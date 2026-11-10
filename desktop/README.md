# Trellis Board Windows 客户端

Tauri v2 外壳 + Node SEA sidecar。客户端冷启动固定显示本地登录页，用户只填写服务器地址、
登录名和密码；登录成功后当前 WebView 直接进入 Board，后台 sidecar 使用同一账号的设备凭证
同步 Agent 生命周期。

- 客户端版本：`desktop/package.json`、`desktop/src-tauri/Cargo.toml`
- Agent 协议：`AGENT_PROTOCOL_VERSION = 2`
- 本地配置：`%LOCALAPPDATA%\TrellisBoard\data\client.json`
- Agent 数据：`%LOCALAPPDATA%\TrellisBoard\data\agent`

## 登录流程

```text
本地登录页
  -> app_status（预填上次服务器地址）
  -> desktop_login(serverUrl, username, password)
  -> Tauri IPC
  -> sidecar stdin（单个 JSON 对象）
  -> POST /api/auth/login
  -> 写入 WebView HttpOnly Session Cookie
  -> 复用或创建当前账号的桌面设备
  -> 当前 WebView 打开 Board
```

安全边界：

- 密码只经过 `invoke -> Rust -> sidecar stdin -> HTTP/HTTPS`，不进入 argv、环境变量、日志或配置文件。
- 远程 HTTP 不提供传输加密，密码、会话 Cookie 和任务内容可能被监听或篡改；非可信网络应使用 HTTPS。
- Session Cookie 只存在当前 WebView Cookie Store 和 Rust 内存；冷启动后必须重新登录。
- 设备凭证只由 Windows DPAPI 保存，`client.json` 只保存 `serverUrl`。
- 首次使用新客户端会忽略旧 `client.json` schema 并强制创建新设备；不迁移旧设备令牌。
- 同服务器、同账号再次登录会先用已有设备做 heartbeat，有效则复用。
- 不同账号、不同服务器或显式 `--force-new` 会重新兑换设备并清理旧账号的游标、事件缓存和运行状态。
- 切换账号还会清理旧的实时游标、待确认批次和本地冲突备份，避免跨账号展示。
- `mustChangePassword=true` 时只建立 Board 会话，不创建设备；完成改密后下一次登录再建立设备。

sidecar 内部仍会用一次性的设备兑换令牌调用现有
`POST /api/desktop/enroll-tokens -> POST /api/agent/enroll-desktop`，但令牌不进入 UI、磁盘、
命令参数或日志，只存在于 sidecar 单次调用内存。

## 本地项目关联

项目栏由服务端 Board 渲染。只有 Tauri WebView 会显示本地关联入口；普通浏览器不显示。

```text
Board ProjectRail
  -> invoke("list_local_associations")
  -> invoke("associate_local_project", { projectId, syncBranch })
  -> Rust 校验当前页面 origin == 本次登录 Board origin
  -> Rust 打开系统目录选择器
  -> sidecar associate
  -> inspectRepository 校验 Git 根、.trellis、当前分支和 origin
  -> 一次 Agent heartbeat
  -> 服务端校验团队成员、项目状态、分支和远端身份
  -> 绑定直接 approved
```

- 账号属于启用团队即可关联该团队项目；不再需要项目负责人人工审批。
- `project_member.role=read_only` 可以关联并接收服务端内容，但项目栏显示只读，服务端拒绝任务写操作。
- 项目停用、团队移除、设备撤销、远端或分支不一致时，关联失效。
- 客户端不能新增服务端项目；项目必须先由管理台创建并启用。
- 本地关联用于桌面 WebView，不开放通用文件系统、Shell、进程或 dialog 权限给远程页面。

## 实时任务同步

已关联、`approved` 且非 `read_only` 的项目会由 sidecar 启动与单机服务端相同的 watcher：

```text
.trellis 文件变化
  -> 250ms 聚合
  -> Git dirty 路径过滤
  -> 读取仍未提交的 UTF-8 文本
  -> assignee preflight
  -> 责任人确认（需要时）
  -> POST /api/agent/live-changes
  -> 服务端项目 revision + live.changed
  -> 其他客户端拉取
  -> 冲突文件先备份
  -> 临时文件、fsync、原子 rename
```

- 单文件上限 1 MiB，单批次 8 MiB / 64 文件；只同步 `.trellis/.developer`、
  `.trellis/tasks/**` 和 `.trellis/workspace/**` 下的 JSON、JSONL、Markdown、文本和 YAML。
