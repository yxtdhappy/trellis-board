export const TEAM_PAGE_LIMIT = 100
const TASK_SPACE_LISTENER_STATES = new Set([
  'online',
  'inactive',
  'unassociated',
  'unknown_legacy',
  'disabled',
])

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

export function pickProjectTrellisDevId(projects, remoteIdentityKey, fallback) {
  const key = typeof remoteIdentityKey === 'string' ? remoteIdentityKey.trim() : ''
  const match = key
    ? (Array.isArray(projects) ? projects : []).find(
        (project) => project?.remoteIdentityHash === key,
      )
    : null
  return (match?.trellisDevId || '').trim() || fallback
}

export function normalizeTeamProject(project = {}) {
  const id = project.id ?? project.repositoryId ?? project.repository_id ?? ''
  const taskSpaces = Array.isArray(project.taskSpaces)
    ? project.taskSpaces.map((taskSpace) => {
        const listenerState = taskSpace?.listenerState ?? taskSpace?.listener_state
        const onlineListenerCount =
          taskSpace?.onlineListenerCount ?? taskSpace?.online_listener_count
        const approvedBindingCount =
          taskSpace?.approvedBindingCount ?? taskSpace?.approved_binding_count
        const listenerReportedBindingCount =
          taskSpace?.listenerReportedBindingCount ?? taskSpace?.listener_reported_binding_count
        const lastListenerAt = taskSpace?.lastListenerAt ?? taskSpace?.last_listener_at
        const hasListenerSummary = [
          listenerState,
          onlineListenerCount,
          approvedBindingCount,
          listenerReportedBindingCount,
          lastListenerAt,
        ].some((value) => value != null)
        return {
          ...taskSpace,
          id: String(taskSpace?.id ?? ''),
          projectId: String(taskSpace?.projectId ?? taskSpace?.project_id ?? id),
          branchName: String(taskSpace?.branchName ?? taskSpace?.branch_name ?? ''),
          revision: Number(taskSpace?.revision ?? 0),
          indexedRevision: Number(taskSpace?.indexedRevision ?? taskSpace?.indexed_revision ?? 0),
          readOnly: taskSpace?.readOnly === true,
          approvedBindingCount: hasListenerSummary
            ? Math.max(0, Number(approvedBindingCount) || 0)
            : undefined,
          onlineListenerCount: hasListenerSummary
            ? Math.max(0, Number(onlineListenerCount) || 0)
            : undefined,
          listenerReportedBindingCount: hasListenerSummary
            ? Math.max(0, Number(listenerReportedBindingCount) || 0)
            : undefined,
          lastListenerAt: hasListenerSummary ? (lastListenerAt ?? null) : undefined,
          listenerState:
            typeof listenerState === 'string' && TASK_SPACE_LISTENER_STATES.has(listenerState)
              ? listenerState
              : undefined,
        }
      })
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
    sourceBranchName:
      row.sourceBranchName ?? row.source_branch_name ?? row.branchName ?? row.branch_name ?? '',
    taskSpaceRevision: Number(row.taskSpaceRevision ?? row.task_space_revision ?? 0),
    taskSpaceIndexedRevision: Number(
      row.taskSpaceIndexedRevision ?? row.task_space_indexed_revision ?? 0,
    ),
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
    previousAssigneeUserId: row.previousAssigneeUserId ?? row.previous_assignee_user_id ?? null,
    controlState: row.controlState ?? row.control_state ?? null,
    materializationState: row.materializationState ?? row.materialization_state ?? null,
    controlTaskVersion: row.controlTaskVersion ?? row.control_task_version ?? null,
    handoffState: row.handoffState ?? row.handoff_state ?? null,
    leaseStatus: row.leaseStatus ?? row.lease_status ?? null,
    leaseExpiresAt: row.leaseExpiresAt ?? row.lease_expires_at ?? null,
    leaseExpired: row.leaseExpired ?? row.lease_expired ?? null,
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

export function taskCommandState(taskSpace = {}, teamMode = false) {
  if (!teamMode) return { canSubmit: true, reason: null }
  if (taskSpace?.listenerState === 'disabled' || taskSpace?.status === 'disabled') {
    return { canSubmit: false, reason: '该分支任务空间已停用' }
  }
  if (taskSpace?.readOnly || taskSpace?.role === 'read_only') {
    return {
      canSubmit: false,
      reason: '当前账号对该分支只有只读权限',
    }
  }
  return { canSubmit: true, reason: null }
}

const TASK_CONTROL_VIEWS = {
  pending_delivery: {
    label: '等待客户端接管',
    description: '任务已保存到服务端，等待目标客户端上线后认领并落地；当前只展示服务端元数据。',
    tone: 'warning',
  },
  claimed: {
    label: '客户端已认领',
    description: '目标客户端已认领任务，正在落地完整内容；索引完成前不把正文视为可用。',
    tone: 'info',
  },
  materialized: {
    label: '任务已落地',
    description: '服务端已收到完整任务快照；文档长期历史仍以 Git 为准。',
    tone: 'success',
  },
  lease_expired: {
    label: '写入租约已过期',
    description: '当前写入租约已失效，其他授权客户端可申请接管；本页内容可能已落后。',
    tone: 'warning',
  },
  version_stale: {
    label: '控制版本待收敛',
    description: '服务端控制版本领先于当前索引投影，请刷新或等待索引收敛，不能视为实时一致。',
    tone: 'warning',
  },
  migration_conflict: {
    label: '迁移/身份冲突',
    description: '检测到多个执行身份或迁移冲突，需要人工确认，不能按单一实时任务处理。',
    tone: 'danger',
  },
  archived: {
    label: '已归档',
    description: '任务已归档；本地活动副本可能保留、进入受保护清理或需要按 Git 流程处理。',
    tone: 'neutral',
  },
  reassigned: {
    label: '等待新负责人接管',
    description: '任务负责人已变更，等待目标客户端接管；旧负责人的本地副本不会因改派立即删除。',
    tone: 'warning',
  },
  handoff_pending: {
    label: '等待目标认领',
    description: '任务已委派，等待目标客户端认领并上传完整内容。',
    tone: 'warning',
  },
  target_materializing: {
    label: '目标正在接管',
    description: '目标客户端正在认领和落地任务，完成后才允许清理创建者副本。',
    tone: 'info',
  },
  source_cleanup_pending: {
    label: '等待来源副本清理',
    description: '目标已落地完整内容，等待创建者本地副本完成受保护备份和清理。',
    tone: 'info',
  },
  source_cleanup_conflict: {
    label: '来源副本需保护',
    description: '创建者本地副本存在修改、Git 跟踪或备份问题，需要保留并按说明处理。',
    tone: 'danger',
  },
  completed: {
    label: '认领与清理已完成',
    description: '目标接管和来源副本清理已完成。',
    tone: 'success',
  },
}

function numericVersion(value) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number >= 0 ? number : null
}

