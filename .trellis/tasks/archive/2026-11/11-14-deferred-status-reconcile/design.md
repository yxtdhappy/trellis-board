# 设计：deferred 已一致状态收敛

## 1. 边界

改动限定在桌面 Agent 的 Rust 同步层：

- `apps/desktop/src-tauri/src/agent/task_sync.rs`
- 对应 Rust 单测
- `.trellis/spec/backend/desktop-realtime-sync.md`
- 必要时同步 `.trellis/spec/frontend/rendering-and-state.md` 的 deferred 文案契约

不改服务端、Team API、Web 组件或数据库 schema。UI 继续按 `deferredCount` 展示状态，只修正输入值。

## 2. 状态与数据

`Cursor` 已有：

- `baselines`：客户端已知的服务端文件最新 SHA256。
- `deferred`：首次安全接入时保留的本地任务文件 SHA256。

本地任务目录由现有 `local_groups()` 读取，继续复用 UTF-8 规范化、路径白名单和摘要逻辑。

“已一致”严格定义为：

```text
local[taskDir] == snapshot_baselines filtered by taskDir
```

并且 `local[taskDir]` 非空。该比较包含相对路径集合和每个 SHA256，不使用标题、稳定任务 ID 或
目录名启发式。`snapshot_baselines` 是 cursor 已知基线与本次增量文件合并后的结果；空增量时它
等于 cursor 基线。

## 3. 收敛流程

### 3.1 启动/绑定收敛

运行时启动时 `update_bindings()` 面对的绑定集合为空，现有逻辑会为该进程首次建立运行集合并逐个
调用 `pull()`；后续心跳集合未变化时直接返回，不会再次扫描任务正文。复用这个入口，不新增启动
扫描状态或定时任务。

首次 `pull()` 在 `afterRevision=cursor.revision` 时可能收到空文件增量。此时
`snapshot_baselines` 合并结果等于 `cursor.baselines`，比较逻辑仍可清除已一致的 deferred，因此
不依赖服务端产生新 revision。

### 3.2 正常 pull 收敛

正常 pull 已计算合并后的 `snapshot_baselines`。在现有本地状态比较阶段，同时使用该服务端基线：

- deferred 指纹、本地状态和合并后的服务端基线三者完全一致且本地任务非空：删除 deferred，并且
  不把该目录加入 dirty。
- deferred 指纹仍等于本地状态，但服务端基线不同或不完整：保留 deferred，继续走现有受保护目录
  审查，不自动上传。
- 本地任务目录缺失或读取结果为空：保留 deferred，不把目录缺失当作可自动上传的删除。
- 本地非空状态已偏离 deferred 指纹：保留现有行为，删除旧 deferred，再相对 `cursor.baselines`
  判断是否 dirty。
- 没有 deferred 的任务：仍只使用 `cursor.baselines` 判断本地 dirty，避免把服务端刚发生的变化
  误判为本地待上传内容。

这样服务端由其他 Agent 补齐任务后，下一次真实快照 pull 也能自动收敛。

客户端把收敛结果写回 cursor 后，本任务先通过现有 association 刷新机制读取
`deferredCount=0`。后续状态性能优化任务再把 cursor 写入通知接入 Tauri 事件，缩短界面更新延迟。

## 4. 纯函数与复用

把现有比较循环提取为一个可单测的窄纯函数：

```rust
fn local_sync_state_from_groups(
    cursor: &Cursor,
    local_groups: &[SnapshotGroup],
    server_baselines: &BTreeMap<String, String>,
) -> (Vec<String>, BTreeMap<String, BTreeMap<String, String>>, HashSet<String>)
```

内部复用：

- `file_state_from_group()`
- `baselines_for_task_dir()`

第三个返回值只包含本地、deferred 指纹和合并服务端基线三者完全一致而收敛的目录；本地状态变化
导致的旧 deferred 清理不得进入该集合。`cursor.baselines` 只用于 dirty 判断，
`server_baselines` 只用于 deferred 收敛判断。不复制摘要计算，不新增缓存，不修改文件内容。

## 5. 兼容与失败行为

- cursor v2/v3 缺失 baselines：不清除 deferred。
- service baseline 只包含部分文件：不相等，不清除。
- 任务目录移动：路径集合不同，不清除旧 deferred。
- 读取本地任务失败：不修改 cursor，保留 deferred，沿用现有错误上报。
- cursor 写失败：本次内存结果不生效，下次启动可重试。
- 自动收敛不需要服务端协议版本变化，旧服务端可继续使用。

## 6. 性能

- 启动 pull 复用 `update_bindings()` 的新增绑定集合，只在该进程首次加入运行时执行。
- 正常 pull 复用已经读取的 local groups 和已计算的 baselines。
- 3 秒 association 展示轮询不增加任何文件读取或摘要计算。
- 只在 deferred 结果变化时写 cursor。

## 7. 与状态性能优化任务的边界

- 本任务负责把 `live-cursors.json` 中的 deferred 收敛正确，不实现新的 UI 通知机制。
- 本任务完成后，现有 association 刷新路径即可用于功能验收；deferred 收敛本身不得新增周期扫描。
- 单独的状态性能优化任务负责让 cursor 或 association 变化触发 Tauri 事件；它直接消费本任务产出的
  `deferredCount/deferredTaskDirs`，不能在本任务中再增加轮询或正文扫描。
- 两个任务都会触及 `task_sync.rs`：本任务必须先完成 deferred 收敛和 `write_cursor` 实际变化语义，
  状态性能优化任务随后只在实际变化分支增加通知，不得重写或绕过本任务的收敛判断。
- 状态性能优化任务的最终 E2E 必须覆盖“deferred 清理后由 Tauri 事件触发 ProjectRail 更新”，
  但这不是本任务启动或归档的前置条件。

## 8. 回滚

产品代码无数据库或持久 schema 变更。回滚新版本后，已删除的 deferred 不会恢复；但被删除项必须
满足本地与服务端已知基线完全一致，因此不会丢失未同步内容。其他冲突和上传数据不受影响。

## 9. 测试

- exact local/server：删除 deferred。
- 本地任务目录缺失：保留 deferred，不产生 dirty 上传。
- 文件 hash 不同：保留。
- 服务端缺文件：保留。
- 本地多文件：保留。
- baselines 为空：保留。
- 同一 revision 的启动 pull 也能删除已一致 deferred。
- 启动清理不触发被移除任务的基线补交上传。
- 本地状态变化导致的 deferred 移除仍保留原 baseline task reconcile 上传。
- 正常 pull 可以删除已一致 deferred，且不产生 dirty upload。
- 重复 heartbeat 不重复扫描任务正文。
- deferred 未变化时 `write_cursor` 不落盘。
