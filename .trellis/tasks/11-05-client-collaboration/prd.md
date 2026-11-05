# 客户端桌面化与团队协作增强

## Goal

把当前“Windows Agent（zip + 计划任务）+ 浏览器访问 Board”的组合，升级为可分发的桌面客户端与可多团队部署的服务端：

1. 客户端以 Tauri 单 exe 分发，双击可运行，并支持 PowerShell 安装；直接加载服务端 Board 页面（不把前端资源打进安装包）并后台常驻。
2. 服务端通过 SSE + HTTP POST 主动向客户端下发 Trellis 任务。
3. 客户端选择 workspace 后完成 `.trellis` 注入、`.opencode` / `.agents` 初始化，并用管理员创建的用户名初始化 Trellis developer。
4. 服务端引入团队（tenant）边界：团队只能由管理员创建和配置，管理员为每个用户配置所属团队；账号、项目、任务、Agent、审计按团队隔离，一个用户可加入多个团队并切换。
5. 服务端不开放注册；用户只能由管理员创建，管理员建号时配置团队与角色。

## 来源需求

用户原始请求（2026-11-05）：

> 1. 客户端打包exe (可以通过powershell 安装），嵌入页面，后台监听
> 2. 服务端和客户端通过sse/websocket通信，服务端可以给客户端下发trellis任务
> 4. 客户端选择workspace目录时，初始目录中的.trellis文件夹，并初始化 .opencode .agents，两个目录，使用用户注册的名字来初始化trellis用户
> 5. 服务端团队隔离
> 6. 服务端用户注册

## 当前事实（来自仓库）

- 现有客户端是 Windows Agent：`agent/package-agent.ps1` 产出 `dist/trellis-board-agent-win-x64-<version>.zip`，内置 Node 24 `node.exe`，解压后运行 `trellis-agent.cmd`，没有 exe、安装器或内嵌页面。
- 现有后台运行方式是登录自启计划任务：`agent/windows/service.ps1`；`agent/cli.js` 提供 `service install/uninstall/status`。
- Agent 仅通过 HTTP 长轮询拉取命令：`agent/index.js:25`（`POLL_WAIT_MS = 25_000`）、`agent/index.js:453`（`_commandLoop`）、`agent/index.js:462`（`pollCommands`）、`agent/api.js:142`（`pollCommands`）；服务端 `server/team/http.js:460`（`POST /api/agent/commands`），`server/team/agents.js:13-14`（租约 5 分钟、最长等待 25 秒），`server/team/agents.js:19` 的 `ALLOWED_COMMANDS` 只有 `sync_branch`、`refresh_status`。
- 服务端没有任何 SSE / WebSocket 实现；`server/team/http.js` 是原生 `node:http` 路由，`server/index.js` 用 `http.createServer` 启动。
- 数据库当前是 schema v5：`server/database.js:15`（`DATABASE_SCHEMA_VERSION = 5`），已有 `user_account`、`team_project`、`project_member`、`audit_event`、`agent_device`、`team_task_index` 和 v5 的插件表；但 `team_project` 只有项目级成员，没有 team/tenant 表和团队维度过滤。
- 团队模式只有项目级权限：`server/team/permissions.js` 的 `authorizeProject()` 只查 `project_member`；`server/team/board.js:293` 的 `listProjects()`、`server/team/task-index.js:528` 的 `queryTasks()` 都按“当前用户可见项目”过滤。
- 用户只能由管理员创建：`server/team/http.js:546`（`POST /api/admin/users`，`requireAdmin`）、`server/team/auth.js:202`（`createUser()`）、`server/team/cli.js:175`（`init-admin`）；没有注册路由，登录页也没有注册入口。
- 前端已迁移为 React 19 + Vite + TypeScript + Tailwind/shadcn：入口 `web/index.html`、`web/admin.html`、`web/login.html`，源码 `web/src/main-board.tsx`、`web/src/main-admin.tsx`、`web/src/main-login.tsx`；`web/vite.config.ts:18` 将构建产物输出到 `public/`，服务端通过 `server/team/http.js:1010` / `server/index.js:30` 托管 `public/`。管理页现有页签见 `web/src/pages/admin/AdminPage.tsx:14`（项目协作、用户账号、项目接入、Agent 设备、系统审计）。
- 插件机制已存在（DB v5、`/api/plugins`、`plugins/` 子进程），但 team 模式明确不加载插件：`server/team/http.js:1028` 对插件端点返回空列表或 404，因此团队隔离暂不包含插件运行数据。
- Trellis CLI 可用（本机 0.6.16，项目要求 0.6.17），仓库内已有 `.trellis/scripts/init_developer.py`；但客户端当前不创建或初始化 workspace，Agent 的 `bind --path` 仍要求目标目录已是 Git 仓库（`agent/cli.js:292-308`）。
- 现有团队测试集中在 `tests/team-core.test.js`、`tests/team-web.test.js`、`tests/team-release.test.js`，没有 team/SSE/Tauri 相关测试。

## 已确认决策（2026-11-05）

- 客户端技术栈：**Tauri**，目标产物是可直接双击运行的单 exe；同时提供 PowerShell 安装/注册自启路径。依赖 WebView2 运行时（Win10/11 通常已内置）。
- 服务端到客户端通信：**SSE + HTTP POST**；WebSocket 不作为首版范围。
- 团队隔离：**一人多团队 + 会话内切换活动团队**；项目归属团队，所有查询按活动团队过滤。
- 团队管理：**团队只能由管理员创建和配置**；管理员为每个用户配置所属团队，普通用户不能创建/加入/退出团队。
- 用户创建：**不开放注册**；用户只能由管理员创建，管理员建号时配置团队与角色。
- 身份与团队配置权限（2026-11-05 补充）：**仅系统管理员**创建用户、创建/配置团队、分配用户团队；**团队管理员只管理项目**。建号时团队可留空，之后补配；密码由系统管理员直接填写（>=6 位），不自动生成、不强制首次改密。
- 旧数据：**不做迁移**。系统尚未启用，首版按最新 team 模型全新设计 schema；旧开发库直接删除重建。
- 系统管理员可见性：系统管理员**可直接读取所有团队数据**，无需先切换活动团队；跨团队写操作需指定目标团队并留审计。
- workspace 模板：从**服务端团队模板**下载；客户端缓存最近成功版本并校验 SHA-256，不依赖目标机全局 `trellis` CLI。默认生成 `.opencode` + `.agents`，另有“初始化/修复 Agent 工具”按钮供用户勾选其他工具；已有 `.developer` 用户名不同时默认中止；不自动 `git init`。
- 任务下发：SSE 事件**携带完整任务内容**（含 PRD 正文与 `taskVersion`），客户端幂等落盘；Git 仍是仓库权威。事件按类型定向：`task.assigned` 只发被指派人 + 项目负责人，其余任务事件发项目内已绑定 Agent。
- 实时通道覆盖范围：首版**直接移除** `POST /api/agent/commands` 长轮询入口（保留 `POST /api/agent/commands/:id/result` 回执），不做双通道降级；命令也走 SSE。事件游标按 `(agent, team)` 分团队维护，旧版 Agent 收到明确的升级提示。
- 桌面客户端：Tauri 窗口**直接加载服务端 Board URL**；**按用户安装**到 `%LOCALAPPDATA%`；后台 Agent 打成 **Node SEA sidecar**；身份用**桌面设备注册**换取设备凭证（DPAPI 存储）。

## Task Map

| 子任务 | 交付物 | 依赖顺序 |
| --- | --- | --- |
| `11-05-team-isolation` | 团队实体、多团队成员关系、活动团队切换、团队级查询/写权限隔离、schema v6 全新库 | 先做；建号、下发、客户端都依赖团队边界 |
| `11-05-user-registration` | 仅系统管理员建号、配置每个用户的团队与角色、密码最少 6 位、不强制改密 | 依赖 team-isolation |
| `11-05-workspace-bootstrap` | 目录选择、服务端团队模板下载与校验、`.trellis` 注入、`.opencode` / `.agents` 初始化、`init_developer.py` | 依赖 user-registration（管理员创建的用户名）与 team-isolation（团队模板授权） |
| `11-05-client-server-push` | SSE 通道、鉴权、团队作用域、完整任务快照下发、移除长轮询、按团队游标、断线重连与补偿 | 依赖 team-isolation；与 workspace-bootstrap 可并行 |
| `11-05-desktop-client-package` | Tauri 单 exe、远程 Board 页面、PowerShell 安装/卸载、Node SEA sidecar、桌面设备注册、托盘与后台监听 | 最后集成前四项 |

父子关系不是依赖系统；上面的顺序必须同时写进各子任务自身的 `prd.md` / `implement.md`。

## 跨子任务验收标准

- [ ] 全新 Windows 10/11 x64 机器仅通过 PowerShell 安装包即可启动客户端，界面内可完成登录、选择 workspace、看到 Board 页面；后台通过桌面设备注册建立同步与事件连接。
- [ ] 客户端关闭窗口后仍在后台运行，服务端事件可在 2 秒内到达；断网重连后不丢任务下发（有游标/补偿）。
- [ ] 客户端选择的 workspace 具备可用的 `.trellis`、`.opencode`、`.agents`，模板来自服务端团队模板并通过哈希校验，`.trellis/.developer` 的 `name` 等于服务端账号用户名。
- [ ] 服务端下发的事件携带完整任务正文与 `taskVersion`；客户端按版本幂等落盘，重复/过期事件不造成重复写入或回退。
- [ ] 同一部署内两个团队互相看不到对方的项目、任务、成员、Agent、审计和看板统计；同一用户加入两个团队后可切换，切换后只看到当前团队数据。
- [ ] 团队只能由系统管理员创建和配置，并由系统管理员为每个用户分配团队；团队管理员只能管理项目，不能建号或改团队归属；普通用户不能创建账号、团队或自助加入/退出团队。
- [ ] 用户密码最少 6 个字符，不做大小写/数字/符号等复杂度校验；不强制首次改密；用户管理只保留建号、重置密码、启停账号和团队分配。
- [ ] 未认证用户不能创建账号；未加入任何团队的普通用户不能访问任何团队、项目、任务或审计数据（系统管理员除外）。
- [ ] 现有 standalone 模式行为与测试不回归；当前 schema 为 v5，本任务新增 v6 并按全新数据库初始化，不提供 v5 → v6 迁移，旧开发库可删除重建。
- [ ] 所有新增文件操作限制在用户选定目录内，不写系统目录，不把凭证写入日志或配置文件明文。

## Out of Scope（父任务层面）

- macOS / Linux 客户端。
- 公网 SaaS 化、计费、跨地域多活。
- 邮件服务、短信验证码、SSO/OIDC。
- 自动更新服务器与灰度发布体系（首版只做手动升级）。
- 移动端。

## Remaining Decisions

所有产品决策已确认，无开放问题。已确认：Tauri、SSE、多团队切换、仅管理员建号与配置团队、不做旧数据迁移、系统管理员可读所有团队、workspace 模板由服务端下发、事件携带完整任务内容、团队可留空、管理员填密码、远程 Board 页面、按用户安装、Node SEA sidecar、桌面设备注册、默认生成 `.opencode` + `.agents` 并可勾选其他工具、developer 冲突中止、不自动 `git init`、事件按类型定向、首版移除长轮询、按团队分游标。

按用户要求，本阶段仍停留在 PRD；下一步需经用户确认后再为各子任务编写 `design.md` / `implement.md` 并执行 `task.py start`。

## Notes

- 保持 `prd.md` 只写需求、约束和验收标准；技术方案放各子任务 `design.md`。
- 现有 `11-03-team-*` 任务仍是 `in_progress`，本任务树与其并行；涉及同一文件的改动需要先确认对方状态，避免覆盖。
