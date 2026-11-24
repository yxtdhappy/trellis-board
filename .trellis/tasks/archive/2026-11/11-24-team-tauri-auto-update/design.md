# Design: Team 服务端集成 Tauri 客户端自动更新

## 1. Architecture Overview

将桌面客户端自动更新从「依赖外部独立文件服务器 + 编译期写死地址」升级为「**Team 服务端内置托管 `/client-updates/` + 客户端运行时自动发现当前服务端地址**」，同时保留编译期 `TRELLIS_UPDATE_SERVER` 作为最高优先级覆盖项：

```text
[内网 Jenkins]
  ├─ 构建并重启 Team 服务端（packages/server/public + Node 服务）
  └─ 构建 Windows 便携包（latest.json + TrellisBoard_<v>_x64-portable.zip）
         │ 先传 .zip，再原子 mv 替换 latest.json
         ▼
<TRELLIS_BOARD_DATA_DIR>/client-updates/  (或 TRELLIS_CLIENT_UPDATES_DIR)
         │ HTTP/HTTPS GET/HEAD (免登录)
         ▼
[Tauri 桌面客户端]
  ├─ 若编译期存在 TRELLIS_UPDATE_SERVER -> 使用编译期基地址
  └─ 否则使用当前连接的 Team 服务端 -> <server_root(board_url)>/client-updates
```

## 2. Server Design (`packages/server`)

### 2.1 目录解析 (`packages/server/config.js` & `scripts/lib/env-schema.mjs`)
- 新增 `resolveClientUpdatesDir({ platform, env, homeDir, dataDir } = {})`：
  1. 若 `env.TRELLIS_CLIENT_UPDATES_DIR` 非空：`platformPath.resolve(override)`；
  2. 否则回落 `platformPath.join(resolvedDataDir, 'client-updates')`。
- `packages/server/config.js` 导出 `clientUpdatesDir = resolveClientUpdatesDir()`。
- `scripts/lib/env-schema.mjs` 在 `scopes: ['dev', 'start']` 注册：
  - `env: 'TRELLIS_CLIENT_UPDATES_DIR'`、`flag: 'client-updates-dir'`、`type: 'path'`。
- `.env.example` 增加 `TRELLIS_CLIENT_UPDATES_DIR=` 模板与注释。

### 2.2 HTTP 托管路由 (`packages/server/team/http/client-updates.js` & `packages/server/team/http.js`)
- `createTeamRuntime({ ..., clientUpdatesDir })`：未显式传入 `clientUpdatesDir` 时默认使用 `path.join(resolvedDataDir, 'client-updates')`（保证测试传入临时 `dataDir` 时自动隔离，无需额外配置）。
- 在 `packages/server/team/http.js` 的 `dispatch()` 中，**置于 `requireActor(request)` 之前**（与 `/api/health`、`/plugin-ui/` 平级，保证登录前检查更新与下载时无需 Cookie）：
  - 匹配 `/client-updates/...`（精确 `/client-updates` 返回 404，只服务其下文件）：
  - 仅放行 `GET` 与 `HEAD`，其他方法返回 `405` JSON（带 `Allow: GET, HEAD`）。
  - 对路径编码非法返回 `400` JSON。
  - 文件名提取与白名单校验：
    - `latest.json` → `content-type: application/json; charset=utf-8`，`cache-control: no-store, no-cache, must-revalidate`；
    - `^[A-Za-z0-9._-]+\.zip$` → `content-type: application/zip`，`cache-control: public, max-age=86400`，附加 `content-disposition: attachment; filename="<name>"`；
    - 其余任何包含 `/`、`\`、`..` 或非法字符/后缀的请求直接返回 `400` / `404` JSON，不访问磁盘。
  - 真实路径逃逸守卫：
    - 使用 `fs.realpathSync(baseDir)` 与 `fs.realpathSync(filePath)` 检查 `realPath` 严格位于 `realBase` 下（防止目录内符号链接逃逸到服务器敏感文件），越界返回 `403` JSON，不存在返回 `404` JSON。
  - 响应头附带 `securityHeaders()`（其中 `latest.json` 与 `.zip` 显式覆盖各自 `cache-control`），`GET` 通过 `fs.createReadStream(realPath).pipe(response)` 流式传输，支持大包低内存占用；`HEAD` 返回 `content-length` 后结束。
- `packages/web/vite.config.ts` 增加 `/client-updates` proxy（`target: apiTarget`, `changeOrigin: false`），便于本地 `yarn dev --mode=desktop` 联调。

## 3. Desktop Rust Design (`packages/desktop/src-tauri/src/`)

### 3.1 `update.rs` 动态与编译期双源机制
- 保留 `pub const UPDATE_SERVER: Option<&str> = option_env!("TRELLIS_UPDATE_SERVER");` 与 `configured_base()` 作为**编译期覆盖源**。
- 新增 `normalize_server_base(board_url: &str) -> Option<String>`：
  - 解析 `http` / `https` URL，校验 `host_str().is_some()`，提取 `scheme://host[:port]` 并拼接 `/client-updates`（注意复用/对齐 `server_root` 逻辑，忽略多余路径/query/fragment）。
