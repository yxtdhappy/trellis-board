# 技术设计：子路径部署与 trustProxy 默认开启

## 1. 架构总览与设计取舍

### 1.1 运行期子路径适配（而非构建期硬编码）
- **决策**：前端统一采用 Vite `base: './'` 构建一份通用产物；子路径前缀在**服务端运行期**由 `TRELLIS_BOARD_BASE_PATH` 决定，由服务端在返回 HTML 时注入 `<meta name="trellis-base-path" content="<basePath>" />` 并改写 HTML 静态资源路径。
- **为什么不选构建期 `VITE_BASE_PATH`**：
  - 同一份 `yarn build` 产物可直接跑在本地 `/`、测试环境 `/` 与线上 `/weint-spec-board`，无需针对不同子路径重编前端；
  - 避免 `.env` 写入 `/weint-spec-board` 后破坏本地 Vite dev 或单测对 `packages/server/public/` 的根路径预期。
- **CSP 兼容性**：现有 `securityHeaders()` 强制 `script-src 'self'` 和 `base-uri 'none'`，因此**不使用** `<base href>`，也**不注入**内联 `<script>`；仅注入 `<meta>` 标签与静态属性改写，完全兼容现有 CSP。

### 1.2 双模式反代兼容（透传前缀 + 剥离前缀）
在线上反代环境中，运维常见两种 Nginx 写法：
1. **透传前缀**：`location /weint-spec-board { proxy_pass http://127.0.0.1:4317; }`（Node 收到 `/weint-spec-board/...`）。
2. **剥离前缀**：`location /weint-spec-board/ { proxy_pass http://127.0.0.1:4317/; }`（Node 收到 `/...`）。

服务端配置 `basePath = '/weint-spec-board'` 时的请求路由策略：
1. `GET/HEAD` 且 `url.pathname === basePath`（精确匹配无尾斜杠入口）：返回 `302 Found`，`Location: ${basePath}/${url.search}`，附带安全头。
2. `url.pathname.startsWith(`${basePath}/`)`：剥离 `basePath` 得到 `internalPathname`（必以 `/` 开头），交由后续路由分发。
3. 其余路径（已被反代剥离前缀的 `/api/...`、`/`、`/login.html`、`/assets/...`、`/client-updates/...` 及容器健康探针 `/api/health`）：保持 `internalPathname = url.pathname` 直接进入分发。
4. 任何路径均按 `internalPathname` 匹配既有路由；若最终由 `serveStatic` 返回 `.html`，统一按 `config.basePath` 注入 `<meta>` 并改写静态资源前缀为 `${basePath}/...`。

> **安全边界**：`normalizeBasePath()` 禁止首段为 `api`、`client-updates`、`plugin-ui`、`assets`，因此透传前缀与已剥离内部路径永不冲突；同前缀兄弟路径（如 `/weint-spec-board-other`）不满足 `=== basePath` 或 `startsWith(basePath + '/')`，会落入静态目录返回 `404`。

---

## 2. 分层契约与关键改动

### 2.1 服务端配置与 CLI（`packages/server/config.js`、`scripts/`、`.env*`）
- **新增规范化函数 `normalizeBasePath(raw)`**（导出供 `config.js`、测试与 CLI 复用）：
  - `undefined | null | '' | whitespace | '/'` → `''`。
  - 去掉首尾空白后：若不以 `/` 开头则补前导 `/`；去掉末尾连续 `/`（若全为 `/` 则返回 `''`）。
  - 校验：拒绝 `//`、`\`、`?`、`#`、空白、控制字符、`%`、`"`、`'`、`<`、`>`、`&`；按 `/` 切分后每段必须匹配 `/^[A-Za-z0-9._~-]+$/` 且不得为 `.` 或 `..`；首段（小写）不得为 `api`、`client-updates`、`plugin-ui`、`assets`。不合法时抛出明确中文错误。
- **`parseTeamConfig(env = process.env)`**：
  - `basePath: normalizeBasePath(env.TRELLIS_BOARD_BASE_PATH)`（默认 `''`）。
  - `trustProxy: booleanSetting(env, 'TRELLIS_BOARD_TRUST_PROXY', true)`（默认 `true`）。
