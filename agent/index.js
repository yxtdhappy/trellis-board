import path from 'node:path'
import { AgentApiClient, loadCaFile } from './api.js'
import { ConfigStore } from './config-store.js'
import { formatBindingHealth, inspectRepository, syncRepository } from './git-sync.js'
import { SingleInstanceLock } from './lock.js'
import { AgentLogger } from './logger.js'
import { AgentTaskCommandExecutor } from './task-command.js'
import {
  AgentTaskSnapshotSync,
  BRANCH_GUARD_ERROR_CODES,
  liveControlLine,
} from './task-snapshot-sync.js'
import {
  AgentError,
  AGENT_ERROR_CODE,
  AGENT_PROTOCOL_VERSION,
  AGENT_VERSION,
  buildCommandResult,
  compareVersions,
  isAuthenticationError,
  safeErrorMessage,
  validateCommand,
} from './protocol.js'

const HEARTBEAT_MS = 15_000
const EVENT_RECONCILE_MS = 5_000
const RETRY_BASE_MS = 1_000
const RETRY_MAX_MS = 60_000

function sleep(ms, signal) {
  if (signal?.aborted) {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })
}

function nextDelay(attempt, retryAfterMs = null) {
  if (Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
    return Math.min(Math.max(retryAfterMs, RETRY_BASE_MS), RETRY_MAX_MS)
  }
  return Math.min(RETRY_BASE_MS * 2 ** Math.min(attempt, 6), RETRY_MAX_MS)
}

function publicBinding(binding) {
  return {
    localId: binding.localId,
    serverBindingId: binding.serverBindingId,
    taskSpaceId: binding.taskSpaceId,
    projectId: binding.projectId,
    localRepoKey: binding.localRepoKey,
    remoteIdentityKey: binding.remoteIdentityKey,
    displayName: binding.displayName,
    branchName: binding.branchName,
    teamId: binding.teamId ?? null,
    readOnly: binding.readOnly === true,
    status: binding.syncStatus,
    lastSyncedAt: binding.lastSyncedAt,
    lastErrorCode: binding.lastErrorCode,
    lastError: binding.lastError,
  }
}

function commandBinding(config, command) {
  const byServerId = config.bindings.find(
    (binding) => binding.serverBindingId === command.bindingId,
  )
  if (byServerId) {
    return byServerId
  }
  if (command.payload.taskSpaceId) {
    return (
      config.bindings.find((binding) => binding.taskSpaceId === command.payload.taskSpaceId) || null
    )
  }
  return null
}

function bindingMatchesCommand(binding, command) {
  if (command.payload.taskSpaceId && binding.taskSpaceId !== command.payload.taskSpaceId) {
    return false
  }
  if (binding.serverBindingId && binding.serverBindingId !== command.bindingId) {
    return false
  }
  return !command.payload.branchName || command.payload.branchName === binding.branchName
}

function activeCommandEnabled(heartbeat) {
  if (!heartbeat?.compatible) {
    return false
  }
  if (!heartbeat.minimumAgentVersion) {
    return true
  }
  const comparison = compareVersions(AGENT_VERSION, heartbeat.minimumAgentVersion)
  return comparison != null && comparison >= 0
}

