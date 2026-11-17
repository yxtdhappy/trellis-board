import { ERROR_CODES, teamError } from '../errors.js'
import { canManageSystem, isTeamManager, readProjectAccess } from '../permissions.js'
import { readPlugin } from './registry.js'

/**
 * team 插件的权限矩阵（design.md §5）。
 *
 * 角色来源唯一：`user_account.system_admin` / `team_member.role` / `project_member.role`。
 * 这里不重复实现角色查询，全部复用 `apps/server/team/permissions.js`。
 */

function denied(message = '无权执行该操作') {
  return teamError(403, ERROR_CODES.FORBIDDEN, message)
}

function teamIdsOf(actor) {
  return (actor?.teams ?? []).map((team) => team.id)
}

export function createPluginPolicy({ db }) {
  function assertAuthenticated(actor) {
    if (!actor?.userId) throw teamError(401, ERROR_CODES.AUTH_REQUIRED, '需要登录')
  }

  function assertSystemAdmin(actor) {
    assertAuthenticated(actor)
    if (!canManageSystem(actor)) throw denied('只有系统管理员可以管理插件进程')
  }

  function assertTeamAdmin(actor, teamId) {
    assertAuthenticated(actor)
    if (!isTeamManager(actor, teamId)) throw denied('只有系统管理员或团队管理员可以管理团队插件')
  }

  /** 插件必须全局启用，且对 actor 所在的某个团队启用（系统管理员不需要团队启用）。 */
  function assertPluginVisible(actor, pluginId) {
    assertAuthenticated(actor)
    const plugin = readPlugin(db, pluginId)
    if (!plugin) throw teamError(404, ERROR_CODES.PLUGIN_NOT_FOUND, '插件不存在')
    if (!plugin.enabled) throw teamError(403, ERROR_CODES.PLUGIN_DISABLED, '插件已被系统管理员停用')
    if (canManageSystem(actor)) return plugin
    const teamIds = teamIdsOf(actor)
    if (!teamIds.length) throw denied('你不在任何团队中')
    const row = db
      .prepare(
        `
      SELECT 1
      FROM plugin_team_setting
      WHERE plugin_id = ? AND enabled = 1 AND team_id IN (${teamIds.map(() => '?').join(',')})
      LIMIT 1
    `,
      )
      .get(plugin.id, ...teamIds)
    if (!row) throw denied('团队还没有启用这个插件')
    return plugin
  }

  function isPluginVisible(actor, pluginId) {
    try {
      assertPluginVisible(actor, pluginId)
      return true
    } catch {
      return false
    }
  }

  /** 每个人只能写自己的非敏感偏好。 */
  function assertCanConfigureSelf(actor, targetUserId) {
    assertAuthenticated(actor)
    if (String(actor.userId) !== String(targetUserId)) throw denied('只能修改自己的插件配置')
  }

  /** 管理员可以看别人的在线状态；普通用户只能看自己。 */
  function assertCanViewOther(actor, targetUserId, teamId) {
    assertAuthenticated(actor)
    if (String(actor.userId) === String(targetUserId)) return
    if (canManageSystem(actor)) return
    if (teamId && isTeamManager(actor, teamId)) return
    throw denied('无权查看其他用户的插件状态')
  }

  /** 强制下线：系统管理员或该团队的管理员。 */
  function assertCanForceLogout(actor, targetUserId, teamId) {
    assertAuthenticated(actor)
    if (canManageSystem(actor)) return
    if (teamId && isTeamManager(actor, teamId)) return
    throw denied('只有系统管理员或团队管理员可以让该用户重新登录')
  }

  /** 项目绑定：系统管理员、团队管理员、或该项目的 lead。 */
  function assertCanBindProject(actor, { teamId, projectId }) {
    assertAuthenticated(actor)
    if (canManageSystem(actor)) return
    if (teamId && isTeamManager(actor, teamId)) return
    if (!projectId) throw denied('缺少项目')
    const access = readProjectAccess(db, projectId, actor)
    if (!access) throw teamError(404, ERROR_CODES.NOT_FOUND, '项目不存在')
    if (access.role === 'lead') return
    throw denied('只有系统管理员、团队管理员或项目负责人可以绑定插件项目')
  }

  function assertTeamSetting(actor, teamId) {
    assertTeamAdmin(actor, teamId)
  }

  return {
    assertAuthenticated,
    assertSystemAdmin,
    assertTeamAdmin,
    assertTeamSetting,
    assertPluginVisible,
    isPluginVisible,
    assertCanConfigureSelf,
    assertCanViewOther,
    assertCanForceLogout,
    assertCanBindProject,
  }
}
