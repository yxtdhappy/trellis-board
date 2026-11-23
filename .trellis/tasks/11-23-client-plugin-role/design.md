# 设计：客户端插件可见性（role + 本机宿主）

## 1. 角色模型

新增两个正交维度：

```ts
type RuntimeRole = 'server' | 'client'   // 本端角色，启动参数决定
type BackendMode = 'team' | 'standalone' // 连接的后端形态，仍由 /api/runtime 决定
```

- `role` 只决定：插件宿主在哪、是否显示“本机插件”、是否请求服务端插件。
- `teamMode` 保留现有语义，继续管登录、团队/权限、数据 API、UI。
- `isTauri` 只表示“能否使用 Tauri IPC”，不再表示“是不是客户端”。

### 解析顺序

新增 `packages/web/src/lib/role.ts`：

```ts
export type RuntimeRole = 'server' | 'client'

export function resolveRuntimeRole(input?: {
  search?: string
  injected?: unknown
  build?: unknown
}): RuntimeRole {
  const search = input?.search ?? (typeof location === 'undefined' ? '' : location.search)
  const fromQuery = new URLSearchParams(search).get('role')
  const value = fromQuery || input?.injected || input?.build || 'server'
  return value === 'client' ? 'client' : 'server'
}
```

优先级：`?role=client` > `window.__TRELLIS_ROLE__` > `import.meta.env.VITE_TRELLIS_ROLE` > `server`。

`BoardPage` 顶部只解析一次：

```ts
const role = resolveRuntimeRole({ injected: window.__TRELLIS_ROLE__ })
const isClient = role === 'client'
```

## 2. 传输层抽象

新增 `packages/web/src/api/plugin-transport.ts`，把现有 7 个 IPC 调用收口：

```ts
export type PluginTransport = {
  list(): Promise<DesktopPluginsState>
  setEnabled(id: string, enabled: boolean): Promise<unknown>
  reorder(ids: string[]): Promise<unknown>
  logs(id: string, tail?: number): Promise<DesktopPluginLogEntry[]>
  panels(): Promise<DesktopPanel[]>
  request(id: string, method: string, path: string, body?: unknown): Promise<DesktopPluginResponse>
  asset(id: string, path: string): Promise<{ status: number; contentType?: string; content: string }>
}
```

两个实现：

| 实现 | 条件 | 基址 |
| --- | --- | --- |
| `createIpcTransport()` | `role==='client' && isTauri` | `window.__TAURI__.core.invoke` |
| `createHttpTransport()` | `role==='client' && !isTauri` | `/local-plugin`（Vite 代理） |

HTTP 映射：

| Transport | HTTP |
| --- | --- |
| `list()` | `GET /internal/plugins` |
| `setEnabled(id, enabled)` | `POST /internal/plugins/<id>/enabled` `{enabled}`（host.mjs 新增） |
| `reorder(ids)` | `POST /internal/plugins/order` `{ids}` |
| `logs(id, tail)` | `GET /internal/plugins/<id>/logs?tail=` |
| `panels()` | `GET /internal/panels` |
| `request(id, method, path, body)` | 宿主内部转发：`POST /internal/plugins/<id>/request`（host.mjs 新增） |
| `asset(id, path)` | `GET /plugin-ui/...` 或 `/s/<secret>/...` |

所有 HTTP 请求带 `Authorization: Bearer <token>`；token 来自 `import.meta.env.VITE_LOCAL_PLUGIN_TOKEN`，仅 dev 注入。

`desktop-plugins.ts` 保留现有导出签名，内部改为 `transport()` 选择实现，避免页面层大改。

## 3. 4401 本地宿主

### 启动脚本

新增 `.worktree/scripts/plugin-host.sh`（本机专属，不入库）：

```bash
node "$WT/packages/desktop/plugin-host/host.mjs" \
  --port 4517 \
  --data-dir "$ROOT/.worktree/data/plugin-host-dev" \
  --plugins-dir "$WT/plugins" \
  --host-version "$(node -p "require('$WT/package.json').version")" \
  --token "$TOKEN" \
  --secret "$SECRET"
```

