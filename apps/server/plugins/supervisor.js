import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { minimalEnvironment, terminateTree } from '../team/process.js'
import {
  HOST_API_VERSION,
  MAX_FRAME_BYTES,
  ERROR_CODES,
  RPC,
  RpcError,
  PERMISSION_BY_METHOD,
  ALWAYS_ALLOWED_METHODS,
  HOST_TO_PLUGIN_TIMEOUTS,
  encodeFrame,
  createFrameDecoder,
  successResponse,
  errorResponse,
  notificationFrame,
  requestFrame,
  isRequest,
  isNotification,
  isResponse,
  methodNotFound,
  invalidParams,
  appError,
} from './protocol.js'
import {
  validateManifest,
  manifestFailureMessage,
  isValidSemver,
  satisfiesRange,
} from './version.js'
import { createCoreCapabilities } from './core-capabilities.js'
import {
  defaultSecretsFile,
  defaultSecretsKeyFile,
  deleteSecretRef,
  inlineSecretFields,
  loadSecretsFile,
  resolveConfigReferences,
  summarizeSources,
  writeSecretRef,
} from './secrets.js'

export const PLUGIN_STATUSES = Object.freeze([
  'starting',
  'running',
  'stopped',
  'error',
  'incompatible',
  'disabled',
  'missing-secret',
])

const DEFAULT_RESTART_DELAYS = [1_000, 2_000, 4_000, 8_000, 16_000]
const MAX_RESTART_DELAY = 60_000
const AUTO_DISABLE_WINDOW_MS = 10 * 60 * 1000
const AUTO_DISABLE_LIMIT = 5
const EVENT_QUEUE_LIMIT = 500
const EVENT_ACK_TIMEOUT_MS = 30_000
const EVENT_MAX_ATTEMPTS = 3
const EVENT_RING_LIMIT = 1000
const LOG_RING_LIMIT = 500
const LOG_FILE_LIMIT = 10 * 1024 * 1024
const LOG_FILE_KEEP = 3
const SENSITIVE_KEY_PATTERN = /(token|password|secret|apikey|api_key|credential)/i
const RESERVED_ROOT_PREFIXES = ['/api']
const RESERVED_ROOT_PATHS = new Set(['/'])

function nowIso() {
  return new Date().toISOString()
}

function redactValue(key, value) {
  if (SENSITIVE_KEY_PATTERN.test(key)) {
    if (value && typeof value === 'object') return redactConfig(value)
    return '***'
  }
  if (value && typeof value === 'object') {
    return Array.isArray(value)
      ? value.map((item) => (item && typeof item === 'object' ? redactConfig(item) : item))
      : redactConfig(value)
  }
  return value
}

export function redactConfig(config) {
  if (!config || typeof config !== 'object') return config
  const result = {}
  for (const [key, value] of Object.entries(config)) {
    result[key] = redactValue(key, value)
  }
  return result
}

/**
 * 生成与键序无关的配置签名，用于判断 reload 时配置是否真的变了。
 * 值里可能有 null（缺失的 secret/env 引用），必须与 undefined 区分开。
 */
function configSignature(value) {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(configSignature).join(',')}]`
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${configSignature(value[key])}`)
    .join(',')}}`
}

export function loadPluginConfigFile(file, { env = process.env, secretsFile } = {}) {
  if (!fs.existsSync(file)) return { plugins: [], missing: [], warnings: [] }
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    throw new Error('plugins.json 不是合法 JSON')
  }
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.plugins)) {
    throw new Error('plugins.json 必须包含 plugins 数组')
  }
  const secrets = loadSecretsFile(
    secretsFile || env.TRELLIS_BOARD_SECRETS_FILE || defaultSecretsFile(file),
  )
  const warnings = secrets.warnings.map((warning) => ({ ...warning }))
  const missing = []
  const plugins = raw.plugins.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`plugins.json 第 ${index + 1} 项不是对象`)
    }
    const id = String(entry.id || '').trim()
    if (!id) throw new Error(`plugins.json 第 ${index + 1} 项缺少 id`)
    if (!/^[A-Za-z0-9._-]+$/.test(id)) {
      throw new Error(`插件 id 只能包含字母、数字、点、下划线与中划线: ${id}`)
    }
    const entryMissing = []
    const sources = {}
    const config = resolveConfigReferences(entry.config ?? {}, {
      env,
      refs: secrets.refs,
      missing: entryMissing,
      sources,
    })
    const inline = inlineSecretFields(sources)
    if (inline.length) {
      warnings.push({ kind: 'inline-secret', id, fields: inline })
    }
    missing.push({
      id,
      names: entryMissing.filter((name, at) => entryMissing.indexOf(name) === at),
    })
    const sortValue = entry.sort === undefined || entry.sort === null ? null : Number(entry.sort)
    if (sortValue !== null && !Number.isFinite(sortValue)) {
      throw new Error(`插件 ${id} 的 sort 必须是数字`)
    }
    return {
      id,
      module: String(entry.module || '').trim(),
      enabled: entry.enabled !== false,
      sort: sortValue,
      version: entry.version == null ? undefined : String(entry.version),
      command: entry.command ? String(entry.command) : null,
      args: Array.isArray(entry.args) ? entry.args.map(String) : null,
      config: config ?? {},
      configSource: summarizeSources(sources),
      allowMissingSecrets: entry.allowMissingSecrets === true,
    }
  })
  return { plugins, missing, warnings, secretsFile: secrets.file }
}

function createLogRing(limit = LOG_RING_LIMIT) {
  const entries = []
  return {
    push(entry) {
      entries.push(entry)
      if (entries.length > limit) entries.splice(0, entries.length - limit)
    },
    list(tail = 200) {
      return entries.slice(-Math.max(1, Math.min(limit, Number(tail) || 200)))
    },
  }
}

function rotateLogFile(file) {
  if (!fs.existsSync(file)) return
  if (fs.statSync(file).size < LOG_FILE_LIMIT) return
  for (let index = LOG_FILE_KEEP - 1; index >= 1; index -= 1) {
    const from = index === 1 ? file : `${file}.${index}`
    const to = `${file}.${index + 1}`
    if (fs.existsSync(from)) {
      try {
        fs.renameSync(from, to)
      } catch {
        // 轮转失败不能影响插件运行。
      }
    }
  }
  try {
    fs.renameSync(file, `${file}.1`)
  } catch {
    // 当前文件改名失败时保留原文件，下一次轮转再试。
  }
}

/**
 * 一个插件子进程的封装：spawn、帧解码、请求 id、超时与终止。
 */
class PluginProcess {
  constructor(runtime, entry, { command, args, cwd, env }) {
    this.runtime = runtime
    this.entry = entry
    this.command = command
    this.args = args
    this.cwd = cwd
    this.env = env
    this.child = null
    this.decoder = null
    this.pending = new Map()
    this.sequence = 0
    this.stopping = false
    this.exited = false
    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve
    })
  }

  start() {
    this.child = this.runtime.spawnImpl(this.command, this.args, {
      cwd: this.cwd,
      env: this.env,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.decoder = createFrameDecoder({
      maxBytes: MAX_FRAME_BYTES,
      onMessage: (message) => this.handleMessage(message),
      onError: (error) => {
        this.runtime.recordError(this.entry, error.message)
        this.runtime.audit(this.entry, 'protocol-error', { message: error.message })
        if (error.code === ERROR_CODES.RATE_LIMITED) {
          // 超过 1 MiB 说明帧边界已不可信，继续解析只会读到半截数据，直接断开进程。
          this.runtime.audit(this.entry, 'frame-too-large', { message: error.message })
          this.kill()
        }
      },
    })
    this.child.stdout.on('data', (chunk) => this.decoder.push(chunk))
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (line.trim()) this.runtime.writeLog(this.entry, 'stderr', line, {})
      }
    })
    this.child.once('error', (error) => {
      this.runtime.recordError(this.entry, error.message)
      this.rejectAll(error)
    })
    this.child.once('exit', (code, signal) => {
      this.exited = true
      this.rejectAll(new Error(`插件进程已退出（code=${code}, signal=${signal ?? '-'}）`))
      this.resolveExit({ code, signal })
      this.runtime.handleExit(this.entry, { code, signal })
    })
    return this
  }

  handleMessage(message) {
    if (isResponse(message)) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error) {
        const error = new RpcError(
          message.error.data?.code ?? ERROR_CODES.INTERNAL_ERROR,
          message.error.message || '插件返回错误',
          { rpcCode: message.error.code, data: message.error.data?.detail },
        )
        pending.reject(error)
      } else {
        pending.resolve(message.result)
      }
      return
    }
    if (isRequest(message)) {
      this.runtime.handlePluginRequest(this.entry, message).then(
        (result) => this.write(successResponse(message.id, result)),
        (error) => {
          const payload = errorResponse(message.id, error)
          this.write(payload)
        },
      )
      return
    }
    if (isNotification(message)) {
      this.runtime.handlePluginNotification(this.entry, message)
    }
  }

  write(message) {
    if (!this.child || this.exited || this.child.stdin.destroyed) return false
    try {
      this.child.stdin.write(encodeFrame(message))
      return true
    } catch (error) {
      this.runtime.recordError(this.entry, error.message)
      return false
    }
  }

  request(method, params, timeoutMs) {
    if (!this.child || this.exited) {
      return Promise.reject(new RpcError(ERROR_CODES.DISABLED, '插件进程未运行'))
    }
    const id = `h${++this.sequence}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        // 超时只取消当前请求，不终止进程；插件可以忽略取消通知，宿主不再等待结果。
        this.notify('request/cancel', { id })
        reject(new RpcError(ERROR_CODES.TIMEOUT, `插件请求超时: ${method}`))
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(id, { resolve, reject, timer })
      this.write(requestFrame(id, method, params))
    })
  }

  notify(method, params) {
    return this.write(notificationFrame(method, params))
  }

  cancelRequest(id) {
    return this.notify('request/cancel', { id })
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  async stop(graceMs) {
    this.stopping = true
    try {
      await this.request('shutdown', {}, this.runtime.timeoutFor('shutdown'))
    } catch {
      // 插件可能已经退出或不响应，继续走终止流程。
    }
    const exited = await Promise.race([
      this.exitPromise.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), graceMs)),
    ])
    if (!exited && this.child) await terminateTree(this.child)
    await Promise.race([this.exitPromise, new Promise((resolve) => setTimeout(resolve, graceMs))])
  }

  kill() {
    if (this.child && !this.exited) void terminateTree(this.child)
  }
}

