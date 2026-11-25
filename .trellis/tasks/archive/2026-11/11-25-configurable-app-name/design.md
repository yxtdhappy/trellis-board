# Technical Design: 应用与页面名称支持环境变量配置

## Architecture & Boundaries

将展示名称拆分为两层，互不破坏兼容性：

1. **展示名称层（可配置，默认 `Weint Spec Board`）**：
   - 统一由环境变量 `TRELLIS_BOARD_APP_NAME` 控制（CLI 对应 `--app-name`）。
   - Web 与服务端：在 Node 服务端运行时解析 `.env` / 进程环境变量，并通过 HTML 重写 + `/api/runtime` 下发给所有前端页面。
   - 桌面端（Tauri）：构建期与运行期读取 `TRELLIS_BOARD_APP_NAME`，并把 `tauri.conf.json` 默认 `productName` 设为 `Weint Spec Board`。
2. **技术标识层（冻结不变）**：
   - 保留 `trellis-board-client.exe`、`TrellisBoard_<version>_x64-portable.zip`、`%LOCALAPPDATA%\TrellisBoard`、`com.trellisboard.client`、`spec-board://` 与 `@trellis-board/*`，防止自动更新、深链唤起与既有本地数据失效。

## Data Flow & Contracts

### 1. Env Schema & Server Config

- [`scripts/lib/env-schema.mjs`](scripts/lib/env-schema.mjs)：新增条目
  - `env: 'TRELLIS_BOARD_APP_NAME'`
  - `flag: 'app-name'`
  - `type: 'string'`
  - `scopes: ['dev', 'start', 'build']`
- [`packages/server/config.js`](packages/server/config.js)：
  - 导出常量 `DEFAULT_APP_NAME = 'Weint Spec Board'`。
  - 新增 `normalizeAppName(raw)`：
    - `null` / `undefined` / trim 后为空字符串 → 返回 `DEFAULT_APP_NAME`（`Weint Spec Board`）。
    - 若包含 ASCII 控制字符（`[\u0000-\u001f\u007f]`）或长度 > 80 字符 → 抛出明确错误 `TRELLIS_BOARD_APP_NAME 配置无效：...`。
    - 返回 trimmed 字符串。
  - `parseTeamConfig(env)` 新增字段 `appName: normalizeAppName(env.TRELLIS_BOARD_APP_NAME)`。

### 2. Server Runtime & HTML Rewriting

- [`packages/server/team/http/context.js`](packages/server/team/http/context.js)：
  - `runtimePayload(actor)` 在未登录和已登录分支中都返回 `appName: config.appName || DEFAULT_APP_NAME`。
- [`packages/server/team/http/common.js`](packages/server/team/http/common.js)：
  - 扩展现有 `rewriteHtmlForBasePath` 或并列组合 `rewriteHtmlForRuntime(html, { basePath, appName })`（保持 `rewriteHtmlForBasePath(html, basePath)` 导出签名向后兼容）：
    - 转义 `appName` 后注入 `<meta name="trellis-app-name" content="${escapeHtmlAttr(appName)}" />` 到 `</head>` 前（如已存在则跳过或更新）。
    - 若 `appName` 与构建产物默认占位不同（或统一做模板替换）：
      - 替换 `<title>...</title>` 中的默认品牌名（如 `Weint Spec Board` / 兼容旧产物 `Trellis Board`）。
      - 替换 `<meta name="description" content="..." />` 中的默认品牌名。
      - 替换 `share.html` 正文 `#opening` 与 `#hint` 中的默认品牌名（仅针对静态文本段，且对文本做 HTML 转义）。
  - `serveStatic(request, response, url, publicDir, { basePath = '', appName = DEFAULT_APP_NAME } = {})`：只要 `basePath` 或 `appName` 存在即执行 `transformHtml`（注意即便 `appName === DEFAULT_APP_NAME` 也注入 `<meta name="trellis-app-name">` 或当为默认值时同样保持一致，使得前端能区分“新服务端显式下发”与“旧服务端未下发”）。
- [`packages/server/team/http.js`](packages/server/team/http.js)：调用 `serveStatic` 时传入 `{ basePath, appName: config.appName }`。

