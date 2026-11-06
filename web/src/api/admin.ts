import { ApiError, requestJson } from './request'
import { redactSensitiveDetail } from '@/lib/team-client.js'

export const AUDIT_PAGE_LIMIT = 100

export type AdminView = 'project-access' | 'users' | 'teams' | 'projects' | 'agents' | 'audit'

export type SessionUser = {
  id: string
  username: string
  displayName: string
  systemAdmin: boolean
  status: string
  mustChangePassword: boolean
}

export type RuntimeProject = {
  id: string
  name: string
  syncStatus: string
  syncBranch: string
  role: string | null
  stale: boolean
  lastError: string | null
  capabilities: Record<string, unknown>
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
  scriptsSha256: string | null
  hooksStatus: string | null
  lastFetchAt: string | null
  lastPushAt: string | null
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

export type Runtime = {
  mode: 'team' | 'standalone'
  team: boolean
  authenticated: boolean
  user: SessionUser | null
  systemAdmin: boolean
  activeTeamId: string | null
  activeTeam: Team | null
  teamRole: string | null
  teams: Team[]
  projects: RuntimeProject[]
}

export type ApprovalDraft = {
  toolchainSha256: string | null
  files: string[] | number | null
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
    mustChangePassword: flag(row.mustChangePassword ?? row.must_change_password)
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
    projectCount: Number(row.projectCount ?? row.project_count ?? 0) || 0
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
    role: text(row.role ?? row.teamRole ?? row.team_role, 'member')
  }
}

function readRuntimeProject(input: unknown): RuntimeProject {
  const row = record(input)
  const syncStatus = text(row.syncStatus ?? row.sync_status, 'unknown')
  return {
    id: text(row.id ?? row.repositoryId ?? row.repository_id),
    name: text(row.name ?? row.repositoryName ?? row.repository_name),
    syncStatus,
    syncBranch: text(row.syncBranch ?? row.sync_branch),
    role: optionalText(row.role ?? row.projectRole ?? row.project_role),
    stale: flag(row.stale) || ['stale', 'pending_push', 'needs_repair'].includes(syncStatus),
    lastError: optionalText(row.lastError ?? row.last_error),
    capabilities: record(row.capabilities ?? row.permissions)
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
      status: 'active'
    }
  }
  const row = record(input)
  return {
    userId: optionalText(row.userId ?? row.user_id ?? row.id),
    username: text(row.username),
    displayName: text(row.displayName ?? row.display_name, text(row.username)),
    trellisDevId: optionalText(row.trellisDevId ?? row.trellis_dev_id),
    role: optionalText(row.role),
    status: text(row.status, 'active')
  }
}