- 固定 `127.0.0.1:4517`，只本机可访问。
- `TOKEN`/`SECRET` 由脚本生成，写入 `.worktree/data/plugin-host-dev/env.json`（0600），`dev.sh` 读取后注入 Vite。
- `--plugins-dir` 指向 `.worktree/trellis-board-dev/plugins`，包含 6 个内置插件与私有插件。
- 宿主懒启动逻辑保留：全部插件 disabled 时进程可退出，`dev.sh` 不强制常驻。

### Vite 代理

`packages/web/vite.config.ts`：

```ts
'/local-plugin': {
  target: 'http://127.0.0.1:4517',
  changeOrigin: false,
  rewrite: (path) => path.replace(/^\/local-plugin/, ''),
},
```

### 角色注入

`.worktree/scripts/dev.sh` 启动 Vite 时增加：

```bash
VITE_TRELLIS_ROLE=client \
VITE_LOCAL_PLUGIN_TOKEN="$TOKEN" \
```

生产构建不设置这两个变量，默认 `role=server`。

## 4. 服务端固定关闭

`packages/server/team/http/common.js`：

```js
export function teamPluginsEnabled() {
  return false
}
```

- 保留函数签名，调用点不改。
- `/api/runtime` 继续返回 `features: { pluginsEnabled: false }`。
- `config.js` 的 allowlist 解析保留，任务 2 再清理。
- `/api/plugins`、`/api/panels` 的关闭态由现有 `createDisabledTeamPluginRoutes()` 提供，不改。

## 5. desktop 注入

`packages/desktop/src-tauri/src/main.rs` 的 `WebviewWindowBuilder`：

```rust
.initialization_script("window.__TRELLIS_ROLE__ = 'client'")
```

- dev 与生产一致，不依赖 URL query。
- 仅 Board 窗口需要；登录页不显示插件，注入无副作用。
- Linux 验证：`cargo check`；Windows GUI 行为在交付说明中标注未验证。

## 6. 文件清单

| 文件 | 改动 |
| --- | --- |
| `packages/web/src/lib/role.ts` | 新增角色解析 |
| `packages/web/src/api/plugin-transport.ts` | 新增 IPC/HTTP 传输层 |
| `packages/web/src/api/desktop-plugins.ts` | 改为通过 transport |
| `packages/web/src/features/plugins/DesktopPluginsView.tsx` | 使用 transport，不直接 invoke |
| `packages/web/src/pages/board/BoardPage.tsx` | `role` 替换 `isTauri` 判定；客户端不请求服务端插件 |
| `packages/web/vite.config.ts` | `/local-plugin` 代理 |
| `packages/desktop/plugin-host/host.mjs` | 新增 `/internal/plugins/<id>/enabled` 与 `/internal/plugins/<id>/request` |
| `packages/desktop/src-tauri/src/main.rs` | 注入 `window.__TRELLIS_ROLE__` |
| `packages/server/team/http/common.js` | `teamPluginsEnabled()` 恒 false |
| `.worktree/scripts/plugin-host.sh` | 新增本地宿主启动脚本 |
| `.worktree/scripts/dev.sh` | 注入 `VITE_TRELLIS_ROLE` / token |

## 7. 验证

1. `yarn build`（`tsc -b && vite build`）通过。
2. 4401 打开：左侧出现“本机插件”，6 个插件列出。
3. 启用 `witops-core`：宿主进程拉起，状态 `running`，5 秒轮询更新。
4. 打开 `witops-core` 面板：iframe 经 `/local-plugin/s/<secret>/...` 加载。
5. 4402 `GET /api/runtime` → `pluginsEnabled:false`；`GET /api/plugins` 禁用态。
6. 4401 网络面板确认没有 `/api/panels` 插件请求。
7. desktop `cargo check` 通过；Windows GUI 未验证。

## 8. 风险

- `host.mjs` 新增接口必须保持 Tauri 路径不变；Rust `plugin_host.rs` 仍走原 IPC，不依赖新接口。
- 固定端口 4517 需在脚本启动前检查占用。
- 面板 iframe 的 CSP：dev 页面无 CSP；desktop 生产仍走 IPC，不受影响。
- `import.meta.env.VITE_LOCAL_PLUGIN_TOKEN` 只存在于 dev 构建，生产为空，HTTP transport 不会启用。
