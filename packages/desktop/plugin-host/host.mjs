#!/usr/bin/env node
/**
 * 桌面 EXE 本机插件宿主。
 *
 * 由 Rust `plugin_host.rs` 按需拉起：只监听 127.0.0.1 的随机端口，内部接口要求
 * bearer token；面板静态资源走 `<secret>` 前缀，iframe 无需 Cookie/Token。
 *
 * 复用服务端的 `createPluginRuntime`（supervisor/store/task-service），不复制插件协议。
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HOST_DIR = path.dirname(fileURLToPath(import.meta.url))
const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.woff2', 'font/woff2'],
  ['.woff', 'font/woff'],
  ['.ttf', 'font/ttf'],
  ['.ico', 'image/x-icon'],
])
const BODY_LIMIT = 2 * 1024 * 1024
const EVENT_HEARTBEAT_MS = 15_000

function parseArgs(argv) {
  const options = {
    port: 0,
    host: '127.0.0.1',
    dataDir: '',
    appDir: HOST_DIR,
    pluginsDir: '',
    hostVersion: '0.0.0',
    token: '',
    secret: '',
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const value = argv[index + 1]
    switch (arg) {
      case '--port':
        options.port = Number(value)
        index += 1
        break
      case '--data-dir':
        options.dataDir = String(value || '')
        index += 1
        break
      case '--app-dir':
        options.appDir = String(value || HOST_DIR)
        index += 1
        break
      case '--plugins-dir':
        options.pluginsDir = String(value || '')
        index += 1
        break
      case '--host-version':
        options.hostVersion = String(value || '0.0.0')
        index += 1
        break
      case '--token':
        options.token = String(value || '')
        index += 1
        break
      case '--secret':
        options.secret = String(value || '')
        index += 1
        break
      default:
        break
    }
  }
  return options
}

function fail(message) {
  process.stderr.write(`[desktop-plugin-host] ${message}\n`)
  process.exit(2)
}

function readJsonBody(request, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    let body = ''
    request.on('data', (chunk) => {
      body += chunk
      if (body.length > limit) {
        reject(new Error('请求体过大'))
        request.destroy()
      }
    })
    request.on('end', () => {
      if (!body.trim()) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(body))
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    request.on('error', reject)
  })
}

function sendJson(response, status, payload) {
  if (response.headersSent) {
    response.destroy()
    return
  }
  const source = JSON.stringify(payload ?? null)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(source),
    'cache-control': 'no-store',
  })
  response.end(source)
}

function contentTypeOf(file) {
  return MIME_TYPES.get(path.extname(file).toLowerCase()) || 'application/octet-stream'
}

function safeJoin(root, relative) {
  const target = path.resolve(root, `.${path.sep}${relative}`)
  const inside = path.relative(root, target)
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) return null
  return target
}

function panelHtml(html, secret) {
  // 面板 HTML 里的 /api/plugins/<id>/... 由本机宿主提供；换成 secret 前缀后
  // iframe 子资源仍走同一个匿名通道，不会打到 Board 服务端。
  if (!html.includes('/api/plugins/')) return html
  return html.replaceAll('/api/plugins/', `/s/${secret}/`)
}

const options = parseArgs(process.argv.slice(2))
if (!options.dataDir) fail('缺少 --data-dir')
if (!options.token) fail('缺少 --token')
if (!options.secret) fail('缺少 --secret')

const pluginsDir = options.pluginsDir
  ? path.resolve(options.pluginsDir)
  : path.join(path.resolve(options.dataDir), 'plugins')
const dataDir = path.resolve(options.dataDir)
const appDir = path.resolve(options.appDir)

process.env.TRELLIS_BOARD_DATA_DIR = dataDir
process.env.TRELLIS_BOARD_PLUGINS_DIR = pluginsDir
const secretsFile = path.join(dataDir, 'secrets.json')
if (fs.existsSync(secretsFile)) process.env.TRELLIS_BOARD_SECRETS_FILE = secretsFile

fs.mkdirSync(pluginsDir, { recursive: true })
fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true })

const { getDefaultDatabase } = await import('@trellis-board/server/database.js')
const { createPluginRuntime } = await import('@trellis-board/server/plugins/runtime.js')

const logger = {
  info: (...args) => process.stderr.write(`[info] ${args.map(formatLog).join(' ')}\n`),
  warn: (...args) => process.stderr.write(`[warn] ${args.map(formatLog).join(' ')}\n`),
  error: (...args) => process.stderr.write(`[error] ${args.map(formatLog).join(' ')}\n`),
  debug: (...args) => process.stderr.write(`[debug] ${args.map(formatLog).join(' ')}\n`),
}

function formatLog(value) {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

const repositories = []
const db = getDefaultDatabase({ logger })
const runtime = createPluginRuntime({
  db,
  appDir,
  dataDir,
  pluginsDir,
  hostVersion: options.hostVersion,
  repositories,
  configFile: path.join(pluginsDir, 'plugins.json'),
  logger,
  env: process.env,
})

let stopping = false
let server = null

function authorized(request) {
  const header = String(request.headers.authorization || '')
  const match = /^Bearer\s+(.+)$/i.exec(header)
  return Boolean(match && match[1].trim() === options.token)
}

function eventsHandler(request, response) {
  const url = new URL(request.url || '/', 'http://127.0.0.1')
  const topics = String(url.searchParams.get('topics') || '')
    .split(',')
    .map((topic) => topic.trim())
    .filter(Boolean)
  const matches = (name) => !topics.length || topics.some((topic) => name === topic || name.startsWith(`${topic}/`))
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    connection: 'keep-alive',
  })
  response.write(': connected\n\n')
  const lastEventId = Number(request.headers['last-event-id'])
  const write = (event) => {
    if (!event || !event.public || !matches(String(event.name || ''))) return
    response.write(`id: ${event.eventId}\ndata: ${JSON.stringify(event)}\n\n`)
  }
  if (Number.isFinite(lastEventId) && lastEventId > 0) {
    for (const event of runtime.supervisor.eventRing) {
      if (event.eventId > lastEventId) write(event)
    }
  }
  const unsubscribe = runtime.supervisor.onEvent(write)
  const heartbeat = setInterval(() => response.write(': ping\n\n'), EVENT_HEARTBEAT_MS)
  heartbeat.unref?.()
  const close = () => {
    clearInterval(heartbeat)
    unsubscribe()
  }
  request.on('close', close)
  response.on('close', close)
  response.on('error', close)
}

async function forwardPanel(pluginId, subPath, search) {
  const state = runtime.supervisor.plugins.get(pluginId)
  if (!state) return { status: 404, body: { error: `未知插件: ${pluginId}` } }
  const result = await runtime.supervisor.forwardHttp(state, {
    method: 'GET',
    path: `/${subPath}${search || ''}`,
    headers: {},
    body: '',
    anonymous: true,
  })
  return result && typeof result === 'object' ? result : { status: 502, body: { error: '插件返回无效响应' } }
}

function writePluginResult(response, result, secret) {
  const status = Number.isInteger(result?.status) ? result.status : 200
  const headers = result?.headers && typeof result.headers === 'object' ? result.headers : {}
  const body = result?.body ?? ''
  const type = String(headers['content-type'] || 'text/plain; charset=utf-8')
  if (typeof body === 'object' && body !== null) {
    sendJson(response, status, body)
    return
  }
  const text = String(body)
  const finalBody = type.includes('text/html') ? panelHtml(text, secret) : text
  if (response.headersSent) {
    response.destroy()
    return
  }
  response.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(finalBody),
  })
  response.end(finalBody)
}

const PLUGIN_UI_ROOTS = [
  path.join(appDir, 'plugin-ui'),
  path.join(appDir, 'node_modules', '@trellis-board', 'server', 'plugin-ui'),
]

function servePluginUi(request, response, url) {
  const relative = url.pathname.slice('/plugin-ui/'.length)
  let file = null
  for (const root of PLUGIN_UI_ROOTS) {
    const candidate = safeJoin(root, relative)
    if (candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      file = candidate
      break
    }
  }
  if (!file) {
    sendJson(response, 404, { error: '静态资源不存在' })
    return
  }
  const body = fs.readFileSync(file)
  response.writeHead(200, {
    'content-type': contentTypeOf(file),
    'cache-control': 'no-store',
    'content-length': body.length,
  })
  if (request.method === 'HEAD') response.end()
  else response.end(body)
}

async function handleInternal(request, response, url, body) {
  if (url.pathname === '/internal/health') {
    sendJson(response, 200, { ok: true, pid: process.pid })
    return
  }
  if (url.pathname === '/internal/plugins' && request.method === 'GET') {
    sendJson(response, 200, runtime.list())
    return
  }
  if (url.pathname === '/internal/panels' && request.method === 'GET') {
    sendJson(response, 200, runtime.panels())
    return
  }
  if (url.pathname === '/internal/repositories') {
    if (request.method === 'GET') {
      sendJson(response, 200, { repositories })
      return
    }
    if (request.method === 'POST') {
      runtime.setRepositories(Array.isArray(body?.repositories) ? body.repositories : body)
      sendJson(response, 200, { ok: true, repositories })
      return
    }
  }
  if (url.pathname === '/internal/reload' && request.method === 'POST') {
    const result = await runtime.reload()
    sendJson(response, result.ok ? 200 : 400, result)
    return
  }
  if (url.pathname === '/internal/plugins/order' && request.method === 'POST') {
    try {
      sendJson(response, 200, { ok: true, plugins: runtime.supervisor.setOrder(body?.ids) })
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : '排序失败' })
    }
    return
  }
  const admin = /^\/internal\/plugins\/([^/]+)\/(start|stop)$/.exec(url.pathname)
  if (admin && request.method === 'POST') {
    const id = decodeURIComponent(admin[1])
    const state = runtime.supervisor.plugins.get(id)
    if (!state) {
      sendJson(response, 404, { error: `未知插件: ${id}` })
      return
    }
    try {
      if (admin[2] === 'start') await runtime.supervisor.startPlugin(id)
      else await runtime.supervisor.stopPlugin(id)
      sendJson(response, 200, { ok: true, plugin: runtime.supervisor.describe(state) })
    } catch (error) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : '操作失败' })
    }
    return
  }
  const logMatch = /^\/internal\/plugins\/([^/]+)\/logs$/.exec(url.pathname)
  if (logMatch && request.method === 'GET') {
    const id = decodeURIComponent(logMatch[1])
    try {
      sendJson(response, 200, runtime.supervisor.getLogs(id, url.searchParams.get('tail') || 200))
    } catch (error) {
      sendJson(response, 404, { error: error instanceof Error ? error.message : '未知插件' })
    }
    return
  }
  if (url.pathname === '/internal/shutdown' && request.method === 'POST') {
    sendJson(response, 200, { ok: true })
    void shutdown()
    return
  }
  sendJson(response, 404, { error: '未知的内部接口' })
}

async function handle(request, response) {
  const url = new URL(request.url || '/', 'http://127.0.0.1')

  if (url.pathname.startsWith('/plugin-ui/')) {
    servePluginUi(request, response, url)
    return
  }

  const secretPrefix = `/s/${options.secret}/`
  if (url.pathname.startsWith(secretPrefix)) {
    const remainder = url.pathname.slice(secretPrefix.length)
    if (remainder === '__events') {
      eventsHandler(request, response)
      return
    }
    const slash = remainder.indexOf('/')
    const pluginId = decodeURIComponent(slash < 0 ? remainder : remainder.slice(0, slash))
    const subPath = slash < 0 ? '' : remainder.slice(slash + 1)
    if (!pluginId || !subPath) {
      sendJson(response, 404, { error: '面板资源路径无效' })
      return
    }
    const result = await forwardPanel(pluginId, subPath, url.search)
    writePluginResult(response, result, options.secret)
    return
  }

  if (!authorized(request)) {
    sendJson(response, 401, { error: '未授权访问本机插件宿主' })
    return
  }

  if (url.pathname.startsWith('/internal/')) {
    const body = request.method === 'GET' || request.method === 'HEAD' ? {} : await readJsonBody(request)
    await handleInternal(request, response, url, body)
    return
  }

  if (url.pathname.startsWith('/api/')) {
    const handled = await runtime.handleHttp({
      request,
      response,
      url,
      sendJson,
    })
    if (!handled) sendJson(response, 404, { error: '未知插件接口' })
    return
  }

  sendJson(response, 404, { error: '未知路径' })
}


async function shutdown() {
  if (stopping) return
  stopping = true
  try {
    server?.close()
  } catch {
    /* 已经关闭 */
  }
  try {
    await runtime.stop()
  } catch (error) {
    process.stderr.write(`[desktop-plugin-host] 停止插件失败: ${error?.message || error}\n`)
  }
  try {
    db.close()
  } catch {
    /* 连接可能已关闭 */
  }
  setTimeout(() => process.exit(0), 20).unref?.()
}

process.on('SIGTERM', () => void shutdown())
process.on('SIGINT', () => void shutdown())
process.on('unhandledRejection', (error) => {
  process.stderr.write(`[desktop-plugin-host] 未处理的 Promise 拒绝: ${error?.stack || error}\n`)
})
process.on('uncaughtException', (error) => {
  process.stderr.write(`[desktop-plugin-host] 未捕获异常: ${error?.stack || error}\n`)
  void shutdown()
})

try {
  await runtime.load()
  await runtime.start()
  server = http.createServer((request, response) => {
    handle(request, response).catch((error) => {
      if (response.headersSent) {
        response.destroy()
        return
      }
      sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
    })
  })
  server.listen(options.port, options.host, () => {
    const address = server.address()
    const payload = { event: 'ready', port: address.port, pid: process.pid }
    process.stdout.write(`${JSON.stringify(payload)}\n`)
  })
} catch (error) {
  process.stderr.write(`[desktop-plugin-host] 启动失败: ${error?.stack || error}\n`)
  process.exit(1)
}
