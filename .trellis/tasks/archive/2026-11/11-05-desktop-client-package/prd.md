# 客户端打包 exe 与嵌入页面

## Goal

交付一个 Windows 桌面客户端：以 **Tauri 单 exe** 分发，双击即可运行；同时提供 PowerShell 安装/卸载路径（复制、快捷方式、自启），承载 Trellis Board 页面，并在关闭窗口后继续后台运行，承担 Agent 同步与事件监听。

## Dependencies

- 依赖 `11-05-client-server-push` 提供事件通道。
- 依赖 `11-05-user-registration` / `11-05-team-isolation` 提供登录与团队上下文。
- `11-05-workspace-bootstrap` 作为集成项：desktop 先提供 Tauri 目录选择与本地执行环境，workspace 模块完成后接入；不在 desktop 内重复实现模板下载/解包逻辑。
- 可先基于现有 `agent/` 与 `web/` 构建产物做出可运行壳，再逐项接入后三个子任务。

## Current State（仓库事实）

- 现有 Windows Agent 是 zip 分发包：`agent/package-agent.ps1` 产出 `dist/trellis-board-agent-win-x64-<version>.zip`，内含 Node 24 `node.exe`、Agent 源码与脚本；目标机解压后运行 `trellis-agent.cmd`。
- 后台运行依赖登录自启计划任务：`agent/windows/service.ps1`；`service install/uninstall/status` 由 `agent/cli.js` 提供。
- Agent 是控制台进程，没有窗口、托盘、安装器或内嵌页面；仓库没有 Tauri 工程、`install.ps1` 或 `uninstall.ps1`。
- Board 前端已迁移为 React 19 + Vite + TypeScript + Tailwind/shadcn：源码在 `web/`，入口 `web/index.html`、`web/admin.html`、`web/login.html`；`web/vite.config.ts:18` 将构建产物输出到 `public/`，服务端通过 `server/team/http.js:1010` / `server/index.js:30` 托管 `public/`。
- 根 `package.json` 的 `build` 为 `npm --prefix web run build`；`public/` 是构建产物、不随仓库提交，部署前必须先构建。
- 现有凭证存储使用 Windows DPAPI：`agent/credential-store.js`；配置在 `%LOCALAPPDATA%\TrellisBoardAgent\config.json`。
- 现有设备身份只有 Agent 配对码/设备（`server/team/agents.js` 的 `agent_pairing_code`、`agent_device`），没有桌面设备注册接口，也没有“登录会话换设备凭证”的契约。
- 服务端/Agent 运行时仍是 Node 24 零第三方依赖；前端有独立构建链，两者不要混淆。

## In Scope

- 桌面壳：**Tauri v2**（已确认），Windows x64。
  - 主窗口加载配置的服务端 Board URL（远程页面），支持登录、看板、任务详情、管理页；不把 `web/` 构建产物打进 Tauri 安装包。
  - 托盘图标、菜单（打开主窗口、暂停同步、查看日志、退出）、关闭到托盘、单实例锁。
  - 开机/登录自启（HKCU Run 或计划任务），启动后最小化到托盘。
  - 窗口状态记忆、最小尺寸、DPI 缩放、深色模式跟随系统（可选）。
- 分发形态：
  - **单 exe 便携版**：Tauri release 构建出的 `*.exe`，双击直接运行，不写安装目录（数据仍在 `%LOCALAPPDATA%`）。
  - **PowerShell 安装**：`install.ps1` 将便携 exe 复制到 `%LOCALAPPDATA%\TrellisBoardClient`，创建快捷方式、注册自启并启动；无需管理员。
  - **NSIS setup exe（可选）**：Tauri `bundle.targets = ["nsis"]` 产出 `*-setup.exe`，支持 PowerShell 静默安装（`/S`），供企业批量分发；安装模式使用 `installMode: currentUser`。
  - 以上三种形态共享同一份 exe 与版本号，不维护两套代码。
