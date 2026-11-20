# 稳定 handoff 物化轮次标识

## Goal

同一物化轮次内的 `materialized_at` 必须保持稳定：目标客户端的多次上传和命令完成不得改写它。
这样创建者的 ACK 不会在同一轮内被误判为 `HANDOFF_CYCLE_STALE`，同时跨轮次的陈旧 ACK 仍会被拒绝。

## Background / Confirmed Facts

- 手工测试任务 `handoff-manual-e2e-114216`（yhj 创建，委派给 kyf）在正常第二轮清理时失败：
  服务端最终为 `source_cleanup_conflict`，reason `missing`；本机来源副本已备份后删除。
- 服务端拒绝日志（`server.1.log:3060-3061`）显示同一轮内 `materialized_at` 多次变化：
  - 客户端 ACK 携带 `03:56:03.369Z`；
  - 服务端当前值先变为 `03:56:03.477Z`，又变为 `03:56:04.337Z`；
  - `materialized_revision` 始终为 `162`。
- 代码路径：
  - `assignPendingTask` 只把 `materialization_state` 置为 `pending`，未清空上一轮的 `materialized_at`（`packages/server/team/task-control/tasks.js:92-113`、`shared.js:264-269`）。
  - 目标客户端每次上传都会改写 `materialized_at`（`shared.js:304` 的 `updateTaskFromUpload`；`uploads.js` 的 `commitUpload`）。
  - `completeCommand` 再次无条件覆盖 `materialized_at`（`shared.js:296` 的 `updateTaskCommandComplete`）。
  - fencing 同时比较 `materializedAt` 与 `materializedRevision`（`packages/server/team/task-control/handoff.js:18-34`）。
- 结果：客户端从较早的控制快照取得 epoch，清理后 ACK 被误拒；由于来源副本已删除，新轮次只能收敛为 `conflict/missing`。
- 该缺陷由任务 `11-20-handoff-ack-cycle-fencing` 的 fencing 引入/放大；当时的 E2E 只覆盖了陈旧 ACK 被拒，没有覆盖“同轮多次上传”。

## Requirements

- R1 新轮次起点：跨用户改派（`assignPendingTask` 且 assignee 变化）时清空 `materialized_at`、`materialized_revision`、`materialized_manifest_sha256`、`materialized_by_agent_id`，明确开启新物化轮次。
- R2 稳定写入：`updateTaskFromUpload` 仅在目标写入者首次物化（`materialized_at IS NULL`）时写入 `materialized_at`；同一轮后续上传不得改写。`materialized_revision` 可继续反映最新内容 revision。
- R3 命令完成不覆盖：`updateTaskCommandComplete` 仅在 `materialized_at` 为空时补写，不得覆盖首次物化时间。
- R4 fencing 主键：`assertHandoffCycle` 以 `materializedAt` 为准；仅当请求未提供 `materializedAt` 时才比较 `materializedRevision`。`materializedAt` 匹配时忽略 revision 差异。
- R5 兼容性：旧客户端不发送轮次字段时保持兼容；不新增数据库列；历史任务在下次改派时自然获得稳定 epoch。
- R6 测试与规范：服务端覆盖“同轮多次上传 → 同一 epoch → ACK 成功”“跨轮旧 epoch → 拒绝”“改派清空并重新生成”；更新 `.trellis/spec/backend/desktop-realtime-sync.md`。

## Acceptance Criteria

- [ ] AC1：同一轮内目标多次上传后，创建者使用首次物化 epoch ACK 成功，不再出现 `HANDOFF_CYCLE_STALE`。
- [ ] AC2：跨轮次旧 ACK 仍返回 `409 HANDOFF_CYCLE_STALE`，状态与审计不变。
- [ ] AC3：真实 A 流程（创建 → 委派给 kyf）完成来源备份与删除，服务端 `completed`，Board 显示“认领与清理已完成”，无 `conflict/missing`。
- [ ] AC4：旧客户端不带轮次字段仍可 ACK；现有 handoff 测试不回归。
- [ ] AC5：spec 更新；CI 的 Node 测试通过（如允许执行）。

## Out of Scope

- 新增独立的 `handoff_cycle_id` 列（当前先用稳定的 `materialized_at`；若未来需要更强标识再迁移）。
- 客户端 ACK 重试策略重写、历史 conflict 任务批量修复。
- 已归档任务 `11-20-handoff-ack-cycle-fencing` 的代码逻辑本身（本次只修 epoch 稳定性与比较优先级）。

## Open Questions

- 无阻塞问题。