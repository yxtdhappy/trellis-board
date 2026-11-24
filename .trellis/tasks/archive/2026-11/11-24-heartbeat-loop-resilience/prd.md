# 修复服务端重启后客户端心跳循环静默停止导致在线监听不恢复

## Goal

服务端每次重启，所有已连接客户端的心跳都会**永久停止**，Board 上「在线监听」归零，只有重启客户端进程才能恢复。目标是让在线状态在服务端重启后**自行恢复**（15–60 秒内），并让这类故障下次可直接从客户端日志定位。

## Background

2026-11-24 现场（用户 yhj 的客户端 + 另外三台在线客户端）实测：

| 时间（UTC） | 事实 | 来源 |
| --- | --- | --- |
| 08:41:01.485 | 最后一次成功心跳（`agent_device.last_seen_at`） | `board.sqlite` |
| 08:41:08 – 08:42:23 | 服务端关机 11 秒后重启 | `server/logs/server.1.log` |
| 08:41:18.695 | `runtime.json` 最后一次写入：`status=error`、`lastError=.../api/agent/events`（非认证错误，`lastErrorCode=null`） | `data/agent/runtime.json`（此后 mtime 不再变） |
| 08:43:47 – 08:44:21、08:48 | 客户端**仍在正常同步**：ownership 校验、上传、`live-cursors.json` 持续写入 | `data/logs/desktop.log`、文件 mtime |
| 之后 | 心跳零次、状态零写入；无 git 子进程、无 `.config.lock`/`.live-cursors.lock` 残留 | 复查 |

同一天 06:39 的同一次重启也出现过完全一致的现象（三台客户端 `last_seen_at` 冻结在 06:39:25–36）。

关键代码事实：

- `agent/runtime.rs:22-24`：`HEARTBEAT_INTERVAL=15s`、`RETRY_BASE=1s`、`RETRY_MAX=60s`。
- `agent/runtime.rs:138-189`：心跳循环。成功 → 15s 后再来；认证失败 → 写 `AUTH_REVOKED` 并 `stop()`；其它错误 → 写状态 + 探活 + 指数退避。**循环内没有任何日志**。
- `agent/runtime.rs:191-243`：`heartbeat_once()` 先 `await task_sync.update_bindings(...)`，**再**发心跳；两次 `update_bindings` 都没有超时。
- `agent/task_sync/bindings.rs:102-105` `update_bindings` → `prepare_bindings`（`bindings.rs:241-345`，持 `binding_selection_lock` + `cursor_write` 两把全局 AsyncMutex，内含 HEAD 读取与 watcher 重建）→ `sync_task_spaces`（`bindings.rs:116-157`，逐个等待 per-taskSpace 串行锁，无超时）。
- `agent/rt.rs`：任务只是裸 `tokio::spawn`，**无监督、无重启**；`heartbeat_once` 一旦 panic 或永久阻塞，在线状态即永久失联。
- 服务端：`packages/server/config.js:187` `agentStaleMs=60_000`，`team/sync-agent-service.js:118-120` 取该值，在线判定见 `team/task-space/shared.js:255-274`。

推论（用于验收口径，不代替根因复现）：`write_state` 不去重、每次失败都会重写 `runtime.json`；成功心跳会推进 `last_seen_at`。两者同时消失 ⇒ 08:41:18 之后心跳任务既没成功也没失败，即**已死亡或永久阻塞**，而不是「在退避重试」。

## Requirements

- **R1 心跳不被同步阻塞**：`heartbeat_once` 必须先发出心跳，再执行绑定同步；绑定的获取只允许读缓存。
- **R2 同步有界**：心跳路径上的每一次 `update_bindings` 都必须包超时（30s），超时只记日志并跳过，不影响本轮心跳结果。
- **R3 整轮有总超时**：`heartbeat_once` 外层必须包一个总超时（60s），超时则记录并进入下一轮，绝不无限等待。认证失败仍保持现有语义（写 `AUTH_REVOKED` 并停止运行时）。
  > 注：release 构建 `panic = "abort"`（`packages/desktop/src-tauri/Cargo.toml:68`），panic 会终止整个进程；现场客户端进程存活且持续同步，因此心跳任务不是 panic，而是**永久阻塞**——总超时是唯一有效的自愈手段。
- **R4 可观测**：心跳失败、超时、panic、恢复正常四类事件都必须写入 `desktop.log`（含错误码与 URL 路径，不含 token/凭据）。
- **R5 契约不变**：心跳报文结构、`AGENT_PROTOCOL_VERSION=3`、`listenerReportVersion=1`、15s/60s 语义、服务端行为全部不变；服务端代码零改动。
- **R6 回归测试**：覆盖「同步端点挂起时心跳仍按周期送达」与「单次 panic 后循环继续」两条不变量。

## Constraints

- 只改 `packages/desktop/src-tauri/src/agent/` 下的 Rust 代码；不引入新依赖（panic 隔离用 `tokio::spawn` + `JoinHandle`，不用 `futures::FutureExt::catch_unwind`）。
- 遵守 `.trellis/spec/desktop/tauri-commands/index.md`：单文件 ≤ 1200 行、根文件 ≤ 500 行；日志必须走 `logging::info/warn`（自带脱敏与轮转）。
- 不顺手改服务端 heartbeat 事务（`INVALID_INPUT` 导致整事务回滚的问题另开任务）。
- 修复需要重新出客户端包并让 4 台机器升级；未升级的客户端仍会复发，验收只针对新包。

## Acceptance Criteria

- [ ] 集成测试：mock 服务端让 `/api/agent/task-spaces/*/changes` 挂起 ≥60s，`/api/agent/heartbeat` 仍在 20s 内收到 ≥2 次。
- [ ] 单元测试：`heartbeat_once` 单次 panic 后，循环在下一轮仍会再次尝试（间隔 ≤ 退避上限）。
- [ ] 手工：客户端保持运行 → 重启服务端 → 不重启客户端，60s 内 `agent_device.last_seen_at` 恢复前进且 `sync_agent_binding.is_listening=1`，Board 显示在线。
- [ ] 手工：断开网络 2 分钟再恢复，心跳自动恢复，`runtime.json` 不再停留在 `error`。
- [ ] `desktop.log` 能看到「心跳失败(code) → 心跳恢复」成对出现，且不含凭据。
- [ ] `cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml` 全绿。

## Out of Scope

- 服务端 heartbeat 事务在绑定校验失败时整体回滚（`sync-agent-service.js:410-600`）的加固。
- 事件循环（SSE）同类加固；若与心跳共用可复用的小工具才抽取，不作为验收项。
- Board 页面「在线监听」展示与文案调整。
- 客户端自动更新/分发流程本身（沿用现有 0.4.62 出包方式）。
