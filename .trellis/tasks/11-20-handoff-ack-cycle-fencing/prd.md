# 消除跨轮次陈旧 handoff ACK 竞态

## Goal

跨用户委派产生的 handoff ACK 必须具备轮次隔离：上一轮迟到的 `cleaned` ACK 不能把新一轮 `source_cleanup_pending` 提前推进为 `completed`，也不能让新一轮的 ACK 永久卡在 `409 HANDOFF_ACK_MISMATCH`。

## Background / Confirmed Facts

- 客户端 `retry_pending_handoff_acks` 会在处理新控制前重试本地 `ackState=pending` 的旧 ACK（`packages/desktop/src-tauri/src/agent/task_sync/control.rs:456`），事件短路路径也会单独重试（`packages/desktop/src-tauri/src/agent/task_sync/pull.rs`）。
- 服务端 `ackHandoff` 只按 `handoff_state` 判断：任意合法 `cleaned` ACK 都会把当前状态推进为 `completed`（`packages/server/team/task-control/handoff.js:53-89`），没有轮次标识或 `materializedAt` fencing。
- 竞态路径：上一轮 `cleaned` ACK 发送失败（本地 pending）→ 任务被再次跨用户委派并物化（服务端 `source_cleanup_pending`）→ 客户端重试旧 ACK 被接受（提前 `completed`）→ 新一轮真实清理产生不同备份并 ACK → 服务端返回 `409 HANDOFF_ACK_MISMATCH`（`handoff.js:20-45`），本地记录永久 pending。
- 该风险在任务 `11-20-handoff-second-cycle-cleanup` 的 check 阶段发现，已记录为前提任务的残余风险；当时按 Out of Scope 未处理，因为彻底修复需要服务端协议/状态机改动。

## Requirements

- R1 服务端应在 ACK 中校验轮次（例如要求回传上一轮 `materializedRevision` / `materializedAt` 或独立轮次 ID），轮次不匹配时拒绝或忽略旧 ACK，不得推进当前轮状态。
- R2 或客户端在重试旧 ACK 前读取最新控制/任务，确认 `materializedAt` 与本轮记录一致；不一致时丢弃旧 ACK 并进入新一轮清理。
- R3 无论采用 R1 或 R2，均需覆盖：旧 ACK pending + 新一轮已开始 + 旧 ACK 重试 / 新一轮清理 ACK 的完整竞态序列。
- R4 保持现有 ACK 白名单、审计结构与终态幂等语义；旧客户端兼容。

## Acceptance Criteria

- [ ] AC1：模拟上一轮 `cleaned` ACK 未送达、服务端已进入新一轮 `source_cleanup_pending` 时，旧 ACK 重试不会把状态推进为 `completed`。
- [ ] AC2：新一轮清理与 ACK 正常收敛为 `completed`，不出现 `HANDOFF_ACK_MISMATCH` 永久 pending。
- [ ] AC3：服务端与客户端测试覆盖该竞态序列；现有 handoff 测试不回归。
- [ ] AC4：协议/兼容性变更写入 `.trellis/spec/backend/desktop-realtime-sync.md`。

## Out of Scope

- 本轮任务（`11-20-handoff-second-cycle-cleanup`）已实现的物化轮次重置逻辑本身。
- 服务端 handoff 状态机的其他改造（例如新增冲突恢复流程）。

## Open Questions

- 采用服务端轮次 fencing（R1）还是客户端 ACK 前校验（R2），或两者结合？需在本任务规划阶段结合协议兼容成本决定。