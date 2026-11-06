# 桌面客户端打包设计（Tauri v2 + Node SEA sidecar）

## 1. 边界与既有事实

- 服务端、Agent 运行时仍是 Node 24 零第三方依赖；本任务不引入新的服务端 API，也不改写同步/SSE 业务。
- 桌面端只做三件事：远程 Board 页面外壳、后台 Agent 生命周期、按用户安装/卸载。
- 页面始终来自服务端 `https://<server>/`，不把 `web/` 构建产物打进安装包；服务端必须先执行 `npm run build` 生成 `public/`。
- 设备身份复用现有契约：
  1. 已登录用户在 Board 管理页 `POST /api/team/pairing-codes` 获取一次性配对码；
  2. 桌面端把配对码提交到 `POST /api/agent/enroll`，换回 `agentId` + 设备凭证；
  3. Agent 后续心跳/事件流使用 `Authorization: Bearer <credential>`；
  4. 撤销走 `POST /api/admin/agents/{agentId}/revoke`（团队管理员会话）。
  不新增 `POST /api/desktop/devices` 之类的平行认证体系。

## 2. 目录结构

```text
desktop/
  README.md                 构建、签名、SmartScreen、升级顺序、Windows 验证清单
  install.ps1               按用户安装；-Uninstall 转调 uninstall.ps1
  uninstall.ps1             停止进程、撤销自启/快捷方式、可选撤销设备与清理数据
  package.json              仅构建期工具（esbuild/postject），私有包
  ui/                       本地加载/设置/错误页；只在未配置或注册失败时显示
    index.html
    setup.js
    styles.css
  sidecar/
    main.js                 薄入口：run / enroll / revoke / version
    desktop-device.js       配对码注册与设备撤销（复用 agent/api.js、agent/config-store.js）
    bundle.mjs              esbuild 打包 + 生成 SEA 配置（可在 Linux 上语法/单元验证）
    build-sidecar.ps1       Windows 构建：Node 24 x64 校验、SEA 注入、产出 sidecar exe
  src-tauri/
    Cargo.toml
    build.rs
    tauri.conf.json
    capabilities/main.json  仅本地窗口；无 remote、无 shell/fs/http 权限
    permissions/desktop.toml 自定义命令 allowlist
    binaries/               构建产物落点（trellis-agent-x86_64-pc-windows-msvc.exe）
    icons/
    src/
      main.rs               Builder、托盘、单实例、窗口与命令注册
      config.rs             %LOCALAPPDATA%\TrellisBoard\data 下的 client.json
      navigation.rs         Board URL 校验与同源导航策略
      sidecar.rs            sidecar 启动/停止/暂停/崩溃重启/日志转发
      logging.rs            桌面日志与脱敏
```

## 3. 进程模型

- 单实例：`tauri-plugin-single-instance` 注册在最前；二次启动聚焦已有窗口并退出新实例。
- 窗口关闭 = 隐藏到托盘（`WindowEvent::CloseRequested` + `prevent_close`）；只有托盘“退出”调用 `app.exit(0)`。
- sidecar：Rust 通过 `tauri-plugin-shell` 的 `sidecar("trellis-agent")` 启动 `run` 子命令，环境变量 `TRELLIS_AGENT_ROOT=<data>\agent`。
  - stdout/stderr 逐行写入 `<data>\logs\desktop.log`，落盘前脱敏。
  - 非主动退出时按 1s/2s/4s/8s/16s 退避重启，最多 5 次；超过后保持停止并在托盘菜单提示“恢复同步”。
  - 托盘“暂停同步”终止子进程且不再自动重启；“恢复同步”重新启动并清零计数。
- sidecar 内部的单实例锁（`agent/lock.js`）继续生效，避免托盘重复启动产生第二个同步进程。

## 4. 配置与 URL 策略

