import { requestJson } from './request.ts'

/**
 * 团队版插件管理（admin 页使用）。
 *
 * 注意：这里没有"账号密码"相关的任何入口。用户的 WitOps 账号只在面板里自己输入，
 * 服务端不落库（见 .trellis/tasks/11-16-team-plugin-core/design.md §11 D2）。
 */

export type TeamPluginView = {
  id: string
  name: string
  version: string
  description: string
  enabled: boolean
  teamEnabled: boolean
  status: string
  running: boolean
  sessions: number
  lastError: string | null
}

export type PluginBindingView = {
  id: string
  teamId: string
  pluginId: string
  projectId: string
  projectName: string | null
  externalProjectId: string
  externalProjectName: string | null
  createdAt: string
}

function readPlugin(value: unknown): TeamPluginView | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  const id = typeof row.id === 'string' ? row.id : ''
  if (!id) return null
  return {
    id,
    name: String(row.name ?? id),
    version: String(row.version ?? ''),
    description: String(row.description ?? ''),
    enabled: row.enabled === true,
    teamEnabled: row.teamEnabled === true,
    status: String(row.status ?? 'unknown'),
    running: row.running === true || row.status === 'running',
    sessions: Number(row.sessions ?? 0),
    lastError: typeof row.lastError === 'string' ? row.lastError : null,
  }
}

function readBinding(value: unknown): PluginBindingView | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  const id = typeof row.id === 'string' ? row.id : ''
  if (!id) return null
  return {
    id,
    teamId: String(row.teamId ?? ''),
    pluginId: String(row.pluginId ?? ''),
    projectId: String(row.projectId ?? ''),
    projectName: typeof row.projectName === 'string' ? row.projectName : null,
    externalProjectId: String(row.externalProjectId ?? ''),
    externalProjectName:
      typeof row.externalProjectName === 'string' ? row.externalProjectName : null,
    createdAt: String(row.createdAt ?? ''),
  }
}

function teamQuery(teamId?: string | null) {
  return teamId ? `?teamId=${encodeURIComponent(teamId)}` : ''
}

export async function listTeamPlugins(teamId?: string | null): Promise<TeamPluginView[]> {
  const { data } = await requestJson<unknown>(`/api/plugins${teamQuery(teamId)}`)
  const rows = (data as { plugins?: unknown[] } | null)?.plugins
  return Array.isArray(rows) ? rows.map(readPlugin).filter((row): row is TeamPluginView => !!row) : []
}

export async function setPluginEnabled(pluginId: string, enabled: boolean): Promise<void> {
  await requestJson(`/api/plugins/${encodeURIComponent(pluginId)}/enabled`, {
    method: 'PUT',
    body: { enabled },
  })
}

export async function startPlugin(pluginId: string): Promise<void> {
  await requestJson(`/api/plugins/${encodeURIComponent(pluginId)}/start`, { method: 'POST', body: {} })
}

export async function stopPlugin(pluginId: string): Promise<void> {
  await requestJson(`/api/plugins/${encodeURIComponent(pluginId)}/stop`, { method: 'POST', body: {} })
}

export async function setTeamPluginEnabled(
  pluginId: string,
  teamId: string,
  enabled: boolean,
): Promise<void> {
  await requestJson(`/api/plugins/${encodeURIComponent(pluginId)}/team-config${teamQuery(teamId)}`, {
    method: 'PUT',
    body: { enabled, config: {} },
  })
}

export async function listBindings(
  pluginId: string,
  teamId: string,
): Promise<PluginBindingView[]> {
  const { data } = await requestJson<unknown>(
    `/api/plugins/${encodeURIComponent(pluginId)}/bindings${teamQuery(teamId)}`,
  )
  const rows = (data as { bindings?: unknown[] } | null)?.bindings
  return Array.isArray(rows) ? rows.map(readBinding).filter((row): row is PluginBindingView => !!row) : []
}

export async function addBinding(
  pluginId: string,
  teamId: string,
  input: { projectId: string; externalProjectId: string; externalProjectName: string },
): Promise<void> {
  await requestJson(`/api/plugins/${encodeURIComponent(pluginId)}/bindings${teamQuery(teamId)}`, {
    method: 'POST',
    body: input,
  })
}

export async function removeBinding(
  pluginId: string,
  teamId: string,
  bindingId: string,
): Promise<void> {
  const query = `?teamId=${encodeURIComponent(teamId)}&bindingId=${encodeURIComponent(bindingId)}`
  await requestJson(`/api/plugins/${encodeURIComponent(pluginId)}/bindings${query}`, {
    method: 'DELETE',
  })
}
