import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  AgentError,
  AGENT_ERROR_CODE,
  normalizeServerUrl,
  validateBranchNameSyntax,
} from './protocol.js'
import { buildEnvironment, runProcess } from './process.js'

export const CONFIG_SCHEMA_VERSION = 2
export const STATE_SCHEMA_VERSION = 2

export function defaultAgentRoot() {
  if (process.env.TRELLIS_AGENT_ROOT) {
    return path.resolve(process.env.TRELLIS_AGENT_ROOT)
  }
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share')
  return path.join(base, 'TrellisBoardAgent')
}

export function createAgentPaths(root = defaultAgentRoot()) {
  const resolvedRoot = path.resolve(root)
  return {
    root: resolvedRoot,
    configFile: path.join(resolvedRoot, 'config.json'),
    credentialFile: path.join(resolvedRoot, 'credential.dpapi'),
    stateFile: path.join(resolvedRoot, 'runtime.json'),
    eventCursorsFile: path.join(resolvedRoot, 'event-cursors.json'),
    liveCursorsFile: path.join(resolvedRoot, 'live-cursors.json'),
    liveCursorLockFile: path.join(resolvedRoot, '.live-cursors.lock'),
    liveSuppressionFile: path.join(resolvedRoot, 'live-suppression.json'),
    liveBackupsDir: path.join(resolvedRoot, 'live-backups'),
    pendingLiveDir: path.join(resolvedRoot, 'pending-live'),
    eventsDir: path.join(resolvedRoot, 'events'),
    logsDir: path.join(resolvedRoot, 'logs'),
    lockFile: path.join(resolvedRoot, 'agent.lock'),
    configLockFile: path.join(resolvedRoot, '.config.lock'),
    hooksBaseDir: path.join(resolvedRoot, 'hooks'),
  }
}

function requireString(value, fieldName, maxLength = 4096) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new AgentError(AGENT_ERROR_CODE.CONFIG_INVALID, `配置字段 ${fieldName} 无效`)
  }
  return value
}

function optionalString(value, fieldName, maxLength = 4096) {
  if (value == null) {
    return null
  }
  return requireString(value, fieldName, maxLength)
}

function requireHash(value, fieldName) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new AgentError(AGENT_ERROR_CODE.CONFIG_INVALID, `配置字段 ${fieldName} 无效`)
  }
  return value
}

export function createConfigRevision() {
  return crypto.randomBytes(16).toString('hex')
}

