# 设计：handoff ACK 状态按物化轮次隔离

## 1. 根因与约束

### 当前数据流

1. 服务端在跨用户 `assign_task` 命令完成时把任务置为 `materialization_state='materialized'`、`handoff_state='source_cleanup_pending'`，并原子写入 `materialized_at` / `materialized_revision`（`packages/server/team/database-sql` 对应语句 `updateTaskCommandComplete`，`packages/server/team/task-control/shared.js:293-299`；`completeCommand` 分支见 `packages/server/team/task-control/tasks.js:138-146`）。
2. 创建者客户端的 `controlsForAgent` 收到 `state='handoff_materialized'` + `handoffState='source_cleanup_pending'` 的控制（`packages/server/team/task-control/views.js:98-143`），进入本地清理通道。
3. 客户端把清理进度持久化在 `task-control-state.json` 的 `handoffs[localId::executionTaskKey]`（`StoredTaskHandoff`，`packages/desktop/src-tauri/src/agent/task_control.rs:277`）。
4. 下一轮委派产生同一条 `execution_task_key` 的新的 `source_cleanup_pending` 控制；`upsert_handoff_control` 无条件从上一轮记录复制 `ack_state/outcome/backup_id/...`（`task_control.rs:433-447`）。
5. `process_handoff_control` 入口判断 `control.handoff_state == "source_cleanup_conflict" || !handoff.outcome.is_empty()`，直接 early return（`packages/desktop/src-tauri/src/agent/task_sync/handoff.rs:850-858`）；`retry_pending_handoff_acks` 只选 `ack_state == "pending"`（`control.rs:408-447`、`task_control.rs:532-541`）。

结果：旧轮次的 `done/cleaned` 永远阻止新一轮清理与 ACK。

### 约束

- 服务端 handoff 状态只有 `none/pending/conflict/completed`，没有轮次 ID；不能依赖服务端区分轮次。
- `task-control-state.json` 必须向后兼容：旧客户端回滚读取新字段不能失败；新客户端读取旧文件必须继续工作。
- 同一轮次内的重试语义（网络失败、进程重启、租约阻塞）不能被破坏。

## 2. 方案选择

**采用：在 `StoredTaskHandoff` 持久化物化标识，合并时检测轮次变化并重置。**

候选轮次标识的评估：

| 候选 | 结论 | 理由 |
| --- | --- | --- |
| `materializedAt` + `materializedRevision` | 采用 | 服务端每次命令完成时原子写入（`shared.js:293-299`），唯一标识一次物化事件；同轮内稳定；控制 payload 已携带（`views.js:130-133`）。 |
| `taskVersion` | 否 | 归档、改派、租约等控制面变化都会推进版本，与“是否发生新物化”无关，会误重置。 |
| `updatedAt` | 否 | 每次控制拉取/刷新都会变化，同轮内不稳定，会打断 pending ACK 重试。 |
| 服务端新增轮次 ID | 否 | 协议与 DB 迁移范围大，跨版本客户端兼容成本高；客户端已有足够信息自判定。 |
| 依据 manifest/backupId 判断 | 否 | 两轮内容可能完全相同，manifest 相同但仍是新一轮（新副本仍需清理）。 |

`completeCommand` 只对 `status='running'` 的命令执行一次（`packages/server/team/task-command-service.js:624-640`），因此同一轮不会因命令重试而反复刷新 `materialized_at`。

## 3. 数据模型

`packages/desktop/src-tauri/src/agent/task_control.rs` 的 `StoredTaskHandoff` 新增：

```rust
#[serde(default)]
pub materialized_at: Option<String>,
#[serde(default)]
pub materialized_revision: Option<u64>,
```

- `TASK_CONTROL_STATE_VERSION` 保持 `1`；新增字段全部 `#[serde(default)]`。
- 旧客户端读取新文件：serde 默认忽略未知字段，回滚安全。
- 新客户端读取旧文件：字段为 `None`，走“旧记录 → 新轮次”自愈分支。
- `StoredTaskHandoff::from_control` 从 `TaskControl` 填充这两个字段（`TaskControl` 已有同名字段，`task_control.rs:71-75`）。

## 4. 合并规则（`upsert_handoff_control`）

```rust
fn same_materialization_cycle(prev: &StoredTaskHandoff, next: &StoredTaskHandoff) -> bool {
    if let (Some(a), Some(b)) = (&prev.materialized_at, &next.materialized_at) {
        return a == b;
    }
    if let (Some(a), Some(b)) = (prev.materialized_revision, next.materialized_revision) {
        return a == b;
    }
    // legacy 记录没有轮次标识，而新控制携带轮次 => 视为新一轮（自愈）
    !(prev.materialized_at.is_none()
        && prev.materialized_revision.is_none()
        && (next.materialized_at.is_some() || next.materialized_revision.is_some()))
}
```

`upsert_handoff_control` 行为：

