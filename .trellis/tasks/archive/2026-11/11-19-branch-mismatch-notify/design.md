# 技术设计：分支守卫降噪与非模态消息

## 1. 现状与根因

```text
AgentRuntime::heartbeat_once (每 15s)
  → TaskSync::update_bindings
    → prepare_bindings（分支不匹配时 branch_state_matches=false，不短路）
      → select_bindings
        → assert_binding_branch 失败（persist_binding_sync_error）
        → report_binding_error → emit(task_sync_error)
  → AgentService::publish_control
    → ControlHub::push_with_change（队列为空时成为队首）
    → emit("live-control-changed") + 首次 notify_control（系统通知）
  → LiveSyncControlDialog 轮询 live_control_pending → 弹出模态框
用户关闭 → live_control_dismiss 弹出队首 → 下一轮心跳重新入队 → 再次弹窗
```

当前 `main` 的 `publish_control` 已把首次提醒从 `focus_main_window` 改为 `notify_control` 系统通知（`agent_service.rs:288-294`、`agent_service.rs:349-374`）；用户反馈的旧版本还会抢焦点。两者都不是本任务要的“客户端内非模态消息”：本任务让 `task_sync_notice` 完全绕过 `ControlHub` 与系统通知，只发 Board 内 toast。

关键锚点：`bindings.rs:269-296`、`bindings.rs:384-386`、`bindings.rs:441-448`、`control.rs:92-120`、`agent_service.rs:349-374`、`LiveSyncControlDialog.tsx:493-546`。

`BRANCH_MISMATCH` 等分支守卫错误是**持续状态**，不是一次性事件；项目栏已经通过 `lastErrorCode` 展示“已暂停”，因此不应进入模态事件队列。

## 2. 设计目标

1. 分支守卫错误不再进入 `ControlHub`：不弹模态框、不触发 `focus_main_window`、不占用“处理实时确认”入口。
2. 只在“从正常进入暂停”时发一次非模态消息；暂停期间（含切换另一个非绑定分支、窗口重载、进程重启）不再提醒。
3. 保留原有失败关闭语义：不 pull、不 upload、不写本地任务目录、不监听、不把任务空间上报为在线监听。
4. 非分支守卫类 `task_sync_error` 的模态行为完全不变。

## 3. 事件契约

### 3.1 新增非模态事件 `task_sync_notice`

`TaskSync` 通过现有 `ControlSink` 发出，但 `AgentService::publish_control` 将其直接转发为 Tauri 事件，不进入 `ControlHub`：

```json
{
  "type": "task_sync_notice",
  "kind": "branch_guard",
  "taskSpaceId": "<taskSpaceId>",
  "projectName": "<binding.displayName>",
  "branchName": "<binding.branchName>",
  "errorCode": "BRANCH_MISMATCH",
  "message": "本地当前分支为 fix/offline-assign-materialize，绑定分支为 main"
}
```

- Tauri 事件名：`task-sync-notice`。
- 无 `expiresAtEpochMs`、无队列、无 dismiss；监听方只做提示。
- 不包含 `repoPath` 等本地路径，沿用 `task_sync_error` 的脱敏口径。

### 3.2 触发条件（进入暂停的边沿）

实测发现：分支切换可能先被 `ownership 增量校验`、事件 pull 等路径发现；这些路径同样调用 `assert_binding_branch` 并持久化错误。如果通知只在 `select_bindings` 的 `report_binding_error` 里发，进入边沿会被这些路径先“消费”掉，心跳再检查时已经处于错误状态，结果**一条消息都不会发**。

因此通知必须由 `assert_binding_branch` 自己在进入边沿发出：

1. 通过 `assert_binding_active` 的返回值读取**刚持久化的** `last_error_code`，不使用调用方传入的可能滞后的 binding 副本。
2. `let entered = !previous.as_deref().is_some_and(is_paused_state_code);`
3. 调用 `persist_binding_sync_error` 持久化；`changed` 表示配置是否实际变化。
4. 若 `entered && changed`，在 `TaskSync.branch_guard_notified`（按 `local_repo_key` 的内存集合）中占位；首次占位成功才 emit `task_sync_notice`。
5. 若 `entered && !changed`，说明另一个并发路径已经持久化，由它负责发射。
6. 若 `!entered`，把 `local_repo_key` 记入集合，避免启动时已暂停或重复心跳再次提醒。

`is_paused_state_code` 同时把分支守卫 7 码和心跳写入的 `BINDING_BRANCH_MISMATCH` 视为“已暂停”，避免两种错误码逐轮交替时重复提醒。

状态矩阵：

| 之前持久化状态 | 本次真实分支 | entered | 结果 |
| --- | --- | --- | --- |
| 无错误 / 非分支守卫错误 | 不匹配 | true | 持久化 + 发一次 notice |
| 已是分支守卫或 `BINDING_BRANCH_MISMATCH`（同一分支或另一个非绑定分支） | 不匹配 | false | 更新错误文案，不发 notice |
| 已是分支守卫错误 | 匹配 | - | `clear_branch_guard_error` 清除并从集合移除，不发 notice |
| 已清除后再次不匹配 | 不匹配 | true | 再发一次 notice |
| 进程启动时配置已是分支守卫错误 | 不匹配 | false | 不发 notice（符合已确认的产品决策） |
| 同仓库多绑定同时不匹配 | 不匹配 | true | 首个 binding 发射，后续被 `local_repo_key` 集合去重 |