export function validateConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new AgentError(AGENT_ERROR_CODE.CONFIG_INVALID, 'Agent 配置不是对象')
  }
  if (config.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    throw new AgentError(AGENT_ERROR_CODE.CONFIG_INVALID, 'Agent 配置版本不受支持')
  }
  requireString(config.revision, 'revision', 64)
  if (!/^[a-f0-9]{32}$/.test(config.revision)) {
    throw new AgentError(AGENT_ERROR_CODE.CONFIG_INVALID, 'Agent 配置修订号无效')
  }
  const serverUrl = normalizeServerUrl(config.serverUrl)
  const agentId = requireString(config.agentId, 'agentId', 128)
  const deviceName = requireString(config.deviceName, 'deviceName', 160)
  if (Array.from(deviceName).length > 80 || /[\u0000-\u001f\u007f]/.test(deviceName)) {
    throw new AgentError(AGENT_ERROR_CODE.CONFIG_INVALID, '设备名格式无效')
  }
  if (!Number.isInteger(config.protocolVersion) || config.protocolVersion < 1) {
    throw new AgentError(AGENT_ERROR_CODE.CONFIG_INVALID, 'Agent 协议版本无效')
  }
  if (config.caFile != null) {
    if (!path.isAbsolute(config.caFile)) {
      throw new AgentError(AGENT_ERROR_CODE.CONFIG_INVALID, 'CA 文件必须使用绝对路径')
    }
  }
  if (!Array.isArray(config.bindings)) {
    throw new AgentError(AGENT_ERROR_CODE.CONFIG_INVALID, 'Agent 绑定列表无效')
  }

  const bindings = config.bindings.map((binding, index) => {
    if (!binding || typeof binding !== 'object') {
      throw new AgentError(AGENT_ERROR_CODE.CONFIG_INVALID, `第 ${index + 1} 个绑定无效`)
    }
    const taskSpaceId = requireString(binding.taskSpaceId, 'taskSpaceId', 128)
    const projectId = requireString(binding.projectId, 'projectId', 128)
    const serverBindingId = optionalString(binding.serverBindingId, 'serverBindingId', 128)
    const syncStatus = binding.syncStatus ?? 'pending'
    if (!['pending', 'approved', 'rejected', 'revoked'].includes(syncStatus)) {
      throw new AgentError(AGENT_ERROR_CODE.CONFIG_INVALID, `第 ${index + 1} 个绑定状态无效`)
    }
    const liveSyncStatus = binding.liveSyncStatus ?? 'pending'
    if (!['pending', 'syncing', 'ready', 'error'].includes(liveSyncStatus)) {
      throw new AgentError(
        AGENT_ERROR_CODE.CONFIG_INVALID,
        `第 ${index + 1} 个绑定的实时同步状态无效`,
      )
    }
    const initialSyncMode =
      binding.initialSyncMode ?? (binding.initialReviewPending === true ? 'review' : 'safe')
    if (!['bootstrap', 'safe', 'review'].includes(initialSyncMode)) {
      throw new AgentError(
        AGENT_ERROR_CODE.CONFIG_INVALID,
        `第 ${index + 1} 个绑定的首次同步方式无效`,
      )
    }
    const initialSyncCompleted =
      typeof binding.initialSyncCompleted === 'boolean'
        ? binding.initialSyncCompleted
        : binding.initialSyncMode == null && binding.initialReviewPending !== true
    const initialReviewPending = initialSyncMode === 'review' && !initialSyncCompleted
    return {
      localId: requireString(binding.localId, 'localId', 128),
      serverBindingId,
      taskSpaceId,
      projectId,
      repoPath: path.resolve(requireString(binding.repoPath, 'repoPath', 4096)),
      branchName: validateBranchNameSyntax(requireString(binding.branchName, 'branchName', 255)),
      teamId: optionalString(binding.teamId, 'teamId', 128),
      remoteIdentityKey: requireHash(binding.remoteIdentityKey, 'remoteIdentityKey'),
      localRepoKey: requireHash(binding.localRepoKey, 'localRepoKey'),
      displayName: requireString(binding.displayName, 'displayName', 255),
      createdAt: requireString(binding.createdAt, 'createdAt', 64),
      allowFileRemote: binding.allowFileRemote === true,
      readOnly: binding.readOnly === true,
      syncStatus,
      initialSyncMode,
      initialSyncCompleted,
      initialReviewPending,
      liveSyncStatus,
      liveSyncError: optionalString(binding.liveSyncError, 'liveSyncError', 500),
      lastSyncedAt: optionalString(binding.lastSyncedAt, 'lastSyncedAt', 64),
      lastHead: optionalString(binding.lastHead, 'lastHead', 64),
      lastError: optionalString(binding.lastError, 'lastError', 500),
      lastErrorCode: optionalString(binding.lastErrorCode, 'lastErrorCode', 128),
    }
  })
  const seenTaskSpaces = new Set()
  for (const binding of bindings) {
    if (seenTaskSpaces.has(binding.taskSpaceId)) {
      throw new AgentError(AGENT_ERROR_CODE.CONFIG_INVALID, '同一任务空间只能绑定一次')
    }
    seenTaskSpaces.add(binding.taskSpaceId)
  }
  const teams = Array.isArray(config.teams)
    ? config.teams.map((team, index) => {
        if (!team || typeof team !== 'object' || Array.isArray(team)) {
          throw new AgentError(AGENT_ERROR_CODE.CONFIG_INVALID, `第 ${index + 1} 个团队信息无效`)
        }
        return {
          id: requireString(team.id, 'teams.id', 128),
          name: requireString(team.name, 'teams.name', 160),
          role: optionalString(team.role, 'teams.role', 32),
        }
      })
    : []

  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    revision: config.revision,
    serverUrl,
    caFile: config.caFile ?? null,
    allowLocalGitRemotes: config.allowLocalGitRemotes === true,
    agentId,
    deviceName,
    username: optionalString(config.username, 'username', 64),
    teamId: optionalString(config.teamId, 'teamId', 128),
    teams,
    protocolVersion: config.protocolVersion,
    agentVersion: typeof config.agentVersion === 'string' ? config.agentVersion : null,
    pairedAt: typeof config.pairedAt === 'string' ? config.pairedAt : null,
    bindings,
  }
}

