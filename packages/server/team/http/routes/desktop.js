import { sendJson, readJsonBody } from '../common.js'

export function createDesktopRoutes(ctx) {
  const { desktopAuth } = ctx

  async function handleDesktop(request, response, url, actor) {
    if (url.pathname !== '/api/desktop/enroll-tokens') return false
    if (request.method !== 'POST') return false
    const body = await readJsonBody(request)
    sendJson(response, 201, desktopAuth.issue(actor, body))
    return true
  }

  return { handleDesktop }
}
