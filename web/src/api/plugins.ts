import { requestJson } from './request'

export type PluginInfo = {
  id: string
  name: string
  version: string | null
  apiVersion: number | null
  compatible: boolean
  reason: string | null
  enabled: boolean
  status: string
  pid: number | null
  restarts: number
  lastError: string | null
  droppedEvents?: number
  permissions?: string[]
  rootPaths?: string[]
  openPaths?: string[]
  logFile?: string | null
  startedAt?: string | null
}

export type PluginList = {
  disabled: boolean
  hostVersion?: string
  plugins: PluginInfo[]
}

export type PluginLogEntry = {
  at?: string | null
  level?: string
  message?: string
  fields?: Record<string, unknown>
}

export async function fetchPlugins(): Promise<PluginList> {
  const { data } = await requestJson<PluginList>('/api/plugins')
  return { disabled: Boolean(data?.disabled), hostVersion: data?.hostVersion, plugins: data?.plugins ?? [] }
}

export async function startPlugin(id: string): Promise<void> {
  await requestJson(`/api/plugins/${encodeURIComponent(id)}/start`, { method: 'POST' })
}

export async function stopPlugin(id: string): Promise<void> {
  await requestJson(`/api/plugins/${encodeURIComponent(id)}/stop`, { method: 'POST' })
}

export async function fetchPluginLogs(id: string, tail = 200): Promise<PluginLogEntry[]> {
  const { data } = await requestJson<{ entries?: PluginLogEntry[] }>(
    `/api/plugins/${encodeURIComponent(id)}/logs?tail=${tail}`,
  )
  return data?.entries ?? []
}
