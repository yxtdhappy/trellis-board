import { ApiError, requestJson } from './request.ts'

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
  return {
    disabled: Boolean(data?.disabled),
    hostVersion: data?.hostVersion,
    plugins: data?.plugins ?? [],
  }
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

export type PluginReloadResult = {
  ok: boolean
  reason?: string
  error?: string
  secretsFile?: string | null
  changed: string[]
  restarted: string[]
  started: string[]
  stopped: string[]
  added: string[]
  removed: string[]
  failed: { id: string; error: string }[]
  warnings?: Array<Record<string, unknown>>
}

function normalizeReloadResult(payload: Partial<PluginReloadResult> | null): PluginReloadResult {
  return {
    ok: Boolean(payload?.ok),
    reason: payload?.reason,
    error: payload?.error,
    secretsFile: payload?.secretsFile ?? null,
    changed: payload?.changed ?? [],
    restarted: payload?.restarted ?? [],
    started: payload?.started ?? [],
    stopped: payload?.stopped ?? [],
    added: payload?.added ?? [],
    removed: payload?.removed ?? [],
    failed: payload?.failed ?? [],
    warnings: payload?.warnings ?? [],
  }
}

/**
 * 重读插件配置目录（默认 `<TrellisBoard>/plugins`）的 plugins.json + secrets 并重启受影响的插件。
 * 解析失败时宿主返回 400 + 完整结果，这里统一按结果对象返回，调用方只看 ok。
 */
export async function reloadPlugins(): Promise<PluginReloadResult> {
  try {
    const { data } = await requestJson<PluginReloadResult>('/api/plugins/reload', {
      method: 'POST',
    })
    return normalizeReloadResult(data)
  } catch (error) {
    if (error instanceof ApiError && error.payload) {
      return normalizeReloadResult(error.payload as Partial<PluginReloadResult>)
    }
    throw error
  }
}
