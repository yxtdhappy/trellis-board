# 客户端任务同步性能基线

## 1. 结论

服务端 warm 增量投影不是本次任务的主瓶颈。一次真实单任务创建的端到端时间线中，服务端提交后的投影约 `139ms`；主要放大量集中在桌面客户端：

1. Git / HEAD 变化会进入全任务空间 ownership 扫描。
2. 单任务上传前会再次读取整个 taskSpace 正文。
3. 上传过程对任务根目录重复遍历。
4. 多个同步入口共享全局锁，一个慢 taskSpace 会阻塞其他 taskSpace。
5. 看板创建命令额外执行大仓库 Git 状态扫描。
6. 命令直传和 watcher 对同一任务重复触发上传。

本文只记录已核实事实和基于代码路径的推断，不把阶段耗时估算当成实测。

## 2. 已核实时间线

`2026-11-16 UTC` 的一次 warm 单任务创建：

| 时间 | 事件 | 相对任务创建起点 |
| --- | --- | --- |
| `15:47:26.57` | `task.py create` 创建任务目录 | `0s` |
| `15:47:29.55` | `task.json` 写完 | 约 `3.0s` |
| `15:47:33.503` | 客户端生成上传 `clientSequence` | 约 `6.9s` |
| `15:47:35.722` | 服务端提交 revision | 约 `9.2s` |
| `15:47:35.864` | 服务端 warm 增量投影完成 | 提交后约 `139ms` |

这证明约 `3s` 属于 `task.py` 文件生成，另有约 `6s` 位于 watcher、ownership、扫描、Git、上传和拉取链路。

## 3. 规模与成本

已核实的目标 taskSpace 规模：

- `330-331` 个任务目录。
- `1615` 个任务正文文件。
- 约 `3.36MiB` 正文。

本机等价只读测量：

| 操作 | 约耗时 |
| --- | ---: |
| 从 `.trellis/tasks` 根遍历全部目录元数据 | `841ms` |
| 读取全部正文并计算 SHA-256 | `2.0-2.1s` |
| 直接读取一个目标任务 | `16ms` |
| `git status`（历史基线） | `697ms` |
| `rev-parse --show-toplevel` + `branch --show-current` | `380ms` |

当前机器受工作区规模和终端安全组件影响，Git status 存在较大波动；本文用当前客户端日志而不是单次 shell 测量判断主要慢路径。

## 4. HEAD 扫描放大

当前 `desktop.log` 中 `a8d34d0e` taskSpace：

| 指标 | 值 |
| --- | ---: |
| `head-or-ref-changed` 次数 | `28` |
| P50 | `4.840s` |
| P95 | `12.898s` |
| 最大 | `20.831s` |

每次该路径当前会：

1. 因 HEAD/ref 指纹不匹配进入 `scanMode=full`。
2. 从任务根重新遍历目录。
3. 执行多次 Git 调用。
4. 持有全局同步锁，阻塞其他 taskSpace。

代码锚点：

- `packages/desktop/src-tauri/src/agent/task_sync.rs:2218`
- `packages/desktop/src-tauri/src/agent/task_sync.rs:2237`
- `packages/desktop/src-tauri/src/agent/task_sync.rs:2418`

## 5. 单任务上传放大

### 5.1 目标过滤发生得太晚

`read_local_task_snapshot_files()` 收到 `task_dirs` 后仍从 `.trellis/tasks` 根递归遍历，最后才过滤目标目录：

- `packages/desktop/src-tauri/src/agent/task_sync.rs:6762`
- `packages/desktop/src-tauri/src/agent/task_sync.rs:6782`
- `packages/desktop/src-tauri/src/agent/task_sync.rs:6811`

### 5.2 上传前读取全空间正文

`upload_directories()` 先只读目标目录构造 ownership 输入，随后又调用 `local_groups(binding, None)` 读取全 taskSpace 正文：

- `packages/desktop/src-tauri/src/agent/task_sync.rs:4880`
- `packages/desktop/src-tauri/src/agent/task_sync.rs:4943`

### 5.3 发送前再次扫描

`upload_batch()` 为 pending/ownership 一致性重新读取目标目录：

- `packages/desktop/src-tauri/src/agent/task_sync.rs:5093`
- `packages/desktop/src-tauri/src/agent/task_sync.rs:5125`

这次读取是发送前一致性门禁，应保留；问题在于它前面的两次遍历和全正文读取。

## 6. 全局锁与 watcher 顺序

`binding_sync_lock` 当前为单个 `Mutex<()>`，被以下路径共享：

- 启动同步。
- SSE pull。
- watcher 上传。
- ownership 校验 worker。

同时，watcher 在 task 事件后先排入 ownership 校验 worker，再竞争同一个全局锁上传。新任务事件可能先等大 taskSpace ownership 扫描完成，再开始正文扫描。

代码锚点：

- `packages/desktop/src-tauri/src/agent/task_sync.rs:1279`
- `packages/desktop/src-tauri/src/agent/task_sync.rs:1487`
- `packages/desktop/src-tauri/src/agent/task_sync.rs:2536`
- `packages/desktop/src-tauri/src/agent/task_sync.rs:2851`
- `packages/desktop/src-tauri/src/agent/task_sync.rs:3084`

## 7. 看板创建命令额外成本

`create_task()` 在 `task.py` 前后各执行一次全仓 `git status`，随后又执行一次目标目录 `status_paths`，但结果没有被业务判断消费：

- `packages/desktop/src-tauri/src/agent/task_command.rs:356`
- `packages/desktop/src-tauri/src/agent/task_command.rs:411`
- `packages/desktop/src-tauri/src/agent/task_command.rs:450`
- `packages/desktop/src-tauri/src/agent/task_command.rs:493`

命令成功后的直传仍会触发一次同步；watcher 随后又看到相同任务文件。当前 suppression 只用于服务端写回本地后的回波，不覆盖命令直传后的 watcher 回波。

## 8. 一致性约束

优化不能移除：

- 每次实际 HTTP 写入前的真实分支校验和 `observedBranchName`。
- pending batch 原始 `batchId/clientSequence/files/mergeEvidence` 重放。
- 文件级 `baseSha256` CAS。
- 完整任务目录、稳定任务 ID、活动到归档移动和删除墓碑校验。
- 任务归属暂停、冲突阻断和 `TASK_OWNED_BY_BASELINE` 行为。

## 9. 推测与待验证项

- 推测：真实 `9.293s` 中，约 `3s` 是 `task.py`，其余主要来自 ownership 扫描、全正文读取和 watcher 竞争。
- 待验证：目标目录直扫、HEAD 差量和锁拆分后，2s/5s P95 是否能在真实 Windows 客户端稳定达到。
- 待验证：去掉看板命令前后全仓 status 后，现有目标任务唯一性、路径、分支和任务身份门禁是否足以保持命令写入边界。

## 10. 基准采样要求

- 至少 `20` 次脚本单任务创建。
- 至少 `20` 次真实看板按钮创建。
- 优化前后使用同一 taskSpace 规模、同一机器、同一登录链路和同一操作脚本。
- 记录任务写文件时间、客户端上传序号生成、HTTP 发出/返回、revision committed、Board 首次卡片可见时间。
- 重开客户端单独采样，避免把服务端冷启动投影混入客户端性能。