export class AgentRuntime {
  constructor(options) {
    this.store = options.store
    this.credentialStore = options.credentialStore
    this.logger = options.logger
    this.apiFactory =
      options.apiFactory ||
      ((config, credential, ca) =>
        new AgentApiClient({
          serverUrl: config.serverUrl,
          credential,
          ca,
        }))
    this.inspectRepository = options.inspectRepository || inspectRepository
    this.syncRepository = options.syncRepository || syncRepository
    this.heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS
    this.eventIdleMs = options.eventIdleMs ?? 60_000
    this.eventReconcileMs = options.eventReconcileMs ?? EVENT_RECONCILE_MS
    this.taskSync =
      options.taskSync ||
      new AgentTaskSnapshotSync({
        store: this.store,
        loadContext: () => this.loadContext(),
        logger: this.logger,
        emitControl:
          options.emitControl ||
          ((event) => {
            if (event.type) process.stdout.write(liveControlLine(event))
          }),
        watch: options.watch,
      })
    this.taskCommand =
      options.taskCommand ||
      new AgentTaskCommandExecutor({
        store: this.store,
        taskSync: this.taskSync,
        loadContext: () => this.loadContext(),
        logger: this.logger,
      })
    this._syncInFlight = new Map()
    this.abortController = new AbortController()
    this.signal = this.abortController.signal
    if (options.signal?.aborted) {
      this.stop('signal')
    } else if (options.signal) {
      options.signal.addEventListener('abort', () => this.stop('signal'), {
        once: true,
      })
    }
    this.api = null
    this.config = null
    this.credential = null
    this.ca = null
    this.lastHeartbeat = null
    this.pollEnabled = false
    // 已被服务端撤销/拒绝的团队：不再重建事件流，避免 403 风暴。
    this.authRevoked = false
    this.stopReason = null
    this.fatalError = null
  }

  stop(reason = 'requested') {
    this.taskSync?.stop()
    if (!this.signal.aborted) {
      this.stopReason ||= reason
      this.abortController.abort()
    }
  }

  async loadContext(force = false) {
    const config = await this.store.readConfig({ allowMissing: false })
    const credential =
      force || !this.credential ? await this.credentialStore.loadCredential() : this.credential
    const ca = force || !this.api ? await loadCaFile(config.caFile) : this.ca
    if (
      force ||
      !this.api ||
      !this.config ||
      this.config.revision !== config.revision ||
      this.credential !== credential ||
      this.ca !== ca
    ) {
      this.api = this.apiFactory(config, credential, ca)
    }
    this.config = config
    this.credential = credential
    this.ca = ca
    return { config, credential, api: this.api }
  }

  _heartbeatPayload() {
    return {
      agentId: this.config.agentId,
      deviceId: this.config.agentId,
      deviceName: this.config.deviceName,
      protocolVersion: AGENT_PROTOCOL_VERSION,
      agentVersion: AGENT_VERSION,
      bindings: this.config.bindings.map(publicBinding),
    }
  }

  async _applyHeartbeatBindings(heartbeat) {
    if (!heartbeat.bindings?.length) {
      return
    }
    const byTaskSpace = new Map(heartbeat.bindings.map((binding) => [binding.taskSpaceId, binding]))
    await this.store.updateConfig((config) => {
      let changed = false
      const bindings = config.bindings.map((binding) => {
        const remote = byTaskSpace.get(binding.taskSpaceId)
        if (!remote || remote.localRepoKey !== binding.localRepoKey) {
          return binding
        }
        const branchGuarded = BRANCH_GUARD_ERROR_CODES.has(binding.lastErrorCode)
        const next = {
          ...binding,
          serverBindingId: remote.id,
          teamId: remote.teamId ?? binding.teamId ?? null,
          readOnly: remote.readOnly === true,
          syncStatus: remote.status,
          lastErrorCode: branchGuarded ? binding.lastErrorCode : remote.errorCode,
          lastError: branchGuarded ? binding.lastError : remote.error,
        }
        if (remote.branchName && remote.branchName !== binding.branchName) {
          next.lastErrorCode = 'BINDING_BRANCH_MISMATCH'
          next.lastError = '服务端项目管理分支与本地绑定不一致'
        }
        if (
          next.serverBindingId !== binding.serverBindingId ||
          next.teamId !== binding.teamId ||
          next.readOnly !== binding.readOnly ||
          next.syncStatus !== binding.syncStatus ||
          next.lastErrorCode !== binding.lastErrorCode ||
          next.lastError !== binding.lastError
        ) {
          changed = true
          return next
        }
        return binding
      })
      return changed ? { ...config, bindings } : undefined
    })
    try {
      this.config = await this.store.readConfig({ allowMissing: false })
      await this.taskSync.updateBindings(this.config.bindings)
    } catch (error) {
      this.logger.warn('更新本地实时监听绑定失败', error)
    }
  }