- 数据根：`%LOCALAPPDATA%\TrellisBoard\data`（可用 `TRELLIS_DESKTOP_HOME` 覆盖，便于开发/测试）。
  - `client.json`：`{"schemaVersion":1,"serverUrl":"https://board.example.com"}`。
  - `agent\`：Agent 配置与 DPAPI 凭证；`logs\`：桌面与 Agent 日志。
- 优先级：命令行 `--server <URL>` > 环境变量 `TRELLIS_DESKTOP_SERVER_URL` > `client.json`。
- 允许的 Board URL：`https://` 任意主机，或 `http://localhost|127.0.0.1|[::1]`；必须是根路径，不能带账号、查询或片段（与 `agent/protocol.js:normalizeServerUrl` 一致）。
- 导航：`on_navigation` 只允许与配置 Board URL 同源；其它 URL 交给系统浏览器并拒绝加载。
- `on_new_window` 一律拒绝；`window.open` 不会产生第二个 webview。
- 本地页只用于未配置、注册失败和状态展示；成功后 `location.replace(serverUrl)` 切到远程页面。
- devtools 只在 debug 构建可用；release 不启用 `devtools` feature，也不在配置里开启。

## 5. 安全边界

- `capabilities/main.json` 只绑定窗口 `main`，不写 `remote.urls`，因此远程 Board 页面没有 IPC 权限。
- 权限只有 `core:default` + 两个本地自定义命令（`app_status`、`enroll_device`）；不授予 `shell:*`、`fs:*`、`http:*`、`process:*`、`dialog:*`。
- 两个命令额外校验调用页面 `WebviewWindow::url()` 必须是本地页；即使 ACL 配置失误，远程 Board 页面也无法调用。
- sidecar 由 Rust 启动，不需要给 webview 授予 shell 执行权限。
- `CSP`：`default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src ipc: http://ipc.localhost`，不允许 `unsafe-eval`、通配符或远程脚本。
- 配对码只经本地页 → Rust → sidecar stdin，不写 `localStorage`、不写日志、不进命令行参数。
- 设备凭证由 sidecar 用现有 `agent/credential-store.js` 写入 DPAPI（CurrentUser）；`client.json` 只保存 `serverUrl`，不含凭证。

## 6. sidecar 打包（Node SEA）

- 入口：`desktop/sidecar/main.js`，内部 `import { runAgentProcess } from "../../agent/index.js"`，不复制同步/事件逻辑。
- `bundle.mjs` 用 esbuild 打成单个 CommonJS 文件（`--platform=node --format=cjs`），并用 banner 修复 `import.meta.url`（SEA 内没有真实模块 URL）。
- SEA 配置由 `bundle.mjs` 生成：`main` = bundle，`assets.dpapi.ps1` = `agent/windows/dpapi.ps1`，`useCodeCache: true`。
- `main.js` 在 SEA 中把 `dpapi.ps1` 资产释放到 `<agentRoot>\windows\dpapi.ps1`，并注入 `DpapiCredentialStore({ scriptFile })`；非 SEA 开发模式直接用仓库文件。
- 产物：`src-tauri/binaries/trellis-agent-x86_64-pc-windows-msvc.exe` + `SHA256SUMS.txt` + `VERSION.txt`。
- Node SEA 的 `--experimental-sea-config` + `postject` 仍是 Node 24 的公开路径；构建脚本固定 esbuild/postject 版本，缺失时以明确退出码失败。
- 该流程只能在 Windows x64 + Node 24 上产出可用 exe；Linux 本机只能验证 JS 语法、bundle 逻辑和静态契约。

## 7. 安装 / 卸载

