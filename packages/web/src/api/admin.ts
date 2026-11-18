import { ApiError, requestJson } from './request.ts'
import { redactSensitiveDetail } from '@/lib/team-client.js'

export const AUDIT_PAGE_LIMIT = 100

export type AdminView =
  | 'project-access'
  | 'archive-sync'
  | 'users'
  | 'teams'
  | 'plugins'
  | 'agents'
  | 'audit'

export type SessionUser = {
  id: string
  username: string
  displayName: string
  systemAdmin: boolean
  status: string
  mustChangePassword: boolean
}

export type TaskSpaceLifecycleStatus = 'active' | 'disabled' | 'retired'

export type AdminTaskSpace = {
  id: string
  branchName: string
  status: string
  lifecycleStatus: TaskSpaceLifecycleStatus
  isBaseline?: boolean
  revision: number
  indexedRevision: number
  readOnly: boolean
  retiredAt: string | null
  retiredByUserId: string | null
  retiredReason: string | null
  taskCount: number
  fileCount: number
  activeTaskCount: number
  archivedTaskCount: number
  lastActivityAt: string | null
  unarchivedTaskTitles: string[]
  approvedBindingCount: number
  onlineListenerCount: number
  lastListenerAt: string | null
}

export type RuntimeProject = {
  id: string
  teamId: string | null
  teamName: string | null
  name: string
  baselineBranch?: string | null
  syncStatus: string
  syncBranch: string
  role: string | null
  stale: boolean
  lastError: string | null
  capabilities: Record<string, unknown>
  taskSpaces: AdminTaskSpace[]
}

export type ProjectMember = {
  userId: string | null
  username: string
  displayName: string
  trellisDevId: string | null
  role: string | null
  status: string
}

export type TeamProject = RuntimeProject & {
  members: ProjectMember[]
}

export type Team = {
  id: string
  name: string
  slug: string
  status: string
  role: string | null
  active: boolean
  memberCount: number
  projectCount: number
}

export type TeamMember = {
  userId: string
  username: string
  displayName: string
  systemAdmin: boolean
  status: string
  role: string
}

export type AdminUser = SessionUser & {
  passwordChangedAt: string | null
  createdAt: string | null
  teams: Team[]
}

export type AgentDevice = {
  id: string
  userId: string | null
  username: string
  displayName: string
  deviceName: string
  platform: string
  agentVersion: string
  protocolVersion: number
  status: string
  lastSeenAt: string | null
  createdAt: string | null
  revokedAt: string | null
}

export type AgentBinding = {
  id: string
  agentId: string
  projectId: string
  localRepoKey: string
  displayName: string | null
  branchName: string
  status: string
  lastSyncedAt: string | null
  lastError: string | null
  deviceName: string | null
  agentStatus: string | null
  ownerUserId: string | null
  ownerUsername: string
  ownerDisplayName: string
  lastSeenAt: string | null
  createdAt: string | null
  updatedAt: string | null
}

export type ProjectTeamAccess = {
  projectId: string
  teamId: string
  teamName: string
  teamStatus: string
  accessRole: string
  createdAt: string | null
}

export type AuditEvent = {
  id: number
  actorUserId: string | null
  actorAgentId: string | null
  projectId: string | null
  action: string
  targetType: string
  targetId: string | null
  result: string
  correlationId: string
  detail: unknown
  occurredAt: string | null
}

export type ArchiveSyncConfig = {
  enabled: boolean
  intervalSeconds: number
  updatedAt: string | null
}

export type ArchiveGitCredential = {
  id: string
  name: string
  scheme: 'ssh' | 'https'
  host: string
  port: number
  origin: string
  authType: 'ssh_key' | 'https_token'
  username: string | null
  configured: boolean
  publicKeyFingerprint: string | null
  secretVersion: number
  createdAt: string | null
  updatedAt: string | null
}

export type ArchiveTaskSpaceSync = {
  taskSpaceId: string
  projectId: string
  projectName: string
  remoteUrl: string
  origin: string | null
  branchName: string
  credentialState: string
  credential: ArchiveGitCredential | null
  status: string
  lastAttemptAt: string | null
  lastSuccessAt: string | null
  lastIndexedAt: string | null
  lastError: string | null
  remoteHead: string | null
  fileCount: number
  byteCount: number
  archiveRevision: number
  archiveIndexedRevision: number
  failureCount: number
  nextAttemptAt: string | null
}

