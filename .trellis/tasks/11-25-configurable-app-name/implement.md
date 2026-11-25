# Implementation Plan: 应用与页面名称支持环境变量配置

## Ordered Checklist

### Step 1: 环境变量 Schema、服务端配置与 HTML/Runtime 下发

- [ ] 更新 [`scripts/lib/env-schema.mjs`](scripts/lib/env-schema.mjs)，添加 `TRELLIS_BOARD_APP_NAME`（`--app-name`，`scopes: ['dev', 'start', 'build']`）。
- [ ] 更新 [`scripts/dev.mjs`](scripts/dev.mjs)、[`scripts/start.mjs`](scripts/start.mjs)、[`scripts/build.mjs`](scripts/build.mjs) 的 `formatEnvSummary` 展示列表，补充 `TRELLIS_BOARD_APP_NAME`。
- [ ] 更新 [`.env.example`](.env.example) 与 [`.env`](.env)，记录并默认配置 `TRELLIS_BOARD_APP_NAME=Weint Spec Board`（或说明默认值为 `Weint Spec Board`）。
- [ ] 更新 [`packages/server/config.js`](packages/server/config.js)：导出 `DEFAULT_APP_NAME = 'Weint Spec Board'` 与 `normalizeAppName(raw)`，在 `parseTeamConfig(env)` 中返回 `appName`。
- [ ] 更新 [`packages/server/team/http/context.js`](packages/server/team/http/context.js)：`runtimePayload(actor)` 返回 `appName`。
- [ ] 更新 [`packages/server/team/http/common.js`](packages/server/team/http/common.js) 与 [`packages/server/team/http.js`](packages/server/team/http.js)：支持 `rewriteHtmlForAppName` / 组合 `transformHtml`（注入 `<meta name="trellis-app-name">` 并替换标题/描述/`share.html` 名称，含 HTML 转义）。

### Step 2: Web 入口页面、Vite 配置与 React 组件接入

- [ ] 更新 [`packages/web/index.html`](packages/web/index.html)、[`admin.html`](packages/web/admin.html)、[`login.html`](packages/web/login.html)、[`share.html`](packages/web/share.html)、[`desktop/index.html`](packages/web/desktop/index.html) 的默认名称为 `Weint Spec Board`。
- [ ] 更新 [`packages/web/vite.config.ts`](packages/web/vite.config.ts) 与 [`packages/web/vite.desktop.config.ts`](packages/web/vite.desktop.config.ts)，在 dev/build 时支持从 `TRELLIS_BOARD_APP_NAME` 注入/替换 HTML 名称与 meta。
- [ ] 新增共享工具 [`packages/web/src/lib/app-name.js`](packages/web/src/lib/app-name.js)（含 `DEFAULT_APP_NAME`、`readAppNameFromMeta`、`resolveAppName`），与 `base-path.js` 保持一致风格。
- [ ] 更新 runtime 归一化与类型定义：[`packages/web/src/lib/team-normalize.js`](packages/web/src/lib/team-normalize.js)、[`packages/web/src/api/board.ts`](packages/web/src/api/board.ts)、[`packages/web/src/api/admin/types.ts`](packages/web/src/api/admin/types.ts)、[`packages/web/src/api/admin/readers.ts`](packages/web/src/api/admin/readers.ts)。
- [ ] 更新 [`BoardPage.tsx`](packages/web/src/pages/board/BoardPage.tsx)、[`AdminPage.tsx`](packages/web/src/pages/admin/AdminPage.tsx)、[`LoginPage.tsx`](packages/web/src/pages/login/LoginPage.tsx)、[`LoginApp.tsx`](packages/web/src/desktop/LoginApp.tsx) 读取并展示配置后的 `brandName` 并同步 `document.title`。

### Step 3: 桌面端（Tauri / Rust / 便携打包脚本）

- [ ] 更新 [`packages/desktop/src-tauri/tauri.conf.json`](packages/desktop/src-tauri/tauri.conf.json) 的 `productName` 为 `"Weint Spec Board"`。
- [ ] 更新 [`packages/desktop/src-tauri/build.rs`](packages/desktop/src-tauri/build.rs)，监听 `cargo:rerun-if-env-changed=TRELLIS_BOARD_APP_NAME`。
- [ ] 更新 [`packages/desktop/src-tauri/src/main.rs`](packages/desktop/src-tauri/src/main.rs)：实现统一 `app_display_name` / `resolve_app_name` 解析逻辑，`client_identity`、`app_status`（补充 `appName` 字段）、主窗口 `.title(...)` 均接入。
- [ ] 更新 [`packages/desktop/src-tauri/src/tray.rs`](packages/desktop/src-tauri/src/tray.rs)、[`update.rs`](packages/desktop/src-tauri/src/update.rs)、[`agent_service.rs`](packages/desktop/src-tauri/src/agent_service.rs) 使用动态应用名称（默认 `Weint Spec Board`）。
- [ ] 更新 [`packages/desktop/package-portable.ps1`](packages/desktop/package-portable.ps1) 支持 `$env:TRELLIS_BOARD_APP_NAME`（默认 `Weint Spec Board`）并保持 EXE/ZIP 文件名与数据目录不变。

### Step 4: 测试与跨层验证

- [ ] 新增/更新服务端测试（[`packages/server/test/team-subpath-and-proxy.test.js`](packages/server/test/team-subpath-and-proxy.test.js) 等）：覆盖 `TRELLIS_BOARD_APP_NAME` 默认值、合法值、非法字符/超长报错、`/api/runtime` 字段下发、HTML `<meta>` 与 `<title>` / `share.html` 动态重写及 XSS 转义。
- [ ] 新增/更新前端与桌面静态契约测试（[`packages/desktop/test/desktop-ui-build.test.js`](packages/desktop/test/desktop-ui-build.test.js) 等）：覆盖 `app-name` 解析优先级（服务端 > meta > 客户端回退 > 默认 `Weint Spec Board`）与桌面 UI 静态契约。
- [ ] 更新 Rust 单测（[`packages/desktop/src-tauri/src/main/tests.rs`](packages/desktop/src-tauri/src/main/tests.rs)、[`packages/desktop/src-tauri/src/agent_service/tests.rs`](packages/desktop/src-tauri/src/agent_service/tests.rs) 等）：覆盖 `resolve_app_name` 优先级、默认 `Weint Spec Board` 与通知标题。
- [ ] 检查 `.trellis/spec/desktop/tauri-commands/index.md` 是否需要同步更新 `client_identity` 默认值说明（由 `Trellis Board` 改为 `Weint Spec Board` 及 `TRELLIS_BOARD_APP_NAME` 优先级）。

## Validation Commands

```powershell
yarn test
yarn build --target=all
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml
yarn format:check
git ls-files --eol | rg 'i/crlf'
```

## Risky Files & Rollback Points

- `packages/server/team/http/common.js`：HTML 重写同时服务 `basePath` 与 `appName`，需注意正则边界与 `content-length` 计算一致，避免损坏 `HEAD` 响应或内联 script/meta。
- `packages/desktop/test/desktop-ui-build.test.js`：存在对 `BoardPage.tsx` `useState('Trellis Board')` 与 `client_identity` 的静态正则断言，需同步更新测试断言以反映新契约。
- `.trellis/spec/desktop/tauri-commands/index.md`：`client_identity` 契约文档写明默认回退为 `Trellis Board`，实现后应在 Phase 3.3 同步更新 spec。
