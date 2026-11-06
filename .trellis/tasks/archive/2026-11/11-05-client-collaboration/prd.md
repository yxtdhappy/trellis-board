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

## 跨任务验收记录（2026-11-06）

集成基线：`codex/team-board`，合并提交 `d0b8ee4`（workspace-bootstrap）与 `5df50db`（desktop-client-package）。以下每条均给出命令、测试名或关键输出。

### 1. 管理员建号与团队分配 — 通过

- 仅系统管理员：`tests/team-registration.test.js`「管理员建号、团队分配、重置密码与跨团队隔离」断言团队管理员调用 `POST /api/admin/users`、`PATCH /api/admin/users/:id`、`POST .../reset-password`、`PUT .../teams` 全部 403，普通成员访问 `/api/admin/users` 也是 403。
- 密码 ≥6 code point：`server/team/auth.js:102` 使用 `Array.from(password).length < 6`；「密码策略为 6 到 1024 字节且无复杂度要求」断言 `abcde`→400、`abcdef`/`123456` 通过、1025 字节→400、纯中文短密码→400。
- 无公开注册：`server/team/http.js:655`（`handleAuth`）与 `server/team/http.js:1272`（先于 `assertJsonWrite`）对 `/api/auth/register` 直接返回 404，因此非 JSON 请求不会先触发 400/415。现场脚本 `node /tmp/verify-acceptance.mjs` 输出 `register json : 404 NOT_FOUND`、`register text : 404 {"error":"接口不存在","code":"NOT_FOUND"}`；测试同时断言未写入 `user_account`。
- 审计不落明文密码：测试断言 `audit_event.detail_json` 不含 `abcdef` / `newpass` / `Legacy-Password-123`。

### 2. 团队隔离 — 通过

- 跨团队读写：`tests/team-isolation.test.js`「团队 CRUD、活动团队切换与跨团队读写隔离」断言非成员访问项目详情/成员 404、`/api/tasks/query` 403、看板 404；跨团队分页游标返回 409 `CURSOR_INVALID` 且 `recoverable: true`。
- 停用团队拒绝：`tests/team-workspace-template.test.js`「非成员、停用团队和未登录请求被拒绝」断言停用团队成员下载模板 403 且错误含「团队已停用」，非成员 403 且不回显停用状态（`server/team/workspace-templates.js:282,293`）。
- 系统管理员跨团队：同一测试中管理员可 `POST /api/auth/team` 切到任意团队；`activeTeamId=null` 时 `/api/admin/projects` 返回 p-a+p-b，`/api/admin/audit?teamId=` 只返回该团队事件。
- `workspace_key` 团队内唯一：`server/database.js:236` 定义 `UNIQUE (team_id, workspace_key)`；`tests/database.test.js:240`「workspace_key 仅在同一团队内唯一」断言跨团队同 key 可插入、同团队重复触发 `UNIQUE constraint failed`。
- 审计/游标按团队：审计断言 `events.every(event => event.teamId === teamA.id)`；游标隔离见 `tests/team-events.test.js`「事件按团队隔离，不同团队游标互不影响」。

### 3. SSE 下发 — 通过

- `GET /api/agent/events` 鉴权：`server/team/http.js:617` 的 `agentEvents.openStream` 要求 Agent Bearer；测试「事件流按团队鉴权、完整快照并支持 Last-Event-ID 断线补发」。
- 断线补发：同上测试用 `Last-Event-ID` 重放缺失事件；另有「慢消费者不会阻塞同一团队的其他事件流」。
- `resync.required`：「游标不可识别时发送 resync.required 并保留明确语义」断言 `reason=unknown_cursor`；「游标落后于保留窗口时返回 cursor_expired」断言 `reason=cursor_expired`。
- 旧长轮询 410：`server/team/http.js:623-629` 返回 410 `AGENT_LONG_POLL_REMOVED`，`tests/team-core.test.js:903` 断言状态码与 code。
- 协议 v2 心跳：`tests/team-core.test.js:865-866` 断言 `bindings[0].teamId` 非空、`protocolVersion === 2`、`minimumAgentVersion` 为字符串；实现见 `server/team/agents.js:551-553`。

