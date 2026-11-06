# Trellis Board 桌面客户端（Windows）

Tauri v2 外壳 + 现有 Agent sidecar。桌面端只负责：加载 Board 网页、托盘/单实例/开机自启、
用一次性配对码把设备注册到现有 `/api/agent/enroll`。SSE、心跳、任务执行仍由
`agent/` 实现，桌面端不重复实现业务。

- 协议版本：`AGENT_PROTOCOL_VERSION = 2`（`agent/protocol.js`）
- 客户端版本：`desktop/package.json` / `src-tauri/Cargo.toml` 的 `0.2.0`
- 设备注册复用：`POST /api/team/pairing-codes`（用户会话）→ `POST /api/agent/enroll`
- 设备撤销复用：`POST /api/admin/agents/{id}/revoke`

## 目录

```
desktop/
  ui/                    本地加载页/注册页（无打包器、无第三方依赖）
  src-tauri/             Rust 外壳
    src/main.rs          窗口、托盘、单实例、命令
    src/navigation.rs    导航白名单（仅 Board origin；外链交系统浏览器）
    src/config.rs        本地配置（serverUrl，不含任何凭证）
    src/sidecar.rs       tauri-plugin-shell 启动/重启/停止 sidecar，转发日志
    src/logging.rs       desktop.log + 凭证脱敏
    capabilities/main.json
    tauri.conf.json
    binaries/            build-sidecar.ps1 输出（trellis-agent-<target>.exe）
  sidecar/               Node SEA 打包入口与设备注册/撤销命令
    main.js              run / enroll / revoke / status / version
    desktop-device.js    复用 agent 的 ConfigStore、AgentApiClient、DPAPI
    bundle.mjs           esbuild 单文件 + SEA 配置
    build-sidecar.ps1    Windows x64 打包（Node 24）
  install.ps1            按用户安装（无需管理员）
  uninstall.ps1          按用户卸载
```

## 安全边界

- 导航：只允许配置的 Board origin（`https` 任意主机；`http` 仅 `localhost`/`127.0.0.1`/`::1`），
  且必须是根路径、无账号密码/查询/片段。同源跳转留在 webview；`mailto:`/`http(s)` 外链用
  `shell.open` 交给系统浏览器；`window.open` 一律拒绝。
- 远程页面没有 Tauri IPC：capability `main` 只包含 `core:default` 和两个自定义命令
  `app_status`、`enroll_device`，没有 `shell:allow-open`、文件系统、进程或 updater 权限。
  Rust 命令还会校验调用页面 URL 必须是本地页（`ensure_local_caller`），作为 capability 之外的
  第二道防线。设备凭证只存在 sidecar 的 DPAPI 文件中，不注入 webview，也不写 cookie。
- 生产构建禁用 devtools（未启用 `devtools` feature，且只在 debug 构建可打开）。
- CSP：`default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:;
  connect-src ipc: http://ipc.localhost; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`。
- 日志：`desktop.log` 对 `Bearer ...`、`"credential"`、`"pairingCode"`、`"password"` 做脱敏；
  配对码只经 stdin 传给 sidecar，不进命令行、不落盘。
- 关闭窗口 = 最小化到托盘；托盘菜单：打开主窗口、暂停同步、打开日志目录、开机自启、退出。
- 单实例：重复启动只聚焦已有窗口。

## 配置与命令行

配置保存在 `%LOCALAPPDATA%\TrellisBoard\data\client.json`：

```json
{ "schemaVersion": 1, "serverUrl": "https://board.example.com" }
```

覆盖顺序：`--server <url>` > `TRELLIS_DESKTOP_SERVER_URL` > `client.json`。URL 不符合白名单时
客户端退回本地注册页。`--minimized` 启动时隐藏主窗口（自启使用）。`TRELLIS_DESKTOP_HOME`
可整体重定向数据目录（测试/便携场景）。

sidecar 数据在 `%LOCALAPPDATA%\TrellisBoard\data\agent`（`TRELLIS_AGENT_ROOT` 由客户端注入）。

## 构建（Windows x64 构建机）

前置：

- Windows 10/11 x64
- Node.js 24 x64（`agent/package-agent.ps1` 同款要求；Node 22 会拒绝打包）
- Rust stable（MSVC toolchain）+ Visual Studio Build Tools（C++ 桌面负载）
- Tauri CLI：`cargo install tauri-cli --locked --version "^2"`（提供 `cargo tauri`）
- WebView2 Runtime（Win11 自带；Win10 由 NSIS 安装包以 `downloadBootstrapper` 静默安装）

