# handoff ACK 轮次 fencing E2E 报告

## 环境与版本

- 日期：2026-11-20，Asia/Shanghai。
- 被测客户端：GitHub Actions run
  [`44667614623`](https://github.com/yxtdhappy/trellis-board/actions/runs/44667614623)，
  head `1b761b0`，portable ZIP SHA256
  `fbd7bc81df2016d67ae9bb9082ce25b50268b456aab27defa63982416b8edcaa`，
  解压后 `trellis-board-client.exe` SHA256
  `04d405047d629df82d41e57127caeaeb8d712dcade19ebac138b64a1f0b34cdd`，版本 `0.4.48`。
- 服务端：本机 `node packages/server/index.js`（PID 3336，直接启动），监听 `0.0.0.0:4317`，
  日志 `%LOCALAPPDATA%\TrellisBoard\server\logs\server.1.log`。
- 数据库：`%LOCALAPPDATA%\TrellisBoard\server\board.sqlite`。
- taskSpace：`3536a478-4b1b-4b3b-a8f0-42903482d33d`，仓库 `\\?\D:\wit\trellis-board`，分支 `main`。
- E2E 任务：`handoff-fencing-e2e-113222`，目录 `.trellis/tasks/11-20-handoff-fencing-e2e-113222`，
  创建者 yhj，目标负责人 kyf（kanyifei）。

## 场景搭建（真实 API，不模拟服务端）

1. 通过 Board API `POST /api/tasks` 创建任务并指派给 yhj；旧客户端执行 `create_task`
   落地本地副本，服务端 `materialized`（content revision 157）。
2. 停止旧客户端，避免创建者提前清理。
3. 通过 Board API `POST /api/tasks/assign` 改派给 kyf；kyf 在线客户端完成物化，
   服务端进入新一轮 `source_cleanup_pending`：`materialized_at=2026-11-20T03:32:52.733Z`、
   `materialized_revision=158`。
4. 重启本地服务端加载 fencing 代码。
5. 在本机 `task-control-state.json` 注入一条**旧轮次 pending ACK**：
   `materializedAt=2000-01-01T00:00:00.000Z`、`materializedRevision=1`、`outcome=cleaned`。
   客户端的 cleaned ACK 重试会先复核备份；由于伪造备份不存在，它按既有逻辑转为
   `conflict/missing` 后发送——本轮 E2E 覆盖的是“陈旧 ACK（conflict 分支）被 fencing 拒绝”的路径，
   cleaned 分支由服务端测试覆盖。
6. 启动 CI 新客户端，观察服务端拒绝与后续新轮次清理。

## 结果

| 断言 | 结果 | 证据 |
| --- | --- | --- |
| 陈旧 ACK 被服务端拒绝 | 通过 | `server.1.log:3009`：`handoff ACK 属于旧物化轮次，拒绝推进状态`，请求 epoch `2000-01-01T00:00:00.000Z/1`，当前 epoch `2026-11-20T03:32:52.733Z/158` |
| 旧 ACK 不推进状态、不写审计 | 通过 | 该任务审计仅 1 条（id=38，`cleaned`，新备份 `handoff-cd290a1a20126452`） |
| 新轮次清理完成 | 通过 | 服务端 `handoff_state=completed`；本机活动目录已删除；备份 `handoff-cd290a1a20126452`（4 文件/974 字节，meta revision 158） |
| 客户端按新轮次重置 | 通过 | 本机记录 `materializedAt=2026-11-20T03:32:52.733Z`、`materializedRevision=158`、`ackState=done`、`outcome=cleaned` |
| Board UI 状态 | 通过 | 卡片 `handoff 轮次 fencing E2E` 显示绿色“认领与清理已完成”，见 `e2e-board-after.png` |

关键日志（服务端）：

```json
{"level":40,"time":"2026-11-20T03:36:08.520Z","msg":"handoff ACK 属于旧物化轮次，拒绝推进状态 { executionTaskKey: '3536a478-4b1b-4b3b-a8f0-42903482d33d::handoff-fencing-e2e-113222', requestedMaterializedAt: '2000-01-01T00:00:00.000Z', requestedMaterializedRevision: 1, currentMaterializedAt: '2026-11-20T03:32:52.733Z', currentMaterializedRevision: 158 }"}
```

审计（服务端）：

```json
{"id":38,"result":"cleaned","detail_json":"{\"outcome\":\"cleaned\",\"reason\":null,\"backupId\":\"handoff-cd290a1a20126452\",\"manifestSha256\":\"cd290a1a20126452379c32c6060a98dfee8ceee26a8f29bcda5b4b04414ec22b\",\"fileCount\":4,\"totalBytes\":974}","occurred_at":"2026-11-20T03:36:10.213Z"}
```

## 兼容性说明

- 服务端先更新，旧客户端不携带轮次字段仍可正常 ACK（兼容路径）；本 E2E 中目标负责人 kyf
  使用旧客户端，未受影响。
- 创建者 yhj 使用新客户端后，陈旧 ACK 被拒绝并按新轮次恢复。
- 永久不升级的旧创建者客户端仍存在原有竞态，已记录为已知限制。

## 环境恢复与遗留

- E2E 客户端已停止；原安装客户端
  `%LOCALAPPDATA%\TrellisBoard_0.4.48_x64-portable` 已重新启动。
- 本地服务端当前以新代码直接运行（PID 3336），未通过 `yarn start` 托管，后续可按需重启。
- E2E 任务 `handoff-fencing-e2e-113222` 保留在 Board 上（目标负责人 kyf），作为测试记录；
  本机来源副本已按预期清理。
- 备份与日志位于 `%TEMP%\trellis-e2e-fencing-44667614623\`。

## 结论

**PASS**。服务端轮次 fencing 在真实客户端 + 真实服务端 + 真实任务数据上生效：陈旧 ACK 被拒绝且不写审计，
新轮次正常清理并收敛为 `completed`，Board UI 显示完成状态。可进入归档。