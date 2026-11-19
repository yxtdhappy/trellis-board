import { redactSensitiveDetail } from '@/lib/team-client.js'

import type {
  AdminTaskSpace,
  AdminUser,
  AgentBinding,
  AgentDevice,
  ArchiveGitCredential,
  ArchiveSyncConfig,
  ArchiveSyncLog,
  ArchiveSyncOverview,
  ArchiveTaskSpaceSync,
  AuditEvent,
  ProjectMember,
  Runtime,
  RuntimeProject,
  SessionUser,
  TaskSpaceLifecycleStatus,
  Team,
  TeamMember,
  TeamProject,
} from './types.ts'

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

function teamQuery(teamId?: string | null): string {
  const value = teamId?.trim()
  return value ? `?teamId=${encodeURIComponent(value)}` : ''
}

export {
  collection,
  flag,
  optionalText,
  readAdminUser,
  readAgentBinding,
  readAgentDevice,
  readArchiveSyncConfig,
  readArchiveSyncLog,
  readAuditEvent,
  readTeam,
  readTeamMember,
  record,
  rows,
  teamQuery,
  text,
}