- **`.env` 与 `.env.example`**：
  - `.env` 增加：
    - `TRELLIS_BOARD_BASE_PATH=/weint-spec-board`
    - `TRELLIS_BOARD_TRUST_PROXY=true`
  - `.env.example` 补充两项注释模板。
- **CLI 与开发/测试隔离**：
  - `scripts/lib/env-schema.mjs` 新增两项（`scopes: ['dev', 'start']`）：
    - `TRELLIS_BOARD_BASE_PATH` → `--base-path`（`type: 'string'`）
    - `TRELLIS_BOARD_TRUST_PROXY` → `--trust-proxy` / `--no-trust-proxy`（`type: 'boolean'`, `trueValue: 'true'`, `falseValue: 'false'`）
  - `scripts/start.mjs` 在启动摘要中打印 `TRELLIS_BOARD_BASE_PATH`、`TRELLIS_BOARD_TRUST_PROXY`。
  - `scripts/dev.mjs` 与 `scripts/test.mjs`：若 `resolved.sources.TRELLIS_BOARD_BASE_PATH === '.env'`，将其重置为 `''`（`sources` 记为 `'default'`），确保本地 `yarn dev` 与 `yarn test` 默认运行在根路径 `/`；若用户通过 CLI `--base-path=...`、Shell 环境变量或 `--env-file` 显式传入，则保留生效。

### 2.2 服务端 HTTP、Cookie 与下载链接（`packages/server/`）
- **`packages/server/http-common.js`**：
  - `serveStatic()` 支持可选 `transformHtml?: (html: string) => string`。当 `extension === '.html'` 且提供 `transformHtml` 时，同步读取 UTF-8 文本，经 `transformHtml` 转换后转为 `Buffer`，按新长度发送 `content-length`（`HEAD` 直接 `end()`，`GET` 发送 Buffer）；未提供 `transformHtml` 或非 HTML 文件保持原有 `fs.createReadStream` 流式逻辑。
- **`packages/server/team/http/common.js`**：
  - 新增 `rewriteHtmlForBasePath(html, basePath)`：
    - 当 `!basePath` 时原样返回。
    - 将 HTML 中的相对/根静态资源属性（`href="./`、`src="./`、`href="/assets/`、`src="/assets/`、`href="/favicon.svg"`、`src="/theme-init.js"`）改写为 `${basePath}/...`。
    - 在 `</head>` 前插入 `<meta name="trellis-base-path" content="${basePath}" />`（若无 `</head>` 则插在文档开头，防御测试夹具中的极简 HTML）。
  - `serveStatic(request, response, url, publicDir, { basePath = '' } = {})` 透传 `transformHtml`（仅当 `basePath` 非空时传入）。
- **`packages/server/team/http.js`**：
  - `const basePath = normalizeBasePath(config.basePath)`（在 `createRequestHandler` 顶部计算一次）。
  - 在 `dispatch()` 解析 `url` 后：
    - 若 `basePath && url.pathname === basePath && (request.method === 'GET' || request.method === 'HEAD')`：返回 `302` 重定向至 `${basePath}/${url.search}`，附 `...securityHeaders()`、`location`。
    - 若 `basePath && url.pathname.startsWith(`${basePath}/`)`：构造新的 `routeUrl`（保持同一 origin/search，仅 `pathname = url.pathname.slice(basePath.length)`），后续路由统一使用 `routeUrl`。
  - 启动日志 `url` 追加 `basePath` 便于运维核对。
- **`packages/server/team/auth.js` 与路由**：
  - `sessionCookie(token, config)` 与 `clearSessionCookie(config)` 新增 `path: config.cookiePath || '/'`。
  - `packages/server/team/http/routes/auth.js`：
    - `login()` 传入 `trustProxy: Boolean(config.trustProxy)`。
    - `sessionCookie` / `clearSessionCookie` 传入 `cookiePath: config.basePath || '/'`。
  - `packages/server/team/http/routes/agent.js`：
    - `POST /api/agent/enroll` 传入 `ip: clientIp(request, Boolean(config.trustProxy))`。
- **`packages/server/team/task-space-index.js`**：
  - `createTaskSpaceIndex` 接收可选 `basePath = ''`（由 `packages/server/team/http.js` 传入 `normalizeBasePath(config.basePath)`）。
  - 第 208 行 `downloadUrl` 改为 `${basePath}/api/archive-files/${encodeURIComponent(row.id)}?taskSpaceId=${encodeURIComponent(taskSpaceId)}`。

