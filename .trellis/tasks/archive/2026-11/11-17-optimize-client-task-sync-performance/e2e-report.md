# 任务同步性能与归档来源 E2E 报告

## 1. 环境与版本

- 日期：2026-11-17，Windows，运行数据目录
  `C:\Users\yuhaojie\AppData\Local\TrellisBoard`。
- Team 服务：PID `44796`，启动时间 `2026-11-17 15:34:07 +08:00`，
  监听 `0.0.0.0:4317`。
- Web 构建产物：`2026-11-17 16:14:10 +08:00`；desktop UI 产物：
  `2026-11-17 16:14:30 +08:00`。
- SQLite 数据库：`C:\Users\yuhaojie\AppData\Local\TrellisBoard\server\board.sqlite`，
  schema v14。
- 服务日志：`C:\Users\yuhaojie\AppData\Local\TrellisBoard\server\logs\server.1.log`。
- 当前会话没有 Chrome DevTools MCP，UI 验证使用 `ego-browser`；接口、SQLite 和日志分别核对。

## 2. 重启后的数据库终检

发布前只读复核数据库中的最终 `current` 状态。

| 项目 | 分支 | 状态 | 活动 revision | 归档 revision | 归档文件 | 归档索引 |
| --- | --- | --- | --- | --- | ---: | ---: |
| mdp-backend-service | dev | current | 149/149 | 1/1 | 1584 | 141 |
| mdp-backend-web | dev | current | 109/109 | 2/2 | 646 | 104 |
| mdp-management-web | release/3.0.0/dev | current | 510/510 | 1/1 | 1609 | 329 |
| mdp-report-service | release/3.0.0/dev | current | 63/63 | 1/1 | 265 | 40 |
| trellis-board | main | current | 520/520 | 2/2 | 777 | 116 |

汇总断言：

- 活动 taskSpace：5 个，全部 `current`。
- 活动与归档 revision：不一致数 0。
- `sync_archive_file`：4881 行；`sync_task_index.archived=1`：730 行。
- 非法归档路径：0。
- 不支持扩展名进入归档表：0。
- 重启后新增归档同步失败日志：0。
- 历史失败日志仍保留 183 条；失败记录按 taskSpace 有界保留，不表示当前同步失败。

## 3. GitHub 归档真实导入

- taskSpace：`trellis-board`，分支 `main`。
- 服务端同步的远端 HEAD：`a39a622108d814045754ec49021d78f5b1d8e90a`。
- Git archive tree：808 个文件。
- 白名单文本文件：777 个。
- 跳过的非白名单附件：31 个，不再阻断整个分支。
- 数据库归档文件：777 行；字节数 `2,532,553`。
- `archive_revision/archive_indexed_revision`：`2/2`。
- 最近一次成功同步为 `15:51:10`，索引同为 `15:51:10`；后续 `16:13:33`
  的同步尝试命中相同远端 HEAD，保持 `current`。
- 本地对同一归档树独立校验同样得到 `808 / 777 / 31`。

## 4. 管理页 UI

- 打开 `http://192.168.65.27:4317/admin.html` 的“归档同步”页。
- `/api/admin/archive-sync` 返回 HTTP 200。
- 五个项目均显示“已更新”；凭据状态为四个“凭据已配置”和一个“公开 HTTPS 匿名”。
- 五个 taskSpace 的 `lastError` 均为 `null`。
- 最近更新时间、最近尝试时间、最近成功时间、文件数和归档 revision 均正常展示。
- `15:43` 构建后重新加载页面复验，结果相同；`16:14` 最终构建只完成构建门禁，
  未再次重做浏览器 UI 验收。
- 截图：
  `C:\Users\yuhaojie\AppData\Local\Temp\trellis-board-admin-archive-sync-after-build.png`。

## 5. 归档读取链路

对 `trellis-board` 执行一次归档查询和首条详情读取：

- 归档查询采样：HTTP 200，当时总数 115，首屏返回 20，耗时 35ms；当前数据库归档索引
  已增长到 116，本次发布门禁未重复该 HTTP 采样。
- 首条任务：“客户端显示可配置品牌名与版本号”。
- 任务详情：HTTP 200，耗时 32ms，标题和归档路径一致。
- 两次操作期间没有新增“归档 Git”日志，也没有启动新的 `git.exe`
  进程。服务端已有进程中的旧 Git 进程启动于 08:55 至 10:34，与本次读取无关。

这验证详情读取使用服务端已有归档文件/索引，不会为每次打开详情重新访问远端。

## 6. 测试与构建

- 发布前聚焦门禁：31/31 通过。
  - `archive-git-store.test.js` + `task-snapshot.test.js`：13/13。
  - `archive-git-sync.test.js`：1/1。
  - `team-task-index-v10.test.js`：17/17。
- `yarn build`：通过，3636 个模块，耗时 4.92s。
- `yarn build:desktop`：通过，2226 个模块，耗时 1.97s。
- 树中已有大 chunk 警告（`main` 和 `MonacoDiff`），以及 desktop 入口的非模块
  `theme-init.js` 提示，属于本轮范围外的既有打包问题。
- 前序完整 `yarn test`：595 项中 593 passed、1 skipped、1 failed；
  唯一失败为无关的 `plugin-cancel.test.js`，单独复跑 1 passed。

## 7. 限制与未覆盖项

- 本机没有 Rust/Cargo 工具链，无法重新构建最新桌面客户端，因此“退出客户端并重开最新
  Rust 客户端”的真实 E2E 仍未验证。
- 本轮完成了服务端重启、管理页、Git 归档导入、归档查询和详情读取的真实验证；不是最新客户端的
  完整端到端 P95 报告。
- 构建是当前完整工作区级别，包含并行未提交 UI 改动；该并行改动的正确性不属于本任务门禁。
- 当前改动未提交、未推送、未归档。
