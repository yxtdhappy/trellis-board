# 设计：服务端 handoff ACK 轮次 fencing

## 1. 方案与边界

- 轮次来源：`sync_task.materialized_at` 与 `sync_task.materialized_revision`。两者在每次命令完成时原子更新（`packages/server/team/task-control/shared.js:293-299`），控制面已下发（`views.js:130-133`），客户端 handoff 记录已持久化。
- 权威校验放在服务端 `ackHandoff`（`packages/server/team/task-control/handoff.js`），在任何状态推进、幂等判断和审计写入之前执行。
- 客户端只负责携带轮次并在收到新错误码时保持 pending；轮次重置逻辑复用上一任务已实现的 `materializedAt/materializedRevision` 比较（`packages/desktop/src-tauri/src/agent/task_control.rs`）。
- 不做客户端 ACK 前 GET 预检：服务端校验已覆盖 TOCTOU；预检只增加请求，不构成额外保证。

## 2. 协议契约

### 请求

`POST /api/agent/tasks/:executionTaskKey/handoff-ack`

| 字段 | 类型 | 必填 | 约束 |
| --- | --- | --- | --- |
| `outcome` | string | 是 | `cleaned` / `conflict` |
| `reason` | string | conflict 必填 | 现有白名单 |
| `backupId` | string | cleaned 必填 | 现有格式 |
| `manifestSha256` | string | cleaned 必填 | 64 位小写 hex |
| `fileCount` | integer | cleaned 必填 | 1..100000 |
| `totalBytes` | integer | cleaned 必填 | 1..64 MiB |
| `materializedAt` | string | 新客户端必填 | `YYYY-MM-DDTHH:mm:ss.sssZ`，≤ 24 字符，与 `sync_task.materialized_at` 精确相等 |
| `materializedRevision` | integer | 可选 | ≥ 0 的安全整数，与 `sync_task.materialized_revision` 相等 |

- 新客户端在 cleaned 和 conflict ACK 中都发送 `materializedAt`；有 `materializedRevision` 时一并发送。
- 旧客户端不发送这两个字段时，服务端走兼容路径（与现状一致）。
- 服务端忽略未知字段，新客户端对旧服务端安全。

### 响应与错误

| 条件 | 结果 |
| --- | --- |
| `materializedAt` 与当前行一致（且提供的 revision 也一致） | 按现有逻辑处理，返回 `{handoffState, outcome, idempotent, updatedAt}` |
| `materializedAt` 与当前行不一致 | `409 HANDOFF_CYCLE_STALE`，`details` 返回当前 `materializedAt`/`materializedRevision`；不写审计、不改状态 |
| 仅提供 `materializedRevision` 且不一致 | 同上 |
| 同时提供但只有一项不一致 | 同上（两项都必须匹配） |
| 两个字段都缺失 | 兼容路径，按现有逻辑处理 |
| 当前行 `materialized_at` 为空而请求提供了值 | `409 HANDOFF_CYCLE_STALE` |
| 已完成终态的重复 ACK 且轮次一致 | 现有幂等元数据校验（可能 `409 HANDOFF_ACK_MISMATCH`） |
| 已完成终态的 ACK 但轮次陈旧 | 优先 `409 HANDOFF_CYCLE_STALE`，不进入幂等比较 |

## 3. 服务端实现

`packages/server/team/task-control/shared.js` 的 `normalizeHandoffAck`：

- 新增 `materializedAt`：`text(input.materializedAt, 24)`，非空时校验 `/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/`，否则 `400 INVALID_INPUT`；返回 `null` 表示未提供。
- 新增 `materializedRevision`：仅在 `input.materializedRevision !== undefined/null` 时解析，要求 `Number.isSafeInteger(value) && value >= 0`；否则 `400 INVALID_INPUT`。返回 `null` 表示未提供。

`packages/server/team/task-control/handoff.js` 的 `ackHandoff`：

```js
function assertHandoffCycle(row, ack) {
  const currentAt = row.materialized_at || null
  const currentRevision =
    row.materialized_revision == null ? null : Number(row.materialized_revision)
  if (ack.materializedAt != null && ack.materializedAt !== currentAt) {
    throw teamError(409, 'HANDOFF_CYCLE_STALE', 'handoff ACK 属于旧物化轮次', {
      details: { materializedAt: currentAt, materializedRevision: currentRevision },
    })
  }
  if (ack.materializedRevision != null && ack.materializedRevision !== currentRevision) {
    throw teamError(409, 'HANDOFF_CYCLE_STALE', 'handoff ACK 属于旧物化轮次', {
      details: { materializedAt: currentAt, materializedRevision: currentRevision },
    })
  }
}
```

