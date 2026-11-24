# 实施计划：子路径部署与 trustProxy 默认开启

## 实施顺序

### Phase A：服务端配置、CLI 与 `trustProxy`（`packages/server`、`scripts/`、`.env*`）
- [x] A1. 在 `packages/server/config.js` 实现并导出 `normalizeBasePath()`；在 `parseTeamConfig()` 中接入 `TRELLIS_BOARD_BASE_PATH`（默认 `''`）与 `TRELLIS_BOARD_TRUST_PROXY`（默认 `true`）。
- [x] A2. 更新 `.env`（新增 `TRELLIS_BOARD_BASE_PATH=/weint-spec-board` 与 `TRELLIS_BOARD_TRUST_PROXY=true`）与 `.env.example`。
- [x] A3. 更新 `scripts/lib/env-schema.mjs`、`scripts/start.mjs`、`scripts/dev.mjs`、`scripts/test.mjs`：注册 `--base-path` 与 `--trust-proxy`，在 `start.mjs` 展示摘要，在 `dev.mjs` 与 `test.mjs` 中屏蔽仅来自仓库 `.env` 的 `TRELLIS_BOARD_BASE_PATH` 以保证本地开发和测试默认运行在 `/`；补充 `scripts/test/cli.test.js` 用例。

### Phase B：服务端 HTTP 路由、HTML 改写、Cookie 与归档下载链接（`packages/server`）
- [x] B1. 更新 `packages/server/http-common.js`：`serveStatic()` 支持可选 `transformHtml`（仅在传入且为 `.html` 时读取改写并重算 `content-length`）。
- [x] B2. 更新 `packages/server/team/http/common.js`：新增 `rewriteHtmlForBasePath(html, basePath)` 并接入 `serveStatic()`。
- [x] B3. 更新 `packages/server/team/auth.js`：`sessionCookie` / `clearSessionCookie` 支持 `cookiePath`（默认 `'/'`）。
- [x] B4. 更新 `packages/server/team/http/routes/auth.js` 与 `packages/server/team/http/routes/agent.js`：传入 `Boolean(config.trustProxy)` 与 `cookiePath: config.basePath || '/'`。
- [x] B5. 更新 `packages/server/team/task-space-index.js` 与 `packages/server/team/http.js`：
  - `http.js` 处理 `<basePath>` 无尾斜杠 `302` 跳转、`<basePath>/*` 前缀剥离与已剥离路径双模式兼容，向 `serveStatic` 与 `createTaskSpaceIndex` 传入 `basePath`，启动日志输出完整基址。
  - `task-space-index.js` 输出 `${basePath}/api/archive-files/...`。
- [x] B6. 新增/更新服务端测试：
  - `packages/server/test/team-subpath-and-proxy.test.js`（新建）：覆盖 `normalizeBasePath` 边界、`parseTeamConfig` 默认 `trustProxy=true` 及覆写、登录限流按 `X-Forwarded-For` 隔离与直连回退、Agent enroll IP、双模式子路径路由、无尾斜杠 `302`、HTML `<meta>` 与资源改写及 CSP 不变、Cookie `Path`、归档 `downloadUrl`。
  - 检查并更新 `packages/server/test/team-cookie.test.js`（补充自定义 `cookiePath` 用例）。

### Phase C：Web 前端运行时子路径适配（`packages/web`）
- [x] C1. 更新 `packages/web/vite.config.ts`（`base: './'`）与 `packages/web/{index,login,admin,share}.html`（`./favicon.svg`、`./theme-init.js`）。
- [x] C2. 新增 `packages/web/src/lib/base-path.js` 与 `packages/web/src/lib/base-path.d.ts`。
- [x] C3. 更新 `packages/web/src/lib/safe-return-to.js`、`safe-return-to.d.ts` 支持 `basePath` 作用域约束与登录页拦截；更新 `packages/web/src/lib/share-link.ts` 新增 `normalizeShareServerUrl` 与 `isSameShareServer`，并使 `parseSharePageParams` 保留合法子路径。
- [x] C4. 更新所有前端调用点：
  - `packages/web/src/api/request.ts`（`requestJson`、`redirectToLogin`）
  - `packages/web/src/api/board.ts`（`downloadArchiveFile`）
  - `packages/web/src/hooks/useBoard.ts`（`EventSource`）
  - `packages/web/src/features/plugins/PluginPanel.tsx`（远端插件请求、SSE 与 iframe `src`）
  - `packages/web/src/pages/login/LoginPage.tsx`
  - `packages/web/src/pages/board/BoardPage.tsx`
  - `packages/web/src/pages/admin/AdminPage.tsx`
  - `packages/web/src/components/layout/TopBar.tsx`
  - `packages/web/src/hooks/useAdminConsole.ts`
  - `packages/web/src/features/admin/DevicesTab.tsx`
  - `packages/web/src/share.ts`、`packages/web/src/features/board/ShareTaskButton.tsx`、`packages/web/src/features/board/useShareLinkOpen.ts`
