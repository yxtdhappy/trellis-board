# handoff 二次轮次清理 E2E 报告

## 环境与版本

- 日期：2026-11-20，Asia/Shanghai。
- 被测客户端：GitHub Actions run
  [`44663521779`](https://github.com/yxtdhappy/trellis-board/actions/runs/44663521779)，
  head `e6c2678`，portable ZIP SHA256
  `715919c9aec1c76b80a51183f55c67409746442c004837f641efc81d2db9ba9d`，
  解压后 `trellis-board-client.exe` SHA256
  `a39c5a6cfe13df9d6737992f2218622e4d2109cd98e2b4bcd84b43f344cb7e09`，版本 `0.4.48`。
- 服务端：本机 `node packages/server/index.js`（PID 5944），监听 `0.0.0.0:4317`；
  客户端连接 `http://192.168.65.27:4317`。
- 数据库：`%LOCALAPPDATA%\TrellisBoard\server\board.sqlite`。
- taskSpace：`3536a478-4b1b-4b3b-a8f0-42903482d33d`，仓库 `\\?\D:\wit\trellis-board`，
  分支 `main`。
- Agent 状态：`%LOCALAPPDATA%\TrellisBoard\data\agent\task-control-state.json`。

## 前置状态（复现现场）

- 任务 `test1`（`.trellis/tasks/11-20-test1`）当前为 `source_cleanup_pending`：
  `materialized_at=2026-11-20T02:12:52.819Z`、`materialized_revision=142`、
  `updated_at=2026-11-20T02:35:23.334Z`。
- 服务端审计只有第一轮清理：`audit_event.id=36`，`cleaned`，备份
  `handoff-8f4d8c4dab571e0e`。
- 本机 handoff 记录沿用第一轮终态：`ackState=done`、`outcome=cleaned`、
  `backupId=handoff-8f4d8c4dab571e0e`，且 `materializedAt/materializedRevision`
  均为 `null`（旧版本状态文件）。
- 本机活动目录存在 4 个文件，cursor baseline 与磁盘摘要一致，目录未被 Git 跟踪，
  当前分支 `main`，清理前置条件为 `Ready`。

## 验证步骤

1. 从 CI run `44663521779` 下载 `trellis-board-desktop-windows` 产物，校验 ZIP
   SHA256 通过。
2. 备份 `task-control-state.json`、`live-cursors.json`、任务目录和服务端数据库到
   `%TEMP%\trellis-e2e-44662429408\backup\`。
3. 停止旧客户端（PID 13640），启动 CI 构建的客户端；不修改仓库、不改服务端数据库。
4. 等待 Agent 正常控制同步（启动后约 9 秒完成 ACK）。
5. 核对本机文件、备份、Agent 状态、服务端 `sync_task`、审计事件和 Board UI。

## 结果

| 断言 | 结果 | 证据 |
| --- | --- | --- |
| 本机活动副本被清理 | 通过 | `.trellis/tasks/11-20-test1` 已不存在 |
| 新轮次完整备份 | 通过 | `handoff-c44c8d67db7c1af9`，`materializedRevision=142`，4 文件 / 845 字节 |
| 本机 handoff 记录进入新轮次 | 通过 | `materializedAt=2026-11-20T02:12:52.819Z`、`materializedRevision=142` |
| 清理 ACK 完成 | 通过 | `ackState=done`、`outcome=cleaned`、`backupId=handoff-c44c8d67db7c1af9` |
| 服务端收敛 | 通过 | `sync_task.handoff_state=completed`，`updated_at=2026-11-20T03:00:36.849Z` |
| 服务端审计新增 cleaned | 通过 | `audit_event.id=37`，`cleaned`，新备份 `handoff-c44c8d67db7c1af9` |
| Board UI 状态 | 通过 | 卡片 `委派测试1` 显示绿色“认领与清理已完成”，见 `e2e-board-after.png` |

结论：旧版本状态文件（无轮次字段、`done/cleaned`）在遇到新物化轮次后按设计自愈；
第二轮清理完整执行并收敛为 `completed`，无需手工修改状态文件。

## CI 前置修复

前两次 CI 暴露出 `6301262`（无提交时停止 pull 递归）的回归：归档目录 409 场景
`committedRevision=0` 时直接返回，跳过快照应用。为让本任务可在 CI 验证，已在 `main`
上补充：

- `cab412d`：无提交时停止递归但继续应用当前快照；
- `d33817d`：上传无提交时按最新 cursor 重算 baseline，避免旧基线写回；
- `e6c2678`：同步更新归档 409 用例的快照拉取次数断言。

最终 CI run `44663521779`：`Rust unit tests`、`Bundle desktop client`、
`Upload artifacts` 全部通过，Node 测试通过。

## 环境恢复

- E2E 客户端已停止，原安装客户端
  `%LOCALAPPDATA%\TrellisBoard_0.4.48_x64-portable` 已重新启动。
- 备份保留在 `%TEMP%\trellis-e2e-44662429408\backup\`，用于事后核对。
- 注意：当前安装客户端仍是修复前的二进制；需升级到包含本修复的构建后，后续轮次
  handoff 才会自动按轮次清理。

## 结论

**PASS**。本任务的代码、规范更新与 E2E 验证均已完成，可进入归档。