# 支持子路径部署与 trustProxy 默认开启

## Goal

让 Trellis Board（Team 服务端、Web 网页端与 Windows 桌面客户端）全面支持部署在域名子路径（例如 `http://spec-board.weintdata.cn/weint-spec-board`）及反向代理之后，同时将服务端 `trustProxy` 默认值设为 `true`，避免内网多用户经反代登录时互相触发 IP 限流。

## Confirmed Facts & Constraints

- 线上 CI 部署后的访问地址为 `http://spec-board.weintdata.cn/weint-spec-board`（子路径 `/weint-spec-board`，入口地址可能不带末尾 `/`）。
- 仓库根 `.env` 已入库，CI 启动会直接读取其中的配置（如 `node_version`、`runtime`、`PORT`、初始管理员凭据）；用户已明确选择将 `TRELLIS_BOARD_BASE_PATH=/weint-spec-board` 直接写入仓库 `.env`，同时要求本地 `yarn dev`（以及自动化测试）默认保持根路径 `/` 不受干扰。
- 用户已明确要求 `trustProxy` 默认值为 `true`，且支持显式配置覆盖。
- 用户已明确要求 Windows 桌面客户端（Tauri EXE + 内置 Rust Agent）一并纳入子路径支持范围。
- 安全边界约束（来自 `research/subpath-audit.md` 与项目 spec）：
  - HTTP 响应 CSP 固定为 `script-src 'self'` 与 `base-uri 'none'`（`packages/server/http-common.js:20-32`），禁止引入 `<base href>` 或内联 `<script>`。
  - 写请求 CSRF 校验要求 `Origin` 等于 `<X-Forwarded-Proto>://<Host>`（`packages/server/team/http/common.js:113-156`），HTTP `Origin` 头只包含 `scheme://host[:port]`，不含子路径。
  - 桌面端 `packages/desktop/src-tauri/src/main.rs` 当前已 1226 行，受 `.trellis/spec/desktop/tauri-commands/index.md` 1200 行增量守卫约束，不得在 `main.rs` 净增行数，新增子路径辅助逻辑需放在 `navigation.rs` 等轻量模块中。

## Requirements

### R1. `trustProxy` 默认开启且可配置
- `packages/server/config.js` 的 `parseTeamConfig()` 读取 `TRELLIS_BOARD_TRUST_PROXY`，未设置或留空时默认返回 `true`，显式传入 `false`/`0` 时为 `false`，非法值启动报错。
- `scripts/lib/env-schema.mjs` 与 `scripts/start.mjs` / `scripts/dev.mjs` 支持 `--trust-proxy` / `--no-trust-proxy` 参数，`.env.example` 与运维文档同步说明。
- `packages/server/team/http/routes/auth.js:33`（`POST /api/auth/login`）与 `packages/server/team/http/routes/agent.js:34`（`POST /api/agent/enroll`）改用 `Boolean(config.trustProxy)`，不再硬编码 `false`。

### R2. 服务端支持运行时可配置子路径（`TRELLIS_BOARD_BASE_PATH`）
- `parseTeamConfig()` 读取并校验 `TRELLIS_BOARD_BASE_PATH`：未设置、留空或 `/` 归一化为空串 `""`（根路径模式，保持完全向后兼容）；非空值归一化为前导 `/`、无尾 `/` 的合法路径（如 `/weint-spec-board`）；拒绝含 `..`、`.`、`//`、`\`、`?`、`#`、空白、控制字符、HTML 特殊字符或与内部保留前缀（`/api`、`/client-updates`、`/plugin-ui`、`/assets`）冲突的值。
- 仓库根 `.env` 写入 `TRELLIS_BOARD_BASE_PATH=/weint-spec-board` 供 CI 开箱生效；`.env.example`、`scripts/lib/env-schema.mjs`、`scripts/start.mjs` 同步声明 `--base-path`；`scripts/dev.mjs` 与 `scripts/test.mjs` 在 `TRELLIS_BOARD_BASE_PATH` 仅来自仓库 `.env` 时默认重置为根路径 `/`，显式通过 CLI 或 Shell 环境变量传入时仍生效。
- 服务端 HTTP 路由（`packages/server/team/http.js`）配置非空 `basePath` 时同时兼容两类反代转发：
  - **透传前缀**：`GET/HEAD <basePath>`（无尾 `/`）返回 `302` 重定向至 `<basePath>/`（保留查询串）；`<basePath>/*` 剥离前缀后进入既有 API / SSE / `client-updates` / `plugin-ui` / 静态资源分发。
  - **剥离前缀**：已由反代剥离为 `/*` 的请求直接进入既有分发。
- 服务端静态 HTML 响应在 `basePath` 非空时保持 CSP 安全，向 `<head>` 注入 `<meta name="trellis-base-path" content="<basePath>" />`，并将 HTML 内的静态资源路径改写为 `<basePath>/...`（`Content-Length` 按改写后字节数计算，`HEAD` 不输出正文）；根路径模式保持零改写流式直出。
- 会话 Cookie（`packages/server/team/auth.js:548-569`）的 `Path` 设为 `basePath || '/'`（同时覆盖登录写入与退出清理），避免同域下多子路径实例互相覆盖 Cookie。
- 服务端生成的归档附件下载路径（`packages/server/team/task-space-index.js:208`）按当前 `basePath` 输出 `<basePath>/api/archive-files/...`（根路径时仍为 `/api/archive-files/...`）。

