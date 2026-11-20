# E2E 报告：稳定 handoff 物化轮次标识

## 环境

- 服务端：本机 `packages/server`，代码含 `a359fcf fix(server): 稳定 handoff 物化轮次标识`，监听 `0.0.0.0:4317`。
- 客户端：CI v0.4.49 构建（`TrellisBoard_0.4.49_x64-portable`），支持发送 `materializedAt`/`materializedRevision`，PID 14256。
- 服务端数据库：`C:\Users\yuhaojie\AppData\Local\TrellisBoard\server\board.sqlite`。
- 服务端日志：`C:\Users\yuhaojie\AppData\Local\TrellisBoard\server\logs\server.1.log`。
- 客户端日志：`C:\Users\yuhaojie\AppData\Local\TrellisBoard\data\logs\desktop.log`。
- 被测任务：`handoff-stable-e2e-123311`（`3536a478-4b1b-4b3b-a8f0-42903482d33d::.trellis/tasks/11-20-handoff-stable-e2e-123311`）。

## E2E A：常规清理（同轮 ACK 不被误拒）

步骤：

1. 创建测试任务并委派给 kyf；kyf 客户端物化。
2. 创建者（yhj）本机校验、备份并删除本地副本，客户端发送 `cleaned` ACK。
3. ACK 携带物化轮次 `materializedAt`/`materializedRevision`。

实际结果：

| 断言 | 结果 | 证据 |
| --- | --- | --- |
| pending 轮次 | `2026-11-20T04:33:25.947Z` / revision 171 | 服务端控制快照 |
| 服务端进入 `handoff_state=completed` | 通过 | `sync_task.handoff_state=completed` |
| 审计新增一条 `task_handoff_cleanup_ack`，`result=cleaned` | 通过，id=43 | `backupId=handoff-b8a7029c613a6b5a`，`fileCount=4`，`totalBytes=1004`，`occurred_at=2026-11-20T04:33:28.971Z` |
| 本机来源目录已删除 | 通过 | `.trellis/tasks/11-20-handoff-stable-e2e-123311` 不存在 |
| 未出现 `HANDOFF_CYCLE_STALE` 拒绝 | 通过 | 服务端该时间段无拒绝日志 |

说明：本轮未发生“同一轮内后续上传/命令完成推进 `materialized_at` 导致 ACK 被误拒”的旧问题；审计仅一条 cleaned，无 conflict。

## E2E B：陈旧 ACK 被 fencing 拒绝

步骤：

1. 将任务改派回 yhj，本机重新物化（轮次 `2026-11-20T04:33:48.988Z` / revision 172）。
2. 停止本机客户端。
3. 再委派给 kyf，服务端开启新轮次（`2026-11-20T04:34:01.969Z` / revision 173）。
4. 向本机本地控制文件注入陈旧 ACK（`materializedAt=2000-01-01T00:00:00.000Z`、`materializedRevision=1`，伪造备份 `handoff-0123456789abcdef`）。
5. 启动 v0.4.49 客户端，观察其先尝试陈旧 ACK、再按新控制重新物化并 ACK。

实际结果：

| 断言 | 结果 | 证据 |
| --- | --- | --- |
| 服务端拒绝陈旧 ACK | 通过 | `server.1.log:3124`：`requestedMaterializedAt: '2000-01-01T00:00:00.000Z', requestedMaterializedRevision: 1, currentMaterializedAt: '2026-11-20T04:34:01.969Z', currentMaterializedRevision: 173`，消息“handoff ACK 属于旧物化轮次，拒绝推进状态” |
| 客户端将拒绝视为可重试，不清除 pending | 通过 | `desktop.log:911504`：`WARN handoff ACK 属于旧物化轮次 handoff-stable-e2e-123311`，随后按新控制继续 |
| 陈旧 ACK 未写审计 | 通过 | 审计仅有 id=43（E2E A）与 id=44（本轮新 ACK），无伪造 backupId 记录 |
| 新轮次 ACK 成功并完成 | 通过 | 审计 id=44，`result=cleaned`，`backupId=handoff-c9bc18bf2e3297e3`，`fileCount=4`，`totalBytes=1005`，`occurred_at=2026-11-20T04:34:22.443Z`；`sync_task.handoff_state=completed`，`materialized_at=2026-11-20T04:34:01.969Z`，`materialized_revision=173` |
| 本机来源目录已删除 | 通过 | `.trellis/tasks/11-20-handoff-stable-e2e-123311` 不存在 |

## UI 证据

截图：`e2e-board-after.png`（v0.4.49 客户端，任务卡片显示绿色“认领与清理已完成”，任务列于“检查 / 收尾”）。

## 结论

- AC1–AC5 均在真实客户端 + 本机服务端上验证通过。
- 同轮 ACK 不再因 `materialized_at` 被反复改写而误拒（E2E A）。
- 跨轮陈旧 ACK 被服务端 fencing 拒绝，且不影响新轮次完成（E2E B）。
- 旧手工任务 `handoff-manual-e2e-114216` 仍显示“本地副本状态需要人工确认”，属于上一版本缺陷遗留的已知状态，不属于本次修复验收范围。