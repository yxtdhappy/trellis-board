import { parseCookieHeader, readSession, SESSION_COOKIE } from '../../auth.js'
import { ERROR_CODES, teamError } from '../../errors.js'
import { listTeamsForActor } from '../../teams.js'
import { sendJson, sendNotModified, readJsonBody, statusEtag } from '../common.js'

export function createTeamRoutes(ctx) {
  const {
    config,
    db,
    boardService,
    taskSpaces,
    ownershipInbox,
    agentService,
    boardEvents,
    requireActor,
  } = ctx

  async function handleTeam(request, response, url) {
    const { pathname } = url
    const actor = requireActor(request)
    if (pathname === '/api/board/events' && request.method === 'GET') {
      const token = parseCookieHeader(request.headers.cookie).get(SESSION_COOKIE)
      const opened = boardEvents.open({
        response,
        authorize: () => {
          const session = readSession(db, token)
          return Boolean(session && session.sessionId === actor.sessionId)
        },
      })
      if (!opened) {
        throw teamError(401, ERROR_CODES.AUTH_REQUIRED, '会话已失效')
      }
      return true
    }
    if (pathname === '/api/team/projects' && request.method === 'GET') {
      sendJson(response, 200, {
        projects: taskSpaces.listReadable(actor, {
          teamId: url.searchParams.get('teamId'),
        }),
      })
      return true
    }
    if (
      (pathname === '/api/team/status' || pathname === '/api/status') &&
      request.method === 'GET'
    ) {
      const status = boardService.status(actor, { staleMs: config.agentStaleMs || 60_000 })
      const etag = statusEtag(status)
      if (String(request.headers['if-none-match'] || '') === etag) {
        sendNotModified(response, etag)
        return true
      }
      sendJson(response, 200, status, { etag })
      return true
    }
    if (pathname === '/api/ownership-inbox' && request.method === 'GET') {
      sendJson(
        response,
        200,
        ownershipInbox.list(actor, {
          teamId: url.searchParams.get('teamId'),
          projectIds: url.searchParams.getAll('projectIds'),
          limit: url.searchParams.get('limit'),
          cursor: url.searchParams.get('cursor'),
        }),
      )
      return true
    }
    if (pathname === '/api/teams' && request.method === 'GET') {
      sendJson(response, 200, {
        teams: listTeamsForActor(db, actor, { activeOnly: true }),
        activeTeamId: null,
      })
      return true
    }
    if (pathname === '/api/team/pairing-codes' && request.method === 'POST') {
      const body = await readJsonBody(request)
      sendJson(response, 201, agentService.createPairingCode(actor, body))
      return true
    }
    return false
  }

  return { handleTeam }
}
