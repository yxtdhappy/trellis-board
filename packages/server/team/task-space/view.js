import {
  emptyListenerSummary,
  emptyTaskSpaceStats,
  listenerSummaries,
  taskSpaceStats,
} from './shared.js'

function listenerState(row, summary) {
  if (row.retired_at || row.status === 'disabled' || row.project_status === 'disabled') {
    return 'disabled'
  }
  if (summary.onlineListenerCount > 0) return 'online'
  if (summary.approvedBindingCount === 0) return 'unassociated'
  if (summary.listenerReportedBindingCount === 0) return 'unknown_legacy'
  return 'inactive'
}

export function taskSpacePublic(row, actor, access, summary = null, stats = null) {
  const role = access.projectMembers.get(row.project_id)?.get(actor?.userId)?.role || null
  const systemAdmin = Boolean(actor?.systemAdmin)
  const teamAdmin = [...access.teamRoles.entries()].some(
    ([teamId, teamRole]) =>
      teamRole === 'admin' && access.teamAccessByProject.has(`${row.project_id}\0${teamId}`),
  )
  // 团队管理员可以管理访问权限，但没有 developer ID 映射时不能写任务。
  const readOnly = !(systemAdmin || role === 'lead' || role === 'member')
  const listeners = summary || emptyListenerSummary()
  const counts = stats || emptyTaskSpaceStats()
  const lifecycleStatus = row.retired_at
    ? 'retired'
    : row.status === 'disabled'
      ? 'disabled'
      : 'active'
  return {
    id: row.id,
    projectId: row.project_id,
    branchName: row.branch_name,
    isBaseline: Boolean(row.baseline_branch && row.branch_name === row.baseline_branch),
    isWorktree: Boolean(row.is_worktree),
    status: row.status,
    revision: Number(row.revision || 0),
    indexedRevision: Number(row.indexed_revision || 0),
    lastError: row.last_error || null,
    role: role || (teamAdmin ? 'team_admin' : systemAdmin ? 'system_admin' : null),
    readOnly,
    canManage: systemAdmin || teamAdmin || role === 'lead',
    lifecycleStatus,
    retiredAt: row.retired_at || null,
    retiredByUserId: row.retired_by_user_id || null,
    retiredReason: row.retired_reason || null,
    taskCount: counts.taskCount,
    fileCount: counts.fileCount,
    activeTaskCount: counts.activeTaskCount,
    archivedTaskCount: counts.archivedTaskCount,
    lastActivityAt: counts.lastActivityAt,
    unarchivedTaskTitles: counts.unarchivedTaskTitles,
    approvedBindingCount: listeners.approvedBindingCount,
    onlineListenerCount: listeners.onlineListenerCount,
    listenerReportedBindingCount: listeners.listenerReportedBindingCount,
    lastListenerAt: listeners.lastListenerAt,
    listenerState: listenerState(row, listeners),
  }
}

export function projectPublic(row, access, actor = null) {
  const team = access.teamsById.get(row.owner_team_id) || null
  const requester = actor ? access.projectMembers.get(row.id)?.get(actor.userId) : null
  return {
    id: row.id,
    name: row.name,
    remoteUrl: row.remote_url,
    remoteIdentityHash: row.remote_identity_hash,
    baselineBranch: row.baseline_branch || null,
    ownerTeamId: row.owner_team_id,
    ownerTeamName: team?.name || null,
    teamId: row.owner_team_id,
    teamName: team?.name || null,
    status: row.status,
    taskSpaces: [],
    trellisDevId: requester?.trellisDevId || null,
    members: access.projectMembers.get(row.id)?.role ? [access.projectMembers.get(row.id)] : [],
    workspaceMembers: access.workspaceMembers.get(row.id) || [],
    syncStatus: row.status === 'active' ? 'current' : 'disabled',
    health: row.status,
  }
}

export function createView({ statements, now, staleMs }) {
  const listenerSummariesFor = (taskSpaceIds) => {
    const staleCutoff = new Date(now().getTime() - staleMs).toISOString()
    return listenerSummaries(statements, taskSpaceIds, staleCutoff)
  }

  const taskSpaceStatsFor = (taskSpaceIds, options) =>
    taskSpaceStats(statements, taskSpaceIds, options)

  return {
    listenerSummariesFor,
    taskSpaceStatsFor,
    staleCutoff: () => new Date(now().getTime() - staleMs).toISOString(),
    taskSpacePublic,
    projectPublic,
  }
}
