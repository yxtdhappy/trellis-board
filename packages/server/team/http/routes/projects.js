import { listAuditEvents } from '../../audit.js'
import { ERROR_CODES, teamError } from '../../errors.js'
import { sendJson, readJsonBody, parseInteger, routeMatch } from '../common.js'

export function createProjectRoutes(ctx) {
  const { db, taskSpaces, taskSpaceIndex, requireActor } = ctx

  async function handleProjects(request, response, url) {
    const { pathname } = url
    const actor = requireActor(request)
    const membersMatch = routeMatch(pathname, /^\/api\/projects\/([^/]+)\/members$/)
    if (membersMatch && request.method === 'GET') {
      sendJson(response, 200, {
        members: taskSpaces.listVisibleMembers(actor, membersMatch[0]),
      })
      return true
    }
    if (membersMatch && request.method === 'PUT') {
      const body = await readJsonBody(request)
      sendJson(response, 200, {
        member: taskSpaces.upsertMember(actor, {
          ...body,
          projectId: membersMatch[0],
        }),
      })
      return true
    }
    if (membersMatch && request.method === 'DELETE') {
      const userId = String(url.searchParams.get('userId') || '').trim()
      sendJson(response, 200, {
        members: taskSpaces.removeMember(actor, {
          projectId: membersMatch[0],
          userId,
        }),
      })
      return true
    }
    const auditMatch = routeMatch(pathname, /^\/api\/projects\/([^/]+)\/audit$/)
    if (auditMatch && request.method === 'GET') {
      const projectId = auditMatch[0]
      const project = taskSpaces.readProject(projectId, actor)
      if (!project) throw teamError(404, ERROR_CODES.NOT_FOUND, '项目不存在')
      const events = listAuditEvents(db, {
        projectId,
        limit: parseInteger(url.searchParams.get('limit'), 'limit', 100),
        beforeId: parseInteger(url.searchParams.get('beforeId'), 'beforeId', null),
      })
      sendJson(response, 200, { events })
      return true
    }
    const agentsMatch = routeMatch(pathname, /^\/api\/projects\/([^/]+)\/agents$/)
    if (agentsMatch && request.method === 'GET') {
      const project = taskSpaces.readProject(agentsMatch[0], actor)
      if (!project) throw teamError(404, ERROR_CODES.NOT_FOUND, '项目不存在')
      sendJson(response, 200, {
        agents: db
          .prepare(`
          SELECT b.*, a.device_name, a.platform, a.last_seen_at, a.status AS agent_status,
                 s.branch_name, u.username, u.display_name,
                 active.agent_id IS NOT NULL AS current_effective
          FROM sync_agent_binding b
          JOIN sync_task_space s ON s.id = b.task_space_id
          JOIN agent_device a ON a.id = b.agent_id
          JOIN user_account u ON u.id = a.user_id
          LEFT JOIN sync_active_agent active
            ON active.user_id = a.user_id AND active.agent_id = a.id
          WHERE s.project_id = ?
          ORDER BY b.created_at DESC
        `)
          .all(agentsMatch[0])
          .map((row) => ({
            id: row.id,
            agentId: row.agent_id,
            taskSpaceId: row.task_space_id,
            branchName: row.branch_name,
            userId: row.user_id,
            username: row.username,
            displayName: row.display_name,
            deviceName: row.device_name,
            platform: row.platform,
            status: row.sync_status,
            lastSeenAt: row.last_seen_at || null,
            current: Boolean(row.current_effective),
          })),
      })
      return true
    }
    const taskSpacesMatch = routeMatch(pathname, /^\/api\/projects\/([^/]+)\/task-spaces$/)
    if (taskSpacesMatch && request.method === 'GET') {
      sendJson(response, 200, {
        taskSpaces: taskSpaces.listAdminTaskSpaces(actor, taskSpacesMatch[0]),
      })
      return true
    }
    const taskSpaceActionMatch = routeMatch(
      pathname,
      /^\/api\/projects\/([^/]+)\/task-spaces\/([^/]+)\/(retire|restore)$/,
    )
    if (taskSpaceActionMatch && request.method === 'POST') {
      const [projectId, taskSpaceId, action] = taskSpaceActionMatch
      const body = await readJsonBody(request)
      const result =
        action === 'retire'
          ? taskSpaces.retireTaskSpace(actor, projectId, taskSpaceId, body)
          : taskSpaces.restoreTaskSpace(actor, projectId, taskSpaceId)
      taskSpaceIndex.incrementQueryRevision()
      if (action === 'restore' && result.indexedRevision < result.revision) {
        void taskSpaceIndex.enqueue(result.id)
      }
      sendJson(response, 200, { taskSpace: result })
      return true
    }
    const taskSpaceMatch = routeMatch(pathname, /^\/api\/projects\/([^/]+)\/task-spaces\/([^/]+)$/)
    if (taskSpaceMatch && request.method === 'DELETE') {
      const [projectId, taskSpaceId] = taskSpaceMatch
      const body = await readJsonBody(request)
      const result = taskSpaces.purgeTaskSpace(actor, projectId, taskSpaceId, body)
      taskSpaceIndex.incrementQueryRevision()
      sendJson(response, 200, result)
      return true
    }
    const teamAccessMatch = routeMatch(pathname, /^\/api\/projects\/([^/]+)\/team-access$/)
    if (teamAccessMatch && request.method === 'GET') {
      sendJson(response, 200, {
        teams: taskSpaces.listTeamAccess(actor, teamAccessMatch[0]),
      })
      return true
    }
    if (teamAccessMatch && request.method === 'POST') {
      const body = await readJsonBody(request)
      sendJson(
        response,
        200,
        taskSpaces.inviteTeam(actor, teamAccessMatch[0], body.teamId, body.accessRole),
      )
      return true
    }
    if (teamAccessMatch && request.method === 'DELETE') {
      sendJson(
        response,
        200,
        taskSpaces.removeTeam(actor, teamAccessMatch[0], url.searchParams.get('teamId')),
      )
      return true
    }
    return false
  }

  return { handleProjects }
}
