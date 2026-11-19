import { parseCookieHeader, readSession, SESSION_COOKIE } from '../auth.js'
import { ERROR_CODES, teamError } from '../errors.js'
import { TEAM_ROLES, listTeamsForActor } from '../teams.js'
import { runtimeProject } from './common.js'

export function createRequestContext(ctx) {
  const { config, db, boardService, taskSpaceIndex, agentService, boardEvents } = ctx

  function readActor(request) {
    const cookies = parseCookieHeader(request.headers.cookie)
    const token = cookies.get(SESSION_COOKIE)
    const session = readSession(db, token)
    if (!session) return null
    return {
      userId: session.user.id,
      sessionId: session.sessionId,
      systemAdmin: session.user.systemAdmin,
      teams: session.teams,
      user: session.user,
      expiresAt: session.expiresAt,
    }
  }

  function runtimePayload(actor) {
    if (!actor) {
      return {
        mode: 'team',
        team: true,
        authenticated: false,
        user: null,
        projects: [],
        capabilities: {},
        allowLocalGitRemotes: Boolean(config.allowLocalGitRemotes),
      }
    }
    const projects = boardService.listProjects(actor)
    const teams = listTeamsForActor(db, actor, { activeOnly: true })
    return {
      mode: 'team',
      team: true,
      authenticated: true,
      user: actor.user,
      sessionExpiresAt: actor.expiresAt,
      systemAdmin: actor.systemAdmin,
      activeTeamId: null,
      activeTeam: null,
      teamRole: null,
      teams,
      allowLocalGitRemotes: Boolean(config.allowLocalGitRemotes),
      projects: projects.map((project) => runtimeProject(project, actor)),
      capabilities: {
        manageUsers: actor.systemAdmin,
        manageTeams: actor.systemAdmin,
        manageProjects: actor.systemAdmin || teams.some((team) => team.role === TEAM_ROLES.ADMIN),
        manageAgents: actor.systemAdmin || teams.some((team) => team.role === TEAM_ROLES.ADMIN),
        viewSystemAudit: actor.systemAdmin || teams.some((team) => team.role === TEAM_ROLES.ADMIN),
      },
    }
  }

  function requireActor(request) {
    const actor = readActor(request)
    if (!actor) {
      throw teamError(401, ERROR_CODES.AUTH_REQUIRED, '需要登录')
    }
    return actor
  }

  function templateIdentity(request) {
    const actor = readActor(request)
    if (actor) {
      return {
        userId: actor.userId,
        systemAdmin: actor.systemAdmin,
        mustChangePassword: Boolean(actor.user?.mustChangePassword),
      }
    }
    if (!/^Bearer\s+/i.test(String(request.headers.authorization || ''))) {
      throw teamError(401, ERROR_CODES.AUTH_REQUIRED, '需要登录')
    }
    const agent = agentService.authenticate(request)
    const user = db
      .prepare(`
      SELECT system_admin, status, must_change_password
      FROM user_account
      WHERE id = ?
    `)
      .get(agent.userId)
    if (!user || user.status !== 'active') {
      throw teamError(401, ERROR_CODES.AGENT_AUTH_REQUIRED, 'Agent 凭证无效或已撤销')
    }
    return {
      userId: agent.userId,
      systemAdmin: Boolean(user.system_admin),
      mustChangePassword: Boolean(user.must_change_password),
    }
  }

  function publishTaskControlChanged() {
    if (!taskSpaceIndex) return
    const revision = taskSpaceIndex.incrementQueryRevision({ publish: false })
    boardEvents.publish({ revision })
  }

  return { readActor, runtimePayload, requireActor, templateIdentity, publishTaskControlChanged }
}
