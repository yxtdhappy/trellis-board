import path from 'node:path'
import { createPluginStore } from './store.js'
import { createTaskService } from './task-service.js'
import { PluginSupervisor } from './supervisor.js'
import { ERROR_CODES, RpcError } from './protocol.js'

const BODY_LIMIT = 1024 * 1024
const STREAM_HEARTBEAT_MS = 15_000

function readRawBody(request) {
  return new Promise((resolve, reject) => {
    let body = ''
    request.on('data', (chunk) => {
      body += chunk
      if (body.length > BODY_LIMIT) {
        reject(new Error('请求体过大'))
        request.destroy()
      }
    })
    request.on('end', () => resolve(body))
    request.on('error', reject)
  })
}

/** 读 JSON 请求体；空体按 {} 处理，解析失败由调用方返回 400。 */
async function readJsonBody(request) {
  const raw = await readRawBody(request)
  if (!raw.trim()) return {}
  try {
    return JSON.parse(raw)
  } catch {
    throw new SyntaxError('请求体不是合法 JSON')
  }
}

function toResponse(error) {
  if (error instanceof RpcError) {
    const status =
      error.code === ERROR_CODES.TIMEOUT
        ? 504
        : error.code === ERROR_CODES.PERMISSION_DENIED
          ? 403
          : error.code === ERROR_CODES.NOT_FOUND
            ? 404
            : error.code === ERROR_CODES.DISABLED
              ? 503
              : 502
    return { status, payload: { error: error.message, code: error.code } }
  }
  return { status: 500, payload: { error: error instanceof Error ? error.message : String(error) } }
}

/**
 * 插件 HTTP 层的唯一入口：/api/plugins 管理路由 + 插件命名空间 + 根路径。
 * 核心路由不经过这里（除非插件没有匹配到）。
 */