### 3. Web Frontend & Vite Dev/Build

- **HTML 入口默认值**：将 `packages/web/{index,admin,login,share}.html` 与 `packages/web/desktop/index.html` 中的 `Trellis Board` 全部替换为 `Weint Spec Board`。
- **Vite 插件**（[`packages/web/vite.config.ts`](packages/web/vite.config.ts) 与 [`packages/web/vite.desktop.config.ts`](packages/web/vite.desktop.config.ts)）：
  - 在 `transformIndexHtml` 中读取 `process.env.TRELLIS_BOARD_APP_NAME`（trim 后非空则覆盖默认 `Weint Spec Board`），在 dev/build 阶段替换 HTML 中默认的 `Weint Spec Board` 并注入 `<meta name="trellis-app-name" content="..." />`，这样 `yarn dev`（直接由 Vite 托管 HTML）和 `desktop-ui` 构建也能立刻生效。
- **前端统一读取模块**（例如 `packages/web/src/lib/app-name.js` + `base-path` 风格一致，供 TS/JS 与 Node 单测复用）：
  - `DEFAULT_APP_NAME = 'Weint Spec Board'`
  - `normalizeAppName(value)`：非空白则返回 trim 后字符串，否则返回 `''`（由调用方决定是否回退默认）。
  - `readAppNameFromMeta(doc = globalThis.document)`：读取 `meta[name="trellis-app-name"]`。
  - `resolveAppName({ runtimeAppName, metaAppName, clientAppName })`：
    - 优先级：`runtimeAppName`（服务端运行时）> `metaAppName`（服务端注入 meta）> `clientAppName`（旧服务端兜底时桌面 `client_identity`）> `DEFAULT_APP_NAME`。
    - 说明：对于网页端，`runtimeAppName` 与 `metaAppName` 同源（均为服务端配置）；对于桌面端连接新版服务端时，`runtimeAppName` / `metaAppName` 存在且非空，因此自然覆盖 `clientAppName`；连接未下发 `appName` 的旧服务端时，`runtimeAppName` 与 `metaAppName` 均为空，自动回退 `clientAppName`！
- **页面消费点**：
  - [`BoardPage.tsx`](packages/web/src/pages/board/BoardPage.tsx)：初始品牌名由 `readAppNameFromMeta() || DEFAULT_APP_NAME` 起步；`runtime.appName` 到达后更新；`client_identity` 仅在服务端未显式提供 `appName`（即 `!runtime?.appName && !readAppNameFromMeta()`）时作为 `brandName` 回退，同时仍读取 `clientVersion`。同步更新 `document.title = brandName`。
  - [`AdminPage.tsx`](packages/web/src/pages/admin/AdminPage.tsx)：从 `useAdminConsole()`（`readRuntime` 解析 `appName?: string | null`）或 meta 获取 `brandName`，更新顶栏文字、`aria-label={`返回 ${brandName}`}` 及 `document.title = \`团队管理 · ${brandName}\``。
  - [`LoginPage.tsx`](packages/web/src/pages/login/LoginPage.tsx)：在 `/api/runtime` 响应或 meta 中读取 `brandName`，替换左右品牌区文本、`aria-label` 及 `document.title = \`登录 · ${brandName}\``。
  - [`packages/web/src/lib/team-normalize.js`](packages/web/src/lib/team-normalize.js) / [`packages/web/src/api/board.ts`](packages/web/src/api/board.ts) / [`packages/web/src/api/admin/types.ts`](packages/web/src/api/admin/types.ts) / [`packages/web/src/api/admin/readers.ts`](packages/web/src/api/admin/readers.ts)：补充可选字段 `appName`。
  - [`LoginApp.tsx`](packages/web/src/desktop/LoginApp.tsx)：`AppStatus` 增加可选 `appName?: string`（通过 Tauri `app_status` 返回，fallback 为 `readAppNameFromMeta() || DEFAULT_APP_NAME`），更新错误提示文案与 `document.title = \`${appName} 登录\``。

### 4. Desktop Client (Rust / Tauri / Packaging)