- `UpdateManager` 内部状态由不可变 `enabled` / `base` 升级为受 `Mutex` 保护的可变状态：
  - 追踪 `compile_base: Option<String>`、`runtime_base: Option<String>`；
  - 有效更新源 `effective_base() = compile_base.clone().or_else(|| runtime_base.clone())`；
  - `UpdateManager::new(initial_runtime_base: Option<String>)` 在启动时初始化。
- 新增导出函数：
  - `pub fn enabled(app: &AppHandle) -> bool`（若无 state 时可兼容 `configured_base().is_some()`，或由 `UpdateManager` 提供 `is_enabled()`）；
  - `pub fn set_server_url(app: &AppHandle, board_url: Option<&str>)`：
    1. 若 `compile_base` 已配置：直接保持 `compile_base` 不变（不覆盖显式构建期配置）；
    2. 否则更新 `runtime_base = board_url.and_then(normalize_server_base)`；
    3. 若 `runtime_base` 发生变化：重置内存缓存的 `latest_release` / `latest` / `update_available` / `error` / `checked_at`，同步更新 `status.enabled` 与 `status.server`，发射 `update-status-changed`，同步更新托盘菜单项 `"check-update"` 的 `set_enabled(status.enabled)`；
    4. 若新的 `runtime_base` 为 `Some(...)` 且确实发生了变更（例如刚登录或切换到另一台 Team 服务端）：异步触发一次 `check(&app)`。
- 后台定时循环（`register`）：
  - 若 `compile_base` 或 `initial_server_url` 任一可用，启动后台检查循环；即使启动时未登录（`runtime_base = None`），循环也常驻并在每轮检查前判断 `effective_base().is_some()`，未配置时跳过不报错，登录后由 `set_server_url` 立即触发一次检查。

### 3.2 `main.rs` 集成点
- `AppState`（或独立托管）保存托盘 `"check-update"` `MenuItem<tauri::Wry>` 引用，便于登录/退出时调用 `item.set_enabled(enabled)`，无需重启应用即可点亮或置灰托盘菜单。
- `setup` 阶段：先计算 `initial_runtime_base = initial_server_url()` 并传给 `update::register(&handle, initial_runtime_base.as_deref())`，再构建托盘并注册 `"check-update"` 句柄。
- 登录成功设置 `board_url` 后（[main.rs:484](../../../packages/desktop/src-tauri/src/main.rs#L484)）：调用 `update::set_server_url(&app, Some(board.as_str()))`。
- `desktop_logout` 清空 `board_url` 后（[main.rs:300](../../../packages/desktop/src-tauri/src/main.rs#L300)）：调用 `update::set_server_url(&app, None)`。

## 4. Compatibility, Security & Rollback

- **向下兼容**：若 Jenkins/CI 构建仍传 `TRELLIS_UPDATE_SERVER`，行为与改造前完全一致；不传时自动切到当前连接的 Team 服务端 `<serverRoot>/client-updates`。
- **安全边界**：
  - 服务端不信任 URL 中的 `file` 参数做路径拼接，仅允许单段 `[A-Za-z0-9._-]+\.zip` 且做 `realpathSync` 根目录校验；
  - 客户端沿用 `manifest::parse` 与 `package::download` 的严格 `size`、`sha256`、ZIP 单 EXE 提取与 `.old` 回滚；
  - `check-update` / `update_status` / `update_check` / `update_apply` 继续受 `board-local-association` capability 与 `ensure_board_caller` 约束。
- **回滚方案**：若内网更新服务出现异常，只需清空或移走服务端 `client-updates/latest.json`（接口返回 404，客户端记录温和提示而不影响正常同步与看板使用），无需重编客户端或修改数据库。