  async _recordHeartbeat(heartbeat, error = null) {
    this.lastHeartbeat = {
      at: new Date().toISOString(),
      compatible: heartbeat?.compatible ?? false,
      protocolVersion: heartbeat?.protocolVersion ?? null,
      minimumAgentVersion: heartbeat?.minimumAgentVersion ?? null,
      error: error
        ? {
            code: error.code || AGENT_ERROR_CODE.NETWORK_ERROR,
            message: safeErrorMessage(error),
          }
        : null,
    }
    this.pollEnabled = error == null && activeCommandEnabled(this.lastHeartbeat)
    await this.store.writeState({
      status: this.authRevoked ? 'auth_revoked' : error ? 'degraded' : 'running',
      pid: process.pid,
      startedAt: this.startedAt || null,
      lastHeartbeatAt: this.lastHeartbeat.at,
      lastHeartbeatError: this.lastHeartbeat.error,
      commandPollingEnabled: this.pollEnabled,
      eventStreamEnabled: this.pollEnabled,
    })
  }

  async heartbeatOnce() {
    await this.loadContext()
    try {
      const heartbeat = await this.api.heartbeat(this._heartbeatPayload(), {
        signal: this.signal,
      })
      await this._applyHeartbeatBindings(heartbeat)
      await this._recordHeartbeat(heartbeat)
      if (!heartbeat.compatible) {
        this.logger.warn('服务端协议不兼容，仅保留心跳')
      } else if (!activeCommandEnabled(heartbeat)) {
        this.logger.warn('Agent 版本低于服务端最低版本，暂停领取命令', {
          minimumAgentVersion: heartbeat.minimumAgentVersion,
        })
      }
      return heartbeat
    } catch (error) {
      await this._recordHeartbeat(null, error)
      if (isAuthenticationError(error)) {
        this.authRevoked = true
        this.logger.error('Agent 凭证已撤销，停止重试，请重新配对')
        this.stop('auth_revoked')
        return null
      }
      throw error
    }
  }

  async _heartbeatLoop() {
    let attempt = 0
    while (!this.signal.aborted) {
      try {
        await this.heartbeatOnce()
        attempt = 0
      } catch (error) {
        if (isAuthenticationError(error)) {
          return
        }
        const delay = nextDelay(attempt, error.retryAfterMs)
        attempt += 1
        this.logger.warn('心跳失败，稍后重试', error)
        await sleep(delay, this.signal)
        continue
      }
      await sleep(this.heartbeatMs, this.signal)
    }
  }

  async _submitResult(command, result, attempt = 0) {
    try {
      await this.loadContext()
      await this.api.submitCommandResult(command.id, result, {
        signal: this.signal,
      })
      return true
    } catch (error) {
      if (isAuthenticationError(error)) {
        this.authRevoked = true
        this.stop('auth_revoked')
        return false
      }
      if (this.signal.aborted) {
        return false
      }
      if (
        error.retryable !== true &&
        error.code !== AGENT_ERROR_CODE.NETWORK_ERROR &&
        error.serverCode !== 'COMMAND_WAITING_INDEX'
      ) {
        this.logger.error('命令结果上报被服务端拒绝', error)
        return false
      }
      if (attempt >= (error.serverCode === 'COMMAND_WAITING_INDEX' ? 8 : 2)) {
        this.logger.error('命令结果上报失败，等待服务端租约重投', error)
        return false
      }
      await sleep(nextDelay(attempt, error.retryAfterMs), this.signal)
      return this._submitResult(command, result, attempt + 1)
    }
  }