function assertRepositoryBindingsConverged(bindings, previousBindings = []) {
  const activeByRepository = (items) => {
    const groups = new Map()
    for (const binding of items) {
      if (binding.syncStatus !== 'approved') continue
      const taskSpaceIds = groups.get(binding.localRepoKey) || []
      taskSpaceIds.push(binding.taskSpaceId)
      groups.set(binding.localRepoKey, taskSpaceIds)
    }
    return groups
  }
  const previous = activeByRepository(previousBindings)
  for (const [localRepoKey, taskSpaceIds] of activeByRepository(bindings)) {
    if (taskSpaceIds.length < 2) continue
    const before = (previous.get(localRepoKey) || []).sort()
    const after = [...taskSpaceIds].sort()
    if (before.length === after.length && before.every((value, index) => value === after[index])) {
      // 兼容升级前已存在的双绑定；运行时会按真实分支只启用一个 watcher。
      continue
    }
    throw new AgentError(
      AGENT_ERROR_CODE.CONFIG_INVALID,
      '同一本地仓库只能绑定一个任务空间；需要并行同步多个分支时请使用独立 Git worktree',
    )
  }
}

async function pathExists(target) {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

const RENAME_RETRY_DELAYS_MS = [10, 25, 50, 100, 200]

async function renameWithRetry(source, target) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(source, target)
      return
    } catch (error) {
      const retryable = error.code === 'EPERM' || error.code === 'EBUSY' || error.code === 'EACCES'
      if (!retryable || attempt >= RENAME_RETRY_DELAYS_MS.length) throw error
      await new Promise((resolve) => setTimeout(resolve, RENAME_RETRY_DELAYS_MS[attempt]))
    }
  }
}

export class ConfigStore {
  constructor(root = defaultAgentRoot(), options = {}) {
    this.paths = createAgentPaths(root)
    this.secureDirectory = options.secureDirectory !== false
    this._directoriesReady = null
  }

  async ensureDirectories() {
    if (!this._directoriesReady) {
      this._directoriesReady = (async () => {
        const created = await fs.mkdir(this.paths.root, { recursive: true, mode: 0o700 })
        await fs.mkdir(this.paths.logsDir, { recursive: true, mode: 0o700 })
        await fs.mkdir(this.paths.hooksBaseDir, { recursive: true, mode: 0o700 })
        await fs.mkdir(this.paths.eventsDir, { recursive: true, mode: 0o700 })
        await fs.mkdir(this.paths.liveBackupsDir, { recursive: true, mode: 0o700 })
        await fs.mkdir(this.paths.pendingLiveDir, { recursive: true, mode: 0o700 })
        if (process.platform === 'win32' && this.secureDirectory && created) {
          await this._restrictWindowsAcl(this.paths.root)
        }
      })()
    }
    return this._directoriesReady
  }

  async _restrictWindowsAcl(target) {
    const systemRoot = process.env.SystemRoot || 'C:\\Windows'
    const whoami = path.join(systemRoot, 'System32', 'whoami.exe')
    const icacls = path.join(systemRoot, 'System32', 'icacls.exe')
    const env = buildEnvironment()

    let principal
    try {
      const identity = await runProcess(whoami, [], {
        env,
        timeoutMs: 10_000,
        maxOutputBytes: 32_768,
      })
      if (identity.exitCode !== 0 || !identity.stdout.trim()) {
        throw new Error('whoami failed')
      }
      principal = identity.stdout.trim().split(/\r?\n/)[0]
    } catch (error) {
      throw new AgentError(
        AGENT_ERROR_CODE.CONFIG_INVALID,
        '无法确认当前 Windows 用户，配置目录未加密保护',
        {
          cause: error,
        },
      )
    }

    let aclResult
    try {
      aclResult = await runProcess(
        icacls,
        [target, '/inheritance:r', '/grant:r', `${principal}:(OI)(CI)F`, '/C', '/Q'],
        { env, timeoutMs: 20_000, maxOutputBytes: 262_144 },
      )
    } catch (error) {
      throw new AgentError(AGENT_ERROR_CODE.CONFIG_INVALID, '无法限制 Agent 配置目录 ACL', {
        cause: error,
      })
    }
    if (aclResult.exitCode !== 0) {
      throw new AgentError(AGENT_ERROR_CODE.CONFIG_INVALID, '无法限制 Agent 配置目录 ACL')
    }
  }

