import { withTransaction } from '../../database.js'
import { ERROR_CODES, teamError } from '../errors.js'
import { nowIso, normalizeRole, optionalText, requiredText } from './shared.js'

export function createMembership({ db, statements, access }) {
  function inviteTeam(actor, projectId, teamId, accessRole = 'member') {
    const project = access.loadProjectRow(projectId)
    if (!project) throw teamError(404, ERROR_CODES.NOT_FOUND, '项目不存在')
    const accessContext = access.accessContext(actor)
    const member = accessContext.projectMembers.get(projectId)?.get(actor.userId) || null
    const ownerAdmin = (actor.teams || []).some(
      (team) => team.id === project.owner_team_id && team.role === 'admin',
    )
    if (!actor.systemAdmin && !ownerAdmin && member?.role !== 'lead') {
      throw teamError(403, ERROR_CODES.FORBIDDEN, '无权邀请其他团队')
    }
    const target = statements.activeTeamById.get(String(teamId || ''))
    if (!target) throw teamError(404, ERROR_CODES.NOT_FOUND, '团队不存在')
    const role = accessRole === 'owner' ? 'owner' : 'member'
    const now = nowIso()
    statements.upsertTeamAccess.run(projectId, teamId, role, actor.userId, now)
    return { projectId, teamId, accessRole: role }
  }

  function listTeamAccess(actor, projectId) {
    const project = access.readProject(projectId, actor)
    if (!project) throw teamError(404, ERROR_CODES.NOT_FOUND, '项目不存在')
    return statements.teamAccessList.all(projectId).map((row) => ({
      projectId: row.project_id,
      teamId: row.team_id,
      teamName: row.team_name,
      teamStatus: row.team_status,
      accessRole: row.access_role,
      createdAt: row.created_at,
    }))
  }

  function removeTeam(actor, projectId, teamId) {
    const project = access.loadProjectRow(projectId)
    if (!project) throw teamError(404, ERROR_CODES.NOT_FOUND, '项目不存在')
    if (teamId === project.owner_team_id) {
      throw teamError(409, ERROR_CODES.CONFLICT, '不能移除项目所有者团队')
    }
    const member = access.accessContext(actor).projectMembers.get(projectId)?.get(actor.userId)
    if (!actor.systemAdmin && member?.role !== 'lead') {
      throw teamError(403, ERROR_CODES.FORBIDDEN, '无权移除项目团队')
    }
    statements.deleteTeamAccess.run(projectId, teamId)
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
    const project = access.loadProjectRow(projectId)
    if (!project) throw teamError(404, ERROR_CODES.NOT_FOUND, '项目不存在')
    const current = access.accessContext(actor).projectMembers.get(projectId)?.get(actor.userId)
    const ownerAdmin = (actor.teams || []).some(
      (team) => team.id === project.owner_team_id && team.role === 'admin',
    )
    if (!actor.systemAdmin && !ownerAdmin && current?.role !== 'lead') {
      throw teamError(403, ERROR_CODES.FORBIDDEN, '无权管理项目成员')
    }
    const user = statements.activeUserById.get(userId)
    if (!user) throw teamError(404, ERROR_CODES.NOT_FOUND, '用户不存在')
    const now = nowIso()
    statements.upsertProjectMember.run(projectId, userId, role, developerId, actor.userId, now, now)
    return {
      userId,
      username: statements.usernameById.get(userId).username,
      role,
      trellisDevId: developerId,
    }
  }

  function listVisibleMembers(actor, projectId) {
    const project = access.readProject(projectId, actor)
    if (!project) throw teamError(404, ERROR_CODES.NOT_FOUND, '项目不存在')
    return [...(project.access.projectMembers.get(projectId)?.values() || [])]
  }

  function removeMember(actor, input = {}) {
    const projectId = requiredText(input.projectId, '项目 ID', 128)
    const userId = requiredText(input.userId, '用户 ID', 128)
    const project = access.loadProjectRow(projectId)
    if (!project) throw teamError(404, ERROR_CODES.NOT_FOUND, '项目不存在')
    const current = access.accessContext(actor).projectMembers.get(projectId)?.get(actor.userId)
    const ownerAdmin = (actor.teams || []).some(
      (team) => team.id === project.owner_team_id && team.role === 'admin',
    )
    if (!actor.systemAdmin && !ownerAdmin && current?.role !== 'lead') {
      throw teamError(403, ERROR_CODES.FORBIDDEN, '无权移除项目成员')
    }
    statements.deleteProjectMember.run(projectId, userId)
    return listVisibleMembers(actor, projectId)
  }

  function disableProject(actor, projectId) {
    const row = access.loadProjectRow(projectId)
    if (!row) throw teamError(404, ERROR_CODES.NOT_FOUND, '项目不存在')
    const member = access.accessContext(actor).projectMembers.get(projectId)?.get(actor.userId)
    const ownerAdmin = (actor.teams || []).some(
      (team) => team.id === row.owner_team_id && team.role === 'admin',
    )
    if (!actor.systemAdmin && !ownerAdmin && member?.role !== 'lead') {
      throw teamError(403, ERROR_CODES.FORBIDDEN, '无权停用项目')
    }
    const now = nowIso()
    withTransaction(db, () => {
      statements.disableProjectRow.run(now, projectId)
      statements.stopProjectBindings.run(now, projectId)
      statements.cancelProjectCommands.run(now, projectId)
    })
    return { projectId, status: 'disabled' }
  }

  return {
    inviteTeam,
    listTeamAccess,
    removeTeam,
    upsertMember,
    listVisibleMembers,
    removeMember,
    disableProject,
  }
}