### 4. workspace 初始化 — 通过

- 模板下载权限：`tests/team-workspace-template.test.js`「Agent Bearer 可下载其所属团队模板」与「非成员、停用团队和未登录请求被拒绝」；manifest 返回 64 位 hex `sha256`、ETag，HEAD 无 body，`If-None-Match` 命中 304。
- SHA-256：「模板哈希不匹配时中止且不写入」「下载哈希头不匹配时不写缓存也不初始化」「离线时回落到最近成功缓存并可初始化」。
- 默认目录：「空目录初始化生成 .trellis/.opencode/.agents、developer 和模板哈希，不创建 .git」。
- developer 用登录用户名：「显式确认后备份原 .developer 并切换为登录用户名」；用户名不符时「developer 用户名不同默认中止且不写入模板文件」。
- 冲突备份：同上，另有「repair 模式先备份再覆盖被修改的已展开文件」。
- 符号链接拒绝：「拒绝符号链接条目」「拒绝 .opencode 指向工作区外的符号链接且外部目录无写入」「拒绝 .trellis/scripts 符号链接且回滚不删除外部文件」「拒绝根目录与符号链接 workspace 目标」。
- 不执行 Python / 不 `git init`：「不执行模板内 init_developer.py，developer 文件与 journal/index 由本地生成」；默认初始化测试断言未创建 `.git`。

### 5. Tauri 客户端 — 静态通过，Windows 运行时未验证

- 脚手架：`desktop/` 含 `src-tauri`（main/config/navigation/sidecar/logging）、`ui/`、`sidecar/`、`install.ps1`、`uninstall.ps1`；`tests/desktop-package.test.js` 10 条全过。
- capability 最小化：`desktop/src-tauri/capabilities/main.json` 仅 `core:default` + `dialog:allow-open` + 本地命令，`desktop/src-tauri/permissions/desktop.toml` 6 条自定义命令；修正轮后的完整清单与断言见下文「修正轮验收记录」。
- install.ps1 静态断言：「install.ps1 默认按用户安装、校验 SHA256 并可回滚」「uninstall.ps1 拒绝受保护目录并复用现有撤销流程」。
- sidecar 入口：「sidecar 构建脚本引用的入口文件都存在且使用 Node SEA」「sidecar CLI 报告协议 v2，未注册时以配置错误退出」「桌面设备注册复用 pairing-codes + agent/enroll，凭证不落明文」。
- 未验证（本机 Linux，无 cargo/rustc/pwsh/Node 24）：`cargo build` / `cargo tauri build` / NSIS 产物、`build-sidecar.ps1` 的 SEA 注入产物、`install.ps1` / `uninstall.ps1` 实际执行、WebView2 bootstrapper、DPAPI 加解密、托盘/单实例/导航拦截运行时行为、代码签名与 SmartScreen。清单见 `desktop/README.md` 的「Windows 验证清单」（14 项）与「Linux 未验证项」（7 项）。

### 6. 五条链路一致性 — 通过

- 桌面设备注册复用配对码：`desktop/sidecar/desktop-device.js:62` 调用 `AgentApiClient.enroll`（同一 `/api/agent/enroll`），凭证写入 `DpapiCredentialStore`；测试「桌面设备注册复用 pairing-codes + agent/enroll，凭证不落明文」。
- 设备凭证即 SSE Bearer：`agent/api.js:159` 使用 `authorization: Bearer ${this.credential}`，sidecar 复用 `runAgentProcess`（`desktop/sidecar/main.js:8`），事件流与设备注册共用同一凭证。
- workspace 模板授权与团队隔离一致：`server/team/workspace-templates.js:282,293` 用团队成员与停用状态判定；模板测试与隔离测试共用 `setUserTeams` 与同一团队模型。
- 协议版本单一来源：`server/team/agents.js:11` `AGENT_PROTOCOL_VERSION = 2`，合并冲突处保留常量而非字面量 `2`；心跳回传的 `teamId` 供客户端建立对应团队的 SSE。
- 撤销链路复用：`desktop/sidecar/desktop-device.js:151` 调 `/api/admin/agents/{id}/revoke`，测试「卸载撤销复用 /api/admin/agents/{id}/revoke 并标记设备」。