- PowerShell 安装/卸载：
  - `install.ps1`：校验包 SHA256、复制到安装目录、创建开始菜单/桌面快捷方式、注册自启、启动客户端、输出安装路径与版本。
  - `uninstall.ps1`：停止进程、移除自启与快捷方式、删除程序目录；默认保留用户配置、凭证、日志与 workspace，`-PurgeData` 才清理。
  - 默认按用户安装（无需管理员）；机器级安装作为可选参数并明确需要提权。
  - 支持 `-Quiet`、`-ServerUrl`、`-NoAutostart` 等非交互参数，便于企业脚本分发。
- 后台运行与同步：
  - 把现有 `agent/` 打成 **Node SEA 单文件 sidecar**，由 Tauri 主进程启动、监控并在退出时终止；复用其同步、锁、日志、DPAPI 凭证与协议逻辑。
  - 接入事件通道后保持长连接；断线重连、心跳、游标持久化。
  - 关闭窗口不退出进程；退出必须显式从托盘菜单执行。
  - 崩溃后自动重启（有限次数）并记录日志；不产生多实例。
- 登录与设备身份：
  - 首次启动引导填写服务端地址，远程 Board 页面完成登录。
  - 新增**桌面设备注册**契约：远程页面登录后用会话换取桌面设备凭证（例如 `POST /api/desktop/devices`），后台 sidecar 只使用该设备凭证，不依赖浏览器 Cookie。
  - 设备注册需返回稳定 `deviceId`、凭证/刷新令牌与过期时间；一个安装实例对应一个设备，重复注册应复用或轮换而非无限增生。
  - 凭证只存 DPAPI，不进入前端 `localStorage`；管理员/用户可撤销设备，撤销后事件流与同步立即失效。
  - 设备注册、凭证轮换、撤销都写入审计；不记录凭证明文。
- 安全边界（Tauri）：
  - 只加载配置的 Board 源；导航/新窗口白名单，外部链接交给系统浏览器。
  - Tauri capabilities 最小化：远程页面默认不能调用 IPC；如确需目录选择/托盘等能力，只对配置的远程域开放白名单命令，并校验来源。
  - 拒绝摄像头、麦克风、地理位置等无关权限；不忽略 TLS 错误。
  - 服务端 CSP 保持有效；不在页面注入内联脚本或远程第三方脚本。
  - 日志脱敏 token、配对码、密码与完整本地路径。
- 打包与版本：
  - 构建前置：在仓库根执行 `npm run build` 生成 `public/`，服务端可正常提供 Board 页面；Tauri 只打包壳与 sidecar，不重复打包 `web/` 资源。
  - 产出 `trellis-board-client-win-x64-<version>.exe`（便携单文件）+ `SHA256SUMS.txt` + `install.ps1` / `uninstall.ps1`；可选 `*-setup.exe`（NSIS）。
  - 版本号来自 `package.json` / `tauri.conf.json`，显示在关于页与日志；启动时可选检查服务端版本并提示手动升级。
  - 构建可重复：固定 Tauri / Rust / WebView2 相关版本，不把测试、数据库、配置、凭证或开发机路径打入包内。
- 诊断：
  - “关于/诊断”页显示版本、服务端地址、连接状态、最近同步、日志目录、打开日志按钮。
  - 支持导出脱敏诊断包（可选）。

## Out of Scope

- macOS / Linux 客户端。
- 自动静默更新、灰度发布、回滚服务器。
- MSI/MSIX 打包（首版以单 exe + PowerShell 安装为主；NSIS setup exe 为可选形态）。
- 代码签名证书采购与 EV 证书流程；首版允许未签名，但需文档说明 SmartScreen 提示。
- 在客户端内运行完整 Trellis CLI 工作流（创建任务仍由服务端权威执行）。
- 多窗口、多账号同时登录。

## 已确认决策（2026-11-05）

1. **桌面技术栈**：Tauri v2；单 exe 便携运行 + PowerShell 安装，NSIS setup exe 作为可选批量分发形态。
2. **页面加载方式**：Tauri 窗口直接加载服务端 Board URL，始终与服务器版本一致；需要严格的远程域 capability 与导航白名单。
3. **安装范围**：按用户安装到 `%LOCALAPPDATA%`，无需管理员；机器级安装只作为可选参数并明确需要提权。
4. **后台身份来源**：新增**桌面设备注册**接口，由登录会话直接换取设备凭证；不复用 Agent 配对码作为主路径。
5. **Node Agent 复用方式**：把现有 `agent/` 打成 Node SEA 单文件 sidecar，由 Tauri 启动；不做 Rust 重写。

