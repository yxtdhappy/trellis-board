/**
 * jenkins-ops：把 Jenkins 的作业、构建、队列与产物操作暴露给 Trellis Board。
 *
 * 配置来源有两层，后者覆盖前者：
 * 1. data/plugins.json 的 config（适合随仓库分发的静态配置）；
 * 2. 面板写入的 store `settings`（适合在 UI 里改 baseUrl / username）。
 * 认证只有一种：账号 + 密码走 Jenkins 表单登录换会话 Cookie，密码只落 secrets
 * （宿主 AES-256-GCM 加密），不写 store、不写日志。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPlugin } from '@trellis-board/server/plugins/sdk.js'
import { JenkinsError, createJenkinsClient } from './jenkins-client.js'

const PLUGIN_ID = 'jenkins-ops'
const PLUGIN_VERSION = '1.0.0'
const BASE_DIR = path.dirname(fileURLToPath(import.meta.url))
const SECRET_PASSWORD_KEY = 'jenkins-ops/password'
const SETTINGS_STORE_KEY = 'settings'

const DEFAULTS = {
  baseUrl: '',
  username: '',
  password: '',
  jobFilter: [],
  views: [],
  verifyTls: true,
  crumb: 'auto',
  timeoutMs: 20_000,
  retries: 1,
  maxLogLines: 2_000,
  repositoryId: '',
}

function text(value) {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

function positiveInt(value, fallback) {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : fallback
}

function normalizeJobFilter(value) {
  if (Array.isArray(value)) return value.map(text).filter(Boolean)
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
  }
  return []
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.map(text).filter(Boolean)
  if (typeof value === 'string') {
    return value
      .split(/[,\n]/)
      .map((item) => item.trim())
      .filter(Boolean)
  }
  return []
}

function normalizeConfig(raw = {}) {
  const config = { ...DEFAULTS, ...(raw ?? {}) }
  return {
    baseUrl: text(config.baseUrl),
    username: text(config.username),
    password: text(config.password),
    jobFilter: normalizeJobFilter(config.jobFilter),
    views: normalizeList(config.views),
    verifyTls: config.verifyTls !== false,
    crumb: config.crumb === 'off' || config.crumb === 'force' ? config.crumb : 'auto',
    timeoutMs: positiveInt(config.timeoutMs, DEFAULTS.timeoutMs),
    retries: Math.max(0, Number(config.retries ?? DEFAULTS.retries) || 0),
    maxLogLines: positiveInt(config.maxLogLines, DEFAULTS.maxLogLines),
    repositoryId: text(config.repositoryId),
  }
}

function respond(status, body) {
  return { status, headers: { 'content-type': 'application/json; charset=utf-8' }, body }
}

function toHttpError(error) {
  if (error?.code === -32602) return respond(400, { error: error.message })
  const status = Number.isInteger(error?.status)
    ? error.status
    : error?.code === 1003
      ? 504
      : error?.code === 1001
        ? 401
        : error?.code === 1002
          ? 400
          : error?.code === 1005
            ? 429
            : 502
  const safeStatus = status >= 400 && status < 600 ? status : 502
  return respond(safeStatus, {
    error: error?.message || 'Jenkins 请求失败',
    code: error?.code ?? null,
    ...(error?.detail ? { detail: error.detail } : {}),
  })
}

function guard(handler) {
  return async (request) => {
    try {
      return await handler(request)
    } catch (error) {
      return toHttpError(error)
    }
  }
}

function requireJob(params) {
  const name = text(params?.job ?? params?.name)
  if (!name) throw new JenkinsError('缺少 job 名称', { code: 1002 })
  return name
}

async function safeSecret(ctx, key) {
  try {
    return text(await ctx.secrets.get(key))
  } catch {
    return ''
  }
}

// 面板写入的密码优先；也允许 plugins.json 直接配 config.password（便于测试与随仓库分发）。
async function resolvePassword(ctx, config) {
  const stored = await safeSecret(ctx, SECRET_PASSWORD_KEY)
  if (stored) return stored
  return text(config?.password)
}

async function readStoredSettings(ctx) {
  try {
    const value = await ctx.store.get(SETTINGS_STORE_KEY)
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

export default createPlugin({
  name: PLUGIN_ID,
  version: PLUGIN_VERSION,
  apiVersion: 1,
  permissions: [
    'http:route',
    'panels',
    'store',
    'secrets:read',
    'secrets:write',
    'capabilities:provide',
  ],

  async onStart(ctx) {
    const config = normalizeConfig(ctx.config)
    let stored = await readStoredSettings(ctx)
    let password = await resolvePassword(ctx, config)
    let client = null
    let clientError = null

    function currentSettings() {
      return {
        baseUrl: text(stored.baseUrl ?? config.baseUrl),
        username: text(stored.username ?? config.username),
        verifyTls: stored.verifyTls === undefined ? config.verifyTls : stored.verifyTls !== false,
        jobFilter: Array.isArray(stored.jobFilter)
          ? normalizeJobFilter(stored.jobFilter)
          : config.jobFilter,
        views: Array.isArray(stored.views) ? normalizeList(stored.views) : config.views,
        timeoutMs: config.timeoutMs,
        retries: config.retries,
        crumb: config.crumb,
        maxLogLines: config.maxLogLines,
      }
    }

    function rebuild() {
      client = null
      clientError = null
      const settings = currentSettings()
      if (!settings.baseUrl) {
        clientError = new JenkinsError(
          '未配置 Jenkins 地址：请在「设置」里填写 baseUrl（或在 plugins.json 里配置）',
          { code: 1002 },
        )
        return null
      }
      try {
        client = createJenkinsClient({ ...settings, password, logger: ctx.log })
        return client
      } catch (error) {
        clientError = error
        return null
      }
    }

    function requireClient() {
      if (client) return client
      const instance = rebuild()
      if (!instance) throw clientError ?? new JenkinsError('Jenkins 客户端未就绪', { code: 1002 })
      return instance
    }

    async function statusPayload() {
      const settings = currentSettings()
      const payload = {
        plugin: PLUGIN_ID,
        version: PLUGIN_VERSION,
        configured: Boolean(settings.baseUrl),
        baseUrl: settings.baseUrl,
        username: settings.username,
        hasPassword: Boolean(password),
        authMode: password ? 'password' : 'none',
        verifyTls: settings.verifyTls,
        jobFilter: settings.jobFilter,
        views: settings.views,
        connection: null,
        error: null,
      }
      if (!settings.baseUrl) {
        payload.error = clientError?.message ?? null
        return payload
      }
      try {
        payload.connection = await requireClient().testConnection()
      } catch (error) {
        payload.error = error?.message ?? String(error)
      }
      return payload
    }

    function asset(name, type) {
      try {
        return {
          status: 200,
          headers: { 'content-type': type },
          body: fs.readFileSync(path.join(BASE_DIR, 'panel', name), 'utf8'),
        }
      } catch {
        return respond(404, { error: `面板资源缺失: ${name}` })
      }
    }

    ctx.http.route(
      'GET',
      '/panel',
      () => asset('index.html', 'text/html; charset=utf-8') ?? respond(404, { error: 'not found' }),
    )
    ctx.http.route('GET', '/panel/app.js', () => asset('app.js', 'text/javascript; charset=utf-8'))
    ctx.http.route('GET', '/panel/app.css', () => asset('app.css', 'text/css; charset=utf-8'))

    ctx.http.route(
      'GET',
      '/status',
      guard(async () => respond(200, await statusPayload())),
    )

    ctx.http.route(
      'POST',
      '/settings',
      guard(async (request) => {
        const body = request.json() ?? {}
        const next = { ...stored }
        if (body.baseUrl !== undefined) {
          const baseUrl = text(body.baseUrl)
          if (baseUrl && !/^https?:\/\//i.test(baseUrl)) {
            return respond(400, { error: 'baseUrl 必须以 http:// 或 https:// 开头' })
          }
          next.baseUrl = baseUrl
        }
        if (body.username !== undefined) next.username = text(body.username)
        if (body.verifyTls !== undefined) next.verifyTls = body.verifyTls !== false
        if (body.jobFilter !== undefined) next.jobFilter = normalizeJobFilter(body.jobFilter)
        if (body.views !== undefined) next.views = normalizeList(body.views)
        stored = next
        await ctx.store.set(SETTINGS_STORE_KEY, stored)
        client = null
        ctx.log.info('Jenkins 设置已更新', {
          baseUrl: text(next.baseUrl ?? config.baseUrl),
          username: text(next.username ?? config.username),
        })
        return respond(200, { ok: true, status: await statusPayload() })
      }),
    )

    ctx.http.route(
      'POST',
      '/password',
      guard(async (request) => {
        const body = request.json() ?? {}
        const value = text(body.password)
        if (!value) return respond(400, { error: 'password 不能为空' })
        if (body.username !== undefined && text(body.username)) {
          stored = { ...stored, username: text(body.username) }
          await ctx.store.set(SETTINGS_STORE_KEY, stored)
        }
        await ctx.secrets.set(SECRET_PASSWORD_KEY, value)
        password = value
        client = null
        ctx.log.info('Jenkins 账号密码已更新（表单登录模式）')
        return respond(200, { ok: true, status: await statusPayload() })
      }),
    )

    ctx.http.route(
      'POST',
      '/password/clear',
      guard(async () => {
        await ctx.secrets.delete(SECRET_PASSWORD_KEY)
        password = ''
        client = null
        return respond(200, { ok: true, status: await statusPayload() })
      }),
    )

    ctx.http.route(
      'GET',
      '/param-values',
      guard(async (request) => {
        const job = text(request.query.job)
        const name = text(request.query.name)
        const className = text(request.query.class)
        if (!job || !name) return respond(400, { error: '需要 job 与 name 参数' })
        const result = await requireClient().listParameterValues(job, name, className)
        return respond(200, result)
      }),
    )

    ctx.http.route(
      'GET',
      '/jobs',
      guard(async (request) => {
        const settings = currentSettings()
        const folder = text(request.query.folder)
        const filter =
          request.query.filter === undefined
            ? settings.jobFilter
            : normalizeJobFilter(request.query.filter)
        const views =
          request.query.view !== undefined
            ? normalizeList(request.query.view)
            : request.query.all === '1'
              ? []
              : settings.views
        const result = await requireClient().listJobs({
          folder,
          recursive: request.query.recursive !== '0',
          filter,
          views,
        })
        return respond(200, result)
      }),
    )

    ctx.http.route(
      'GET',
      '/job',
      guard(async (request) =>
        respond(200, await requireClient().getJob(text(request.query.name))),
      ),
    )

    ctx.http.route(
      'POST',
      '/build',
      guard(async (request) => {
        const body = request.json() ?? {}
        const job = requireJob(body)
        const parameters =
          body.parameters && typeof body.parameters === 'object' ? body.parameters : {}
        const result = await requireClient().triggerBuild(job, {
          parameters,
          wait: body.wait !== false,
          waitTimeoutMs: positiveInt(body.waitTimeoutMs, 60_000),
        })
        ctx.log.info('Jenkins 构建已触发', {
          job,
          queueId: result.queueId,
          buildNumber: result.buildNumber,
        })
        return respond(200, result)
      }),
    )

    ctx.http.route(
      'GET',
      '/build',
      guard(async (request) =>
        respond(
          200,
          await requireClient().getBuild(
            text(request.query.job),
            text(request.query.number) || undefined,
          ),
        ),
      ),
    )

    ctx.http.route(
      'GET',
      '/log',
      guard(async (request) => {
        const settings = currentSettings()
        const tail = positiveInt(request.query.tail, Math.min(200, settings.maxLogLines))
        return respond(
          200,
          await requireClient().getBuildLog(
            text(request.query.job),
            text(request.query.number) || undefined,
            { tail: Math.min(tail, settings.maxLogLines) },
          ),
        )
      }),
    )

    ctx.http.route(
      'POST',
      '/build/stop',
      guard(async (request) => {
        const body = request.json() ?? {}
        const result = await requireClient().stopBuild(
          requireJob(body),
          text(body.number) || undefined,
        )
        ctx.log.info('Jenkins 构建已请求中止', { job: result.job, number: result.number })
        return respond(200, result)
      }),
    )

    ctx.http.route(
      'GET',
      '/queue',
      guard(async () => respond(200, await requireClient().listQueue())),
    )

    ctx.http.route(
      'POST',
      '/queue/cancel',
      guard(async (request) => {
        const body = request.json() ?? {}
        return respond(200, await requireClient().cancelQueue(body.id))
      }),
    )

    ctx.http.route(
      'GET',
      '/artifacts',
      guard(async (request) =>
        respond(
          200,
          await requireClient().listArtifacts(
            text(request.query.job),
            text(request.query.number) || undefined,
          ),
        ),
      ),
    )

    ctx.http.route(
      'GET',
      '/artifact',
      guard(async (request) =>
        respond(
          200,
          await requireClient().fetchArtifact(
            text(request.query.job),
            text(request.query.number) || undefined,
            text(request.query.path),
          ),
        ),
      ),
    )

    ctx.capabilities.register('jenkins.ops', {
      'jobs.list': (params) =>
        requireClient().listJobs({
          folder: text(params?.folder),
          recursive: params?.recursive !== false,
          filter: Array.isArray(params?.filter)
            ? normalizeJobFilter(params.filter)
            : currentSettings().jobFilter,
          views:
            params?.views === undefined ? currentSettings().views : normalizeList(params.views),
        }),
      'job.get': (params) => requireClient().getJob(requireJob(params)),
      'build.trigger': (params) =>
        requireClient().triggerBuild(requireJob(params), {
          parameters:
            params?.parameters && typeof params.parameters === 'object' ? params.parameters : {},
          wait: params?.wait === true,
          waitTimeoutMs: positiveInt(params?.waitTimeoutMs, 60_000),
        }),
      'build.status': (params) =>
        requireClient().getBuild(requireJob(params), text(params?.number) || undefined),
      'build.log': (params) =>
        requireClient().getBuildLog(requireJob(params), text(params?.number) || undefined, {
          tail: positiveInt(params?.tail, 200),
        }),
      'build.stop': (params) =>
        requireClient().stopBuild(requireJob(params), text(params?.number) || undefined),
      'queue.list': () => requireClient().listQueue(),
      'queue.cancel': (params) => requireClient().cancelQueue(params?.id),
      'artifacts.list': (params) =>
        requireClient().listArtifacts(requireJob(params), text(params?.number) || undefined),
      'artifact.fetch': (params) =>
        requireClient().fetchArtifact(
          requireJob(params),
          text(params?.number) || undefined,
          text(params?.path),
        ),
    })

    rebuild()
    ctx.log.info('jenkins-ops 已启动', {
      baseUrl: currentSettings().baseUrl || '(未配置)',
      username: currentSettings().username || '(未配置)',
      hasPassword: Boolean(password),
      jobFilter: currentSettings().jobFilter,
      views: currentSettings().views,
    })
  },
})
