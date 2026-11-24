# Team 服务端集成 Tauri 客户端自动更新

## Goal

Team 看板部署到内网服务器后，由 Team 服务端直接托管 Tauri 桌面客户端更新清单（`latest.json`）与便携更新包（`TrellisBoard_<version>_x64-portable.zip`），同时升级 Tauri 客户端支持「编译期 `TRELLIS_UPDATE_SERVER` 优先、未配置时自动回退到当前登录 Team 服务端 `<serverUrl>/client-updates`」，适配内网 Jenkins 一体化打包与发布流程，并在 `/opt/app/work/github/trellis-board/docs/client-auto-update.md` 补充完整运维与 Jenkins 集成文档。

## Confirmed Codebase Facts

- **客户端现有自动更新机制**（[update.rs](../../../packages/desktop/src-tauri/src/update.rs)、[manifest.rs](../../../packages/desktop/src-tauri/src/update/manifest.rs)、[package.rs](../../../packages/desktop/src-tauri/src/update/package.rs)）：
  - 当前仅通过编译期 `option_env!("TRELLIS_UPDATE_SERVER")` 注入更新基地址（[update.rs:19](../../../packages/desktop/src-tauri/src/update.rs#L19)），未配置或 URL 非法时 `enabled=false`，不发起网络请求。
  - 启动 5 秒后首次检查、之后每 6 小时检查，请求 `{base}/latest.json`（上限 64 KiB），按严格 semver（`x.y.z`）对比，确认升级后下载 `{base}/{file}` 并校验 `size`（≤ 512 MiB）与 `sha256`，提取唯一 `trellis-board-client.exe` 备份旧 EXE 后替换重启。
  - `debug` 构建禁止调用 `update_apply`（[update.rs:231-234](../../../packages/desktop/src-tauri/src/update.rs#L231-L234)）；通知去重持久化在 `data/update-state.json`（[update.rs:330-355](../../../packages/desktop/src-tauri/src/update.rs#L330-L355)）。
- **桌面端生命周期与入口**：
  - `ClientConfig.server_url` 保存在 `%LOCALAPPDATA%\TrellisBoard\data\client.json`（[config.rs:10-14](../../../packages/desktop/src-tauri/src/config.rs#L10-L14)），启动时由 `initial_server_url()` 读取（[main.rs:225-230](../../../packages/desktop/src-tauri/src/main.rs#L225-L230)），登录成功写入 `DesktopAuthState.board_url`（[main.rs:429-490](../../../packages/desktop/src-tauri/src/main.rs#L429-L490)），退出时清空 `board_url`（[main.rs:291-305](../../../packages/desktop/src-tauri/src/main.rs#L291-L305)）。
  - 托盘菜单项 `"check-update"` 在 `build_tray()` 中创建并初始化启用态（[main.rs:994-1005](../../../packages/desktop/src-tauri/src/main.rs#L994-L1005)）。
  - 看板 UI 通过 `UpdateDialog.tsx` 调用 `update_status` / `update_check` / `update_apply`（[UpdateDialog.tsx:96-159](../../../packages/web/src/desktop/UpdateDialog.tsx#L96-L159)）。
- **打包产物脚本**（[package-portable.ps1:181-196](../../../packages/desktop/package-portable.ps1#L181-L196)）：已在 `packages/desktop/src-tauri/target/release/bundle/portable/` 下同时产出 `TrellisBoard_<version>_x64-portable.zip`、`TrellisBoard_<version>_x64-portable.zip.sha256` 与 `latest.json`。
- **服务端现状**（[http-common.js:5-18](../../../packages/server/http-common.js#L5-L18)、[http.js:124-143](../../../packages/server/team/http.js#L124-L143)）：
  - `STATIC_TYPES` 仅含前端静态资源扩展名（不含 `.json` / `.zip`），且 `packages/server/team/http.js` 目前没有客户端更新目录托管路由。
- **规范约束**：[桌面 Tauri 命令与导航规范](../../spec/desktop/tauri-commands/index.md#L334-L380)。

## Requirements

- **REQ-1 服务端更新托管目录与配置**：
  - `packages/server/config.js` 新增 `resolveClientUpdatesDir()`，默认 `<TRELLIS_BOARD_DATA_DIR>/client-updates/`，支持 `TRELLIS_CLIENT_UPDATES_DIR` 环境变量覆盖；同步登记到 `scripts/lib/env-schema.mjs`（`--client-updates-dir`）与 `.env.example`。
  - `createTeamRuntime`（`packages/server/team/http.js`）接收 `clientUpdatesDir`（未传时默认 `<dataDir>/client-updates`）。
- **REQ-2 服务端免登录只读下载路由**：
  - 在 `packages/server/team/http.js` 登录鉴权前挂载 `/client-updates/` 路由（独立模块 `packages/server/team/http/client-updates.js`）：
    - 仅允许 `GET` / `HEAD`（其余方法返回 `405`）；
    - `/client-updates/latest.json` 返回 `application/json; charset=utf-8` 与 `Cache-Control: no-store, no-cache, must-revalidate`；
    - `/client-updates/<file>.zip` 严格校验单段文件名（`^[A-Za-z0-9._-]+\.zip$`，禁止 `/`、`\`、`..`、符号链接逃逸），返回 `application/zip`、`Content-Length`、`Cache-Control: public, max-age=86400`，使用 `fs.createReadStream` 流式传输；
    - 缺失目录或文件返回 `404` JSON，不泄露本机绝对路径；
    - `packages/web/vite.config.ts` 增加 `/client-updates` 代理到 `apiTarget`，便于本地桌面 dev 联调。
- **REQ-3 Tauri 客户端更新源自动回退**：
  - 改造 `packages/desktop/src-tauri/src/update.rs` 与 `main.rs`：
    - 更新源优先级：编译期 `TRELLIS_UPDATE_SERVER`（若配置且为合法 `http(s)` URL）> 运行时当前连接的 Team 服务端 `<server_root(board_url)>/client-updates`；
    - 启动时若无编译期地址但本地配置/参数存在合法 `initial_server_url()`，初始化运行时回退地址；
    - 登录成功设置 `board_url` 时调用 `update::set_server_url(&app, Some(&board))` 刷新更新源、启用托盘「检查更新」菜单项，并在地址变化时触发一次检查；
    - 退出登录清空 `board_url` 时调用 `update::set_server_url(&app, None)` 清理运行时回退与缓存（存在编译期地址时不受影响），并同步更新托盘「检查更新」可用状态；
    - 保持现有安全契约不变：严格 semver 比较、`size` + `sha256` 校验、ZIP 单 EXE 提取、`.old` 备份回滚、`debug` 构建禁止 `update_apply`、通知去重。
- **REQ-4 文档与规范同步**：
  - 新增 `docs/client-auto-update.md`：覆盖架构原理、目录与环境变量、内网 Jenkins 一体化打包服务端与 Windows 绿色包并原子投放发布范式（先传 `.zip` 再原子替换 `latest.json`）、Nginx/Docker 配置建议、端到端验收与排障；
  - 在 `docs/team-operations.md`、`README.md`、`packages/desktop/README.md` 补充链接与说明，并在 Phase 3.3 同步更新 `.trellis/spec/desktop/tauri-commands/index.md` 中的「客户端自动更新」契约。

## Out of Scope

- 不在 `/admin.html` 新增 Web 上传客户端安装包界面或管理台上传 API（由内网 Jenkins 流水线直接部署到服务器目录）。
- 不引入代码签名基础设施或增量二进制补丁（沿用现有完整绿色 ZIP + SHA-256 校验机制）。
- 不修改 GitHub Actions 现有 `v*` tag 发版触发逻辑。

## Acceptance Criteria

- [ ] **AC-1**：Team 服务端正确托管 `GET/HEAD /client-updates/latest.json`（`no-store`、`application/json`）与 `GET/HEAD /client-updates/<file>.zip`（流式、`Content-Length`、`application/zip`），无需登录 Cookie；非法文件名、路径穿越、符号链接逃逸、非 `GET/HEAD` 方法、缺失文件均返回预期 `400/403/404/405`。
- [ ] **AC-2**：`resolveClientUpdatesDir` 支持默认 `<dataDir>/client-updates` 与 `TRELLIS_CLIENT_UPDATES_DIR` 覆盖，并已登记到 `scripts/lib/env-schema.mjs` 与 `.env.example`。
- [ ] **AC-3**：Tauri 客户端 Rust 单元测试覆盖更新源优先级（编译期 > 运行时服务端回退 > 未配置禁用）、URL 规范化、登录切换/退出重置以及端到端从模拟服务端拉取 `/client-updates/latest.json`；`cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml` 全绿（若当前 Linux 环境缺少桌面构建依赖，明确说明并在 Windows CI/实机验证）。
- [ ] **AC-4**：Node 服务端单元测试（新增 `packages/server/test/team-client-updates.test.js`）与现有 `yarn test` / `scripts/test/cli.test.js` 通过，`oxfmt --check`（改动文件）与 LF 行尾检查通过。
- [ ] **AC-5**：`docs/client-auto-update.md` 完整覆盖架构、配置、内网 Jenkins 同步更新服务端 + 产出 Windows 包并原子投放流程、验收清单与排障指南，并从 `README.md`、`docs/team-operations.md`、`packages/desktop/README.md` 正确链接。
