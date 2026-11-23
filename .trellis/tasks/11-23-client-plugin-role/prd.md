# 客户端插件可见性：role 启动参数与本机宿主

## Goal

客户端启动后，即使通过普通浏览器访问页面（当前 4401 模拟场景），也应被识别为客户端并展示本机插件；插件入口不再依赖 `window.__TAURI__`，服务端 Team 模式固定不承载插件。

## Background

当前判定链路：

- `packages/web/src/pages/board/BoardPage.tsx:111` 用 `Boolean(window.__TAURI__?.core?.invoke)` 得到 `isTauri`；
- `:223` 用 `isTauri && teamMode` 决定是否显示“本机插件”；
- 浏览器访问时 `isTauri=false`，即使进程角色是客户端也不显示；
- 服务端 `/api/runtime` 的 `features.pluginsEnabled` 又控制远端面板，Team 默认关闭时该路径也为空。

## Requirements

### R1 角色由启动参数决定

- 新增统一角色：`server | client`。
- 解析优先级：URL query `role` > `window.__TRELLIS_ROLE__`（桌面注入）> `import.meta.env.VITE_TRELLIS_ROLE` > 默认 `server`。
- `isTauri` 只保留“能否使用 Tauri IPC”的语义，不再参与插件可见性判断。
- `teamMode` 保留原义（连接的后端是否为 Team），不参与插件可见性判断。

### R2 客户端插件入口与数据源

- `role === 'client'` 时显示“本机插件”入口；`role === 'server'` 时不显示。
- 客户端模式不再请求服务端插件数据（`/api/plugins`、`/api/panels` 的插件部分）。
- 传输层按能力选择：
  - `role === 'client' && isTauri`：沿用现有 `desktop_plugin*` IPC；
  - `role === 'client' && !isTauri`：走本地宿主 HTTP。
- standalone 的 `!teamMode` 分支原样保留，不在本任务删除。

### R3 4401 本地插件宿主

- 在 dev 环境提供本地宿主启动方式，复用 `packages/desktop/plugin-host/host.mjs`。
- 固定 `127.0.0.1:4517`，仅 dev 使用；bearer token 与 secret 由启动脚本生成并通过 Vite 注入。
- Vite 代理 `/local-plugin` 到本地宿主，避免浏览器跨域。
- 前端在 `role === 'client' && !isTauri` 时通过该代理调用插件列表、启停、面板、日志与请求转发。

### R4 服务端固定关闭插件

- Team 模式 `pluginsEnabled` 恒为 `false`，不再依赖 `TRELLIS_TEAM_PLUGINS_ALLOWLIST` 或 `TRELLIS_PLUGINS_DISABLED`。
- `/api/runtime` 继续返回 `features.pluginsEnabled: false`，保持字段向后兼容。
- `/api/plugins`、`/api/panels` 的插件部分固定返回禁用/空列表。
- 服务端插件代码保留，不在本任务删除。

### R5 desktop 注入角色

- `packages/desktop/src-tauri/src/main.rs` 的 `WebviewWindowBuilder` 加载 URL 时注入 `role=client`（dev 与生产一致）。
- Linux 上只要求 `cargo check`/`cargo build` 通过；Windows GUI 行为在交付说明中标注未验证。

### R6 范围边界

- `client/trellis-board-web`（4403）分支本轮不改动。
- 不删除 standalone 代码。
- 不改动 4317 远端实例。

## Acceptance Criteria

- [ ] 4401 浏览器打开后，左侧出现“本机插件”，列出 6 个内置插件。
- [ ] 在 4401 能启停 `witops-core`，状态在 5 秒轮询内更新。
- [ ] `witops-core` 面板能在 4401 的 iframe 中加载，面板数据经本地宿主返回。
- [ ] 4402 `GET /api/runtime` 返回 `features.pluginsEnabled:false`；`GET /api/plugins` 返回禁用态。
- [ ] 4401 客户端模式不再请求 `/api/panels` 的插件数据。
- [ ] 4403（`client/trellis-board-web`）代码无改动。
- [ ] `yarn test` 通过；`yarn build`（`tsc -b && vite build`）通过。
- [ ] desktop `cargo check` 通过；Windows GUI 未验证部分在实现记录中注明。

## 落点

- 主改：`.worktree/trellis-board-dev`（`packages/web`、`packages/desktop`、`scripts`）。
- 关联改动：`.worktree/trellis-board-team`（`packages/server` 的 Team 插件门禁固定关闭）。
- 任务文档在 main 分支创建，执行阶段在两个 worktree 分别提交。

## Notes

- 本地宿主仅 dev 使用，不进入生产构建。
- 不新增前端状态库或路由库。
- 面板 iframe 继续使用 `/plugin-ui/v1/*` 与 `TrellisBridge`，不另建主题/桥接体系。
