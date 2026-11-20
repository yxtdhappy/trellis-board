# PRD: 桌面 EXE 本机插件宿主与 Tauri 双通道桥接

- 所属父任务：`11-20-team-plugin-architecture-refactor`
- 前置依赖：`11-20-team-plugin-server-gating`（Phase 1 完成后启动）
- 阶段：Phase 2（核心主线 · P1）

## Goal

围绕「生产 Team Server 默认屏蔽插件 + Windows 桌面 EXE 内嵌团队网页」主线，在 `trellis-board-client.exe` 内建立按账号隔离的**桌面本机插件宿主**，用于托管 6 大内置插件（`witops-core`、`scenario-copilot`、`jenkins-ops`、`accounts-core`、`acp-dispatch`、`a2a-intake`）及用户目录私有插件（如 `witops-workbench`）：

1. **纯浏览器天然隔离，桌面 EXE 专属可见**：纯浏览器访问远程 Team Board 时完全看不到任何本机插件及入口；仅在 `trellis-board-client.exe` 内通过 `window.__TAURI__` 且经同源校验后呈现本机插件管理页与插件面板。
2. **同一 EXE 不同账号严格隔离**：不同用户在同一个 EXE 中登录不同服务器或不同账号时，本机插件的配置、运行日志、SQLite Store、以及 DPAPI 加密凭据按 `(serverHash, userId)` 彻底隔离；退出或切号立即停止上一个账号的插件进程。
3. **本机工作区闭环**：本机插件自动读取当前账号已批准关联的 `localAssociations`（提供真实本地 `repoPath` 与分支）；插件创建或修改 `.trellis/tasks/**` 后由现有 Rust `TaskSync` 自动监听并通过 CAS 同步至 Team Server。

## Confirmed Facts（仓库实证）

- `packages/desktop/README.md` 与 `packages/desktop/src-tauri/src/runtime_commands.rs` 已通过运行环境门保证每台安装客户端的电脑具备 Node.js ≥ 18.17、Python ≥ 3.9 与 Trellis CLI。
- `packages/desktop/src-tauri/src/main.rs:82-98` 的 `ensure_board_caller` 校验远程 WebView 当前 origin 与本次登录的 `board_url` 同源，只放行 `packages/desktop/src-tauri/capabilities/board-local-association.json` 中的白名单命令。
- `packages/desktop/src-tauri/src/agent_service.rs` 维护当前账号设备的 `localAssociations`（approved `taskSpaceId <-> repoPath <-> branchName` 映射）及 Windows DPAPI 凭据封装（`packages/desktop/src-tauri/src/agent/credential.rs`）。
- `packages/web/src/pages/board/BoardPage.tsx:101-103` 已以 `isTauri = Boolean(desktopInvoke)` 区分桌面 EXE 与浏览器；`packages/web/src/features/plugins/PluginPanel.tsx:64-148` 使用标准 `postMessage` 桥与沙箱 iframe 交互。

## Requirements