export function readProjectMembers(source: Record<string, unknown>): ProjectMember[] {
  const seen = new Set<string>()
  const members: ProjectMember[] = []
  for (const item of [
    ...rows(source.members),
    ...rows(source.validAssignees),
    ...rows(source.valid_assignees),
    ...rows(source.assignees)
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
    scriptsSha256: optionalText(row.trustedToolchainSha256 ?? row.trusted_task_toolchain_sha256),
    hooksStatus: optionalText(row.hooksStatus ?? row.hooks_status),
    lastFetchAt: optionalText(row.lastFetchAt ?? row.last_fetch_at),
    lastPushAt: optionalText(row.lastPushAt ?? row.last_push_at),
    members: readProjectMembers(row)
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
    activeTeamId: optionalText(row.activeTeamId ?? row.active_team_id),
    activeTeam: row.activeTeam || row.active_team
      ? readTeam(row.activeTeam ?? row.active_team)
      : null,
    teamRole: optionalText(row.teamRole ?? row.team_role),
    teams: rows(row.teams).map(readTeam),
    projects: rows(row.projects ?? row.items).map(readRuntimeProject)
  }
}

function readAdminUser(input: unknown): AdminUser {
  const row = record(input)
  return {
    ...readSessionUser(row),
    passwordChangedAt: optionalText(row.passwordChangedAt ?? row.password_changed_at),
    createdAt: optionalText(row.createdAt ?? row.created_at),
    teams: rows(row.teams).map(readTeam)
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
    revokedAt: optionalText(row.revokedAt ?? row.revoked_at)
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
    updatedAt: optionalText(row.updatedAt ?? row.updated_at)
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
    occurredAt: optionalText(row.occurredAt ?? row.occurred_at)
  }
}

function readApprovalFiles(value: unknown): string[] | number | null {
  if (typeof value === 'number') return value
  if (Array.isArray(value)) {
    const files = value.map((item) => text(item)).filter((item) => item.length > 0)
    return files.length > 0 ? files : null
  }
  return null
}

function auditQuery(beforeId: number | null, limit = AUDIT_PAGE_LIMIT): string {
  const cursor = beforeId ? `&beforeId=${encodeURIComponent(String(beforeId))}` : ''
  return `?limit=${limit}${cursor}`
}

export async function fetchRuntime(): Promise<Runtime> {
  const { data } = await requestJson<unknown>('/api/runtime')
  return readRuntime(data)
}

export async function switchTeam(teamId: string): Promise<Team | null> {
  const { data } = await requestJson<unknown>('/api/auth/team', {
    method: 'POST',
    body: { teamId }
  })
  return record(data).team ? readTeam(record(data).team) : null
}

export async function fetchAdminTeams(): Promise<Team[]> {
  const { data } = await requestJson<unknown>('/api/admin/teams')
  return collection(data, 'teams', readTeam)
}

export async function createTeam(name: string, slug?: string): Promise<Team | null> {
  const { data } = await requestJson<unknown>('/api/admin/teams', {
    method: 'POST',
    body: { name, slug: slug?.trim() || undefined }
  })
  return record(data).team ? readTeam(record(data).team) : null
}

export async function updateTeam(
  teamId: string,
  updates: { name?: string; status?: string }
): Promise<Team | null> {
  const { data } = await requestJson<unknown>(`/api/admin/teams/${encodeURIComponent(teamId)}`, {
    method: 'PATCH',
    body: updates
  })
  return record(data).team ? readTeam(record(data).team) : null
}

export async function fetchTeamDetail(
  teamId: string
): Promise<{ team: Team | null; members: TeamMember[] }> {
  const { data } = await requestJson<unknown>(`/api/admin/teams/${encodeURIComponent(teamId)}`)
  const row = record(data)
  return {
    team: record(row.team).id ? readTeam(record(row.team)) : null,
    members: rows(record(row.team).members).map(readTeamMember)
  }
}

export async function saveUserTeams(
  userId: string,
  teams: { teamId: string; role: string }[]
): Promise<Team[]> {
  const { data } = await requestJson<unknown>(
    `/api/admin/users/${encodeURIComponent(userId)}/teams`,
    { method: 'PUT', body: { teams } }
  )
  return rows(record(data).teams).map(readTeam)
}

export async function fetchUsers(): Promise<AdminUser[]> {
  const { data } = await requestJson<unknown>('/api/admin/users')
  return collection(data, 'users', readAdminUser)
}

export async function fetchAdminProjects(): Promise<TeamProject[]> {
  const { data } = await requestJson<unknown>('/api/admin/projects')
  return collection(data, 'projects', readTeamProject)
}

export async function fetchDevices(): Promise<AgentDevice[]> {
  const { data } = await requestJson<unknown>('/api/admin/agents')
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
      systemAdmin: input.systemAdmin
    }
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
    body: updates
  })
  const row = record(data)
  return readAdminUser(row.user ?? data)
}

export async function resetUserPassword(userId: string, password: string): Promise<void> {
  await requestJson<unknown>(
    `/api/admin/users/${encodeURIComponent(userId)}/reset-password`,
    { method: 'POST', body: { password } }
  )
}

export type ConnectProjectInput = {
  name: string
  syncBranch: string
  remoteUrl: string
  repositoryId?: string
}

export async function connectProject(
  input: ConnectProjectInput
): Promise<{ project: TeamProject; approval: ApprovalDraft | null }> {
  const { data } = await requestJson<unknown>('/api/admin/projects', {
    method: 'POST',
    body: {
      name: input.name,
      syncBranch: input.syncBranch,
      remoteUrl: input.remoteUrl,
      repositoryId: input.repositoryId?.trim() || undefined
    }
  })
  const row = record(data)
  const approval = record(row.approval)
  return {
    project: readTeamProject(row.project ?? {}),
    approval: row.approval
      ? {
          toolchainSha256: optionalText(approval.toolchainSha256),
          files: readApprovalFiles(approval.files)
        }
      : null
  }
}

export type ApprovalInput = {
  toolchainSha256: string
  leadUserId: string
  leadTrellisDevId: string
}

export type ApprovalResult = {
  project?: TeamProject
  result?: unknown
  warning?: { code?: string; message?: string; details?: Record<string, unknown> }
}