  async _updateBindingResult(binding, result, error = null) {
    const health = error
      ? formatBindingHealth(error)
      : result?.clean === false
        ? {
            errorCode: AGENT_ERROR_CODE.LOCAL_DIRTY,
            error: '本地工作区存在未提交或未跟踪文件',
          }
        : null
    await this.store.updateConfig((config) => {
      let changed = false
      const bindings = config.bindings.map((item) => {
        if (item.localId !== binding.localId) {
          return item
        }
        const branchGuarded = BRANCH_GUARD_ERROR_CODES.has(item.lastErrorCode)
        const next = {
          ...item,
          syncStatus: result ? 'approved' : item.syncStatus,
          lastSyncedAt: result?.syncedAt ?? item.lastSyncedAt,
          lastHead: result?.head ?? item.lastHead,
          lastErrorCode: branchGuarded ? item.lastErrorCode : (health?.errorCode ?? null),
          lastError: branchGuarded ? item.lastError : (health?.error ?? null),
        }
        if (
          next.lastSyncedAt !== item.lastSyncedAt ||
          next.lastHead !== item.lastHead ||
          next.lastErrorCode !== item.lastErrorCode ||
          next.lastError !== item.lastError
        ) {
          changed = true
          return next
        }
        return item
      })
      return changed ? { ...config, bindings } : undefined
    })
  }

  _repoOptions(binding) {
    return {
      repoPath: binding.repoPath,
      branchName: binding.branchName,
      hooksDir: path.join(this.store.paths.hooksBaseDir, binding.localId),
      expectedRemoteIdentity: binding.remoteIdentityKey,
      allowFileRemote: binding.allowFileRemote,
    }
  }

  async _syncBinding(binding) {
    const existing = this._syncInFlight.get(binding.localId)
    if (existing) return existing
    const run = (async () => {
      const result = await this.syncRepository(this._repoOptions(binding))
      await this._updateBindingResult(binding, result)
      return {
        bindingId: binding.serverBindingId,
        taskSpaceId: binding.taskSpaceId,
        projectId: binding.projectId,
        branchName: result.branchName,
        head: result.head,
        clean: result.clean,
        syncedAt: result.syncedAt,
        localRepoKey: result.localRepoKey,
        remoteIdentityKey: result.remoteIdentityKey,
      }
    })()
    this._syncInFlight.set(binding.localId, run)
    try {
      return await run
    } finally {
      if (this._syncInFlight.get(binding.localId) === run) {
        this._syncInFlight.delete(binding.localId)
      }
    }
  }

  _bindingForTaskSpace(taskSpaceId) {
    return (
      (this.config?.bindings || []).find(
        (binding) => binding.taskSpaceId === taskSpaceId && binding.syncStatus === 'approved',
      ) || null
    )
  }

  async _syncTaskSpace(taskSpaceId) {
    if (!taskSpaceId) return
    const binding = this._bindingForTaskSpace(taskSpaceId)
    if (!binding) {
      this.logger.warn('收到未知任务空间的事件', { taskSpaceId })
      return
    }
    try {
      await this.taskSync.pullTaskSpace(taskSpaceId)
    } catch (error) {
      this.logger.warn('处理事件时同步任务空间失败', error)
    }
  }

  async _handleEvent(event) {
    const data = event.data && typeof event.data === 'object' ? event.data : {}
    switch (event.type) {
      case 'agent.revoked':
        this.logger.warn('账号已在其他设备登录或被管理员撤销，Agent 停止运行')
        this.authRevoked = true
        this.stop('auth_revoked')
        return
      case 'task.changed':
        await this.taskSync.pullTaskSpace(data.taskSpaceId)
        return
      case 'cursor.invalidated':
        if (data.taskSpaceId) {
          await this.taskSync.pullTaskSpace(data.taskSpaceId)
        }
        return
      case 'command': {
        const raw = data.payload?.command
        if (!raw) return
        const command = validateCommand(raw)
        await this._processCommand(command)
        return
      }
      default:
        this.logger.warn('忽略未知事件类型', { type: event.type })
    }
  }

