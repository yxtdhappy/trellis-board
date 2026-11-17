import { ERROR_CODES, teamError } from '../errors.js'
import { maskAccount } from './session.js'

const MAX_JSON_BYTES = 64 * 1024

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  response.end(body)
}

function readJson(request, maxBytes = MAX_JSON_BYTES) {
  return new Promise((resolve, reject) => {
    let raw = ''
    request.on('data', (chunk) => {
      raw += chunk
      if (raw.length > maxBytes) {
        reject(teamError(413, ERROR_CODES.INVALID_INPUT, '请求体过大'))
        request.destroy()
      }
    })
    request.on('end', () => {
      if (!raw.trim()) return resolve({})
      try {
        const parsed = JSON.parse(raw)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(teamError(400, ERROR_CODES.INVALID_INPUT, '请求体必须是 JSON 对象'))
          return
        }
        resolve(parsed)
      } catch {
        reject(teamError(400, ERROR_CODES.INVALID_INPUT, '请求体不是合法 JSON'))
      }
    })
    request.on('error', reject)
  })
}

function writeJson(payload) {
  return typeof payload === 'string' ? payload : JSON.stringify(payload ?? {})
}

/**
 * team 插件 HTTP 层。所有入口先过 `policy`，再决定是否触达插件进程。
 * 路由前缀固定 `/api/plugins`，与 standalone 保持一致，面板代码不需要分支。
 */
function resolveTeamId(actor, raw) {
  const value = String(raw ?? '').trim()
  if (value) {
    if (!(actor.teams ?? []).some((team) => team.id === value) && !actor.systemAdmin) {
      throw teamError(403, ERROR_CODES.FORBIDDEN, '你不属于这个团队')
    }
    return value
  }
  if (actor.activeTeamId) return actor.activeTeamId
  const first = (actor.teams ?? [])[0]
  if (!first) throw teamError(400, ERROR_CODES.INVALID_INPUT, '缺少团队')
  return first.id
}