- [x] C5. 新增 `packages/web/test/base-path.test.js`，并更新 `packages/web/test/share-link.test.js`、`packages/server/test/team-subpath-and-proxy.test.js`，覆盖 `base-path.js`、`safeReturnTo`、`share-link.ts` 与 `share.html` 在根路径与 `/weint-spec-board` 下的全部边界。

### Phase D：Windows 桌面客户端子路径支持（`packages/desktop/src-tauri`）
- [x] D1. 更新 `packages/desktop/src-tauri/src/navigation.rs` 与 `navigation/tests.rs`：实现 `normalize_subpath`、`validate_board_url`（支持子路径并拒绝 `share.html` 等页面结尾）、`board_base_path`、`board_server_url`、`board_cookie_path`、`same_board_scope`、`is_board_login_path`、`handle_navigation`。
- [x] D2. 更新 `packages/desktop/src-tauri/src/main.rs`（净减少行数，严守 ≤ 1200 行增量守卫）：移除本地 `server_root`，切换为调用 `navigation::*`。
- [x] D3. 更新 `packages/desktop/src-tauri/src/agent/protocol.rs` 与 `protocol/tests.rs`：`normalize_server_url` 支持合法子路径（拒绝 `share.html` 等页面结尾），新增 `server_origin`。
- [x] D4. 更新 `packages/desktop/src-tauri/src/agent/device.rs`（及相关 Rust 测试）：`SessionClient` 拆分 `server_url` 与 `origin`，写请求 `Origin` 头严格发送 `origin`。
- [x] D5. 更新 `packages/desktop/src-tauri/src/update.rs` 与 `update/tests.rs`：`normalize_server_base` 保留子路径并兼容去掉页面尾段（含 `login.html`、`share.html`）。
- [x] D6. 更新 `packages/desktop/src-tauri/src/share_link.rs`、`share_link/tests.rs` 与 `packages/desktop/test/desktop-ui-build.test.js`：`share_link::parse` 改用 `navigation::board_server_url(&server)` 保留合法子路径并归一化默认端口与尾斜杠。
- [x] D7. 新增 `navigation::raw_path_has_dot_segments`：`Url::parse` 会消解 `.`/`..` 段，`validate_board_url`、`protocol::normalize_server_url`、`update::normalize_server_base` 统一在解析前对原始输入检查，修复既有 `.`/`..` 拒绝断言实际失效的问题。

### Phase E：文档、全量构建与验收验证
- [x] E1. 更新 `docs/team-operations.md`、`docs/client-auto-update.md`、`README.md`（同步环境变量与子路径 Nginx 示例）。
- [x] E2. 格式化与静态检查：`oxfmt --check`（8 个变更 JS/TS/HTML 文件）、`rustfmt --edition 2021 --check`（3 个变更 `.rs` 文件）、`packages/web` `oxlint`（仅既有 warning，退出码 0）与 `tsc -b --noEmit` 均通过。
- [x] E3. 构建与全量测试：`yarn build`、`yarn build --target=desktop-ui`、`yarn test --scope=all`（868 passed / 0 failed / 5 skipped）、`cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml`（408 passed / 0 failed）全绿。
- [x] E4. 行数与行尾守卫检查：
  - 确认 `packages/desktop/src-tauri/src/main.rs` 为 1144 行（≤ 1200），变更 `.rs` 文件无内联 `^mod tests \{`；
  - 确认 `git ls-files --eol` 无 `i/crlf` 输出；
  - 检查 `packages/server/public/{index,login,admin,share}.html` 无根绝对 `/assets/` 引用且无内联 `<script>`。