  async _eventLoop() {
    let attempt = 0
    while (!this.signal.aborted) {
      if (!this.pollEnabled) {
        await sleep(this.eventReconcileMs, this.signal)
        continue
      }
      await this.loadContext().catch((error) => {
        this.logger.warn('加载 Agent 配置失败', error)
        return null
      })
      const cursors = await this.store.readEventCursors()
      try {
        await this.api.streamEvents(
          { lastEventId: cursors._global ?? null },
          {
            signal: this.signal,
            idleTimeoutMs: this.eventIdleMs,
            onOpen: () => {
              attempt = 0
              this.logger.info('Agent 事件流已连接')
              for (const taskSpaceId of this.taskSync.bindings.keys()) {
                void this.taskSync.pullTaskSpace(taskSpaceId).catch((error) => {
                  this.logger.warn('事件流恢复后同步任务空间失败', {
                    taskSpaceId,
                    error: safeErrorMessage(error),
                  })
                })
              }
            },
            onEvent: async (event) => {
              try {
                await this._handleEvent(event)
              } finally {
                const id = Number(event.id)
                if (Number.isSafeInteger(id) && id >= 0) {
                  await this.store.writeEventCursor('_global', id).catch(() => {})
                }
              }
            },
          },
        )
        if (this.signal.aborted) return
        await sleep(1_000, this.signal)
      } catch (error) {
        if (this.signal.aborted) return
        if (isAuthenticationError(error)) {
          this.authRevoked = true
          this.logger.error('Agent 凭证已撤销，停止重试，请重新配对')
          this.stop('auth_revoked')
          return
        }
        const delay = nextDelay(attempt, error.retryAfterMs) + Math.floor(Math.random() * 250)
        attempt += 1
        this.logger.warn('Agent 事件流断开，稍后重连', error)
        await sleep(delay, this.signal)
      }
    }
  }

  async _runCommand(command) {
    const { config } = await this.loadContext()
    const binding = commandBinding(config, command)
    if (!binding) {
      throw new AgentError(AGENT_ERROR_CODE.BINDING_UNKNOWN, '服务端命令引用了未知的本地项目绑定')
    }
    if (!bindingMatchesCommand(binding, command)) {
      throw new AgentError(
        AGENT_ERROR_CODE.COMMAND_INVALID,
        '服务端命令的项目或分支与本地绑定不一致',
      )
    }
    if (binding.syncStatus !== 'approved') {
      throw new AgentError(
        AGENT_ERROR_CODE.BINDING_NOT_APPROVED,
        '本地任务空间绑定尚未获项目负责人批准',
      )
    }
    if (command.type === 'create_task' || command.type === 'assign_task') {
      return this.taskCommand.execute(command)
    }
    const options = {
      repoPath: binding.repoPath,
      branchName: binding.branchName,
      hooksDir: path.join(this.store.paths.hooksBaseDir, binding.localId),
      expectedRemoteIdentity: binding.remoteIdentityKey,
      allowFileRemote: binding.allowFileRemote,
    }
    if (command.type === 'sync_branch') {
      return this._syncBinding(binding)
    }
    if (command.type === 'refresh_status') {
      const result = await this.inspectRepository(options)
      const reported = {
        bindingId: binding.serverBindingId,
        taskSpaceId: binding.taskSpaceId,
        projectId: binding.projectId,
        branchName: result.branchName,
        head: result.head,
        clean: result.clean,
        syncedAt: new Date().toISOString(),
        localRepoKey: result.localRepoKey,
        remoteIdentityKey: result.remoteIdentityKey,
      }
      await this._updateBindingResult(binding, reported)
      return reported
    }
    throw new AgentError(AGENT_ERROR_CODE.COMMAND_INVALID, '不支持的服务端命令')
  }

