# 修复失效 handoff 冲突提示持续驻留

## Goal

修复桌面客户端本地 handoff 记录在服务端控制面已不再处于 handoff 状态后仍永久显示"任务已被认领，本地副本需保留"的问题，并保证真实进行中的冲突提示不受影响。

## Background

- 复现任务：`handoff-manual-e2e-114216`（本机 yhj 创建，原委派给 kyf，测试库任务）。
- 服务端 `sync_task` 已为 `materialization_state=claimed`、`handoff_state=none`、`materialized_at=null`（2026-11-20T04:30:27Z）。
- 本机 `task-control-state.json` 的 `controls` 已同步为 `state=claimed`、`handoffState=none`，但 `handoffs` 仍保留 `serverHandoffState=source_cleanup_conflict`、`outcome=conflict`、`ackState=done`。
- 客户端只在 `state=handoff_materialized` 且 `handoff_state` 为 `source_cleanup_pending|source_cleanup_conflict` 时处理 handoff（`task_sync/control.rs`），因此该残留记录不会被再次更新或删除；`pending_handoff_notices` 直接返回全部本地记录，页内常驻卡片持续显示。
- 该状态是上一版缺陷遗留，但当前代码缺少"服务端回到非 handoff 状态后清理本地记录"的路径，同类场景（冲突后服务端重置、改派回原负责人、任务归档）会复现。

## Requirements

1. 客户端合并服务端控制面（快照 `controls` 字段存在）时，清理本地 `handoffs` 中不再对应有效 handoff 控制的记录：
   - 对当前 binding 的 `localId + taskSpaceId`；
   - 若同一 `executionTaskKey` 的当前控制不是 `state=handoff_materialized`，或 `handoff_state` 不属于 `source_cleanup_pending|source_cleanup_conflict`，则该本地记录失效；
   - `outcome=cleaned` 的成功记录保留，不删除。
2. 有效记录必须保留：当前控制仍为 `handoff_materialized` 且 `handoff_state` 为 `source_cleanup_pending|source_cleanup_conflict` 的 pending/conflict/处理中记录。
3. 不得清理其他 binding（其他 `localId` 或其他 `taskSpaceId`）的 handoff 记录。
4. 快照缺少 `controls` 字段时（旧服务端兼容路径）不做清理。
5. 清理后 `handoff_notice_pending` 不再返回失效记录，页内常驻卡片随之消失；不改变通知去重键和已有 toast 行为。
6. 服务端、Web 渲染和状态文件 schema 不做改动。

## Constraints

- 只改 `packages/desktop/src-tauri/src/agent/task_control.rs` 及其测试文件。
- 保持规范契约"冲突状态持续显示非模态页内提示；固定页内状态只展示冲突和处理中项"：真实进行中的冲突提示不能提前消失。
- 不清理 `outcome=cleaned` 记录，避免丢失清理成功通知的既有语义。
- 不新增 Tauri 命令、事件或前端交互。

## Acceptance Criteria

- [ ] 构造"本地 conflict 记录 + 控制面 claimed/none"后执行控制面合并，记录被删除，`pending_handoff_notices()` 返回空。
- [ ] "本地 conflict 记录 + 控制面 handoff_materialized/source_cleanup_conflict"合并后记录保留，提示仍显示。
- [ ] "本地 pending 记录 + 控制面 handoff_materialized/source_cleanup_pending"合并后记录保留。
- [ ] "本地 cleaned 记录 + 控制面 claimed/none"合并后记录保留。
- [ ] 其他 binding 的 conflict 记录在合并当前 binding 控制面后保持不变。
- [ ] `controls` 缺失时不触发清理。
- [ ] 桌面 Rust 单元测试全绿；安装新构建后首次同步，`handoff-manual-e2e-114216` 的右上角常驻提示消失，无重复 toast/native 通知。
- [ ] 真实 dirty/tracked 本地副本产生的 conflict 仍持续显示提示，行为与修复前一致。

## Verification Plan

1. 单元测试覆盖上述合并矩阵（含本轮实际状态复现）。
2. `cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml` 全绿。
3. 使用本机 v0.4.51 数据目录复现：在本地状态文件已有残留记录的情况下安装修复构建，确认同步后 `task-control-state.json` 中该记录被移除、`handoff_notice_pending` 返回空、页内卡片消失。
4. 回归：制造一个仍处于 `source_cleanup_conflict` 的任务（或保留现有 conflict 测试任务），确认持卡行为不变。