import { serveStatic as serveStaticCommon } from '../http-common.js'
import { PATHS } from './state.js'

export function serveStatic(state, request, response, url) {
  respondWithStatic(request, response, { pathname: url.pathname, publicDir: PATHS.publicDir })
}

// 插件面板共用资源：/plugin-ui/<file> → packages/server/plugin-ui/<file>。
// 这些资源属于宿主，不依赖某个插件是否启用。
export function servePluginUi(state, request, response, url) {
  const pathname = url.pathname.slice('/plugin-ui'.length) || '/'
  respondWithStatic(request, response, { pathname, publicDir: PATHS.pluginUiDir })
}

function respondWithStatic(request, response, { pathname, publicDir }) {
  const text = (status, body, headers = {}) => {
    response.writeHead(status, headers)
    response.end(body)
  }
  serveStaticCommon({
    request,
    response,
    pathname,
    publicDir,
    invalidPath: () => text(400, 'Bad request'),
    methodNotAllowed: () => text(405, 'Method not allowed', { allow: 'GET, HEAD' }),
    forbidden: () => text(403, 'Forbidden'),
    notFound: () => text(404, 'Not found'),
  })
}
