# 子路径部署与 trustProxy 代码审计

## 1. `trustProxy` 现状

- `packages/server/config.js:188`：`parseTeamConfig()` 硬编码 `trustProxy: false`，无对应环境变量。
- `packages/server/team/http/routes/auth.js:33`：`POST /api/auth/login` 调用 `login(db, { ..., trustProxy: false, ... })` 硬编码 `false`，未读取 `config.trustProxy`。
- `packages/server/team/http/routes/agent.js:34`：`POST /api/agent/enroll` 调用 `clientIp(request, false)` 硬编码 `false`，未读取 `config.trustProxy`。
- `packages/server/team/auth.js:307-357`：`clientIp(request, trustProxy)` 在 `trustProxy=true` 时读取 `x-forwarded-for` 首个 IP，否则使用 `request.socket.remoteAddress`；`login()` 以该 IP 执行 15 分钟内 `LOGIN_MAX_FAILURES = 5` 限流并写入 `user_session.ip`。
- `packages/server/team/http/common.js:95-102`：`requestProtocol(request)` 当前总是读取 `x-forwarded-proto`（不依赖 `trustProxy`）。
- 现有测试：`packages/server/test/` 多个测试夹具在 `config` 中显式传入 `trustProxy: false`。

## 2. 服务端 (`packages/server`) 子路径影响面

- **配置入口**：`packages/server/config.js`、`scripts/lib/env-schema.mjs`、`.env.example`、`scripts/start.mjs` 当前均无 base path 环境变量或 CLI 参数。
- **路由匹配**：`packages/server/team/http.js:117-195` 直接以 `url.pathname` 精确匹配 `/api/agent/*`、`/api/health`、`/plugin-ui/`、`/client-updates`、`/client-updates/`、`/api/*`，其余落入 `serveStatic`。
- **静态资源与 CSP**：
  - `packages/server/http-common.js:20-32` 的 `securityHeaders()` 设置了 `script-src 'self'` 与 `base-uri 'none'`——**不能**使用 `<base href>` 标签，也**不能**向 HTML 注入内联 `<script>`；若在 HTML 注入运行时配置，必须使用纯 HTML（如 `<meta name="trellis-base-path" content="...">`）或外部同源脚本。
  - `packages/server/http-common.js:99-164` 的 `serveStatic()` 将 `/` 映射为 `/index.html`。
- **会话 Cookie**：`packages/server/team/auth.js:548-569` 的 `sessionCookie()` / `clearSessionCookie()` 写死 `path: '/'`。
- **服务端下发路径**：
  - `packages/server/team/task-space-index.js:208` 返回 `downloadUrl: '/api/archive-files/...'`（归档附件下载 URL，由前端 `packages/web/src/api/board.ts:182` 直接 `fetch(file.downloadUrl)`）。
  - `packages/server/team/http/common.js:113-156` 的 `assertHost` 与 `assertJsonWrite` 校验 `Origin === requestHostOrigin(request)`（`Origin` 头本身只含 `scheme://host[:port]`，不含子路径）。

## 3. Web 前端 (`packages/web`) 子路径影响面

- **构建配置**：`packages/web/vite.config.ts`（Vite 8.3.5）未配置 `base`（默认 `/`）；包含动态 `import()`（`packages/web/src/desktop/live-control/DiffViewer.tsx:7`）。
- **HTML 入口**：`packages/web/index.html`、`login.html`、`admin.html` 硬编码 `/favicon.svg` 与 `/theme-init.js`。
- **API 与 SSE 请求**：全部以 `/api/...` 开头，例如：
  - `packages/web/src/api/request.ts`（统一 `requestJson` 入口）
  - `packages/web/src/api/board.ts`（含 `downloadArchiveFile` 直接 `fetch(file.downloadUrl)`）
  - `packages/web/src/hooks/useBoard.ts:250`（`new EventSource('/api/board/events')`）
  - `packages/web/src/api/health.ts`、`panels.ts`、`plugins.ts`、`team-plugins.ts`、`admin/*.ts`
- **页面跳转与链接**：
  - `packages/web/src/api/request.ts:93-98`：`redirectToLogin()` 硬编码 `/login.html`
  - `packages/web/src/lib/safe-return-to.js:9`：判断 `/login.html` 与 fallback `/`
  - `packages/web/src/pages/login/LoginPage.tsx`：`window.location.replace('/')`、`href="/"`
  - `packages/web/src/pages/board/BoardPage.tsx:174,356`：`/admin.html`、`/login.html`
  - `packages/web/src/pages/admin/AdminPage.tsx:115,126`：`href="/"`
  - `packages/web/src/components/layout/TopBar.tsx:160,164`：`href="/"`
  - `packages/web/src/hooks/useAdminConsole.ts:68,355`：`/`、`/login.html`

## 4. 桌面客户端 (`packages/desktop`) 子路径影响面

- `packages/desktop/src-tauri/src/navigation.rs:6-21`：`validate_board_url()` 拒绝非根路径（`Board 地址必须使用根路径`）。
- `packages/desktop/src-tauri/src/agent/protocol.rs:156-187`：`normalize_server_url()` 拒绝非根路径（`Agent 服务地址必须使用根路径`）。
- `packages/desktop/src-tauri/src/main.rs:191-207,232-244,1101-1112`：`server_root()` 丢弃 path；`cookie_for()` 写死 `path("/")`；`on_navigation` 仅拦截 `"/login" | "/login.html"`。
- `packages/desktop/src-tauri/src/update.rs:159-179`：`normalize_server_base()` 丢弃 path，直接拼 `/client-updates`。
- `packages/desktop/src-tauri/src/agent/device.rs:187,393,458,812`：写请求的 `Origin` 头当前直接发送 `client.server_url`；支持子路径时需确保 `Origin` 只发送 `scheme://host[:port]`，而请求 URL 拼接带子路径的 `server_url`。
