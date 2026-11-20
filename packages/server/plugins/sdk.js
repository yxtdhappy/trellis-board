/**
 * 插件侧 SDK（零依赖）。
 *
 * 插件作者只写 createPlugin({...})，SDK 负责：
 * - JSONL 帧解析、请求 id、超时、错误封装
 * - ctx.tasks / events / http / store / schedule / log / effect
 * - 未处理异常上报与优雅停止
 *
 * stdout 只承载协议帧；console.log/info 在子进程模式下重定向到 stderr，
 * 避免第三方依赖打印日志破坏协议。
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import {
  HOST_API_VERSION,
  encodeFrame,
  createFrameDecoder,
  successResponse,
  errorResponse,
  requestFrame,
  notificationFrame,
  isRequest,
  isResponse,
  isNotification,
  RPC,
} from './protocol.js'

const DEFAULT_TIMEOUTS = {
  'task/get': 10_000,
  'task/list': 10_000,
  'task/create': 120_000,
  'task/assign': 30_000,
  'task/setStage': 10_000,
  'event/emit': 5_000,
  'event/publish': 5_000,
  'store/get': 5_000,
  'store/set': 5_000,
  'store/delete': 5_000,
  'store/list': 5_000,
  'log/write': 5_000,
  'schedule/register': 5_000,
  'schedule/unregister': 5_000,
  'capability/call': 30_000,
}

export class PluginError extends Error {
  constructor(code, message, detail) {
    super(message)
    this.name = 'PluginError'
    this.code = code
    this.detail = detail
  }
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function matchRoutePath(routePath, requestPath) {
  if (routePath === requestPath) return true
  const normalizedRoute =
    routePath.endsWith('/') && routePath !== '/' ? routePath.slice(0, -1) : routePath
  const normalizedRequest =
    requestPath.endsWith('/') && requestPath !== '/' ? requestPath.slice(0, -1) : requestPath
  return normalizedRoute === normalizedRequest
}

function matchesEvent(pattern, name) {
  if (pattern === '*' || pattern === name) return true
  if (pattern.endsWith('.*')) return name.startsWith(pattern.slice(0, -1))
  return false
}

/**
 * team 模式下每次插件调用都要带上"当前是谁"。
 * 用 AsyncLocalStorage 而不是给每个 handler 加参数：既有代码不用改，
 * 也不会因为漏传上下文把 A 用户的 token 用成 B 用户的。
 */
const requestScope = new AsyncLocalStorage()

/**
 * team 模式下宿主按 actor 给 store 分区（`user:<userId>:<key>`），
 * 所以每次 store 调用都要带上当前请求的 actorRef，否则会被当成"缺少 actor 上下文"拒绝。
 */
function actorRefOf() {
  return requestScope.getStore()?.actor?.ref ?? null
}

export function createPlugin({
  name,
  version,
  apiVersion = HOST_API_VERSION,
  permissions = [],
  onStart = async () => {},
  onStop = async () => {},
} = {}) {
  if (!name || typeof name !== 'string') throw new Error('createPlugin 需要 name')
  if (!version || typeof version !== 'string') throw new Error('createPlugin 需要 version')
  const plugin = {
    name,
    version,
    apiVersion,
    permissions: [...permissions],
    onStart,
    onStop,
  }
  if (process.env.TRELLIS_PLUGIN_CHILD === '1') {
    queueMicrotask(() => {
      try {
        startPluginRuntime(plugin)
      } catch (error) {
        process.stderr.write(`插件启动失败: ${error?.stack || error}\n`)
        process.exitCode = 1
      }
    })
  }
  return plugin
}