  async _processCommand(command) {
    try {
      let started
      try {
        started = await this.api.startCommand(command.id, { signal: this.signal })
      } catch (error) {
        if (error?.code === AGENT_ERROR_CODE.NETWORK_ERROR) {
          this.logger.warn('任务命令领取状态暂时无法确认，等待服务端租约重投', {
            commandId: command.id,
            commandType: command.type,
          })
          return
        }
        throw error
      }
      if (started?.execute !== true) {
        this.logger.info('任务命令已执行或已结束，忽略重复投递', {
          commandId: command.id,
          commandType: command.type,
          status: started?.operation?.status || 'unknown',
        })
        return
      }
      const result = await this._runCommand(command)
      const payload = buildCommandResult('succeeded', result)
      const delivered = await this._submitResult(command, payload)
      if (delivered) {
        this.logger.info('Agent 命令执行成功', {
          commandId: command.id,
          commandType: command.type,
        })
      } else {
        this.logger.warn('Agent 命令执行成功，但结果未上报', {
          commandId: command.id,
          commandType: command.type,
        })
      }
      return payload
    } catch (error) {
      const { config } = await this.loadContext().catch(() => ({ config: this.config }))
      const binding = config ? commandBinding(config, command) : null
      if (binding) {
        await this._updateBindingResult(binding, null, error).catch(() => {})
      }
      const payload = buildCommandResult('failed', null, error)
      await this._submitResult(command, payload)
      this.logger.warn('Agent 命令执行失败', error)
      return payload
    }
  }

  async run() {
    this.startedAt = new Date().toISOString()
    await this.store.ensureDirectories()
    await this.loadContext(true)
    await this.store.writeState({
      status: 'starting',
      pid: process.pid,
      startedAt: this.startedAt,
    })
    await this.taskSync.start()
    this.logger.info('Trellis Agent 已启动')
    const heartbeat = this._heartbeatLoop()
    const events = this._eventLoop()
    await Promise.all([heartbeat, events])
    this.taskSync.stop()
    await this.store.writeState({
      status: this.authRevoked ? 'auth_revoked' : 'stopped',
      pid: process.pid,
      startedAt: this.startedAt,
      stoppedAt: new Date().toISOString(),
      reason: this.stopReason || 'requested',
      lastHeartbeatAt: this.lastHeartbeat?.at ?? null,
    })
    this.logger.info(this.authRevoked ? 'Trellis Agent 因凭证撤销停止' : 'Trellis Agent 已停止')
    return {
      exitCode: 0,
      authRevoked: this.authRevoked,
      reason: this.stopReason,
    }
  }
}

export async function runAgentProcess(options = {}) {
  const store = options.store || new ConfigStore()
  await store.ensureDirectories()
  const logger = options.logger || new AgentLogger({ logsDir: store.paths.logsDir })
  const lock = options.lock || new SingleInstanceLock(store.paths.lockFile)
  let acquired = false
  try {
    await lock.acquire()
    acquired = true
    if (!options.credentialStore) {
      throw new AgentError(AGENT_ERROR_CODE.CONFIG_INVALID, 'Agent 凭证存储未初始化')
    }
    const credentialStore = options.credentialStore
    const runtime = new AgentRuntime({
      store,
      credentialStore,
      logger,
      apiFactory: options.apiFactory,
      inspectRepository: options.inspectRepository,
      syncRepository: options.syncRepository,
      heartbeatMs: options.heartbeatMs,
      eventIdleMs: options.eventIdleMs,
      eventReconcileMs: options.eventReconcileMs,
      emitControl: options.emitControl,
      watch: options.watch,
      taskSync: options.taskSync,
      taskCommand: options.taskCommand,
      signal: options.signal,
    })
    return await runtime.run()
  } catch (error) {
    logger.error('Trellis Agent 启动或运行失败', error)
    return {
      exitCode: error.code === AGENT_ERROR_CODE.LOCKED ? 7 : 1,
      error,
    }
  } finally {
    if (acquired) {
      await lock.release()
    }
    await logger.close()
  }
}
