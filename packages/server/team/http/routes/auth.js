import {
  changePassword,
  clearSessionCookie,
  login,
  revokeSession,
  sessionCookie,
} from '../../auth.js'
import { ERROR_CODES, teamError } from '../../errors.js'
import { sendJson, requestProtocol, readJsonBody } from '../common.js'

export function createAuthRoutes(ctx) {
  const { config, db, basePath = '', readActor, runtimePayload, requireActor } = ctx
  const cookiePath = basePath || '/'

  async function handleAuth(request, response, url) {
    const { pathname } = url
    if (pathname === '/api/auth/register') {
      throw teamError(404, ERROR_CODES.NOT_FOUND, '接口不存在')
    }
    if (pathname === '/api/runtime' && request.method === 'GET') {
      sendJson(response, 200, runtimePayload(readActor(request)))
      return true
    }
    if (pathname === '/api/auth/me' && request.method === 'GET') {
      sendJson(response, 200, runtimePayload(requireActor(request)))
      return true
    }
    if (pathname === '/api/auth/login' && request.method === 'POST') {
      const body = await readJsonBody(request)
      const result = await login(db, {
        username: body.username,
        password: body.password,
        request,
        trustProxy: Boolean(config.trustProxy),
        sessionTtlMs: config.sessionTtlMs,
      })
      sendJson(
        response,
        200,
        {
          user: result.user,
          expiresAt: result.expiresAt,
          mode: 'team',
        },
        {
          'set-cookie': sessionCookie(result.token, {
            cookieSecure: requestProtocol(request) === 'https:',
            cookiePath,
          }),
        },
      )
      return true
    }
    if (pathname === '/api/auth/logout' && request.method === 'POST') {
      const actor = readActor(request)
      if (actor) revokeSession(db, actor.sessionId)
      sendJson(
        response,
        200,
        { ok: true },
        {
          'set-cookie': clearSessionCookie({
            cookieSecure: requestProtocol(request) === 'https:',
            cookiePath,
          }),
        },
      )
      return true
    }
    if (pathname === '/api/auth/team' && request.method === 'POST') {
      requireActor(request)
      await readJsonBody(request)
      throw teamError(410, 'ACTIVE_TEAM_REMOVED', '活动团队已移除，请使用团队筛选切换展示范围')
    }
    if (pathname === '/api/auth/password' && request.method === 'POST') {
      const actor = requireActor(request)
      const body = await readJsonBody(request)
      await changePassword(db, {
        userId: actor.userId,
        currentPassword: body.currentPassword,
        newPassword: body.newPassword,
        currentSessionId: actor.sessionId,
      })
      sendJson(response, 200, {
        ok: true,
        user: { ...actor.user, mustChangePassword: false },
      })
      return true
    }
    return false
  }

  return { handleAuth }
}