- 任务列表、单项目 Board 和任务详情都优先使用服务端实时覆盖层；Board 每 750ms 检查实时 revision。
- 远端版本覆盖本地不同内容前，原文件备份到
  `%LOCALAPPDATA%\TrellisBoard\data\agent\live-backups\<projectId>\<backupId>`。
- 控制窗口可一键复原；复原会作为更高 revision 上传并广播。取消责任人操作会先备份，再恢复
  服务端或 Git 当前版本。
- 非责任人可选择取消、继续推进或接管。继续保留原责任人并写审计；接管会更新 `task.json.assignee`
  并形成新的实时 revision；原责任人收到通知。
- 控制窗口只在客户端启动后的第一次待确认事件自动显示和聚焦。点击系统 X 或“稍后处理”
  只隐藏窗口，不删除待确认批次；后续事件继续静默排队，可从托盘“处理实时确认”重新打开。
- Git merge、checkout 或 fast-forward 写回但最终与 HEAD 一致时，sidecar 不会上传或弹窗；
  真实未提交修改仍按责任人确认流程处理。
- `read_only` 项目只接收和落盘，不启动上传 watcher。
- Git 内容与实时文件摘要一致后覆盖行自动收敛；不一致时任务卡显示“实时未入 Git”，不会回退。

## Tauri 权限

`capabilities/main.json` 只允许本地页面：

- `app_status`
- `desktop_login`

`capabilities/board-local-association.json` 通过 `remote.urls` 允许任意主机和端口的 HTTP/HTTPS
Board origin 调用：

- `associate_local_project`
- `list_local_associations`
- `desktop_sidecar_status`

远程 capability 同时使用 `http://*:*` 和 `https://*:*`；不带端口的 `http://*` 只匹配默认端口，
不能用于局域网地址加自定义端口。Rust 命令还会把当前 WebView origin 与本次登录成功的 Board origin
做同源比较，其他远程页面即使命中 capability 也会被拒绝。

`capabilities/live-control.json` 只绑定本地 `live-control` 窗口：

- `live_control_pending`
- `live_control_decide`
- `live_control_restore`
- `live_control_dismiss`

控制窗口只处理当前实时同步事件，不拥有文件系统、Shell 或远程页面权限。

本地登录页没有通用 dialog 权限。目录选择器由 `associate_local_project` 在 Rust 内部调用
`tauri-plugin-dialog`，不向页面暴露 `dialog:allow-open`。

## 导航与退出

- 冷启动始终加载 `tauri://localhost/index.html` 或 Windows 等价本地 URL，不根据历史配置直接打开 Board。
- 登录成功后动态写入允许的 Board origin，再在同一 WebView 内导航。
- 同源 Board 导航允许；外链仍交给系统浏览器；`window.open` 一律拒绝。
- Board 同源跳转到 `/login.html` 或 `/login` 时，客户端拦截导航、停止 sidecar、撤销会话、
  删除 Cookie、清空 Board origin，并返回本地登录页。

## 目录

```text
desktop/
  ui/                         本地登录页、实时同步控制窗口
  src-tauri/
    src/main.rs               窗口、登录、Cookie、动态导航、本地关联命令
    src/navigation.rs         Board URL 白名单和同源导航
    src/config.rs             client.json schema 2
    src/sidecar.rs            sidecar JSON 命令、生命周期和日志转发
    src/logging.rs            日志脱敏
    capabilities/             本地登录与远程关联分离的 capability
    permissions/desktop.toml  登录、关联、状态和控制窗口的显式命令
    binaries/                 SEA sidecar 构建产物
  sidecar/
    cli.js                    源码运行入口，注入 DPAPI helper 路径
    sea-entry.js              SEA 入口，不做模块路径推断
    main.js                   login/logout/associate/associations/live-decide/live-restore/run/...
    desktop-device.js         登录、Cookie 解析、设备复用和兑换
    desktop-association.js    本地 Git 检查、绑定写入和即时 heartbeat
    bundle.mjs                esbuild + SEA 配置
    build-sidecar.ps1         Node 24 x64 打包
  install.ps1                 按用户安装、SHA256、暂存与回滚
  uninstall.ps1               卸载、可选设备撤销和数据处理
```

## 配置

