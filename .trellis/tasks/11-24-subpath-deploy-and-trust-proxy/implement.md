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
- [x] C1. 更新 `packages/web/vite.config.ts`（`base: './'`）与 `packages/web/{index,login,admin}.html`（`./favicon.svg`、`./theme-init.js`）。
- [x] C2. 新增 `packages/web/src/lib/base-path.js` 与 `packages/web/src/lib/base-path.d.ts`。
- [x] C3. 更新 `packages/web/src/lib/safe-return-to.js` 与 `safe-return-to.d.ts` 支持 `basePath` 作用域约束与登录页拦截。
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
- [x] C5. 新增 `packages/web/test/base-path.test.js`，覆盖 `base-path.js` 与 `safeReturnTo` 在根路径与 `/weint-spec-board` 下的全部边界。

### Phase D：Windows 桌面客户端子路径支持（`packages/desktop/src-tauri`）
- [x] D1. 更新 `packages/desktop/src-tauri/src/navigation.rs` 与 `navigation/tests.rs`：实现 `normalize_subpath`、`validate_board_url`（支持子路径）、`board_base_path`、`board_server_url`、`board_cookie_path`、`same_board_scope`、`is_board_login_path`、`handle_navigation`。
- [x] D2. 更新 `packages/desktop/src-tauri/src/main.rs`（净减少行数，严守 ≤ 1200 行增量守卫）：移除本地 `server_root`，切换为调用 `navigation::*`。
- [x] D3. 更新 `packages/desktop/src-tauri/src/agent/protocol.rs` 与 `protocol/tests.rs`：`normalize_server_url` 支持合法子路径，新增 `server_origin`。
- [x] D4. 更新 `packages/desktop/src-tauri/src/agent/device.rs`（及相关 Rust 测试）：`SessionClient` 拆分 `server_url` 与 `origin`，写请求 `Origin` 头严格发送 `origin`。
- [x] D5. 更新 `packages/desktop/src-tauri/src/update.rs` 与 `update/tests.rs`：`normalize_server_base` 保留子路径并兼容去掉页面尾段（如 `login.html`）。

### Phase E：文档、全量构建与验收验证
- [x] E1. 更新 `docs/team-operations.md`、`docs/client-auto-update.md`、`README.md`（同步环境变量与子路径 Nginx 示例）。
- [x] E2. 格式化与静态检查：变更范围 `oxfmt --check`（35 个 JS/TS/MJS/HTML 文件）、`rustfmt --edition 2021 --check`（9 个 `.rs` 文件）、`packages/web` `oxlint` 与 `tsc -b --noEmit` 均通过（退出码 0；仓库另有 26 个无关文件保持未改，未跑通全局 `oxfmt --check .`）。
- [ ] E3. 构建与全量测试（按用户指令暂跳过全量测试、先提交代码，待后续继续）：
  - 已通过：`yarn build`、`yarn build --target=desktop-ui`、`yarn test --file=team-subpath-and-proxy.test.js`（5/5）
  - 待续：`yarn test --scope=all`、`yarn test --scope=rust`
- [x] E4. 行数与行尾守卫检查：
  - 确认 `packages/desktop/src-tauri/src/main.rs` 为 1206 行（原 1226 行，净减少 20 行），变更的 9 个 `.rs` 文件均无内联 `^mod tests \{`；
  - 确认 `git ls-files --eol | rg 'i/crlf'` 无输出；
  - 检查 `packages/server/public/{index,login,admin}.html` 无根绝对 `/assets/` 引用且无内联 `<script>`。
- [x] E5. Phase 3.3 Spec 回写检查：同步更新 `.trellis/spec/backend/http-and-filesystem.md`、`.trellis/spec/backend/architecture-and-runtime.md` 与 `.trellis/spec/desktop/tauri-commands/index.md` 中涉及 `basePath` / `trustProxy` / `validate_board_url` / Cookie `Path` 的契约说明。

## 高风险点与回滚点
- **风险 1**：仓库 `.env` 新增 `TRELLIS_BOARD_BASE_PATH=/weint-spec-board` 可能影响依赖根 `.env` 的脚本或测试。
  - **缓解**：`scripts/dev.mjs` 与 `scripts/test.mjs` 对来源为 `.env` 的该键做隔离清空；服务端默认单测通过显式 `env` 对象驱动 `parseTeamConfig`。
- **风险 2**：`packages/desktop/src-tauri/src/main.rs` 已有 1226 行。
  - **缓解**：所有新工具函数放在 `navigation.rs`，`main.rs` 只删减替换为短调用，确保只减不增。
- **风险 3**：桌面端登录时 `Origin` 头若带上子路径会被部分代理或严格校验拒绝，且 WebView2 删除 Cookie 必须匹配精确 `Path`。
  - **缓解**：`SessionClient` 单独保存纯 `origin`；`cookie_for` 统一使用 `board_cookie_path(board)`。