```powershell
# 1) 安装构建期 Node 依赖（仅 esbuild/postject，运行时无依赖）
npm --prefix desktop install

# 2) 打包 sidecar -> desktop\src-tauri\binaries\trellis-agent-x86_64-pc-windows-msvc.exe
powershell -NoProfile -ExecutionPolicy Bypass -File desktop\sidecar\build-sidecar.ps1

# 3) 前端无需构建（desktop/ui 是静态文件）

# 4) 进入 desktop，Tauri CLI 从 src-tauri 读取配置
cd desktop

# 4a) 生成单可执行文件（不打包安装器）
cargo tauri build --no-bundle
# 产物：desktop\src-tauri\target\release\trellis-board-client.exe

# 4b) 生成 NSIS 安装器（*-setup.exe，支持 /S 静默）
cargo tauri build
# 产物：desktop\src-tauri\target\release\bundle\nsis\Trellis Board_0.2.0_x64-setup.exe
```

`tauri.conf.json` 已固定 `bundle.targets=["nsis"]`、`nsis.installMode="currentUser"`、
`webviewInstallMode=downloadBootstrapper`（`silent: true`）。
`bundle.externalBin=["binaries/trellis-agent"]`，因此 **必须先执行步骤 2**，否则 Rust 构建失败。

### 单可执行文件分发（不装 NSIS）

把 `trellis-board-client.exe` 和 `trellis-agent-x86_64-pc-windows-msvc.exe` 放同一目录
（`install.ps1` 会把后者复制并重命名为 `trellis-agent.exe`），然后：

```powershell
# 生成 SHA256SUMS.txt（安装脚本默认读取同目录清单）
Get-FileHash .\trellis-board-client.exe -Algorithm SHA256 |
  ForEach-Object { "$($_.Hash.ToLower())  trellis-board-client.exe" } |
  Set-Content .\SHA256SUMS.txt -Encoding ascii

powershell -NoProfile -ExecutionPolicy Bypass -File desktop\install.ps1 `
  -Source .\trellis-board-client.exe -ServerUrl https://board.example.com
```

## 安装 / 卸载脚本

```powershell
# 安装（默认 %LOCALAPPDATA%\TrellisBoard；-Source 是客户端 exe，不是 setup.exe）
powershell -NoProfile -ExecutionPolicy Bypass -File desktop\install.ps1 `
  -Source .\trellis-board-client.exe -ServerUrl https://board.example.com

# 静默安装（不写自启、不启动）
powershell -NoProfile -ExecutionPolicy Bypass -File desktop\install.ps1 -Quiet -NoAutostart -NoLaunch

# NSIS 安装器走自己的 currentUser 流程；静默安装 /S 必须大写
.\TrellisBoard_0.2.0_x64-setup.exe /S

# 卸载（保留 data；-PurgeData 删除 data；-RevokeDevice 先调用撤销接口）
powershell -NoProfile -ExecutionPolicy Bypass -File desktop\uninstall.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File desktop\uninstall.ps1 -PurgeData
$env:TRELLIS_BOARD_SESSION = '<trellis_team_session cookie>'
powershell -NoProfile -ExecutionPolicy Bypass -File desktop\uninstall.ps1 -RevokeDevice
```

