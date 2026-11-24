# Implementation Plan: Team 服务端集成 Tauri 客户端自动更新

## Execution Checklist

### Phase A: 服务端托管目录、CLI 环境登记与 HTTP 路由
- [x] **A1**：`packages/server/config.js` 新增并导出 `resolveClientUpdatesDir()` 与 `clientUpdatesDir`（默认 `<dataDir>/client-updates`，支持 `TRELLIS_CLIENT_UPDATES_DIR` 覆盖）。
- [x] **A2**：`scripts/lib/env-schema.mjs` 新增 `TRELLIS_CLIENT_UPDATES_DIR` / `--client-updates-dir`（`scopes: ['dev', 'start']`, `type: 'path'`）；`.env.example` 补充该键注释。
- [x] **A3**：新增 `packages/server/team/http/client-updates.js`，实现 `createClientUpdatesHandler({ clientUpdatesDir })`：免登录 `GET/HEAD /client-updates/latest.json`（`no-store`）与 `/client-updates/<file>.zip`（流式、单段文件名白名单、`realpathSync` 防逃逸）。
- [x] **A4**：在 `packages/server/team/http.js` 的 `createTeamRuntime` 接收 `clientUpdatesDir`（默认 `<dataDir>/client-updates`），并在 `dispatch()` 鉴权前挂载 `/client-updates/` 路由；`packages/web/vite.config.ts` 增加 `/client-updates` 代理。
- [x] **A5**：新增单元测试 `packages/server/test/team-client-updates.test.js`，覆盖 `latest.json` / `.zip` 的 `GET` / `HEAD`、缓存头、`400/403/404/405` 边界、符号链接逃逸拒绝与 `resolveClientUpdatesDir` 路径解析。

### Phase B: Tauri 客户端运行时回退与托盘联动
- [x] **B1**：改造 `packages/desktop/src-tauri/src/update.rs`：
  - 提取 `normalize_server_base`（提取 `scheme://host[:port]` + `/client-updates`）；
  - `UpdateManager` 支持 `compile_base` + `runtime_base`（`compile_base` 优先），支持动态刷新与状态清理；
  - 新增 `set_server_url(&app, Option<&str>)` 与托盘菜单项联动刷新；
  - `register(&app, initial_server_url: Option<&str>)` 保持后台检查循环并适配动态源。
- [x] **B2**：修改 `packages/desktop/src-tauri/src/main.rs`：
  - `setup` 初始化传入 `initial_server_url()`；
  - 保存 `"check-update"` 托盘 `MenuItem` 并由 `update::set_tray_item` 同步启用态；
  - 登录成功与 `desktop_logout` 分别调用 `update::set_server_url(&app, Some(...))` / `None`。
- [x] **B3**：补充 `packages/desktop/src-tauri/src/update/tests.rs` 单元测试：验证 `compile_base` 优先、`runtime_base` 回退与规范化（含去掉路径/尾斜杠/query）、切换服务端重置缓存、从真实 HTTP 测试服务端请求 `/client-updates/latest.json`。

### Phase C: 文档、规范与验证
- [x] **C1**：编写 `/opt/app/work/github/trellis-board/docs/client-auto-update.md`：包含架构流程、目录与环境变量、内网 Jenkins 一体化构建服务端 + Windows 客户端并原子发布脚本范式、Nginx/Docker 配置、验收与排障指南。
- [x] **C2**：在 `README.md`、`docs/team-operations.md`、`packages/desktop/README.md` 补充客户端托管目录与自动更新文档链接；同步更新 `.trellis/spec/desktop/tauri-commands/index.md`（Phase 3.3）。
- [x] **C3**：执行格式化与全量验证：
  - `node node_modules/oxfmt/bin/oxfmt --check <touched_js_ts_files>`
  - `yarn test --scope=server --file=team-client-updates`
  - `yarn test --scope=scripts`
  - `yarn test`
  - `yarn test --scope=rust`（如本机具备 Rust 工具链）
  - `git ls-files --eol` 检查无 CRLF。

## Risky Files & Rollback Points
- `packages/server/team/http.js`：改动置于 `requireActor` 前的静态路由分发，确保不干扰 `/api/*` 与前端静态托管。
- `packages/desktop/src-tauri/src/update.rs` & `main.rs`：保留 `TRELLIS_UPDATE_SERVER` 原有逻辑分支与 `manifest.rs` / `package.rs` 全部安全校验不改动；任何发布异常可通过移除服务器 `client-updates/latest.json` 立即止血。