export function startPluginRuntime(
  plugin,
  { input = process.stdin, output = process.stdout, exit = (code) => process.exit(code) } = {},
) {
  const routes = []
  const handlers = new Map()
  const disposers = []
  const timers = new Map()
  const capabilityHandlers = new Map()
  const pending = new Map()
  const controllers = new Map()
  const settled = new Set()
  let sequence = 0
  let stopping = false
  let started = false
  let timeoutMs = 30_000
  let config = {}

  if (process.env.TRELLIS_PLUGIN_CHILD === '1' && output === process.stdout) {
    const toStderr = (...args) => {
      process.stderr.write(`${args.map(formatLogArg).join(' ')}\n`)
    }
    console.log = toStderr
    console.info = toStderr
  }

  function write(message) {
    try {
      output.write(encodeFrame(message))
      return true
    } catch {
      return false
    }
  }

  function call(method, params = {}, options = {}) {
    const id = `p${++sequence}`
    const budget = Number(options.timeoutMs ?? DEFAULT_TIMEOUTS[method] ?? timeoutMs)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new PluginError(1003, `宿主请求超时: ${method}`))
      }, budget)
      timer.unref?.()
      pending.set(id, { resolve, reject, timer })
      write(requestFrame(id, method, params))
    })
  }

  function notify(method, params) {
    write(notificationFrame(method, params))
  }

  function registerCapability(name, methods) {
    const capabilityName = String(name ?? '').trim()
    if (!capabilityName) throw new PluginError(-32602, 'capability 名称不能为空')
    if (capabilityHandlers.has(capabilityName)) {
      throw new PluginError(-32602, `capability 已注册: ${capabilityName}`)
    }
    if (!isObject(methods) || Object.keys(methods).length === 0) {
      throw new PluginError(-32602, `capability 缺少方法: ${capabilityName}`)
    }
    const handlers = {}
    for (const [method, handler] of Object.entries(methods)) {
      if (typeof handler !== 'function') {
        throw new PluginError(-32602, `capability 方法必须是函数: ${capabilityName}.${method}`)
      }
      handlers[method] = handler
    }
    capabilityHandlers.set(capabilityName, handlers)
    return {
      name: capabilityName,
      methods: Object.keys(handlers),
    }
  }

  function capabilityClient(name) {
    const capabilityName = String(name ?? '').trim()
    return {
      name: capabilityName,
      call: (method, params = null, options = {}) =>
        call(
          'capability/call',
          { name: capabilityName, method: String(method), params },
          {
            timeoutMs: options.timeoutMs,
          },
        ).then((result) => result?.value ?? null),
    }
  }

  /**
   * 读写 secrets（写入由宿主加密落盘）。保留对 process.env 的只读兼容。
   */
  function createSecretsApi() {
    const api = {
      get: (key) =>
        call('secrets/get', { key: String(key ?? '') }).then((result) => result?.value ?? null),
      set: (key, value) =>
        call('secrets/set', { key: String(key ?? ''), value: String(value ?? '') }).then((result) =>
          Boolean(result?.stored),
        ),
      delete: (key) =>
        call('secrets/delete', { key: String(key ?? '') }).then((result) =>
          Boolean(result?.deleted),
        ),
    }
    return new Proxy(api, {
      get: (target, key) => {
        if (key in target) return target[key]
        return typeof key === 'string' ? process.env[key] : undefined
      },
      has: (target, key) => key in target || String(key) in process.env,
      ownKeys: () => [...new Set([...Object.keys(api), ...Object.keys(process.env)])],
      getOwnPropertyDescriptor: (target, key) =>
        key in target
          ? Object.getOwnPropertyDescriptor(target, key)
          : { enumerable: true, configurable: true },
    })
  }

  const ctx = {
    plugin: {
      id: plugin.name,
      version: plugin.version,
      apiVersion: plugin.apiVersion,
      hostVersion: null,
    },
    mode: 'standalone',
    currentActor: () => requestScope.getStore()?.actor ?? null,
    currentCredential: () => requestScope.getStore()?.credential ?? null,
    tasks: {
      create: (params) => call('task/create', params),
      assign: (params) => call('task/assign', params),
      setStage: (params) => call('task/setStage', params),
      setPlan: (params) => call('task/setPlan', params),
      get: (params) => call('task/get', params),
      list: (params = {}) => call('task/list', params),
    },
    capabilities: {
      register: registerCapability,
      client: capabilityClient,
      call: (name, method, params = null, options = {}) =>
        capabilityClient(name).call(method, params, options),
    },
    runs: {
      start: (params = {}) =>
        call('run/start', params).then((result) => ({
          run: result?.run ?? null,
          runId: result?.run?.runId ?? null,
          status: result?.run?.status ?? null,
          started: Boolean(result?.started),
        })),
      progress: (runId, patch = {}) =>
        call('run/progress', { ...patch, runId }).then((result) => result?.run ?? null),
      finish: (runId, patch = {}) =>
        call('run/finish', { ...patch, runId }).then((result) => result?.run ?? null),
      list: (params = {}) => call('run/list', params).then((result) => result?.runs ?? []),
    },
    events: {
      on(pattern, handler) {
        if (typeof handler !== 'function') throw new Error('事件处理器必须是函数')
        if (!handlers.has(pattern)) handlers.set(pattern, [])
        handlers.get(pattern).push(handler)
        return () => {
          const list = handlers.get(pattern) || []
          const index = list.indexOf(handler)
          if (index >= 0) list.splice(index, 1)
        }
      },
      emit: (eventName, payload = {}) => call('event/emit', { name: eventName, payload }),
      publish: (eventName, payload = {}) =>
        call('event/publish', { name: eventName, payload, public: true }),
    },
    http: {
      route(method, routePath, handler) {
        routes.push({
          method: String(method).toUpperCase(),
          path: String(routePath),
          handler,
          public: false,
        })
        return () => removeRoute(method, routePath)
      },
      public(method, routePath, handler) {
        routes.push({
          method: String(method).toUpperCase(),
          path: String(routePath),
          handler,
          public: true,
        })
        return () => removeRoute(method, routePath)
      },
    },
    store: {
      get: (key) =>
        call('store/get', { key, actorRef: actorRefOf() }).then((result) => result?.value ?? null),
      set: (key, value) =>
        call('store/set', { key, value, actorRef: actorRefOf() }).then(
          (result) => result?.value ?? null,
        ),
      delete: (key) =>
        call('store/delete', { key, actorRef: actorRefOf() }).then((result) =>
          Boolean(result?.deleted),
        ),
      list: (prefix = '') =>
        call('store/list', { prefix, actorRef: actorRefOf() }).then(
          (result) => result?.entries ?? [],
        ),
    },
    schedule: {
      every(intervalMs, handler) {
        const timerId = `t${++sequence}`
        timers.set(timerId, handler)
        call('schedule/register', { timerId, intervalMs }).catch((error) => {
          timers.delete(timerId)
          process.stderr.write(`注册定时器失败: ${error.message}\n`)
        })
        return timerId
      },
      cancel(timerId) {
        timers.delete(timerId)
        return call('schedule/unregister', { timerId }).catch(() => {})
      },
    },
    log: {
      debug: (message, fields) => writeLog('debug', message, fields),
      info: (message, fields) => writeLog('info', message, fields),
      warn: (message, fields) => writeLog('warn', message, fields),
      error: (message, fields) => writeLog('error', message, fields),
    },
    effect(dispose) {
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => {
        const index = disposers.indexOf(dispose)
        if (index >= 0) disposers.splice(index, 1)
        return dispose()
      }
    },
    secrets: createSecretsApi(),
    error(code, message, detail) {
      return new PluginError(code, message, detail)
    },
    get config() {
      return config
    },
  }

  function removeRoute(method, routePath) {
    const index = routes.findIndex(
      (route) => route.method === String(method).toUpperCase() && route.path === String(routePath),
    )
    if (index >= 0) routes.splice(index, 1)
  }

  function writeLog(level, message, fields) {
    notify('log/write', {
      level,
      message: String(message ?? ''),
      fields: isObject(fields) ? fields : {},
    })
  }

  function capabilities() {
    return {
      http: routes.length > 0,
      events: handlers.size > 0,
      schedule: timers.size > 0,
    }
  }

  function providedCapabilities() {
    return [...capabilityHandlers.entries()].map(([name, handlers]) => ({
      name,
      methods: Object.keys(handlers),
    }))
  }

  async function handleInitialize(message) {
    const params = message.params ?? {}
    config = params.config ?? {}
    ctx.plugin.hostVersion = params.hostVersion ?? null
    ctx.mode = params.mode === 'team' ? 'team' : 'standalone'
    if (Number.isInteger(params.apiVersion) && params.apiVersion <= plugin.apiVersion) {
      timeoutMs = 30_000
    }
    await plugin.onStart(ctx, config)
    started = true
    const provides = providedCapabilities()
    return {
      apiVersion: plugin.apiVersion,
      id: plugin.name,
      name: plugin.name,
      version: plugin.version,
      capabilities: capabilities(),
      ...(provides.length ? { provides } : {}),
    }
  }

  async function handleRoute(message, signal) {
    const params = message.params ?? {}
    const [rawPath, search = ''] = String(params.path || '/').split('?')
    const route = routes.find(
      (candidate) =>
        (candidate.method === String(params.method || 'GET').toUpperCase() ||
          candidate.method === '*') &&
        matchRoutePath(candidate.path, rawPath),
    )
    if (!route) {
      return { status: 404, body: { error: `插件没有该路由: ${params.method} ${rawPath}` } }
    }
    const request = {
      method: String(params.method || 'GET').toUpperCase(),
      path: rawPath,
      query: Object.fromEntries(new URLSearchParams(search)),
      headers: params.headers ?? {},
      body: params.body ?? '',
      actor: params.actor ?? null,
      credential: params.credential ?? null,
      signal,
      json() {
        try {
          return JSON.parse(request.body || '{}')
        } catch {
          throw new PluginError(-32602, '请求体不是合法 JSON')
        }
      },
    }
    const result = await requestScope.run(
      { actor: request.actor, credential: request.credential },
      () => route.handler(request),
    )
    if (result === undefined || result === null) return { status: 204, body: '' }
    if (
      typeof result === 'object' &&
      !Array.isArray(result) &&
      (Object.hasOwn(result, 'status') ||
        Object.hasOwn(result, 'body') ||
        Object.hasOwn(result, 'headers'))
    ) {
      return result
    }
    return { status: 200, body: result }
  }

  async function handleCapability(message) {
    const params = message.params ?? {}
    const name = String(params.name ?? '').trim()
    const method = String(params.method ?? '').trim()
    const handlers = capabilityHandlers.get(name)
    if (!handlers) throw new PluginError(1002, `未提供 capability: ${name}`)
    const handler = handlers[method]
    if (!handler) throw new PluginError(1010, `capability 未提供方法: ${name}.${method}`)
    const result = await handler(params.params ?? null, { caller: params.caller ?? null })
    return { value: result ?? null }
  }

  async function handleEvent(message) {
    const params = message.params ?? {}
    const matched = []
    for (const [pattern, list] of handlers) {
      if (matchesEvent(pattern, params.name)) matched.push(...list)
    }
    for (const handler of matched) {
      await handler({
        name: params.name,
        payload: params.payload ?? {},
        eventId: params.eventId,
        occurredAt: params.occurredAt,
      })
    }
    notify('event/ack', { eventId: params.eventId })
    return { handled: matched.length }
  }

  function handleResponse(message) {
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    clearTimeout(entry.timer)
    if (message.error) {
      entry.reject(
        new PluginError(
          message.error.data?.code ?? -32603,
          message.error.message || '宿主返回错误',
          message.error.data?.detail,
        ),
      )
      return
    }
    entry.resolve(message.result)
  }

  async function handleRequest(message, signal) {
    switch (message.method) {
      case 'initialize':
        return handleInitialize(message)
      case 'http/request':
        return handleRoute(message, signal)
      case 'capability/call':
        return handleCapability(message)
      case 'event/dispatch':
        return handleEvent(message)
      case 'timer/fire': {
        const handler = timers.get(message.params?.timerId)
        if (!handler) return { fired: false }
        await handler()
        return { fired: true }
      }
      case 'plugin/status':
        return { status: 'ok', uptimeMs: process.uptime() * 1000, started }
      case 'shutdown': {
        await shutdown()
        if (process.env.TRELLIS_PLUGIN_CHILD === '1') {
          setImmediate(() => exit(0))
        }
        return { stopped: true }
      }
      case 'plugin/configure':
        config = message.params?.config ?? config
        return { ok: true }
      default:
        throw new PluginError(-32601, `未知方法: ${message.method}`)
    }
  }

  async function shutdown() {
    if (stopping) return
    stopping = true
    for (const dispose of [...disposers].reverse()) {
      try {
        await dispose()
      } catch (error) {
        process.stderr.write(`插件清理失败: ${error?.message || error}\n`)
      }
    }
    disposers.length = 0
    try {
      await plugin.onStop(ctx)
    } catch (error) {
      process.stderr.write(`插件 onStop 失败: ${error?.message || error}\n`)
    }
  }

  const decoder = createFrameDecoder({
    onMessage: (message) => {
      if (isResponse(message)) {
        handleResponse(message)
        return
      }
      if (isRequest(message)) {
        const controller = new AbortController()
        controllers.set(message.id, controller)
        handleRequest(message, controller.signal)
          .then(
            (result) => {
              if (!settled.has(message.id)) write(successResponse(message.id, result))
            },
            (error) => {
              if (!settled.has(message.id)) write(errorResponse(message.id, error))
            },
          )
          .finally(() => {
            controllers.delete(message.id)
            settled.delete(message.id)
          })
        return
      }
      if (isNotification(message)) {
        if (message.method === 'plugin/started') return
        if (message.method === 'shutdown/now') {
          shutdown().finally(() => exit(0))
          return
        }
        if (message.method === 'request/cancel') {
          const id = message.params?.id
          const controller = controllers.get(id)
          if (controller) {
            controller.abort()
            settled.add(id)
            write(errorResponse(id, new PluginError(RPC.REQUEST_CANCELLED, '请求已取消')))
            controllers.delete(id)
          }
          return
        }
        if (message.method === 'plugin/config.changed') {
          config = message.params?.config ?? config
        }
      }
    },
  })

  input.setEncoding?.('utf8')
  input.on('data', (chunk) => decoder.push(chunk))
  input.on('end', () => {
    if (stopping) return
    shutdown().finally(() => exit(0))
  })

  return {
    ctx,
    decoder,
    stop: shutdown,
    pending,
    resolveTimeout: (ms) => {
      timeoutMs = ms
    },
  }
}

function formatLogArg(value) {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