### 集成验证命令与结果

```text
npm test                       # tests 327, pass 326, fail 0, skipped 1
npm run build                  # ✓ built in 965ms
git diff --check               # clean
node --test tests/team-isolation.test.js tests/team-registration.test.js \
  tests/team-workspace-template.test.js tests/workspace-bootstrap.test.js \
  tests/team-events.test.js tests/desktop-package.test.js
                               # tests 59, pass 59, fail 0
python3 .trellis/scripts/task.py validate <五个子任务>  # 全部 ✓
node /tmp/verify-acceptance.mjs
  register json : 404 NOT_FOUND
  register text : 404 {"error":"接口不存在","code":"NOT_FOUND"}
  create user   : 201
  foreign team  : 403 FORBIDDEN
  short password: 400
  admin teams   : 200 count: 2 | audit teamA: 200
```

## 修正轮验收记录（2026-11-06）

修正轮补齐两条被遗漏的支线（workspace 客户端接线、登录会话签发设备令牌），并按「先审阅、后串行
合并」的流程重新集成本任务树。基线为 `38200e8`（`docs(tasks): archive client collaboration task tree`）。

### 合并提交

| 顺序 | 分支 | 合并提交 | 冲突 |
| --- | --- | --- | --- |
| 1 | `codex/11-05-workspace-client-flow` @ `d1c83e6` | `cf7c55c` | 无 |
| 2 | `codex/11-05-desktop-device-auth` @ `e3b8d47` | `5624ffc` | 6 个文件，全部语义合并，未用 `--ours/--theirs` |

冲突与解决方式：

| 文件 | 解决方式 |
| --- | --- |
| `desktop/src-tauri/capabilities/main.json` | 取并集：`core:default`、`allow-app-status`、`allow-enroll-with-token`、`allow-enroll-device`、`allow-open-board-login`、`allow-pick-workspace`、`allow-init-workspace`、`dialog:allow-open` |
| `desktop/src-tauri/permissions/desktop.toml` | 6 条自定义 permission（两条注册命令 + 两条 workspace 命令 + status + open_board_login） |
| `desktop/src-tauri/src/main.rs` | 命令取并集（`enroll_with_token`、`enroll_device`、`open_board_login`、`pick_workspace`、`init_workspace`），保留 `tauri_plugin_dialog::init()` |
| `desktop/ui/setup.js` | 保留深链 `enroll-token`/`enroll-complete`/`enroll-failed` 监听与 `resetButtons`，并保留 workspace 面板；令牌兑换成功后进入 workspace 面板（与配对码路径一致），不跳过初始化步骤 |
| `server/team/agents.js` | 保留 `insertDevice` 抽取；`insertDevice` 统一返回 `username`/`teamId`，`enroll` 与 `enrollDesktop` 共用，避免两条路径行为分叉 |
| `tests/desktop-package.test.js`、`tests/desktop-device-auth.test.js` | 断言改为合并后的并集（8 条 capability、6 条自定义 permission、合并后的 `generate_handler!` 顺序） |

### 验证数字

```text
npm test                                  # tests 343, pass 342, fail 0, skipped 1（基线 327）
npm run build                             # ✓ built in 1.05s
git diff --check                          # clean
git status --short                        # 空
git grep -n '<<<<<<<'                     # 无命中
node --test tests/workspace-client-flow.test.js tests/desktop-device-auth.test.js \
  tests/desktop-package.test.js tests/workspace-bootstrap.test.js \
  tests/team-workspace-template.test.js   # tests 58, pass 58, fail 0
```

