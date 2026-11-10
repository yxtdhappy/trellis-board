import { ApiError, requestJson, redirectToLogin } from './request'
import type { BoardTask } from '@/features/board/task-view'
import { normalizeTaskPage } from '@/lib/team-client.js'

export type Project = {
  id: string
  teamId?: string
  teamName?: string
  name: string
  path: string
  members?: string[]
  workspaceMembers?: string[]
  developer?: string | null
  syncStatus?: string
  syncBranch?: string | null
  role?: string | null
  scanStatus?: string
  lastScanAt?: string | null
  taskCount?: number
  [key: string]: unknown
}

export type BoardPayload = {
  projects: Project[]
  tasks: BoardTask[]
  generatedAt?: string
  source?: string
  refreshRunning?: boolean
  refreshQueued?: boolean
  savedViews?: unknown[]
  watcher?: { enabled?: boolean; lastEvent?: { relativePath?: string } }
  settings?: { executionWipLimit?: number }
  [key: string]: unknown
}

export type BoardStatus = {
  refreshRunning?: boolean
  refreshQueued?: boolean
  lastRefreshAt?: string
  [key: string]: unknown
}

export type TeamRuntime = {
  team?: boolean
  mode?: string
  authenticated: boolean
  user: {
    displayName?: string
    username?: string
    role?: string
    developerId?: string
    mustChangePassword?: boolean
  } | null
  systemAdmin?: boolean
  teams?: RuntimeTeam[]
}

export type RuntimeTeam = {
  id: string
  name: string
  role?: string | null
  status?: string
}

async function apiRequest(
  url: string,
  method = 'GET',
  body?: unknown,
  options: { headers?: Record<string, string> } = {},
) {
  try {
    return await requestJson(url, { method, body, headers: options.headers })
  } catch (error) {
    if (error instanceof ApiError && error.status === 401 && error.code !== 'AUTH_FAILED') {
      redirectToLogin()
    }
    throw error
  }
}

export async function api<T = unknown>(url: string, method = 'GET', body?: unknown) {
  const result = await apiRequest(url, method, body)
  return (result.status === 304 ? null : result.data) as T | null
}

export const getRuntime = () => api<TeamRuntime>('/api/runtime')

export const fetchBoard = (force = false) =>
  force
    ? api<BoardPayload>('/api/board/refresh/start', 'POST').then(() =>
        api<BoardPayload>('/api/board'),
      )
    : api<BoardPayload>('/api/board')

export const saveWipLimit = (executionWipLimit: number, teamId?: string) =>
  api('/api/board/settings', 'PUT', {
    executionWipLimit,
    ...(teamId ? { teamId } : {}),
  })

export const fetchBoardSettings = (teamId: string) =>
  api<{ teamId?: string | null; executionWipLimit?: number }>(
    `/api/board/settings?teamId=${encodeURIComponent(teamId)}`,
  )

export const fetchSavedViews = (teamId: string) =>
  api<{ views?: unknown[] }>(`/api/saved-views?teamId=${encodeURIComponent(teamId)}`).then(
    (payload) => payload?.views || [],
  )

export const fetchTaskDetail = (task: BoardTask) =>
  api<{ task?: BoardTask }>('/api/task', 'POST', {
    projectId: task.projectId,
    taskPath: task.relativeDir,
  }).then((payload) => payload?.task || (payload as BoardTask | null))

export type TeamQueryPage = {
  tasks: BoardTask[]
  assignees: string[]
  total: number
  nextCursor?: string | null
  queryRevision?: string
  queryDay?: string
}

export async function queryTeamTasks(query: string, etag: string | null) {
  const result = await apiRequest(`/api/tasks/query?${query}`, 'GET', undefined, {
    headers: etag ? { 'if-none-match': etag } : {},
  })
  if (result.status === 304) return { notModified: true as const, page: null, etag: result.etag }
  return {
    notModified: false as const,
    page: normalizeTaskPage(result.data) as TeamQueryPage,
    etag: result.etag,
  }
}

export const fetchTeamStatus = () => api<Record<string, unknown>>('/api/team/status')

export type TeamLiveRevision = {
  revision: number
  revisionKey: string
  projects: { projectId: string; revision: number }[]
  notifications: {
    id: number
    type: 'task.live.overridden'
    projectId: string
    taskKey: string | null
    taskTitle: string | null
    revision: number
    action: 'continue' | 'takeover' | null
    actorAgentId: string | null
    createdAt: string
  }[]
}

export const fetchTeamLiveRevision = (teamId: string) =>
  api<TeamLiveRevision>(`/api/team/live-revision?teamId=${encodeURIComponent(teamId || 'all')}`)

export const fetchAssignments = () =>
  api<{ assignments?: unknown[] }>('/api/assignments?state=pending')

export const acceptTask = (payload: unknown) => api('/api/tasks/accept', 'POST', payload)

export const fetchRepositories = () =>
  api<{ repositories: Project[] }>('/api/repositories').then((data) => data?.repositories || [])

export const pickFolders = () =>
  api<{ paths: string[] }>('/api/repositories/pick-folders', 'POST').then(
    (data) => data?.paths || [],
  )

export const addRepositories = (paths: string[]) =>
  api<BoardPayload>('/api/repositories', 'POST', { repositories: paths.map((path) => ({ path })) })

export const removeRepository = (id: string) => api('/api/repositories', 'DELETE', { id })

export const createTaskRequest = (payload: Record<string, unknown>) =>
  api('/api/tasks', 'POST', payload)

export const assignTaskRequest = (payload: Record<string, unknown>) =>
  api('/api/tasks/assign', 'POST', payload)

export const changePassword = (payload: { currentPassword: string; newPassword: string }) =>
  api('/api/auth/password', 'POST', payload)

export const logout = () => api('/api/auth/logout', 'POST')

export const saveSavedView = (payload: {
  name: string
  filter: Record<string, unknown>
  teamId?: string
}) => api<{ view?: { id: string } }>('/api/saved-views', 'POST', payload)

export const deleteSavedView = (id: string, teamId?: string) =>
  api('/api/saved-views', 'DELETE', { id, ...(teamId ? { teamId } : {}) })

export const createDependency = (payload: {
  blocked: { projectId: string; taskPath: string }
  blocker: { projectId: string; taskPath: string }
  reason: string
  assigneeDecision?: { warningId: string; action: 'continue' | 'takeover' }
}) => api('/api/tasks/dependencies', 'POST', payload)

export const removeDependency = (
  id: string,
  assigneeDecision?: { warningId: string; action: 'continue' | 'takeover' },
) =>
  api('/api/tasks/dependencies', 'DELETE', {
    id,
    ...(assigneeDecision ? { assigneeDecision } : {}),
  })

export const fetchGitOperation = (id: string) =>
  api<Record<string, unknown>>(`/api/git-operations/${encodeURIComponent(id)}`)

export const retryGitOperation = (id: string) =>
  api<Record<string, unknown>>(`/api/git-operations/${encodeURIComponent(id)}/retry`, 'POST', {})