调用顺序：读取并校验 row / ownership 之后，**先** `assertHandoffCycle(row, ack)`，再进入现有 `completed/conflict/pending` 分支。拒绝路径不调用 `appendAuditEvent`。

可观测性：拒绝时写入一条服务端 warn 日志（沿用现有日志设施；不新增审计行，避免污染 ACK 终态审计）。

## 4. 客户端实现

`packages/desktop/src-tauri/src/agent/task_sync/handoff.rs` 的 `handoff_ack_request`：

```rust
if let Some(at) = handoff.materialized_at.as_deref() {
    request["materializedAt"] = Value::String(at.to_string());
}
if let Some(revision) = handoff.materialized_revision {
    request["materializedRevision"] = json!(revision);
}
```

`packages/desktop/src-tauri/src/agent/task_sync/control.rs` 的 `attempt_handoff_ack`：

- 旧记录（`materialized_at == None`）在发送前回填：读取本地最新控制（`TaskControlStateFile.controls[execution_task_key]`），用其 `materialized_at/materialized_revision` 填充请求副本；不改写持久记录。
- `HANDOFF_CYCLE_STALE`：记录 warn 日志并返回 `Ok(false)`，保持 `ackState=pending`；不调用 `mark_handoff_ack_done`，也不转 conflict。
- 后续由控制同步恢复：`process_handoff_control` 先用新控制 upsert，触发上一任务的轮次比较逻辑，重置为新轮次（pending/空 outcome），再执行清理和 ACK。

## 5. 兼容与发布顺序

1. **先发服务端**：旧客户端不发送轮次字段，走兼容路径；新客户端发送字段后获得 fencing。
2. **再发客户端**：新客户端对旧服务端发送未知字段，服务端 `normalizeHandoffAck` 不读取即忽略，行为不变。
3. **回滚**：服务端回滚后忽略字段；客户端保持发送字段不影响旧服务端。

已知限制：永远不升级、不发送轮次字段的旧客户端仍可能触发该竞态；需在升级窗口内接受，或在后续版本中要求最小 Agent 版本。

## 6. 边界与错误矩阵（客户端）

| 场景 | 行为 |
| --- | --- |
| ACK 携带当前轮次 | 服务端正常处理 |
| ACK 携带旧轮次 | `409 HANDOFF_CYCLE_STALE`；本地保持 pending；下一次控制同步重置并清理 |
| 旧记录无轮次字段、本地有控制 | 用控制轮次回填后发送 |
| 旧记录无轮次字段、本地无控制 | 不发送轮次，走服务端兼容路径 |
| 网络失败/超时 | 现有 pending 重试，不改变轮次字段 |
| 服务端返回 `HANDOFF_LEASE_HELD` | 现有 lease_active 处理不变 |

## 7. 测试设计

### 服务端（`packages/server/test/team-task-control.test.js`）

以现有 handoff fixture 为基础：

1. 匹配轮次的 cleaned ACK → `completed`，审计新增。
2. 模拟新轮次：更新 `sync_task.materialized_at/materialized_revision` 并重置 `handoff_state='source_cleanup_pending'`；用旧轮次 ACK → `409 HANDOFF_CYCLE_STALE`，状态仍 pending，审计无新增。
3. 用新轮次 ACK → `completed`，审计包含新备份。
4. 不带轮次字段的旧 ACK → 兼容成功（现有用例保持通过）。
5. 已完成终态：轮次一致的重复 ACK 幂等；轮次陈旧的重复 ACK → `HANDOFF_CYCLE_STALE`。
6. conflict ACK 使用旧轮次 → `HANDOFF_CYCLE_STALE`。
7. 非法 `materializedAt`（格式错误/超长）与负 revision → `400 INVALID_INPUT`。

### 客户端（Rust）

1. `handoff_ack_request`：有轮次时包含两个字段；无轮次时省略。
2. `attempt_handoff_ack`：mock 返回 `409 HANDOFF_CYCLE_STALE` 时 `ackState` 保持 pending，未标记 done。
3. 状态机级：pending 旧 ACK 收到 409 后，新控制到达 → 重置 → 备份 → 删除 → 新 ACK 成功。
4. 旧记录回填：handoff 无轮次、本地 control 有轮次时，请求包含 control 的轮次。
5. mock server 增加可配置 `/handoff-ack` 响应（默认 200；测试可返回 409 + code）。

## 8. 规范更新

`.trellis/spec/backend/desktop-realtime-sync.md`：

- ACK 请求字段表新增 `materializedAt` / `materializedRevision`。
- 新增 `409 HANDOFF_CYCLE_STALE` 的校验顺序与错误矩阵。
- 明确旧客户端兼容路径与升级顺序。
- 测试要求补充跨轮次陈旧 ACK 竞态用例。