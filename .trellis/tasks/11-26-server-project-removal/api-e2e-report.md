# 项目永久移除 API E2E 报告

## 0. 测试拓扑

| 层 | 地址 / 进程 | 说明 |
| --- | --- | --- |
| 本地转发代理 | 不适用 | API E2E 直接请求本机后端 |
| 后端 | `http://127.0.0.1:58648`，PID `41140` | 启动时间 `2026-11-26T10:49:51.259Z`；由本机最新源码创建真实 HTTP 服务 |
| 数据库 | 临时隔离 SQLite `board.sqlite` | 临时目录 `trellis-project-removal-e2e-IgSU8l`，测试结束后删除 |
| 后端日志 | 临时数据目录的 `logs/server*.log` | 服务没有请求级 access log；按错误日志增量降级判定 |
| 证据文件 | `.trellis/tasks/11-26-server-project-removal/api-e2e-evidence.jsonl` | 请求、响应摘要、日志错误增量和数据库复核结果 |

本项目使用本机登录会话，不使用 WIT `Weareint-Token`。测试账号密码在运行时随机生成，未写入脚本、证据或报告。

## 1. 测试数据策略

- 前缀：`e2e-project-removal`。
- 创建项目 A `E2E 待移除项目 A` 和项目 B `E2E 保留项目 B`，每个项目各有一个任务空间。
- 项目 A 额外创建一条任务和活动租约，用于验证级联删除。
- 项目 fixture 通过真实 Team 数据库和任务空间服务建立；被测删除操作全部通过 HTTP API 执行。
- 使用临时数据目录，结束后停止服务并删除整个临时目录。项目 B 在验证完成前保持存在，作为隔离对照。

## 2. 逐步证据表

| # | 请求 | 响应摘要 | 对应后端日志 | 验证层级 | 结论 |
| --- | --- | --- | --- | --- | --- |
| 1 | `POST /api/auth/login` 管理员 | HTTP 200，取得本机会话 | 首次请求增量含启动日志 335 bytes，无 ERROR | 契约级 | ✅ |
| 2 | `POST /api/auth/login` 团队管理员 | HTTP 200，取得非系统管理员会话 | 无 ERROR 增量 | 契约级 | ✅ |
| 3 | `GET /api/auth/me` | HTTP 200，`systemAdmin=true` | 无 ERROR 增量 | 契约级 | ✅ |
| 4 | `GET /api/admin/projects?teamId=...` | HTTP 200，项目数 2 | 无 ERROR 增量 | 持久化级（读回基线） | ✅ |
| 5 | 未登录 `DELETE /api/admin/projects/:id` | HTTP 401，`AUTH_REQUIRED`，文案“需要登录” | 无 ERROR 增量 | 契约级 | ✅ 预期失败 |
| 6 | 团队管理员 `DELETE /api/admin/projects/:id` | HTTP 403，`FORBIDDEN`，文案“只有系统管理员可以执行该操作” | 无 ERROR 增量 | 契约级 + 数据未变 | ✅ 预期失败 |
| 7 | 系统管理员使用带首尾空格的错误确认名称 | HTTP 400，`INVALID_INPUT`，文案“项目确认名称不匹配” | 无 ERROR 增量 | 契约级 + 备份/项目未变 | ✅ 预期失败 |
| 8 | 系统管理员 `DELETE /api/admin/projects/:id` | HTTP 200，`purged=true`，返回项目 ID/名称、备份 basename 和删除摘要 | 无 ERROR 增量 | 契约级 + 持久化级 | ✅ |
| 9 | `GET /api/admin/projects?teamId=...` | HTTP 200，项目 A 消失，项目 B 保留，项目数 1 | 无 ERROR 增量 | 持久化级（写后读回） | ✅ |
| 10 | `GET /api/projects/:projectA/task-spaces` | HTTP 404，文案“项目不存在” | 无 ERROR 增量 | 持久化级（读回） | ✅ |
| 11 | `GET /api/projects/:projectB/task-spaces` | HTTP 200，保留项目仍有 1 个任务空间 | 无 ERROR 增量 | 持久化级（对照读回） | ✅ |
| 12 | `GET /api/tasks/query?...&projectIds=项目A` | HTTP 403，文案“查询包含无权访问的项目” | 无 ERROR 增量 | 持久化级（任务查询隔离） | ✅ |
| 13 | `GET /api/tasks/query?...&projectIds=项目B` | HTTP 200，`total=0`，保留项目可查询 | 无 ERROR 增量 | 持久化级（对照读回） | ✅ |
| 14 | `GET /api/admin/audit?teamId=...&limit=200` | HTTP 200，可读取 `project_purged`，项目名和备份名一致 | 无 ERROR 增量 | 持久化级（审计回读） | ✅ |