`persist_binding_sync_error` 返回 `bool`（配置是否实际变化），供状态通知复用；`changed` 仍用于原有的 `notify_state_changed` 逻辑。

### 3.3 发射路径

`task_sync_notice_event(binding, task_space_id, error, message)` 放在 `task_sync/errors.rs`，与 `task_sync_error_event` 并列。

- `assert_binding_branch`：唯一发射点，按 3.2 的边沿与集合去重；任何调用方（心跳选择、ownership 校验、事件 pull、上传、watcher）都经过这里。
- `report_binding_error` / `report_error`：分支守卫错误只过滤，不再发模态 `task_sync_error`，也不重复发 notice；其他错误保持原行为。
- `forget_branch_guard_notice`：分支恢复时从集合移除 `local_repo_key`，允许下一次进入暂停重新提醒；`select_bindings` 的快路径也调用它。

`AgentService::publish_control`：

```rust
match control.get("type").and_then(Value::as_str) {
    Some("task_handoff") => { /* 现有逻辑 */ return; }
    Some("task_sync_notice") => {
        let _ = self.app.emit("task-sync-notice", control);
        return; // 不入 ControlHub，不 focus
    }
    _ => {}
}
```

`live-control-changed` 只在控制队列变化时发出，前端模态框不会因分支守卫错误刷新。

## 4. 前端消息

- 新增纯函数 `packages/web/src/lib/sync-notice.js`：输入 notice payload，输出 `{ id, title, description }`，便于 Node 测试。
  - 标题：有项目名时 `项目「<projectName>」已暂停同步`，否则 `任务同步已暂停`。
  - 描述：`<message>。切回绑定分支后会自动恢复。`；`message` 缺失时用绑定分支兜底。
  - `id`：`sync-notice:<projectName || taskSpaceId>`，同一项目多条事件由 sonner 合并。
- 新增 `packages/web/src/desktop/SyncNotice.tsx`：
  - `listen('task-sync-notice', ...)` → `toast.warning(title, { id, description, duration: 10_000 })`。
  - 不请求系统通知权限、不调用 `focus`、不打开 Dialog。
  - 非 Tauri 环境或旧客户端无事件时静默。
- 在 `BoardPage.tsx` 的 `<HandoffNotice />` 旁挂载 `<SyncNotice />`。
- 窗口隐藏/最小化时不额外排队；恢复可见后由项目栏的“已暂停”状态兜底（明确接受）。

## 5. 暂停语义验证

代码路径已确认，但需要测试锁定：

- `prepare_bindings` 只把 `selected` 写入 `self.bindings`（`bindings.rs:296-314`）。
- `sync_task_spaces` 为空直接返回（`bindings.rs:118-121`）。
- watcher 只为 `selected` 重建（`bindings.rs:349`、`watch.rs:19-38`）。
- `pull_task_space_tracking` 对未选中绑定返回 `BINDING_INACTIVE`，不发 HTTP（`pull.rs:291-300`）。
- `pull_tracking` 在读取 cursor / 写文件前先 `assert_binding_branch`（`pull.rs:353`）。
- 本地任务目录写入只由 pull 触发（`local_files.rs:393`）。
- `active_bindings` 来自 `self.bindings`，因此心跳不会把暂停的任务空间上报为在线监听（`bindings.rs:689-700`、`runtime.rs:190-197`）。

新增测试至少覆盖：

1. 分支不匹配时 `prepare_startup_bindings` 返回空、`active_bindings()` 为空；`pull_task_space()` 返回 `BINDING_INACTIVE` 且 mock API 无请求。
2. 同一不匹配分支连续两个心跳周期只发 1 条 notice。
3. 切回绑定分支后错误清除、绑定重新入选；再次切走发第 2 条 notice。
4. 同仓库多绑定同时进入暂停只发 1 条 notice。
5. 非分支守卫错误仍发 `task_sync_error`（回归）。
6. 直接调用 `assert_binding_branch`（模拟 ownership/pull 路径）也能发出且只发一次 notice。
7. 复用旧 binding 副本（`last_error_code` 仍是守卫码）在恢复后再次失败时仍能提醒，证明边沿依据持久化状态。

## 6. 兼容性

- 新桌面 + 旧 Web：旧 Web 不监听 `task-sync-notice`，仅少一条提示；项目栏仍显示“已暂停”。
- 旧桌面 + 新 Web：事件永不出现，旧桌面仍弹旧模态框；无回归。
- `task_sync_error` 的 JSON 契约不变；非分支守卫错误行为不变。
- 无配置 schema、cursor schema、服务端协议变化；无需迁移。

## 7. 风险与缓解

- **stale `last_error_code` 导致误判边沿**：所有调用点传入的 binding 都来自配置读取或已选集合；测试覆盖“连续两轮”“恢复后再进入”。
- **同仓库多绑定消息内容只代表一个绑定**：单轮按 `local_repo_key + code` 去重，消息使用首条；项目栏仍按分支逐条展示。
- **窗口隐藏时消息被错过**：接受；项目栏持续展示状态，且启动不提醒是已确认决策。
- **`report_error` 其他持久错误仍可能重复弹窗**：本任务明确不改变非分支守卫错误行为，后续可单独降噪。

## 8. 回滚

改动集中在 Rust 事件发射路由、一个前端监听组件与测试/规格文档；回滚只需还原这些提交。旧行为（模态 `task_sync_error`）会立即恢复，无数据迁移需要清理。