function normalizedControlValue(source, camel, snake) {
  return String(existingValue(source, camel, snake) ?? '')
    .trim()
    .toLowerCase()
}

export function taskControlView(task = {}) {
  const source = task && typeof task === 'object' && !Array.isArray(task) ? task : {}
  const explicitState = normalizedControlValue(source, 'controlState', 'control_state')
  const materializationState = normalizedControlValue(
    source,
    'materializationState',
    'materialization_state',
  )
  const handoffState = normalizedControlValue(source, 'handoffState', 'handoff_state')
  const leaseStatus = normalizedControlValue(source, 'leaseStatus', 'lease_status')
  const leaseExpiresAt = String(
    existingValue(source, 'leaseExpiresAt', 'lease_expires_at') ?? '',
  ).trim()
  const controlVersion = numericVersion(
    existingValue(source, 'controlTaskVersion', 'control_task_version'),
  )
  const indexedVersion = numericVersion(taskVersion(source))
  const previousAssigneeUserId =
    existingValue(source, 'previousAssigneeUserId', 'previous_assignee_user_id') ?? null
  const identityConflict =
    boolean(existingValue(source, 'executionIdentityConflict', 'execution_identity_conflict')) ||
    boolean(existingValue(source, 'migrationConflict', 'migration_conflict'))
  const activeLeaseExpired =
    leaseStatus === 'expired' ||
    (leaseStatus === 'active' &&
      Boolean(leaseExpiresAt) &&
      Number.isFinite(Date.parse(leaseExpiresAt)) &&
      Date.parse(leaseExpiresAt) <= Date.now()) ||
    boolean(existingValue(source, 'leaseExpired', 'lease_expired'))
  const handoffActive = Boolean(handoffState) && !['none', 'completed'].includes(handoffState)
  const hasControlMetadata = Boolean(
    explicitState ||
    materializationState ||
    handoffActive ||
    controlVersion != null ||
    leaseStatus ||
    previousAssigneeUserId ||
    identityConflict,
  )
  if (!hasControlMetadata) {
    return {
      available: false,
      state: 'unavailable',
      label: '',
      description: '',
      tone: 'neutral',
      contentMaterialized: true,
    }
  }

  let state = explicitState
  if (boolean(source.archived)) {
    state = 'archived'
  } else if (!state) {
    if (identityConflict) state = 'migration_conflict'
    else if (handoffState === 'completed') state = 'completed'
    else if (handoffActive) state = handoffState
    else if (previousAssigneeUserId && ['pending', 'claimed'].includes(materializationState)) {
      state = 'reassigned'
    } else if (activeLeaseExpired && ['pending', 'claimed'].includes(materializationState)) {
      state = 'lease_expired'
    } else if (
      controlVersion != null &&
      indexedVersion != null &&
      controlVersion > indexedVersion
    ) {
      state = 'version_stale'
    } else if (materializationState === 'pending') {
      state = 'pending_delivery'
    } else if (materializationState === 'claimed') {
      state = 'claimed'
    } else if (materializationState === 'materialized') {
      state = 'materialized'
    } else {
      state = materializationState || 'unknown'
    }
  }

  const known = TASK_CONTROL_VIEWS[state]
  const requiresMaterialization = new Set([
    'pending_delivery',
    'claimed',
    'reassigned',
    'lease_expired',
    'target_materializing',
    'handoff_pending',
    'migration_conflict',
  ]).has(state)
  const contentMaterialized =
    !requiresMaterialization &&
    (boolean(source.archived) || materializationState === 'materialized') &&
    (!explicitState || Boolean(known))

  return {
    available: true,
    state,
    label: known?.label || '状态未知',
    description:
      known?.description || `服务端返回了未识别的控制状态“${state}”，当前不能视为实时一致。`,
    tone: known?.tone || 'warning',
    contentMaterialized,
  }
}

export function taskContentMaterialized(task = {}) {
  return taskControlView(task).contentMaterialized
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

export function isActiveOperation(operation) {
  return ['pending', 'delivered', 'running'].includes(operation?.status)
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
