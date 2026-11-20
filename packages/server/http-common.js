import fs from 'node:fs'
import path from 'node:path'
import { gzip } from 'node:zlib'

export const STATIC_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.woff2', 'font/woff2'],
  ['.woff', 'font/woff'],
  ['.ttf', 'font/ttf'],
  ['.ico', 'image/x-icon'],
  ['.webmanifest', 'application/manifest+json'],
  ['.map', 'application/json'],
  ['.txt', 'text/plain; charset=utf-8'],
])

export function securityHeaders() {
  return {
    'content-security-policy':
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
      "connect-src 'self' ipc: http://ipc.localhost http://127.0.0.1:* http://localhost:*; " +
      "frame-src 'self' http://127.0.0.1:* http://localhost:*; " +
      "object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
  }
}

export function sendJson(
  response,
  status,
  payload,
  { headers = {}, gzip: compress = false, security = false } = {},
) {
  if (response.headersSent) {
    response.destroy()
    return
  }
  const source = payload == null ? '' : JSON.stringify(payload)
  const compressed =
    compress &&
    source.length >= 1024 &&
    /\bgzip\b/.test(String(response.req?.headers?.['accept-encoding'] || ''))
  const write = (body) => {
    response.writeHead(status, {
      ...(security ? securityHeaders() : { 'cache-control': 'no-store' }),
      'content-type': 'application/json; charset=utf-8',
      'content-length': body.length,
      ...(compressed ? { 'content-encoding': 'gzip', vary: 'accept-encoding' } : {}),
      ...headers,
    })
    response.end(body)
  }
  if (!compressed) {
    write(Buffer.from(source))
    return
  }
  gzip(source, (error, body) => {
    if (error || response.destroyed) {
      response.destroy()
      return
    }
    try {
      write(body)
    } catch {
      response.destroy()
    }
  })
}

export async function readJsonBody(request, { maxBytes = 1024 * 1024, errors }) {
  const declared = Number(request.headers['content-length'])
  if (Number.isFinite(declared) && declared > maxBytes) throw errors.tooLarge(maxBytes)
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > maxBytes) throw errors.tooLarge(maxBytes)
    chunks.push(chunk)
  }
  if (!size) return {}
  let value
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw errors.invalidJson()
  }
  if (errors.notObject && (!value || typeof value !== 'object' || Array.isArray(value))) {
    throw errors.notObject()
  }
  return value
}

export function serveStatic({
  request,
  response,
  pathname,
  publicDir,
  security = false,
  cacheControl = (extension) => (extension === '.html' ? 'no-store' : 'public, max-age=60'),
  invalidPath,
  methodNotAllowed,
  forbidden,
  notFound,
}) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    methodNotAllowed()
    return
  }
  let requested
  try {
    requested = decodeURIComponent(pathname === '/' ? '/index.html' : pathname)
  } catch {
    invalidPath()
    return
  }
  const root = path.resolve(publicDir)
  const filePath = path.resolve(root, `.${requested}`)
  if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
    forbidden()
    return
  }
  const extension = path.extname(filePath).toLowerCase()
  if (!STATIC_TYPES.has(extension)) {
    notFound()
    return
  }
  let stat
  let realPath
  let realRoot
  try {
    realRoot = fs.realpathSync(root)
    realPath = fs.realpathSync(filePath)
    stat = fs.statSync(realPath)
  } catch {
    stat = null
  }
  if (realPath && realPath !== realRoot && !realPath.startsWith(`${realRoot}${path.sep}`)) {
    forbidden()
    return
  }
  if (!stat?.isFile()) {
    notFound()
    return
  }
  response.writeHead(200, {
    ...(security ? securityHeaders() : {}),
    'content-type': STATIC_TYPES.get(extension),
    'content-length': stat.size,
    'cache-control': cacheControl(extension),
  })
  if (request.method === 'HEAD') {
    response.end()
    return
  }
  fs.createReadStream(realPath)
    .on('error', () => response.destroy())
    .pipe(response)
}
