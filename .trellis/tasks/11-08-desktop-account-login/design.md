# 桌面客户端账号密码直连登录技术设计

## 1. 目标与边界

桌面冷启动固定进入本地登录页，用户只填写服务器地址、登录名和密码。登录成功后：

1. 本地 WebView 获得 Board 的 HttpOnly Session Cookie。
2. sidecar 获得同一账号的长期设备凭据并启动后台同步。
3. 当前窗口在 WebView 内打开 Board，不使用系统浏览器。

本任务删除桌面客户端中的一次性设备令牌、设备名称输入、浏览器登录、配对码、深链注册和 workspace 初始化入口。服务端仍可保留其他任务正在使用的设备与配对接口，但桌面客户端不再向用户暴露。

## 2. 前置依赖

本任务必须在 `11-08-support-multi-team-board` 的服务端契约完成并验证后实施：

- 登录只验证账号身份，不要求或不保存活动团队。
- Session 返回实时有效团队成员关系。
- 桌面设备凭据绑定“用户 + 设备”，不绑定单一团队。
- `/api/desktop/enroll-tokens` 不要求选择团队。
- `/api/agent/enroll-desktop` 返回兼容多团队的设备身份。

本任务不重复修改上述授权语义。当前多团队任务有大量未提交文件；实施前先由该任务完成验证和提交，避免两套认证改动交叉。

## 3. 端到端流程

```text
冷启动
  -> 本地 index.html
  -> 服务器地址 + 登录名 + 密码
  -> Tauri desktop_login
  -> sidecar login（密码走 stdin）
  -> POST /api/auth/login
  -> 获取 Board Session Cookie
  -> 复用或创建桌面设备
  -> Tauri 写入 WebView HttpOnly Cookie
  -> 更新导航白名单
  -> 启动 sidecar
  -> WebView 打开 Board
```

服务端调用顺序：

```text
POST /api/auth/login
      |
      +-- mustChangePassword=true
      |      -> 只建立 Board 会话，本次不创建设备凭据
      |
      +-- 可复用设备
      |      -> 用现有设备凭据做一次 heartbeat
      |
      +-- 首次/不同账号/凭证失效
             -> POST /api/desktop/enroll-tokens
             -> POST /api/agent/enroll-desktop
             -> 保存 DPAPI 设备凭据
```

一次性设备令牌只存在于 sidecar 内存和单次 HTTP 调用中，不进入 UI、配置文件、命令行或日志。

## 4. 组件与职责

### 4.1 本地登录页

`desktop/ui/index.html` 只保留：

- 服务器地址；
- 登录名；
- 密码；
- 登录按钮；
- 错误提示和版本信息。

页面不再包含 workspace、设备名称、设备令牌、浏览器登录、配对码或“打开看板”按钮。服务器地址可由新版本 `client.json` 预填；登录名和密码不预填。

### 4.2 Tauri 外壳

删除命令：

- `enroll_with_token`
- `enroll_device`
- `open_board_login`
- `pick_workspace`
- `init_workspace`

新增命令：

```text
desktop_login(serverUrl, username, password)
associate_local_project(projectId, syncBranch)
list_local_associations()
```

职责：

- 校验调用页面必须是本地页；
- 校验 Board URL；
- 校验登录名和密码的基本长度；
- 将账号与密码通过 stdin 交给 sidecar，不放入 argv；
- 接收 sidecar 返回的 Session Token 和设备状态；
- 为 Board origin 写入 HttpOnly Session Cookie；
- 更新动态导航白名单；
- 登录成功且设备就绪时启动 sidecar；
- 在 WebView 内导航到 Board。

`associate_local_project` 和 `list_local_associations` 是唯一允许远程 Board 调用的命令。它们校验当前页面 origin 等于动态配置的 Board origin。

`app_status` 缩减为版本、上次服务器地址、配置路径和 sidecar 状态。

### 4.3 sidecar 登录命令

