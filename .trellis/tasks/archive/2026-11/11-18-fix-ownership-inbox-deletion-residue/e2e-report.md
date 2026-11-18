# 待归属任务删除残留 E2E 报告

## 1. 测试拓扑与版本

| 层 | 实际运行信息 | 结论 |
| --- | --- | --- |
| 服务端 | PID `29840`，`node packages/server/index.js`，启动于 `2026-11-18 19:17:22 +08:00`，监听 `0.0.0.0:4317` | 运行中；启动日志为 `11:17:23.716Z` |
| 客户端 | PID `41428`，`TrellisBoard_0.4.40_x64-portable`，启动于 `2026-11-18 19:20:05 +08:00` | 运行中 |
| Web/API | `http://192.168.65.27:4317/` | `/api/team/status`、`/api/ownership-inbox?limit=50` 均返回 `200` |
| 服务端数据库 | `C:\Users\yuhaojie\AppData\Local\TrellisBoard\server\board.sqlite` | `sync_task_ownership_inbox`、`sync_task_index`、`sync_task_space_file` 已核对 |
| 客户端 cursor | `C:\Users\yuhaojie\AppData\Local\TrellisBoard\data\agent\live-cursors.json` | 两份待归属账本已核对 |
| 服务端日志 | `C:\Users\yuhaojie\AppData\Local\TrellisBoard\server\logs\server.1.log` | 已按时间窗读取 |
| 客户端日志 | `C:\Users\yuhaojie\AppData\Local\TrellisBoard\data\logs\desktop.log` | 已按任务目录、错误码和时间窗读取 |

版本证据：

- 修复提交为 `8c101fc`，tag 为 `v0.4.40`。
- GitHub Actions run `44291537801` 成功：Node 全量测试 `3m23s`，Rust 单测、桌面打包、
  portable smoke、launch smoke 和 Release 资产发布均成功。
- 官方 portable 包下载到
  `C:\Users\yuhaojie\AppData\Local\TrellisBoard_0.4.40_x64-portable-e2e-20261118-1915`，
  SHA-256 为 `9b7d94865d3a8028c662cef99027a1038ef4cd93320419461c3330d5b70b054f`，
  与 Release `.sha256` 一致。
- WebView 页面实际显示 `v0.4.40`。

## 2. 逐步证据

### 2.1 空分支任务进入双账本和项目收件箱

- 创建目录
  `.trellis/tasks/11-18-e2e-ownership-offline-20261118-1915`，
  稳定任务 ID 为 `e2e-ownership-offline-id-20261118-1915`，目录名与任务 ID 故意不同。
- 服务端 `sync_task_ownership_inbox` 出现 1 行，
  `reason=TASK_OWNERSHIP_REQUIRED`，`source_branch_name=main`。
- 客户端 cursor 同时存在该目录的 `ownershipPending` 和 `pendingRejected`。
- 客户端日志 `11:15:25.578Z` 记录增量 ownership 扫描：
  `scanMode=incremental`、`taskJsonParsed=1`、`elapsedMs=488`。

### 2.2 服务端离线后删除任务

- 停止服务端 PID `52600`，确认 `4317` 无监听。
- 直接删除上述本地任务目录。
- 客户端日志 `11:16:53.366Z`、`11:16:55.985Z` 记录 `NETWORK_ERROR`，
  对应 ownership inbox 和 files 请求均无法连接。
- 服务端 SQLite 行仍存在；客户端 `ownershipPending`、`pendingRejected` 仍存在；
  本地任务目录已不存在。失败关闭符合预期。

### 2.3 0.4.40 启动自动续传

- 恢复服务端 PID `29840`，启动 `0.4.40` 客户端 PID `38704`，不点击归属界面、不手动 invoke。
- 从观察开始 `772ms` 内：服务端 inbox 行变为 0，两份 cursor 账本均为空。
- WebView 页面显示 `v0.4.40`、`已关联 · 同步正常`，
  不包含“待归属任务 N”或“服务端拒绝待处理”。
