import * as transport from './plugin-transport'

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

/** 本端是否能访问插件宿主：桌面 IPC 或浏览器客户端 HTTP。 */
export const desktopAvailable = transport.pluginTransportAvailable()

export async function fetchDesktopPlugins(): Promise<DesktopPluginsState> {
  return transport.listPlugins()
}

export async function setDesktopPluginEnabled(id: string, enabled: boolean): Promise<unknown> {
  return transport.setPluginEnabled(id, enabled)
}

export async function reorderDesktopPlugins(ids: string[]): Promise<unknown> {
  return transport.reorderPlugins(ids)
}

export async function fetchDesktopPluginLogs(
  id: string,
  tail = 200,
): Promise<DesktopPluginLogEntry[]> {
  return transport.pluginLogs(id, tail)
}

export async function fetchDesktopPanels(): Promise<DesktopPanel[]> {
  return transport.listPanels()
}

export async function requestDesktopPlugin(
  id: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<DesktopPluginResponse> {
  return transport.requestPlugin(id, method, path, body)
}

export async function fetchDesktopPluginAsset(
  id: string,
  path: string,
): Promise<{ status: number; contentType?: string; content: string }> {
  return transport.pluginAsset(id, path)
}
