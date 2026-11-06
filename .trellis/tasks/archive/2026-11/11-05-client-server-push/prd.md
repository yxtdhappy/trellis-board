# 客户端与服务端事件通道

## Goal

在服务端与桌面客户端/Agent 之间建立 **SSE** 长连接事件通道，让服务端在任务创建、分派、更新、撤销或需要同步时主动通知客户端，替代当前最长 25 秒一次的命令长轮询，并支持把 Trellis 任务下发到目标客户端。

## Dependencies

- 依赖 `11-05-team-isolation`：事件必须携带团队作用域，不能跨团队广播。
- 与 `11-05-workspace-bootstrap` 可并行；`11-05-desktop-client-package` 负责在桌面壳中消费本通道。
- 复用现有 Agent 身份与凭证：`server/team/agents.js`、`agent/api.js`、`agent/index.js`。

## Current State（仓库事实）

- Agent 通过 HTTP 长轮询取命令：`agent/index.js:25`（`POLL_WAIT_MS = 25_000`）、`agent/index.js:453`（`_commandLoop`）、`agent/index.js:462`（`pollCommands`）、`agent/api.js:142`（`pollCommands`）。
- 服务端命令接口：`server/team/http.js:443`（`handleAgent`）、`:460`（`POST /api/agent/commands`）、`:470`（`POST /api/agent/commands/:id/result`）；`server/team/agents.js:13-14`（命令租约 5 分钟、最长等待 25 秒）、`:19` 的 `ALLOWED_COMMANDS` 只有 `sync_branch`、`refresh_status`、`:809` 的 `pollCommands`。
- 服务端没有 SSE / WebSocket：`grep EventSource|WebSocket|text/event-stream` 无实现；HTTP 入口是原生 `node:http` 路由 `server/team/http.js`，由 `server/index.js` 启动。
- 团队任务由服务端工作副本创建并 push：`server/team/task-writes.js`（`task.py create --no-start`、Git 操作、幂等键）。任务事实仍以 Git 工作副本为准。
- Agent 已在本地保存绑定、运行状态与 DPAPI 凭证：`agent/config-store.js`、`agent/credential-store.js`、`%LOCALAPPDATA%\TrellisBoardAgent\`。
- 当前没有事件表、事件游标或 SSE 路由；`agent_command` 表已有 `pending/delivered/completed/failed/cancelled` 状态与租约字段。
- 前端 Web 仍走 HTTP 轮询/请求，不消费 SSE；桌面客户端尚未存在，因此本任务先替换 Agent 的长轮询通道。
- 现有测试没有覆盖 SSE、事件游标、慢消费者或长轮询移除。
- Node 24 内置 `http`/`crypto`，没有 WebSocket 服务端内置实现；现项目无第三方运行时依赖。

## In Scope

- 事件传输：**SSE**（`GET /api/agent/events`），服务端 → 客户端单向推送；客户端 → 服务端继续使用现有 HTTP POST。WebSocket 不在首版范围。
- 鉴权：
  - 使用现有 Agent Bearer 凭证（`Authorization: Bearer ...`），不接受 URL query 传 token。
  - 事件流建立前校验设备状态、团队、项目绑定；设备被撤销时主动发送 `agent.revoked` 并关闭连接。
  - 浏览器入口校验 Origin/Host；SSE 响应禁止缓存。
- 多团队作用域：
  - 事件载荷必须包含 `teamId`；服务端只发送当前 Agent 所属用户有权限的团队事件，不能跨团队广播。
  - 一个已登录用户可属于多个团队；SSE 连接可以保持一条，客户端按当前活动团队过滤展示，切换团队不强制重连。
  - 事件游标**按 `(agent, team)` 分游标**（`agent_event_cursor(agent_id, team_id, last_event_id, updated_at)`，复合唯一）；客户端为每个团队独立维护 `Last-Event-ID`，重连时按团队分别补发。具体是每团队一条连接还是单连接多游标握手由 `design.md` 决定，但服务端不得用单游标跨团队推进。
- 服务端事件存储与游标：
  - 新增 `agent_event`（id/seq、team_id、project_id、target_agent_id 或 target_user_id、type、payload_json、created_at、expires_at）。
  - 每个 Agent、每个团队维护独立游标（`agent_event_cursor(agent_id, team_id, last_event_id)`，团队内单调递增）。
  - 保留窗口默认 7 天；游标过旧或事件被清理时返回 `resync.required`，客户端执行一次全量刷新。
  - 事件至少一次投递；客户端按 event id 去重。
- 事件类型（首版）：
  - `task.created`、`task.assigned`、`task.updated`、`task.cancelled`：任务下发/变更事件，载荷包含完整任务内容（标题、PRD Markdown 正文、状态、优先级、标签、依赖、`assigneeUserId`、`teamId`、`projectId`、`taskVersion`、`changedAt`）。
  - `sync.required`：要求 Agent 执行 `fetch` + `ff-only` 同步。
  - `task.snapshot_required`：任务正文超过载荷上限时的降级事件，只含 `taskKey`、`projectId`、`taskVersion`，客户端通过 HTTP 拉取完整任务。
  - `agent.revoked`、`resync.required`：控制类事件。
  - `command` 事件承载现有 `sync_branch` / `refresh_status`；长轮询已移除，SSE 是唯一命令通道。
- 任务下发语义：
  - 服务端先在权威工作副本创建/更新任务并 push 成功，再把同一版本的任务快照放进事件载荷；客户端收到后可直接展示并落盘，不要求先完成 Git 同步。
  - Git 仍是仓库与任务文件的权威来源；事件载荷是服务端在该版本上的权威快照，客户端不得自行拼接、改写或回写任务正文。
  - 客户端按 `taskKey + taskVersion` 幂等应用：同版本重复事件忽略，低版本事件丢弃，只有高于本地已知版本才写入；本地落盘路径与格式由 `design.md` 定义，必须限制在当前 workspace 内，且不直接操作 Git 索引。
  - 事件载荷上限默认 256 KB；超过上限时服务端改发 `task.snapshot_required`，客户端通过既有 HTTP 任务接口拉取完整内容，不得截断 PRD 正文后仍标记为完整。
  - 事件发送失败不回滚已成功的 Git 操作；客户端重连后按游标补发。
- 事件目标：
  - `task.assigned`：只发给被指派人 + 项目负责人对应的 Agent。
  - `task.created` / `task.updated` / `task.cancelled`：发给项目内已绑定的 Agent。
  - 所有目标先经过团队与项目权限过滤；同一 Agent 存在多条连接时只投递一次（按连接去重）。
- 连接管理：
  - 心跳/注释帧每 15 秒；代理场景设置 `X-Accel-Buffering: no`、`Cache-Control: no-store`、`Connection: keep-alive`。
  - 客户端指数退避重连（1s → 30s，带抖动），401/403 停止重试并提示重新登录或重新注册设备，429 尊重 `Retry-After`。
  - 服务端限制单 Agent 并发连接数、空闲超时与慢消费者队列；队列溢出时丢弃旧事件并发送 `resync.required`。
  - 服务关闭时发送 `server.shutdown` 并优雅关闭连接。
- 客户端消费：
  - 后台进程维护事件循环，持久化游标；通过 IPC 通知界面刷新/弹通知。
  - 托盘通知可点击打开对应任务；不对每条事件都弹窗。
- 替换长轮询（已确认）：
  - 首版直接移除 `POST /api/agent/commands` 长轮询入口；命令下发统一走 SSE `command` 事件，`sync_branch` / `refresh_status` 仍走现有白名单与租约语义。
  - 保留 `POST /api/agent/commands/:id/result` 作为命令回执通道；该接口不属于长轮询，不能一并删除。
  - 不保留双通道、不做静默降级；旧版 Agent 请求已移除的长轮询接口时返回 `410 Gone` 与明确升级提示。
  - 桌面客户端与 Agent sidecar 必须同版本发布，升级前旧客户端无法继续接收命令。

## Out of Scope

- WebSocket 传输与双向连接状态机。
- 客户端之间互相通信、P2P、离线消息队列。
- 服务端主动执行客户端本地命令（除现有 sync/refresh 白名单）。
- 推送二进制附件、图片或大文件；完整 PRD 正文以外的任务资产仍走 HTTP 下载。
- 长轮询双通道/降级模式；旧版 Agent 兼容层。
- 通过事件通道把客户端修改回写/提交到 Git。
- 移动推送、邮件、短信通知。
- 事件总线外部化（Redis/NATS/Kafka）与多实例广播。

## 已确认决策（2026-11-05）

- **传输协议**：SSE + 现有 HTTP POST；WebSocket 首版不做。
- **任务下发语义**：事件携带完整任务内容，客户端本地落盘并按版本幂等应用；Git 仍是仓库权威。
- **事件目标**：按事件类型定向——`task.assigned` 只发被指派人 + 项目负责人，其余任务事件发项目内已绑定 Agent。
- **长轮询**：首版直接移除，不做双通道降级；旧 Agent 收到 `410 Gone` 与升级提示。
- **多团队游标**：按 `(agent, team)` 分游标，客户端按团队独立维护与补发。

## Acceptance Criteria

- [ ] 新任务创建并 push 成功后，目标 Agent 在 2 秒内收到事件（本机/局域网基准）；载荷包含完整 PRD 正文与 `taskVersion`，看板立即可见，不依赖先完成 Git 同步。
- [ ] 客户端按 `taskKey + taskVersion` 幂等应用：重复同版本事件不重复写入，低版本事件被丢弃，高于本地版本才更新。
- [ ] 超过载荷上限的任务收到 `task.snapshot_required` 并通过 HTTP 拉取完整正文；不存在截断后仍标记完整的载荷。
- [ ] 断线 30 秒后重连，使用游标补齐期间事件；重复事件不导致重复刷新/重复通知。
- [ ] 游标超出保留窗口时收到 `resync.required`，客户端完成一次全量刷新。
- [ ] 无效/撤销的 Agent 凭证无法建立事件流，返回 401/403；设备撤销后现有连接被关闭。
- [ ] `task.assigned` 只送达被指派人 + 项目负责人的 Agent；其他任务事件送达项目内已绑定 Agent；未被授权的 Agent 收不到。
- [ ] 团队 A 的事件不会发送给团队 B 的 Agent；跨团队绑定在建立连接时被拒绝；事件载荷带 `teamId`，客户端不能通过切换活动团队读取未加入团队的事件。
- [ ] 同一用户属于团队 A 和 B 时，切换活动团队后事件展示随之切换；A、B 各自维护 `(agent, team)` 游标，一个团队的游标推进、过期或补发不影响另一个团队。
- [ ] `POST /api/agent/commands` 长轮询入口已移除；旧版 Agent 请求返回 `410 Gone` 与升级提示；`POST /api/agent/commands/:id/result` 回执仍可用；新版 Agent 无长轮询也能收到 `command` 与任务事件。
- [ ] 慢消费者不会阻塞其他连接；队列溢出触发 `resync.required`，服务端内存有上限。
- [ ] SSE 响应包含正确的 `Content-Type`、`Cache-Control: no-store`、`X-Accel-Buffering: no`，代理不缓冲。
- [ ] 服务端关闭时客户端收到关闭事件并在重启后自动重连；客户端进程重启后游标不丢失。
- [ ] 事件载荷不含密码、token、完整绝对路径；只包含当前团队/项目内允许该 Agent 读取的任务正文；日志不记录正文。
- [ ] 单元/集成测试覆盖：鉴权、团队隔离、事件顺序、去重、重放、游标过期、慢消费者、优雅关闭。

## Notes

- 现有 `agent_command` 表已有 `pending/delivered/completed/failed/cancelled` 与租约语义；长轮询移除后，命令下发改由 SSE `command` 事件承载，必须保留租约、去重与完成回执，避免状态机丢失。
- SSE 在 HTTP/1.1 下受浏览器每域 6 连接限制；桌面客户端使用独立 HTTP 客户端，不受浏览器限制，但仍应限制单机连接数。
- 完整任务正文允许进入事件，但必须有 256 KB 上限和 `task.snapshot_required` 降级；事件载荷与本地落盘文件都必须限制在 workspace 与团队边界内。