### R1 随绿色包分发的本机插件宿主与懒启动生命周期
- 在 `packages/desktop/src-tauri/` 新增本机插件宿主管理器：
  - **按需懒启动**：当当前 `(serverHash, userId)` 未启用任何本机插件时，**不拉起额外 Node 子进程**，保持客户端零闲置进程特征；启用至少一个插件后，复用运行环境门已探测/安装的 `node.exe` 启动最小本机插件宿主。
  - **进程生命周期联动**：在退出登录、托盘退出、切号重登（`clear_desktop_session`）时立即终止旧账号插件子进程树；异常崩溃同样纳入树清理。
  - **双源目录覆盖**：延续先扫描用户目录 `%LOCALAPPDATA%\TrellisBoard\plugins\<id>\`（允许放 `witops-workbench` 等私有插件并覆盖内置插件），再回退随桌面安装包/绿色包分发的内置插件目录（包含 6 大内置插件）。
  - **绿色包打包更新**：更新 `packages/desktop/src-tauri/tauri.conf.json` 与 `packages/desktop/package-portable.ps1`，随客户端打包最小宿主脚本与精简后的内置插件目录（剔除 `test/` 等开发测试目录），纳入 `SHA256SUMS.txt` 与自动更新流程，不额外内嵌 Node.js 二进制。

### R2 多账号/多服务器隔离与本机安全边界
- 本机插件运行状态、配置与日志落在 `%LOCALAPPDATA%\TrellisBoard\data\desktop-plugins\<serverHash>\<userId>\`，内置 `plugins.json` 只存开关、顺序与极简覆盖。
- 敏感凭据与 secrets 密钥文件使用 Windows DPAPI（Entropy 绑定 `(serverHash, userId)`）按账号保护，绝不跨账号混用、绝不上传 Team Server。
- `a2a-intake` 等提供本地 HTTP 回调的插件，在桌面宿主的本地入口（若启用）默认只绑定 `127.0.0.1` 随机/指定本地端口且强制校验本地 bearer token，禁止监听 `0.0.0.0` 对局域网暴露。

### R3 同源校验 Tauri IPC 与 Web 双通道桥接
- Rust 新增受 `ensure_board_caller(&app, &window)` 同源保护的 Tauri 命令，登记到 `capabilities/board-local-association.json` 与 `permissions/desktop.toml`：
  - `desktop_plugins_list`
  - `desktop_plugin_set_enabled`
  - `desktop_plugin_reorder`
  - `desktop_plugin_logs`
  - `desktop_plugin_panels`
  - `desktop_plugin_request`
  - `desktop_plugin_asset`
- 前端 `BoardPage.tsx`：
  - 仅在 `isTauri === true` 时在导航显示「本机插件」管理入口（与单机版全局管理区分，纯浏览器完全不渲染），并调用 `desktopInvoke('desktop_plugin_panels')` 将本机面板与远程（如有）服务端面板合并。
  - `PluginPanel.tsx`：按 `panel.host === 'desktop'` 自动将 `trellis:request`、SSE/状态刷新与面板静态资源加载路由到 Tauri IPC，iframe 仍保持 `sandbox="allow-scripts allow-forms"` 隔离。

### R4 `localAssociations` 桥接项目与任务上下文
- 本机宿主向插件注入当前登录账号信息与 `trellis.projects`（来源：`localAssociations` 中 `status === 'approved'` 的仓库，包含真实本地 `repoPath`、`repositoryId`、`branchName`）及标准 `ctx.tasks`（基于 `packages/server/plugins/task-service.js` 操作本地关联仓库 `.trellis/tasks/**`）。
- 当关联仓库发生变化（新接入、切换分支、解绑）时实时刷新本机宿主的可用项目列表；插件写入任务后由 Rust `TaskSync` 自动监听并 CAS 上行至 Team Server。

## Acceptance Criteria

1. **浏览器不可见**：纯浏览器访问 Team Server 时，顶栏与视图无任何本机插件入口或本机面板，且不报错调用 `__TAURI__`。
2. **零闲置开销**：在 EXE 中未启用任何本机插件时，登录进入看板后不拉起常驻 Node 宿主子进程；启用任意本机插件后才拉起，全部停用后自动回收进程。
3. **双账号严格隔离**：同一台 Windows 电脑用同一个 EXE 先以账号 A 登录并启用/配置插件，退出切账号 B 登录同一服务器：账号 A 插件子进程已关闭，账号 B 看到独立的空白/默认插件状态，无法读取账号 A 的 store、日志或 DPAPI 凭据。
4. **同源防线**：非当前登录 `board_url` 来源页面的 IPC 调用全部被 `ensure_board_caller` 拒绝。
5. **本地任务同步闭环**：本机插件通过 `trellis.projects` 正确列出当前账号关联的本地仓库并在该仓库写入任务后，触发 Rust `TaskSync` 将任务同步到 Team Server 看板。
6. **质量门与文档**：`cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml`、`yarn test`、`yarn --cwd packages/web lint`、`yarn --cwd packages/web build` 全绿，同步更新 `packages/desktop/README.md` 与 `plugins/README.md`；Windows 绿色包完成实机验证。

## Out of Scope

- 不在中心 Team Server 上代理或替用户运行任何本机插件。
- 不对 6 大内置插件 `plugin.json` 做字段精简与零配置改造（由 Phase 3 `11-20-desktop-plugins-zero-config` 专项完成，本任务先保证宿主能力与代表链路跑通）。
