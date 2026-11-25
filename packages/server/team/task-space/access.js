import {
  formatGitRemote,
  gitRemoteIdentityKey,
  normalizeGitRemote,
  validateGitBranchName,
} from '@trellis-board/shared/remote-identity.js'
import { listTeamsForActor } from '../teams.js'
import { ERROR_CODES, teamError } from '../errors.js'

function parsePreflightTaskMeta(jsonText) {
  if (!jsonText) return { title: null, taskBranch: null }
  try {
    const parsed = JSON.parse(jsonText)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { title: null, taskBranch: null }
    }
    const title =
      typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title.trim() : null
    const taskBranch =
      typeof parsed.branch === 'string' && parsed.branch.trim() ? parsed.branch.trim() : null
    return { title, taskBranch }
  } catch {
    return { title: null, taskBranch: null }
  }
}

export function createAccess({ db, statements, view, allowFileRemote, now = () => new Date() }) {
  function actorContext(userId, requestedTeamId = null) {
    const user = statements.userAccountById.get(userId)
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
      const team = statements.activeTeamById.get(teamId)
      if (!team) throw teamError(404, ERROR_CODES.NOT_FOUND, '团队不存在')
      if (!actor.systemAdmin && !actor.teams.some((item) => item.id === teamId)) {
        throw teamError(403, ERROR_CODES.FORBIDDEN, '无权访问该团队')
      }
    }
    return actor
  }

  function accessContext(actor) {
    const teamAccess = statements.allTeamAccess.all()
    const members = statements.projectMembersWithUser.all()
    const workspaceMembers = statements.workspaceDevIds.all()
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
    return statements.projectById.get(String(projectId || '')) || null
  }

  function loadTaskSpaceRow(taskSpaceId) {
    return statements.taskSpaceDetailById.get(String(taskSpaceId || '')) || null
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
    const rows = statements.activeProjects
      .all()
      .filter((row) => projectAccessible(row, actor, access))
      .filter(
        (row) => !scope || scope === 'all' || access.teamAccessByProject.has(`${row.id}\0${scope}`),
      )
    const projectIds = rows.map((row) => row.id)
    const spaces = projectIds.length
      ? statements.taskSpacesForProjects(projectIds.length, includeDisabled).all(...projectIds)
      : []
    const spacesByProject = new Map()
    for (const space of spaces) {
      if (!spacesByProject.has(space.project_id)) spacesByProject.set(space.project_id, [])
      spacesByProject.get(space.project_id).push(space)
    }
    const summaries = view.listenerSummariesFor(spaces.map((space) => space.id))
    const stats = view.taskSpaceStatsFor(spaces.map((space) => space.id))
    return rows.map((row) => {
      const project = view.projectPublic(row, access, actor)
      project.taskSpaces = (spacesByProject.get(row.id) || []).map((space) =>
        view.taskSpacePublic(space, actor, access, summaries.get(space.id), stats.get(space.id)),
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
      const team = statements.activeTeamById.get(requestedTeamId)
      if (!team) throw teamError(404, ERROR_CODES.NOT_FOUND, '团队不存在')
    }
    const rows = statements.allProjects.all()
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
      ? statements.taskSpacesForAllProjects(projectIds.length).all(...projectIds)
      : []
    const summaries = view.listenerSummariesFor(spaces.map((space) => space.id))
    const stats = view.taskSpaceStatsFor(spaces.map((space) => space.id))
    const spacesByProject = new Map()
    for (const space of spaces) {
      if (!spacesByProject.has(space.project_id)) spacesByProject.set(space.project_id, [])
      spacesByProject.get(space.project_id).push(space)
    }
    return scopedRows.map((row) => {
      const project = view.projectPublic(row, access)
      project.taskSpaces = (spacesByProject.get(row.id) || []).map((space) =>
        view.taskSpacePublic(space, actor, access, summaries.get(space.id), stats.get(space.id)),
      )
      return project
    })
  }

  function resolve(userId, input = {}) {
    const actor = actorContext(userId, input.teamId)
    const branchName = validateGitBranchName(input.branchName)
    const identity = normalizeGitRemote(input.remoteUrl, { allowFileRemote })
    const identityHash = gitRemoteIdentityKey(input.remoteUrl, { allowFileRemote })
    const project = statements.projectByRemoteHash.get(identityHash)
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
    const taskSpace = statements.taskSpaceBranchWithProject.get(project.id, branchName)
    if (taskSpace?.retired_at) {
      return {
        status: 'unavailable',
        canCreate: false,
        remoteUrl: project.remote_url,
        remoteIdentityHash: identityHash,
        branchName,
        project: view.projectPublic(project, access),
        taskSpace: null,
      }
    }
    const summaries = view.listenerSummariesFor(taskSpace ? [taskSpace.id] : [])
    return {
      status: taskSpace ? 'existing' : 'branch_new',
      canCreate: !taskSpace,
      remoteUrl: project.remote_url,
      remoteIdentityHash: identityHash,
      branchName,
      project: view.projectPublic(project, access),
      taskSpace: taskSpace
        ? view.taskSpacePublic(taskSpace, actor, access, summaries.get(taskSpace.id))
        : null,
    }
  }

  function preflight(userId, input = {}, options = {}) {
    const resolved = resolve(userId, input)
    if (resolved.status !== 'existing' || !resolved.taskSpace) {
      return {
        ...resolved,
        revision: 0,
        tasks: [],
        hiddenTaskDirs: [],
        archivedTaskBasenames: [],
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
        hiddenTaskDirs: [],
        archivedTaskBasenames: [],
      }
    }

    const agentId =
      typeof options.agentId === 'string' && options.agentId.trim() ? options.agentId.trim() : null
    const rows = statements.preflightFiles.all(
      userId,
      resolved.taskSpace.id,
      now().toISOString(),
      agentId,
      agentId,
    )
    const groups = new Map()
    for (const row of rows) {
      let group = groups.get(row.task_dir)
      if (!group) {
        group = {
          taskDir: row.task_dir,
          taskId: null,
          title: null,
          taskBranch: null,
          files: [],
        }
        groups.set(row.task_dir, group)
      }
      group.files.push({
        path: row.relative_path,
        sha256: row.sha256,
      })
      if (row.relative_path === `${row.task_dir}/task.json`) {
        if (row.task_id) group.taskId = row.task_id
        const meta = parsePreflightTaskMeta(row.task_json_text)
        group.title = meta.title
        group.taskBranch = meta.taskBranch
      }
    }

    const hiddenTaskDirSet = new Set()
    const archivedBasenameSet = new Set()
    for (const row of statements.preflightHiddenTasks.all(resolved.taskSpace.id, userId)) {
      const dir = String(row.relative_dir || '').trim()
      if (!dir) continue
      hiddenTaskDirSet.add(dir)
      if (Number(row.archived) === 1) {
        const base = dir.split('/').filter(Boolean).pop()
        if (base) archivedBasenameSet.add(base)
      }
    }
    for (const row of statements.preflightLegacyTaskDirs.all(resolved.taskSpace.id)) {
      const dir = String(row.task_dir || '').trim()
      if (dir) hiddenTaskDirSet.add(dir)
    }

    return {
      ...resolved,
      revision: Number(resolved.taskSpace.revision || 0),
      tasks: [...groups.values()],
      hiddenTaskDirs: [...hiddenTaskDirSet].sort(),
      archivedTaskBasenames: [...archivedBasenameSet].sort(),
    }
  }

  function listAssociationCandidates(actor) {
    return listReadable(actor)
  }

  function listStatusReadable(actor) {
    return listReadable(actor, { includeDisabled: true })
  }

  return {
    actorContext,
    accessContext,
    projectAccessible,
    loadProjectRow,
    loadTaskSpaceRow,
    readProject,
    readTaskSpace,
    manageContext,
    listReadable,
    listAll,
    resolve,
    preflight,
    listAssociationCandidates,
    listStatusReadable,
  }
}