export class PluginSupervisor {
  constructor({
    db,
    appDir,
    dataDir,
    pluginsDir,
    hostVersion,
    repositories = [],
    tasks,
    repositoryService = null,
    store,
    configFile,
    spawnImpl = spawn,
    env = process.env,
    logger = console,
    restartDelaysMs = DEFAULT_RESTART_DELAYS,
    healthIntervalMs = 30_000,
    eventAckTimeoutMs = EVENT_ACK_TIMEOUT_MS,
    autoDisableWindowMs = AUTO_DISABLE_WINDOW_MS,
    autoDisableLimit = AUTO_DISABLE_LIMIT,
    timeoutOverrides = {},
    now = nowIso,
  }) {
    this.db = db
    this.appDir = appDir
    this.dataDir = dataDir
    this.pluginsDir = pluginsDir ? path.resolve(pluginsDir) : path.dirname(configFile)
    this.hostVersion = hostVersion
    this.repositories = repositories
    this.tasks = tasks
    this.coreCapabilities = createCoreCapabilities({
      repositories,
      repositoryService,
      listCapabilities: () => this.capabilityCatalog(),
      invokeCapability: (request) => this.invokeBrokeredCapability(request),
    })
    this.store = store
    this.configFile = configFile
    this.secretsFile = env.TRELLIS_BOARD_SECRETS_FILE || defaultSecretsFile(configFile)
    this.secretsKeyFile = defaultSecretsKeyFile(this.secretsFile)
    this.spawnImpl = spawnImpl
    this.env = env
    this.logger = logger
    this.restartDelaysMs = restartDelaysMs
    this.healthIntervalMs = healthIntervalMs
    this.eventAckTimeoutMs = eventAckTimeoutMs
    this.autoDisableWindowMs = autoDisableWindowMs
    this.autoDisableLimit = autoDisableLimit
    this.timeoutOverrides = timeoutOverrides
    this.now = now
    this.plugins = new Map()
    this.capabilities = new Map()
    this.eventSequence = 0
    this.eventRing = []
    this.eventSubscribers = new Set()
    this.rootPaths = new Map()
    this.healthTimer = null
    this.stopping = false
    this.reloading = null
    // 插件配置、密钥与日志都在 <pluginsDir> 下，不再与 board.sqlite 混放。
    this.logDir = path.join(this.pluginsDir, 'logs')
  }

  async load() {
    const config = loadPluginConfigFile(this.configFile, { env: this.env })
    for (const warning of config.warnings) {
      this.logger.warn?.('插件配置警告', warning)
    }
    const missingById = new Map(config.missing.map((item) => [item.id, item.names]))
    for (const entry of config.plugins) {
      this.plugins.set(entry.id, this.createEntry(entry, missingById.get(entry.id) ?? []))
    }
    for (const state of this.plugins.values()) {
      this.inspectManifest(state)
    }
    this.resolveCapabilities()
    this.resolveRootPaths()
    return this.list()
  }

  /**
   * 重新读取 plugins.json 与 secrets 文件，按 id 增量应用变化。
   *
   * - 运行中的插件配置变化：先 plugin/configure 热更新，入口/启动参数变化或热更新失败时重启子进程；
   * - 之前因缺 secret 没起来、现在补齐了：自动启动；
   * - 配置文件解析失败（权限不对、半截 JSON、version 缺失）：保留旧配置，只写审计告警。
   *
   * 手动 POST /api/plugins/reload 与调用方都走这里；并发调用复用同一个 promise。
   */
  async reloadConfig({ reason = 'manual' } = {}) {
    if (this.stopping) {
      return { ok: false, reason, error: '插件运行时正在停止', changed: [] }
    }
    if (this.reloading) return this.reloading
    this.reloading = this.applyReload(reason).finally(() => {
      this.reloading = null
    })
    return this.reloading
  }

