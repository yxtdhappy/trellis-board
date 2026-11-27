import type { Plugin } from 'vite'

// 本机 4403 环境：页面从 127.0.0.1:4403 打开，但远端 Team 服务按 Host 匹配域名，
// 且登录 Set-Cookie Path=/weint-spec-board、写请求 Origin 必须与 Host 同源。
// 因此 /api 与 /client-updates 代理到远端时保持原始 Host/Origin 会 404/403；
// 这里把代理请求的 Host/Origin 重写为目标域名，同时把响应 Set-Cookie Path 改回 '/'，
// 使 4403 的页面能登录并访问远端服务端。
export function remoteTeamProxyHeaders(): Plugin {
  const target = process.env.VITE_API_TARGET || ''
  if (!target.includes('spec-board.weintdata.cn')) return { name: 'remote-team-proxy-headers' }
  const upstreamHost = new URL(target).host
  const upstreamOrigin = new URL(target).origin

  const rewriteRequest = (req: any, res: any, next: () => void) => {
    const url = String(req.url || '')
    if (!url.startsWith('/api/') && !url.startsWith('/client-updates/')) {
      next()
      return
    }
    req.headers.host = upstreamHost
    req.headers.origin = upstreamOrigin
    req.headers['x-forwarded-host'] = upstreamHost
    // 代理 sink 通过 res.setHeader 写出响应头，拦截它把 cookie Path 改回根。
    const originalSetHeader = res.setHeader.bind(res)
    res.setHeader = (name: string, value: any) => {
      if (String(name).toLowerCase() === 'set-cookie') {
        const list = Array.isArray(value) ? value : [value]
        value = list.map((item: any) =>
          String(item).replace(/;\s*Path=\/weint-spec-board(?:;|$)/i, '; Path=/;'),
        )
      }
      return originalSetHeader(name, value)
    }
    next()
  }

  return {
    name: 'remote-team-proxy-headers',
    configureServer(server) {
      server.middlewares.use(rewriteRequest)
    },
    configurePreviewServer(server) {
      server.middlewares.use(rewriteRequest)
    },
  }
}