安装脚本行为：校验源文件存在、校验 SHA256（`SHA256SUMS.txt` 或 `-Checksum`）、停止正在运行的
客户端、把同目录的 `trellis-agent*.exe` 复制为 `<InstallDir>\trellis-agent.exe`、暂存目录 +
备份 + 失败回滚、创建开始菜单/桌面快捷方式、写
`HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 的 `"<exe>" --minimized`、可选写入
`data\client.json`。路径全部用引号/`-LiteralPath` 处理空格。退出码：

| 脚本 | 0 | 1 | 2 | 3 | 4 | 6 |
| --- | --- | --- | --- | --- | --- | --- |
| install.ps1 | 成功 | 参数/源文件/架构错误 | SHA256 失败（未落盘） | 复制/安装失败（已回滚） | 快捷方式/自启失败（已回滚） | — |
| uninstall.ps1 | 成功/未安装 | 参数或受保护目录 | — | 删除失败 | — | 撤销失败（未删本地文件） |

`uninstall.ps1` 拒绝删除盘符根、`%LOCALAPPDATA%`、`%USERPROFILE%`、`%APPDATA%`；默认只删
exe/快捷方式/自启，保留 `data`。

## 签名、SmartScreen、WebView2

- 代码签名：用 EV/OV 证书对 `trellis-board-client.exe`、`trellis-agent.exe`、最终
  `*-setup.exe` 签名（`signtool sign /fd SHA256 /tr <timestamp> /td SHA256 /a <file>`）。
  Tauri 可用 `bundle.windows.certificateThumbprint` + `digestAlgorithm` + `timestampUrl` 让
  NSIS 产物自动签名；本项目未内置证书。
- SmartScreen：未签名或新证书会提示“Windows 已保护你的电脑”。正式发布必须签名并积累声誉；
  内测可提供 SHA256 供用户核对，不要建议关闭 SmartScreen。
- WebView2：`downloadBootstrapper` 在安装时联网下载 Evergreen Runtime；离线环境需改为
  `offlineInstaller` 并随包放 `MicrosoftEdgeWebview2Setup.exe`。
- 升级顺序：**先升 Agent/桌面端，再升服务端**。协议 v2 下旧 Agent 仍可连接新服务端；
  反过来（新 Agent + 旧服务端）会在 enroll/心跳阶段报 `PROTOCOL_INCOMPATIBLE`。
  回滚：卸载客户端不会撤销服务端设备记录；需要时在 Board 撤销后重装。

## Windows 验证清单

在 Windows x64 构建机上逐项执行并记录输出（Linux 无法执行）：

| # | 命令 | 预期 |
| --- | --- | --- |
| 1 | `node -p "process.versions.node + ' ' + process.arch"` | `24.x x64` |
| 2 | `powershell -NoProfile -ExecutionPolicy Bypass -File desktop\sidecar\build-sidecar.ps1` | 退出码 0；`binaries\trellis-agent-x86_64-pc-windows-msvc.exe` 与 `SHA256SUMS.txt` 存在 |
| 3 | `cargo tauri build --no-bundle` | 退出码 0；`target\release\trellis-board-client.exe` 存在 |
| 4 | `cargo tauri build` | `bundle\nsis\Trellis Board_0.2.0_x64-setup.exe` 存在 |
| 5 | `.\TrellisBoard_0.2.0_x64-setup.exe /S` | 静默安装到 `%LOCALAPPDATA%\TrellisBoard`，开始菜单出现快捷方式 |
| 6 | `Test-Path "$env:LOCALAPPDATA\TrellisBoard\trellis-board-client.exe"; Test-Path "$env:LOCALAPPDATA\TrellisBoard\trellis-agent.exe"` | 两行均为 `True` |
| 7 | 启动客户端 → 输入配对码 → 提交 | 跳转 Board；`%LOCALAPPDATA%\TrellisBoard\data\agent\credential.dpapi` 存在且不是明文 |
| 8 | `Get-Content "$env:LOCALAPPDATA\TrellisBoard\data\agent\credential.dpapi" -TotalCount 1` | 二进制/DPAPI 内容，不含 64 字符 base64url 凭证 |
| 9 | 关闭窗口 | 进程仍在，托盘图标存在；托盘“退出”后进程消失 |
| 10 | 再次双击 exe | 不产生第二个进程，只聚焦已有窗口 |
| 11 | 托盘勾选“开机自启”，注销重登 | 客户端以 `--minimized` 启动 |
| 12 | 在 Board 页面点外链 | 系统浏览器打开，客户端窗口 URL 不变 |
| 13 | `powershell -NoProfile -ExecutionPolicy Bypass -File desktop\uninstall.ps1 -PurgeData` | 退出码 0；安装目录与快捷方式消失，Run 值消失 |
| 14 | Board 设备列表 | 设备在下次心跳超时后离线；`-RevokeDevice` 后立即显示已撤销 |

## Linux 未验证项

开发/CI 环境是 Linux，**没有 cargo/rustc，也没有 pwsh**，以下均未在本仓库验证：

1. `cargo test` / `cargo build` / `tauri build`（Rust 编译、`generate_context!`、Cargo.lock 解析）。
2. `build-sidecar.ps1` 的 `node --experimental-sea-config` 与 postject 注入实际产物。
3. `install.ps1` / `uninstall.ps1` 的真实执行（仅做静态断言）。
4. NSIS 产物、`/S` 静默安装、WebView2 bootstrapper、快捷方式/自启注册表。
5. DPAPI 加解密（`agent/windows/dpapi.ps1`）与 sidecar 的 SEA asset 解包。
6. 托盘/单实例/导航拦截的运行时行为。
7. 代码签名与 SmartScreen 表现。

复现步骤即上表 1–14。CI 在 Linux 上只跑 `npm test` 中的静态契约测试
（`tests/desktop-package.test.js`）。
