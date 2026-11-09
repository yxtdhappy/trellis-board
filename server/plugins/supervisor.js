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
import { validateManifest, manifestFailureMessage, isValidSemver } from './version.js'
import {
  defaultSecretsFile,
  inlineSecretFields,
  loadSecretsFile,
  resolveConfigReferences,
  summarizeSources,
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

export function loadPluginConfigFile(file, { env = process.env, secretsFile } = {}) {
  if (!fs.existsSync(file)) return { plugins: [], missing: [], warnings: [] }
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    throw new Error('data/plugins.json 不是合法 JSON')
  }
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.plugins)) {
    throw new Error('data/plugins.json 必须包含 plugins 数组')
  }
  const secrets = loadSecretsFile(
    secretsFile || env.TRELLIS_BOARD_SECRETS_FILE || defaultSecretsFile(file),
  )
  const warnings = secrets.warnings.map((warning) => ({ ...warning }))
  const missing = []
  const plugins = raw.plugins.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`data/plugins.json 第 ${index + 1} 项不是对象`)
    }
    const id = String(entry.id || '').trim()
    if (!id) throw new Error(`data/plugins.json 第 ${index + 1} 项缺少 id`)
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
    return {
      id,
      module: String(entry.module || '').trim(),
      enabled: entry.enabled !== false,
      version: entry.version == null ? undefined : String(entry.version),
      command: entry.command ? String(entry.command) : null,
      args: Array.isArray(entry.args) ? entry.args.map(String) : null,
      config: config ?? {},
      configSource: summarizeSources(sources),
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
    if (!exited && this.child) terminateTree(this.child)
    await Promise.race([this.exitPromise, new Promise((resolve) => setTimeout(resolve, graceMs))])
  }

  kill() {
    if (this.child && !this.exited) terminateTree(this.child)
  }
}

export class PluginSupervisor {
  constructor({
    db,
    appDir,
    dataDir,
    hostVersion,
    repositories = [],
    tasks,
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
    this.hostVersion = hostVersion
    this.repositories = repositories
    this.tasks = tasks
    this.store = store
    this.configFile = configFile
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
    this.eventSequence = 0
    this.eventRing = []
    this.rootPaths = new Map()
    this.healthTimer = null
    this.stopping = false
    this.logDir = path.join(dataDir, 'plugins')
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
    this.resolveRootPaths()
    return this.list()
  }

  createEntry(entry, missingSecrets) {
    const state = {
      id: entry.id,
      modulePath: this.resolveModule(entry),
      enabled: entry.enabled,
      config: entry.config,
      command: entry.command,
      args: entry.args,
      pinnedVersion: entry.version,
      missingSecrets,
      configSource: entry.configSource ?? 'none',
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

  resolveModule(entry) {
    const value = entry.module || `./plugins/${entry.id}/index.js`
    return path.isAbsolute(value) ? value : path.resolve(this.appDir, value)
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

  async start() {
    const started = []
    for (const state of this.plugins.values()) {
      if (!state.enabled || state.manualStopped) continue
      if (!state.compatible || state.blocked) continue
      if (state.missingSecrets.length) {
        state.status = 'missing-secret'
        state.lastError = `缺少配置项: ${state.missingSecrets.join(', ')}`
        this.audit(state, 'error', { error: state.lastError })
        continue
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
  }

  async stopPlugin(id) {
    const state = this.plugins.get(id)
    if (!state) throw new Error(`未知插件: ${id}`)
    state.manualStopped = true
    state.enabled = false
    clearTimeout(state.restartTimer)
    state.restartTimer = null
    await this.shutdownState(state)
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
      case 'event/emit':
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
    this.publish(name, params?.payload ?? {}, { source: state.id })
    return { name }
  }

  publish(name, payload, { source = 'core' } = {}) {
    const event = {
      eventId: ++this.eventSequence,
      name,
      payload,
      occurredAt: this.now(),
      source,
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
      status: state.status,
      pid: state.pid,
      restarts: state.restarts,
      lastError: state.lastError,
      droppedEvents: state.droppedEvents,
      permissions: state.manifest?.permissions ?? [],
      rootPaths: state.manifest?.http.rootPaths ?? [],
      openPaths: state.manifest?.http.openPaths ?? [],
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

  list() {
    return [...this.plugins.values()].map((state) => this.describe(state))
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
