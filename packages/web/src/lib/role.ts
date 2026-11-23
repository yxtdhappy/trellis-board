/**
 * 本端运行角色。
 *
 * - `server`：Team 服务端进程/页面，不承载本机插件。
 * - `client`：桌面客户端或模拟客户端的页面，插件由本机宿主提供。
 *
 * 角色由启动参数决定，不再用 `window.__TAURI__` 推断“是不是客户端”。
 */
export type RuntimeRole = 'server' | 'client'

declare global {
  interface Window {
    __TRELLIS_ROLE__?: string
  }
}

export type RuntimeRoleInput = {
  /** URL query，默认取 `location.search`。 */
  search?: string
  /** 桌面壳注入的 `window.__TRELLIS_ROLE__`。 */
  injected?: unknown
  /** 构建期注入的 `import.meta.env.VITE_TRELLIS_ROLE`。 */
  build?: unknown
}

/**
 * 解析优先级：URL query `role` > 注入值 > 构建变量 > 默认 `server`。
 */
export function resolveRuntimeRole(input: RuntimeRoleInput = {}): RuntimeRole {
  const search =
    input.search ?? (typeof location === 'undefined' ? '' : location.search)
  const fromQuery = new URLSearchParams(search).get('role')
  const value = fromQuery ?? input.injected ?? input.build ?? 'server'
  return value === 'client' ? 'client' : 'server'
}