### 2.3 Web 前端（`packages/web/`）
- **构建与 HTML 入口**：
  - `packages/web/vite.config.ts` 增加 `base: './'`。
  - `packages/web/{index,login,admin}.html` 将 `/favicon.svg` 与 `/theme-init.js` 改为 `./favicon.svg`、`./theme-init.js`。
- **公共纯模块 `packages/web/src/lib/base-path.js` + `.d.ts`**：
  - `normalizeBasePath(value)`：与服务端一致的轻量归一化（无尾 `/`、空串代表 `/`）。
  - `readBasePath(doc = globalThis.document)`：读取 `doc?.querySelector?.('meta[name="trellis-base-path"]')?.getAttribute('content')`，经 `normalizeBasePath` 返回。
  - `withBasePath(path, basePath = readBasePath())`：
    - 完整协议 URL（`/^[a-zA-Z][a-zA-Z0-9+.-]*:/`）或非 `/` 开头路径原样返回；
    - `!basePath` 时原样返回；
    - `path === '/'` → `${basePath}/`；
    - 已包含 `${basePath}` 边界（`path === basePath` 或以 `${basePath}/`、`?`、`#` 紧随其后）→ 原样返回（幂等）；
    - 其余 `/` 开头路径 → `${basePath}${path}`。
  - `stripBasePath(pathname, basePath = readBasePath())`：边界剥离。
  - `appOriginWithBase(loc = globalThis.window?.location, basePath = readBasePath())`：`${loc?.origin || ''}${basePath}`。
- **调用点接入**：
  - `packages/web/src/api/request.ts`：`requestJson` 使用 `fetch(withBasePath(url), ...)`；`redirectToLogin()` 使用 `withBasePath('/login.html')`。
  - `packages/web/src/api/board.ts`：`downloadArchiveFile` 使用 `fetch(withBasePath(file.downloadUrl), ...)`。
  - `packages/web/src/hooks/useBoard.ts`：`new EventSource(withBasePath('/api/board/events'))`。
  - `packages/web/src/features/plugins/PluginPanel.tsx`：非 desktop 面板的 `base`、`events` source 与 `panel.src` 统一经 `withBasePath()`。
  - `packages/web/src/lib/safe-return-to.js`（及 `.d.ts`）：接受可选 `basePath = readBasePath()`；默认 `fallback = withBasePath('/', basePath)`；当 `basePath` 非空时要求 `target.pathname === basePath || target.pathname.startsWith(`${basePath}/`)`；禁止返回 `<basePath>/login` 或 `<basePath>/login.html`。
  - `LoginPage.tsx`、`BoardPage.tsx`、`AdminPage.tsx`、`TopBar.tsx`、`useAdminConsole.ts`：所有 `/`、`/login.html`、`/admin.html` 跳转与 `href` 改用 `withBasePath(...)`。
  - `DevicesTab.tsx`：`trellisboard://enroll?...&server=` 与 `trellis-agent.cmd pair --server ...` 改用 `appOriginWithBase()`。

### 2.4 Windows 桌面客户端（`packages/desktop/src-tauri/`）
为遵守 `main.rs` 1200 行增量守卫，所有新增 URL/子路径解析工具集中放入 `navigation.rs` 与 `agent/protocol.rs`，`main.rs` 净减少行数：

