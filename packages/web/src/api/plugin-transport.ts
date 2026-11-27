import { invoke, isNativeTauri } from '@/desktop/tauri'
import { resolveRuntimeRole } from '@/lib/role'
import type {
  DesktopPanel,
  DesktopPluginLogEntry,
  DesktopPluginResponse,
  DesktopPluginsState,
} from './desktop-plugins'

/**
 * 插件宿主 transport。
 *
 * - 桌面 EXE：走 Tauri IPC（`window.__TAURI__.core.invoke`）。
 * - 浏览器里的客户端页面：走 Vite 代理 `/local-plugin` 到本机 host.mjs。
 * 判据必须是「是否原生 Tauri」而不是「transport 是否有 invoke」：桥模式虽然也有
 * `invoke`，但插件宿主是独立进程，能力来自 `/local-plugin` 的 HTTP 接口。
 * - 服务端页面：两者都没有，调用方不应触发这里。
 *
 * HTTP 模式下 token/secret 来自 dev 脚本注入的 `VITE_LOCAL_PLUGIN_*`，
 * 只用于本机开发；生产桌面始终走 IPC。
 */
const LOCAL_BASE = (import.meta.env.VITE_LOCAL_PLUGIN_BASE as string | undefined) || '/local-plugin'
const LOCAL_TOKEN = (import.meta.env.VITE_LOCAL_PLUGIN_TOKEN as string | undefined) || ''
const LOCAL_SECRET = (import.meta.env.VITE_LOCAL_PLUGIN_SECRET as string | undefined) || ''

function injectedRole(): string | undefined {
  return typeof window === 'undefined' ? undefined : window.__TRELLIS_ROLE__
}

export function pluginTransportAvailable(): boolean {
  if (isNativeTauri) return true
  return resolveRuntimeRole({ injected: injectedRole() }) === 'client'
}

async function httpJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  if (LOCAL_TOKEN) headers.set('authorization', `Bearer ${LOCAL_TOKEN}`)
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }
  const response = await fetch(`${LOCAL_BASE}${path}`, { ...init, headers })
  const text = await response.text()
  let data: unknown = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = { error: text }
  }
  if (!response.ok) {
    const message = (data as { error?: string } | null)?.error
    throw new Error(message || `插件宿主请求失败（${response.status}）`)
  }
  return data as T
}

export async function listPlugins(): Promise<DesktopPluginsState> {
  if (isNativeTauri && invoke) return invoke<DesktopPluginsState>('desktop_plugins_list')
  return httpJson<DesktopPluginsState>('/internal/plugins')
}

export async function setPluginEnabled(id: string, enabled: boolean): Promise<unknown> {
  if (isNativeTauri && invoke) return invoke('desktop_plugin_set_enabled', { pluginId: id, enabled })
  return httpJson(`/internal/plugins/${encodeURIComponent(id)}/enabled`, {
    method: 'POST',
    body: JSON.stringify({ enabled }),
  })
}

export async function reorderPlugins(ids: string[]): Promise<unknown> {
  if (isNativeTauri && invoke) return invoke('desktop_plugin_reorder', { ids })
  return httpJson('/internal/plugins/order', {
    method: 'POST',
    body: JSON.stringify({ ids }),
  })
}

export async function pluginLogs(id: string, tail = 200): Promise<DesktopPluginLogEntry[]> {
  if (isNativeTauri && invoke) {
    const result = await invoke<{ entries?: DesktopPluginLogEntry[] }>('desktop_plugin_logs', {
      pluginId: id,
      tail,
    })
    return result?.entries ?? []
  }
  const result = await httpJson<{ entries?: DesktopPluginLogEntry[] }>(
    `/internal/plugins/${encodeURIComponent(id)}/logs?tail=${tail}`,
  )
  return result?.entries ?? []
}

export async function listPanels(): Promise<DesktopPanel[]> {
  if (isNativeTauri && invoke) {
    const result = await invoke<{ panels?: DesktopPanel[]; running?: boolean }>(
      'desktop_plugin_panels',
    )
    return (result?.panels ?? []).map((panel) => ({ ...panel, host: 'desktop' as const }))
  }
  const result = await httpJson<{ panels?: DesktopPanel[]; running?: boolean }>('/internal/panels')
  const prefix = `${LOCAL_BASE}/s/${LOCAL_SECRET}/`
  return (result?.panels ?? []).map((panel) => {
    const src = String(panel.src || '').replace(/^\/api\/plugins\//, prefix)
    return {
      ...panel,
      host: 'desktop' as const,
      src,
      eventsSrc: `${LOCAL_BASE}/s/${LOCAL_SECRET}/__events?topics=${encodeURIComponent(panel.pluginId)}`,
    }
  })
}

export async function requestPlugin(
  id: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<DesktopPluginResponse> {
  if (isNativeTauri && invoke) {
    return invoke<DesktopPluginResponse>('desktop_plugin_request', {
      pluginId: id,
      method,
      path,
      body: body ?? null,
    })
  }
  return httpJson<DesktopPluginResponse>(`/internal/plugins/${encodeURIComponent(id)}/request`, {
    method: 'POST',
    body: JSON.stringify({ method, path, body: body ?? null }),
  })
}

export async function pluginAsset(
  id: string,
  path: string,
): Promise<{ status: number; contentType?: string; content: string }> {
  if (isNativeTauri && invoke) return invoke('desktop_plugin_asset', { pluginId: id, path })
  return httpJson(`/internal/plugins/${encodeURIComponent(id)}/asset?path=${encodeURIComponent(path)}`)
}