- [`packages/desktop/src-tauri/tauri.conf.json`](packages/desktop/src-tauri/tauri.conf.json)：`productName` 改为 `"Weint Spec Board"`。
- [`packages/desktop/src-tauri/build.rs`](packages/desktop/src-tauri/build.rs)：增加 `println!("cargo:rerun-if-env-changed=TRELLIS_BOARD_APP_NAME");`。
- **统一品牌解析函数**（放在 `main.rs` 或专用小 helper，并在 `tray.rs`、`update.rs`、`agent_service.rs` 复用，避免重复逻辑）：
  - `pub const DEFAULT_APP_NAME: &str = "Weint Spec Board";`
  - `pub const BUILD_APP_NAME: Option<&str> = option_env!("TRELLIS_BOARD_APP_NAME");`
  - `resolve_app_name(runtime_env: Option<&str>, build_env: Option<&str>, product_name: Option<&str>) -> String`：按 `runtime_env` -> `build_env` -> `product_name` -> `DEFAULT_APP_NAME` 取第一个非空白值。
  - `pub fn app_display_name(product_name: Option<&str>) -> String`：供 `main.rs`（`client_identity`、`app_status`、`build_main_window` `.title(...)`）、`tray.rs`（`.tooltip(...)`）、`update.rs`（`format!("{app_name} 有新版本")`）、`agent_service.rs`（`format!("{app_name} 有新的同步事件")`）统一调用。
  - 注：`update.rs` 和 `agent_service.rs` 的通知辅助函数接收 `app_name: &str`（或通过 `AppHandle` 读取 `app.config().product_name.as_deref()`），保证纯单元测试无需 `AppHandle` 也能测试。
- [`packages/desktop/package-portable.ps1`](packages/desktop/package-portable.ps1)：
  - 读取 `$appName = if ($env:TRELLIS_BOARD_APP_NAME -and $env:TRELLIS_BOARD_APP_NAME.Trim()) { $env:TRELLIS_BOARD_APP_NAME.Trim() } else { 'Weint Spec Board' }`。
  - `$Notes` 默认值改为 `"$appName $version"`，`使用说明.txt` 首行改为 `"$appName $version Windows x64 绿色版"`。
  - 保留 `$packageName = "TrellisBoard_${version}_x64-portable"`、`trellis-board-client.exe` 与 `%LOCALAPPDATA%\TrellisBoard\data`。

## Compatibility & Trade-offs

- **旧版服务端兼容**：当新版桌面端连接尚未升级的旧服务端（`/api/runtime` 无 `appName` 且 HTML 无 `trellis-app-name` meta）时，`resolveAppName` 自动回退桌面端 `client_identity().name`（默认 `Weint Spec Board` 或客户端构建时注入值），不会显示空白。
- **旧版桌面端连接新版服务端**：新版服务端仍提供新版静态页面，旧桌面端虽在本地登录页显示 `Trellis Board`，进入新版服务端 Board 页面后顶栏仍能显示服务端配置的 `appName`。
- **桌面原生窗口标题与 Web 标题同步**：Tauri `WebviewWindow` 打开远程页面时窗口标题初始为客户端 `app_display_name`；如果未来需要原生标题栏也随远程网页 `document.title` 动态改变，需检查 Tauri `on_document_title_changed` 是否默认同步或暂由网页 `document.title` 与顶栏体现。目前 Tauri 默认会根据需要或保留窗口标题为应用名，不影响页面内品牌展示与浏览器标签页标题。
- **HTML 替换方式的选择**：在 `serveStatic` 中仅针对已知占位字符串/标准 `<title>` 与 `<meta name="description">` 进行定点正则/替换并转义 HTML 属性与文本，避免引入重量级 HTML 解析器，也与现有 `rewriteHtmlForBasePath` 保持一致风格。

## Operational & Rollback

- 修改 `.env` 中的 `TRELLIS_BOARD_APP_NAME` 后重启 Node 服务端即可生效，无需重编前端。
- 如需恢复旧展示名称，只需在 `.env` 设置 `TRELLIS_BOARD_APP_NAME="Trellis Board"`（Web/服务端即时回退），代码层面改动集中在配置解析、HTML 重写、UI 品牌读取和 Rust `app_display_name`，回滚边界清晰。