export function createTeamPluginRoutes({ host, logger = console }) {
  const { policy, settings, sessions, actors } = host

  function findPlugin(pluginId) {
    const { plugin } = host.find(pluginId)
    if (!plugin) throw teamError(404, ERROR_CODES.PLUGIN_NOT_FOUND, '插件不存在')
    return plugin
  }

  /**
   * 系统管理员要能看到（并重新启用）已被停用的插件，所以这里只对普通用户做可见性判定；
   * 停用状态本身由后续的具体端点决定是否允许访问。
   */
  function visiblePlugin(actor, pluginId) {
    const plugin = findPlugin(pluginId)
    if (!actor.systemAdmin) policy.assertPluginVisible(actor, pluginId)
    return plugin
  }

  function issueActor(actor, pluginId) {
    return actors.issue({ actor, pluginId })
  }

  async function forward(actor, pluginId, method, subPath, { headers = {}, body = '' } = {}) {
    const { state } = host.find(pluginId)
    if (!state) throw teamError(404, ERROR_CODES.PLUGIN_NOT_FOUND, '插件还没有装载')
    if (state.status !== 'running') {
      throw teamError(503, ERROR_CODES.DISABLED, '插件未运行')
    }
    const payload = issueActor(actor, pluginId)
    try {
      const result = await host.forwardHttp(state, {
        method,
        path: subPath,
        headers,
        body,
        actorRef: payload.ref,
      })
      return result
    } catch (error) {
      logger.warn?.('插件请求失败', {
        pluginId,
        subPath,
        error: error.message,
      })
      throw teamError(
        error.code === ERROR_CODES.TIMEOUT ? 504 : 502,
        error.code ?? 'PLUGIN_REQUEST_FAILED',
        error.message,
      )
    }
  }

  async function handleList(actor, url, response, request) {
    if (request.method === 'POST' && url.pathname === '/api/plugins/reload') {
      policy.assertSystemAdmin(actor)
      throw teamError(
        409,
        ERROR_CODES.RELOAD_REQUIRES_RESTART,
        '团队版不支持热重载插件，请重启服务',
      )
    }
    if (request.method === 'POST' && url.pathname === '/api/plugins/rescan') {
      policy.assertSystemAdmin(actor)
      const result = await host.rescan()
      sendJson(response, 200, {
        inserted: result.inserted,
        updated: result.updated,
        removed: result.removed,
        warnings: result.warnings,
        plugins: result.plugins.filter((plugin) => isVisible(policy, actor, plugin.id)),
      })
      return true
    }
    if (request.method !== 'GET') return false
    const items = host.list().filter((plugin) => isVisible(policy, actor, plugin.id))
    // 管理页会按右上角选中的团队查看；没传就退回会话里的活动团队。
    const viewTeamId = String(url.searchParams.get('teamId') ?? '').trim() || null
    sendJson(response, 200, {
      disabled: false,
      mode: 'team',
      teamId: viewTeamId ?? actor.activeTeamId ?? (actor.teams ?? [])[0]?.id ?? null,
      plugins: items.map((plugin) => decorate(actor, plugin, viewTeamId)),
    })
    return true
  }

  function isVisible(policyRef, actor, pluginId) {
    if (actor.systemAdmin) return true
    return policyRef.isPluginVisible(actor, pluginId)
  }

  /**
   * 列表里的每个插件都要带两件和"当前用户"有关的信息：
   * 这个团队有没有启用它、当前有几个人登录着。管理页靠这两列决定按钮状态。
   */
  function decorate(actor, plugin, teamIdOverride = null) {
    const teamId = teamIdOverride ?? actor.activeTeamId ?? (actor.teams ?? [])[0]?.id ?? null
    const setting = teamId ? settings.getTeamSetting(teamId, plugin.id) : null
    const enriched = {
      ...plugin,
      teamId,
      teamEnabled: setting?.enabled === true,
      sessions: sessions.listOnline({ pluginId: plugin.id }).length,
    }
    if (actor.systemAdmin) return enriched
    const rest = { ...enriched }
    delete rest.reason
    delete rest.lastError
    return rest
  }

  async function handleOne(actor, url, response, request) {
    const match = /^\/api\/plugins\/([^/]+)(\/.*)?$/.exec(url.pathname)
    if (!match) return false
    const pluginId = decodeURIComponent(match[1])
    const tail = match[2] ?? ''
    const method = request.method
    const plugin = visiblePlugin(actor, pluginId)

    if (method === 'GET' && tail === '') {
      const detail = host.list().find((item) => item.id === pluginId) ?? {}
      sendJson(response, 200, {
        plugin: decorate(actor, detail),
        manifest: sanitizeManifest(plugin.manifest),
        config: sanitizeConfig(plugin.manifest?.config),
      })
      return true
    }

    if (method === 'PUT' && tail === '/enabled') {
      policy.assertSystemAdmin(actor)
      const body = await readJson(request)
      if (typeof body.enabled !== 'boolean') {
        throw teamError(400, ERROR_CODES.INVALID_INPUT, 'enabled 必须是布尔值')
      }
      await host.setEnabled(pluginId, body.enabled, { actorUserId: actor.userId })
      const updated = host.list().find((item) => item.id === pluginId)
      sendJson(response, 200, { plugin: updated })
      return true
    }

    if (method === 'POST' && (tail === '/start' || tail === '/stop')) {
      policy.assertSystemAdmin(actor)
      if (tail === '/start') {
        await host.setEnabled(pluginId, true, { actorUserId: actor.userId })
      } else {
        await host.setEnabled(pluginId, false, { actorUserId: actor.userId })
      }
      const detail = host.list().find((item) => item.id === pluginId)
      sendJson(response, 200, { plugin: detail })
      return true
    }

    if (method === 'GET' && tail === '/logs') {
      policy.assertSystemAdmin(actor)
      const { state } = host.find(pluginId)
      sendJson(response, 200, {
        logs: state ? host.supervisor.getLogs(state.id, 200).entries : [],
      })
      return true
    }

    if (method === 'GET' && tail === '/audit') {
      const teamId = url.searchParams.get('teamId')
      if (!actor.systemAdmin) policy.assertTeamAdmin(actor, resolveTeamId(actor, teamId))
      const limit = Number(url.searchParams.get('limit') ?? 100)
      sendJson(response, 200, {
        audit: host.listAudit(pluginId, {
          teamId: teamId ? resolveTeamId(actor, teamId) : null,
          limit,
        }),
      })
      return true
    }

    if (tail === '/session') {
      return handleSession(actor, pluginId, method, response, request)
    }

    if (tail === '/user-config') {
      if (method === 'GET') {
        sendJson(response, 200, settings.describeUserPlugin(actor.userId, pluginId))
        return true
      }
      if (method === 'PUT') {
        const body = await readJson(request)
        policy.assertCanConfigureSelf(actor, actor.userId)
        const saved = settings.setUserConfig({
          userId: actor.userId,
          pluginId,
          config: body.config ?? {},
          fields: plugin.userConfigFields ?? [],
          status: 'active',
        })
        sendJson(response, 200, { config: saved.config, status: saved.status })
        return true
      }
      return false
    }

    if (tail === '/team-config') {
      const teamId = resolveTeamId(actor, url.searchParams.get('teamId'))
      policy.assertTeamSetting(actor, teamId)
      if (method === 'GET') {
        sendJson(response, 200, {
          setting: settings.getTeamSetting(teamId, pluginId),
        })
        return true
      }
      if (method === 'PUT') {
        const body = await readJson(request)
        const saved = settings.setTeamSetting({
          teamId,
          pluginId,
          enabled: body.enabled !== false,
          config: body.config ?? {},
          actorUserId: actor.userId,
        })
        host.audit({
          pluginId,
          kind: saved.enabled ? 'team-setting.enable' : 'team-setting.disable',
          detail: { teamId, configKeys: Object.keys(saved.config ?? {}) },
          userId: actor.userId,
          teamId,
        })
        sendJson(response, 200, { setting: saved })
        return true
      }
      return false
    }

    if (tail === '/bindings') {
      const teamId = resolveTeamId(actor, url.searchParams.get('teamId'))
      if (method === 'GET') {
        sendJson(response, 200, { bindings: host.bindings.list({ teamId, pluginId }) })
        return true
      }
      if (method === 'POST') {
        const body = await readJson(request)
        policy.assertCanBindProject(actor, { teamId, projectId: body.projectId })
        const binding = host.bindings.create({
          teamId,
          pluginId,
          projectId: body.projectId,
          externalProjectId: body.externalProjectId,
          externalProjectName: body.externalProjectName,
          actorUserId: actor.userId,
        })
        host.audit({
          pluginId,
          kind: 'binding.create',
          detail: {
            bindingId: binding.id,
            projectId: binding.projectId,
            externalProjectId: binding.externalProjectId,
            externalProjectName: binding.externalProjectName,
          },
          userId: actor.userId,
          teamId,
        })
        sendJson(response, 200, { binding })
        return true
      }
      if (method === 'DELETE') {
        const bindingId = url.searchParams.get('bindingId')
        if (!bindingId) throw teamError(400, ERROR_CODES.INVALID_INPUT, '缺少 bindingId')
        const binding = host.bindings.read(bindingId)
        if (!binding) throw teamError(404, ERROR_CODES.NOT_FOUND, '绑定不存在')
        policy.assertCanBindProject(actor, { teamId, projectId: binding.projectId })
        host.bindings.remove({ teamId, pluginId, bindingId })
        host.audit({
          pluginId,
          kind: 'binding.remove',
          detail: {
            bindingId,
            projectId: binding.projectId,
            externalProjectId: binding.externalProjectId,
            externalProjectName: binding.externalProjectName,
          },
          userId: actor.userId,
          teamId,
        })
        sendJson(response, 200, { removed: true })
        return true
      }
      return false
    }

    if (tail.startsWith('/app/')) {
      // query 必须一起转发，否则 /app/project-tasks?projectId=... 会退化成"缺少 projectId"。
      const subPath = `/${tail.slice('/app/'.length)}${url.search || ''}`
      const body = method === 'GET' || method === 'HEAD' ? '' : await readBody(request)
      const result = await forward(actor, pluginId, method, subPath, {
        headers: forwardHeaders(request.headers),
        body,
      })
      // 平台说凭据失效时顺手记一笔，管理页就能显示"需要重新登录"。
      if (Number(result?.status ?? 200) === 401) {
        const payload = parsePluginBody(result) ?? {}
        settings.setUserStatus({
          userId: actor.userId,
          pluginId,
          status: 'invalid',
          lastError: String(payload.error ?? '连接已断开').slice(0, 200),
        })
        // 面板靠 code 决定下一步：统一翻译成 CONNECTION_LOST / CREDENTIALS_MISSING / AUTH_FAILED。
        throw pluginFailure(result, payload)
      }
      sendPluginResponse(response, result)
      return true
    }

    return false
  }

  async function handleSession(actor, pluginId, method, response, request) {
    if (method === 'GET') {
      sendJson(
        response,
        200,
        settings.describeUserPlugin(actor.userId, pluginId, {
          session: sessions.statusOf(actor.userId, pluginId),
        }),
      )
      return true
    }
    if (method === 'DELETE') {
      sessions.revokeUser(actor.userId, pluginId, { reason: 'logout' })
      settings.setUserStatus({ userId: actor.userId, pluginId, status: 'unconfigured' })
      sendJson(response, 200, { online: false })
      return true
    }
    if (method === 'POST') {
      const body = await readJson(request)
      const account = String(body.account ?? '').trim()
      const password = String(body.password ?? '')
      if (!account || !password) {
        throw teamError(400, ERROR_CODES.INVALID_INPUT, '请填写 WitOps 账号和密码')
      }
      // 密码只在这一层出现：交给插件换 token，随后立即丢弃。
      const result = await forward(actor, pluginId, 'POST', '/session/open', {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ account, password }),
      })
      const payload = parsePluginBody(result)
      if (Number(result?.status ?? 200) >= 400 || !payload?.token) {
        throw pluginFailure(result, payload)
      }
      const entry = sessions.create({
        userId: actor.userId,
        pluginId,
        account: payload.account ?? account,
        token: payload.token,
        witopsUserId: payload.userId ?? null,
      })
      settings.setUserStatus({ userId: actor.userId, pluginId, status: 'active', lastError: null })
      sendJson(response, 200, {
        online: true,
        account: maskAccount(entry.account),
        expiresAt: new Date(entry.expiresAt).toISOString(),
      })
      return true
    }
    return false
  }

  /**
   * 面板的 SSE：面板加载后会订阅 `<pluginId>:<version>` 这类 topic，
   * 没这个端点浏览器会一直报 404，面板也收不到刷新通知。
   */
  function openEventStream(request, response, url) {
    const topics = String(url.searchParams.get('topics') || '')
      .split(',')
      .map((topic) => topic.trim())
      .filter(Boolean)
    const matches =
      topics.length === 0
        ? () => true
        : (name) => topics.some((topic) => name === topic || name.startsWith(`${topic}/`))
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    response.write(': connected\n\n')
    const write = (event) => {
      if (!event?.public || !matches(event.name)) return
      response.write(`id: ${event.eventId}\ndata: ${JSON.stringify(event)}\n\n`)
    }
    const lastEventId = Number(request.headers['last-event-id'])
    if (Number.isFinite(lastEventId) && lastEventId > 0) {
      for (const event of host.supervisor.eventRing ?? []) {
        if (event.eventId > lastEventId) write(event)
      }
    }
    const unsubscribe = host.supervisor.onEvent(write)
    const heartbeat = setInterval(() => response.write(': ping\n\n'), 15_000)
    heartbeat.unref?.()
    const close = () => {
      clearInterval(heartbeat)
      unsubscribe()
    }
    request.on('close', close)
    response.on('close', close)
    response.on('error', close)
  }

  /**
   * 面板的静态资源（HTML / JS / CSS）不需要登录：
   * 面板 iframe 是 sandbox="allow-scripts allow-forms"，没有 same-origin，
   * 它自己发的子资源请求不带 Cookie。数据请求走父页面的 postMessage 桥，仍有鉴权。
   */
  const PANEL_ASSET = /^\/api\/plugins\/([^/]+)\/app\/panel(?:\/([A-Za-z0-9._-]+))?$/

  async function publicAsset(request, response, url) {
    if (request.method !== 'GET') return false
    const match = PANEL_ASSET.exec(url.pathname)
    if (!match) return false
    const pluginId = decodeURIComponent(match[1])
    const { state } = host.find(pluginId)
    if (!state || state.status !== 'running') {
      sendJson(response, 404, { error: '插件未运行' })
      return true
    }
    const subPath = `/panel${match[2] ? `/${match[2]}` : ''}`
    try {
      const result = await host.forwardHttp(state, {
        method: 'GET',
        path: subPath,
        anonymous: true,
      })
      sendPluginResponse(response, result)
    } catch (error) {
      logger.warn?.('面板资源读取失败', { pluginId, subPath, error: error.message })
      sendJson(response, 502, { error: '面板资源读取失败' })
    }
    return true
  }

  /** 面板清单：只列已启用、正在运行、且当前用户可见的插件。 */
  function panels(actor) {
    const items = []
    for (const plugin of host.list()) {
      if (!plugin.enabled || plugin.status !== 'running') continue
      if (!actor.systemAdmin && !policy.isPluginVisible(actor, plugin.id)) continue
      for (const panel of plugin.panels ?? []) {
        items.push({
          ...panel,
          pluginId: plugin.id,
          pluginName: plugin.name,
          src: `/api/plugins/${encodeURIComponent(plugin.id)}/app${panel.entry}`,
        })
      }
    }
    items.sort(
      (left, right) =>
        (left.order ?? 0) - (right.order ?? 0) ||
        String(left.title ?? '').localeCompare(String(right.title ?? ''), 'zh'),
    )
    return { panels: items }
  }

  async function dispatch(request, response, url, actor) {
    if (!actor) return publicAsset(request, response, url)
    if (url.pathname === '/api/events' && request.method === 'GET') {
      openEventStream(request, response, url)
      return true
    }
    if (url.pathname === '/api/panels' && request.method === 'GET') {
      sendJson(response, 200, panels(actor))
      return true
    }
    if (
      url.pathname === '/api/plugins' ||
      url.pathname === '/api/plugins/rescan' ||
      url.pathname === '/api/plugins/reload'
    ) {
      if (await handleList(actor, url, response, request)) return true
      return false
    }
    return handleOne(actor, url, response, request)
  }

  return dispatch
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let raw = ''
    request.on('data', (chunk) => {
      raw += chunk
      if (raw.length > MAX_JSON_BYTES) {
        reject(teamError(413, ERROR_CODES.INVALID_INPUT, '请求体过大'))
        request.destroy()
      }
    })
    request.on('end', () => resolve(raw))
    request.on('error', reject)
  })
}