### 端到端链路（登录 → 签发 → 深链/粘贴 → 兑换 → 保存 → workspace → SSE）

1. **登录后签发一次性令牌**：`web/src/features/admin/DevicesTab.tsx:118` 生成 `trellisboard://enroll?token=...&server=...` 链接，`web/src/api/admin.ts:644` 调 `POST /api/desktop/enroll-tokens`；服务端入口 `server/team/http.js:1246`（`handleDesktop`）→ `server/team/desktop-auth.js:85`（`issue`）。TTL 5 分钟（`server/team/desktop-auth.js:5`）、只存哈希（`:112`）、每用户上限 5（`:92`）、审计 `desktop_enroll_token_issued`（`:119`）。测试：「签发设备令牌要求登录会话、JSON 与同源 Origin」「同一用户未使用的设备令牌上限为 5，已使用令牌不占额度」。
2. **深链与手动粘贴**：`desktop/src-tauri/src/navigation.rs:57`（`parse_enroll_link`，只接受 `trellisboard://enroll`）→ `desktop/src-tauri/src/main.rs:295`（`handle_enroll_links`）向本地页 `emit("enroll-token")`（`:301`）并直接兑换（`:316`）；`desktop/ui/setup.js:188` 监听事件预填令牌。粘贴路径：`desktop/ui/setup.js:130` → `invoke("enroll_with_token")` → `desktop/src-tauri/src/main.rs:123`。
3. **兑换设备凭证**：`server/team/http.js:607`（`POST /api/agent/enroll-desktop`，`verify` 与 `consume` 之间不 `await`）→ `server/team/agents.js:342`（`enrollDesktop`）→ `server/team/agents.js:252`（`insertDevice`，返回 `username`/`teamId`）。令牌无效 401 `DESKTOP_TOKEN_INVALID`、账号禁用 403（`:344-350`），成功审计 `desktop_device_enrolled`（`:360`）。测试：「设备令牌只能兑换一次并签发可用凭证」「过期令牌返回 401 且不创建设备」「无效、已撤销会话与禁用用户分别被拒绝」。
4. **保存凭证与身份**：`desktop/sidecar/desktop-device.js:69`（`completeDesktopEnrollment`）把凭证写入 DPAPI、把 `username`/`teamId` 写入 sidecar 配置；`desktop/sidecar/main.js:182`（`commandEnroll`）按 `--pairing-code` 选择兑换接口，两条路径共用同一份 `common`。
5. **workspace init 使用兑换回来的用户名**：`desktop/sidecar/main.js:220`（`commandWorkspaceInit`，缺省取 `config.username`）；等价 CLI `agent/cli.js:729`（`resolveWorkspaceUsername`：`--username` → `config.username` → `.trellis/.developer`）→ `agent/cli.js:738`（`initializeWorkspace`）。测试：「workspace init 从 config.json 读取用户名、团队和服务端」。
6. **SSE 用同一凭证**：`server/team/http.js:624`（`GET /api/agent/events`）→ `authenticate()` 按 `credential_hash` 查 `agent_device`（`server/team/agents.js:370`）；凭证与心跳/SSE 共用同一 Bearer。测试：「事件流按团队鉴权、完整快照并支持 Last-Event-ID 断线补发」（`tests/team-events.test.js:291`）。

### 安全边界复核

