export const TEAM_PAGE_LIMIT = 100

export function createIdempotencyKey(cryptoApi = globalThis.crypto) {
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID()
  if (typeof cryptoApi?.getRandomValues === 'function') {
    return Array.from(cryptoApi.getRandomValues(new Uint8Array(16)), (value) =>
      value.toString(16).padStart(2, '0'),
    ).join('')
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

const ARRAY_FILTERS = [
  ['projectIds', 'projectIds'],
  ['priorities', 'priorities'],
  ['stages', 'stages'],
  ['tags', 'tags'],
]

function existingValue(source, camel, snake) {
  if (source?.[camel] != null) return source[camel]
  return source?.[snake]
}

function boolean(value) {
  return value === true || value === 1 || value === '1' || value === 'true'
}

function list(payload, ...keys) {
  for (const key of keys) {
    const value = payload?.[key]
    if (Array.isArray(value)) return value
  }
  return Array.isArray(payload) ? payload : []
}

export function normalizeUser(payload) {
  const source = payload?.user ?? payload ?? {}
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null
  return {
    id: source.id ?? source.userId ?? source.user_id ?? null,
    username: source.username ?? '',
    displayName: source.displayName ?? source.display_name ?? source.username ?? '',
    systemAdmin: boolean(source.systemAdmin ?? source.system_admin),
    status: source.status ?? 'active',
    mustChangePassword: boolean(source.mustChangePassword ?? source.must_change_password),
    role: source.role ?? null,
  }
}

export function normalizeRuntime(payload = {}) {
  const source = payload?.runtime ?? payload ?? {}
  const mode = String(
    source.mode ?? source.boardMode ?? source.board_mode ?? 'standalone',
  ).toLowerCase()
  const user = normalizeUser(source.user ?? source.currentUser ?? source.current_user)
  return {
    mode: mode === 'team' ? 'team' : 'standalone',
    team: boolean(source.team ?? source.teamMode ?? source.team_mode) || mode === 'team',
    authenticated: source.authenticated !== false,
    user,
    systemAdmin: boolean(source.systemAdmin ?? source.system_admin) || Boolean(user?.systemAdmin),
    capabilities: source.capabilities ?? {},
    teams: Array.isArray(source.teams)
      ? source.teams
          .map((team) => ({
            id: String(team?.id ?? ''),
            name: String(team?.name ?? team?.id ?? ''),
            role: team?.role ?? null,
            status: team?.status ?? 'active',
          }))
          .filter((team) => team.id)
      : [],
    projects: normalizeTeamProjects(source.projects ?? source.items ?? []),
    raw: source,
  }
}

export function normalizeProjectMembers(project = {}) {
  const rows = [
    ...(Array.isArray(project.members) ? project.members : []),
    ...(Array.isArray(project.validAssignees) ? project.validAssignees : []),
    ...(Array.isArray(project.valid_assignees) ? project.valid_assignees : []),
    ...(Array.isArray(project.assignees) ? project.assignees : []),
  ]
  const seen = new Set()
  return rows
    .map((member) => {
      if (typeof member === 'string') {
        return {
          userId: null,
          username: member,
          displayName: member,
          trellisDevId: member,
          role: null,
          status: 'active',
        }
      }
      return {
        userId: member?.userId ?? member?.user_id ?? member?.id ?? null,
        username: member?.username ?? '',
        displayName: member?.displayName ?? member?.display_name ?? member?.username ?? '',
        trellisDevId: member?.trellisDevId ?? member?.trellis_dev_id ?? null,
        role: member?.role ?? null,
        status: member?.status ?? 'active',
      }
    })
    .filter((member) => {
      const key = member.userId || member.trellisDevId || member.username || member.displayName
      if (!key || seen.has(key)) return false
      seen.add(key)
      return true
    })
}

export function normalizeTeamProject(project = {}) {
  const id = project.id ?? project.repositoryId ?? project.repository_id ?? ''
  const taskSpaces = Array.isArray(project.taskSpaces)
    ? project.taskSpaces.map((taskSpace) => ({
        ...taskSpace,
        id: String(taskSpace?.id ?? ''),
        projectId: String(taskSpace?.projectId ?? taskSpace?.project_id ?? id),
        branchName: String(taskSpace?.branchName ?? taskSpace?.branch_name ?? ''),
        revision: Number(taskSpace?.revision ?? 0),
        indexedRevision: Number(taskSpace?.indexedRevision ?? taskSpace?.indexed_revision ?? 0),
        readOnly: taskSpace?.readOnly === true,
      }))
    : []
  return {
    ...project,
    id: String(id),
    repositoryId: String(project.repositoryId ?? project.repository_id ?? id),
    name: project.name ?? project.repositoryName ?? project.repository_name ?? String(id),
    teamId: project.teamId ?? project.team_id ?? null,
    teamName: project.teamName ?? project.team_name ?? null,
    syncBranch: project.syncBranch ?? project.sync_branch ?? '',
    syncStatus: project.syncStatus ?? project.sync_status ?? 'unknown',
    role: project.role ?? project.projectRole ?? project.project_role ?? null,
    trellisDevId: project.trellisDevId ?? project.trellis_dev_id ?? null,
    boardVersion: project.boardVersion ?? project.board_version ?? null,
    activeCount: Number(
      project.activeCount ?? project.active_count ?? project.taskCount ?? project.task_count ?? 0,
    ),
    archivedCount: Number(project.archivedCount ?? project.archived_count ?? 0),
    stale:
      boolean(project.stale) ||
      ['stale', 'needs_repair'].includes(project.syncStatus ?? project.sync_status),
    lastError:
      project.lastError ?? project.last_error ?? project.syncError ?? project.sync_error ?? null,
    members: normalizeProjectMembers(project),
    taskSpaces,
  }
}

export function normalizeTeamProjects(payload) {
  const value = payload?.projects ?? payload?.items ?? payload
  return Array.isArray(value) ? value.map(normalizeTeamProject).filter((item) => item.id) : []
}

export function normalizeTaskPage(payload = {}) {
  const source = payload?.page ?? payload ?? {}
  const tasks = source.tasks ?? source.items ?? source.rows
  return {
    tasks: Array.isArray(tasks) ? tasks.map(normalizeTeamTaskRow) : [],
    assignees: Array.isArray(source.assignees) ? source.assignees.map(String) : [],
    nextCursor: existingValue(source, 'nextCursor', 'next_cursor') ?? null,
    total: Number(existingValue(source, 'total', 'total_count') ?? 0),
    queryRevision: existingValue(source, 'queryRevision', 'query_revision') ?? null,
    queryDay: existingValue(source, 'queryDay', 'query_day') ?? null,
    summary: source.summary ?? {},
    raw: source,
  }
}

export function normalizeTeamTaskRow(row = {}) {
  const relativeDir = row.relativeDir ?? row.relative_dir ?? ''
  return {
    ...row,
    taskKey: row.taskKey ?? row.task_key ?? '',
    executionTaskKey:
      row.executionTaskKey ?? row.execution_task_key ?? row.taskKey ?? row.task_key ?? '',
    taskVersion: taskVersion(row),
    assignmentVersion: assignmentVersion(row),
    projectId: String(row.projectId ?? row.project_id ?? ''),
    taskSpaceId: String(row.taskSpaceId ?? row.task_space_id ?? ''),
    projectName: row.projectName ?? row.project_name ?? '',
    branchName: row.branchName ?? row.branch_name ?? '',
    taskSpaceRevision: Number(row.taskSpaceRevision ?? row.task_space_revision ?? 0),
    teamId: row.teamId ?? row.team_id ?? null,
    teamName: row.teamName ?? row.team_name ?? null,
    relativeDir,
    dirName:
      row.dirName ??
      row.dir_name ??
      relativeDir.replaceAll('\\', '/').split('/').filter(Boolean).pop() ??
      '',
    title: row.title ?? '',
    priority: row.priority ?? '',
    derivedStage: row.derivedStage ?? row.derived_stage ?? '',
    archived: boolean(row.archived),
    archivedAt: row.archivedAt ?? row.archived_at ?? null,
    assignee: row.assigneeDevId ?? row.assignee_dev_id ?? row.assignee ?? '',
    assigneeDevId: row.assigneeDevId ?? row.assignee_dev_id ?? row.assignee ?? '',
    assigneeUserId: row.assigneeUserId ?? row.assignee_user_id ?? null,
    dueDate: row.dueDate ?? row.due_date ?? null,
    lastActivityAt: row.lastActivityAt ?? row.last_activity_at ?? null,
    isBlocked: boolean(row.isBlocked ?? row.is_blocked),
    isUnblockedReady: boolean(row.isUnblockedReady ?? row.is_unblocked_ready),
    attentionReasons: row.attentionReasons ?? row.attention_reasons ?? [],
    groupKey: row.groupKey ?? row.group_key ?? null,
    groupRole: row.groupRole ?? row.group_role ?? null,
    projectSyncStatus: row.projectSyncStatus ?? row.project_sync_status ?? 'unknown',
    stale: boolean(row.stale),
    syncError: row.syncError ?? row.sync_error ?? null,
    stages: Array.isArray(row.stages) ? row.stages : [],
    artifacts: row.artifacts,
    execution: row.execution || {},
  }
}

export function normalizeBoardPage(payload = {}) {
  const source = payload?.board ?? payload ?? {}
  const tasks =
    source.tasks ?? payload.tasks ?? source.items ?? payload.items ?? source.rows ?? payload.rows
  const nextCursor =
    existingValue(source, 'nextCursor', 'next_cursor') ??
    existingValue(payload, 'nextCursor', 'next_cursor') ??
    null
  const total =
    existingValue(source, 'total', 'total_count') ??
    existingValue(payload, 'total', 'total_count') ??
    tasks?.length ??
    0
  return {
    ...source,
    tasks: Array.isArray(tasks) ? tasks : [],
    projects: Array.isArray(source.projects) ? source.projects.map(normalizeTeamProject) : [],
    nextCursor,
    total: Number(total),
    boardVersion: existingValue(source, 'boardVersion', 'board_version') ?? null,
    queryRevision:
      existingValue(source, 'queryRevision', 'query_revision') ??
      existingValue(payload, 'queryRevision', 'query_revision') ??
      null,
    queryDay:
      existingValue(source, 'queryDay', 'query_day') ??
      existingValue(payload, 'queryDay', 'query_day') ??
      null,
    savedViews: source.savedViews ?? source.saved_views ?? [],
    raw: source,
  }
}

export function normalizeAssignments(payload = {}) {
  const value = payload?.assignments ?? payload?.tasks ?? payload?.items ?? payload
  return Array.isArray(value)
    ? value.map((row) => ({
        ...row,
        executionTaskKey:
          row.executionTaskKey ?? row.execution_task_key ?? row.taskKey ?? row.task_key ?? '',
        assignmentVersion: assignmentVersion(row),
        assignmentState:
          row.assignmentState ?? row.assignment_state ?? row.state ?? row.assignment?.state ?? null,
      }))
    : []
}

export function normalizeOperation(payload = {}) {
  const operation = payload?.operation ?? payload
  return {
    id: existingValue(operation, 'id', 'id') ?? null,
    status: existingValue(operation, 'status', 'status') ?? null,
    code: existingValue(operation, 'code', 'code') ?? null,
    error: existingValue(operation, 'error', 'error') ?? null,
    commandType: existingValue(operation, 'commandType', 'command_type') ?? null,
    taskSpaceId: existingValue(operation, 'taskSpaceId', 'task_space_id') ?? null,
    taskKey:
      existingValue(operation, 'taskKey', 'task_key') ??
      operation?.result?.executionTaskKey ??
      null,
    projectId: existingValue(operation, 'projectId', 'project_id') ?? null,
    result: operation?.result ?? {},
    raw: operation,
  }
}

export function normalizeTeamStatus(payload = {}) {
  const source = payload?.status ?? payload?.teamStatus ?? payload?.team_status ?? payload ?? {}
  const projects = normalizeTeamProjects(source.projects ?? source.items ?? [])
  const boardVersions =
    source.boardVersions ??
    source.board_versions ??
    Object.fromEntries(projects.map((project) => [project.id, project.boardVersion]))
  return {
    ...source,
    projects,
    boardVersions,
    queryRevision: source.queryRevision ?? source.query_revision ?? null,
    queryDay: source.queryDay ?? source.query_day ?? null,
    pendingAssignments: Number(
      source.pendingAssignments ??
        source.pending_assignments ??
        source.assignments?.pending ??
        source.assignmentCount ??
        0,
    ),
    updatedAt: source.updatedAt ?? source.updated_at ?? null,
    raw: source,
  }
}

export function normalizeAdminUser(row = {}) {
  return {
    ...normalizeUser(row),
    passwordChangedAt: row.passwordChangedAt ?? row.password_changed_at ?? null,
    createdAt: row.createdAt ?? row.created_at ?? null,
    updatedAt: row.updatedAt ?? row.updated_at ?? null,
  }
}

export function normalizeAgentDevice(row = {}) {
  return {
    id: row.id ?? '',
    userId: row.userId ?? row.user_id ?? null,
    username: row.username ?? '',
    displayName: row.displayName ?? row.display_name ?? row.username ?? '',
    deviceName: row.deviceName ?? row.device_name ?? '未命名设备',
    platform: row.platform ?? '',
    agentVersion: row.agentVersion ?? row.agent_version ?? '',
    protocolVersion: Number(row.protocolVersion ?? row.protocol_version ?? 0),
    status: row.status ?? 'unknown',
    lastSeenAt: row.lastSeenAt ?? row.last_seen_at ?? null,
    createdAt: row.createdAt ?? row.created_at ?? null,
    revokedAt: row.revokedAt ?? row.revoked_at ?? null,
  }
}

export function normalizeAgentBinding(row = {}) {
  return {
    id: row.id ?? '',
    agentId: row.agentId ?? row.agent_id ?? '',
    projectId: row.projectId ?? row.project_id ?? '',
    localRepoKey: row.localRepoKey ?? row.local_repo_key ?? '',
    displayName: row.displayName ?? row.display_name ?? null,
    branchName: row.branchName ?? row.branch_name ?? '',
    status: row.status ?? row.syncStatus ?? row.sync_status ?? 'unknown',
    lastSyncedAt: row.lastSyncedAt ?? row.last_synced_at ?? null,
    lastError: row.lastError ?? row.last_error ?? null,
    deviceName: row.deviceName ?? row.device_name ?? null,
    agentStatus: row.agentStatus ?? row.agent_status ?? null,
    ownerUserId: row.ownerUserId ?? row.owner_user_id ?? null,
    ownerUsername: row.ownerUsername ?? row.owner_username ?? '',
    ownerDisplayName: row.ownerDisplayName ?? row.owner_display_name ?? '',
    lastSeenAt: row.lastSeenAt ?? row.last_seen_at ?? null,
    createdAt: row.createdAt ?? row.created_at ?? null,
    updatedAt: row.updatedAt ?? row.updated_at ?? null,
  }
}

export function normalizeAuditEvent(row = {}) {
  return {
    id: Number(row.id ?? 0),
    actorUserId: row.actorUserId ?? row.actor_user_id ?? null,
    actorAgentId: row.actorAgentId ?? row.actor_agent_id ?? null,
    projectId: row.projectId ?? row.project_id ?? null,
    action: row.action ?? '',
    targetType: row.targetType ?? row.target_type ?? '',
    targetId: row.targetId ?? row.target_id ?? null,
    result: row.result ?? 'unknown',
    correlationId: row.correlationId ?? row.correlation_id ?? '',
    detail: redactSensitiveDetail(row.detail ?? {}),
    occurredAt: row.occurredAt ?? row.occurred_at ?? null,
  }
}

export function canWriteProject(project = {}) {
  project = project || {}
  if (['stale', 'needs_repair', 'disabled'].includes(project.syncStatus)) {
    return false
  }
  const capabilities = project.capabilities ?? project.permissions ?? project
  if (capabilities.writeTask ?? capabilities.write_task) return true
  return ['lead', 'member'].includes(project.role)
}

export function canManageProject(project = {}) {
  project = project || {}
  const capabilities = project.capabilities ?? project.permissions ?? project
  if (capabilities.manageMembers ?? capabilities.manage_members) return true
  return (
    project.role === 'lead' ||
    (Array.isArray(project.taskSpaces) &&
      project.taskSpaces.some((taskSpace) => taskSpace?.canManage === true))
  )
}

export function assignableProjectMembers(project = {}) {
  return normalizeProjectMembers(project).filter(
    (member) =>
      ['lead', 'member'].includes(member.role) &&
      member.status === 'active' &&
      Boolean(member.trellisDevId),
  )
}

export function assignmentActionState(task = {}, assignee, assignees = []) {
  const readOnly = Boolean(task?.archived)
  const candidates = Array.isArray(assignees) ? assignees : []
  return {
    readOnly,
    canSubmit: Boolean(task) && !readOnly && Boolean(assignee) && candidates.includes(assignee),
  }
}

export function planEditingState(task = {}) {
  const readOnly = Boolean(task?.archived)
  return {
    readOnly,
    canEdit: Boolean(task) && !readOnly,
  }
}

export function buildTaskQuery(filters = {}, { limit = TEAM_PAGE_LIMIT, cursor = null } = {}) {
  const params = new URLSearchParams()
  const add = (key, value) => {
    if (value == null || value === '' || value === false) return
    params.set(key, String(value))
  }
  add('teamId', filters.teamId && filters.teamId !== 'all' ? filters.teamId : null)
  add(
    'taskSpaceId',
    filters.taskSpaceId && filters.taskSpaceId !== 'all' ? filters.taskSpaceId : null,
  )
  add('scope', filters.scope === 'mine' ? 'mine' : 'all')
  if (filters.projectId && filters.projectId !== 'all') {
    add('projectIds', filters.projectId)
  }
  for (const [key] of ARRAY_FILTERS) {
    const value = filters[key]
    if (Array.isArray(value) && value.length) add(key, value.join(','))
    else if (typeof value === 'string' && value.trim()) add(key, value.trim())
  }
  const priorities = filters.priorities ?? filters.priority
  const stages = filters.stages ?? filters.stage
  add('priorities', Array.isArray(priorities) ? priorities.join(',') : priorities?.trim())
  add('stages', Array.isArray(stages) ? stages.join(',') : stages?.trim())
  add('q', filters.q?.trim())
  add('branch', filters.branch?.trim())
  add('assignee', filters.assignee?.trim())
  add('dueWithinDays', filters.dueWithinDays)
  add('staleDays', filters.staleDays)
  add('blocked', filters.blocked && filters.blocked !== 'any' ? filters.blocked : null)
  add('archived', filters.archived === true ? '1' : null)
  add('preset', filters.preset)
  add('limit', Math.max(1, Math.min(200, Number(limit) || TEAM_PAGE_LIMIT)))
  add('cursor', cursor)
  return params.toString()
}

export function archiveAssigneeOptions(assignees = [], selected = '') {
  const values = [
    String(selected || '').trim(),
    ...(Array.isArray(assignees) ? assignees.map(String) : []),
  ].filter(Boolean)
  return [
    { value: '__all', label: '全部负责人' },
    ...[...new Set(values)].map((value) => ({ value, label: value })),
  ]
}

function projectBoardVersion(status, projectId) {
  if (!projectId || projectId === 'all') return null
  const versions = status?.boardVersions ?? status?.board_versions
  if (versions && Object.hasOwn(versions, projectId)) return versions[projectId]
  const projects = status?.projects ?? status?.items
  if (!Array.isArray(projects)) return null
  const project = projects.find(
    (item) => (item.id ?? item.projectId ?? item.project_id) === projectId,
  )
  return project?.boardVersion ?? project?.board_version ?? null
}

export function shouldReloadTasks(previous, next, projectId = 'all') {
  if (!previous || !next) return true
  const previousRevision = previous.queryRevision ?? previous.query_revision
  const nextRevision = next.queryRevision ?? next.query_revision
  if (previousRevision !== nextRevision) return true
  const previousDay = previous.queryDay ?? previous.query_day
  const nextDay = next.queryDay ?? next.query_day
  if (previousDay !== nextDay) return true
  return projectBoardVersion(previous, projectId) !== projectBoardVersion(next, projectId)
}

export function assignmentVersion(row = {}) {
  return (
    existingValue(row, 'assignmentVersion', 'assignment_version') ??
    existingValue(row.assignment, 'version', 'version') ??
    null
  )
}

export function taskVersion(row = {}) {
  return existingValue(row, 'taskVersion', 'task_version') ?? null
}

export function isRetryableOperation(operation) {
  return ['pending', 'delivered', 'running', 'failed'].includes(operation?.status)
}

export function isCompleteOperation(operation) {
  return ['succeeded', 'cancelled'].includes(operation?.status)
}

export function operationPollDelay(attempt, status) {
  if (status === 'delivered' || status === 'running') {
    return Math.min(8_000, 1_500 * (attempt + 1))
  }
  return Math.min(4_000, 700 * 2 ** attempt)
}

export function safeReturnTo(value, fallback = '/') {
  const raw = String(value || '').trim()
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) {
    return fallback
  }
  try {
    const base = 'https://trellis.invalid'
    const target = new URL(raw, base)
    if (target.origin !== base || target.pathname === '/login.html') return fallback
    return `${target.pathname}${target.search}${target.hash}`
  } catch {
    return fallback
  }
}

const SENSITIVE_KEY =
  /(password|token|secret|credential|authorization|cookie|private.?key|passphrase)/i

export function redactSensitiveDetail(value, depth = 0) {
  if (depth > 4) return '[已截断]'
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') return value.slice(0, 500)
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => redactSensitiveDetail(item, depth + 1))
  }
  if (typeof value !== 'object') return String(value).slice(0, 200)
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      SENSITIVE_KEY.test(key) ? '[已隐藏]' : redactSensitiveDetail(item, depth + 1),
    ]),
  )
}

export function adminCollection(payload, ...keys) {
  return list(payload, ...keys)
}