  async writeAtomic(target, data, mode = 0o600) {
    await this.ensureDirectories()
    const directory = path.dirname(target)
    await fs.mkdir(directory, { recursive: true, mode: 0o700 })
    const tempFile = path.join(
      directory,
      `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`,
    )
    let handle
    try {
      handle = await fs.open(tempFile, 'wx', mode)
      await handle.writeFile(data)
      await handle.sync()
      await handle.close()
      handle = null
      await renameWithRetry(tempFile, target)
    } catch (error) {
      await handle?.close().catch(() => {})
      await fs.unlink(tempFile).catch(() => {})
      throw error
    }
  }

  async readConfig(options = {}) {
    let raw
    try {
      raw = await fs.readFile(this.paths.configFile, 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT') {
        if (options.allowMissing !== false) {
          return null
        }
        throw new AgentError(AGENT_ERROR_CODE.CONFIG_MISSING, 'Agent 尚未配对，请先执行 pair')
      }
      throw new AgentError(AGENT_ERROR_CODE.CONFIG_INVALID, '无法读取 Agent 配置', { cause: error })
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      throw new AgentError(AGENT_ERROR_CODE.CONFIG_INVALID, 'Agent 配置文件不是合法 JSON', {
        cause: error,
      })
    }
    return validateConfig(parsed)
  }

  async saveConfig(config) {
    return this.withConfigLock(async () => {
      const previous = await this.readConfig().catch(() => null)
      return this._saveConfigUnlocked(config, previous)
    })
  }

  async _saveConfigUnlocked(config, previous = null) {
    const normalized = validateConfig(config)
    assertRepositoryBindingsConverged(normalized.bindings, previous?.bindings || [])
    await this.writeAtomic(this.paths.configFile, `${JSON.stringify(normalized, null, 2)}\n`)
    return normalized
  }

  async withConfigLock(operation, options = {}) {
    return this._withFileLock(this.paths.configLockFile, operation, {
      ...options,
      openMessage: '无法锁定 Agent 配置',
      timeoutMessage: 'Agent 配置正被另一个进程更新',
    })
  }

  async withLiveCursorLock(operation, options = {}) {
    return this._withFileLock(this.paths.liveCursorLockFile, operation, {
      ...options,
      openMessage: '无法锁定 Agent 同步游标',
      timeoutMessage: 'Agent 同步游标正被另一个进程更新',
    })
  }

  async _withFileLock(lockFile, operation, options = {}) {
    const timeoutMs = options.timeoutMs ?? 5_000
    const staleMs = options.staleMs ?? 30_000
    const deadline = Date.now() + timeoutMs
    await this.ensureDirectories()
    let handle
    while (!handle) {
      try {
        handle = await fs.open(lockFile, 'wx', 0o600)
      } catch (error) {
        if (error.code !== 'EEXIST') {
          throw new AgentError(AGENT_ERROR_CODE.CONFIG_INVALID, options.openMessage, {
            cause: error,
          })
        }
        let stale = false
        try {
          stale = Date.now() - (await fs.stat(lockFile)).mtimeMs > staleMs
        } catch (statError) {
          if (statError.code === 'ENOENT') {
            continue
          }
          throw statError
        }
        if (stale) {
          await fs.unlink(lockFile).catch(() => {})
          continue
        }
        if (Date.now() >= deadline) {
          throw new AgentError(AGENT_ERROR_CODE.LOCKED, options.timeoutMessage)
        }
        await new Promise((resolve) => setTimeout(resolve, 40))
      }
    }
    try {
      return await operation()
    } finally {
      await handle.close().catch(() => {})
      await fs.unlink(lockFile).catch(() => {})
    }
  }

