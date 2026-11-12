# PRD: 桌面客户端去除 Node 运行时，单 exe 交付

## Goal

Windows 桌面客户端不再携带 Node.js 运行时与 SEA sidecar，把所有同步/认证逻辑内嵌进主程序 `trellis-board-client.exe`；打包产物只有一个可双击运行的 exe。Trellis 项目初始化改为调用环境门（首次启动检查页）准备的 Node.js + `trellis` CLI：机器已有则复用，缺失则从 npmmirror 下载便携 Node 并把 CLI 装到客户端私有前缀。

## Background

当前架构：Tauri 主程序（Rust）通过 `tauri-plugin-shell` 启动 Node SEA 二进制 `trellis-agent.exe`，并用 `resources/trellis-runtime/`（`node.exe` + 完整 `node_modules`）支撑 `trellis init`。一次安装要带三个可执行体与上百 MB 的 npm 依赖树，首启、升级、杀软误报与病毒式目录扫描都是问题。

用户已定方案（两轮确认）：

1. 不需要 sidecar，在主 exe 内实现当前 sidecar 的全部功能。
2. 路线选 Rust 全量重写（约 12k 行 JS 逻辑）。
3. `trellis init` 不复刻实现：首次启动检查 Node.js 与 `trellis` 是否可用，缺失则经 npmmirror 安装，检查通过后写标志位；初始化直接调用该 CLI。
4. 首次启动需要独立的环境检查页：检查中 loading、缺失时提供安装按钮、安装分步 loading、成功后指引进入登录。

## Requirements

### R1 无 Node 运行时依赖

- 客户端 exe 内不包含、不释放、不依赖 `node.exe`；运行期不启动任何 Node 子进程。
- 认证、心跳、SSE 事件、任务快照同步、实时文件同步、冲突确认、git 检查、托盘控制全部由 Rust 在主进程内完成。
- Node 只在环境门（R5 的安装与版本校验）与项目初始化（R3）时使用，属于按需调用；同步/心跳/SSE/冲突处理等运行期链路不依赖 Node。

### R2 单一 exe 产物

- `tauri.conf.json` 去掉 `bundle.externalBin` 与 `bundle.resources`（`trellis-runtime/`）。
- 构建产物：`desktop/src-tauri/target/release/trellis-board-client.exe`，单独拷贝即可运行；NSIS 安装包仍是单文件 exe。
- 删除 `desktop/sidecar/**`（SEA 构建链、`build-sidecar.ps1`、`bundle.mjs`、`sea-entry.js`、`cli.js`、`parent-watchdog.js`、`trellis-runtime.js`、`trellis-pi-repair.mjs`、`desktop-device.js`、`desktop-association.js`、`main.js`）。
- `desktop/package-portable.ps1` 只打包 exe + 版本/校验文件，不再要求 `node.exe`/`node_modules`。

### R3 项目初始化使用环境门确定的 Node + Trellis CLI

- 初始化不自行安装运行时：直接用环境门（R5）解析出的 `node.exe` 与 `@mindfoldhq/trellis/bin/trellis.js` 执行 `init`。
- 命令：`<node.exe> <cli.js> init -y --skip-existing -u <developerId> <agent-tool-flags>`，cwd 为项目根，超时 210s，stdout/stderr 落客户端日志。
- 不依赖 `trellis`/`npm` 在 PATH 上，不修改用户 PATH；Python ≥3.9 缺失时给出明确中文错误（Trellis CLI 自身要求）。
- 环境门未通过时，项目的「初始化」入口返回明确错误而不是静默失败。

### R4 行为对齐（不改变服务端协议与前端契约）

