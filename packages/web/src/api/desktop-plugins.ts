import { invoke } from '@/desktop/tauri'

export type DesktopPlugin = {
  id: string
  name?: string
  version?: string | null
  apiVersion?: number | null
  enabled: boolean
  sort?: number
  status: string
  compatible?: boolean
  reason?: string | null
  pid?: number | null
  lastError?: string | null
  restarts?: number
  panels?: { id: string; title: string; entry: string; placement: string; order: number }[]
}

export type DesktopPluginsState = {
  disabled: boolean
  running: boolean
  hostVersion: string
  plugins: DesktopPlugin[]
}

export type DesktopPanel = {
  id: string
  title: string
  entry: string
  placement: 'view' | 'board-tab'
  order: number
  pluginId: string
  pluginName: string
  src: string
  eventsSrc?: string
  host: 'desktop'
}

export type DesktopPluginLogEntry = { at?: string; level?: string; message?: string }

export type DesktopPluginResponse = {
  ok: boolean
  status: number
  contentType?: string
  data: unknown
}

export const desktopAvailable = Boolean(invoke)

function requireInvoke() {
  if (!invoke) throw new Error('当前环境不是桌面客户端')
  return invoke
}

export async function fetchDesktopPlugins(): Promise<DesktopPluginsState> {
  return requireInvoke()<DesktopPluginsState>('desktop_plugins_list')
}

export async function setDesktopPluginEnabled(id: string, enabled: boolean): Promise<unknown> {
  return requireInvoke()('desktop_plugin_set_enabled', { pluginId: id, enabled })
}

export async function reorderDesktopPlugins(ids: string[]): Promise<unknown> {
  return requireInvoke()('desktop_plugin_reorder', { ids })
}

export async function fetchDesktopPluginLogs(
  id: string,
  tail = 200,
): Promise<DesktopPluginLogEntry[]> {
  const result = await requireInvoke()<{ entries?: DesktopPluginLogEntry[] }>(
    'desktop_plugin_logs',
    { pluginId: id, tail },
  )
  return result?.entries ?? []
}

export async function fetchDesktopPanels(): Promise<DesktopPanel[]> {
  const result = await requireInvoke()<{ panels?: DesktopPanel[]; running?: boolean }>(
    'desktop_plugin_panels',
  )
  return (result?.panels ?? []).map((panel) => ({ ...panel, host: 'desktop' as const }))
}

export async function requestDesktopPlugin(
  id: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<DesktopPluginResponse> {
  return requireInvoke()<DesktopPluginResponse>('desktop_plugin_request', {
    pluginId: id,
    method,
    path,
    body: body ?? null,
  })
}

export async function fetchDesktopPluginAsset(
  id: string,
  path: string,
): Promise<{ status: number; contentType?: string; content: string }> {
  return requireInvoke()('desktop_plugin_asset', { pluginId: id, path })
}