新增：

```text
trellis-agent login --server <URL> --name <设备名> [--force-new]
```

stdin 使用单个 JSON 对象：

```json
{ "username": "alice", "password": "..." }
```

成功 stdout：

```json
{
  "ok": true,
  "serverUrl": "https://board.example.com",
  "sessionToken": "...",
  "expiresAt": "2026-11-09T00:00:00.000Z",
  "username": "alice",
  "mustChangePassword": false,
  "deviceReady": true
}
```

失败沿用 sidecar JSON 错误结构；密码、Session Token 和设备凭据不得进入 stderr 或普通日志。

### 4.4 设备复用

`client.json` 升级为新 schema，只保存：

```json
{ "schemaVersion": 2, "serverUrl": "https://board.example.com" }
```

旧 schema 不参与设备复用。第一次使用新客户端登录时传入 `--force-new`，确保不迁移旧设备。

后续登录可复用 sidecar 中同一服务器、同一用户名的设备，但必须先用设备凭据执行一次 heartbeat。以下任一条件成立时重新兑换设备凭据：

- sidecar 配置不存在或版本不可用；
- 服务器地址变化；
- 登录名变化；
- 工具显式传入 `--force-new`；
- 现有设备 heartbeat 返回认证失败。

重新兑换会覆盖本地 sidecar 配置和 DPAPI 凭据。服务端旧设备记录不在本任务中自动迁移或删除。

账号变化或 `--force-new` 时，还清空该 Agent 数据目录下的 `event-cursors.json`、`events/` 和
`runtime.json`，防止新账号复用前一个账号的游标、事件快照或运行状态。配置和凭据只在设备兑换
成功后再替换；兑换失败时保留旧文件但保持 sidecar 停止。

## 5. Board 会话交接

Tauri v2 的 `WebviewWindow::set_cookie`/`delete_cookie` 可用于 WebView Cookie Store。登录成功后：

1. 解析 sidecar 返回的 `trellis_team_session` Set-Cookie 数据。
2. 仅接受该固定 Cookie 名称、合法 Token 格式和目标 Board origin。
3. 以 `HttpOnly`、`SameSite=Strict`、`Path=/` 和 HTTPS 时 `Secure` 写入 WebView。
4. 写入失败则撤销刚建立的 Session，登录失败，不导航。

Cookie 不写入 `client.json`、sidecar 配置或前端存储。每次冷启动仍显示本地登录页；退出登录后删除 Board Cookie。

## 6. 导航

当前导航白名单在窗口创建时固定，首次登录后没有 Board origin，导致 Board 跳转被交给系统浏览器。改成共享动态状态：

```rust
Arc<RwLock<Option<Url>>>
```

窗口仍以本地 `index.html` 创建，但 `on_navigation` 每次读取当前允许的 Board origin。登录成功先更新该状态，再调用 `window.navigate(board_url)`。

同源 `/login.html` 导航视为客户端退出登录：停止 sidecar、删除 Session Cookie、清除动态 Board origin，并返回本地登录页。外链仍交给系统浏览器。

## 6.1 Board 项目栏本地关联

服务端 Board 项目栏增加仅桌面可用的本地关联入口：

1. `ProjectRail` 检测 `window.__TAURI__.core.invoke` 是否存在；浏览器中不显示入口。
2. 客户端调用 `list_local_associations` 获取项目 ID 到本地路径、分支、只读状态的映射。
3. 未关联项目显示“关联本地项目”操作；点击调用 `associate_local_project({ projectId, syncBranch })`。
4. Rust 校验当前 WebView URL 与已登录 Board origin 同源，再打开系统目录选择器。
5. Rust 调用 sidecar `associate`，由现有 `inspectRepository()` 验证 Git 根目录、`.trellis`、当前分支和 origin。
6. sidecar 写入本地绑定并立即触发一次 heartbeat。
7. 服务端验证 active team member、active project 和远端身份，绑定直接成为有效状态，不再进入人工审批。
8. Board 项目栏刷新为“本地已关联”；`read_only` 项目显示只读标识。