- **`packages/desktop/src-tauri/src/navigation.rs`**：
  - 新增纯函数 `normalize_subpath(raw_path: &str) -> Result<String, String>`：
    - 去除末尾 `/`；若为空返回 `""`；
    - 校验不得包含 `//`、`\`、控制字符，任一段不得为 `.` 或 `..`，且段字符合法；不得直接以 `/login`、`/login.html`、`/admin.html`、`/index.html` 结尾（防止误把页面 URL 当服务根）。
  - `validate_board_url(input: &str) -> Result<Url, String>`：
    - 允许根路径或合法子路径；仍拒绝账号密码、query、fragment、非 http/https；
    - 返回规范化 `Url`（有子路径时路径设为 `<subpath>/`，根路径时为 `/`），便于 `window.navigate(board)` 一步落到带尾 `/` 的首页。
  - 新增导出辅助函数：
    - `board_base_path(board: &Url) -> String`：返回 `""` 或 `"/weint-spec-board"`（无尾 `/`）。
    - `board_server_url(board: &Url) -> String`：返回 `scheme://host[:port]` + `board_base_path(board)`（无尾 `/`；IPv6 保留方括号）。
    - `board_cookie_path(board: &Url) -> String`：无子路径返回 `"/"`，有子路径返回 `"/weint-spec-board"`。
    - `same_board_scope(candidate: &Url, board: &Url) -> bool`：先检查 `same_origin(candidate, board)`，若 `board_base_path` 非空则进一步要求 `candidate.path() == base || candidate.path().starts_with(&format!("{base}/"))`。
    - `is_board_login_path(candidate: &Url, board: &Url) -> bool`：`same_origin(candidate, board)` 且剥离 `board_base_path` 后的相对路径为 `"/login"` 或 `"/login.html"`。
  - `handle_navigation()` 改用 `same_board_scope(candidate, board)`，同域非当前子路径外链交由系统浏览器打开。
- **`packages/desktop/src-tauri/src/main.rs`**：
  - 删除冗长的私有 `server_root()`，改用 `navigation::board_server_url(board)`。
  - `ensure_board_caller()` 改用 `navigation::same_board_scope(&current, &board)`。
  - `cookie_for()` 的 `.path(...)` 改为 `navigation::board_cookie_path(board)`。
  - `on_navigation` 登录拦截改为 `navigation::is_board_login_path(candidate, board)`。
- **`packages/desktop/src-tauri/src/agent/protocol.rs`**：
  - `normalize_server_url(input: &str) -> AgentResult<String>`：允许根路径或合法子路径（复用同款段校验规则：拒绝 `//`、`.`/`..`、`\`、控制字符、credentials、query、fragment、non-http(s)），返回无尾 `/` 的 `scheme://host[:port][<subpath>]`（IPv6 正确加方括号）。
  - 新增 `server_origin(server_url: &str) -> AgentResult<String>`：提取纯 `scheme://host[:port]`（不含 path），专供 HTTP `Origin` 请求头使用。
- **`packages/desktop/src-tauri/src/agent/device.rs`**：
  - `SessionClient` 保存 `server_url`（含子路径，用于拼请求 URL）与 `origin`（经 `protocol::server_origin(&server_url)?`，用于 `Origin` 请求头）。
  - `login_request`、`logout_request`、`issue_desktop_enroll_token`（第 393、458、812 行）全部改为发送 `client.origin` 作为 `Origin` 头。
- **`packages/desktop/src-tauri/src/update.rs`**：
  - `normalize_server_base(raw: &str) -> Option<String>`：解析 URL 后保留合法子路径，若末段为 `login.html`、`admin.html`、`index.html` 或 `login` 则剥离末段，返回 `scheme://host[:port][<subpath>]/client-updates`。

---

## 3. 兼容性、风险与运维说明

- **向后兼容**：
  - 现有根路径服务端（未配 `TRELLIS_BOARD_BASE_PATH` 或设 `/`）：HTML、Cookie、API、SSE、桌面客户端行为 100% 不变。
  - 既有桌面客户端 `client.json` 中的根路径 `server_url` 无需迁移，直接兼容。
  - `plugin_host::server_hash(server_url)` 天然把 `http://host/a` 与 `http://host/b` 映射到不同目录，插件存储自动隔离。
- **反代配置注意点（写入 `docs/team-operations.md`）**：
  - Nginx 需透传 `Host $http_host`、`X-Forwarded-Proto $scheme`、`X-Forwarded-For $proxy_add_x_forwarded_for`。
  - SSE 路由（`<basePath>/api/(board|agent)/events`）必须关闭 `proxy_buffering` 并设长超时（`1800s`）。
  - 快照上传路由（`<basePath>/api/agent/task-spaces/...`）放宽 `client_max_body_size 96m`。
- **回滚方案**：
  - 运维若需紧急切回根路径部署，只需在启动环境变量设置 `TRELLIS_BOARD_BASE_PATH=/`（无需回滚代码或重编前端）；如需关闭代理 IP 信任，设置 `TRELLIS_BOARD_TRUST_PROXY=false`。
