# 设计：稳定物化轮次标识

## 1. 根因

`materialized_at` 被设计成“每次物化/上传时间”，但实际被三处反复改写：

1. `updateTaskAssignee`（`packages/server/team/task-control/shared.js:264-269`）在改派时只把
   `materialization_state` 置为 `pending`，保留上一轮的 `materialized_at`。
2. `updateTaskFromUpload`（`shared.js:304`）在目标客户端**每次上传**时写入
   `materialized_at = now()`。
3. `updateTaskCommandComplete`（`shared.js:296`）在命令完成时再次无条件写入
   `materialized_at = now()`。

客户端从控制快照取得的 epoch 可能是上传时间，之后 `completeCommand` 或后续上传又推进了它；
服务端 fencing 按精确字符串比较，于是同一轮 ACK 被误判为旧轮次。

手工测试证据：

```
requestedMaterializedAt: 2026-11-20T03:56:03.369Z
currentMaterializedAt:   2026-11-20T03:56:03.477Z  (completeCommand)
currentMaterializedAt:   2026-11-20T03:56:04.337Z  (后续上传)
requestedMaterializedRevision = currentMaterializedRevision = 162
```

## 2. 方案选择

**采用：把 `materialized_at` 定义为“本轮首次物化时间”，一轮内只写一次；fencing 以它为准。**

| 方案 | 结论 | 理由 |
| --- | --- | --- |
| 稳定 `materialized_at` | 采用 | 不新增列；现有控制面/客户端字段可直接使用；语义从“最近上传时间”调整为“本轮首次物化时间” |
| 新增独立 `handoff_cycle_id` | 暂不采用 | 更严格，但需要 DB 迁移、协议字段和旧数据回填；当前问题用稳定 at 即可解决 |
| 只比较 revision | 否 | 内容未变的跨轮次 revision 可能相同，无法识别陈旧 ACK |
| 客户端 ACK 前重读最新 at | 否 | 仍有 TOCTOU；服务端标识不稳定才是根因 |

## 3. 服务端改动

### 3.1 改派开启新轮次

`updateTaskAssignee`（`assignPendingTask` 使用）在 assignee 变化时额外清空：

```sql
materialized_at = NULL,
materialized_revision = NULL,
materialized_manifest_sha256 = NULL,
materialized_by_agent_id = NULL
```

保留 `materialization_state = 'pending'` 与现有 `handoff_state` 规则。

### 3.2 首次物化写入，后续上传不改写

`updateTaskFromUpload` 的 `materialized_at` 子句改为“仅目标写入者且当前为空”：

```sql
materialized_at = CASE
  WHEN ? AND materialized_at IS NULL THEN ?
  ELSE materialized_at
END
```

- `materialized_revision` 仍可随每次目标上传更新（反映最新内容 revision）。
- `materialized_manifest_sha256`、`materialized_by_agent_id` 保持现有写入规则。
- `insertTaskFromUpload`（新任务首次上传）不在此范围，保持现状即可。

### 3.3 命令完成只补写

`updateTaskCommandComplete`：

```sql
materialized_at = COALESCE(materialized_at, ?),
materialized_by_agent_id = COALESCE(materialized_by_agent_id, ?),
materialized_revision = ?
```

- 目标已上传：保留首次物化时间。
- 目标未上传（内容未变等）：命令完成时间作为本轮 epoch。
- `materialized_revision` 继续写命令结果的 revision。

### 3.4 fencing 比较优先级

`assertHandoffCycle`：

```js
const stale = ack.materializedAt != null
  ? ack.materializedAt !== current.materializedAt
  : ack.materializedRevision != null
    ? ack.materializedRevision !== current.materializedRevision
    : false
```

- `materializedAt` 提供时只比较 at，**忽略 revision 差异**（同轮后续上传可能推进 revision）。
- 仅在 at 缺失时回退比较 revision。
- 两者都缺失保持旧客户端兼容。

## 4. 客户端

无需改代码：

- 新客户端已同时发送 `materializedAt` 与 `materializedRevision`；服务端 at 匹配后忽略 revision。
- 旧记录回填逻辑不变。
- 收到 `HANDOFF_CYCLE_STALE` 时保持 pending、由新控制重置的行为不变。

## 5. 数据与兼容

- 无 schema 迁移。
- 历史行：`materialized_at` 可能是最后一次上传时间；下一次跨用户改派会清空并按新规则重建。
- 旧客户端：不发送轮次字段 → 兼容路径。
- 新旧服务端混用：新客户端多发的 revision 字段被旧服务端忽略；行为不变。
- 当前手工测试任务 `handoff-manual-e2e-114216` 处于 `conflict/missing`；修复后可通过重新委派给 yhj
  再委派给 kyf 恢复验证，无需手工改库。

## 6. 边界与错误矩阵

| 场景 | 行为 |
| --- | --- |
| 改派到新负责人 | 清空轮次字段，`materialization_state=pending` |
| 目标首次上传 | 写入本轮 `materialized_at` |
| 同轮第二次及以后上传 | `materialized_at` 不变；revision 可更新 |
| 命令完成时已有上传 | 保留上传时写入的 at |
| 命令完成时没有上传 | 用命令完成时间补写 |
| ACK 提供 at 且匹配 | 成功（即使 revision 不同） |
| ACK 提供 at 但陈旧 | `409 HANDOFF_CYCLE_STALE` |
| ACK 只提供 revision | 按 revision 比较 |
| ACK 不提供轮次 | 旧客户端兼容路径 |
| 改派回创建者（creator==assignee） | 同样开启新物化轮次，但不进入 handoff |

## 7. 测试设计

服务端（`packages/server/test/team-task-control.test.js`）：

1. 改派后 `materialized_at` 为空；目标首次上传写入 at1；第二次上传后 at 仍为 at1；
   `completeCommand` 后 at 仍为 at1。
2. ACK 使用 at1 + 不同的 revision → 成功 `completed`（证明 at 优先、revision 忽略）。
3. 再次改派 → at 清空；目标物化写入 at2；旧 at1 ACK → `409 HANDOFF_CYCLE_STALE`，状态/审计不变。
4. 无上传的 assign_task：`completeCommand` 补写 at，ACK 成功。
5. 旧客户端不带轮次字段 → 兼容成功。
6. 现有 handoff/幂等/lease 测试不回归。

客户端（Rust）：现有 `handoff_ack_request` 字段测试保持；无需新增行为测试，但需确认编译。

## 8. 规范更新

`.trellis/spec/backend/desktop-realtime-sync.md`：

- 明确 `materialized_at` 是“本轮首次物化时间”，改派清空、首次上传写入、命令完成只补写。
- ACK fencing：`materializedAt` 优先，`materializedRevision` 仅在 at 缺失时使用。
- 更新测试要求：同轮多次上传后 ACK 成功、跨轮拒绝。