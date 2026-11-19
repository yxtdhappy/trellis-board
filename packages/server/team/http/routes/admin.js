import { appendAuditEvent, listAuditEvents } from '../../audit.js'
import { createUser, listUsers, resetUserPassword, updateUserAdmin } from '../../auth.js'
import { ERROR_CODES, teamError } from '../../errors.js'
import {
  createTeam,
  listTeamMembers,
  listTeamsForActor,
  listUserTeams,
  readTeam,
  setUserTeams,
  updateTeam,
  validateTeamAssignments,
} from '../../teams.js'
import {
  sendJson,
  readJsonBody,
  parseInteger,
  requireAdmin,
  requireTeamAdmin,
  manageableTeamIds,
  teamAssignmentsFromBody,
  routeMatch,
  MAX_ARCHIVE_CREDENTIAL_BYTES,
} from '../common.js'

export function createAdminRoutes(ctx) {
  const { config, db, taskSpaces, archiveGitSync, agentService, requireActor } = ctx

  async function handleAdmin(request, response, url) {
    const { pathname } = url
    const actor = requireActor(request)

    if (pathname === '/api/admin/archive-sync' && request.method === 'GET') {
      requireAdmin(actor)
      sendJson(response, 200, archiveGitSync.overview())
      return true
    }
    if (pathname === '/api/admin/archive-sync/config' && request.method === 'PATCH') {
      requireAdmin(actor)
      sendJson(response, 200, {
        config: archiveGitSync.updateConfig(actor, await readJsonBody(request)),
      })
      return true
    }
    if (pathname === '/api/admin/archive-sync/credentials' && request.method === 'POST') {
      requireAdmin(actor)
      sendJson(response, 201, {
        credential: archiveGitSync.credentials.create(
          actor,
          await readJsonBody(request, MAX_ARCHIVE_CREDENTIAL_BYTES),
        ),
      })
      return true
    }
    const archiveCredentialMatch = routeMatch(
      pathname,
      /^\/api\/admin\/archive-sync\/credentials\/([^/]+)$/,
    )
    if (archiveCredentialMatch && request.method === 'PATCH') {
      requireAdmin(actor)
      sendJson(response, 200, {
        credential: archiveGitSync.credentials.update(
          actor,
          archiveCredentialMatch[0],
          await readJsonBody(request, MAX_ARCHIVE_CREDENTIAL_BYTES),
        ),
      })
      return true
    }
    if (archiveCredentialMatch && request.method === 'DELETE') {
      requireAdmin(actor)
      await readJsonBody(request)
      sendJson(response, 200, archiveGitSync.credentials.remove(actor, archiveCredentialMatch[0]))
      return true
    }
    const archiveCredentialTestMatch = routeMatch(
      pathname,
      /^\/api\/admin\/archive-sync\/credentials\/([^/]+)\/test$/,
    )
    if (archiveCredentialTestMatch && request.method === 'POST') {
      requireAdmin(actor)
      await readJsonBody(request)
      sendJson(
        response,
        200,
        await archiveGitSync.testCredential(actor, archiveCredentialTestMatch[0]),
      )
      return true
    }
    if (pathname === '/api/admin/archive-sync/run' && request.method === 'POST') {
      requireAdmin(actor)
      const body = await readJsonBody(request)
      sendJson(response, 202, await archiveGitSync.runNow(body.taskSpaceId))
      return true
    }
    const archiveLogsMatch = routeMatch(
      pathname,
      /^\/api\/admin\/archive-sync\/task-spaces\/([^/]+)\/logs$/,
    )
    if (archiveLogsMatch && request.method === 'GET') {
      requireAdmin(actor)
      sendJson(
        response,
        200,
        archiveGitSync.listLogs(archiveLogsMatch[0], {
          beforeId: url.searchParams.get('beforeId'),
          limit: url.searchParams.get('limit'),
        }),
      )
      return true
    }

    if (pathname === '/api/admin/users' && request.method === 'GET') {
      const scope = requireTeamAdmin(db, actor, url.searchParams.get('teamId'))
      const adminTeamIds = manageableTeamIds(actor, scope)
      const memberIds = adminTeamIds
        ? new Set(
            adminTeamIds.flatMap((teamId) =>
              listTeamMembers(db, teamId).map((member) => member.userId),
            ),
          )
        : null
      const editableTeamIds = actor.systemAdmin ? null : adminTeamIds
      sendJson(response, 200, {
        users: listUsers(db)
          .filter((user) => !memberIds || memberIds.has(user.id))
          .map((user) => {
            const teams = listUserTeams(db, user.id)
            return {
              ...user,
              teams: editableTeamIds
                ? teams.filter((team) => editableTeamIds.includes(team.id))
                : teams,
            }
          }),
      })
      return true
    }
    if (pathname === '/api/admin/users' && request.method === 'POST') {
      requireAdmin(actor)
      const body = await readJsonBody(request)
      const teams = teamAssignmentsFromBody(db, null, body)
      if (teams != null) validateTeamAssignments(db, teams)
      const user = await createUser(db, {
        username: body.username,
        displayName: body.displayName,
        password: body.password,
        teams,
        systemAdmin: Boolean(body.systemAdmin),
        mustChangePassword: false,
        createdBy: actor.userId,
      })
      appendAuditEvent(db, {
        actorUserId: actor.userId,
        action: 'user_created',
        targetType: 'user',
        targetId: user.id,
        detail: { systemAdmin: user.systemAdmin },
      })
      sendJson(response, 201, {
        user: { ...user, teams: listUserTeams(db, user.id) },
      })
      return true
    }
    const userTeamsMatch = routeMatch(pathname, /^\/api\/admin\/users\/([^/]+)\/teams$/)
    if (userTeamsMatch && request.method === 'PUT') {
      requireAdmin(actor)
      const body = await readJsonBody(request)
      const teams = setUserTeams(db, {
        userId: userTeamsMatch[0],
        teams: body.teams,
        actorUserId: actor.userId,
      })
      sendJson(response, 200, { teams })
      return true
    }
    const teamMatch = routeMatch(pathname, /^\/api\/admin\/teams\/([^/]+)$/)
    if (teamMatch && request.method === 'GET') {
      requireAdmin(actor)
      const team = readTeam(db, teamMatch[0])
      if (!team) throw teamError(404, ERROR_CODES.NOT_FOUND, '团队不存在')
      sendJson(response, 200, {
        team: { ...team, members: listTeamMembers(db, team.id) },
      })
      return true
    }
    if (teamMatch && request.method === 'PATCH') {
      requireAdmin(actor)
      const body = await readJsonBody(request)
      sendJson(response, 200, {
        team: updateTeam(db, {
          teamId: teamMatch[0],
          updates: body,
          actorUserId: actor.userId,
        }),
      })
      return true
    }
    if (pathname === '/api/admin/teams' && request.method === 'GET') {
      requireAdmin(actor)
      sendJson(response, 200, { teams: listTeamsForActor(db, actor) })
      return true
    }
    if (pathname === '/api/admin/teams' && request.method === 'POST') {
      requireAdmin(actor)
      const body = await readJsonBody(request)
      sendJson(response, 201, {
        team: createTeam(db, {
          name: body.name,
          slug: body.slug,
          actorUserId: actor.userId,
        }),
      })
      return true
    }
    const userMatch = routeMatch(pathname, /^\/api\/admin\/users\/([^/]+)$/)
    if (userMatch && request.method === 'PATCH') {
      requireAdmin(actor)
      const body = await readJsonBody(request)
      const teams = teamAssignmentsFromBody(db, userMatch[0], body)
      if (teams != null) validateTeamAssignments(db, teams)
      const user = await updateUserAdmin(db, {
        userId: userMatch[0],
        updates: body,
        actorUserId: actor.userId,
      })
      if (teams != null) {
        setUserTeams(db, {
          userId: user.id,
          teams,
          actorUserId: actor.userId,
        })
      }
      sendJson(response, 200, {
        user: { ...user, teams: listUserTeams(db, user.id) },
      })
      return true
    }
    const passwordMatch = routeMatch(pathname, /^\/api\/admin\/users\/([^/]+)\/reset-password$/)
    if (passwordMatch && request.method === 'POST') {
      requireAdmin(actor)
      const body = await readJsonBody(request)
      const user = await resetUserPassword(db, {
        userId: passwordMatch[0],
        actorUserId: actor.userId,
        password: body.password,
      })
      sendJson(response, 200, { user })
      return true
    }
    if (pathname === '/api/admin/projects' && request.method === 'GET') {
      const teamId = requireTeamAdmin(db, actor, url.searchParams.get('teamId'))
      sendJson(response, 200, {
        projects: taskSpaces.listAll(actor, { teamId }),
      })
      return true
    }
    const projectAction = routeMatch(pathname, /^\/api\/admin\/projects\/([^/]+)\/disable$/)
    if (projectAction && request.method === 'POST') {
      const [projectId] = projectAction
      sendJson(response, 200, taskSpaces.disableProject(actor, projectId))
      return true
    }
    if (pathname === '/api/admin/agents' && request.method === 'GET') {
      const teamId = requireTeamAdmin(db, actor, url.searchParams.get('teamId'))
      sendJson(response, 200, {
        agents: agentService.listDevices(actor, { teamId }),
      })
      return true
    }
    if (pathname === '/api/admin/audit' && request.method === 'GET') {
      const requestedTeamId = String(url.searchParams.get('teamId') || '').trim()
      const teamId = requireTeamAdmin(db, actor, requestedTeamId)
      const events = listAuditEvents(db, {
        teamIds: manageableTeamIds(actor, teamId),
        limit: parseInteger(url.searchParams.get('limit'), 'limit', 100),
        beforeId: parseInteger(url.searchParams.get('beforeId'), 'beforeId', null),
      })
      sendJson(response, 200, { events })
      return true
    }
    const agentMatch = routeMatch(pathname, /^\/api\/admin\/agents\/([^/]+)\/revoke$/)
    if (agentMatch && request.method === 'POST') {
      const body = await readJsonBody(request)
      const teamId = requireTeamAdmin(db, actor, body.teamId)
      sendJson(
        response,
        200,
        agentService.revokeDevice(actor, agentMatch[0], {
          teamId,
        }),
      )
      return true
    }
    return false
  }

  return { handleAdmin }
}