- 安装目录：`%LOCALAPPDATA%\TrellisBoard`；exe：`trellis-board-client.exe`；数据在 `data\`，默认卸载保留。
- `install.ps1`：
  - 校验源文件存在、`SHA256SUMS.txt` 中的 SHA256（不匹配退出码 2，且不落盘）。
  - 先复制到 `data` 之外的 staging 文件，成功后原子替换；失败恢复旧 exe/删除新文件。
  - 创建开始菜单与桌面快捷方式（`WScript.Shell`，路径全部加引号），写 `HKCU:\...\Run` 自启值（`-NoAutostart` 时移除）。
  - 可选写 `data\client.json`（`-ServerUrl`），然后启动；全程无需管理员。
  - 退出码：0 成功、1 参数/源文件错误、2 校验失败、3 复制/回滚失败、4 快捷方式/自启失败。
- `uninstall.ps1`：
  - 停止 `trellis-board-client` 进程，删除 `Run` 值、两个快捷方式和 exe。
  - 默认保留 `data\`；`-PurgeData` 才删除，且删除前校验目标严格等于 `%LOCALAPPDATA%\TrellisBoard\data`。
  - `-RevokeDevice` 优先调用 `data\agent\trellis-agent.exe revoke --server <url> --agent <id>`；sidecar 内部复用 `POST /api/admin/agents/{agentId}/revoke`，并按服务端 CSRF 要求带 `Origin: <serverUrl>`。会话 Cookie 只从 `TRELLIS_BOARD_SESSION` 环境变量或交互式 `Read-Host -AsSecureString` 读取，不落盘、不进 argv。
  - 撤销失败时以退出码 6 停止，**不删除本地文件**，避免设备仍活跃却丢失撤销入口；用户可重试或加 `-SkipRevoke` 先卸载再在 Web 撤销。
- NSIS：`bundle.targets=["nsis"]`、`bundle.windows.nsis.installMode="currentUser"`，产出 `*-setup.exe` 支持 `/S`；`tauri build --no-bundle` 产出便携 exe。两条路径共用同一 Rust/sidecar 产物。

## 8. 版本与升级顺序

- 版本来源：根 `package.json` 0.2.0；`desktop/package.json`、`src-tauri/Cargo.toml`、`tauri.conf.json` 保持一致，测试断言。
- Agent 协议为 v2（`agent/protocol.js:AGENT_PROTOCOL_VERSION`）；桌面端先升 Agent/桌面端，再升服务端。旧 Agent 连新服务端只会降级心跳，不发新命令。
- 服务端版本检查只做提示，不自动更新。

## 9. 测试策略（Linux 可执行）

- `tests/desktop-package.test.js`：
  - `tauri.conf.json`：targets/installMode/externalBin/CSP/无 devtools/版本一致。
  - `capabilities/*.json`：窗口白名单、无 remote、无危险权限、自定义命令在 `permissions/desktop.toml` 中声明。
  - `install.ps1`/`uninstall.ps1`：目标目录、SHA256、快捷方式、自启、退出码、危险删除守卫、撤销端点。
  - sidecar：`main.js` 引用 `agent/index.js`；`bundle.mjs` 生成 SEA 配置且入口资产存在；所有 JS 通过 `node --check`。
  - 设备注册契约：启动真实 team runtime，`POST /api/team/pairing-codes` → 桌面模块 `enrollDesktopDevice` → 真实 `POST /api/agent/enroll`；断言 `agent_device` 行、配置无凭证、重复配对码失败、撤销后 `agent_device.status='revoked'`。
- 不新增第三方测试/运行依赖；esbuild/postject 只在 `desktop/package.json` 中作为构建期依赖。

## 10. 未验证项（Linux 环境）

本机无 cargo/rustc、pwsh、Node 24。以下只能提供可复现清单，不能声称已验证：

- `cargo tauri build` 编译、`--no-bundle` 便携 exe、NSIS `*-setup.exe` 与 `/S`。
- Rust 编译期 API（托盘、`on_navigation`、`on_new_window`、插件版本）以 Tauri v2 文档为准，需在 Windows 构建机确认。
- `install.ps1`/`uninstall.ps1`/`build-sidecar.ps1` 的真实执行、快捷方式、注册表、DPAPI、WebView2 行为。
- Linux 上已实际执行：`node --check`（sidecar/UI）、`node desktop/sidecar/main.js version|status`、`node --test tests/desktop-package.test.js`、`npm test`、`npm run build`、`git diff --check`、`task.py validate`。
- 托盘关闭、单实例聚焦、崩溃重启、开机自启、SmartScreen、签名。

## 11. 风险与取舍

- Tauri Rust 代码无法在本机编译，API 漂移风险最高；实现保持最小调用面，README 给出构建机验证命令。
- SEA 是 Node 实验特性；esbuild/postject 版本固定，构建脚本在缺失工具时明确失败而不是生成半成品。
- 远程页面无法调用 IPC 意味着设备注册只能通过本地设置页完成；这是安全边界的有意取舍。
- 桌面端不解析/缓存 Board 数据；断网时远程页面自行重试，sidecar 负责 Agent 事件重连。