export type ArchiveSyncOverview = {
  config: ArchiveSyncConfig
  credentials: ArchiveGitCredential[]
  taskSpaces: ArchiveTaskSpaceSync[]
}

export type ArchiveSyncLog = {
  id: number
  taskSpaceId: string
  attemptId: string
  phase: string
  level: string
  errorCode: string
  message: string
  detail: Record<string, unknown>
  createdAt: string | null
}

export type Runtime = {
  mode: 'team' | 'standalone'
  team: boolean
  authenticated: boolean
  user: SessionUser | null
  systemAdmin: boolean
  teams: Team[]
  projects: RuntimeProject[]
}

export function canManageProject(project: RuntimeProject): boolean {
  if (project.capabilities.manageMembers ?? project.capabilities.manage_members) return true
  return project.role === 'lead'
}

export function formatError(error: unknown): string {
  if (error instanceof ApiError) {
    return error.code ? `${error.message}（${error.code}）` : error.message
  }
  if (error instanceof Error) return error.message || '请求失败'
  return '请求失败'
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function text(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return fallback
}

function optionalText(value: unknown): string | null {
  if (typeof value === 'string') return value || null
  if (typeof value === 'number') return String(value)
  return null
}

function flag(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true'
}

function rows(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function collection<T>(payload: unknown, key: string, read: (row: unknown) => T): T[] {
  const source = record(payload)
  const value = source[key]
  return (Array.isArray(value) ? value : Array.isArray(payload) ? payload : []).map(read)
}

function readSessionUser(input: unknown): SessionUser {
  const row = record(record(input).user ?? input)
  const username = text(row.username)
  return {
    id: text(row.id ?? row.userId ?? row.user_id),
    username,
    displayName: text(row.displayName ?? row.display_name, username),
    systemAdmin: flag(row.systemAdmin ?? row.system_admin),
    status: text(row.status, 'active'),
    mustChangePassword: flag(row.mustChangePassword ?? row.must_change_password),
  }
}

function readTeam(input: unknown): Team {
  const row = record(input)
  return {
    id: text(row.id),
    name: text(row.name),
    slug: text(row.slug),
    status: text(row.status, 'active'),
    role: optionalText(row.role),
    active: flag(row.active),
    memberCount: Number(row.memberCount ?? row.member_count ?? 0) || 0,
    projectCount: Number(row.projectCount ?? row.project_count ?? 0) || 0,
  }
}

function readTeamMember(input: unknown): TeamMember {
  const row = record(input)
  return {
    userId: text(row.userId ?? row.user_id),
    username: text(row.username),
    displayName: text(row.displayName ?? row.display_name, text(row.username)),
    systemAdmin: flag(row.systemAdmin ?? row.system_admin),
    status: text(row.status, 'active'),
    role: text(row.role ?? row.teamRole ?? row.team_role, 'member'),
  }
}

function readTaskSpaceLifecycleStatus(
  value: unknown,
  status: string,
  retiredAt: string | null,
): TaskSpaceLifecycleStatus {
  if (value === 'active' || value === 'disabled' || value === 'retired') return value
  if (retiredAt) return 'retired'
  return status === 'disabled' ? 'disabled' : 'active'
}

export function readTaskSpace(input: unknown): AdminTaskSpace {
  const row = record(input)
  const status = text(row.status, 'unknown')
  const retiredAt = optionalText(row.retiredAt ?? row.retired_at)
  return {
    id: text(row.id),
    branchName: text(row.branchName ?? row.branch_name),
    status,
    lifecycleStatus: readTaskSpaceLifecycleStatus(
      row.lifecycleStatus ?? row.lifecycle_status,
      status,
      retiredAt,
    ),
    revision: Number(row.revision ?? 0),
    indexedRevision: Number(row.indexedRevision ?? row.indexed_revision ?? 0),
    readOnly: flag(row.readOnly ?? row.read_only),
    retiredAt,
    retiredByUserId: optionalText(row.retiredByUserId ?? row.retired_by_user_id),
    retiredReason: optionalText(row.retiredReason ?? row.retired_reason),
    taskCount: Number(row.taskCount ?? row.task_count ?? 0) || 0,
    fileCount: Number(row.fileCount ?? row.file_count ?? 0) || 0,
    activeTaskCount: Number(row.activeTaskCount ?? row.active_task_count ?? 0) || 0,
    archivedTaskCount: Number(row.archivedTaskCount ?? row.archived_task_count ?? 0) || 0,
    lastActivityAt: optionalText(row.lastActivityAt ?? row.last_activity_at),
    unarchivedTaskTitles: rows(row.unarchivedTaskTitles ?? row.unarchived_task_titles)
      .map((title) => text(title))
      .filter(Boolean),
    approvedBindingCount: Number(row.approvedBindingCount ?? row.approved_binding_count ?? 0) || 0,
    onlineListenerCount: Number(row.onlineListenerCount ?? row.online_listener_count ?? 0) || 0,
    lastListenerAt: optionalText(row.lastListenerAt ?? row.last_listener_at),
  }
}

function readRuntimeProject(input: unknown): RuntimeProject {
  const row = record(input)
  const syncStatus = text(row.syncStatus ?? row.sync_status, 'unknown')
  return {
    id: text(row.id ?? row.repositoryId ?? row.repository_id),
    teamId: optionalText(row.teamId ?? row.team_id),
    teamName: optionalText(row.teamName ?? row.team_name),
    name: text(row.name ?? row.repositoryName ?? row.repository_name),
    syncStatus,
    syncBranch: text(row.syncBranch ?? row.sync_branch),
    role: optionalText(row.role ?? row.projectRole ?? row.project_role),
    stale: flag(row.stale) || ['stale', 'needs_repair'].includes(syncStatus),
    lastError: optionalText(row.lastError ?? row.last_error),
    capabilities: record(row.capabilities ?? row.permissions),
    taskSpaces: rows(row.taskSpaces).map(readTaskSpace),
  }
}

function readProjectMember(input: unknown): ProjectMember {
  if (typeof input === 'string') {
    return {
      userId: null,
      username: input,
      displayName: input,
      trellisDevId: input,
      role: null,
      status: 'active',
    }
  }
  const row = record(input)
  return {
    userId: optionalText(row.userId ?? row.user_id ?? row.id),
    username: text(row.username),
    displayName: text(row.displayName ?? row.display_name, text(row.username)),
    trellisDevId: optionalText(row.trellisDevId ?? row.trellis_dev_id),
    role: optionalText(row.role),
    status: text(row.status, 'active'),
  }
}

export function readProjectMembers(source: Record<string, unknown>): ProjectMember[] {
  const seen = new Set<string>()
  const members: ProjectMember[] = []
  for (const item of [
    ...rows(source.members),
    ...rows(source.validAssignees),
    ...rows(source.valid_assignees),
    ...rows(source.assignees),
  ]) {
    const member = readProjectMember(item)
    const key = member.userId || member.trellisDevId || member.username || member.displayName
    if (!key || seen.has(key)) continue
    seen.add(key)
    members.push(member)
  }
  return members
}

export function readTeamProject(input: unknown): TeamProject {
  const row = record(input)
  return {
    ...readRuntimeProject(row),
    members: readProjectMembers(row),
  }
}

export function readRuntime(payload: unknown): Runtime {
  const row = record(record(payload).runtime ?? payload)
  const mode = text(row.mode ?? row.boardMode ?? row.board_mode, 'standalone').toLowerCase()
  const rawUser = row.user ?? row.currentUser ?? row.current_user
  const user = rawUser ? readSessionUser(rawUser) : null
  return {
    mode: mode === 'team' ? 'team' : 'standalone',
    team: flag(row.team ?? row.teamMode ?? row.team_mode) || mode === 'team',
    authenticated: row.authenticated !== false,
    user,
    systemAdmin: flag(row.systemAdmin ?? row.system_admin) || Boolean(user?.systemAdmin),
    teams: rows(row.teams).map(readTeam),
    projects: rows(row.projects ?? row.items).map(readRuntimeProject),
  }
}

function readAdminUser(input: unknown): AdminUser {
  const row = record(input)
  return {
    ...readSessionUser(row),
    passwordChangedAt: optionalText(row.passwordChangedAt ?? row.password_changed_at),
    createdAt: optionalText(row.createdAt ?? row.created_at),
    teams: rows(row.teams).map(readTeam),
  }
}

function readAgentDevice(input: unknown): AgentDevice {
  const row = record(input)
  return {
    id: text(row.id),
    userId: optionalText(row.userId ?? row.user_id),
    username: text(row.username),
    displayName: text(row.displayName ?? row.display_name, text(row.username)),
    deviceName: text(row.deviceName ?? row.device_name, '未命名设备'),
    platform: text(row.platform),
    agentVersion: text(row.agentVersion ?? row.agent_version),
    protocolVersion: Number(row.protocolVersion ?? row.protocol_version ?? 0) || 0,
    status: text(row.status, 'unknown'),
    lastSeenAt: optionalText(row.lastSeenAt ?? row.last_seen_at),
    createdAt: optionalText(row.createdAt ?? row.created_at),
    revokedAt: optionalText(row.revokedAt ?? row.revoked_at),
  }
}

function readAgentBinding(input: unknown): AgentBinding {
  const row = record(input)
  return {
    id: text(row.id),
    agentId: text(row.agentId ?? row.agent_id),
    projectId: text(row.projectId ?? row.project_id),
    localRepoKey: text(row.localRepoKey ?? row.local_repo_key),
    displayName: optionalText(row.displayName ?? row.display_name),
    branchName: text(row.branchName ?? row.branch_name),
    status: text(row.status ?? row.syncStatus ?? row.sync_status, 'unknown'),
    lastSyncedAt: optionalText(row.lastSyncedAt ?? row.last_synced_at),
    lastError: optionalText(row.lastError ?? row.last_error),
    deviceName: optionalText(row.deviceName ?? row.device_name),
    agentStatus: optionalText(row.agentStatus ?? row.agent_status),
    ownerUserId: optionalText(row.ownerUserId ?? row.owner_user_id),
    ownerUsername: text(row.ownerUsername ?? row.owner_username),
    ownerDisplayName: text(row.ownerDisplayName ?? row.owner_display_name),
    lastSeenAt: optionalText(row.lastSeenAt ?? row.last_seen_at),
    createdAt: optionalText(row.createdAt ?? row.created_at),
    updatedAt: optionalText(row.updatedAt ?? row.updated_at),
  }
}

function readAuditEvent(input: unknown): AuditEvent {
  const row = record(input)
  return {
    id: Number(row.id ?? 0) || 0,
    actorUserId: optionalText(row.actorUserId ?? row.actor_user_id),
    actorAgentId: optionalText(row.actorAgentId ?? row.actor_agent_id),
    projectId: optionalText(row.projectId ?? row.project_id),
    action: text(row.action),
    targetType: text(row.targetType ?? row.target_type),
    targetId: optionalText(row.targetId ?? row.target_id),
    result: text(row.result, 'unknown'),
    correlationId: text(row.correlationId ?? row.correlation_id),
    detail: redactSensitiveDetail(row.detail ?? {}),
    occurredAt: optionalText(row.occurredAt ?? row.occurred_at),
  }
}

function readArchiveSyncConfig(input: unknown): ArchiveSyncConfig {
  const row = record(input)
  return {
    enabled: flag(row.enabled),
    intervalSeconds: Number(row.intervalSeconds ?? row.interval_seconds ?? 300) || 300,
    updatedAt: optionalText(row.updatedAt ?? row.updated_at),
  }
}

export function readArchiveGitCredential(input: unknown): ArchiveGitCredential {
  const row = record(input)
  const scheme = text(row.scheme) === 'ssh' ? 'ssh' : 'https'
  return {
    id: text(row.id),
    name: text(row.name, text(row.origin)),
    scheme,
    host: text(row.host),
    port: Number(row.port ?? (scheme === 'ssh' ? 22 : 443)) || 443,
    origin: text(row.origin),
    authType: scheme === 'ssh' ? 'ssh_key' : 'https_token',
    username: optionalText(row.username),
    configured: flag(row.configured ?? true),
    publicKeyFingerprint: optionalText(row.publicKeyFingerprint ?? row.public_key_fingerprint),
    secretVersion: Number(row.secretVersion ?? row.secret_version ?? 0) || 0,
    createdAt: optionalText(row.createdAt ?? row.created_at),
    updatedAt: optionalText(row.updatedAt ?? row.updated_at),
  }
}

function readArchiveTaskSpaceSync(input: unknown): ArchiveTaskSpaceSync {
  const row = record(input)
  return {
    taskSpaceId: text(row.taskSpaceId ?? row.task_space_id),
    projectId: text(row.projectId ?? row.project_id),
    projectName: text(row.projectName ?? row.project_name),
    remoteUrl: text(row.remoteUrl ?? row.remote_url),
    origin: optionalText(row.origin),
    branchName: text(row.branchName ?? row.branch_name),
    credentialState: text(row.credentialState ?? row.credential_state, 'missing'),
    credential: row.credential ? readArchiveGitCredential(row.credential) : null,
    status: text(row.status, 'idle'),
    lastAttemptAt: optionalText(row.lastAttemptAt ?? row.last_attempt_at),
    lastSuccessAt: optionalText(row.lastSuccessAt ?? row.last_success_at),
    lastIndexedAt: optionalText(row.lastIndexedAt ?? row.last_indexed_at),
    lastError: optionalText(row.lastError ?? row.last_error),
    remoteHead: optionalText(row.remoteHead ?? row.remote_head),
    fileCount: Number(row.fileCount ?? row.file_count ?? 0) || 0,
    byteCount: Number(row.byteCount ?? row.byte_count ?? 0) || 0,
    archiveRevision: Number(row.archiveRevision ?? row.archive_revision ?? 0) || 0,
    archiveIndexedRevision:
      Number(row.archiveIndexedRevision ?? row.archive_indexed_revision ?? 0) || 0,
    failureCount: Number(row.failureCount ?? row.failure_count ?? 0) || 0,
    nextAttemptAt: optionalText(row.nextAttemptAt ?? row.next_attempt_at),
  }
}

export function readArchiveSyncOverview(input: unknown): ArchiveSyncOverview {
  const row = record(input)
  return {
    config: readArchiveSyncConfig(row.config),
    credentials: rows(row.credentials).map(readArchiveGitCredential),
    taskSpaces: rows(row.taskSpaces ?? row.task_spaces).map(readArchiveTaskSpaceSync),
  }
}

function readArchiveSyncLog(input: unknown): ArchiveSyncLog {
  const row = record(input)
  return {
    id: Number(row.id ?? 0) || 0,
    taskSpaceId: text(row.taskSpaceId ?? row.task_space_id),
    attemptId: text(row.attemptId ?? row.attempt_id),
    phase: text(row.phase),
    level: text(row.level, 'error'),
    errorCode: text(row.errorCode ?? row.error_code),
    message: text(row.message),
    detail: record(row.detail),
    createdAt: optionalText(row.createdAt ?? row.created_at),
  }
}

function auditQuery(beforeId: number | null, limit = AUDIT_PAGE_LIMIT): string {
  const cursor = beforeId ? `&beforeId=${encodeURIComponent(String(beforeId))}` : ''
  return `?limit=${limit}${cursor}`
}

function teamQuery(teamId?: string | null): string {
  const value = teamId?.trim()
  return value ? `?teamId=${encodeURIComponent(value)}` : ''
}

export async function fetchRuntime(): Promise<Runtime> {
  const { data } = await requestJson<unknown>('/api/runtime')
  return readRuntime(data)
}

export async function fetchAdminTeams(): Promise<Team[]> {
  const { data } = await requestJson<unknown>('/api/admin/teams')
  return collection(data, 'teams', readTeam)
}

export async function createTeam(name: string, slug?: string): Promise<Team | null> {
  const { data } = await requestJson<unknown>('/api/admin/teams', {
    method: 'POST',
    body: { name, slug: slug?.trim() || undefined },
  })
  return record(data).team ? readTeam(record(data).team) : null
}

export async function updateTeam(
  teamId: string,
  updates: { name?: string; status?: string },
): Promise<Team | null> {
  const { data } = await requestJson<unknown>(`/api/admin/teams/${encodeURIComponent(teamId)}`, {
    method: 'PATCH',
    body: updates,
  })
  return record(data).team ? readTeam(record(data).team) : null
}

export async function fetchTeamDetail(
  teamId: string,
): Promise<{ team: Team | null; members: TeamMember[] }> {
  const { data } = await requestJson<unknown>(`/api/admin/teams/${encodeURIComponent(teamId)}`)
  const row = record(data)
  return {
    team: record(row.team).id ? readTeam(record(row.team)) : null,
    members: rows(record(row.team).members).map(readTeamMember),
  }
}

export async function saveUserTeams(
  userId: string,
  teams: { teamId: string; role: string }[],
): Promise<Team[]> {
  const { data } = await requestJson<unknown>(
    `/api/admin/users/${encodeURIComponent(userId)}/teams`,
    { method: 'PUT', body: { teams } },
  )
  return rows(record(data).teams).map(readTeam)
}

export async function fetchUsers(teamId?: string | null): Promise<AdminUser[]> {
  const { data } = await requestJson<unknown>(`/api/admin/users${teamQuery(teamId)}`)
  return collection(data, 'users', readAdminUser)
}

export async function fetchAdminProjects(teamId?: string | null): Promise<TeamProject[]> {
  const { data } = await requestJson<unknown>(`/api/admin/projects${teamQuery(teamId)}`)
  return collection(data, 'projects', readTeamProject)
}

export async function fetchDevices(teamId?: string | null): Promise<AgentDevice[]> {
  const { data } = await requestJson<unknown>(`/api/admin/agents${teamQuery(teamId)}`)
  return collection(data, 'agents', readAgentDevice)
}

export type NewUserInput = {
  username: string
  displayName: string
  password: string
  teamIds: string[]
  systemAdmin: boolean
}

export async function createUser(input: NewUserInput): Promise<AdminUser | null> {
  const { data } = await requestJson<unknown>('/api/admin/users', {
    method: 'POST',
    body: {
      username: input.username,
      displayName: input.displayName,
      password: input.password,
      teamIds: input.teamIds,
      systemAdmin: input.systemAdmin,
    },
  })
  const row = record(data)
  return row.user ? readAdminUser(row.user) : null
}

export type UserUpdate = {
  displayName?: string
  status?: string
  systemAdmin?: boolean
  teamIds?: string[]
}

export async function updateUser(userId: string, updates: UserUpdate): Promise<AdminUser> {
  const { data } = await requestJson<unknown>(`/api/admin/users/${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    body: updates,
  })
  const row = record(data)
  return readAdminUser(row.user ?? data)
}

export async function resetUserPassword(userId: string, password: string): Promise<void> {
  await requestJson<unknown>(`/api/admin/users/${encodeURIComponent(userId)}/reset-password`, {
    method: 'POST',
    body: { password },
  })
}

export async function fetchMembers(projectId: string): Promise<ProjectMember[]> {
  const { data } = await requestJson<unknown>(
    `/api/projects/${encodeURIComponent(projectId)}/members`,
  )
  return readProjectMembers(record(data))
}

export type MemberInput = {
  userId: string
  role: string
  trellisDevId: string | null
}

export async function saveMember(projectId: string, input: MemberInput): Promise<ProjectMember[]> {
  const { data } = await requestJson<unknown>(
    `/api/projects/${encodeURIComponent(projectId)}/members`,
    {
      method: 'PUT',
      body: input,
    },
  )
  return readProjectMembers(record(data))
}

export async function removeMember(projectId: string, userId: string): Promise<ProjectMember[]> {
  const { data } = await requestJson<unknown>(
    `/api/projects/${encodeURIComponent(projectId)}/members?userId=${encodeURIComponent(userId)}`,
    { method: 'DELETE' },
  )
  return readProjectMembers(record(data))
}

export async function fetchBindings(projectId: string): Promise<AgentBinding[]> {
  const { data } = await requestJson<unknown>(
    `/api/projects/${encodeURIComponent(projectId)}/agents`,
  )
  return collection(data, 'agents', readAgentBinding)
}

export async function fetchProjectTaskSpaces(projectId: string): Promise<AdminTaskSpace[]> {
  const { data } = await requestJson<unknown>(
    `/api/projects/${encodeURIComponent(projectId)}/task-spaces`,
  )
  return collection(data, 'taskSpaces', readTaskSpace)
}

export type TaskSpaceLifecycleMutation = {
  taskSpace: AdminTaskSpace
  affectedBindingCount: number
}

export async function retireProjectTaskSpace(
  projectId: string,
  taskSpaceId: string,
  reason = '',
): Promise<TaskSpaceLifecycleMutation> {
  const { data } = await requestJson<unknown>(
    `/api/projects/${encodeURIComponent(projectId)}/task-spaces/${encodeURIComponent(taskSpaceId)}/retire`,
    { method: 'POST', body: { reason: reason.trim() || undefined } },
  )
  const row = record(record(data).taskSpace ?? data)
  return {
    taskSpace: readTaskSpace(record(row)),
    affectedBindingCount: Number(row.affectedBindingCount ?? row.affected_binding_count ?? 0) || 0,
  }
}

export async function restoreProjectTaskSpace(
  projectId: string,
  taskSpaceId: string,
): Promise<TaskSpaceLifecycleMutation> {
  const { data } = await requestJson<unknown>(
    `/api/projects/${encodeURIComponent(projectId)}/task-spaces/${encodeURIComponent(taskSpaceId)}/restore`,
    { method: 'POST', body: {} },
  )
  return {
    taskSpace: readTaskSpace(record(record(data).taskSpace ?? data)),
    affectedBindingCount: 0,
  }
}

export type PurgeTaskSpaceResult = {
  taskSpaceId: string
  branchName: string
  backupName: string
  summary: Record<string, unknown>
}

export async function purgeProjectTaskSpace(
  projectId: string,
  taskSpaceId: string,
  confirmation: string,
): Promise<PurgeTaskSpaceResult> {
  const { data } = await requestJson<unknown>(
    `/api/projects/${encodeURIComponent(projectId)}/task-spaces/${encodeURIComponent(taskSpaceId)}`,
    { method: 'DELETE', body: { confirmation } },
  )
  const row = record(data)
  const summary = record(row.summary)
  return {
    taskSpaceId: text(row.taskSpaceId ?? row.task_space_id ?? taskSpaceId),
    branchName: text(row.branchName ?? row.branch_name ?? confirmation),
    backupName: text(row.backupName ?? row.backup_name),
    summary,
  }
}

export async function fetchProjectTeams(projectId: string): Promise<ProjectTeamAccess[]> {
  const { data } = await requestJson<unknown>(
    `/api/projects/${encodeURIComponent(projectId)}/team-access`,
  )
  return collection(data, 'teams', (value) => {
    const row = record(value)
    return {
      projectId: optionalText(row.projectId) || '',
      teamId: optionalText(row.teamId) || '',
      teamName: optionalText(row.teamName) || '未知团队',
      teamStatus: optionalText(row.teamStatus) || 'unknown',
      accessRole: optionalText(row.accessRole) || 'member',
      createdAt: optionalText(row.createdAt),
    }
  }).filter((item) => item.projectId && item.teamId)
}

export async function inviteProjectTeam(
  projectId: string,
  teamId: string,
  accessRole = 'member',
): Promise<void> {
  await requestJson(`/api/projects/${encodeURIComponent(projectId)}/team-access`, {
    method: 'POST',
    body: { teamId, accessRole },
  })
}

export async function removeProjectTeam(projectId: string, teamId: string): Promise<void> {
  await requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/team-access?teamId=${encodeURIComponent(teamId)}`,
    { method: 'DELETE' },
  )
}

export type BindingAction = 'approve' | 'reject' | 'revoke'

export async function runBindingAction(
  projectId: string,
  bindingId: string,
  action: BindingAction,
): Promise<{ commandQueued: boolean }> {
  const { data } = await requestJson<unknown>(
    `/api/projects/${encodeURIComponent(projectId)}/agents/${encodeURIComponent(bindingId)}/${action}`,
    { method: 'POST', body: {} },
  )
  return { commandQueued: flag(record(data).commandQueued) }
}

export async function fetchProjectAudit(
  projectId: string,
  beforeId: number | null,
): Promise<AuditEvent[]> {
  const { data } = await requestJson<unknown>(
    `/api/projects/${encodeURIComponent(projectId)}/audit${auditQuery(beforeId)}`,
  )
  return collection(data, 'events', readAuditEvent)
}

export async function fetchSystemAudit(
  beforeId: number | null,
  teamId?: string | null,
): Promise<AuditEvent[]> {
  const query = new URLSearchParams({ limit: String(AUDIT_PAGE_LIMIT) })
  if (beforeId) query.set('beforeId', String(beforeId))
  if (teamId?.trim()) query.set('teamId', teamId.trim())
  const { data } = await requestJson<unknown>(`/api/admin/audit?${query}`)
  return collection(data, 'events', readAuditEvent)
}

export async function createPairingCode(teamId?: string | null): Promise<{
  pairingCode: string | null
  expiresAt: string | null
}> {
  const { data } = await requestJson<unknown>('/api/team/pairing-codes', {
    method: 'POST',
    body: { teamId: teamId?.trim() || undefined },
  })
  const row = record(data)
  return {
    pairingCode: optionalText(row.pairingCode),
    expiresAt: optionalText(row.expiresAt),
  }
}

export async function createDesktopEnrollToken(): Promise<{
  token: string | null
  expiresAt: string | null
}> {
  const { data } = await requestJson<unknown>('/api/desktop/enroll-tokens', {
    method: 'POST',
    body: {},
  })
  const row = record(data)
  return {
    token: optionalText(row.token),
    expiresAt: optionalText(row.expiresAt),
  }
}

export async function revokeDevice(deviceId: string, teamId?: string | null): Promise<void> {
  await requestJson(`/api/admin/agents/${encodeURIComponent(deviceId)}/revoke`, {
    method: 'POST',
    body: { teamId: teamId?.trim() || undefined },
  })
}

export async function fetchArchiveSync(): Promise<ArchiveSyncOverview> {
  const { data } = await requestJson<unknown>('/api/admin/archive-sync')
  return readArchiveSyncOverview(data)
}

export async function updateArchiveSyncConfig(input: {
  enabled?: boolean
  intervalSeconds?: number
}): Promise<ArchiveSyncConfig> {
  const { data } = await requestJson<unknown>('/api/admin/archive-sync/config', {
    method: 'PATCH',
    body: input,
  })
  return readArchiveSyncConfig(record(data).config ?? data)
}

export type ArchiveCredentialInput = {
  name: string
  scheme: 'ssh' | 'https'
  host: string
  port: number
  username?: string
  token?: string
  privateKey?: string
}

export async function createArchiveSyncCredential(
  input: ArchiveCredentialInput,
): Promise<ArchiveGitCredential> {
  const { data } = await requestJson<unknown>('/api/admin/archive-sync/credentials', {
    method: 'POST',
    body: { ...input, authType: input.scheme === 'ssh' ? 'ssh_key' : 'https_token' },
  })
  return readArchiveGitCredential(record(data).credential ?? data)
}

export async function updateArchiveSyncCredential(
  credentialId: string,
  input: Partial<ArchiveCredentialInput>,
): Promise<ArchiveGitCredential> {
  const { data } = await requestJson<unknown>(
    `/api/admin/archive-sync/credentials/${encodeURIComponent(credentialId)}`,
    { method: 'PATCH', body: input },
  )
  return readArchiveGitCredential(record(data).credential ?? data)
}

export async function deleteArchiveSyncCredential(credentialId: string): Promise<void> {
  await requestJson(`/api/admin/archive-sync/credentials/${encodeURIComponent(credentialId)}`, {
    method: 'DELETE',
    body: {},
  })
}

export async function testArchiveSyncCredential(credentialId: string): Promise<{
  branchFound: boolean
  branchName: string
  taskSpaceId: string
}> {
  const { data } = await requestJson<unknown>(
    `/api/admin/archive-sync/credentials/${encodeURIComponent(credentialId)}/test`,
    { method: 'POST', body: {} },
  )
  const row = record(data)
  return {
    branchFound: flag(row.branchFound ?? row.branch_found),
    branchName: text(row.branchName ?? row.branch_name),
    taskSpaceId: text(row.taskSpaceId ?? row.task_space_id),
  }
}

export async function runArchiveSync(taskSpaceId?: string | null): Promise<number> {
  const { data } = await requestJson<unknown>('/api/admin/archive-sync/run', {
    method: 'POST',
    body: { taskSpaceId: taskSpaceId?.trim() || undefined },
  })
  return Number(record(data).queued ?? 0) || 0
}

export async function fetchArchiveSyncLogs(
  taskSpaceId: string,
  beforeId: number | null,
): Promise<{ logs: ArchiveSyncLog[]; nextBeforeId: number | null }> {
  const query = new URLSearchParams({ limit: '20' })
  if (beforeId) query.set('beforeId', String(beforeId))
  const { data } = await requestJson<unknown>(
    `/api/admin/archive-sync/task-spaces/${encodeURIComponent(taskSpaceId)}/logs?${query}`,
  )
  const row = record(data)
  return {
    logs: rows(row.logs).map(readArchiveSyncLog),
    nextBeforeId: row.nextBeforeId == null ? null : Number(row.nextBeforeId) || null,
  }
}

export async function logout(): Promise<void> {
  await requestJson('/api/auth/logout', { method: 'POST', body: {} })
}