- `list_task_ownership` 返回 `items=[]`。

### 2.4 客户端重启不复活

- 关闭第一台 `0.4.40` 客户端，启动 PID `41428`。
- 重启后再次核对：`inboxCount=0`、`ownershipPending=false`、`pendingRejected=false`。
- 页面继续显示 `v0.4.40`、同步正常，没有待归属或拒绝提示。

### 2.5 普通 main 已上传任务删除回归

- 创建 `branch=main` 探针
  `.trellis/tasks/11-18-e2e-main-delete-20261118-1921`。
- 上传后 `sync_task_index` 和 `sync_task` 各有 1 行；
  `sync_task_space_file` 的 `task.json`、`prd.md` 均为 revision `8`、`deleted=0`。
- 删除本地目录后，任务索引变为 0；两条文件行在同一 revision `9` 变为 `deleted=1`。
- 页面不再显示该任务标题，且没有待归属/拒绝提示。

### 2.6 父目录缺失时失败关闭

- 创建空分支探针
  `.trellis/tasks/11-18-e2e-hidden-parent-20261118-1924`，
  确认项目 inbox 为 1、该目录双账本存在、任务索引总数为 128。
- 暂时把 `.trellis/tasks` 改名为 `.trellis/tasks.e2e-hidden-20261118-1924`，等待 8 秒：
  `tasksParentExists=false`，但 inbox 仍为 1、任务索引仍为 128、两份 cursor 均保留。
- 恢复父目录后帐本仍保留；随后正常删除探针，inbox 和两份 cursor 收敛为 0。
- 没有把“父目录不可读”误解释为全部任务已删除。

### 2.7 活动任务移动到 archive

- 创建空分支探针
  `.trellis/tasks/11-18-e2e-archive-move-20261118-1927`，确认 inbox 为 1。
- 将目录移动到
  `.trellis/tasks/archive/2026-11/11-18-e2e-archive-move-20261118-1927`。
- 8 秒内 inbox 与两份 cursor 收敛为 0。
- `sync_task_space_file` 无活动或归档 probe 路径；
  `sync_archive_file` 无该 probe 路径；`sync_task_index` 无归档 probe 行。
- 说明活动任务移动只清理旧活动摘要，没有把 archive 路径当普通任务上传。

## 3. API 与清理结果

最终 API 证据：

- `GET /api/team/status`：`200`，`trellis-board.ownershipInboxCount=0`。
- 所有 5 个项目 `ownershipInboxCount` 均为 0。
- `GET /api/ownership-inbox?limit=50`：`200`，`total=0`、`items=0`。

最终数据清理：

- `sync_task_ownership_inbox` 的总行数为 0，E2E 前缀行数为 0。
- taskSpace 的 `ownershipPending`、`pendingRejected` 均为 0。
- `sync_task_index` 保持测试前基线 `128` 行。
- 三个活动探针目录和 archive 探针目录均已删除。
- 临时父目录 `tasks.e2e-hidden-20261118-1924` 已恢复，无残留。

## 4. 自动化验证

- `node --test packages/server/test/task-ownership-inbox.test.js`：`7/7` 通过。
  包含来源隔离、`taskDir` 精确删除、重复删除幂等、非法输入整批拒绝和同事务清理。
- `node --test packages/server/test/team-gitless-http.test.js`：`4/4` 通过。
- GitHub Actions Node 全量测试通过。
- GitHub Actions Rust 单元测试通过，包含新增
  `unchanged_startup_pull_revalidates_pending_ownership_ledger`。
- GitHub Actions portable package smoke 与 launch smoke 通过。
- `python ./.trellis/scripts/task.py validate 11-18-fix-ownership-inbox-deletion-residue`：通过。
- `git diff --check`：通过。

## 5. 已知限制

- “两个 Agent 同一任务来源隔离”由服务端自动化测试覆盖，本轮没有同时启动两台真实 Windows 客户端重复该场景。
- archive 移动探针未提交 Git；本项验证的是客户端活动路径排除和摘要清理，不是服务端 Git 归档导入本身。