- 服务端 `/api/agent/*` 路由、`AGENT_PROTOCOL_VERSION = 3`、39 个 `AGENT_ERROR_CODE`、控制事件类型（`assignment_warning`/`remote_overwrite`/`assignment_overridden`/`initial_sync_review`/`task_file_conflict`）与判定键保持不变。
- Tauri 命令名与返回结构保持不变：`app_status`、`desktop_login`、`inspect_local_project`、`initialize_pending_project`、`check_pending_project_push`、`preflight_pending_project`、`cancel_pending_project`、`associate_pending_project`、`list_local_associations`、`desktop_sidecar_status`、`live_control_*`；`desktop/ui/**` 与 `web/src/**` 无需改动。
- 本地数据目录与文件格式保持兼容：`<dataDir>/agent/config.json`（schema 2）、`credential.dpapi`（`WindowsDPAPI-CurrentUser` + base64）、cursor/pending/backup 目录结构。升级后不需要重新登录。
- 已有的实际运行行为全部保留：登录后按 `device_ready` 启动/停止同步、托盘「暂停同步/处理实时确认/日志/开机自启」、关联成功后触发首次全量拉取、账号切换清理 cursor/备份。

### R5 首次启动环境门（Node.js + Trellis CLI）

- 启动时依次检查两项：Node.js（≥ 18.17.0）与 Trellis CLI（`@mindfoldhq/trellis` ≥ 0.6.17）。
- Node.js 检查：先读 `client.json` 的 `node_runtime` 标志位（文件存在即通过），否则查 PATH 上的 `node.exe`；版本过低时提示「检测到 vX，版本过低」。
- Trellis CLI 检查：先读 `trellis_runtime` 标志位，否则查 `<dataDir>/npm-global/node_modules/@mindfoldhq/trellis`、`npm root -g` 默认全局目录、PATH 上的 `trellis.cmd`。
- 检查中显示 loading；任一项缺失或版本过低时给出提示与「下载并安装」按钮，并列出两项检查结果（已就绪 / 未检测到 / 版本过低）。
- 点击安装后逐步显示 loading：
  1. 下载 Node `node-v24.22.3-win-x64.zip`（npmmirror，36.0 MB，sha256 `e612af99f626ab415ea225af6bce5c971feb448cb5cae250bb1c3fa50c5f7d9f`，带百分比）；
  2. 校验哈希；3. 解压到 `<dataDir>/node`；4. 验证 `node.exe --version`；
  5. `npm install -g --prefix <dataDir>/npm-global @mindfoldhq/trellis@0.6.17`；6. 校验 CLI 版本。
- 已满足的检查项跳过对应步骤：已有系统 Node 则只装 Trellis CLI；两者皆备则不出现安装按钮。
- Node 采用**便携 ZIP**：不写系统 PATH、不需要 UAC、不覆盖用户已装 Node。
- 全部通过后写入 `client.json`（schema 3）的 `node_runtime`（仅下载安装时）与 `trellis_runtime`；后续启动命中标志位且文件存在时直接进入登录页（不启动子进程、不联网）。
- 安装成功后页面给出成功提示与「进入登录」入口；失败时展示失败阶段与原因，提供「重试」，且不写标志位、不残留 `.part`/`node.new`。

### R6 质量门

- 删除仅服务于 JS sidecar 的测试，新增 Rust 单测覆盖协议解析、路径防护、快照分类、SSE 分帧、存储原子写。
- `cargo test`（`desktop/src-tauri`）与 `npm test`（仓库根）均通过。

## Out of Scope

- 不改服务端 `server/**` 与 Web 看板 `web/**`。
- 不改 Board 业务功能、UI 交互与视觉。
- 不做 macOS/Linux 桌面打包。
- 不把仓库开发/测试链路的 Node 依赖去掉（`npm test`、`scripts/dev.mjs`、oxfmt 保持不变）。
- 不实现 Trellis CLI 的 Rust 复刻（模板下载、workspace bootstrap、zip 解压等只在 CLI 中使用的模块不移植）。

## Acceptance Criteria