### R3. Web 前端全面适配运行时子路径
- `packages/web/vite.config.ts` 配置 `base: './'`，四页 HTML 入口（`index.html`、`login.html`、`admin.html`、`share.html`）的 `favicon.svg` 与 `theme-init.js` 改为相对路径 `./favicon.svg`、`./theme-init.js`，使同一份 `yarn build` 产物无需按路径重编即可适配 `/` 与任意子路径。
- 新增纯函数模块 `packages/web/src/lib/base-path.js`（及 `.d.ts`），从 `<meta name="trellis-base-path">` 读取当前子路径，提供 `normalizeBasePath`、`readBasePath`、`withBasePath`、`stripBasePath`、`appOriginWithBase`。
- 所有前端请求、SSE 与页面导航统一通过 `base-path` 拼接，不再写死域名根路径：
  - `requestJson`（`packages/web/src/api/request.ts`）统一对 `/api/...` 自动拼接 `basePath`，覆盖所有看板与管理接口；
  - `downloadArchiveFile`（`packages/web/src/api/board.ts:182`）幂等拼接 `basePath`；
  - `EventSource`（`packages/web/src/hooks/useBoard.ts:250`、`packages/web/src/features/plugins/PluginPanel.tsx:93,101`）拼接 `basePath`；
  - 登录/管理/首页跳转与链接（`request.ts`、`safe-return-to.js`、`LoginPage.tsx`、`BoardPage.tsx`、`AdminPage.tsx`、`TopBar.tsx`、`useAdminConsole.ts`）均基于 `basePath`，`safeReturnTo` 拒绝跳出当前 `basePath` 或回跳登录页；
  - 任务分享链接生成、中转页与桌面唤起比对（`share-link.ts`、`share.ts`、`ShareTaskButton.tsx`、`useShareLinkOpen.ts`）统一基于 `appOriginWithBase()`，分享链接输出 `<origin><basePath>/share.html?space=...&task=...`，中转页校验非法子路径与保留页尾段并向协议链接传递含子路径的服务基址，`useShareLinkOpen` 比对含子路径的完整服务基址（`isSameShareServer`），防止同域不同子路径互串；
  - 管理台设备配对链接与命令行示例（`packages/web/src/features/admin/DevicesTab.tsx:133,178`）展示包含 `basePath` 的完整服务端地址。

### R4. Windows 桌面客户端（Tauri + 内置 Rust Agent）支持子路径服务端
- URL 校验与规范化（`packages/desktop/src-tauri/src/navigation.rs`、`packages/desktop/src-tauri/src/agent/protocol.rs`）：允许合法 HTTP/HTTPS 子路径地址（如 `http://spec-board.weintdata.cn/weint-spec-board` 或带末尾 `/`），仍拒绝账号密码、查询参数、片段、非 HTTP(S)、空段 `//`、`.`/`..`、`\`、控制字符以及末尾保留页面文件名（含 `share.html`）。
- WebView 导航、作用域与安全边界（`navigation.rs`、`main.rs`）：
  - 登录后打开规范化子路径首页（如 `http://spec-board.weintdata.cn/weint-spec-board/`），`client.json` / `AgentConfig` 保存无尾 `/` 的 `server_url`（如 `http://spec-board.weintdata.cn/weint-spec-board`）。
  - 窗口导航白名单与 `ensure_board_caller` 校验收紧为同 origin 且位于当前 `board_url` 子路径作用域内，防止同域其他应用调用桌面特权命令。
  - 登录跳转拦截匹配 `<basePath>/login` 与 `<basePath>/login.html`；WebView 会话 Cookie 的写入与删除均使用与服务端一致的 `Path`（`<basePath>` 或 `/`）。
- 分享深度链接（`packages/desktop/src-tauri/src/share_link.rs`）：`share_link::parse` 对 `server` 参数经 `validate_board_url` 校验后使用 `navigation::board_server_url(&server)` 归一化（保留合法子路径、去掉默认端口与尾斜杠），不再截断为纯 origin。
- 内置 Agent HTTP/SSE 与登录会话（`agent/device.rs`、`agent/http.rs`）：
  - API 与 SSE 请求拼到 `server_url`（含子路径）之后；
  - 登录/登出/桌面令牌写请求的 `Origin` 头严格发送纯 origin（`scheme://host[:port]`，不含子路径），确保通过服务端 CSRF 校验。
- 运行时客户端自动更新源（`packages/desktop/src-tauri/src/update.rs`）：`normalize_server_base()` 保留合法子路径并拼接 `/client-updates`（同时兼容去除末尾 `/login.html`、`/admin.html`、`/index.html`、`/share.html`、`/login` 页面段，保持现有测试语义）。