## Acceptance Criteria

- [ ] 在干净的 Windows 10/11 x64 机器上，双击单 exe 即可启动客户端，无需预装 Node、npm 或 Rust；缺少 WebView2 时给出安装引导而不是静默崩溃。
- [ ] `powershell -ExecutionPolicy Bypass -File .\install.ps1` 可按用户安装、创建快捷方式、注册自启并启动；无需管理员。
- [ ] 可选 NSIS `*-setup.exe` 可通过 `powershell -File setup.exe /S` 静默安装/升级；安装模式为当前用户。
- [ ] 安装脚本校验 SHA256；校验失败中止且不落盘；重复安装可覆盖升级并保留用户数据。
- [ ] 卸载脚本移除程序、快捷方式和自启；默认保留 `%LOCALAPPDATA%` 下的配置/凭证/日志/workspace，`-PurgeData` 才删除。
- [ ] 服务端已执行 `npm run build` 且 `public/` 可用时，客户端启动后加载服务端 Board URL，可完成登录、看板浏览、任务详情和 workspace 选择；客户端不依赖本机 `web/` 源码或 Node 前端构建链。
- [ ] 关闭主窗口后进程仍在托盘运行，后台同步与事件监听继续；托盘“退出”能完全退出且无残留进程。
- [ ] 单实例：重复启动聚焦已有窗口，不产生第二个后台同步进程。
- [ ] 断网后自动重连，恢复后同步与事件不丢失；服务端不可达时有明确状态提示，不崩溃。
- [ ] 渲染进程无法直接访问文件系统/命令执行；远程页面不能调用未授权 IPC；导航被限制在配置源；外部链接用系统浏览器打开；TLS 错误不被绕过。
- [ ] 登录后可通过桌面设备注册换取设备凭证，后台 sidecar 只使用该凭证同步与监听事件；凭证只存 DPAPI，前端 `localStorage` 与日志中无明文。
- [ ] 撤销桌面设备后，现有事件连接与同步在下次请求即失效；重复注册不会无限增生设备记录。
- [ ] 配置文件、日志、崩溃转储和诊断包中无明文 token/密码。
- [ ] 打包产物包含版本文件与 SHA256SUMS，不包含测试、数据库、`data/` 配置或开发机绝对路径。
- [ ] 自动化冒烟测试覆盖安装、启动、关闭到托盘、卸载与升级；构建脚本在 CI/本地可重复执行。

## Notes

- 现有 `agent/package-agent.ps1` 已经解决 Node 运行时打包与 SHA256 清单，可复用到 sidecar 打包；Tauri 官方支持 `externalBin` / sidecar 与资源嵌入。Node SEA sidecar 的生命周期、崩溃重启与日志归属需在 `design.md` 明确。
- 桌面设备注册是新服务端契约，必须定义设备上限、凭证轮换、撤销与审计；不能把登录 Cookie 直接交给后台进程长期使用。
- 用户参考材料中提到的 NSIS `singleInstaller` 不是 Tauri v2 的公开配置项；Tauri v2 使用 `bundle.targets = ["nsis"]` 与 `bundle.windows.nsis.installMode`。单文件便携运行应使用 Tauri 直接构建的 exe（`--no-bundle`），安装器则用 NSIS `*-setup.exe`，实施前需按官方文档复核配置。
- Tauri 复用系统 WebView2；Win10/11 通常已内置，精简系统/旧系统可能需要 WebView2 Evergreen 运行时。是否把 WebView2 安装器一并分发需在设计中确认。
- 未签名 exe 会触发 SmartScreen；首版在 README/安装页明确说明，不能通过关闭系统安全策略规避。
- “后台监听”指服务端事件监听 + Agent 同步循环；本地文件监听仍由服务端 `server/watcher.js` 负责，客户端不需要。