1. `cargo tauri build` 后 `target/release/` 只有一个可执行文件 `trellis-board-client.exe`；安装包内不再出现 `trellis-agent.exe` 与 `trellis-runtime/`；双击裸 exe 可正常启动并显示主窗口。
2. 无 Node、无 trellis 的 Windows 机器上：首次启动进入环境页，安装 Node 与 Trellis CLI 后进入登录，关联项目并成功初始化；运行期任务管理器无 `trellis-agent.exe`。
3. 机器已有 Node ≥ 18.17 与 trellis ≥ 0.6.17：首次启动直接显示登录表单，不出现安装入口。
4. 运行期除环境门安装校验与项目初始化外，不出现 `node.exe` 子进程。
5. 旧版本升级：已有 `agent/config.json` 与 `credential.dpapi` 的机器启动后自动恢复同步，无需重新登录；控制窗四类确认流程与改造前一致。
6. `cargo test` 与 `npm test` 通过；`desktop/README.md` 与 `.trellis/spec/backend/desktop-sidecar-packaging.md` 已更新为 in-process 架构说明。
7. 环境页安装流程依次显示「检查 Node.js / 检查 Trellis CLI / 下载 Node.js / 安装 Trellis CLI / 校验」的 loading，成功后出现「进入登录」；`client.json` 同时出现 `node_runtime` 与 `trellis_runtime`；第二次启动直接显示登录表单。
8. 安装中断网或 sha256 不匹配：显示具体错误与「重试」，不写标志位，`<dataDir>` 下不残留 `.part`/`node.new`。
9. 系统 Node < 18.17 或 trellis 版本过低时，环境页分别标注「版本过低（检测到 vX）」，并只安装缺失项；系统既有安装未被修改。
10. 环境门完成后 `trellis init` 使用 `<dataDir>/node/node.exe` 与 `<dataDir>/npm-global/.../trellis.js`（日志可证），用户终端 `node`/`npm`/`trellis` 行为不变。

## Key Decisions

- 重写而非嵌入 Node：满足"零 Node 依赖 + 单 exe"，代价是约 12k 行逻辑的移植与并行维护期。
- 保留 Tauri 命令与 DTO 形状：前端零改动，降低回归面。
- 集成测试用真实服务端（本地启动 server）+ 真实 git 仓库，不引入 mock 框架。
- 版本号 0.2.0 → 0.3.0（打包形态变更为破坏性变更）。
- Node 安装用便携 ZIP（用户确认）：不触发 UAC、不改系统 PATH、不碰用户已装 Node，卸载即删目录；代价是只有本客户端能用这份运行时。
- Node 版本与校验固化：`v24.22.3`（LTS Krypton）+ 官方 SHASUMS256 哈希，下载后先校验再解压。
- Trellis CLI 先查用户机器已有的全局安装（`npm root -g`），缺失时才用 `npm install -g --prefix <dataDir>/npm-global ...` 装到客户端私有前缀：既是全局安装，又不改用户 `%APPDATA%\npm` 与 PATH。
- 标志位存 `client.json`（schema 2→3，新增 `node_runtime` 与 `trellis_runtime`），与 agent 的 `config.json` 互不影响；两项标志位均命中且文件存在时跳过检查。
- 环境门是初始化的前置：环境未就绪时「关联项目→初始化」返回明确错误，不静默降级。

## Risks

- 同步语义回归（初始同步 review、pending 批次重放、冲突备份）是最大风险；以逐模块移植 + 对等服务端集成测试收敛。
- npm 安装 Trellis CLI 可能因网络/镜像失败：需暴露 stderr 末 2 KiB 并允许重试；客户端私有前缀安装无需管理员权限。
- 环境门放大了首启路径：每个检查/安装步骤都必须有超时与可读失败文案，避免卡在 loading。
- `panic = "abort"` 下 agent 代码 panic 会终止整个客户端：实现约束——agent 路径禁止 `unwrap/expect`，全部返回 `Result`。
- 36 MB 下载与 npmmirror 可用性：下载失败必须可重试且不写标志位；企业网络需代理时给出"检查网络/代理"提示。
- 解压写盘被杀软扫描拦截：解压到临时目录后原子改名，失败时清理中间目录并提示重试。