日志降级说明：Team HTTP 只记录状态码 500 及以上的异常，没有请求级 access log。因此使用“响应语义 + 每请求服务的错误日志增量 + 数据库/读回证据”闭环，无法提供 access log 时间戳；本轮所有请求错误日志增量均为 0。

## 3. 副作用复核

删除项目 A 后，直接查询临时数据库得到以下行数：

| 表 | 条件 | 剩余行数 |
| --- | --- | ---: |
| `sync_project` | 项目 A ID | 0 |
| `sync_project_member` | 项目 A ID | 0 |
| `sync_project_team_access` | 项目 A ID | 0 |
| `sync_task_space` | 项目 A ID | 0 |
| `sync_task` | 项目 A ID | 0 |
| `sync_task_lease` | 项目 A 任务 execution key | 0 |
| `sync_task_index` | 项目 A ID | 0 |
| `sync_task_command` | 项目 A ID | 0 |
| `sync_agent_binding` | 项目 A 任务空间 ID | 0 |
| `sync_agent_cursor` | 项目 A 任务空间 ID | 0 |
| `sync_task_space_file` | 项目 A 任务空间 ID | 0 |
| `sync_conflict` | 项目 A 任务空间 ID | 0 |

其他事实：

- 项目 B 主表、成员、团队访问、任务空间、任务和任务索引计数在删除前后完全一致；其中主表、成员、团队访问和任务空间均为 1，任务与任务索引均为 0。
- 删除前备份数 1，删除后备份数 2，未超过 5 份上限。
- 成功响应中的备份名 `board.sqlite.snapshot.20261126T104951688Z` 存在于临时备份目录。
- 响应中不包含临时数据目录绝对路径。
- 审计事件 `project_purged` 在项目删除后仍可读取，详情包含项目名、远程地址、删除数量和备份 basename。

## 4. 自动化验证

- `node --check`：全部改动 JS 通过。
- `oxfmt --check`：本任务服务端 JS 文件通过。
- `git diff --check`：通过。
- 定向测试：47 通过，0 失败。
- `yarn test`：793 通过，2 跳过，0 失败。
- API E2E：14 个 HTTP 步骤通过，12 项 cascade 检查通过，项目 B 六项计数前后一致。

## 5. 未验证项与限制

- 没有请求级 access log，无法按 request ID 精确关联日志；已使用服务错误日志增量降级。
- 本轮 fixture 没有真实的归档快照文件，因此归档快照物理文件清理未在 E2E 中制造和删除；回调触发、异常隔离和现有启动清理由服务级测试覆盖。
- 5 份上限覆盖 `board.sqlite.snapshot.*`。数据库升级前 `board.sqlite.pre-v*` 属于另一套低频升级备份机制，未纳入本任务。
- 本次不改 Web 页面，未执行浏览器 UI 验证。

## 6. 清理记录

- 停止本机临时服务 PID `41140`。
- 删除临时数据目录 `trellis-project-removal-e2e-IgSU8l`，其中包含测试数据库、日志和备份。
- 保留 `api-e2e-evidence.jsonl` 作为任务证据。
- 没有创建持久化 token 文件；随机测试账号随临时数据库删除。