### R5. 运维文档与测试覆盖
- 更新 `docs/team-operations.md`、`docs/client-auto-update.md`、`.env.example` 与 `README.md`（如有环境变量表），补充 `TRELLIS_BOARD_BASE_PATH`、`TRELLIS_BOARD_TRUST_PROXY` 及子路径 Nginx 反向代理配置示例。
- 为服务端、Web 工具模块、CLI 脚本与桌面 Rust 补齐自动化测试，验证根路径向后兼容与 `/weint-spec-board` 子路径端到端链路。

## Out of Scope

- 不修改认证协议、权限模型、数据库 Schema 或引入多实例高可用架构。
- 不启用 Team 服务端插件（服务端插件保持固定关闭）。
- 不引入前端路由框架（保持现有 4 个独立 HTML 入口）。

## Acceptance Criteria

1. **AC-1（`trustProxy` 默认与限流隔离）**：`parseTeamConfig({ TRELLIS_BOARD_MODE: 'team' }).trustProxy === true`；可通过 `TRELLIS_BOARD_TRUST_PROXY=false` 关闭；`trustProxy=true` 时经同一代理 IP、不同 `X-Forwarded-For` 的登录失败互不触发 `429`，同一 `X-Forwarded-For` 连续失败 5 次触发 `429`；`trustProxy=false` 时忽略 `X-Forwarded-For`；`POST /api/agent/enroll` 同样遵循 `config.trustProxy`。
2. **AC-2（服务端双模式子路径路由）**：当 `TRELLIS_BOARD_BASE_PATH=/weint-spec-board` 时：
   - `GET /weint-spec-board` 返回 `302` 且 `Location: /weint-spec-board/`（带 query 时保留 query）；
   - 通过透传路径（`/weint-spec-board/api/health`、`/weint-spec-board/`、`/weint-spec-board/login.html`、`/weint-spec-board/admin.html`、`/weint-spec-board/share.html?...`、`/weint-spec-board/assets/...`、`/weint-spec-board/client-updates/latest.json`）与反代剥离路径（`/api/health`、`/`、`/login.html`、`/share.html?...` 等）均可正常返回 `200`；
   - 返回的 HTML 包含 `<meta name="trellis-base-path" content="/weint-spec-board" />`、资源引用以 `/weint-spec-board/` 开头、不含内联 `<script>` 或 `<base>`、且保留完整 CSP 头；
   - 登录 `Set-Cookie` 与登出清理 Cookie 均带 `Path=/weint-spec-board`；归档附件 `downloadUrl` 以 `/weint-spec-board/api/archive-files/` 开头。
3. **AC-3（配置与开发/测试隔离）**：仓库 `.env` 包含 `TRELLIS_BOARD_BASE_PATH=/weint-spec-board`；`yarn start` 默认读取并打印该配置，支持 `--base-path=/` 覆盖回根路径；`yarn dev` 与 `yarn test` 默认不受仓库 `.env` 中该值影响（仍以 `/` 运行），显式传入 `--base-path` 时生效；非法 `TRELLIS_BOARD_BASE_PATH` 在启动时明确报错退出。
4. **AC-4（Web 前端路径拼接、分享链接与跳转安全）**：`packages/web/test/` 单测覆盖 `base-path.js`、`safeReturnTo` 与 `share-link.ts` 在根路径与 `/weint-spec-board` 下的全部边界（幂等拼接、防止跳出子路径、防止回跳登录页、保留 query/hash、`appOriginWithBase`、`normalizeShareServerUrl`、`isSameShareServer`、拒绝保留段及 `share.html`）；`yarn build` 产物在 `packages/server/public/{index,login,admin,share}.html` 中只使用相对资源路径 `./...` 且无内联脚本。
5. **AC-5（桌面客户端全链路子路径支持）**：Rust 单测全绿，覆盖：
   - `validate_board_url` / `normalize_server_url` 接受 `http://spec-board.weintdata.cn/weint-spec-board`（含/不含尾 `/`）并拒绝非法路径、凭证、查询、片段与 `share.html` 等页面文件尾段；
   - `same_board_scope` 放行 `/weint-spec-board/...` 并拒绝同域 `/other-app`；
   - 登录页拦截识别 `/weint-spec-board/login` 与 `/weint-spec-board/login.html`；
   - `cookie_for` 使用 `Path=/weint-spec-board`（根路径为 `/`）；
   - `share_link::parse` 保留合法子路径并归一化默认端口与尾斜杠（`navigation::board_server_url`），拒绝保留前缀及页面尾段；
   - `SessionClient` 发送写请求 URL 带 `/weint-spec-board/api/...` 而 `Origin` 头仅为 `http://spec-board.weintdata.cn`；
   - `update::normalize_server_base` 针对子路径返回 `http://spec-board.weintdata.cn/weint-spec-board/client-updates` 并保留原 `login.html` / `share.html` 归一化用例。
6. **AC-6（全量回归与代码规范）**：`yarn build`、`yarn build --target=desktop-ui`、`yarn test --scope=all`、`yarn test --scope=rust`、`oxfmt --check`（变更文件）、`oxlint`、`tsc -b --noEmit` 全绿；`packages/desktop/src-tauri/src/main.rs` 行数不超过修改前；`git ls-files --eol` 无新增 CRLF。