export async function approveProject(projectId: string, input: ApprovalInput): Promise<ApprovalResult> {
  const { data } = await requestJson<unknown>(`/api/admin/projects/${encodeURIComponent(projectId)}/approve`, {
    method: 'POST',
    body: input
  })
  const record = data && typeof data === 'object' ? (data as Record<string, unknown>) : {}
  const warning = record.warning && typeof record.warning === 'object'
    ? (record.warning as ApprovalResult['warning'])
    : undefined
  return { project: record.project as TeamProject | undefined, result: record.result, warning }
}

export type ProjectAction = 'refresh' | 'repair' | 'disable'

export async function runProjectAction(projectId: string, action: ProjectAction): Promise<void> {
  const encoded = encodeURIComponent(projectId)
  if (action === 'refresh') {
    await requestJson(`/api/projects/${encoded}/refresh`, { method: 'POST', body: { force: false } })
    return
  }
  await requestJson(`/api/admin/projects/${encoded}/${action}`, { method: 'POST', body: {} })
}

export async function fetchMembers(projectId: string): Promise<ProjectMember[]> {
  const { data } = await requestJson<unknown>(`/api/projects/${encodeURIComponent(projectId)}/members`)
  return readProjectMembers(record(data))
}

export type MemberInput = {
  userId: string
  role: string
  trellisDevId: string | null
}

export async function saveMember(projectId: string, input: MemberInput): Promise<ProjectMember[]> {
  const { data } = await requestJson<unknown>(`/api/projects/${encodeURIComponent(projectId)}/members`, {
    method: 'PUT',
    body: input
  })
  return readProjectMembers(record(data))
}

export async function removeMember(projectId: string, userId: string): Promise<ProjectMember[]> {
  const { data } = await requestJson<unknown>(
    `/api/projects/${encodeURIComponent(projectId)}/members?userId=${encodeURIComponent(userId)}`,
    { method: 'DELETE' }
  )
  return readProjectMembers(record(data))
}

export async function fetchBindings(projectId: string): Promise<AgentBinding[]> {
  const { data } = await requestJson<unknown>(`/api/projects/${encodeURIComponent(projectId)}/agents`)
  return collection(data, 'agents', readAgentBinding)
}

export type BindingAction = 'approve' | 'reject' | 'revoke'

export async function runBindingAction(
  projectId: string,
  bindingId: string,
  action: BindingAction
): Promise<{ commandQueued: boolean }> {
  const { data } = await requestJson<unknown>(
    `/api/projects/${encodeURIComponent(projectId)}/agents/${encodeURIComponent(bindingId)}/${action}`,
    { method: 'POST', body: {} }
  )
  return { commandQueued: flag(record(data).commandQueued) }
}

export async function fetchProjectAudit(
  projectId: string,
  beforeId: number | null
): Promise<AuditEvent[]> {
  const { data } = await requestJson<unknown>(
    `/api/projects/${encodeURIComponent(projectId)}/audit${auditQuery(beforeId)}`
  )
  return collection(data, 'events', readAuditEvent)
}

export async function fetchSystemAudit(beforeId: number | null): Promise<AuditEvent[]> {
  const { data } = await requestJson<unknown>(`/api/admin/audit${auditQuery(beforeId)}`)
  return collection(data, 'events', readAuditEvent)
}

export async function createPairingCode(): Promise<{
  pairingCode: string | null
  expiresAt: string | null
}> {
  const { data } = await requestJson<unknown>('/api/team/pairing-codes', {
    method: 'POST',
    body: {}
  })
  const row = record(data)
  return {
    pairingCode: optionalText(row.pairingCode),
    expiresAt: optionalText(row.expiresAt)
  }
}

export async function createDesktopEnrollToken(): Promise<{
  token: string | null
  expiresAt: string | null
}> {
  const { data } = await requestJson<unknown>('/api/desktop/enroll-tokens', {
    method: 'POST',
    body: {}
  })
  const row = record(data)
  return {
    token: optionalText(row.token),
    expiresAt: optionalText(row.expiresAt)
  }
}

export async function revokeDevice(deviceId: string): Promise<void> {
  await requestJson(`/api/admin/agents/${encodeURIComponent(deviceId)}/revoke`, {
    method: 'POST',
    body: {}
  })
}

export async function logout(): Promise<void> {
  await requestJson('/api/auth/logout', { method: 'POST', body: {} })
}
