# 真实 E2E 报告：任务快照批量上限

测试时间：2026-11-11 21:59-22:08（Asia/Shanghai）

## 1. 测试拓扑

| 层 | 实例 | 说明 |
| --- | --- | --- |
| 服务端 | `node server/index.js`，PID `34124` | 2026-11-11 21:59:16 启动，`team` 模式，监听 `0.0.0.0:4317` |
| 客户端 | `trellis-board-client.exe`，PID `32476` | Windows Tauri/WebView2 客户端，连接 `http://192.168.65.27:4317` |
| Agent | `trellis-agent.exe`，PID `15208` | 当前账号 `yhj`，Agent ID `118a1b6e-b1cb-44cb-b877-54e1adef16b5` |
| 项目 | `D:\wit\mdp-backend-service` | 分支 `dev`，taskSpace `7b8d00fa-f478-4c47-a0ef-615462d5bdb5` |
| 项目远端 | `ssh://git.weintdata.cn:1022/prod-mdp/mdp-backend-service` | Git 远端项目，不是 `file://` 本地仓库 |
| 数据库 | `C:\Users\yuhaojie\AppData\Local\TrellisBoard\server\board.sqlite` | E2E 前备份见下方 |

E2E 前数据库备份：

```text
C:\Users\yuhaojie\AppData\Local\TrellisBoard\server\backups\board.sqlite.pre-batch-limit-e2e-20261111T135723793Z.sqlite
```

备份大小 `4,042,752` 字节，`PRAGMA integrity_check` 为 `ok`。

## 2. 逐步证据

| # | 操作 / 请求 | 服务端或数据库证据 | 结论 |
| --- | --- | --- | --- |
| 1 | 启动新服务端并检查健康状态 | `/api/health` 返回 `status=ok`、`mode=team`、`processId=34124` | 通过 |
| 2 | 客户端自动重试原 pending 批次 | `batchId=99657071-48db-434e-afb3-a0fd9a295631`、`clientSequence=27`，成功落到 revision `27` | 通过 |
| 3 | 检查 250 文件 Oracle 任务 | revision `27` 的 `sync_file_audit` 有 `250` 条 `e2e-oracle` 文件记录 | 通过 |
| 4 | 对照 Oracle 任务文件正文 | 本地与服务端均为 `250` 文件、`5,648,600` 字节，缺失/多出/摘要差异均为 `0` | 通过 |
| 5 | 等待其余任务初始同步 | taskSpace 最终 revision `135`，`indexed_revision=135`，`last_error=null` | 通过 |
| 6 | 全量对照项目任务文件 | 本地与服务端均为 `1518` 文件，路径、SHA-256、规范化正文差异均为 `0` | 通过 |
| 7 | 检查任务索引 | `sync_task_index` 为 `135` 条；服务端 taskSpace 活跃文件 `1518` 条，删除记录 `0` 条 | 通过 |
| 8 | 检查 Agent 持久状态 | 项目 binding 为 `initialSyncCompleted=true`、`liveSyncStatus=ready`、`lastError=null`，最后同步提交 `8079fbe39ae2407ab88e38c00b09dfdc56d96e32` | 通过 |
| 9 | 打开客户端项目栏 | 可见 `mdp-backend-service 已关联 · 同步正常` 和分支 `dev`，无同步失败弹窗 | 通过 |
| 10 | 打开归档索引 | 页面加载 `134` 条已归档任务；当前另有 `1` 条进行中任务，与索引总数 `135` 对齐 | 通过 |
| 11 | 搜索 `Oracle` | 结果包含 `Oracle 数据源全量 UI E2E 验证 #10-03-e2e-oracle · 已归档`，页面显示 `1-19 / 共 19 条` | 通过 |

现场截图在验收后已清理；上面的 UI 结论来自 WebView2 可访问文本、页面截图即时核对、
服务端 taskSpace/index 数据和 Agent 持久状态的交叉验证。

## 3. 日志结论

- 服务端 PID `34124` 启动后的日志增量中 `ERROR=0`。
- Agent 日志在测试窗口内 `ERROR=0`。
- Agent 在 `14:00:19.530Z` 出现一次
  `connect ETIMEDOUT 192.168.65.27:4317`，随后恢复，revision 继续从 `27` 增长到 `135`，
  不是持续同步失败。
- 重启前的 64 文件上限拒绝日志属于修复前历史日志，不计入本次运行结果。
- 成功读取的 Board GET 请求没有被服务端访问日志逐条记录；页面结果通过 WebView2
  可访问文本、服务端 taskSpace/index 数据和 Agent 持久状态三方对齐。

## 4. 容量边界说明

- 真实 E2E 覆盖了本次故障的实际回归场景：旧上限下的 `250` 文件单任务批次自动恢复。
- 恰好 `1024` 文件、`1025` 文件拒绝、恰好 `64 MiB`、`64 MiB + 1` 字节拒绝、
  `96 MiB` 运输边界和单文件 `1 MiB` 边界由自动测试覆盖。
- `64 MiB` 是正常文本任务的业务目标，编码后的 JSON 请求仍受 `96 MiB` 硬运输上限约束；
  超过运输上限时返回 413，不进入业务写入。
- 本轮没有向真实项目写入伪造的超大批次，避免污染 `mdp-backend-service`。

## 5. 清理与状态

- 本轮没有创建测试任务、测试项目或伪造文件。
- 没有删除 Agent cursor、重新绑定项目或清空 taskSpace。
- 原 pending 批次由客户端自行重试并完成，未修改本地任务正文。
- E2E 前数据库备份保留；真实 taskSpace 数据保留。
- 服务端 PID `34124` 保持运行，供用户继续验收。