function parsePluginBody(result) {
  const raw = result?.body
  if (raw == null || raw === '') return null
  if (typeof raw === 'object') return raw
  try {
    return JSON.parse(String(raw))
  } catch {
    return null
  }
}

/**
 * 把插件返回的失败翻译成团队错误码：只暴露用户能理解的三种结果。
 * 未登录/过期统一 401，但 code 不同，前端据此决定"输入密码"还是"重新输入密码"。
 */
/**
 * 只转发和内容协商有关的头。Cookie / authorization 属于 Board 自己的登录态，
 * 不该出现在插件子进程里。
 */
function forwardHeaders(headers = {}) {
  const keep = ['accept', 'content-type', 'if-none-match', 'accept-language']
  const forwarded = {}
  for (const key of keep) {
    if (headers[key] !== undefined) forwarded[key] = headers[key]
  }
  forwarded['x-trellis-board-mode'] = 'team'
  return forwarded
}

function pluginFailure(result, payload) {
  const status = Number(result?.status ?? 502)
  // 插件把细节放在 detail 里（见 witops-core 的 failure()），也兼容直接平铺。
  const reason = payload?.detail?.reason ?? payload?.reason ?? null
  const message = payload?.error || 'WitOps 暂时连不上，请稍后再试'
  if (status === 401) {
    if (reason === 'connection-lost') {
      return teamError(
        401,
        ERROR_CODES.CONNECTION_LOST,
        '你和 WitOps 的连接已断开，需要重新输入密码',
      )
    }
    if (reason === 'missing-credentials') {
      return teamError(401, ERROR_CODES.CREDENTIALS_MISSING, '先登录 WitOps 账号，再查看任务')
    }
    return teamError(401, ERROR_CODES.AUTH_FAILED, 'WitOps 账号或密码不对，请重新输入')
  }
  if (status === 429) {
    return teamError(429, ERROR_CODES.LOGIN_TOO_FREQUENT, '登录尝试太频繁，请稍后再试')
  }
  if (status === 409) {
    return teamError(409, ERROR_CODES.ACCOUNT_IN_USE, message)
  }
  return teamError(502, 'UPSTREAM_UNAVAILABLE', 'WitOps 暂时连不上，请稍后再试')
}

function sendPluginResponse(response, result) {
  const status = Number(result?.status ?? 200)
  const headers = result?.headers && typeof result.headers === 'object' ? result.headers : {}
  const body = typeof result?.body === 'string' ? result.body : writeJson(result?.body ?? '')
  response.writeHead(status, {
    'content-type': headers['content-type'] ?? 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  response.end(body)
}

function sanitizeManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') return null
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    apiVersion: manifest.apiVersion,
    description: manifest.description ?? '',
    permissions: manifest.permissions ?? [],
    panels: manifest.panels ?? [],
    userConfigFields: manifest.userConfigFields ?? [],
    requires: manifest.requires ?? [],
    provides: manifest.provides ?? [],
  }
}

function sanitizeConfig(config) {
  if (!config || typeof config !== 'object') return {}
  return Object.fromEntries(
    Object.entries(config).filter(([key, value]) => {
      if (/password|secret|token/i.test(key)) return false
      return value == null || ['string', 'number', 'boolean'].includes(typeof value)
    }),
  )
}
