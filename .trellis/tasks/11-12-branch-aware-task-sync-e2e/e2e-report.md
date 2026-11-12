# 跨分支任务同步隔离 E2E 报告

## 0. 测试拓扑

| 层 | 地址 / 进程 | 说明 |
| --- | --- | --- |
| 真实页面 | Tauri PID `24056`，启动于 `2026-11-12 21:50:57` | 已安装最新客户端，通过 `192.168.65.27:4317` 连接本机 Team 服务 |
| 真实服务 | `http://0.0.0.0:4317`，PID `33208`，启动于 `2026-11-12 21:48:53` | 当前 `main` 源码；`/api/health` 返回 `status=ok`、`mode=team` |
| 隔离服务 | `http://127.0.0.1:4318` | 当前源码、临时 SQLite 数据目录 |
| 转发代理 | `http://127.0.0.1:4319` | `/api/* -> 4318/api/*`，记录 Agent 请求和状态 |
| 隔离 Agent | 临时 `TRELLIS_AGENT_ROOT` | 实际 `agent/cli.js run`，双分支临时仓库 |
| 证据目录 | [evidence](./evidence) | 截图、代理日志、Agent 日志、服务端日志和结果 JSON |

## 1. 真实桌面证据

| # | 页面操作 | 页面/接口证据 | 日志结论 |
| --- | --- | --- | --- |
| 1 | 选择分支 `codex/server-gitless-task-sync` | 项目状态为“分支不一致，已暂停同步”，详情为“本地当前分支为 `main`，绑定分支为 `codex/server-gitless-task-sync`” | Agent 此前已记录 `BRANCH_MISMATCH`；本机关联配置为 `liveSyncStatus=error`、`lastErrorCode=BRANCH_MISMATCH` |
| 2 | 选择分支 `main` | 项目状态为“已关联 · 同步正常” | 本机 `main` 关联为 `liveSyncStatus=ready`、无 `lastErrorCode` |
| 3 | 选择整个项目 `trellis-board` | 汇总为“`1/2` 个分支已暂停”，显示“按分支独立统计” | 与两条分支真实关联状态一致 |

页面截图：

- [整个项目汇总](./e2e-project-selected.png)
- [暂停分支](./e2e-paused-branch-selected-final.png)
- [正常 main 分支](./e2e-main-normal.png)

三次选择均为前端本地状态切换，服务端、桌面日志和 Agent 日志无新增请求或异常；状态由
`list_local_associations` 的 3 秒轮询结果驱动，本机关联配置与页面文案一致。

## 2. 隔离同步证据

| # | 操作 / 请求 | 响应、日志或数据证据 | 结论 |
| --- | --- | --- | --- |
| 1 | `main` 首次上传本地任务 | 代理记录 `POST /api/agent/task-spaces/:id/changes -> 200`；revision `0 -> 1`；服务端文件数 `2` | ✅ |
| 2 | 切到 `feature/e2e-branch` 并新增本地任务 | `lastErrorCode=BRANCH_MISMATCH`；revision 保持 `1`；cursor 保持 `sequence=1/revision=1`；无错分支文件 | ✅ 失败关闭 |
| 3 | 缺失 `observedBranchName` | `400 BRANCH_OBSERVATION_REQUIRED` | ✅ 预期业务错误 |
| 4 | 错误 `observedBranchName` | `400 BRANCH_TASK_SPACE_MISMATCH` | ✅ 预期业务错误 |
| 5 | feature 分支期间服务端写入任务 | revision 增至 `2`；本地未写文件；cursor 保持 `1` | ✅ 拉取失败关闭 |
| 6 | 切回 `main` 并触发拉取 | server-only 任务落盘；本地与服务端 cursor 到 `3`；绑定恢复 `ready` | ✅ 恢复成功 |
| 7 | 重新关联 feature 分支 | 本机 binding 数 `1`；服务端 feature `approved`、main `revoked`；main taskSpace 保持 revision `3`、文件数 `4` | ✅ 替换收敛 |

结构化结果见 [e2e-result.json](./evidence/e2e-result.json)，请求代理证据见
[proxy.log](./evidence/proxy.log)，Agent 业务错误见
[agent-process.log](./evidence/agent-process.log)。

## 3. 失败与修正

前两次隔离运行都在“切回 main 后自动恢复”处超时。增量日志显示 Agent 发出了
`initial_sync_review`，原因为运行器在首次 bootstrap 刚完成上传、尚未写入
`initialSyncCompleted=true` 时就切到了 feature 分支。

这是 E2E 脚手架时序问题，不是生产分支恢复缺陷。运行器已改为等待
`initialSyncCompleted=true`、`liveSyncStatus=ready` 且无 `lastErrorCode` 后再进入错分支场景；
同一路径重跑后通过。

## 4. 清理与回归

- 4318、4319 已停止，当前仅保留最新 4317 服务 PID `33208`。
- 隔离临时根目录已删除；另清理了首次成功运行遗留的临时 `git rev-parse` 子进程。
- 未对真实数据库执行 `--apply`，未删除存量任务或归档。
- 未修改真实 Agent 绑定。
- `agent/test/task-snapshot-sync.test.js` 与 `tests/project-rail-association.test.js`
  回归共 `54/54` 通过。

## 5. 结论

PRD 的 8 条验收标准全部满足。跨分支上传、拉取、恢复、绑定替换、服务端第二道防线和真实
Tauri 项目栏状态均已闭环。
