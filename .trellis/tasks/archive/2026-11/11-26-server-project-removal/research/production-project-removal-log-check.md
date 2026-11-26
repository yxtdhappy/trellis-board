# 生产项目移除日志核查（2026-11-26）

## 结论

本次从页面移除的项目已完成，删除链路没有发现异常：

- 审计事件 `project_purged` 结果为 `success`，时间为
  `2026-11-26T13:29:03.396Z`（本地时间 21:29:03）。
- 被删除的是项目 ID `cfb47864-7c63-4271-9fc8-17ddf4337893`；删除后项目列表不再返回该 ID。
- 删除前生成了数据库快照
  `board.sqlite.snapshot.20261126T132903242Z`，文件存在，大小 `66,662,400` bytes。
- 当前备份目录共 4 份快照，未超过 5 份上限。
- 删除时间窗 `13:25:00Z` 至 `13:35:00Z` 内没有 level 50 错误，也没有
  `SQLITE`、`FOREIGN KEY`、数据库备份或项目清理异常。
- 服务在删除前启动，删除后继续健康运行，没有因本次删除重启或崩溃。

有一个需要区分的事实：当前项目列表仍有一个同名项目
`mdp-algorithm-service`，其 ID 为 `d9af140c-14db-4254-914d-fb7658b8ca2a`，
分支为 `test`。它与本次被删除的旧项目 ID 不同。根据日志中删除前后的两次任务空间
全量投影，判断它是另建的同名项目；不能据此认为旧项目没有被删除。

## 测试拓扑

| 层 | 地址 / 对象 | 说明 |
| --- | --- | --- |
| 管理页面 | `http://spec-board.weintdata.cn/weint-spec-board/admin.html` | 复用已登录系统管理员浏览器会话 |
| 服务端 API | `/weint-spec-board/api/*` | 同源只读请求 |
| 服务端日志 | `http://spec-board.weintdata.cn/files/logs/server.1.log` | 当前只存在一个轮转文件 |
| 备份目录 | `http://spec-board.weintdata.cn/files/backups/` | 只做目录读取和 HEAD 检查 |
| 生产服务 | `version=0.5.16`，PID `107` | 启动时间 `2026-11-26T12:42:29.729Z` |

## 证据

| # | 检查 | 结果 | 判定 |
| --- | --- | --- | --- |
| 1 | `GET /api/health` | HTTP 200，`status=ok`，`mode=team`，PID 107 | 服务健康 |
| 2 | `GET /api/admin/audit?limit=200` | 审计 ID 94：`project_purged`，`result=success`，目标旧项目 ID `cfb47864...` | 删除成功 |
| 3 | 删除审计摘要 | `taskSpaceCount=1`、`taskCount=1`、`memberCount=1`、`teamAccessCount=1`，备份名与删除时间一致 | 计数和备份记录匹配 |
| 4 | `GET /api/admin/projects` | HTTP 200；旧项目 ID 不存在 | 删除已持久化 |
| 5 | 同名项目检查 | 新项目 ID `d9af140c...`，分支 `test`，1 个任务空间、1 个任务 | 同名但不是同一项目 |
| 6 | 备份目录 | 目标快照存在；当前共 4 份，按时间保留 | 未超过 5 份 |
| 7 | 目标快照 HEAD | HTTP 200，`Content-Length=66662400`，修改时间 `13:29:03Z` | 快照不是空文件 |
| 8 | 删除时间窗日志 | 只有 level 30 正常投影日志；level 40 一条为 `trellis-board` 项目归档 Git 同步失败，与目标项目无关 | 删除链路无报错 |
| 9 | 全日志扫描 | 目标项目名出现 0 次；没有对应 5xx、SQLite 或外键异常 | 无删除错误证据 |
| 10 | 全日志既有 level 50 | 4 条，均在 `01:53Z` 至 `01:55Z`，为归档凭据测试的 `spawn git ENOENT` | 问题存在，但早于本次删除且无关 |

Team HTTP 当前没有请求级 access log，正常请求不会逐条写日志。因此本结论不是只看
“日志里没有 ERROR”，而是用健康检查、成功审计、旧 ID 读回消失、备份文件存在和错误日志
增量共同闭环。

## 安全风险

`/files/` 当前可以直接访问运行数据目录。使用浏览器同源 `fetch` 并显式设置
`credentials: 'omit'` 后，仍得到：

- `/files/`：HTTP 200
- `/files/backups/`：HTTP 200
- `/files/logs/server.1.log`：HTTP 200
- `/files/board.sqlite`：HEAD 200，大小 `92,196,864` bytes
- `/files/board.sqlite-wal`：HEAD 200，大小 `33,141,312` bytes
- `/files/.archive-git-credentials.key`：HEAD 404，隐藏文件未被 Caddy 返回

这说明应用会话鉴权没有覆盖 `/files/`，只要请求能穿过网络和反向代理边界，就可以读取
数据库、WAL、日志和备份。本次只发送 HEAD 或读取日志文本，没有下载数据库内容或读取密钥。
该问题应优先处理，不应把 `/files/` 作为长期公网日志入口。

## 未验证项

- 没有用户点击删除时的浏览器 Network 历史，无法引用原始 DELETE 请求的 request ID。
- 没有恢复备份到独立 SQLite 后执行 `PRAGMA integrity_check`；本轮只验证快照存在及大小。
- 当前日志没有请求级 access log，无法给出 DELETE 请求耗时或逐请求状态行。
- `/files/` 的 HTTP 200 已证明应用层无鉴权；但没有继续验证该地址在互联网侧的网络暴露范围。

## 操作边界

- 未修改、恢复或再次删除任何生产项目。
- 未下载生产数据库、WAL、备份文件或凭据内容。
- 未提交 Git，未触发 Jenkins 发布。