- 令牌只存哈希、审计不落明文：`server/team/desktop-auth.js:112`（`tokens.set(hash, record)`）；测试断言审计 `detail_json` 不含令牌明文。
- 一次性：`server/team/desktop-auth.js:143`（`consume` 标记 `usedAtMs`），重放返回 401「已使用」。
- TTL 与上限：`DESKTOP_ENROLL_TOKEN_TTL_MS = 5 * 60 * 1000`、`MAX_PENDING_DESKTOP_ENROLL_TOKENS = 5`。
- 禁用用户：`server/team/agents.js:344-350` 在读令牌后复查 `user_account.status`。
- 非成员无法用别队令牌：令牌的 `teamId` 只来自会话 `activeTeamId`（`server/team/auth.js:441`），切换团队必须通过成员校验（`server/team/teams.js:221-238`）；测试「团队 CRUD、活动团队切换与跨团队读写隔离」。
- 远程页面无 IPC：capability 不含 `remote`，测试「桌面 capability 只增加本地命令且不允许远程页面」「capability 只授予本地命令与最小 dialog 权限，不授予 shell、文件系统或远程页面权限」。
- workspace 路径符号链接拒绝、不执行 Python：`tests/workspace-bootstrap.test.js` 的「拒绝符号链接条目」「拒绝根目录与符号链接 workspace 目标」「拒绝 .opencode 指向工作区外的符号链接且外部目录无写入」「拒绝 .trellis/scripts 符号链接且回滚不删除外部文件」「不执行模板内 init_developer.py，developer 文件与 journal/index 由本地生成」。

### 流程偏差（如实记录）

- 编排者在修正轮之前直接合并了 `codex/11-05-user-registration`（`11785fc merge: administrator-managed user accounts`）与 `codex/11-05-client-server-push`（`18621c5 merge: SSE event channel`），没有先建修正分支、也没有逐条给出合并证据；本记录只对 `cf7c55c` / `5624ffc` 两个修正轮合并负责，未改写历史。
- 修正过程中曾创建 `/tmp/merge-task2` 工作树做隔离合并，该工作树已删除（`ls /tmp/merge-task2` 不存在，`git worktree list` 无该项）；残留的分支 `tmp/merge-task2` 按“不删除分支”的约束保留。
- Windows 专属项仍未验证：`cargo tauri build` / NSIS 产物、`build-sidecar.ps1` SEA 注入、`install.ps1` / `uninstall.ps1` 实际执行、`trellisboard://` 协议注册与深链转发、DPAPI 加解密、托盘/单实例运行时行为、代码签名与 SmartScreen。清单见 `desktop/README.md` 的「Windows 验证清单」与「Linux 未验证项」。
- 修正轮合并后一次全量 `npm test` 出现过 1 条失败（342 通过 / 1 失败），随后连续 8 次全量运行均为 0 失败，未能复现，未定位到具体用例；作为已知抖动记录在此。

## Out of Scope（父任务层面）

- macOS / Linux 客户端。
- 公网 SaaS 化、计费、跨地域多活。
- 邮件服务、短信验证码、SSO/OIDC。
- 自动更新服务器与灰度发布体系（首版只做手动升级）。
- 移动端。

## Remaining Decisions

所有产品决策已确认，无开放问题。已确认：Tauri、SSE、多团队切换、仅管理员建号与配置团队、不做旧数据迁移、系统管理员可读所有团队、workspace 模板由服务端下发、事件携带完整任务内容、团队可留空、管理员填密码、远程 Board 页面、按用户安装、Node SEA sidecar、桌面设备注册、默认生成 `.opencode` + `.agents` 并可勾选其他工具、developer 冲突中止、不自动 `git init`、事件按类型定向、首版移除长轮询、按团队分游标。

本阶段的执行方式（2026-11-05 决策）：为每个子任务单独建分支 + worktree，先写 `design.md` /
`implement.md` 再实现，全部子任务合并回 `codex/team-board` 后才归档本任务树。该决策已执行完毕：
子任务分别落在 `codex/11-05-*` 分支，归档副本见 `.trellis/tasks/archive/2026-11/`。

## Notes

- 保持 `prd.md` 只写需求、约束和验收标准；技术方案放各子任务 `design.md`。
- 现有 `11-03-team-*` 任务仍是 `in_progress`，本任务树与其并行；涉及同一文件的改动需要先确认对方状态，避免覆盖。