- 同轮次：保持现有字段继承与 `source_cleanup_conflict → done/conflict` 兜底逻辑不变。
- 新轮次：使用 `from_control` 的默认值（`pending` + 空 outcome；若服务端已是 `source_cleanup_conflict` 则 `done/conflict`），不继承旧 `ack_state/outcome/reason/backup_id/manifest_sha256/file_count/total_bytes/notified_state`。
- 新轮次重置后 `outcome` 为空，`process_handoff_control` 不再 early return，继续执行：
  `handoff_source_state` → `ensure_handoff_backup`（新建备份时用新控制的 `materialized_revision` 写 meta；两轮内容完全相同时复用已有的内容寻址 `handoff-<sha16>` 备份，不重复复制）→ `mark_handoff_ack_pending(cleaned)` → 二次复核 → `remove_handoff_source` → `attempt_handoff_ack` → `mark_handoff_ack_done`。

## 5. 状态与通知影响

- 已完成的旧轮次记录在新控制到达前不被改动；`retry_pending_handoff_acks` 行为不变。
- 新轮次会清空 `notified_state`，桌面层因此会重新发射一次 `handoff-control-changed` / notice；前端 Sonner 的 localStorage 去重键仍是 `executionTaskKey:handoffState:outcome`，同一阶段不会重复弹 toast，但持久页内提示会随新轮次状态出现。这是期望行为。
- 服务端仍是单一 `handoff_state`，Board 只展示最新轮次状态；无 UI 改动。

## 6. 边界与错误矩阵

| 场景 | 行为 |
| --- | --- |
| 同轮次 + `done` | 保持 `done`，不清理、不 ACK |
| 同轮次 + `pending`（网络失败/重启） | 现有重试逻辑：备份复核 → 重试 ACK |
| 新轮次 + 服务端 `pending` | 重置为 pending/空 outcome，重新执行完整清理 |
| 新轮次 + 服务端 `conflict` | `from_control` 给出 `done/conflict`，保留冲突提示，不自动清理（现有终态语义） |
| 旧记录（无轮次）+ 带轮次的新控制 | 视为新轮次，自愈当前 `test1` |
| 两侧都无轮次标识 | 无法区分，保持现有“同轮次”行为，避免误重置 |
| 备份失败 / 清理失败 | 沿用现有 `conflict/backup_failed`、`conflict/cleanup_failed` 分支 |

## 7. 迁移与数据修复

- 无 SQL/DB 迁移；`task-control-state.json` 由客户端惰性升级。
- 当前卡住的 `test1` 无需手工改文件：升级后第一次控制同步时旧记录缺少轮次 → 判定新轮次 → 重置并清理。
- 验证路径（真实环境）：
  1. 本机目录 `.trellis/tasks/11-20-test1` 被删除并生成新 `handoff-*` 备份；
  2. `task-control-state.json` 对应记录 `ackState=done / outcome=cleaned` 且 `materializedAt=2026-11-20T01:57:03.950Z`；
  3. 服务端 `sync_task.handoff_state = completed`，Board 卡片不再显示“等待来源副本清理”。

## 8. 回滚

- 代码回滚后，旧客户端读取含新字段的状态文件不受影响（serde 忽略未知字段）。
- 若回滚后仍需要让卡住的任务收敛，可手工把对应 handoff 记录的 `ackState` 改为 `pending`、`outcome` 清空后重启客户端；该操作不是交付物。

## 9. 测试设计

- 单元测试（`packages/desktop/src-tauri/src/agent/task_control/tests.rs`）：
  - 同轮次重复 upsert 保留 `done/cleaned`；
  - 新 `materializedAt`/`materializedRevision` upsert 后 `ackState=pending`、`outcome` 为空、备份字段清空；
  - 旧记录（两字段 `None`）+ 带轮次控制 → 重置。
- 状态机级回归（`packages/desktop/src-tauri/src/agent/task_sync/tests/handoff_and_errors.rs`）：
  - 预置一轮 `done/cleaned` 的 handoff + 新轮次控制，调用 `process_handoff_control`，断言本机目录被删除、新备份目录生成、ACK 请求携带新备份元数据（必要时扩展 mock server 的 `/handoff-ack` 路由）。
- 既有 handoff 测试全部保留，验证同轮重试、备份校验、Git/baseline 失败关闭不回归。
- 真实客户端 E2E（发布前补充）：两个真实客户端完成 `A→B→A→C` 委派，确认每轮创建者副本被清理且 Board 收敛为“认领与清理已完成”。

## 10. 残余风险（check 阶段发现）

- **跨轮次陈旧 ACK**：`retry_pending_handoff_acks` 会在处理新控制前重试上一轮 pending ACK；服务端 `ackHandoff` 没有轮次 fencing，若服务端已进入新一轮 `source_cleanup_pending`，旧 ACK 会被接受并把新轮次提前置为 `completed`；随后新轮次若产生不同备份，ACK 会返回 `409 HANDOFF_ACK_MISMATCH`，本地记录永久 pending。
  - 影响：需要“上一轮 ACK 网络失败 + 紧接着再次跨用户委派”两个条件同时成立，概率低，但状态会卡死。
  - 处置：本任务不修复（需要服务端协议/状态机改动），已另建 Trellis 任务 `.trellis/tasks/11-20-handoff-ack-cycle-fencing` 跟踪。