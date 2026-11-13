import crypto from 'node:crypto'
import { withTransaction } from '../database.js'
import { appendAuditEvent } from './audit.js'
import {
  formatGitRemote,
  gitRemoteIdentityKey,
  normalizeGitRemote,
  validateGitBranchName,
} from '../../../packages/shared/remote-identity.js'
import { ERROR_CODES, teamError } from './errors.js'
import { listTeamsForActor } from './teams.js'

const PROJECT_ROLES = new Set(['lead', 'member', 'read_only'])
const LOCAL_REPO_KEY = /^[a-f0-9]{64}$/
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const DEFAULT_LISTENER_STALE_MS = 60 * 1000

function nowIso() {
  return new Date().toISOString()
}

function requiredText(value, label, max = 255) {
  const result = String(value || '').trim()
  if (!result || result.length > max) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, `${label}格式无效`)
  }
  return result
}

function optionalText(value, max = 255) {
  const result = String(value || '').trim()
  return result ? result.slice(0, max) : null
}

function normalizeRole(value, fallback = 'read_only') {
  const role = String(value || fallback).trim()
  if (!PROJECT_ROLES.has(role)) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, '项目成员角色无效')
  }
  return role
}

function assertLocalRepoKey(value) {
  const key = String(value || '').trim()
  if (!LOCAL_REPO_KEY.test(key)) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, '本地仓库标识格式无效')
  }
  return key
}

function safeId(value, label) {
  const id = requiredText(value, label, 128)
  if (!SAFE_ID.test(id)) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, `${label}格式无效`)
  }
  return id
}

function emptyListenerSummary() {
  return {
    approvedBindingCount: 0,
    onlineListenerCount: 0,
    listenerReportedBindingCount: 0,
    lastListenerAt: null,
  }
}

function emptyTaskSpaceStats() {
  return {
    taskCount: 0,
    fileCount: 0,
    activeTaskCount: 0,
    archivedTaskCount: 0,
    lastActivityAt: null,
    unarchivedTaskTitles: [],
  }
}

function taskSpaceStats(db, taskSpaceIds, { includeTaskTitles = false } = {}) {
  if (!taskSpaceIds.length) return new Map()
  const placeholders = taskSpaceIds.map(() => '?').join(', ')
  const files = db
    .prepare(`
      SELECT task_space_id, COUNT(DISTINCT task_dir) AS task_count,
             COUNT(*) AS file_count, MAX(updated_at) AS last_activity_at
      FROM sync_task_space_file
      WHERE task_space_id IN (${placeholders}) AND deleted = 0
      GROUP BY task_space_id
    `)
    .all(...taskSpaceIds)
  const indexes = db
    .prepare(`
      SELECT task_space_id,
             SUM(CASE WHEN archived = 0 THEN 1 ELSE 0 END) AS active_task_count,
             SUM(CASE WHEN archived = 1 THEN 1 ELSE 0 END) AS archived_task_count,
             MAX(updated_at) AS last_activity_at
      FROM sync_task_index
      WHERE task_space_id IN (${placeholders})
      GROUP BY task_space_id
    `)
    .all(...taskSpaceIds)
  const result = new Map()
  for (const row of files) {
    result.set(row.task_space_id, {
      ...emptyTaskSpaceStats(),
      taskCount: Number(row.task_count || 0),
      fileCount: Number(row.file_count || 0),
      lastActivityAt: row.last_activity_at || null,
    })
  }
  for (const row of indexes) {
    const current = result.get(row.task_space_id) || emptyTaskSpaceStats()
    result.set(row.task_space_id, {
      ...current,
      activeTaskCount: Number(row.active_task_count || 0),
      archivedTaskCount: Number(row.archived_task_count || 0),
      lastActivityAt: current.lastActivityAt || row.last_activity_at || null,
    })
  }
  if (includeTaskTitles) {
    const titles = db
      .prepare(`
        SELECT task_space_id, title
        FROM (
          SELECT task_space_id, title,
                 ROW_NUMBER() OVER (
                   PARTITION BY task_space_id
                   ORDER BY updated_at DESC, task_key
                 ) AS row_number
          FROM sync_task_index
          WHERE task_space_id IN (${placeholders}) AND archived = 0
        )
        WHERE row_number <= 5
        ORDER BY task_space_id, row_number
      `)
      .all(...taskSpaceIds)
    for (const row of titles) {
      const current = result.get(row.task_space_id) || emptyTaskSpaceStats()
      current.unarchivedTaskTitles.push(row.title)
      result.set(row.task_space_id, current)
    }
  }
  return result
}

function listenerSummaries(db, taskSpaceIds, staleCutoff) {
  if (!taskSpaceIds.length) return new Map()
  const rows = db
    .prepare(`
    SELECT
      b.task_space_id,
      SUM(CASE WHEN b.sync_status = 'approved' THEN 1 ELSE 0 END) AS approved_count,
      SUM(CASE
        WHEN b.sync_status = 'approved' AND b.listener_reported_at IS NOT NULL
        THEN 1 ELSE 0
      END) AS reported_count,
      SUM(CASE
        WHEN b.sync_status = 'approved'
          AND b.is_listening = 1
          AND b.listener_reported_at >= ?
          AND a.status = 'active'
          AND a.last_seen_at >= ?
          AND active.agent_id = a.id
          AND s.status = 'active'
          AND s.retired_at IS NULL
          AND p.status = 'active'
        THEN 1 ELSE 0
      END) AS online_count,
      MAX(CASE WHEN b.sync_status = 'approved' THEN b.last_listener_at END) AS last_listener_at
    FROM sync_agent_binding b
    JOIN sync_task_space s ON s.id = b.task_space_id
    JOIN sync_project p ON p.id = s.project_id
    JOIN agent_device a ON a.id = b.agent_id
    LEFT JOIN sync_active_agent active ON active.user_id = a.user_id
    WHERE b.task_space_id IN (${taskSpaceIds.map(() => '?').join(', ')})
    GROUP BY b.task_space_id
  `)
    .all(staleCutoff, staleCutoff, ...taskSpaceIds)
  return new Map(
    rows.map((row) => [
      row.task_space_id,
      {
        approvedBindingCount: Number(row.approved_count || 0),
        onlineListenerCount: Number(row.online_count || 0),
        listenerReportedBindingCount: Number(row.reported_count || 0),
        lastListenerAt: row.last_listener_at || null,
      },
    ]),
  )
}

function listenerState(row, summary) {
  if (row.retired_at || row.status === 'disabled' || row.project_status === 'disabled') {
    return 'disabled'
  }
  if (summary.onlineListenerCount > 0) return 'online'
  if (summary.approvedBindingCount === 0) return 'unassociated'
  if (summary.listenerReportedBindingCount === 0) return 'unknown_legacy'
  return 'inactive'
}