```json
{
  "schemaVersion": 2,
  "serverUrl": "https://board.example.com"
}
```

不保存用户名、密码、Session Cookie、设备凭证或团队缓存。schema 1 配置不参与设备复用，首次
新登录时按无配置处理。

服务器地址预填顺序：

```text
--server <url> > TRELLIS_DESKTOP_SERVER_URL > client.json
```

URL 必须为 HTTP 或 HTTPS 根地址。HTTP 可用于内网或测试环境，但不提供传输加密；生产环境仍建议使用 HTTPS。
`--minimized` 启动时隐藏主窗口。`TRELLIS_DESKTOP_HOME` 可重定向整个桌面数据目录。

## 构建

前置：

- Windows 10/11 x64
- Node.js 24 x64
- Rust stable（MSVC toolchain）
- Visual Studio Build Tools（C++ 桌面负载）
- `cargo install tauri-cli --locked --version "^2"`
- WebView2 Runtime

```powershell
npm --prefix desktop install
powershell -NoProfile -ExecutionPolicy Bypass -File desktop\sidecar\build-sidecar.ps1

cd desktop
cargo tauri build --no-bundle
cargo tauri build
```

产物：

- `desktop\src-tauri\target\release\trellis-board-client.exe`
- `desktop\src-tauri\target\release\bundle\nsis\Trellis Board_<version>_x64-setup.exe`

必须先构建 sidecar，`tauri.conf.json` 的 `externalBin` 依赖
`binaries/trellis-agent-x86_64-pc-windows-msvc.exe`。

## 安装与卸载

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File desktop\install.ps1 `
  -Source .\trellis-board-client.exe -ServerUrl https://board.example.com

.\TrellisBoard_<version>_x64-setup.exe /S

powershell -NoProfile -ExecutionPolicy Bypass -File desktop\uninstall.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File desktop\uninstall.ps1 -PurgeData
$env:TRELLIS_BOARD_SESSION = '<trellis_team_session cookie>'
powershell -NoProfile -ExecutionPolicy Bypass -File desktop\uninstall.ps1 -RevokeDevice
```

`install.ps1` 不再注册 `trellisboard://` 深链。卸载脚本保留旧协议清理，便于升级后的机器不残留
历史注册项。

## 验证清单

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 全新安装后双击 | 只出现服务器地址、登录名、密码登录页 |
| 2 | 错误密码 | 停留登录页，密码清空，无设备配置 |
| 3 | 正确密码 | 当前窗口进入 Board，不弹系统浏览器；`credential.dpapi` 存在 |
| 4 | 检查 `client.json` | 只有 schema 2 与 serverUrl，无密码、Cookie 或设备凭证 |
| 5 | 多团队账号登录 | 无需选择团队，直接看到授权范围 |
| 6 | 同账号再次启动登录 | 复用同一设备，设备总数不增加 |
| 7 | 另一账号登录 | 不复用旧账号 Credential、游标或事件缓存 |
| 8 | Board 项目栏关联本地仓库 | 分支和 origin 不匹配时拒绝；匹配后直接显示已关联 |
| 9 | 普通浏览器打开 Board | 不显示本地关联入口 |
| 10 | read_only 项目 | 显示只读，任务写请求被服务端拒绝 |
| 11 | Board 退出登录 | sidecar 停止，会话失效，返回本地登录页 |
| 12 | 重启客户端 | 仍先显示本地登录页 |
| 13 | A 修改未提交任务文件 | B 的 Board 与本地 `.trellis` 在正常网络 P95 3 秒内更新 |
| 14 | A/B 同时修改同一文件 | 后到 revision 生效；先到方先生成备份并显示冲突提示 |
| 15 | 从控制窗口一键复原 | 备份作为新 revision 广播，双方最终一致 |
| 16 | 非责任人修改任务 | 首次出现取消/继续/接管/稍后处理；继续保留责任人，接管才改派 |
| 17 | 关闭控制窗口后继续产生事件 | 不自动显示或抢焦点；从托盘“处理实时确认”恢复 |
| 18 | Board 服务离线时关闭控制窗口 | 窗口立即隐藏，待确认批次保留 |
| 19 | `read_only` 项目修改本地文件 | 本地可接收服务端内容，但修改不上传 |

Windows 实机仍需验证 WebView2 Cookie 写入、远程 capability、动态导航和 NSIS 安装包。