  async applyReload(reason) {
    const result = {
      ok: true,
      reason,
      at: this.now(),
      secretsFile: null,
      warnings: [],
      changed: [],
      restarted: [],
      started: [],
      stopped: [],
      added: [],
      removed: [],
      failed: [],
    }
    let config
    try {
      config = loadPluginConfigFile(this.configFile, { env: this.env })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.logger.warn?.('插件配置重载失败，保留旧配置', error)
      for (const state of this.plugins.values()) {
        this.audit(state, 'config', { ok: false, reason, error: message })
      }
      return { ...result, ok: false, error: message }
    }
    result.secretsFile = config.secretsFile ?? null
    result.warnings = config.warnings.map((warning) => ({ ...warning }))
    for (const warning of config.warnings) {
      this.logger.warn?.('插件配置警告', warning)
    }

    const missingById = new Map(config.missing.map((item) => [item.id, item.names]))
    const nextIds = new Set(config.plugins.map((entry) => entry.id))

    // 1) 配置里已删除的插件：停进程、注销 capability、删状态。
    for (const id of [...this.plugins.keys()]) {
      if (nextIds.has(id)) continue
      const state = this.plugins.get(id)
      await this.stopForReload(state, `removed:${reason}`)
      this.plugins.delete(id)
      result.removed.push(id)
    }

    // 2) 新增 / 就地更新。不重建 entry，保留进程句柄、日志环与重启计数。
    const touched = []
    for (const entry of config.plugins) {
      const missingSecrets = missingById.get(entry.id) ?? []
      const state = this.plugins.get(entry.id)
      if (!state) {
        const created = this.createEntry(entry, missingSecrets)
        this.plugins.set(entry.id, created)
        this.inspectManifest(created)
        result.added.push(entry.id)
        touched.push({
          state: created,
          previous: null,
          entryChanged: true,
          configChanged: false,
          spawnChanged: false,
        })
        continue
      }

      const nextModulePath = this.resolveModule(entry)
      const previous = {
        config: configSignature(state.config),
        modulePath: state.modulePath,
        command: state.command,
        args: configSignature(state.args),
        missing: state.missingSecrets.join(','),
        configEnabled: state.configEnabled,
        manualStopped: state.manualStopped,
      }
      const configChanged = previous.config !== configSignature(entry.config)
      const spawnChanged =
        previous.modulePath !== nextModulePath ||
        previous.command !== entry.command ||
        previous.args !== configSignature(entry.args)

      state.modulePath = nextModulePath
      state.command = entry.command
      state.args = entry.args
      state.pinnedVersion = entry.version
      state.sort = entry.sort ?? null
      state.config = entry.config
      state.configSource = entry.configSource ?? 'none'
      state.missingSecrets = missingSecrets
      state.configEnabled = entry.enabled
      this.inspectManifest(state)

      if (configChanged || spawnChanged) result.changed.push(entry.id)
      touched.push({
        state,
        previous,
        entryChanged: configChanged || spawnChanged,
        configChanged,
        spawnChanged,
      })
    }

    // 3) 重算索引前先清 blocked：否则旧冲突会把插件永久锁死。
    for (const state of this.plugins.values()) state.blocked = false
    this.resolveCapabilities()
    this.resolveRootPaths()

    // 4) 逐个应用：blocked / 不兼容 / 缺配置 / 开关变化 / 配置变化。
    for (const { state, previous, entryChanged, configChanged, spawnChanged } of touched) {
      const id = state.id
      const running = state.status === 'running' || state.status === 'starting'

      if (state.blocked) {
        if (running) {
          await this.stopForReload(state, `blocked:${reason}`)
          state.status = 'error'
          result.stopped.push(id)
        }
        continue
      }

      if (!state.compatible) {
        if (running) {
          await this.stopForReload(state, `incompatible:${reason}`)
          result.stopped.push(id)
        }
        continue
      }

      if (state.missingSecrets.length && !state.allowMissingSecrets) {
        if (running) {
          await this.stopForReload(state, `missing-secret:${reason}`)
          result.stopped.push(id)
        }
        state.status = 'missing-secret'
        state.lastError = `缺少配置项: ${state.missingSecrets.join(', ')}`
        continue
      }
      if (state.missingSecrets.length) {
        state.lastWarning = `缺少配置项: ${state.missingSecrets.join(', ')}（已按空值启动）`
        this.audit(state, 'warn', { warning: state.lastWarning })
      }

      const enabledChanged = previous ? previous.configEnabled !== state.configEnabled : false
      if (enabledChanged && !state.configEnabled) {
        if (running) {
          await this.stopForReload(state, `disabled:${reason}`)
          result.stopped.push(id)
        }
        state.enabled = false
        state.manualStopped = true
        state.status = 'stopped'
        continue
      }
      if (enabledChanged) {
        state.enabled = true
        state.manualStopped = false
      }

      if (running && entryChanged) {
        // 入口或启动参数变了，热更新没意义，直接重启。
        if (configChanged && !spawnChanged) await this.configureState(state)
        await this.restartState(state, reason)
        result.restarted.push(id)
        if (state.status !== 'running') {
          result.failed.push({ id, error: state.lastError || '重启失败' })
        }
        continue
      }

      const missingChanged = previous ? previous.missing !== state.missingSecrets.join(',') : false
      if (!running && state.enabled && !state.manualStopped && (entryChanged || missingChanged)) {
        try {
          await this.startPlugin(id)
          result.started.push(id)
        } catch (error) {
          result.failed.push({
            id,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
    }

    this.logger.info?.('插件配置已重载', {
      reason,
      changed: result.changed.length,
      restarted: result.restarted.length,
    })
    return result
  }

  /** 尝试把新配置推给运行中的插件；失败不抛错，交给调用方重启。 */
  async configureState(state) {
    if (!state.process || state.status !== 'running') return false
    try {
      await state.process.request(
        'plugin/configure',
        { config: state.config },
        this.timeoutFor('plugin/configure'),
      )
      return true
    } catch (error) {
      this.writeLog(state, 'warn', '配置热更新失败，改为重启进程', {
        error: error instanceof Error ? error.message : String(error),
      })
      return false
    }
  }

  /**
   * 停止插件但保留用户意图（enabled / manualStopped），供 reload 复用。
   * 必须先置 manualStopped，否则 shutdown 期间的 exit 会被 handleExit 当成崩溃并触发自动重启。
   */
  async stopForReload(state, reason) {
    const wasEnabled = state.enabled
    const wasManualStopped = state.manualStopped
    state.manualStopped = true
    clearTimeout(state.restartTimer)
    state.restartTimer = null
    await this.shutdownState(state)
    this.publishCapabilityState(state, 'unavailable')
    const interrupted = this.store.failActiveRuns(state.id, '插件配置已更新，run 已中断')
    state.status = 'stopped'
    state.enabled = wasEnabled
    state.manualStopped = wasManualStopped
    this.audit(state, 'config', { reason, interruptedRuns: interrupted ?? 0 })
    return interrupted ?? 0
  }

  async restartState(state, reason) {
    await this.stopForReload(state, reason)
    // reload 触发的重启不计入崩溃重启计数，否则改几次配置就会被自动禁用。
    state.restarts = 0
    state.healthFailures = 0
    await this.spawnPlugin(state)
    return this.describe(state)
  }

  createEntry(entry, missingSecrets) {
    const state = {
      id: entry.id,
      modulePath: this.resolveModule(entry),
      enabled: entry.enabled,
      sort: entry.sort ?? null,
      config: entry.config,
      command: entry.command,
      args: entry.args,
      pinnedVersion: entry.version,
      missingSecrets,
      allowMissingSecrets: entry.allowMissingSecrets === true,
      lastWarning: null,
      configSource: entry.configSource ?? 'none',
      // 配置文件里的 enabled 原值：reload 时用它判断用户是否改了开关，
      // 而 state.enabled 会被手动启停改写，不能直接对比。
      configEnabled: entry.enabled,
      manifest: null,
      compatible: false,
      reason: null,
      status: entry.enabled ? 'stopped' : 'disabled',
      pid: null,
      restarts: 0,
      lastError: null,
      droppedEvents: 0,
      process: null,
      queue: [],
      inflight: new Map(),
      timers: new Map(),
      healthFailures: 0,
      blocked: false,
      restartTimestamps: [],
      restartTimer: null,
      manualStopped: !entry.enabled,
      startedAt: null,
      configInvalid: null,
    }
    state.logRing = createLogRing()
    state.logFile = path.join(this.logDir, `${entry.id}.log`)
    return state
  }

  timeoutFor(method) {
    return this.timeoutOverrides[method] ?? HOST_TO_PLUGIN_TIMEOUTS[method]
  }

  /**
   * 解析插件入口：绝对路径原样使用；相对路径先找 `<pluginsDir>/<id>/`（用户目录优先），
   * 再回退到安装目录 `appDir`。
   *
   * 约定 `module` 写成 `./plugins/<id>/index.js` 时，用户在
   * `<pluginsDir>/<id>/index.js` 放一份同名入口即可覆盖安装目录里的实现。
   */
  resolveModule(entry) {
    const value = entry.module || `./plugins/${entry.id}/index.js`
    if (path.isAbsolute(value)) return value
    const normalized = String(value).replaceAll('\\', '/').replace(/^\.\//, '')
    const conventional = `plugins/${entry.id}/`
    const relative = normalized.startsWith(conventional)
      ? normalized.slice(conventional.length)
      : normalized
    const userModule = path.resolve(this.pluginsDir, entry.id, relative)
    const insideUserDir = path.relative(path.resolve(this.pluginsDir, entry.id), userModule)
    if (!insideUserDir.startsWith('..') && !path.isAbsolute(insideUserDir)) {
      // 宿主把 plugin.json 当作加载依据：用户目录只有入口、没有 manifest 时回退安装目录，
      // 避免一个残留的 index.js 把本来正常的插件变成 incompatible。
      const manifestFile = path.join(path.dirname(userModule), 'plugin.json')
      if (fs.existsSync(userModule) && fs.existsSync(manifestFile)) return userModule
    }
    return path.resolve(this.appDir, value)
  }

  inspectManifest(state) {
    const manifestFile = path.join(path.dirname(state.modulePath), 'plugin.json')
    let raw = null
    try {
      raw = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
    } catch {
      state.compatible = false
      state.reason = 'invalid-manifest'
      state.manifest = null
      state.status = state.enabled ? 'incompatible' : 'disabled'
      return state
    }
    const validated = validateManifest(raw, {
      configId: state.id,
      hostVersion: this.hostVersion,
      hostApiVersion: HOST_API_VERSION,
      pinnedVersion: state.pinnedVersion,
    })
    if (!validated.ok) {
      state.compatible = false
      state.reason = validated.reason
      state.manifest = raw
      state.lastError = manifestFailureMessage(validated.reason, {
        manifest: raw,
        hostVersion: this.hostVersion,
      })
      if (state.enabled) {
        state.status = 'incompatible'
        this.audit(state, 'incompatible', { reason: validated.reason })
      }
      return state
    }
    state.manifest = validated.manifest
    state.compatible = true
    state.reason = null
    if (validated.manifest.allowMissingSecrets) state.allowMissingSecrets = true
    return state
  }

  resolveRootPaths() {
    this.rootPaths.clear()
    for (const state of this.plugins.values()) {
      if (!state.manifest) continue
      if (!state.manifest.permissions.includes('http:root')) continue
      for (const rootPath of state.manifest.http.rootPaths) {
        if (
          RESERVED_ROOT_PATHS.has(rootPath) ||
          RESERVED_ROOT_PREFIXES.some(
            (prefix) => rootPath === prefix || rootPath.startsWith(`${prefix}/`),
          )
        ) {
          state.status = state.enabled ? 'error' : state.status
          state.lastError = `根路径与核心路由冲突: ${rootPath}`
          state.blocked = true
          this.audit(state, 'http', { error: state.lastError, rootPath })
          continue
        }
        const existing = this.rootPaths.get(rootPath)
        if (existing) {
          state.status = state.enabled ? 'error' : state.status
          state.lastError = `根路径冲突: ${rootPath} 已被 ${existing} 占用`
          state.blocked = true
          this.audit(state, 'http', { error: state.lastError, rootPath })
          continue
        }
        this.rootPaths.set(rootPath, state.id)
      }
    }
  }

  resolveCapabilities() {
    this.capabilities.clear()
    const coreNames = new Set(this.coreCapabilities.definitions().map((item) => item.name))
    for (const state of this.plugins.values()) {
      if (!state.compatible || !state.manifest?.provides?.length) continue
      const coreConflict = state.manifest.provides.find((capability) =>
        coreNames.has(capability.name),
      )
      if (coreConflict) {
        state.blocked = true
        state.status = state.enabled ? 'error' : state.status
        state.lastError = `capability 由宿主提供，插件不可覆盖: ${coreConflict.name}`
        this.audit(state, 'capability', { error: state.lastError })
        continue
      }
      for (const capability of state.manifest.provides) {
        const owner = this.capabilities.get(capability.name)
        if (owner && owner !== state.id) {
          state.blocked = true
          state.status = state.enabled ? 'error' : state.status
          state.lastError = `capability 已被 ${owner} 占用: ${capability.name}`
          this.audit(state, 'capability', { error: state.lastError })
          break
        }
        this.capabilities.set(capability.name, state.id)
      }
    }
  }

  orderedStates() {
    const ordered = []
    const visited = new Set()
    const visiting = new Set()
    const visit = (state) => {
      if (!state || visited.has(state.id)) return
      if (!state.enabled || state.manualStopped || !state.compatible || state.blocked) return
      if (visiting.has(state.id)) {
        state.blocked = true
        state.lastError = 'capability 依赖存在循环'
        this.audit(state, 'capability', { error: state.lastError })
        return
      }
      visiting.add(state.id)
      for (const requirement of state.manifest.requires ?? []) {
        const ownerId = this.capabilities.get(requirement.name)
        if (ownerId && ownerId !== state.id) visit(this.plugins.get(ownerId))
      }
      visiting.delete(state.id)
      visited.add(state.id)
      ordered.push(state)
    }
    for (const state of this.plugins.values()) visit(state)
    return ordered
  }

  publishCapabilityState(state, kind) {
    for (const capability of state.manifest?.provides ?? []) {
      this.publish(
        `capability.${kind}`,
        {
          name: capability.name,
          version: capability.version,
          provider: state.id,
          occurredAt: this.now(),
        },
        { source: 'core', isPublic: false },
      )
    }
  }

  async start() {
    const started = []
    for (const state of this.orderedStates()) {
      if (!state.enabled || state.manualStopped) continue
      if (!state.compatible || state.blocked) continue
      if (state.missingSecrets.length && !state.allowMissingSecrets) {
        state.status = 'missing-secret'
        state.lastError = `缺少配置项: ${state.missingSecrets.join(', ')}`
        this.audit(state, 'error', { error: state.lastError })
        continue
      }
      if (state.missingSecrets.length) {
        state.lastWarning = `缺少配置项: ${state.missingSecrets.join(', ')}（已按空值启动）`
        this.audit(state, 'warn', { warning: state.lastWarning })
        this.writeLog(state, 'warn', state.lastWarning)
      }
      if (!fs.existsSync(state.modulePath)) {
        state.status = 'error'
        state.lastError = `插件入口不存在: ${state.modulePath}`
        this.audit(state, 'error', { error: state.lastError })
        continue
      }
      started.push(await this.startPlugin(state.id))
    }
    this.startHealthChecks()
    return started
  }

  startHealthChecks() {
    if (this.healthTimer || !this.healthIntervalMs) return
    this.healthTimer = setInterval(() => {
      this.checkHealth().catch((error) => {
        this.logger.error?.('插件健康检查失败', error)
      })
    }, this.healthIntervalMs)
    this.healthTimer.unref?.()
  }

  async checkHealth() {
    for (const state of this.plugins.values()) {
      if (state.status !== 'running' || !state.process) continue
      try {
        await state.process.request('plugin/status', {}, this.timeoutFor('plugin/status'))
        state.healthFailures = 0
      } catch (error) {
        state.healthFailures += 1
        state.lastError = error.message
        this.audit(state, 'health', { failures: state.healthFailures, error: error.message })
        if (state.healthFailures >= 3) {
          state.healthFailures = 0
          this.scheduleRestart(state, '健康检查连续失败')
        }
      }
    }
  }

  async startPlugin(id) {
    const state = this.plugins.get(id)
    if (!state) throw new Error(`未知插件: ${id}`)
    if (state.blocked) {
      throw new Error(state.lastError || '插件配置无效')
    }
    if (!state.compatible) {
      throw new Error(
        state.lastError ||
          manifestFailureMessage(state.reason, {
            manifest: state.manifest,
            hostVersion: this.hostVersion,
          }),
      )
    }
    if (state.status === 'running') return this.describe(state)
    state.manualStopped = false
    state.enabled = true
    state.restartTimestamps = []
    state.lastError = null
    await this.spawnPlugin(state)
    return this.describe(state)
  }

  async spawnPlugin(state) {
    clearTimeout(state.restartTimer)
    state.restartTimer = null
    state.status = 'starting'
    state.lastError = null
    const command = state.command ? state.command : process.execPath
    const args = state.args ? state.args : [state.modulePath]
    const env = {
      ...minimalEnvironment(),
      TRELLIS_PLUGIN_CHILD: '1',
      TRELLIS_PLUGIN_ID: state.id,
      TRELLIS_HOST_VERSION: this.hostVersion,
      ...(state.config.env ?? {}),
    }
    const child = new PluginProcess(this, state, {
      command,
      args,
      cwd: path.dirname(state.modulePath),
      env,
    })
    state.process = child
    state.pid = null
    this.writeLog(state, 'info', '启动插件进程', {
      command,
      args,
      version: state.manifest?.version,
    })
    child.start()
    state.pid = child.child?.pid ?? null

    try {
      const handshake = await child.request(
        'initialize',
        {
          apiVersion: HOST_API_VERSION,
          hostVersion: this.hostVersion,
          pluginId: state.id,
          config: state.config,
          permissions: state.manifest.permissions,
          dataDir: this.dataDir,
          repositories: this.repositories.map((repository) => ({
            id: repository.id,
            name: repository.name,
            path: repository.path,
          })),
        },
        this.timeoutFor('initialize'),
      )
      this.verifyHandshake(state, handshake)
    } catch (error) {
      state.status = 'error'
      state.lastError = error.message
      child.kill()
      state.process = null
      state.pid = null
      this.audit(state, 'error', { error: error.message, phase: 'handshake' })
      this.writeLog(state, 'error', '握手失败', { error: error.message })
      if (
        error.code === ERROR_CODES.API_VERSION_MISMATCH ||
        error.code === ERROR_CODES.VERSION_MISMATCH
      ) {
        state.status = 'incompatible'
        state.compatible = false
        state.reason = String(error.code)
        state.manualStopped = true
      }
      return state
    }

    state.status = 'running'
    state.startedAt = this.now()
    state.healthFailures = 0
    const previous = this.store.getManifest(state.id)
    this.store.setManifest(state.id, {
      id: state.id,
      version: state.manifest.version,
      apiVersion: state.manifest.apiVersion,
      loadedAt: this.now(),
    })
    this.audit(state, 'loaded', {
      version: state.manifest.version,
      apiVersion: state.manifest.apiVersion,
    })
    this.audit(state, 'started', { pid: state.pid })
    if (previous && previous.version !== state.manifest.version) {
      const kind =
        compareVersions(state.manifest.version, previous.version) < 0 ? 'downgraded' : 'upgraded'
      this.audit(state, kind, { from: previous.version, to: state.manifest.version })
      if (kind === 'downgraded') {
        this.writeLog(state, 'warn', '插件版本降级', {
          from: previous.version,
          to: state.manifest.version,
        })
      }
    }
    child.notify('plugin/started', {
      apiVersion: HOST_API_VERSION,
      hostVersion: this.hostVersion,
    })
    this.publishCapabilityState(state, 'available')
    this.flushQueue(state)
    return state
  }

  verifyHandshake(state, handshake) {
    if (!handshake || typeof handshake !== 'object') {
      throw new RpcError(ERROR_CODES.VERSION_MISMATCH, '插件握手没有返回清单信息')
    }
    if (handshake.apiVersion !== HOST_API_VERSION) {
      throw new RpcError(ERROR_CODES.API_VERSION_MISMATCH, '插件协议版本与宿主不兼容')
    }
    if (handshake.id !== state.id) {
      throw new RpcError(ERROR_CODES.VERSION_MISMATCH, '插件握手 id 与清单不一致')
    }
    if (!isValidSemver(handshake.version) || handshake.version !== state.manifest.version) {
      throw new RpcError(ERROR_CODES.VERSION_MISMATCH, '插件握手版本与清单不一致')
    }
    const registered = Array.isArray(handshake.provides) ? handshake.provides : []
    for (const capability of state.manifest.provides ?? []) {
      const actual = registered.find((item) => item?.name === capability.name)
      if (!actual) {
        throw new RpcError(
          ERROR_CODES.VERSION_MISMATCH,
          `插件未注册清单声明的 capability: ${capability.name}`,
        )
      }
      const methods = new Set(Array.isArray(actual.methods) ? actual.methods : [])
      for (const method of Object.keys(capability.methods)) {
        if (!methods.has(method)) {
          throw new RpcError(
            ERROR_CODES.VERSION_MISMATCH,
            `插件未注册 capability 方法: ${capability.name}.${method}`,
          )
        }
      }
    }
  }

  async callCapability(state, params) {
    const name = String(params?.name ?? '').trim()
    const method = String(params?.method ?? '').trim()
    if (!name || !method) throw invalidParams('capability/call 缺少 name 或 method')
    const requirement = (state.manifest.requires ?? []).find((item) => item.name === name)
    if (!requirement) {
      throw appError(ERROR_CODES.PERMISSION_DENIED, `插件未声明 capability 依赖: ${name}`)
    }
    if (!requirement.methods.includes(method)) {
      throw appError(ERROR_CODES.PERMISSION_DENIED, `插件未声明 capability 方法: ${name}.${method}`)
    }
    return this.dispatchCapability(state, name, method, params.params, requirement)
  }

  capabilityCatalog() {
    const entries = []
    for (const definition of this.coreCapabilities.definitions()) {
      entries.push({
        name: definition.name,
        version: definition.version,
        description: definition.description ?? '',
        provider: 'core',
        available: true,
        methods: Object.entries(definition.methods).map(([method, meta]) => ({
          name: method,
          access: meta.access ?? 'read',
          timeoutMs: meta.timeoutMs ?? 30_000,
        })),
      })
    }
    for (const [name, providerId] of this.capabilities.entries()) {
      const provider = this.plugins.get(providerId)
      const capability = (provider?.manifest?.provides ?? []).find((item) => item.name === name)
      if (!capability) continue
      entries.push({
        name,
        version: capability.version,
        description: capability.description ?? '',
        provider: providerId,
        available: provider.status === 'running',
        methods: Object.entries(capability.methods).map(([method, meta]) => ({
          name: method,
          access: meta.access ?? 'read',
          timeoutMs: meta.timeoutMs ?? 30_000,
        })),
      })
    }
    return entries.sort((left, right) => left.name.localeCompare(right.name))
  }

  async invokeBrokeredCapability({ state, name, method, params, timeoutMs }) {
    if (name === 'trellis.capabilities' && method === 'call') {
      throw invalidParams('不能通过能力代理递归调用 trellis.capabilities.call')
    }
    return this.dispatchCapability(
      state,
      name,
      method,
      params,
      { version: '*', methods: [method] },
      timeoutMs,
    )
  }

  async dispatchCapability(state, name, method, params, requirement, timeoutMs) {
    const coreDefinition = this.coreCapabilities.definition(name)
    if (coreDefinition) {
      const range = satisfiesRange(requirement.version, coreDefinition.version)
      if (!range.ok) {
        throw appError(
          ERROR_CODES.CAPABILITY_UNAVAILABLE,
          `capability 版本不满足: ${name} 需要 ${requirement.version}，宿主提供 ${coreDefinition.version}`,
        )
      }
      const started = Date.now()
      try {
        const value = await this.coreCapabilities.call(state, name, method, params)
        this.audit(state, 'capability.call', {
          name,
          method,
          provider: 'core',
          durationMs: Date.now() - started,
          ok: true,
        })
        return { value: value ?? null }
      } catch (error) {
        this.audit(state, 'capability.call', {
          name,
          method,
          provider: 'core',
          durationMs: Date.now() - started,
          ok: false,
          code: error?.code ?? null,
        })
        if (error instanceof RpcError) throw error
        throw appError(
          ERROR_CODES.CAPABILITY_UNAVAILABLE,
          `capability 调用失败: ${error?.message || error}`,
        )
      }
    }
    const providerId = this.capabilities.get(name)
    if (!providerId) {
      throw appError(ERROR_CODES.CAPABILITY_UNAVAILABLE, `capability 不可用: ${name}`)
    }
    const provider = this.plugins.get(providerId)
    if (!provider || provider.status !== 'running' || !provider.process) {
      throw appError(ERROR_CODES.CAPABILITY_UNAVAILABLE, `capability 提供者未运行: ${providerId}`)
    }
    const capability = (provider.manifest.provides ?? []).find((item) => item.name === name)
    const definition = capability?.methods?.[method]
    if (!definition) {
      throw appError(
        ERROR_CODES.CAPABILITY_METHOD_DENIED,
        `capability 未提供方法: ${name}.${method}`,
      )
    }
    const range = satisfiesRange(requirement.version, capability.version)
    if (!range.ok) {
      throw appError(
        ERROR_CODES.CAPABILITY_UNAVAILABLE,
        `capability 版本不满足: ${name} 需要 ${requirement.version}，提供者 ${capability.version}`,
      )
    }
    const started = Date.now()
    try {
      const result = await provider.process.request(
        'capability/call',
        {
          name,
          method,
          params: params ?? null,
          caller: { pluginId: state.id },
        },
        Number.isInteger(timeoutMs) ? timeoutMs : definition.timeoutMs,
      )
      this.audit(state, 'capability.call', {
        name,
        method,
        provider: providerId,
        durationMs: Date.now() - started,
        ok: true,
      })
      return { value: result?.value ?? null }
    } catch (error) {
      this.audit(state, 'capability.call', {
        name,
        method,
        provider: providerId,
        durationMs: Date.now() - started,
        ok: false,
        code: error?.code ?? null,
      })
      if (error instanceof RpcError) throw error
      throw appError(
        ERROR_CODES.CAPABILITY_UNAVAILABLE,
        `capability 调用失败: ${error?.message || error}`,
      )
    }
  }

  async stopPlugin(id) {
    const state = this.plugins.get(id)
    if (!state) throw new Error(`未知插件: ${id}`)
    state.manualStopped = true
    state.enabled = false
    clearTimeout(state.restartTimer)
    state.restartTimer = null
    await this.shutdownState(state)
    this.publishCapabilityState(state, 'unavailable')
    const interrupted = this.store.failActiveRuns(state.id, '插件已停止，run 已中断')
    state.status = 'stopped'
    this.audit(state, 'stopped', interrupted ? { interruptedRuns: interrupted } : {})
    return this.describe(state)
  }

  async shutdownState(state) {
    for (const timer of state.timers.values()) clearInterval(timer)
    state.timers.clear()
    for (const inflight of state.inflight.values()) clearTimeout(inflight.timer)
    state.inflight.clear()
    const child = state.process
    state.process = null
    state.pid = null
    if (child) {
      child.stopping = true
      await child.stop(3_000)
    }
  }

  async stop() {
    this.stopping = true
    if (this.healthTimer) clearInterval(this.healthTimer)
    this.healthTimer = null
    for (const state of this.plugins.values()) {
      clearTimeout(state.restartTimer)
      state.restartTimer = null
      await this.shutdownState(state)
      if (state.status === 'running' || state.status === 'starting') {
        state.status = 'stopped'
        this.audit(state, 'stopped', {})
      }
    }
  }

  handleExit(state, { code, signal }) {
    if (state.process && state.process.exited) {
      // 只处理当前进程的退出，旧进程退出不覆盖新状态。
    }
    if (state.stopping || this.stopping || state.manualStopped) return
    const wasRunning = state.status === 'running' || state.status === 'starting'
    state.process = null
    state.pid = null
    if (!wasRunning) return
    this.publishCapabilityState(state, 'unavailable')
    state.status = 'error'
    state.lastError = `插件进程退出（code=${code}, signal=${signal ?? '-'}）`
    this.store.failActiveRuns(state.id, state.lastError)
    this.audit(state, 'crashed', { code, signal })
    this.writeLog(state, 'error', '插件进程退出', { code, signal })
    this.scheduleRestart(state, state.lastError)
  }

  scheduleRestart(state, reason) {
    if (this.stopping || state.manualStopped) return
    const at = Date.now()
    state.restartTimestamps = state.restartTimestamps.filter(
      (timestamp) => at - timestamp < this.autoDisableWindowMs,
    )
    if (state.restartTimestamps.length + 1 >= this.autoDisableLimit) {
      state.status = 'disabled'
      state.manualStopped = true
      state.lastError = `10 分钟内重启 ${state.restartTimestamps.length + 1} 次，已自动禁用`
      this.audit(state, 'disabled', { reason: state.lastError })
      this.writeLog(state, 'error', '插件自动禁用', { reason })
      return
    }
    state.restartTimestamps.push(at)
    const index = Math.min(state.restarts, this.restartDelaysMs.length - 1)
    const delay = Math.min(this.restartDelaysMs[index] ?? MAX_RESTART_DELAY, MAX_RESTART_DELAY)
    state.restarts += 1
    state.status = 'starting'
    this.writeLog(state, 'warn', '安排重启', { delayMs: delay, reason })
    state.restartTimer = setTimeout(() => {
      state.restartTimer = null
      if (state.manualStopped || this.stopping) return
      this.spawnPlugin(state).catch((error) => {
        state.status = 'error'
        state.lastError = error.message
        this.scheduleRestart(state, error.message)
      })
    }, delay)
    state.restartTimer.unref?.()
  }

  async handlePluginRequest(state, message) {
    const method = message.method
    if (!Object.hasOwn(PERMISSION_BY_METHOD, method) && !ALWAYS_ALLOWED_METHODS.includes(method)) {
      throw methodNotFound(method)
    }
    const permission = PERMISSION_BY_METHOD[method]
    if (permission && !state.manifest.permissions.includes(permission)) {
      this.audit(state, 'permission_denied', { method, permission })
      throw appError(ERROR_CODES.PERMISSION_DENIED, `插件未声明权限 ${permission}`)
    }
    const params = message.params ?? {}
    switch (method) {
      case 'task/get':
        return this.tasks.get(params)
      case 'task/list':
        return this.tasks.list(params)
      case 'task/create': {
        const task = await this.tasks.create(params)
        this.publish('task.created', {
          taskKey: task.taskKey,
          projectId: task.projectId,
          repoPath: task.projectPath,
          title: task.title,
          assignee: task.assignee,
          priority: task.priority,
          occurredAt: this.now(),
        })
        return task
      }
      case 'task/assign': {
        const task = await this.tasks.assign(params)
        this.publish('task.assigned', {
          taskKey: task.taskKey,
          projectId: task.projectId,
          repoPath: task.projectPath,
          title: task.title,
          assignee: task.assignee,
          previousAssignee: task.previousAssignee ?? null,
          priority: task.priority,
          occurredAt: this.now(),
        })
        return task
      }
      case 'task/setStage': {
        const stage = this.tasks.setStage(params)
        this.publish('task.stage.changed', {
          taskKey: stage.taskKey,
          stage: stage.stage,
          previousStage: stage.previousStage ?? null,
          occurredAt: this.now(),
        })
        return stage
      }
      case 'task/setPlan': {
        const plan = this.tasks.setPlan(params)
        this.publish('task.plan.changed', {
          taskKey: plan.taskKey,
          dueDate: plan.dueDate,
          occurredAt: this.now(),
        })
        return plan
      }
      case 'run/start': {
        const taskKey = String(params.taskKey ?? '').trim()
        if (!taskKey) throw invalidParams('run/start 缺少 taskKey')
        const started = this.store.startRun({
          pluginId: state.id,
          pluginVersion: state.manifest?.version ?? null,
          taskKey,
          request: params.request ?? null,
          status: 'running',
        })
        if (started.started) {
          this.publish('run.started', {
            runId: started.run.runId,
            pluginId: state.id,
            taskKey,
            occurredAt: this.now(),
          })
        }
        return started
      }
      case 'run/progress':
        return this.handleRunProgress(state, params)
      case 'run/finish':
        return this.handleRunFinish(state, params)
      case 'run/list':
        return {
          runs: this.store.listRuns({
            pluginId: state.id,
            taskKey: params.taskKey ? String(params.taskKey) : null,
            limit: params.limit,
          }),
        }
      case 'capability/call':
        return this.callCapability(state, params)
      case 'event/emit':
        return this.emitPluginEvent(state, params)
      case 'event/publish':
        return this.emitPluginEvent(state, params)
      case 'store/get':
        return {
          value: this.store.getState(state.id, String(params.key ?? '')),
        }
      case 'store/set': {
        const value = this.store.setState(state.id, String(params.key ?? ''), params.value ?? null)
        return { value }
      }
      case 'store/delete':
        return { deleted: this.store.deleteState(state.id, String(params.key ?? '')) }
      case 'store/list':
        return {
          entries: this.store.listState(state.id, String(params.prefix ?? '')),
        }
      case 'secrets/get': {
        const key = this.requirePluginSecretKey(state, params)
        const { refs } = loadSecretsFile(this.secretsFile, { keyFile: this.secretsKeyFile })
        return { key, value: refs.has(key) ? refs.get(key) : null }
      }
      case 'secrets/set': {
        const key = this.requirePluginSecretKey(state, params)
        const value = params.value
        if (typeof value !== 'string' || value === '') {
          throw invalidParams('secrets/set 需要非空字符串 value')
        }
        writeSecretRef(this.secretsFile, key, value, { keyFile: this.secretsKeyFile })
        this.audit(state, 'secrets', { ok: true, action: 'set', key })
        return { key, stored: true, encrypted: true }
      }
      case 'secrets/delete': {
        const key = this.requirePluginSecretKey(state, params)
        const result = deleteSecretRef(this.secretsFile, key)
        this.audit(state, 'secrets', { ok: true, action: 'delete', key, deleted: result.deleted })
        return { key, deleted: result.deleted }
      }
      case 'log/write': {
        const level = String(params.level || 'info')
        this.writeLog(state, level, String(params.message ?? ''), params.fields ?? {})
        return { ok: true }
      }
      case 'schedule/register':
        return this.registerTimer(state, params)
      case 'schedule/unregister':
        return this.unregisterTimer(state, params)
      default:
        throw methodNotFound(method)
    }
  }

  handlePluginNotification(state, message) {
    if (message.method === 'event/ack') {
      const eventId = message.params?.eventId
      const inflight = state.inflight.get(eventId)
      if (inflight) {
        clearTimeout(inflight.timer)
        clearTimeout(inflight.ackTimer)
        state.inflight.delete(eventId)
      }
      return
    }
    if (message.method === 'log/write') {
      const params = message.params ?? {}
      this.writeLog(
        state,
        String(params.level || 'info'),
        String(params.message ?? ''),
        params.fields ?? {},
      )
      return
    }
    if (message.method === 'run/progress') {
      try {
        this.handleRunProgress(state, message.params)
      } catch (error) {
        this.writeLog(state, 'warn', 'run/progress 通知被拒绝', {
          message: error.message,
          code: error.data?.code ?? null,
        })
      }
      return
    }
    this.writeLog(state, 'warn', `未知插件通知: ${message.method}`, {})
  }

  requirePluginSecretKey(state, params) {
    const key = String(params?.key ?? '').trim()
    if (!key) throw invalidParams('缺少 secret key')
    if (!key.startsWith(`${state.id}/`)) {
      throw appError(ERROR_CODES.PERMISSION_DENIED, `插件只能访问自己的 secret：${state.id}/...`)
    }
    return key
  }

  requireRun(state, runId) {
    const run = this.store.getRun(String(runId))
    if (!run) throw appError(ERROR_CODES.NOT_FOUND, `run 不存在: ${runId}`)
    if (run.pluginId !== state.id) {
      throw appError(ERROR_CODES.PERMISSION_DENIED, '不能更新其它插件的 run')
    }
    return run
  }

  handleRunProgress(state, params) {
    const runId = params?.runId
    if (!runId) throw invalidParams('run/progress 缺少 runId')
    this.requireRun(state, runId)
    const patch = {}
    if (params.status) patch.status = String(params.status)
    if (params.result !== undefined) patch.result = params.result
    if (params.finishedAt !== undefined) patch.finishedAt = params.finishedAt
    const run = this.store.updateRun(String(runId), patch)
    return { run }
  }

  handleRunFinish(state, params) {
    const runId = params?.runId
    if (!runId) throw invalidParams('run/finish 缺少 runId')
    this.requireRun(state, runId)
    const status = String(params.status ?? 'succeeded')
    if (['queued', 'starting', 'running'].includes(status)) {
      throw invalidParams(`run/finish 不接受活动状态: ${status}`)
    }
    const run = this.store.finishRun(String(runId), {
      status,
      result: params.result ?? null,
    })
    this.publish('run.finished', {
      runId: run.runId,
      pluginId: run.pluginId,
      taskKey: run.taskKey,
      status: run.status,
      occurredAt: this.now(),
    })
    return { run }
  }

  registerTimer(state, params) {
    const timerId = String(params?.timerId ?? '').trim()
    const intervalMs = Number(params?.intervalMs)
    if (!timerId) throw invalidParams('schedule/register 缺少 timerId')
    if (!Number.isFinite(intervalMs) || intervalMs < 1000) {
      throw appError(ERROR_CODES.RATE_LIMITED, '定时器最小间隔为 1000ms')
    }
    this.unregisterTimer(state, { timerId })
    const timer = setInterval(() => {
      if (state.status !== 'running' || !state.process) return
      state.process
        .request('timer/fire', { timerId }, HOST_TO_PLUGIN_TIMEOUTS['timer/fire'])
        .catch((error) => {
          this.recordError(state, error.message)
        })
    }, intervalMs)
    timer.unref?.()
    state.timers.set(timerId, timer)
    return { timerId, intervalMs }
  }

  unregisterTimer(state, params) {
    const timerId = String(params?.timerId ?? '').trim()
    const timer = state.timers.get(timerId)
    if (timer) clearInterval(timer)
    state.timers.delete(timerId)
    return { timerId, unregistered: Boolean(timer) }
  }

  emitPluginEvent(state, params) {
    const rawName = String(params?.name ?? '').trim()
    if (!rawName) throw invalidParams('event/emit 缺少 name')
    const name = rawName.startsWith(`${state.id}/`) ? rawName : `${state.id}/${rawName}`
    this.publish(name, params?.payload ?? {}, {
      source: state.id,
      isPublic: params?.public === true,
    })
    return { name }
  }

  onEvent(listener) {
    if (typeof listener !== 'function') return () => {}
    this.eventSubscribers.add(listener)
    return () => this.eventSubscribers.delete(listener)
  }

  publish(name, payload, { source = 'core', isPublic = source === 'core' } = {}) {
    const event = {
      eventId: ++this.eventSequence,
      name,
      payload,
      occurredAt: this.now(),
      source,
      public: isPublic,
    }
    this.eventRing.push(event)
    if (this.eventRing.length > EVENT_RING_LIMIT) {
      this.eventRing.splice(0, this.eventRing.length - EVENT_RING_LIMIT)
    }
    for (const state of this.plugins.values()) {
      if (state.status !== 'running' || !state.process) {
        if (state.queue.length < EVENT_QUEUE_LIMIT) state.queue.push(event)
        continue
      }
      this.deliverEvent(state, event)
    }
    for (const listener of this.eventSubscribers) {
      try {
        listener(event)
      } catch {
        // 订阅方异常不能影响事件投递。
      }
    }
    return event
  }

  flushQueue(state) {
    const queued = state.queue.splice(0, state.queue.length)
    for (const event of queued) this.deliverEvent(state, event)
  }

  deliverEvent(state, event, attempt = 1) {
    if (state.status !== 'running' || !state.process) {
      if (state.queue.length >= EVENT_QUEUE_LIMIT) {
        state.queue.shift()
        state.droppedEvents += 1
      }
      state.queue.push(event)
      return
    }
    if (state.inflight.has(event.eventId)) return
    const inflight = {
      attempts: attempt,
      timer: null,
      ackTimer: null,
    }
    state.inflight.set(event.eventId, inflight)
    state.process
      .request(
        'event/dispatch',
        {
          eventId: event.eventId,
          name: event.name,
          payload: event.payload,
          occurredAt: event.occurredAt,
        },
        this.timeoutFor('event/dispatch'),
      )
      .then(() => {
        inflight.ackTimer = setTimeout(() => {
          if (!state.inflight.has(event.eventId)) return
          this.retryEvent(state, event, attempt)
        }, this.eventAckTimeoutMs)
        inflight.ackTimer.unref?.()
      })
      .catch(() => {
        this.retryEvent(state, event, attempt)
      })
  }

  retryEvent(state, event, attempt) {
    const inflight = state.inflight.get(event.eventId)
    if (inflight) {
      clearTimeout(inflight.timer)
      clearTimeout(inflight.ackTimer)
      state.inflight.delete(event.eventId)
    }
    if (attempt >= EVENT_MAX_ATTEMPTS) {
      this.audit(state, 'event-dropped', {
        eventId: event.eventId,
        name: event.name,
        attempts: attempt,
      })
      return
    }
    this.deliverEvent(state, event, attempt + 1)
  }

  recordError(state, message) {
    state.lastError = message
    this.writeLog(state, 'error', message, {})
  }

  audit(state, kind, detail) {
    try {
      this.store.audit(state.id, kind, detail, {
        version: state.manifest?.version ?? null,
        at: this.now(),
      })
    } catch (error) {
      this.logger.error?.('写插件审计失败', error)
    }
  }

  writeLog(state, level, message, fields) {
    const entry = {
      at: this.now(),
      level,
      message,
      fields,
    }
    state.logRing.push(entry)
    try {
      fs.mkdirSync(this.logDir, { recursive: true })
      rotateLogFile(state.logFile)
      const prefix = `[${state.id}@${state.manifest?.version ?? '?'}]`
      const tail = Object.keys(fields || {}).length ? ` ${JSON.stringify(fields)}` : ''
      fs.appendFileSync(state.logFile, `${prefix} ${entry.at} ${level} ${message}${tail}\n`)
    } catch {
      // 日志失败不能影响插件运行。
    }
  }

  getLogs(id, tail = 200) {
    const state = this.plugins.get(id)
    if (!state) throw new Error(`未知插件: ${id}`)
    return {
      id,
      logFile: state.logFile,
      entries: state.logRing.list(tail),
    }
  }

  describe(state) {
    const auth = this.store.getState(state.id, 'session')
    const credentials = state.config?.credentials
    const hasCredentials = Boolean(credentials) || state.configSource !== 'none'
    return {
      id: state.id,
      name: state.manifest?.name ?? state.id,
      version: state.manifest?.version ?? null,
      apiVersion: state.manifest?.apiVersion ?? null,
      compatible: state.compatible,
      reason: state.reason,
      enabled: state.enabled && !state.manualStopped,
      sort: state.sort ?? null,
      status: state.status,
      pid: state.pid,
      restarts: state.restarts,
      lastError: state.lastError,
      lastWarning: state.lastWarning,
      missingSecrets: state.missingSecrets,
      droppedEvents: state.droppedEvents,
      permissions: state.manifest?.permissions ?? [],
      panels: state.manifest?.panels ?? [],
      provides: state.manifest?.provides ?? [],
      requires: state.manifest?.requires ?? [],
      capabilityStatus: (state.manifest?.requires ?? []).map((requirement) => {
        const core = this.coreCapabilities.definition(requirement.name)
        if (core) {
          return {
            name: requirement.name,
            version: requirement.version,
            methods: requirement.methods,
            provider: 'core',
            available: true,
          }
        }
        const ownerId = this.capabilities.get(requirement.name) ?? null
        const owner = ownerId ? this.plugins.get(ownerId) : null
        return {
          name: requirement.name,
          version: requirement.version,
          methods: requirement.methods,
          provider: ownerId,
          available: Boolean(owner && owner.status === 'running'),
        }
      }),
      rootPaths: state.manifest?.http?.rootPaths ?? [],
      openPaths: state.manifest?.http?.openPaths ?? [],
      config: redactConfig(state.config),
      credentials: hasCredentials
        ? {
            mode: credentials?.mode ?? (state.config?.token ? 'token' : 'unknown'),
            source: state.configSource ?? 'none',
          }
        : null,
      auth: auth
        ? {
            status: auth.status ?? 'unknown',
            obtainedAt: auth.obtainedAt ?? null,
            expiresAt: auth.expiresAt ?? null,
          }
        : null,
      logFile: state.logFile,
      startedAt: state.startedAt,
    }
  }

  /**
   * 展示顺序：设置过 sort 的按 sort 升序在前，没设置的保持 plugins.json 里的顺序排在后面。
   * 启动顺序由 orderedStates() 按能力依赖决定，两者互不影响。
   */
  sortedStates() {
    return [...this.plugins.values()]
      .map((state, index) => ({ state, index }))
      .sort((left, right) => {
        const a = typeof left.state.sort === 'number' ? left.state.sort : Number.POSITIVE_INFINITY
        const b = typeof right.state.sort === 'number' ? right.state.sort : Number.POSITIVE_INFINITY
        return a - b || left.index - right.index
      })
      .map((entry) => entry.state)
  }

  list() {
    return this.sortedStates().map((state) => this.describe(state))
  }

  /**
   * 按给定 id 顺序重排插件：把 plugins.json 的 plugins 数组也按这个顺序落盘，
   * 并依次写入 sort = 10/20/30…，顺带让面板顺序一致。不重启插件。
   */
  setOrder(ids) {
    if (!Array.isArray(ids) || ids.length === 0) {
      throw new Error('ids 必须是非空数组')
    }
    const ordered = ids.map((id) => String(id).trim())
    if (ordered.some((id) => !id)) throw new Error('ids 里不能有空值')
    if (new Set(ordered).size !== ordered.length) throw new Error('ids 里有重复的插件')
    const unknown = ordered.filter((id) => !this.plugins.has(id))
    if (unknown.length) throw new Error(`未知插件: ${unknown.join(', ')}`)
    const missing = [...this.plugins.keys()].filter((id) => !ordered.includes(id))
    if (missing.length) throw new Error(`顺序里缺少插件: ${missing.join(', ')}`)

    const sorts = new Map(ordered.map((id, index) => [id, (index + 1) * 10]))
    if (fs.existsSync(this.configFile)) {
      let raw
      try {
        raw = JSON.parse(fs.readFileSync(this.configFile, 'utf8'))
      } catch {
        throw new Error('plugins.json 不是合法 JSON')
      }
      if (!raw || typeof raw !== 'object' || !Array.isArray(raw.plugins)) {
        throw new Error('plugins.json 必须包含 plugins 数组')
      }
      const byId = new Map()
      for (const entry of raw.plugins) {
        if (entry && typeof entry === 'object') byId.set(String(entry.id || '').trim(), entry)
      }
      const head = ordered.map((id) => byId.get(id)).filter(Boolean)
      const rest = raw.plugins.filter((entry) => !head.includes(entry))
      for (const entry of head) {
        entry.sort = sorts.get(String(entry.id || '').trim())
      }
      raw.plugins = [...head, ...rest]
      const temp = `${this.configFile}.tmp`
      fs.writeFileSync(temp, `${JSON.stringify(raw, null, 2)}\n`, 'utf8')
      fs.renameSync(temp, this.configFile)
    }
    for (const [id, sort] of sorts) this.plugins.get(id).sort = sort
    this.logger.info?.('插件顺序已更新', { ids: ordered })
    return this.list()
  }

  /**
   * 设置插件级排序（面板顺序用）：写回 plugins.json 并立即生效，不重启插件。
   * sort 为 null 表示清掉该字段，面板回到清单里的 panels[].order。
   */
  setSort(id, sort) {
    const state = this.plugins.get(id)
    if (!state) throw new Error(`未知插件: ${id}`)
    const value = sort === null || sort === undefined ? null : Number(sort)
    if (value !== null && !Number.isFinite(value)) {
      throw new Error('sort 必须是数字，留空表示按清单默认顺序')
    }
    if (fs.existsSync(this.configFile)) {
      let raw
      try {
        raw = JSON.parse(fs.readFileSync(this.configFile, 'utf8'))
      } catch {
        throw new Error('plugins.json 不是合法 JSON')
      }
      if (!raw || typeof raw !== 'object' || !Array.isArray(raw.plugins)) {
        throw new Error('plugins.json 必须包含 plugins 数组')
      }
      const entry = raw.plugins.find((item) => item && String(item.id || '').trim() === id)
      if (!entry) throw new Error(`plugins.json 里没有插件 ${id}`)
      if (value === null) delete entry.sort
      else entry.sort = value
      const temp = `${this.configFile}.tmp`
      fs.writeFileSync(temp, `${JSON.stringify(raw, null, 2)}\n`, 'utf8')
      fs.renameSync(temp, this.configFile)
    }
    state.sort = value
    this.logger.info?.('插件排序已更新', { id, sort: value })
    return this.describe(state)
  }

  findRootPlugin(pathname) {
    const id = this.rootPaths.get(pathname)
    return id ? (this.plugins.get(id) ?? null) : null
  }

  async forwardHttp(
    state,
    { method, path: requestPath, headers = {}, body = '', public: isPublic = false },
  ) {
    if (state.status !== 'running' || !state.process) {
      throw appError(ERROR_CODES.DISABLED, `插件未运行: ${state.id}`)
    }
    if (isPublic) {
      const token = this.publicToken(state)
      if (!token) {
        throw appError(ERROR_CODES.NOT_FOUND, '公开端点未配置 token，未挂载')
      }
      const provided = bearerToken(headers)
      if (!provided) {
        const error = appError(ERROR_CODES.PERMISSION_DENIED, '缺少访问令牌')
        error.httpStatus = 401
        throw error
      }
      if (provided !== token) {
        const error = appError(ERROR_CODES.PERMISSION_DENIED, '公开端点 token 无效')
        error.httpStatus = 403
        throw error
      }
    }
    return state.process.request(
      'http/request',
      {
        method,
        path: requestPath,
        headers,
        body,
      },
      this.timeoutFor('http/request'),
    )
  }

  publicToken(state) {
    const value = state.config?.token
    if (typeof value === 'string' && value.trim()) return value.trim()
    const credentials = state.config?.credentials
    if (credentials && credentials.mode === 'token' && typeof credentials.token === 'string') {
      return credentials.token.trim()
    }
    return null
  }

  status() {
    return {
      enabled: true,
      plugins: this.list(),
      rootPaths: Object.fromEntries(this.rootPaths),
    }
  }
}

function bearerToken(headers) {
  const value = headers.authorization || headers.Authorization || ''
  const match = /^Bearer\s+(.+)$/i.exec(String(value))
  if (match) return match[1].trim()
  return String(headers['x-trellis-token'] || '').trim()
}

function compareVersions(left, right) {
  const a = left.split(/[.-]/).map((part) => (/^\d+$/.test(part) ? Number(part) : part))
  const b = right.split(/[.-]/).map((part) => (/^\d+$/.test(part) ? Number(part) : part))
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const leftPart = a[index]
    const rightPart = b[index]
    if (leftPart === rightPart) continue
    if (leftPart === undefined) return -1
    if (rightPart === undefined) return 1
    if (typeof leftPart === 'number' && typeof rightPart === 'number') {
      return leftPart - rightPart
    }
    return String(leftPart) < String(rightPart) ? -1 : 1
  }
  return 0
}

export { createFrameDecoder, RPC }