function taskSpacePublic(row, actor, access, summary = null, stats = null) {
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

function projectPublic(row, access) {
  const team = access.teamsById.get(row.owner_team_id) || null
  return {
    id: row.id,
    name: row.name,
    remoteUrl: row.remote_url,
    remoteIdentityHash: row.remote_identity_hash,
    ownerTeamId: row.owner_team_id,
    ownerTeamName: team?.name || null,
    teamId: row.owner_team_id,
    teamName: team?.name || null,
    status: row.status,
    taskSpaces: [],
    members: access.projectMembers.get(row.id)?.role ? [access.projectMembers.get(row.id)] : [],
    workspaceMembers: access.workspaceMembers.get(row.id) || [],
    syncStatus: row.status === 'active' ? 'current' : 'disabled',
    health: row.status,
  }
}

export function createTaskSpaceService({
  db,
  config = {},
  allowedFileRemote = false,
  now = () => new Date(),
  staleMs = null,
  backupService = null,
}) {
  const allowFileRemote = allowedFileRemote === true || config?.allowLocalGitRemotes === true
  const configuredStaleMs = Number(staleMs ?? config.agentStaleMs ?? DEFAULT_LISTENER_STALE_MS)
  const effectiveStaleMs =
    Number.isFinite(configuredStaleMs) && configuredStaleMs > 0
      ? configuredStaleMs
      : DEFAULT_LISTENER_STALE_MS

  function listenerSummariesFor(taskSpaceIds) {
    const staleCutoff = new Date(now().getTime() - effectiveStaleMs).toISOString()
    return listenerSummaries(db, taskSpaceIds, staleCutoff)
  }

  function actorContext(userId, requestedTeamId = null) {
    const user = db
      .prepare(`
      SELECT id, username, display_name, system_admin, status
      FROM user_account
      WHERE id = ?
    `)
      .get(userId)
    if (!user || user.status !== 'active') {
      throw teamError(401, ERROR_CODES.AUTH_REQUIRED, '账号不存在或已禁用')
    }
    const actor = {
      userId: user.id,
      user: {
        id: user.id,
        username: user.username,
        displayName: user.display_name,
        systemAdmin: Boolean(user.system_admin),
      },
      systemAdmin: Boolean(user.system_admin),
      teams: [],
    }
    actor.teams = listTeamsForActor(db, actor, { activeOnly: true })
    const teamId = String(requestedTeamId || '').trim()
    if (teamId && teamId !== 'all') {
      const team = db.prepare("SELECT id FROM team WHERE id = ? AND status = 'active'").get(teamId)
      if (!team) throw teamError(404, ERROR_CODES.NOT_FOUND, '团队不存在')
      if (!actor.systemAdmin && !actor.teams.some((item) => item.id === teamId)) {
        throw teamError(403, ERROR_CODES.FORBIDDEN, '无权访问该团队')
      }
    }
    return actor
  }

  function accessContext(actor) {
    const teamAccess = db.prepare('SELECT * FROM sync_project_team_access').all()
    const members = db
      .prepare(`
      SELECT m.*, u.username, u.display_name
      FROM sync_project_member m
      JOIN user_account u ON u.id = m.user_id
    `)
      .all()
    const workspaceMembers = db
      .prepare(`
      SELECT project_id, trellis_dev_id
      FROM sync_project_member
      WHERE trellis_dev_id IS NOT NULL AND length(trim(trellis_dev_id)) > 0
      ORDER BY trellis_dev_id COLLATE NOCASE
    `)
      .all()
    const projectMembers = new Map()
    for (const row of members) {
      if (!projectMembers.has(row.project_id)) projectMembers.set(row.project_id, new Map())
      projectMembers.get(row.project_id).set(row.user_id, {
        userId: row.user_id,
        username: row.username,
        displayName: row.display_name,
        role: row.role,
        trellisDevId: row.trellis_dev_id || null,
      })
    }
    const workspace = new Map()
    for (const row of workspaceMembers) {
      if (!workspace.has(row.project_id)) workspace.set(row.project_id, [])
      workspace.get(row.project_id).push(row.trellis_dev_id)
    }
    return {
      teamAccess,
      projectMembers,
      workspaceMembers: workspace,
      teamsById: new Map(
        listTeamsForActor(db, actor, { activeOnly: true }).map((team) => [team.id, team]),
      ),
      teamRoles: new Map((actor.teams || []).map((team) => [team.id, team.role])),
      teamAccessByProject: new Map(
        teamAccess.map((row) => [`${row.project_id}\0${row.team_id}`, row.access_role]),
      ),
    }
  }

  function projectAccessible(project, actor, access, requestedTeamId = null) {
    if (actor.systemAdmin) return true
    const scope = String(requestedTeamId || '').trim()
    const teams =
      scope && scope !== 'all'
        ? (actor.teams || []).filter((team) => team.id === scope)
        : actor.teams || []
    return teams.some((team) => access.teamAccessByProject.has(`${project.id}\0${team.id}`))
  }

  function loadProjectRow(projectId) {
    return (
      db.prepare('SELECT * FROM sync_project WHERE id = ?').get(String(projectId || '')) || null
    )
  }

  function loadTaskSpaceRow(taskSpaceId) {
    return (
      db
        .prepare(`
        SELECT s.*, p.name AS project_name, p.remote_url, p.remote_identity_hash,
               p.owner_team_id, p.status AS project_status, team.name AS owner_team_name
        FROM sync_task_space s
        JOIN sync_project p ON p.id = s.project_id
        JOIN team ON team.id = p.owner_team_id
        WHERE s.id = ?
      `)
        .get(String(taskSpaceId || '')) || null
    )
  }

  function readProject(projectId, actor = null) {
    const row = loadProjectRow(projectId)
    if (!row) return null
    if (!actor) return row
    const access = accessContext(actor)
    if (!projectAccessible(row, actor, access)) return null
    return { ...row, access }
  }

  function readTaskSpace(taskSpaceId, actor = null) {
    const row = loadTaskSpaceRow(taskSpaceId)
    if (!row) return null
    if (!actor) return row
    const project = loadProjectRow(row.project_id)
    const access = accessContext(actor)
    if (!project || !projectAccessible(project, actor, access)) return null
    return { ...row, project, access }
  }

  function manageContext(actor, projectId) {
    const project = loadProjectRow(projectId)
    if (!project) throw teamError(404, ERROR_CODES.NOT_FOUND, '项目不存在')
    const access = accessContext(actor)
    if (!projectAccessible(project, actor, access)) {
      throw teamError(404, ERROR_CODES.NOT_FOUND, '项目不存在')
    }
    const member = access.projectMembers.get(project.id)?.get(actor.userId) || null
    const teamAdmin = (actor.teams || []).some(
      (team) =>
        access.teamAccessByProject.has(`${project.id}\0${team.id}`) && team.role === 'admin',
    )
    if (!actor.systemAdmin && !teamAdmin && member?.role !== 'lead') {
      throw teamError(403, ERROR_CODES.FORBIDDEN, '无权管理项目分支')
    }
    return { project, access, member }
  }

  function listReadable(actor, { teamId = null, includeDisabled = false } = {}) {
    const scope = String(teamId || '').trim()
    if (scope && scope !== 'all') {
      if (!actor.systemAdmin && !(actor.teams || []).some((team) => team.id === scope)) {
        throw teamError(403, ERROR_CODES.FORBIDDEN, '无权访问该团队')
      }
    }
    const access = accessContext(actor)
    const rows = db
      .prepare(`
      SELECT *
      FROM sync_project
      WHERE status = 'active'
      ORDER BY name COLLATE NOCASE, id
    `)
      .all()
      .filter((row) => projectAccessible(row, actor, access))
      .filter(
        (row) => !scope || scope === 'all' || access.teamAccessByProject.has(`${row.id}\0${scope}`),
      )
    const projectIds = rows.map((row) => row.id)
    const spaces = projectIds.length
      ? db
          .prepare(`
          SELECT s.*, p.owner_team_id AS team_id, p.status AS project_status
          FROM sync_task_space s
          JOIN sync_project p ON p.id = s.project_id
          WHERE s.project_id IN (${projectIds.map(() => '?').join(', ')})
            AND s.status IN (${includeDisabled ? "'active', 'indexing', 'error', 'disabled'" : "'active', 'indexing', 'error'"})
            AND s.retired_at IS NULL
          ORDER BY s.project_id, s.branch_name COLLATE NOCASE
        `)
          .all(...projectIds)
      : []
    const spacesByProject = new Map()
    for (const space of spaces) {
      if (!spacesByProject.has(space.project_id)) spacesByProject.set(space.project_id, [])
      spacesByProject.get(space.project_id).push(space)
    }
    const summaries = listenerSummariesFor(spaces.map((space) => space.id))
    const stats = taskSpaceStats(
      db,
      spaces.map((space) => space.id),
    )
    return rows.map((row) => {
      const project = projectPublic(row, access)
      project.taskSpaces = (spacesByProject.get(row.id) || []).map((space) =>
        taskSpacePublic(space, actor, access, summaries.get(space.id), stats.get(space.id)),
      )
      return project
    })
  }

  function listAll(actor, { teamId = null } = {}) {
    const requestedTeamId = String(teamId || '').trim()
    if (!actor.systemAdmin) {
      const adminTeams = (actor.teams || []).filter((team) => team.role === 'admin')
      if (!adminTeams.length) {
        throw teamError(403, ERROR_CODES.FORBIDDEN, '只有团队管理员可以查看项目')
      }
      if (
        requestedTeamId &&
        requestedTeamId !== 'all' &&
        !adminTeams.some((team) => team.id === requestedTeamId)
      ) {
        throw teamError(403, ERROR_CODES.FORBIDDEN, '无权管理该团队的项目')
      }
    } else if (requestedTeamId && requestedTeamId !== 'all') {
      const team = db
        .prepare("SELECT id FROM team WHERE id = ? AND status = 'active'")
        .get(requestedTeamId)
      if (!team) throw teamError(404, ERROR_CODES.NOT_FOUND, '团队不存在')
    }
    const rows = db.prepare('SELECT * FROM sync_project ORDER BY created_at DESC, id DESC').all()
    const access = accessContext(actor)
    const manageableTeamIds = actor.systemAdmin
      ? requestedTeamId && requestedTeamId !== 'all'
        ? new Set([requestedTeamId])
        : null
      : new Set(
          requestedTeamId && requestedTeamId !== 'all'
            ? [requestedTeamId]
            : (actor.teams || []).filter((team) => team.role === 'admin').map((team) => team.id),
        )
    const scopedRows =
      manageableTeamIds == null
        ? rows
        : rows.filter((row) =>
            access.teamAccess.some(
              (team) => team.project_id === row.id && manageableTeamIds.has(team.team_id),
            ),
          )
    const projectIds = scopedRows.map((row) => row.id)
    const spaces = projectIds.length
      ? db
          .prepare(`
            SELECT s.*, p.owner_team_id AS team_id, p.status AS project_status
            FROM sync_task_space s
            JOIN sync_project p ON p.id = s.project_id
            WHERE s.project_id IN (${projectIds.map(() => '?').join(', ')})
            ORDER BY s.project_id, s.branch_name COLLATE NOCASE
          `)
          .all(...projectIds)
      : []
    const summaries = listenerSummariesFor(spaces.map((space) => space.id))
    const stats = taskSpaceStats(
      db,
      spaces.map((space) => space.id),
    )
    const spacesByProject = new Map()
    for (const space of spaces) {
      if (!spacesByProject.has(space.project_id)) spacesByProject.set(space.project_id, [])
      spacesByProject.get(space.project_id).push(space)
    }
    return scopedRows.map((row) => {
      const project = projectPublic(row, access)
      project.taskSpaces = (spacesByProject.get(row.id) || []).map((space) =>
        taskSpacePublic(space, actor, access, summaries.get(space.id), stats.get(space.id)),
      )
      return project
    })
  }

  function resolve(userId, input = {}) {
    const actor = actorContext(userId, input.teamId)
    const branchName = validateGitBranchName(input.branchName)
    const identity = normalizeGitRemote(input.remoteUrl, { allowFileRemote })
    const identityHash = gitRemoteIdentityKey(input.remoteUrl, { allowFileRemote })
    const project = db
      .prepare('SELECT * FROM sync_project WHERE remote_identity_hash = ?')
      .get(identityHash)
    if (!project) {
      const teamId = String(input.teamId || '').trim()
      if (teamId && !actor.systemAdmin && !actor.teams.some((team) => team.id === teamId)) {
        throw teamError(403, ERROR_CODES.FORBIDDEN, '不能把项目归属到无权访问的团队')
      }
      return {
        status: 'new',
        canCreate: true,
        requiresTeam: true,
        remoteUrl: formatGitRemote(identity),
        remoteIdentityHash: identityHash,
        branchName,
        project: null,
        taskSpace: null,
      }
    }
    const access = accessContext(actor)
    if (!projectAccessible(project, actor, access, input.teamId)) {
      return {
        status: 'access_required',
        canCreate: false,
        remoteUrl: project.remote_url,
        remoteIdentityHash: identityHash,
        branchName,
        project: { id: project.id, name: project.name, remoteUrl: project.remote_url },
        taskSpace: null,
      }
    }
    const taskSpace = db
      .prepare(`
        SELECT s.*, p.owner_team_id AS team_id, p.status AS project_status
        FROM sync_task_space s
        JOIN sync_project p ON p.id = s.project_id
        WHERE s.project_id = ? AND s.branch_name = ?
      `)
      .get(project.id, branchName)
    if (taskSpace?.retired_at) {
      return {
        status: 'unavailable',
        canCreate: false,
        remoteUrl: project.remote_url,
        remoteIdentityHash: identityHash,
        branchName,
        project: projectPublic(project, access),
        taskSpace: null,
      }
    }
    const summaries = listenerSummariesFor(taskSpace ? [taskSpace.id] : [])
    return {
      status: taskSpace ? 'existing' : 'branch_new',
      canCreate: !taskSpace,
      remoteUrl: project.remote_url,
      remoteIdentityHash: identityHash,
      branchName,
      project: projectPublic(project, access),
      taskSpace: taskSpace
        ? taskSpacePublic(taskSpace, actor, access, summaries.get(taskSpace.id))
        : null,
    }
  }

  function preflight(userId, input = {}) {
    const resolved = resolve(userId, input)
    if (resolved.status !== 'existing' || !resolved.taskSpace) {
      return {
        ...resolved,
        revision: 0,
        tasks: [],
      }
    }
    if (
      resolved.project?.status !== 'active' ||
      resolved.taskSpace.status === 'disabled' ||
      resolved.taskSpace.retiredAt
    ) {
      return {
        ...resolved,
        status: 'unavailable',
        revision: Number(resolved.taskSpace.revision || 0),
        tasks: [],
      }
    }

    const rows = db
      .prepare(`
      SELECT relative_path, sha256, task_id, task_dir
      FROM sync_task_space_file
      WHERE task_space_id = ? AND deleted = 0
      ORDER BY task_dir, relative_path
    `)
      .all(resolved.taskSpace.id)
    const groups = new Map()
    for (const row of rows) {
      let group = groups.get(row.task_dir)
      if (!group) {
        group = {
          taskDir: row.task_dir,
          taskId: null,
          files: [],
        }
        groups.set(row.task_dir, group)
      }
      group.files.push({
        path: row.relative_path,
        sha256: row.sha256,
      })
      if (row.relative_path === `${row.task_dir}/task.json` && row.task_id) {
        group.taskId = row.task_id
      }
    }

    return {
      ...resolved,
      revision: Number(resolved.taskSpace.revision || 0),
      tasks: [...groups.values()],
    }
  }

  function attach(userId, agentId, input = {}) {
    const actor = actorContext(userId, input.teamId)
    const teamId = requiredText(input.teamId, '归属团队', 128)
    if (!actor.systemAdmin && !actor.teams.some((team) => team.id === teamId)) {
      throw teamError(403, ERROR_CODES.FORBIDDEN, '不能把项目归属到无权访问的团队')
    }
    const branchName = validateGitBranchName(input.branchName)
    const identity = normalizeGitRemote(input.remoteUrl, { allowFileRemote })
    const identityHash = gitRemoteIdentityKey(input.remoteUrl, { allowFileRemote })
    const displayName = requiredText(input.displayName || actor.user.displayName, '项目名称', 120)
    const developerId = optionalText(input.developerId || input.trellisDevId, 120)
    const localRepoKey = assertLocalRepoKey(input.localRepoKey)
    const safeAgentId = requiredText(agentId, 'Agent ID', 128)
    if (!SAFE_ID.test(safeAgentId)) {
      throw teamError(400, ERROR_CODES.INVALID_INPUT, 'Agent ID 格式无效')
    }

    return withTransaction(db, () => {
      const agent = db
        .prepare("SELECT id, user_id FROM agent_device WHERE id = ? AND status = 'active'")
        .get(safeAgentId)
      if (!agent || agent.user_id !== userId) {
        throw teamError(403, ERROR_CODES.FORBIDDEN, 'Agent 设备与当前账号不匹配')
      }
      let project = db
        .prepare('SELECT * FROM sync_project WHERE remote_identity_hash = ?')
        .get(identityHash)
      const now = nowIso()
      if (!project) {
        project = {
          id: crypto.randomUUID(),
          name: displayName,
          remote_url: formatGitRemote(identity),
          remote_identity_hash: identityHash,
          owner_team_id: teamId,
          status: 'active',
          created_by_user_id: userId,
          created_by_agent_id: safeAgentId,
          created_at: now,
          updated_at: now,
        }
        db.prepare(`
          INSERT INTO sync_project(
            id, name, remote_url, remote_identity_hash, owner_team_id, status,
            created_by_user_id, created_by_agent_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
        `).run(
          project.id,
          project.name,
          project.remote_url,
          project.remote_identity_hash,
          project.owner_team_id,
          userId,
          safeAgentId,
          now,
          now,
        )
        db.prepare(`
          INSERT INTO sync_project_team_access(
            project_id, team_id, access_role, created_by_user_id, created_at
          ) VALUES (?, ?, 'owner', ?, ?)
        `).run(project.id, teamId, userId, now)
      }

      const access = accessContext(actor)
      if (!projectAccessible(project, actor, access, teamId)) {
        throw teamError(
          409,
          'TASK_SPACE_ACCESS_REQUIRED',
          '项目已存在但当前团队没有访问权限，请联系项目负责人邀请后再接入',
          { details: { projectId: project.id, projectName: project.name } },
        )
      }
      let member = db
        .prepare('SELECT * FROM sync_project_member WHERE project_id = ? AND user_id = ?')
        .get(project.id, userId)
      if (!member) {
        const ownerTeam = project.owner_team_id === teamId
        const role = ownerTeam ? 'lead' : 'read_only'
        if (role !== 'read_only' && !developerId) {
          throw teamError(
            400,
            ERROR_CODES.INVALID_INPUT,
            '项目首次接入必须填写 Trellis developer ID',
          )
        }
        db.prepare(`
          INSERT INTO sync_project_member(
            project_id, user_id, role, trellis_dev_id, created_by_user_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(project.id, userId, role, developerId, userId, now, now)
        member = db
          .prepare('SELECT * FROM sync_project_member WHERE project_id = ? AND user_id = ?')
          .get(project.id, userId)
      }

      let taskSpace = db
        .prepare('SELECT * FROM sync_task_space WHERE project_id = ? AND branch_name = ?')
        .get(project.id, branchName)
      if (!taskSpace) {
        taskSpace = {
          id: crypto.randomUUID(),
          project_id: project.id,
          branch_name: branchName,
          status: 'active',
          revision: 0,
          indexed_revision: 0,
          last_error: null,
          created_by_user_id: userId,
          created_by_agent_id: safeAgentId,
          created_at: now,
          updated_at: now,
        }
        db.prepare(`
          INSERT INTO sync_task_space(
            id, project_id, branch_name, status, revision, indexed_revision,
            created_by_user_id, created_by_agent_id, created_at, updated_at
          ) VALUES (?, ?, ?, 'active', 0, 0, ?, ?, ?, ?)
        `).run(taskSpace.id, project.id, branchName, userId, safeAgentId, now, now)
      }
      if (taskSpace.status === 'disabled' || taskSpace.retired_at || project.status !== 'active') {
        throw teamError(409, ERROR_CODES.PROJECT_NOT_READY, '项目或任务空间已停用')
      }
      const replacedBindings = db
        .prepare(`
          SELECT id, task_space_id, branch_name
          FROM sync_agent_binding
          WHERE agent_id = ? AND local_repo_key = ? AND task_space_id <> ?
            AND sync_status <> 'revoked'
        `)
        .all(safeAgentId, localRepoKey, taskSpace.id)
      if (replacedBindings.length) {
        const placeholders = replacedBindings.map(() => '?').join(', ')
        const bindingIds = replacedBindings.map((item) => item.id)
        db.prepare(`
          UPDATE sync_agent_binding
          SET sync_status = 'revoked', is_listening = 0,
              last_error = '任务空间绑定已被本机新分支替换', updated_at = ?
          WHERE id IN (${placeholders})
        `).run(now, ...bindingIds)
        db.prepare(`
          UPDATE sync_task_command
          SET status = 'cancelled',
              error_text = '任务空间绑定已被本机新分支替换',
              updated_at = ?
          WHERE binding_id IN (${placeholders})
            AND status IN ('pending', 'delivered', 'running')
        `).run(now, ...bindingIds)
      }
      let binding = db
        .prepare('SELECT * FROM sync_agent_binding WHERE agent_id = ? AND task_space_id = ?')
        .get(safeAgentId, taskSpace.id)
      if (!binding) {
        binding = { id: crypto.randomUUID() }
        db.prepare(`
          INSERT INTO sync_agent_binding(
            id, agent_id, task_space_id, local_repo_key, local_display_name,
            branch_name, sync_status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'approved', ?, ?)
        `).run(
          binding.id,
          safeAgentId,
          taskSpace.id,
          localRepoKey,
          displayName,
          branchName,
          now,
          now,
        )
      } else {
        const resetListener =
          binding.sync_status !== 'approved' || binding.local_repo_key !== localRepoKey
        db.prepare(`
          UPDATE sync_agent_binding
          SET local_repo_key = ?, local_display_name = ?, branch_name = ?,
              sync_status = 'approved', is_listening = ?, listener_reported_at = ?,
              last_error = NULL, updated_at = ?
          WHERE id = ?
        `).run(
          localRepoKey,
          displayName,
          branchName,
          resetListener ? 0 : binding.is_listening,
          resetListener ? null : binding.listener_reported_at,
          now,
          binding.id,
        )
      }
      binding = db.prepare('SELECT * FROM sync_agent_binding WHERE id = ?').get(binding.id)
      if (replacedBindings.length) {
        appendAuditEvent(db, {
          actorUserId: userId,
          actorAgentId: safeAgentId,
          teamId: project.owner_team_id,
          projectId: project.id,
          action: 'task_space_binding_replaced',
          targetType: 'agent_binding',
          targetId: binding.id,
          detail: {
            localRepoKey,
            newBranchName: branchName,
            newTaskSpaceId: taskSpace.id,
            replaced: replacedBindings.map((item) => ({
              bindingId: item.id,
              taskSpaceId: item.task_space_id,
              branchName: item.branch_name,
            })),
          },
          occurredAt: now,
        })
      }
      const refreshedAccess = accessContext(actor)
      const summaries = listenerSummariesFor([taskSpace.id])
      return {
        project: projectPublic(
          db.prepare('SELECT * FROM sync_project WHERE id = ?').get(project.id),
          refreshedAccess,
        ),
        taskSpace: taskSpacePublic(
          {
            ...taskSpace,
            team_id: project.owner_team_id,
            project_status: project.status,
          },
          actor,
          refreshedAccess,
          summaries.get(taskSpace.id),
        ),
        binding: {
          id: binding.id,
          agentId: binding.agent_id,
          taskSpaceId: binding.task_space_id,
          projectId: project.id,
          branchName: binding.branch_name,
          status: binding.sync_status,
          readOnly: !['lead', 'member'].includes(member.role),
        },
        replacedBindings: replacedBindings.map((item) => ({
          id: item.id,
          taskSpaceId: item.task_space_id,
          branchName: item.branch_name,
          status: 'revoked',
        })),
      }
    })
  }

  function listTaskSpaces(
    projectId,
    actor,
    { includeRetired = false, includeTaskTitles = false } = {},
  ) {
    const project = readProject(projectId, actor)
    if (!project) throw teamError(404, ERROR_CODES.NOT_FOUND, '项目不存在')
    const rows = db
      .prepare(`
        SELECT s.*, p.owner_team_id AS team_id, p.status AS project_status
        FROM sync_task_space s
        JOIN sync_project p ON p.id = s.project_id
        WHERE s.project_id = ?
          ${includeRetired ? '' : 'AND s.retired_at IS NULL'}
        ORDER BY s.branch_name COLLATE NOCASE
      `)
      .all(projectId)
    const summaries = listenerSummariesFor(rows.map((row) => row.id))
    const stats = taskSpaceStats(
      db,
      rows.map((row) => row.id),
      { includeTaskTitles },
    )
    return rows.map((row) =>
      taskSpacePublic(row, actor, project.access, summaries.get(row.id), stats.get(row.id)),
    )
  }

  function listAdminTaskSpaces(actor, projectId) {
    manageContext(actor, projectId)
    return listTaskSpaces(projectId, actor, {
      includeRetired: true,
      includeTaskTitles: true,
    })
  }

  function loadManagedTaskSpace(actor, projectId, taskSpaceId) {
    const context = manageContext(actor, projectId)
    const taskSpace = loadTaskSpaceRow(taskSpaceId)
    if (!taskSpace || taskSpace.project_id !== context.project.id) {
      throw teamError(404, ERROR_CODES.NOT_FOUND, '任务空间不存在')
    }
    return { ...context, taskSpace }
  }

  function taskSpaceAdminView(taskSpace, actor, access) {
    const summaries = listenerSummariesFor([taskSpace.id])
    const stats = taskSpaceStats(db, [taskSpace.id], { includeTaskTitles: true })
    return taskSpacePublic(
      taskSpace,
      actor,
      access,
      summaries.get(taskSpace.id),
      stats.get(taskSpace.id),
    )
  }

  function backupLabel(file) {
    return (
      String(file || '')
        .split(/[\\/]/)
        .pop() || null
    )
  }

  function retireTaskSpace(actor, projectId, taskSpaceId, input = {}) {
    const { project, access, taskSpace } = loadManagedTaskSpace(actor, projectId, taskSpaceId)
    const rawReason = String(input.reason || '').trim()
    if (rawReason.length > 500) {
      throw teamError(400, ERROR_CODES.INVALID_INPUT, '弃用原因不能超过 500 个字符')
    }
    if (taskSpace.retired_at) {
      return {
        ...taskSpaceAdminView(taskSpace, actor, access),
        alreadyRetired: true,
        affectedBindingCount: 0,
      }
    }
    const timestamp = now().toISOString()
    let affectedBindingCount = 0
    withTransaction(db, () => {
      affectedBindingCount = Number(
        db
          .prepare(`
            SELECT COUNT(*) AS count
            FROM sync_agent_binding
            WHERE task_space_id = ? AND sync_status = 'approved'
          `)
          .get(taskSpace.id).count || 0,
      )
      db.prepare(`
        UPDATE sync_task_space
        SET status = 'disabled', retired_at = ?, retired_by_user_id = ?,
            retired_reason = ?, updated_at = ?
        WHERE id = ? AND project_id = ?
      `).run(timestamp, actor.userId, rawReason || null, timestamp, taskSpace.id, project.id)
      db.prepare(`
        UPDATE sync_agent_binding
        SET is_listening = 0, updated_at = ?
        WHERE task_space_id = ? AND sync_status = 'approved'
      `).run(timestamp, taskSpace.id)
      db.prepare(`
        UPDATE sync_task_command
        SET status = 'cancelled',
            error_text = '任务空间已弃用，操作已取消',
            updated_at = ?
        WHERE task_space_id = ? AND status IN ('pending', 'delivered', 'running')
      `).run(timestamp, taskSpace.id)
      appendAuditEvent(db, {
        actorUserId: actor.userId,
        teamId: project.owner_team_id,
        projectId: project.id,
        action: 'task_space_retired',
        targetType: 'task_space',
        targetId: taskSpace.id,
        detail: {
          branchName: taskSpace.branch_name,
          previousStatus: taskSpace.status,
          reason: rawReason || null,
          affectedBindingCount,
        },
        occurredAt: timestamp,
      })
    })
    const updated = {
      ...taskSpace,
      status: 'disabled',
      retired_at: timestamp,
      retired_by_user_id: actor.userId,
      retired_reason: rawReason || null,
      updated_at: timestamp,
    }
    return {
      ...taskSpaceAdminView(updated, actor, access),
      alreadyRetired: false,
      affectedBindingCount,
    }
  }

  function restoreTaskSpace(actor, projectId, taskSpaceId) {
    const { project, access, taskSpace } = loadManagedTaskSpace(actor, projectId, taskSpaceId)
    if (!taskSpace.retired_at) {
      throw teamError(409, ERROR_CODES.CONFLICT, '任务空间不是已弃用状态')
    }
    const timestamp = now().toISOString()
    withTransaction(db, () => {
      db.prepare(`
        UPDATE sync_task_space
        SET status = 'active', retired_at = NULL, retired_by_user_id = NULL,
            retired_reason = NULL, updated_at = ?
        WHERE id = ? AND project_id = ?
      `).run(timestamp, taskSpace.id, project.id)
      db.prepare(`
        UPDATE sync_agent_binding
        SET is_listening = 0, updated_at = ?
        WHERE task_space_id = ? AND sync_status = 'approved'
      `).run(timestamp, taskSpace.id)
      appendAuditEvent(db, {
        actorUserId: actor.userId,
        teamId: project.owner_team_id,
        projectId: project.id,
        action: 'task_space_restored',
        targetType: 'task_space',
        targetId: taskSpace.id,
        detail: {
          branchName: taskSpace.branch_name,
          previousRetiredAt: taskSpace.retired_at,
        },
        occurredAt: timestamp,
      })
    })
    const updated = {
      ...taskSpace,
      status: 'active',
      retired_at: null,
      retired_by_user_id: null,
      retired_reason: null,
      updated_at: timestamp,
    }
    return taskSpaceAdminView(updated, actor, access)
  }

  function purgeTaskSpace(actor, projectId, taskSpaceId, input = {}) {
    const { project, access, taskSpace } = loadManagedTaskSpace(actor, projectId, taskSpaceId)
    const confirmation = typeof input.confirmation === 'string' ? input.confirmation : ''
    if (!confirmation || confirmation !== taskSpace.branch_name) {
      throw teamError(400, ERROR_CODES.INVALID_INPUT, '分支确认名称不匹配')
    }
    if (!backupService?.backupNowOrThrow) {
      throw teamError(503, 'DATABASE_BACKUP_UNAVAILABLE', '数据库备份服务不可用，已取消移除分支')
    }
    const summary = taskSpaceAdminView(taskSpace, actor, access)
    const unarchivedTasks = db
      .prepare(`
        SELECT title
        FROM sync_task_index
        WHERE task_space_id = ? AND archived = 0
        ORDER BY updated_at DESC, task_key
        LIMIT 100
      `)
      .all(taskSpace.id)
      .map((row) => row.title)
    const affectedAgentIds = db
      .prepare('SELECT DISTINCT agent_id FROM sync_agent_binding WHERE task_space_id = ?')
      .all(taskSpace.id)
      .map((row) => row.agent_id)
    const pendingConflictCount = Number(
      db
        .prepare(`
          SELECT COUNT(*) AS count FROM sync_conflict
          WHERE task_space_id = ? AND status = 'pending'
        `)
        .get(taskSpace.id).count || 0,
    )
    const activeCommandCount = Number(
      db
        .prepare(`
          SELECT COUNT(*) AS count FROM sync_task_command
          WHERE task_space_id = ? AND status IN ('pending', 'delivered', 'running')
        `)
        .get(taskSpace.id).count || 0,
    )
    let backupFile
    try {
      backupFile = backupService.backupNowOrThrow({ force: true })
    } catch {
      throw teamError(503, 'DATABASE_BACKUP_FAILED', '数据库备份失败，已取消移除分支')
    }
    if (!backupFile) {
      throw teamError(503, 'DATABASE_BACKUP_FAILED', '数据库备份失败，已取消移除分支')
    }
    const detail = {
      branchName: taskSpace.branch_name,
      taskCount: summary.taskCount,
      fileCount: summary.fileCount,
      activeTaskCount: summary.activeTaskCount,
      archivedTaskCount: summary.archivedTaskCount,
      unarchivedTasks,
      approvedBindingCount: summary.approvedBindingCount,
      onlineListenerCount: summary.onlineListenerCount,
      affectedAgentIds,
      pendingConflictCount,
      activeCommandCount,
      backupName: backupLabel(backupFile),
    }
    withTransaction(db, () => {
      const current = db
        .prepare('SELECT id, branch_name FROM sync_task_space WHERE id = ? AND project_id = ?')
        .get(taskSpace.id, project.id)
      if (!current) throw teamError(404, ERROR_CODES.NOT_FOUND, '任务空间不存在')
      if (current.branch_name !== confirmation) {
        throw teamError(409, ERROR_CODES.CONFLICT, '任务空间分支已变化，请刷新后重试')
      }
      appendAuditEvent(db, {
        actorUserId: actor.userId,
        teamId: project.owner_team_id,
        projectId: project.id,
        action: 'task_space_purged',
        targetType: 'task_space',
        targetId: taskSpace.id,
        detail,
        occurredAt: now().toISOString(),
      })
      const result = db
        .prepare('DELETE FROM sync_task_space WHERE id = ? AND project_id = ?')
        .run(taskSpace.id, project.id)
      if (Number(result.changes) !== 1) {
        throw teamError(409, ERROR_CODES.CONFLICT, '任务空间状态已变化，请刷新后重试')
      }
    })
    return {
      purged: true,
      taskSpaceId: taskSpace.id,
      branchName: taskSpace.branch_name,
      backupName: backupLabel(backupFile),
      summary: detail,
    }
  }

  function authorizeTaskSpace(
    actor,
    taskSpaceId,
    capability = 'view',
    { allowDisabled = false } = {},
  ) {
    const taskSpace = db
      .prepare(`
      SELECT s.*, p.owner_team_id, p.status AS project_status
      FROM sync_task_space s
      JOIN sync_project p ON p.id = s.project_id
      WHERE s.id = ?
    `)
      .get(String(taskSpaceId || ''))
    if (!taskSpace) throw teamError(404, ERROR_CODES.NOT_FOUND, '任务空间不存在')
    const project = loadProjectRow(taskSpace.project_id)
    const access = accessContext(actor)
    if (!projectAccessible(project, actor, access)) {
      throw teamError(404, ERROR_CODES.NOT_FOUND, '任务空间不存在')
    }
    if (
      !allowDisabled &&
      (taskSpace.status === 'disabled' || taskSpace.retired_at || project.status !== 'active')
    ) {
      throw teamError(409, ERROR_CODES.PROJECT_NOT_READY, '任务空间已停用')
    }
    const member = access.projectMembers.get(project.id)?.get(actor.userId) || null
    const teamAdmin = (actor.teams || []).some(
      (team) =>
        access.teamAccessByProject.has(`${project.id}\0${team.id}`) && team.role === 'admin',
    )
    if (capability === 'write') {
      if (actor.systemAdmin || member?.role === 'lead' || member?.role === 'member') {
        return { taskSpace, project, member, access }
      }
      if (teamAdmin) {
        throw teamError(
          403,
          ERROR_CODES.FORBIDDEN,
          '团队管理员可以管理项目，但必须先映射 Trellis developer ID 才能写任务',
        )
      }
      throw teamError(403, ERROR_CODES.FORBIDDEN, '只读成员不能修改任务')
    }
    return {
      taskSpace,
      project,
      member,
      access,
      canManage: Boolean(actor.systemAdmin || teamAdmin || member?.role === 'lead'),
    }
  }

  function listenerDetails(actor, taskSpaceId) {
    const authorized = authorizeTaskSpace(actor, taskSpaceId, 'view', { allowDisabled: true })
    if (!authorized.canManage) {
      throw teamError(403, ERROR_CODES.FORBIDDEN, '只有项目负责人或团队管理员可以查看监听详情')
    }
    const summaries = listenerSummariesFor([authorized.taskSpace.id])
    const summary = summaries.get(authorized.taskSpace.id) || emptyListenerSummary()
    const taskSpace = taskSpacePublic(authorized.taskSpace, actor, authorized.access, summary)
    const staleCutoff = new Date(now().getTime() - effectiveStaleMs).toISOString()
    const listeners = db
      .prepare(`
      SELECT
        b.id AS binding_id,
        b.agent_id,
        a.user_id,
        u.username,
        u.display_name,
        a.device_name,
        b.sync_status,
        b.listener_reported_at,
        b.last_listener_at,
        b.created_at,
        CASE
          WHEN b.is_listening = 1
            AND b.listener_reported_at >= ?
            AND a.status = 'active'
            AND a.last_seen_at >= ?
            AND active.agent_id = a.id
            AND s.status = 'active'
            AND p.status = 'active'
          THEN 1 ELSE 0
        END AS online
      FROM sync_agent_binding b
      JOIN agent_device a ON a.id = b.agent_id
      JOIN user_account u ON u.id = a.user_id
      JOIN sync_task_space s ON s.id = b.task_space_id
      JOIN sync_project p ON p.id = s.project_id
      LEFT JOIN sync_active_agent active ON active.user_id = a.user_id
      WHERE b.task_space_id = ? AND b.sync_status = 'approved'
      ORDER BY online DESC, b.created_at, b.id
    `)
      .all(staleCutoff, staleCutoff, authorized.taskSpace.id)
      .map((row) => ({
        bindingId: row.binding_id,
        userId: row.user_id,
        username: row.username,
        displayName: row.display_name,
        deviceName: row.device_name,
        bindingStatus: row.sync_status,
        online: Boolean(row.online),
        listenerReportedAt: row.listener_reported_at || null,
        lastListenerAt: row.last_listener_at || null,
        boundAt: row.created_at,
      }))
    return {
      taskSpaceId: taskSpace.id,
      branchName: taskSpace.branchName,
      listenerState: taskSpace.listenerState,
      approvedBindingCount: taskSpace.approvedBindingCount,
      onlineListenerCount: taskSpace.onlineListenerCount,
      lastListenerAt: taskSpace.lastListenerAt,
      listeners,
    }
  }

  function detachAgent(agent, taskSpaceId, input = {}) {
    const agentId = safeId(agent?.id, 'Agent ID')
    const userId = requiredText(agent?.userId, '用户 ID', 128)
    const spaceId = safeId(taskSpaceId, '任务空间 ID')
    const localRepoKey = assertLocalRepoKey(input.localRepoKey)
    const activeAgent = db
      .prepare(`
      SELECT 1
      FROM agent_device a
      JOIN sync_active_agent active ON active.user_id = a.user_id AND active.agent_id = a.id
      WHERE a.id = ? AND a.user_id = ? AND a.status = 'active'
    `)
      .get(agentId, userId)
    if (!activeAgent) {
      throw teamError(403, ERROR_CODES.FORBIDDEN, 'Agent 设备不是当前账号的有效设备')
    }
    const taskSpace = loadTaskSpaceRow(spaceId)
    if (!taskSpace) throw teamError(404, ERROR_CODES.NOT_FOUND, '任务空间不存在')
    const actor = actorContext(userId)
    const access = accessContext(actor)
    const project = loadProjectRow(taskSpace.project_id)
    if (!project || !projectAccessible(project, actor, access)) {
      throw teamError(404, ERROR_CODES.NOT_FOUND, '任务空间不存在')
    }

    return withTransaction(db, () => {
      const binding = db
        .prepare(`
        SELECT *
        FROM sync_agent_binding
        WHERE agent_id = ? AND task_space_id = ?
      `)
        .get(agentId, spaceId)
      if (!binding) {
        return {
          detached: true,
          alreadyDetached: true,
          taskSpaceId: spaceId,
          bindingId: null,
        }
      }
      if (binding.local_repo_key !== localRepoKey) {
        throw teamError(
          409,
          'TASK_SPACE_BINDING_MISMATCH',
          '本地仓库与当前任务空间关联不一致，请刷新本地关联后重试',
          { details: { taskSpaceId: spaceId, bindingId: binding.id } },
        )
      }
      if (binding.sync_status === 'revoked') {
        return {
          detached: true,
          alreadyDetached: true,
          taskSpaceId: spaceId,
          bindingId: binding.id,
        }
      }
      const timestamp = now().toISOString()
      db.prepare(`
        UPDATE sync_agent_binding
        SET sync_status = 'revoked', is_listening = 0, updated_at = ?
        WHERE id = ? AND sync_status <> 'revoked'
      `).run(timestamp, binding.id)
      db.prepare(`
        UPDATE sync_task_command
        SET status = 'cancelled',
            error_text = '客户端主动解除任务空间关联',
            updated_at = ?
        WHERE binding_id = ? AND status IN ('pending', 'delivered', 'running')
      `).run(timestamp, binding.id)
      db.prepare('DELETE FROM sync_agent_cursor WHERE agent_id = ? AND task_space_id = ?').run(
        agentId,
        spaceId,
      )
      appendAuditEvent(db, {
        actorUserId: userId,
        actorAgentId: agentId,
        teamId: project.owner_team_id,
        projectId: project.id,
        action: 'task_space_binding_detached',
        targetType: 'agent_binding',
        targetId: binding.id,
        detail: {
          previousStatus: binding.sync_status,
          branchName: binding.branch_name,
          taskSpaceId: spaceId,
          detachedAt: timestamp,
        },
        occurredAt: timestamp,
      })
      return {
        detached: true,
        alreadyDetached: false,
        taskSpaceId: spaceId,
        bindingId: binding.id,
      }
    })
  }

  function inviteTeam(actor, projectId, teamId, accessRole = 'member') {
    const project = loadProjectRow(projectId)
    if (!project) throw teamError(404, ERROR_CODES.NOT_FOUND, '项目不存在')
    const access = accessContext(actor)
    const member = access.projectMembers.get(projectId)?.get(actor.userId) || null
    const ownerAdmin = (actor.teams || []).some(
      (team) => team.id === project.owner_team_id && team.role === 'admin',
    )
    if (!actor.systemAdmin && !ownerAdmin && member?.role !== 'lead') {
      throw teamError(403, ERROR_CODES.FORBIDDEN, '无权邀请其他团队')
    }
    const target = db
      .prepare("SELECT id FROM team WHERE id = ? AND status = 'active'")
      .get(String(teamId || ''))
    if (!target) throw teamError(404, ERROR_CODES.NOT_FOUND, '团队不存在')
    const role = accessRole === 'owner' ? 'owner' : 'member'
    const now = nowIso()
    db.prepare(`
      INSERT INTO sync_project_team_access(
        project_id, team_id, access_role, created_by_user_id, created_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(project_id, team_id) DO UPDATE SET
        access_role = excluded.access_role,
        created_by_user_id = excluded.created_by_user_id,
        created_at = excluded.created_at
    `).run(projectId, teamId, role, actor.userId, now)
    return { projectId, teamId, accessRole: role }
  }

  function listTeamAccess(actor, projectId) {
    const project = readProject(projectId, actor)
    if (!project) throw teamError(404, ERROR_CODES.NOT_FOUND, '项目不存在')
    return db
      .prepare(`
      SELECT a.project_id, a.team_id, a.access_role, a.created_at,
             t.name AS team_name, t.status AS team_status
      FROM sync_project_team_access a
      JOIN team t ON t.id = a.team_id
      WHERE a.project_id = ?
      ORDER BY CASE a.access_role WHEN 'owner' THEN 0 ELSE 1 END,
               t.name COLLATE NOCASE
    `)
      .all(projectId)
      .map((row) => ({
        projectId: row.project_id,
        teamId: row.team_id,
        teamName: row.team_name,
        teamStatus: row.team_status,
        accessRole: row.access_role,
        createdAt: row.created_at,
      }))
  }

  function removeTeam(actor, projectId, teamId) {
    const project = loadProjectRow(projectId)
    if (!project) throw teamError(404, ERROR_CODES.NOT_FOUND, '项目不存在')
    if (teamId === project.owner_team_id) {
      throw teamError(409, ERROR_CODES.CONFLICT, '不能移除项目所有者团队')
    }
    const member = accessContext(actor).projectMembers.get(projectId)?.get(actor.userId)
    if (!actor.systemAdmin && member?.role !== 'lead') {
      throw teamError(403, ERROR_CODES.FORBIDDEN, '无权移除项目团队')
    }
    db.prepare('DELETE FROM sync_project_team_access WHERE project_id = ? AND team_id = ?').run(
      projectId,
      teamId,
    )
    return { projectId, teamId, removed: true }
  }

  function upsertMember(actor, input = {}) {
    const projectId = requiredText(input.projectId, '项目 ID', 128)
    const userId = requiredText(input.userId, '用户 ID', 128)
    const role = normalizeRole(input.role)
    const developerId = optionalText(input.trellisDevId || input.developerId, 120)
    if (role !== 'read_only' && !developerId) {
      throw teamError(400, ERROR_CODES.INVALID_INPUT, '可写成员必须填写 Trellis developer ID')
    }
    const project = loadProjectRow(projectId)
    if (!project) throw teamError(404, ERROR_CODES.NOT_FOUND, '项目不存在')
    const current = accessContext(actor).projectMembers.get(projectId)?.get(actor.userId)
    const ownerAdmin = (actor.teams || []).some(
      (team) => team.id === project.owner_team_id && team.role === 'admin',
    )
    if (!actor.systemAdmin && !ownerAdmin && current?.role !== 'lead') {
      throw teamError(403, ERROR_CODES.FORBIDDEN, '无权管理项目成员')
    }
    const user = db
      .prepare("SELECT id FROM user_account WHERE id = ? AND status = 'active'")
      .get(userId)
    if (!user) throw teamError(404, ERROR_CODES.NOT_FOUND, '用户不存在')
    const now = nowIso()
    db.prepare(`
      INSERT INTO sync_project_member(
        project_id, user_id, role, trellis_dev_id, created_by_user_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, user_id) DO UPDATE SET
        role = excluded.role,
        trellis_dev_id = excluded.trellis_dev_id,
        updated_at = excluded.updated_at
    `).run(projectId, userId, role, developerId, actor.userId, now, now)
    return {
      userId,
      username: db.prepare('SELECT username FROM user_account WHERE id = ?').get(userId).username,
      role,
      trellisDevId: developerId,
    }
  }

  function listVisibleMembers(actor, projectId) {
    const project = readProject(projectId, actor)
    if (!project) throw teamError(404, ERROR_CODES.NOT_FOUND, '项目不存在')
    return [...(project.access.projectMembers.get(projectId)?.values() || [])]
  }

  function removeMember(actor, input = {}) {
    const projectId = requiredText(input.projectId, '项目 ID', 128)
    const userId = requiredText(input.userId, '用户 ID', 128)
    const project = loadProjectRow(projectId)
    if (!project) throw teamError(404, ERROR_CODES.NOT_FOUND, '项目不存在')
    const current = accessContext(actor).projectMembers.get(projectId)?.get(actor.userId)
    const ownerAdmin = (actor.teams || []).some(
      (team) => team.id === project.owner_team_id && team.role === 'admin',
    )
    if (!actor.systemAdmin && !ownerAdmin && current?.role !== 'lead') {
      throw teamError(403, ERROR_CODES.FORBIDDEN, '无权移除项目成员')
    }
    db.prepare('DELETE FROM sync_project_member WHERE project_id = ? AND user_id = ?').run(
      projectId,
      userId,
    )
    return listVisibleMembers(actor, projectId)
  }

  function disableProject(actor, projectId) {
    const row = loadProjectRow(projectId)
    if (!row) throw teamError(404, ERROR_CODES.NOT_FOUND, '项目不存在')
    const member = accessContext(actor).projectMembers.get(projectId)?.get(actor.userId)
    const ownerAdmin = (actor.teams || []).some(
      (team) => team.id === row.owner_team_id && team.role === 'admin',
    )
    if (!actor.systemAdmin && !ownerAdmin && member?.role !== 'lead') {
      throw teamError(403, ERROR_CODES.FORBIDDEN, '无权停用项目')
    }
    const now = nowIso()
    withTransaction(db, () => {
      db.prepare("UPDATE sync_project SET status = 'disabled', updated_at = ? WHERE id = ?").run(
        now,
        projectId,
      )
      db.prepare(`
        UPDATE sync_agent_binding
        SET is_listening = 0, updated_at = ?
        WHERE task_space_id IN (SELECT id FROM sync_task_space WHERE project_id = ?)
      `).run(now, projectId)
      db.prepare(`
        UPDATE sync_task_command
        SET status = 'cancelled', updated_at = ?
        WHERE project_id = ? AND status IN ('pending', 'delivered', 'running')
      `).run(now, projectId)
    })
    return { projectId, status: 'disabled' }
  }

  function listAssociationCandidates(actor) {
    return listReadable(actor)
  }

  function listStatusReadable(actor) {
    return listReadable(actor, { includeDisabled: true })
  }

  return {
    actorContext,
    readProject,
    readTaskSpace,
    loadTaskSpaceRow,
    listReadable,
    listStatusReadable,
    listAssociationCandidates,
    listAll,
    listTaskSpaces,
    listAdminTaskSpaces,
    retireTaskSpace,
    restoreTaskSpace,
    purgeTaskSpace,
    resolve,
    preflight,
    attach,
    authorizeTaskSpace,
    listenerDetails,
    detachAgent,
    inviteTeam,
    listTeamAccess,
    removeTeam,
    upsertMember,
    listVisibleMembers,
    removeMember,
    disableProject,
  }
}
