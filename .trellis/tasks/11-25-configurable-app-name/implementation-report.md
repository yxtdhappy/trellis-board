# Implementation Report: 应用与页面名称支持环境变量配置

## 变更文件清单

- 环境与 CLI：`scripts/lib/env-schema.mjs`、`scripts/dev.mjs`、`scripts/start.mjs`、`scripts/build.mjs`、`.env`、`.env.example`、`scripts/test/cli.test.js`
- 服务端：`packages/server/config.js`、`packages/server/team/http/context.js`、`packages/server/team/http/common.js`、`packages/server/team/http.js`、`packages/server/test/team-subpath-and-proxy.test.js`
- Web 与 Vite：`packages/web/{index,admin,login,share}.html`、`packages/web/desktop/index.html`、`packages/web/tsconfig.node.json`、`packages/web/vite-app-name.ts`、`packages/web/vite.config.ts`、`packages/web/vite.desktop.config.ts`、`packages/web/src/lib/app-name.js`、`packages/web/src/lib/app-name.d.ts`、`packages/web/src/lib/team-normalize.js`、`packages/web/src/lib/team-normalize.d.ts`、`packages/web/src/api/board.ts`、`packages/web/src/api/admin/types.ts`、`packages/web/src/api/admin/readers.ts`、`packages/web/src/hooks/useAdminConsole.ts`、`packages/web/src/components/layout/TrellisLogo.tsx`、`packages/web/src/components/layout/TopBar.tsx`、`packages/web/src/pages/board/BoardPage.tsx`、`packages/web/src/pages/admin/AdminPage.tsx`、`packages/web/src/pages/login/LoginPage.tsx`、`packages/web/src/desktop/LoginApp.tsx`、`packages/web/test/app-name.test.js`
- 桌面端与测试：`packages/desktop/src-tauri/tauri.conf.json`、`packages/desktop/src-tauri/build.rs`、`packages/desktop/src-tauri/src/main.rs`、`packages/desktop/src-tauri/src/tray.rs`、`packages/desktop/src-tauri/src/update.rs`、`packages/desktop/src-tauri/src/agent_service.rs`、`packages/desktop/src-tauri/src/main/tests.rs`、`packages/desktop/src-tauri/src/agent_service/tests.rs`、`packages/desktop/package-portable.ps1`、`packages/desktop/test/desktop-ui-build.test.js`
- 规范同步：`.trellis/spec/desktop/tauri-commands/index.md`

## 关键实现决策

1. **零硬编码品牌文案**：移除源码、HTML 模板与前端组件中的硬编码品牌文案（含 HTML 默认标题、`app-name.js` 默认值、`LoginApp` 的 `TRELLIS DESKTOP`、`TrellisLogo` 的 `aria-label="Trellis"` 与 `tauri.conf.json` 的硬编码品牌名），仅在 `.env` / `.env.example` 配置 `TRELLIS_BOARD_APP_NAME`；底层技术标识（`trellis-board-client.exe`、`TrellisBoard_<version>_x64-portable.zip`、`%LOCALAPPDATA%\TrellisBoard`、`com.trellisboard.client`、`spec-board://`）保持不变。
2. **模板占位 + 运行时下发**：HTML 使用 `{{APP_NAME}}` 占位符，Vite 通过 `loadProjectEnv` / `TRELLIS_BOARD_APP_NAME` 在 dev/build 注入，服务端 `serveStatic` 通过 `rewriteHtmlForRuntime` 注入/更新 `<meta name="trellis-app-name" ... />` 并转义替换 `<title>`、`description` 与 `share.html` 文案；`/api/runtime` 与 `/api/auth/me` 同步下发 `appName`。
3. **跨端读取优先级**：Web 侧 `resolveAppName` 按 `runtime.appName` > `meta[name="trellis-app-name"]` > `client_identity().name` > 空串解析；Rust 侧 `resolve_app_name` 按运行期环境变量 > 构建期 `option_env!`（`build.rs` 自动回退读取 `.env`）> `product_name` > 中性兜底 `Board` 解析。