Tauri capability 单独新增 `board-local-association`，通过 `remote.urls` 只给当前窗口开放：

- `allow-associate-local-project`
- `allow-list-local-associations`

不开放通用文件系统、Shell、进程或 `dialog:allow-open` 权限。目录选择器由 Rust 命令内部调用。

服务端绑定规则：

- 当前 binding 的 `pending -> approved` 人工审批从用户流程移除。
- 新绑定在 Team Member、Project Active、Git Remote 和 Branch 校验通过后直接有效。
- 显式 `project_member.role=read_only` 仍为只读；heartbeat 和本地 association 返回 `readOnly:true`。
- 管理台仍可撤销设备或绑定，但不要求先批准。

## 7. 移除 workspace 与旧注册入口

从桌面端删除：

- `desktop/ui/index.html` 的 workspace 面板；
- `desktop/ui/setup.js` 的目录选择、workspace 初始化、令牌、浏览器登录和配对码逻辑；
- `desktop/sidecar/workspace-init.js`；
- sidecar `workspace-init` 命令及桌面端调用；
- Tauri `pick_workspace`、`init_workspace` 命令和 dialog capability；
- `trellisboard://enroll` 深链解析与启动处理；
- 安装器中的协议注册；
- 相关 capability、依赖、README 和验收说明。

`agent/workspace.js` 与 Agent CLI 的 workspace 能力可继续保留给非桌面使用，本任务只删除桌面入口。

## 8. 错误处理

| 场景 | 行为 |
| --- | --- |
| Board URL 非 HTTPS 且非回环 HTTP | 停留登录页，提示地址不合法 |
| 用户名或密码错误 | 清空密码，停留登录页 |
| 登录限流 | 显示服务端限流信息 |
| 网络或 TLS 失败 | 不导航，不写设备配置 |
| 登录成功但设备兑换失败 | 撤销 Session，登录失败 |
| `mustChangePassword=true` | 写 Session 并进入 Board；本次不创建设备、不启动 sidecar |
| Cookie 写入失败 | 撤销 Session，停留登录页 |
| sidecar 启动失败 | Board 可进入，但本地状态明确提示后台同步不可用 |

## 9. 安全边界

- 密码只经过 `invoke -> Rust -> sidecar stdin -> HTTPS`，不进入 argv、环境变量、配置文件或日志。
- 设备凭据继续只存 Windows DPAPI。
- Session Cookie 只进入 WebView Cookie Store。
- 远程 Board 页面只拥有本地关联相关的两个窄权限命令，没有通用文件系统、Shell 或进程能力。
- 本地登录页只保留 `app_status`、`desktop_login` 和基础窗口权限。
- 改密要求、账号禁用、CSRF Origin、Host 校验和登录限流继续由服务端执行。

## 10. 兼容、回滚与风险

- 不兼容旧 `client.json`、旧桌面设备注册、旧深链和旧 workspace 初始化页。
- 新客户端第一次登录强制创建设备，不认旧 sidecar 配置。
- 回滚点按“本地 UI/权限 -> sidecar 登录 -> Tauri Cookie/导航”拆分；任一层失败可停止后续接线。
- 最大技术风险是 Tauri WebView Cookie 域名语义。必须在 Windows WebView2 上实测 HTTPS 域名和回环 HTTP 两种来源，不能只依赖 Rust 单元测试。
- 远程 capability 使用 `https://*` 和回环 HTTP pattern，必须由 Rust 二次校验动态 Board origin，避免其他远程页面调用本地关联命令。
- 每次冷启动要求重新登录意味着 `--minimized` 开机自启在用户登录前不会启动 sidecar。该取舍符合“双击后先登录”的当前要求，后续若要恢复无人值守同步需单独设计持久会话。

