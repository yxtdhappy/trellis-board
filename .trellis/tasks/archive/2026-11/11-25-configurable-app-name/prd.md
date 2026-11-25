# 应用与页面名称支持环境变量配置

## Goal

支持通过 `.env` / 环境变量 `TRELLIS_BOARD_APP_NAME` 配置应用名称与页面显示名称，并将前后端及桌面端的默认展示名称由 `Trellis Board` 统一调整为 `Weint Spec Board`，同时保持既有底层技术标识（二进制文件名、本地数据目录、更新包名、深链协议与 npm 包名）兼容。

## Confirmed Facts & Scope Baseline

- **环境配置入口**：
  - 根目录 [`.env`](.env) 与 [`.env.example`](.env.example) 管理运行时默认变量，[`scripts/lib/env-schema.mjs`](scripts/lib/env-schema.mjs) 定义 CLI/env schema（供 `scripts/dev.mjs`、`scripts/start.mjs`、`scripts/build.mjs`、`scripts/test.mjs` 使用）。
  - [`packages/server/index.js`](packages/server/index.js#L1) 通过 `env-bootstrap.js` 在入口最先加载 `.env`，[`packages/server/config.js`](packages/server/config.js#L194-L220) 的 `parseTeamConfig(env)` 集中解析 `TRELLIS_BOARD_*` 配置。
- **服务端与 HTML / Runtime 分发**：
  - [`packages/server/team/http/context.js`](packages/server/team/http/context.js#L24-L62) 的 `runtimePayload(actor)` 对已登录与未登录请求均返回 `/api/runtime`。
  - [`packages/server/team/http/common.js`](packages/server/team/http/common.js#L355-L404) 的 `serveStatic` 已支持在运行时通过 `transformHtml`（`rewriteHtmlForBasePath`）以 `no-store` 策略重写 `.html` 响应并注入 `<meta>` 标签。
- **Web 多页入口与组件**：
  - 入口 HTML：[`packages/web/index.html`](packages/web/index.html)、[`packages/web/admin.html`](packages/web/admin.html)、[`packages/web/login.html`](packages/web/login.html)、[`packages/web/share.html`](packages/web/share.html)、[`packages/web/desktop/index.html`](packages/web/desktop/index.html) 当前硬编码 `Trellis Board`。
  - React 页面：[`BoardPage.tsx`](packages/web/src/pages/board/BoardPage.tsx#L92) 默认 `useState('Trellis Board')` 并读取 `client_identity`；[`AdminPage.tsx`](packages/web/src/pages/admin/AdminPage.tsx#L117-L122)、[`LoginPage.tsx`](packages/web/src/pages/login/LoginPage.tsx#L90-L156) 与 [`LoginApp.tsx`](packages/web/src/desktop/LoginApp.tsx#L210) 硬编码 `Trellis Board`。
- **桌面客户端（Tauri）**：
  - [`packages/desktop/src-tauri/tauri.conf.json`](packages/desktop/src-tauri/tauri.conf.json#L3) 当前 `productName: "Trellis Board"`。
  - [`main.rs`](packages/desktop/src-tauri/src/main.rs#L201-L207)、[`main.rs`](packages/desktop/src-tauri/src/main.rs#L1009)、[`tray.rs`](packages/desktop/src-tauri/src/tray.rs#L52)、[`update.rs`](packages/desktop/src-tauri/src/update.rs#L393)、[`agent_service.rs`](packages/desktop/src-tauri/src/agent_service.rs#L670) 与 [`package-portable.ps1`](packages/desktop/package-portable.ps1#L78) 硬编码 `Trellis Board`。
  - 现有静态与单元测试约束：[`packages/desktop/test/desktop-ui-build.test.js`](packages/desktop/test/desktop-ui-build.test.js#L187)、[`packages/desktop/src-tauri/src/main/tests.rs`](packages/desktop/src-tauri/src/main/tests.rs#L71-L76)、[`packages/desktop/src-tauri/src/agent_service/tests.rs`](packages/desktop/src-tauri/src/agent_service/tests.rs#L103-L113)。

## Requirements

### R1. 环境变量定义与默认名称

- 新增环境变量 `TRELLIS_BOARD_APP_NAME`，默认值为 `Weint Spec Board`。
- 纳入 [`scripts/lib/env-schema.mjs`](scripts/lib/env-schema.mjs)（`scopes: ['dev', 'start', 'build']`，支持 `--app-name=<value>`），并在 `scripts/dev.mjs`、`scripts/start.mjs`、`scripts/build.mjs` 环境摘要中体现。
- 在 [`.env.example`](.env.example) 与 [`.env`](.env) 中补充 `TRELLIS_BOARD_APP_NAME` 说明与默认配置；当未设置或仅为空白字符时回退 `Weint Spec Board`；包含控制字符或超长（> 80 字符）时在服务端配置解析中报错（与用户/设备名边界风格一致）。

### R2. 服务端运行时下发与 HTML 动态重写

- `parseTeamConfig(env)` 解析并导出 `appName`（默认 `Weint Spec Board`）。
- `GET /api/runtime`（以及 `/api/auth/me`）在已登录与未登录响应中均返回 `appName`。
- 服务端 `serveStatic` 对 `index.html`、`admin.html`、`login.html`、`share.html` 的响应在运行时注入 `<meta name="trellis-app-name" content="..." />`（严格 HTML 转义），并同步替换 `<title>`、`<meta name="description">` 及 `share.html` 中的客户端名称展示文本为当前配置的 `appName`（无需因为修改 `.env` 而重新构建前端产物）。
- Vite 开发模式（`packages/web/vite.config.ts` / `vite.desktop.config.ts`）读取 `TRELLIS_BOARD_APP_NAME`（默认 `Weint Spec Board`），使本地 `yarn dev` 下的 HTML 标题与桌面开发页同样生效。

### R3. Web 页面统一读取配置名称

- 静态 HTML 源文件（`packages/web/index.html`、`admin.html`、`login.html`、`share.html`、`desktop/index.html`）的默认展示名称改为 `Weint Spec Board`。
- 新增/复用共享前端读取辅助逻辑（与 `readBasePath` 对齐，读取 `<meta name="trellis-app-name">` 并支持 `runtime.appName` 兜底，默认 `Weint Spec Board`），并同步更新 `document.title`（Board、Admin、Login 页面按各自页面标题格式更新）。
- [`BoardPage.tsx`](packages/web/src/pages/board/BoardPage.tsx)、[`AdminPage.tsx`](packages/web/src/pages/admin/AdminPage.tsx)、[`LoginPage.tsx`](packages/web/src/pages/login/LoginPage.tsx) 顶栏/品牌区、`aria-label` 与 [`LoginApp.tsx`](packages/web/src/desktop/LoginApp.tsx) 提示文案均改为读取应用名称（默认 `Weint Spec Board`）。

### R4. 桌面客户端名称支持环境变量与服务端联动

- [`tauri.conf.json`](packages/desktop/src-tauri/tauri.conf.json) 的 `productName` 默认改为 `"Weint Spec Board"`。
- 桌面端 Rust 侧统一通过品牌名解析函数获取展示名称：
  - **构建期环境变量**：`option_env!("TRELLIS_BOARD_APP_NAME")`（配合 `build.rs` 的 `cargo:rerun-if-env-changed=TRELLIS_BOARD_APP_NAME`）。
  - **运行期环境变量**：`std::env::var("TRELLIS_BOARD_APP_NAME")`（方便测试与本地运行覆盖）。
  - **回退优先级**：运行时 `TRELLIS_BOARD_APP_NAME` > 构建期 `TRELLIS_BOARD_APP_NAME` > `app.config().product_name` > 默认 `"Weint Spec Board"`（空白值自动跳过）。
- 覆盖桌面端所有展示面：
  - 主窗口标题（`build_main_window`）与 `client_identity` 返回的 `name`。
  - 托盘 tooltip（[`tray.rs`](packages/desktop/src-tauri/src/tray.rs)）。
  - 客户端自动更新通知标题（[`update.rs`](packages/desktop/src-tauri/src/update.rs)：`<appName> 有新版本`）与默认同步通知标题（[`agent_service.rs`](packages/desktop/src-tauri/src/agent_service.rs)：`<appName> 有新的同步事件`）。
  - [`packages/desktop/package-portable.ps1`](packages/desktop/package-portable.ps1)：支持读取 `$env:TRELLIS_BOARD_APP_NAME`（默认 `Weint Spec Board`）用于 `使用说明.txt` 展示标题与 `latest.json` 默认 `notes`。
  - 桌面本地登录页 `app_status` 也可返回当前客户端 `appName`，供 `LoginApp.tsx` 与 `desktop/index.html` 在登录前展示统一名称。
- **连接服务端后的联动优先级**：桌面端连接 Team 服务端进入远程 Board 后，若服务端 `/api/runtime`（或页面 `<meta name="trellis-app-name">`）显式返回了非空 `appName`，Board 顶栏与页面标题优先跟随服务端配置；仅当服务端未下发（如连接旧版服务端）时回退使用 `client_identity().name`。同时可在登录/导航进入 Board 或取得服务端名称后按需保持一致体验（至少 Web 视图顶栏与 `document.title` 严格遵循服务端 > 客户端 > 默认 `Weint Spec Board`）。

## Out of Scope

- 不更改底层技术标识与持久化路径：
  - `packages/desktop/src-tauri/Cargo.toml` 的 package/bin 名称（`trellis-board-client.exe`）与 `tauri.conf.json` 的 `identifier`（`com.trellisboard.client`）。
  - `packages/desktop/src-tauri/src/config.rs` 与 `packages/server/config.js` 中的用户数据目录名 `%LOCALAPPDATA%\TrellisBoard`（确保老用户凭据、SQLite 数据库与自动更新不中断）。
  - `packages/desktop/package-portable.ps1` 的输出包名 `TrellisBoard_<version>_x64-portable.zip` 与内含 EXE 名 `trellis-board-client.exe`。
  - 深链协议 `spec-board://`。
  - npm workspace 包名（`@trellis-board/*`）、Git 仓库目录名、代码内部日志文案/测试 Git 用户名、历史文档（`docs/`、`design/*.pen`、`plugins/*/README.md`）。

## Acceptance Criteria

- [ ] 未配置 `TRELLIS_BOARD_APP_NAME` 或配置为空白时，服务端配置、所有 Web 入口页面（看板、登录、管理台、分享页）、桌面本地登录页、桌面窗口标题、托盘 tooltip、更新与同步通知默认均显示 `Weint Spec Board`。
- [ ] 在 `.env` 或进程环境变量中设置 `TRELLIS_BOARD_APP_NAME="Custom Board"` 并重启服务端后（无需重新 `yarn build`），访问 `/`、`login.html`、`admin.html`、`share.html` 的页面 `<title>`、`description`、品牌区域和 `GET /api/runtime` 均实时反映 `Custom Board`。
- [ ] 配置了 XSS 特殊字符（如 `<script>`、`"`、`&`）的 `TRELLIS_BOARD_APP_NAME` 时，HTML 注入经过安全转义，不破坏 `<meta>` 或 `<title>` 结构；控制字符或超长值被配置校验拒绝。
- [ ] 桌面客户端在独立运行时使用 `TRELLIS_BOARD_APP_NAME`（或默认 `Weint Spec Board`）展示窗口/托盘/通知/本地登录页名称；连接至配置了不同 `TRELLIS_BOARD_APP_NAME` 的 Team 服务端后，Board 顶栏与标题跟随服务端下发的名称；连接未下发 `appName` 的旧服务端时回退使用客户端 `client_identity().name`。
- [ ] `trellis-board-client.exe`、`TrellisBoard_<version>_x64-portable.zip`、`%LOCALAPPDATA%\TrellisBoard` 与 `spec-board://` 协议保持不变。
- [ ] `yarn test`、Web 类型检查与构建（`yarn build --target=all`）、桌面 Rust 单测（`cargo test`）及格式检查全部通过。