  async updateConfig(mutator, options = {}) {
    return this.withConfigLock(async () => {
      const current = await this.readConfig({
        allowMissing: options.allowMissing === true,
      })
      const next = await mutator(current)
      if (next === undefined) {
        return current
      }
      if (next == null) {
        throw new AgentError(AGENT_ERROR_CODE.CONFIG_MISSING, 'Agent 尚未配对')
      }
      return this._saveConfigUnlocked(
        {
          ...next,
          revision: createConfigRevision(),
        },
        current,
      )
    })
  }

  async readState() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.paths.stateFile, 'utf8'))
      if (parsed?.schemaVersion !== STATE_SCHEMA_VERSION) {
        return null
      }
      return parsed
    } catch {
      return null
    }
  }

  async writeState(state) {
    const payload = {
      schemaVersion: STATE_SCHEMA_VERSION,
      ...state,
    }
    await this.writeAtomic(this.paths.stateFile, `${JSON.stringify(payload, null, 2)}\n`)
  }

  async readEventCursors() {
    let parsed
    try {
      parsed = JSON.parse(await fs.readFile(this.paths.eventCursorsFile, 'utf8'))
    } catch {
      return {}
    }
    if (parsed?.schemaVersion !== 1 || !parsed.cursors || typeof parsed.cursors !== 'object') {
      return {}
    }
    const cursors = {}
    for (const [teamId, value] of Object.entries(parsed.cursors)) {
      const lastEventId = Number(value?.lastEventId)
      if (Number.isSafeInteger(lastEventId) && lastEventId >= 0) {
        cursors[teamId] = lastEventId
      }
    }
    return cursors
  }

  async writeEventCursor(teamId, lastEventId) {
    const key = String(teamId || '')
    if (!key) return
    const value = Number(lastEventId)
    if (!Number.isSafeInteger(value) || value < 0) return
    const operation = async () => {
      const cursors = await this.readEventCursors()
      if (cursors[key] != null && cursors[key] > value) return
      cursors[key] = value
      const payload = {
        schemaVersion: 1,
        cursors: Object.fromEntries(
          Object.entries(cursors).map(([id, cursor]) => [
            id,
            { lastEventId: cursor, updatedAt: new Date().toISOString() },
          ]),
        ),
      }
      await this.writeAtomic(this.paths.eventCursorsFile, `${JSON.stringify(payload, null, 2)}\n`)
    }
    this._cursorWrite = (this._cursorWrite || Promise.resolve()).catch(() => {}).then(operation)
    return this._cursorWrite
  }

  async clearEventCursor(teamId) {
    const key = String(teamId || '')
    if (!key) return
    const operation = async () => {
      const cursors = await this.readEventCursors()
      if (cursors[key] == null) return
      delete cursors[key]
      const payload = {
        schemaVersion: 1,
        cursors: Object.fromEntries(
          Object.entries(cursors).map(([id, cursor]) => [
            id,
            { lastEventId: cursor, updatedAt: new Date().toISOString() },
          ]),
        ),
      }
      await this.writeAtomic(this.paths.eventCursorsFile, `${JSON.stringify(payload, null, 2)}\n`)
    }
    this._cursorWrite = (this._cursorWrite || Promise.resolve()).catch(() => {}).then(operation)
    return this._cursorWrite
  }

  async writeCredentialRecord(record) {
    await this.writeAtomic(this.paths.credentialFile, `${JSON.stringify(record, null, 2)}\n`)
  }

  async readCredentialRecord() {
    let raw
    try {
      raw = await fs.readFile(this.paths.credentialFile, 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new AgentError(AGENT_ERROR_CODE.CREDENTIAL_MISSING, 'Agent 凭证不存在，请重新配对')
      }
      throw new AgentError(AGENT_ERROR_CODE.CREDENTIAL_CORRUPT, '无法读取 Agent 凭证', {
        cause: error,
      })
    }
    try {
      return JSON.parse(raw)
    } catch (error) {
      throw new AgentError(
        AGENT_ERROR_CODE.CREDENTIAL_CORRUPT,
        'Agent 凭证文件已损坏，请重新配对',
        {
          cause: error,
        },
      )
    }
  }

  async credentialExists() {
    return pathExists(this.paths.credentialFile)
  }
}