- [x] E5. Phase 3.3 Spec 回写检查：同步更新 `.trellis/spec/backend/http-and-filesystem.md`、`.trellis/spec/backend/architecture-and-runtime.md`、`.trellis/spec/frontend/index.md` 与 `.trellis/spec/desktop/tauri-commands/index.md` 中涉及 `basePath` / `trustProxy` / `validate_board_url` / Cookie `Path` / 分享链接与 `share.html` 的契约说明。

### Phase F：真实反向代理 e2e（WSL nginx 1.18 + 真实桌面客户端）
- [x] F1. 透传模式（`proxy_pass http://127.0.0.1:4318;`）实测：`/weint-spec-board` → `302`，首页引用全为前缀绝对路径且 10 个资源 200，`/api/health` 200，登录 Cookie `Path=/weint-spec-board; HttpOnly; SameSite=Strict`，SSE 200 `text/event-stream` TTFB 0.207s（`proxy_buffering off`），匿名 SSE 401，前缀外 404，无 `Origin` 登录 403 `CSRF_REJECTED`，100 MiB → nginx 413 / 8 MiB → 200。
- [x] F2. 剥离前缀模式（`rewrite ^/weint-spec-board(.*)$ $1 break;` + 无 URI `proxy_pass`）实测：`302`、首页与资源 200、`/api/health` 200、`/api/auth/me` 200、SSE 200 TTFB 0.210s、Cookie 仍 `Path=/weint-spec-board`、`share.html` 200。
- [x] F3. trustProxy 实测：`login_attempt.ip` 记录 `x-forwarded-for` 首段（203.0.113.77 / 198.51.100.9，无头时 127.0.0.1），同 IP 第 6 次失败 429、换 IP 401；nginx 覆盖伪造的 `X-Forwarded-Proto`（经 http 代理无 `Secure`），直连带 `https` + `Host` 时 Cookie 带 `Secure`。
- [x] F4. 真实浏览器（Tabbit）：无斜杠入口 → `/login.html?returnTo=%2Fweint-spec-board%2F`，登录后 `/weint-spec-board/` 正常渲染，页面内 `EventSource` opened，`share.html` 无 broken resource。
- [x] F5. 真实桌面客户端（debug + WebView2 CDP）：`desktop_login` 子路径地址成功（`deviceReady: true`、`serverUrl` 保留子路径），webview 落到 `/weint-spec-board/`，页面内 `EventSource` opened，`/api/team/status` 与 `/api/tasks/query` 200，`document.cookie` 为空（HttpOnly）；`client.json` 持久化子路径；更新检查地址推导为 `/weint-spec-board/client-updates`，路由正确（新数据目录下 404 属预期）。
- [x] F6. e2e 暴露的编译缺陷修复：`cargo test` 未构建 `trellis-agent` bin，导致 `raw_path_has_dot_segments` 放在 `navigation.rs` 时 `cargo build` 报 `error[E0433]: cannot find 'navigation' in the crate root`。抽出 `packages/desktop/src-tauri/src/url_path.rs` 供两个目标共用（`main.rs` 与 `bin/trellis-agent.rs` 各自声明模块），修复后 `cargo build` exit 0、`cargo test` 408 passed / 0 failed。
- [x] F7. 报告归档：`.trellis/tasks/11-24-subpath-deploy-and-trust-proxy/e2e-report.md`（环境、两种模式逐项结果、trustProxy、浏览器与客户端证据、已知缺口：单实例 argv 未转成 deep link 事件，`main.rs` 的 single-instance 回调只 `focus_main_window`，与子路径无关，另行立项）。


## 高风险点与回滚点
- **风险 1**：仓库 `.env` 新增 `TRELLIS_BOARD_BASE_PATH=/weint-spec-board` 可能影响依赖根 `.env` 的脚本或测试。
  - **缓解**：`scripts/dev.mjs` 与 `scripts/test.mjs` 对来源为 `.env` 的该键做隔离清空；服务端默认单测通过显式 `env` 对象驱动 `parseTeamConfig`。
- **风险 2**：`packages/desktop/src-tauri/src/main.rs` 已有 1226 行。
  - **缓解**：所有新工具函数放在 `navigation.rs`，`main.rs` 只删减替换为短调用，确保只减不增。
- **风险 3**：桌面端登录时 `Origin` 头若带上子路径会被部分代理或严格校验拒绝，且 WebView2 删除 Cookie 必须匹配精确 `Path`。
  - **缓解**：`SessionClient` 单独保存纯 `origin`；`cookie_for` 统一使用 `board_cookie_path(board)`。
