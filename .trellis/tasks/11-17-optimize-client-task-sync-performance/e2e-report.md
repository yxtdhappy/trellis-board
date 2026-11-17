# 任务同步性能与归档来源 E2E 报告

## 1. 环境与版本

- 日期：2026-11-17，Windows，运行数据目录
  `C:\Users\yuhaojie\AppData\Local\TrellisBoard`。
- 当前 Team 服务：PID `1616`，监听 `0.0.0.0:4317`，启动时间
  `2026-11-17 13:39:31 +08:00`。
- 最新 Web 静态产物生成时间：`2026-11-17 12:38:04 +08:00`。
- SQLite schema：v14；服务日志：
  `C:\Users\yuhaojie\AppData\Local\TrellisBoard\server\logs\server.1.log`。
- 本轮使用 `wit-e2e-testing` 闭环；当前会话没有 Chrome DevTools MCP，因此 UI 验证降级为
  `ego-browser`，接口、数据库和日志仍分别核对。

## 2. 代码级验证

- `node --test packages/server/test/team-task-index-v10.test.js`：16/16 通过。
- `node --test packages/server/test/database.test.js ...` 聚焦服务端测试：50/50 通过。
- `yarn test`：586 个测试，585 passed、0 failed、1 skipped，耗时约 537 秒。
- Web 与 desktop UI 构建在本轮前序已通过；本次新增改动只涉及服务端索引持久化与测试，没有再次修改
  Web 构建产物。
- Rust 客户端无法构建：本机 `cargo`、`rustc`、`rustup` 均不存在，未把旧客户端冒充最新客户端。

## 3. 首次启动预热

部署新索引逻辑后，服务 PID `40788 -> 38332`。首次启动时 5 个 taskSpace 没有
`projection_state_json`，后台按设计执行 5 次 full 预热：

| taskSpace | full 投影总耗时 |
| --- | ---: |
| mdp-management-web | 50.442s |
| trellis-board | 57.825s |
| mdp-backend-web | 27.642s |
| mdp-report-service | 30.414s |
| mdp-backend-service | 20.636s |

这些 full 扫描全部在 HTTP 监听成功之后由后台预热触发，没有阻塞端口启动。预热完成后
`sync_task_space_scan_cache` 的 5 行均写入 warm 状态，合计 `19,266,270` bytes。

## 4. 重启复用与活动任务性能

再次重启后服务 PID `38332 -> 1616`。从启动到创建探针期间，日志没有再出现新的 full 投影，说明
重启已复用持久化 warm 状态。

通过当前已配对 Agent 的 DPAPI 凭证直接调用活动任务 changes API，凭证只在进程内解密，未输出或
写入报告。5 个样本均为活动-only 任务，均先完成 HTTP 写入，再由服务端异步增量投影：

| 样本 | HTTP 写入 | 投影 committed | 模式 | 扫描任务 | 复用任务 | 读取正文行 | revision |
| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: |
| 重启后首次 | 141ms | 464ms | incremental | 1 | 115 | 2 | 492 -> 493 |
| timing-2 | 120ms | 197ms | incremental | 1 | 116 | 2 | 493 -> 494 |
| timing-3 | 36ms | 195ms | incremental | 1 | 117 | 2 | 494 -> 495 |
| timing-4 | 47ms | 236ms | incremental | 1 | 118 | 2 | 495 -> 496 |
| timing-5 | 52ms | 282ms | incremental | 1 | 119 | 2 | 496 -> 497 |

按 5 个样本的 nearest-rank P95：

- HTTP 写入 P95：`141ms`。
- 服务端投影 committed P95：`464ms`。
- P50：HTTP `47ms`，投影 `236ms`。

Board UI 搜索 `E2E_SERVER_TIMING_5` 可见；最近三次 `/api/tasks/query` 耗时为 `126ms`、`78ms`、
`42ms`。因此“HTTP 写入 + 投影 + Board 查询”的服务端链路已低于 `2s/5s` 门槛。该数据不是最新桌面
客户端 watcher 到 UI 的端到端 P95，原因见限制项。

## 5. Agent 归档写入边界

对 `.trellis/tasks/archive/2026-11/e2e-archive-reject/task.json` 发起真实 Agent 批次：

- HTTP 状态：`409`。
- 错误码：`ARCHIVE_SYNC_SERVER_MANAGED`。
- 响应：`归档任务由服务端 Git 索引管理，Agent 批次已整批拒绝`。
- 请求前后活动 revision 均为 `488`，归档表均为 `745` 行，未产生部分写入。

## 6. 归档索引与管理页

- 归档索引页显示 `723` 条归档任务、37 页，页面按归档时间倒序展示。
- 管理页“归档同步”加载 `/api/admin/archive-sync` 耗时 `100ms`。
- 页面展示“最近更新”“最近尝试”“最近成功”、失败状态和“失败日志”入口。
- 打开失败日志可看到阶段、错误码、时间与脱敏摘要；重复轮询间隔稳定在约 5 秒。
- 当前 4 个 SSH taskSpace 因未配置只读凭据显示 `ARCHIVE_CREDENTIAL_MISSING`；trellis-board
  公开 HTTPS 可匿名访问，但仓库内存在快照白名单不支持的文件类型，任务空间显示同步失败并保留旧归档。
- 失败后旧归档仍可读：迁移后的 `sync_archive_file` 共 `4,834` 行，归档索引共 `723` 行，没有被失败
  同步清空。

## 7. 数据清理

- 活动探针目录均为 `11-17-e2e-*`，已通过删除墓碑分批清理。
- 清理后活动探针索引行 `0`、活动探针正文行 `0`，本地探针任务目录全部不存在。
- 清理投影均走 incremental，耗时 `158ms` 到 `259ms`。
- 最终 taskSpace revision 为 `502`，`revision = indexed_revision`。
- 未使用 `git add .`，未提交、未推送、未回滚其他任务或用户改动。

## 8. 限制与未覆盖项

- 本机没有 Rust/Cargo 工具链，无法构建并退出重开最新桌面客户端；客户端 archive 过滤、watcher、
  pending 迁移和真实客户端到 Board 的 P95 仍需在具备工具链的机器上复测。
- 没有配置公司 Git 只读凭据，因此真实 SSH 归档 fetch 成功路径未验证；GitHub 公开远端也因历史归档
  含不支持文件类型而按设计失败关闭。
- `git fetch-pack` 读取 promisor/unadvertised archive blob 的行为只由测试仓库验证，尚未在真实
  企业 GitLab/GitHub 远端完成成功导入。