export function createPluginRuntime({
  db,
  appDir,
  dataDir,
  pluginsDir = path.join(dataDir, 'plugins'),
  hostVersion,
  repositories,
  repositoryService,
  boardProvider,
  store,
  tasks,
  logger = console,
  env = process.env,
  configFile = path.join(pluginsDir, 'plugins.json'),
  spawnImpl,
  restartDelaysMs,
  healthIntervalMs,
  timeoutOverrides,
  autoDisableLimit,
  entriesProvider = null,
  orderWriter = null,
  userProvider = null,
  now = () => new Date().toISOString(),
}) {
  const pluginStore = store ?? createPluginStore({ db })
  const taskService =
    tasks ??
    createTaskService({
      repositories,
      db,
      boardProvider,
    })
  const supervisor = new PluginSupervisor({
    db,
    appDir,
    dataDir,
    pluginsDir,
    hostVersion,
    repositories,
    repositoryService,
    tasks: taskService,
    store: pluginStore,
    configFile,
    spawnImpl,
    env,
    logger,
    restartDelaysMs,
    healthIntervalMs,
    timeoutOverrides,
    autoDisableLimit,
    entriesProvider,
    orderWriter,
    userProvider,
    now,
  })
  const disabled = String(env.TRELLIS_PLUGINS_DISABLED || '') === '1'

  async function load() {
    if (disabled) return []
    const list = await supervisor.load()
    return list
  }

  async function start() {
    if (disabled) {
      logger.warn?.('TRELLIS_PLUGINS_DISABLED=1，插件未加载')
      return { disabled: true, plugins: [] }
    }
    pluginStore.failInterruptedRuns()
    await supervisor.start()
    return { disabled: false, plugins: supervisor.list() }
  }

  async function stop() {
    await supervisor.stop()
  }

  function list() {
    if (disabled) return { disabled: true, plugins: [] }
    return {
      disabled: false,
      hostVersion,
      plugins: supervisor.list(),
    }
  }

  /** 重读 plugins.json + secrets 并按需重启插件；TRELLIS_PLUGINS_DISABLED=1 时直接拒绝。 */
  async function reload() {
    if (disabled) {
      return {
        ok: false,
        reason: 'http',
        error: '插件机制已被 TRELLIS_PLUGINS_DISABLED=1 关闭',
        changed: [],
      }
    }
    return supervisor.reloadConfig({ reason: 'http' })
  }

  function runs(id, url) {
    return {
      runs: pluginStore.listRuns({
        pluginId: id,
        taskKey: url.searchParams.get('taskKey') || null,
        limit: Number(url.searchParams.get('limit') || 50),
      }),
    }
  }

  function audit(id, url) {
    return {
      audit: pluginStore.listAudit(id, {
        limit: Number(url.searchParams.get('limit') || 100),
      }),
    }
  }

  function pluginAdminMatch(pathname) {
    const match = /^\/api\/plugins\/([^/]+)(?:\/(start|stop|logs|runs|audit|sort))?$/.exec(pathname)
    if (!match) return null
    return { id: decodeURIComponent(match[1]), action: match[2] || null }
  }

  function panels() {
    const result = []
    for (const state of supervisor.plugins.values()) {
      if (state.status !== 'running') continue
      const pluginSort = state.sort ?? null
      for (const panel of state.manifest?.panels ?? []) {
        result.push({
          ...panel,
          // 插件级 sort 优先于清单里的 order；没设置时按清单顺序。
          sort: pluginSort ?? panel.order,
          pluginId: state.id,
          pluginName: state.manifest?.name ?? state.id,
          src: `/api/plugins/${encodeURIComponent(state.id)}${panel.entry}`,
        })
      }
    }
    return {
      panels: result.sort(
        (left, right) =>
          left.sort - right.sort ||
          left.order - right.order ||
          left.title.localeCompare(right.title, 'zh'),
      ),
    }
  }

  function topicMatcher(url) {
    const topics = String(url.searchParams.get('topics') || '')
      .split(',')
      .map((topic) => topic.trim())
      .filter(Boolean)
    if (!topics.length) return () => true
    return (name) => topics.some((topic) => name === topic || name.startsWith(`${topic}/`))
  }

  function openEventStream({ request, response, url }) {
    const matches = topicMatcher(url)
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    response.write(': connected\n\n')
    const write = (event) => {
      if (!event.public || !matches(event.name)) return
      response.write(`id: ${event.eventId}\ndata: ${JSON.stringify(event)}\n\n`)
    }
    const lastEventId = Number(request.headers['last-event-id'])
    if (Number.isFinite(lastEventId) && lastEventId > 0) {
      for (const event of supervisor.eventRing) {
        if (event.eventId > lastEventId) write(event)
      }
    }
    const unsubscribe = supervisor.onEvent(write)
    const heartbeat = setInterval(() => response.write(': ping\n\n'), STREAM_HEARTBEAT_MS)
    heartbeat.unref?.()
    const close = () => {
      clearInterval(heartbeat)
      unsubscribe()
    }
    request.on('close', close)
    response.on('close', close)
    response.on('error', close)
    return true
  }

  /**
   * 返回 true 表示已处理（已写响应）。未匹配任何插件路由时返回 false。
   */
  function isOpenPath(state, pathname) {
    const openPaths = state.manifest?.http?.openPaths ?? []
    return Array.isArray(openPaths) && openPaths.includes(pathname)
  }

  async function handleHttp({ request, response, url, sendJson }) {
    if (disabled) return false
    if (url.pathname === '/api/plugins' && request.method === 'GET') {
      sendJson(response, 200, list())
      return true
    }
    if (url.pathname === '/api/panels' && request.method === 'GET') {
      sendJson(response, 200, panels())
      return true
    }
    if (url.pathname === '/api/events' && request.method === 'GET') {
      return openEventStream({ request, response, url })
    }
    if (url.pathname === '/api/plugins/order' && request.method === 'POST') {
      let payload
      try {
        payload = await readJsonBody(request)
      } catch {
        sendJson(response, 400, { error: '请求体不是合法 JSON' })
        return true
      }
      try {
        const plugins = supervisor.setOrder(payload?.ids)
        sendJson(response, 200, { ok: true, plugins })
      } catch (error) {
        sendJson(response, 400, { error: error instanceof Error ? error.message : '排序失败' })
      }
      return true
    }
    // 必须在 pluginAdminMatch 之前：否则 /api/plugins/reload 会被解析成 id=reload 并返回 404。
    if (url.pathname === '/api/plugins/reload' && request.method === 'POST') {
      const result = await reload()
      sendJson(response, result.ok ? 200 : 400, result)
      return true
    }

    const admin = pluginAdminMatch(url.pathname)
    if (admin) {
      const state = supervisor.plugins.get(admin.id)
      if (!state) {
        sendJson(response, 404, { error: `未知插件: ${admin.id}` })
        return true
      }
      try {
        if (admin.action === 'start' && request.method === 'POST') {
          await supervisor.startPlugin(admin.id)
          sendJson(response, 200, { message: '插件已启动', plugin: supervisor.describe(state) })
          return true
        }
        if (admin.action === 'stop' && request.method === 'POST') {
          await supervisor.stopPlugin(admin.id)
          sendJson(response, 200, { message: '插件已停止', plugin: supervisor.describe(state) })
          return true
        }
        if (admin.action === 'sort' && request.method === 'POST') {
          let payload
          try {
            payload = await readJsonBody(request)
          } catch {
            sendJson(response, 400, { error: '请求体不是合法 JSON' })
            return true
          }
          const rawSort = payload?.sort
          const sort =
            rawSort === null || rawSort === undefined || rawSort === '' ? null : Number(rawSort)
          if (sort !== null && !Number.isFinite(sort)) {
            sendJson(response, 400, { error: 'sort 必须是数字，留空表示按清单默认顺序' })
            return true
          }
          const plugin = supervisor.setSort(admin.id, sort)
          sendJson(response, 200, { message: '面板排序已更新', plugin })
          return true
        }
        if (admin.action === 'logs' && request.method === 'GET') {
          sendJson(response, 200, supervisor.getLogs(admin.id, url.searchParams.get('tail') || 200))
          return true
        }
        if (admin.action === 'runs' && request.method === 'GET') {
          sendJson(response, 200, runs(admin.id, url))
          return true
        }
        if (admin.action === 'runs' && request.method === 'POST') {
          // 手动触发交给插件自己解释，宿主只负责转发。
          const body = await readRawBody(request)
          const result = await supervisor.forwardHttp(state, {
            method: 'POST',
            path: '/runs',
            headers: {
              authorization: request.headers.authorization || '',
              'content-type': request.headers['content-type'] || 'application/json',
            },
            body,
            public: false,
          })
          sendPluginResult(sendJson, response, result)
          return true
        }
        if (admin.action === 'audit' && request.method === 'GET') {
          sendJson(response, 200, audit(admin.id, url))
          return true
        }
      } catch (error) {
        const mapped = toResponse(error)
        sendJson(response, mapped.status, mapped.payload)
        return true
      }
      if (admin.action) {
        sendJson(response, 405, { error: '该插件端点不支持此方法' })
        return true
      }
    }

    const namespace = /^\/api\/plugins\/([^/]+)(\/.*)?$/.exec(url.pathname)
    if (namespace) {
      const id = decodeURIComponent(namespace[1])
      const state = supervisor.plugins.get(id)
      if (!state) {
        sendJson(response, 404, { error: `未知插件: ${id}` })
        return true
      }
      const pluginPath = namespace[2] || '/'
      try {
        const body = await readRawBody(request)
        const result = await supervisor.forwardHttp(state, {
          method: request.method,
          path: `${pluginPath}${url.search}`,
          headers: {
            authorization: request.headers.authorization || '',
            'content-type': request.headers['content-type'] || 'application/json',
          },
          body,
          public: false,
        })
        sendPluginResult(sendJson, response, result)
      } catch (error) {
        const mapped = toResponse(error)
        sendJson(response, mapped.status, mapped.payload)
      }
      return true
    }

    const rootState = supervisor.findRootPlugin(url.pathname)
    if (rootState) {
      try {
        const body = await readRawBody(request)
        const result = await supervisor.forwardHttp(rootState, {
          method: request.method,
          path: `${url.pathname}${url.search}`,
          headers: {
            authorization: request.headers.authorization || '',
            'content-type': request.headers['content-type'] || 'application/json',
          },
          body,
          public: !isOpenPath(rootState, url.pathname),
        })
        sendPluginResult(sendJson, response, result)
      } catch (error) {
        const mapped = toResponse(error)
        const status = Number.isInteger(error?.httpStatus)
          ? error.httpStatus
          : error instanceof RpcError && error.code === ERROR_CODES.NOT_FOUND
            ? 404
            : mapped.status
        sendJson(response, status, mapped.payload)
      }
      return true
    }

    return false
  }

  function sendPluginResult(sendJson, response, result) {
    if (!result || typeof result !== 'object') {
      sendJson(response, 502, { error: '插件返回了无效响应' })
      return
    }
    const status = Number.isInteger(result.status) ? result.status : 200
    const headers = result.headers && typeof result.headers === 'object' ? result.headers : {}
    const body = result.body
    if (body === undefined || body === null) {
      sendJson(response, status, {})
      return
    }
    if (typeof body === 'object') {
      sendJson(response, status, body)
      return
    }
    response.writeHead(status, {
      'content-type': headers['content-type'] || 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    })
    response.end(String(body))
  }

  function publish(name, payload) {
    if (disabled) return null
    return supervisor.publish(name, payload)
  }

  function setRepositories(next) {
    if (!Array.isArray(next)) return
    // 原地替换，taskService 与 supervisor 共享同一个数组引用。
    repositories.splice(0, repositories.length, ...next)
  }

  function publishScan(previousBoard, nextBoard, stats, reason) {
    if (disabled) return
    // 事件里的 taskKey 必须与 ctx.tasks.* 的键一致（<projectId>::<任务目录名>），
    // 否则插件收到事件后无法用同一个键回查任务。
    const eventTaskKey = (task) => {
      const dirName =
        task.dirName || String(task.relativeDir || '').replace(/^\.trellis\/tasks\//, '')
      return `${task.projectId}::${dirName}`
    }
    if (previousBoard && nextBoard) {
      const before = new Map((previousBoard.tasks || []).map((task) => [task.taskKey, task]))
      for (const task of nextBoard.tasks || []) {
        const previous = before.get(task.taskKey)
        if (!previous) {
          publish('task.created', {
            taskKey: eventTaskKey(task),
            projectId: task.projectId,
            title: task.title,
            assignee: task.assignee,
            priority: task.priority,
            occurredAt: now(),
          })
          continue
        }
        if (
          previous.meta &&
          task.meta &&
          JSON.stringify(previous.meta) !== JSON.stringify(task.meta)
        ) {
          publish('task.meta.changed', {
            taskKey: eventTaskKey(task),
            meta: task.meta,
            previousMeta: previous.meta,
            occurredAt: now(),
          })
        }
        if (previous.derivedStage !== task.derivedStage) {
          publish('task.stage.derived', {
            taskKey: eventTaskKey(task),
            derivedStage: task.derivedStage,
            previousStage: previous.derivedStage,
            occurredAt: now(),
          })
        }
        if (!previous.archived && task.archived) {
          publish('task.archived', {
            taskKey: eventTaskKey(task),
            archivedAt: task.archivedAt ?? now(),
            occurredAt: now(),
          })
        }
      }
    }
    publish('scan.completed', {
      reason,
      durationMs: stats?.durationMs ?? null,
      tasks: nextBoard?.tasks?.length ?? 0,
      repositoriesScanned: stats?.repositoriesScanned ?? repositories.length,
      occurredAt: now(),
    })
  }

  return {
    supervisor,
    store: pluginStore,
    tasks: taskService,
    load,
    start,
    panels,
    stop,
    reload,
    list,
    runs,
    audit,
    handleHttp,
    publish,
    publishScan,
    setRepositories,
    get disabled() {
      return disabled
    },
  }
}
