import { securityHeaders } from '../../../http-common.js'
import { ERROR_CODES, teamError } from '../../errors.js'
import {
  authorizeWorkspaceTemplate,
  publicWorkspaceTemplateManifest,
  readWorkspaceTemplate,
} from '../../workspace-templates.js'
import { sendJson, sendNotModified, etagMatches, routeMatch } from '../common.js'

export function createWorkspaceTemplateRoutes(ctx) {
  const { db, templateIdentity } = ctx

  async function handleWorkspaceTemplate(request, response, url) {
    const match = routeMatch(
      url.pathname,
      /^\/api\/teams\/([^/]+)\/workspace-template(?:\/(manifest))?$/,
    )
    if (!match) return false
    if (request.method !== 'GET' && request.method !== 'HEAD') return false
    const [teamId, manifestRoute] = match
    const identity = templateIdentity(request)
    if (identity.mustChangePassword) {
      throw teamError(
        403,
        ERROR_CODES.PASSWORD_CHANGE_REQUIRED,
        '首次登录或密码重置后必须先修改密码',
      )
    }
    authorizeWorkspaceTemplate(db, { teamId, ...identity })
    const template = readWorkspaceTemplate()
    const version = template.manifest.version
    const etag = manifestRoute === 'manifest' ? template.manifestEtag : template.etag
    if (etagMatches(request.headers['if-none-match'], etag)) {
      sendNotModified(response, etag)
      return true
    }
    if (manifestRoute === 'manifest') {
      sendJson(response, 200, publicWorkspaceTemplateManifest(template), {
        etag,
        'x-template-sha256': template.sha256,
        'x-template-version': version,
      })
      return true
    }
    response.writeHead(200, {
      ...securityHeaders(),
      'content-type': 'application/zip',
      'content-length': template.size,
      'content-disposition': `attachment; filename="workspace-template-${version}.zip"`,
      'cache-control': 'private, max-age=0, must-revalidate',
      'x-template-sha256': template.sha256,
      'x-template-version': version,
      etag,
    })
    if (request.method === 'HEAD') {
      response.end()
      return true
    }
    response.end(template.archive)
    return true
  }

  return { handleWorkspaceTemplate }
}
