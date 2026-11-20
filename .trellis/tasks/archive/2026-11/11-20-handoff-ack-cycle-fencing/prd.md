# 消除跨轮次陈旧 handoff ACK 竞态

## Goal

跨用户委派产生的 handoff ACK 必须具备轮次隔离：上一轮迟到的 `cleaned` / `conflict` ACK 不能把新一轮 `source_cleanup_pending` 提前推进为终态，也不能让新一轮的 ACK 永久卡在 `409 HANDOFF_ACK_MISMATCH`。

采用**服务端轮次 fencing**：ACK 请求携带物化轮次标识，服务端与 `sync_task` 当前行比对，轮次不匹配直接拒绝，不推进任何状态。

## Background / Confirmed Facts

- 客户端 `retry_pending_handoff_acks` 会在处理新控制前重试本地 `ackState=pending` 的旧 ACK（`packages/desktop/src-tauri/src/agent/task_sync/control.rs:456`），事件短路路径也会单独重试（`packages/desktop/src-tauri/src/agent/task_sync/pull.rs`）。
- 服务端 `ackHandoff` 只按 `handoff_state` 判断：任意合法 ACK 都会推进当前状态（`packages/server/team/task-control/handoff.js:8-97`），没有轮次标识或 `materializedAt` fencing。
- 竞态路径：上一轮 `cleaned` ACK 发送失败（本地 pending）→ 任务再次跨用户委派并物化（服务端 `source_cleanup_pending`）→ 客户端重试旧 ACK 被接受（提前 `completed`）→ 新一轮真实清理产生不同备份并 ACK → 服务端返回 `409 HANDOFF_ACK_MISMATCH`（`handoff.js:43-45`），本地记录永久 pending。
- 服务端 `sync_task` 已有 `materialized_at` 与 `materialized_revision`；控制面 payload 已下发 `materializedAt`/`materializedRevision`（`packages/server/team/task-control/views.js:130-133`）。客户端 handoff 记录已持久化这两个字段（任务 `11-20-handoff-second-cycle-cleanup`）。
- 该风险由任务 `11-20-handoff-second-cycle-cleanup` 的 check 阶段发现，本任务单独跟踪。

## Requirements

- R1 协议扩展：`POST /api/agent/tasks/:executionTaskKey/handoff-ack` 请求体新增可选字段 `materializedAt`（ISO 8601 UTC 毫秒格式，与 `sync_task.materialized_at` 一致）与可选 `materializedRevision`（非负安全整数）。新客户端必须发送；旧客户端缺省保持现有行为。
- R2 服务端 fencing：`ackHandoff` 在幂等判断和任何状态推进之前校验轮次。请求提供的标识与当前 `sync_task` 行不一致（`materializedAt` 优先，缺失时比较 `materializedRevision`；两者都提供则都必须匹配）时返回 `409 HANDOFF_CYCLE_STALE`，不写审计、不改 `handoff_state`。
- R3 客户端处理：`attempt_handoff_ack` 收到 `HANDOFF_CYCLE_STALE` 时保持本地 ACK 为 pending、不得标记 done；由同一轮或下一次控制同步按新物化轮次重置并执行清理。
- R4 兼容与回填：本地 handoff 记录缺少轮次字段时，ACK 使用本地最新控制（`TaskControl.materialized_at/materialized_revision`）回填；旧客户端不发送字段时服务端走兼容路径，不报错。
- R5 测试覆盖：服务端覆盖匹配/不匹配/字段缺失/已完成终态幂等/陈旧 conflict ACK；客户端覆盖 ACK 字段、409 处理、控制同步后的新轮次清理；现有 handoff 测试不回归。
- R6 规范更新：`.trellis/spec/backend/desktop-realtime-sync.md` 补充 ACK 轮次字段、错误码与兼容矩阵。

## Acceptance Criteria

- [ ] AC1：模拟上一轮 `cleaned` ACK pending、服务端已进入新一轮 `source_cleanup_pending`，重试旧 ACK 返回 `409 HANDOFF_CYCLE_STALE`，服务端仍为 `source_cleanup_pending`，审计不新增。
- [ ] AC2：新一轮清理使用当前轮次标识 ACK 成功，服务端收敛为 `completed`，不出现 `HANDOFF_ACK_MISMATCH`。
- [ ] AC3：不带轮次字段的旧客户端 ACK 保持兼容成功（有测试与文档说明）。
- [ ] AC4：客户端收到 `HANDOFF_CYCLE_STALE` 后本地记录保持 pending，下一次控制同步按新轮次重置并完成清理，不永久 pending。
- [ ] AC5：`yarn test`（服务端）与 `cargo test`（客户端）相关用例通过；spec 已更新。

## Out of Scope

- 客户端 ACK 前 GET 预检（本次选择服务端权威 fencing；如需 TOCTOU 双保险另立任务）。
- 服务端 ACK 历史/审计结构重构；所有 handoff 状态机改造（例如冲突恢复流程）。
- 永远不升级、不发送轮次字段的旧客户端仍无法被 fencing；以兼容路径记录为已知限制。

## Open Questions

- 无阻塞问题（方案已拍板：服务端轮次 fencing）。