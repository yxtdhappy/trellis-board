import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { TextDecoder } from 'node:util'
import {
  classifyTaskSnapshots,
  groupTaskSnapshotFiles,
  normalizeSnapshotPath,
  normalizeSnapshotText,
  snapshotSha256,
} from '../shared/task-snapshot.js'
import { createTrellisWatcher } from '../shared/trellis-watcher.js'
import { readLocalTaskSnapshotFiles } from './local-task-snapshot.js'
import { AgentApiError, AgentError, AGENT_ERROR_CODE, safeErrorMessage } from './protocol.js'

const DEBOUNCE_MS = 250
const CURSOR_VERSION = 3
const UPLOAD_MIN_INTERVAL_MS = 260
const RATE_LIMIT_RETRY_DELAY_MS = 1000
const RATE_LIMIT_RETRY_MAX_DELAY_MS = 5000
const MAX_RATE_LIMIT_RETRIES = 2
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })
const SHA256_PATTERN = /^[a-f0-9]{64}$/

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isRateLimitError(error) {
  return error instanceof AgentApiError && error.status === 429 && error.retryable === true
}

function rateLimitRetryDelay(error) {
  const retryAfterMs = Number(error.retryAfterMs)
  return Number.isFinite(retryAfterMs) && retryAfterMs > 0
    ? Math.min(retryAfterMs, RATE_LIMIT_RETRY_MAX_DELAY_MS)
    : RATE_LIMIT_RETRY_DELAY_MS
}

function decodeUtf8(bytes) {
  try {
    return UTF8_DECODER.decode(bytes)
  } catch {
    throw new AgentError(AGENT_ERROR_CODE.INVALID_RESPONSE, '任务文件不是有效的 UTF-8 文本')
  }
}

function isInside(parent, child) {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function taskDirectoryFromRelative(relativePath) {
  const parts = String(relativePath || '')
    .replaceAll('\\', '/')
    .split('/')
  if (parts[0] !== '.trellis' || parts[1] !== 'tasks') return null
  if (parts[2] === 'archive') {
    if (parts.length < 5 || !/^\d{4}-\d{2}$/.test(parts[3])) return null
    return parts.slice(0, 5).join('/')
  }
  if (parts.length < 3) return null
  return parts.slice(0, 3).join('/')
}

function conflictTaskDirectories(value) {
  const directories = String(value || '')
    .split(' -> ')
    .map((item) => item.trim())
    .filter(Boolean)
  return {
    local: directories[0] || null,
    server: directories.at(-1) || null,
  }
}

function conflictSummary(result) {
  return {
    conflictId: result.conflictId,
    taskId: result.details?.taskId || null,
    taskTitle: result.details?.taskTitle || '任务',
    files: Array.isArray(result.details?.files)
      ? result.details.files.map((file) => ({
          path: file.path,
          changedBy: file.changedBy || null,
          revision: file.revision || 0,
        }))
      : [],
    message: result.message || result.error || '任务文件已被其他成员修改',
    suggestion: result.details?.suggestion || '先查看差异，再选择保留哪一份',
  }
}

function controlTaskGroup(group) {
  if (!group) return null
  return {
    taskId: group.taskId,
    taskDir: group.taskDir,
  }
}

function controlDifferences(differences) {
  return (differences || []).map((difference) => ({
    ...difference,
    local: controlTaskGroup(difference.local),
    server: controlTaskGroup(difference.server),
  }))
}

function taskConflictFromError(error) {
  if (error?.serverCode !== 'TASK_FILE_CONFLICT') return null
  return {
    status: 409,
    code: 'TASK_FILE_CONFLICT',
    conflictId: error.conflictId || null,
    message: error.message,
    details: error.details || {},
  }
}

function initialSyncModeFor(binding) {
  if (new Set(['bootstrap', 'safe', 'review']).has(binding.initialSyncMode)) {
    return binding.initialSyncMode
  }
  return binding.initialReviewPending === true ? 'review' : 'safe'
}

function normalizeBaselines(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const baselines = {}
  for (const [pathName, sha256] of Object.entries(value)) {
    try {
      const normalizedPath = normalizeSnapshotPath(pathName)
      if (typeof sha256 === 'string' && SHA256_PATTERN.test(sha256)) {
        baselines[normalizedPath] = sha256
      }
    } catch {
      // 损坏的本地游标摘要直接丢弃，后续写入会按冲突处理。
    }
  }
  return baselines
}

function baselinesFromSnapshot(files) {
  return Object.fromEntries(
    (files || [])
      .filter((file) => !file.deleted && SHA256_PATTERN.test(String(file.sha256 || '')))
      .map((file) => [file.path, file.sha256]),
  )
}

function mergeSnapshotBaselines(current, files) {
  const next = { ...normalizeBaselines(current) }
  for (const file of files || []) {
    if (file.deleted) delete next[file.path]
    else if (SHA256_PATTERN.test(String(file.sha256 || ''))) next[file.path] = file.sha256
  }
  return next
}

function fileStateFromGroup(group) {
  return Object.fromEntries(
    (group?.files || []).filter((file) => !file.deleted).map((file) => [file.path, file.sha256]),
  )
}

function sameFileState(left, right) {
  const leftEntries = Object.entries(left || {})
  const rightEntries = Object.entries(right || {})
  if (leftEntries.length !== rightEntries.length) return false
  return leftEntries.every(([pathName, sha256]) => right?.[pathName] === sha256)
}

function normalizeDeferred(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const deferred = {}
  for (const [taskDir, files] of Object.entries(value)) {
    try {
      const normalizedFiles = normalizeBaselines(files)
      if (
        Object.keys(normalizedFiles).length &&
        Object.keys(normalizedFiles).every(
          (pathName) => taskDirectoryFromRelative(pathName) === taskDir,
        )
      ) {
        deferred[taskDir] = normalizedFiles
      }
    } catch {
      // 损坏的延后状态直接丢弃，后续按本地修改重新判定。
    }
  }
  return deferred
}

function baselinesForTaskDir(baselines, taskDir) {
  return Object.fromEntries(
    Object.entries(normalizeBaselines(baselines)).filter(
      ([pathName]) => taskDirectoryFromRelative(pathName) === taskDir,
    ),
  )
}

function clearDeferredForFiles(deferred, files) {
  const next = { ...normalizeDeferred(deferred) }
  for (const file of files || []) {
    const taskDir = taskDirectoryFromRelative(file.path)
    if (taskDir) delete next[taskDir]
  }
  return next
}

export function liveControlLine(event) {
  return `${JSON.stringify({ control: event })}\n`
}

export class AgentTaskSnapshotSync {
  constructor({
    store,
    loadContext,
    logger = console,
    emitControl = () => {},
    watch = undefined,
    debounceMs = DEBOUNCE_MS,
  }) {
    this.store = store
    this.loadContext = loadContext
    this.logger = logger
    this.emitControl = emitControl
    this.watch = watch
    this.debounceMs = debounceMs
    this.bindings = new Map()
    this.queues = new Map()
    this.uploadGates = new Map()
    this.nextUploadAt = new Map()
    this.watcher = null
    this.stopped = true
    this.suppressed = new Map()
    this.cursorState = null
    this.cursorWriteQueue = Promise.resolve()
  }

  async start() {
    if (!this.stopped) return
    this.stopped = false
    const { config } = await this.loadContext()
    this._setBindings(config.bindings)
  }

  stop() {
    this.stopped = true
    this.watcher?.close()
    this.watcher = null
  }

  updateBindings(bindings) {
    this._setBindings(bindings)
  }

  _setBindings(bindings = []) {
    this.bindings = new Map(
      bindings
        .filter((binding) => binding.syncStatus === 'approved' && binding.taskSpaceId)
        .map((binding) => [binding.taskSpaceId, binding]),
    )
    if (this.stopped) return
    this.watcher?.close()
    this.watcher = createTrellisWatcher({
      repositories: [...this.bindings.values()]
        .filter((binding) => binding.initialSyncCompleted !== false)
        .map((binding) => ({
          id: binding.taskSpaceId,
          name: binding.displayName,
          path: binding.repoPath,
        })),
      roots: ['tasks'],
      watch: this.watch,
      debounceMs: this.debounceMs,
      onChange: (events) => {
        const byTaskSpace = new Map()
        for (const event of events) {
          if (!event.relativePath?.startsWith('tasks/')) continue
          const paths = byTaskSpace.get(event.repositoryId) || new Set()
          paths.add(event.trellisPath)
          byTaskSpace.set(event.repositoryId, paths)
        }
        for (const [taskSpaceId, paths] of byTaskSpace) {
          void this._enqueue(taskSpaceId, () => this._uploadDirty(taskSpaceId, paths))
        }
      },
      onError: (error) => this.logger.warn('任务目录监听失败', error),
    })
    for (const taskSpaceId of this.bindings.keys()) {
      void this.pullTaskSpace(taskSpaceId)
    }
  }

  _enqueue(taskSpaceId, operation) {
    const previous = this.queues.get(taskSpaceId) || Promise.resolve()
    const current = previous
      .catch(() => {})
      .then(operation)
      .catch((error) => {
        this.logger.warn('任务空间同步失败', { taskSpaceId, error: safeErrorMessage(error) })
        this.emitControl({
          type: 'task_sync_error',
          taskSpaceId,
          message: safeErrorMessage(error),
        })
      })
    this.queues.set(taskSpaceId, current)
    current.finally(() => {
      if (this.queues.get(taskSpaceId) === current) this.queues.delete(taskSpaceId)
    })
    return current
  }

  async _readCursorState() {
    if (this.cursorState) return this.cursorState
    try {
      const parsed = JSON.parse(await fs.readFile(this.store.paths.liveCursorsFile, 'utf8'))
      this.cursorState =
        parsed?.version === CURSOR_VERSION &&
        parsed.taskSpaces &&
        typeof parsed.taskSpaces === 'object'
          ? parsed
          : { version: CURSOR_VERSION, taskSpaces: {} }
    } catch {
      this.cursorState = { version: CURSOR_VERSION, taskSpaces: {} }
    }
    return this.cursorState
  }

  async _readCursor(taskSpaceId) {
    const state = await this._readCursorState()
    const value = state.taskSpaces[taskSpaceId] || {}
    const pending =
      value.pending &&
      typeof value.pending.batchId === 'string' &&
      Number.isSafeInteger(Number(value.pending.clientSequence)) &&
      Number(value.pending.clientSequence) > 0 &&
      Array.isArray(value.pending.files) &&
      value.pending.files.length
        ? {
            batchId: value.pending.batchId,
            clientSequence: Number(value.pending.clientSequence),
            files: value.pending.files,
          }
        : null
    return {
      revision: Number(value.revision || 0),
      sequence: Number(value.sequence || 0),
      pending,
      baselines: normalizeBaselines(value.baselines),
      deferred: normalizeDeferred(value.deferred),
    }
  }

  async _writeCursor(taskSpaceId, next) {
    const operation = this.cursorWriteQueue.then(async () => {
      const state = await this._readCursorState()
      const current = state.taskSpaces[taskSpaceId] || {}
      const entry = {
        ...current,
        revision: Math.max(Number(current.revision || 0), Number(next.revision || 0)),
        sequence: Math.max(Number(current.sequence || 0), Number(next.sequence || 0)),
        updatedAt: new Date().toISOString(),
      }
      if (Object.hasOwn(next, 'baselines')) {
        entry.baselines = normalizeBaselines(next.baselines)
      } else if (current.baselines) {
        entry.baselines = normalizeBaselines(current.baselines)
      }
      if (Object.hasOwn(next, 'deferred')) {
        entry.deferred = normalizeDeferred(next.deferred)
      } else if (current.deferred) {
        entry.deferred = normalizeDeferred(current.deferred)
      }
      if (Object.hasOwn(next, 'pending')) {
        if (next.pending) entry.pending = next.pending
        else delete entry.pending
      }
      state.taskSpaces[taskSpaceId] = entry
      await this.store.writeAtomic(
        this.store.paths.liveCursorsFile,
        `${JSON.stringify(state, null, 2)}\n`,
      )
    })
    this.cursorWriteQueue = operation.catch(() => {})
    return operation
  }

  _binding(taskSpaceId) {
    const binding = this.bindings.get(String(taskSpaceId || ''))
    if (!binding) {
      throw new AgentError(AGENT_ERROR_CODE.BINDING_UNKNOWN, '任务空间尚未关联到本地仓库')
    }
    return binding
  }

  async _localFiles(binding, taskDirs = null) {
    return readLocalTaskSnapshotFiles(binding.repoPath, taskDirs)
  }

  async _localSyncState(binding, cursor) {
    const localGroups = groupTaskSnapshotFiles(await this._localFiles(binding), {
      maxFiles: Number.POSITIVE_INFINITY,
      maxBytes: Number.POSITIVE_INFINITY,
    })
    const localByDir = new Map(localGroups.map((group) => [group.taskDir, group]))
    const deferred = normalizeDeferred(cursor.deferred)
    const nextDeferred = { ...deferred }
    const taskDirs = new Set([...localByDir.keys(), ...Object.keys(deferred)])
    for (const pathName of Object.keys(normalizeBaselines(cursor.baselines))) {
      const taskDir = taskDirectoryFromRelative(pathName)
      if (taskDir) taskDirs.add(taskDir)
    }
    const dirtyTaskDirs = []
    for (const taskDir of taskDirs) {
      const localState = fileStateFromGroup(localByDir.get(taskDir))
      const deferredState = deferred[taskDir] || null
      if (deferredState) {
        if (sameFileState(localState, deferredState)) continue
        delete nextDeferred[taskDir]
      }
      if (!sameFileState(localState, baselinesForTaskDir(cursor.baselines, taskDir))) {
        dirtyTaskDirs.push(taskDir)
      }
    }
    return {
      dirtyTaskDirs,
      deferred: nextDeferred,
    }
  }

  async _writeTaskDirectory(binding, taskDir, files) {
    const tasksRoot = path.join(binding.repoPath, '.trellis', 'tasks')
    const target = path.resolve(binding.repoPath, ...taskDir.split('/'))
    if (!isInside(tasksRoot, target) || target === path.resolve(tasksRoot)) {
      throw new AgentError(AGENT_ERROR_CODE.INVALID_RESPONSE, '服务端任务目录越界')
    }
    const temporaryRoot = path.join(
      binding.repoPath,
      '.trellis',
      `.agent-sync-${crypto.randomUUID()}`,
    )
    const staged = path.join(temporaryRoot, 'next')
    const backup = path.join(temporaryRoot, 'previous')
    await fs.mkdir(staged, { recursive: true, mode: 0o700 })
    try {
      for (const file of files) {
        const relative = String(file.path)
        if (!relative.startsWith(`${taskDir}/`)) {
          throw new AgentError(AGENT_ERROR_CODE.INVALID_RESPONSE, '任务文件不属于目标目录')
        }
        const filePath = path.join(staged, ...relative.slice(taskDir.length + 1).split('/'))
        if (!isInside(staged, filePath)) {
          throw new AgentError(AGENT_ERROR_CODE.INVALID_RESPONSE, '任务文件路径越界')
        }
        await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
        await fs.writeFile(filePath, normalizeSnapshotText(file.content), 'utf8')
      }
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
      try {
        await fs.rename(target, backup)
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
      try {
        await fs.rename(staged, target)
      } catch (error) {
        try {
          await fs.rename(backup, target)
        } catch {
          // 恢复失败时保留备份目录，交由用户恢复。
        }
        throw error
      }
      await fs.rm(backup, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 50,
      })
    } finally {
      await fs.rm(temporaryRoot, { recursive: true, maxRetries: 3, retryDelay: 50 }).catch(() => {})
    }
  }

  async _removeTaskDirectory(binding, taskDir) {
    const target = path.resolve(binding.repoPath, ...taskDir.split('/'))
    const tasksRoot = path.join(binding.repoPath, '.trellis', 'tasks')
    if (!isInside(tasksRoot, target) || target === path.resolve(tasksRoot)) return
    try {
      await fs.rm(target, { recursive: true, maxRetries: 3, retryDelay: 50 })
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }

  async _backupDirectory(binding, taskDir) {
    const source = path.resolve(binding.repoPath, ...taskDir.split('/'))
    const tasksRoot = path.join(binding.repoPath, '.trellis', 'tasks')
    if (!isInside(tasksRoot, source)) return null
    const backupId = crypto.randomUUID()
    const target = path.join(this.store.paths.liveBackupsDir, binding.taskSpaceId, backupId)
    try {
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
      await fs.cp(source, target, { recursive: true, errorOnExist: true, force: false })
      return { backupId, backupPath: target, taskDir }
    } catch (error) {
      if (error.code === 'ENOENT') return null
      throw error
    }
  }

  _absoluteTaskPath(binding, relativePath) {
    return path.resolve(binding.repoPath, ...String(relativePath).split('/'))
  }

  _rememberSuppressedFiles(binding, entries) {
    for (const [relativePath, sha256] of entries) {
      this.suppressed.set(this._absoluteTaskPath(binding, relativePath), sha256)
    }
  }

  async _suppressedWatcherEvent(binding, relativePath) {
    const absolute = this._absoluteTaskPath(binding, relativePath)
    if (!this.suppressed.has(absolute)) return false
    const expected = this.suppressed.get(absolute)
    this.suppressed.delete(absolute)
    let current = null
    try {
      const content = normalizeSnapshotText(decodeUtf8(await fs.readFile(absolute)))
      current = snapshotSha256(content)
    } catch (error) {
      if (error.code !== 'ENOENT') return false
    }
    return current === expected
  }

  async _conflictDirectories(binding, api, taskSpaceId, conflict) {
    const parsed = conflictTaskDirectories(conflict.taskDir)
    const directoryCandidates = [
      ...new Set(
        [parsed.local, parsed.server]
          .filter(Boolean)
          .concat(
            (conflict.files || [])
              .map((file) => taskDirectoryFromRelative(file.path))
              .filter(Boolean),
          ),
      ),
    ]
    let local = parsed.local
    for (const taskDir of directoryCandidates) {
      const files = await this._localFiles(binding, new Set([taskDir]))
      if (files.length) {
        local = taskDir
        break
      }
    }
    let server = parsed.server
    let serverFiles = []
    for (const taskDir of directoryCandidates) {
      const directory = await api.fetchTaskDirectory(taskSpaceId, taskDir)
      if (directory.files?.length) {
        server = taskDir
        serverFiles = directory.files
        break
      }
    }
    return { local, server, serverFiles }
  }

  async _applyServerGroups(
    binding,
    revision,
    groups,
    mode = 'safe',
    { persistCursor = true } = {},
  ) {
    let changed = false
    for (const group of groups) {
      const previousFiles = await this._localFiles(binding, new Set([group.taskDir]))
      if (group.files.length === 0) {
        if (mode === 'incremental') {
          this._rememberSuppressedFiles(
            binding,
            previousFiles.map((file) => [file.path, null]),
          )
          await this._removeTaskDirectory(binding, group.taskDir)
          changed = true
        }
        continue
      }
      await this._backupDirectory(binding, group.taskDir)
      await this._writeTaskDirectory(binding, group.taskDir, group.files)
      const nextPaths = new Set(group.files.map((file) => file.path))
      this._rememberSuppressedFiles(
        binding,
        previousFiles.filter((file) => !nextPaths.has(file.path)).map((file) => [file.path, null]),
      )
      for (const file of group.files) {
        this._rememberSuppressedFiles(binding, [[file.path, snapshotSha256(file.content)]])
      }
      changed = true
    }
    if (changed && persistCursor) {
      await this._writeCursor(binding.taskSpaceId, { revision })
    }
  }

  async _pullInitialSync(binding, snapshot) {
    const { api } = await this.loadContext()
    const allFileGroups = { maxFiles: Number.POSITIVE_INFINITY, maxBytes: Number.POSITIVE_INFINITY }
    const localGroups = groupTaskSnapshotFiles(await this._localFiles(binding), allFileGroups)
    const serverGroups = groupTaskSnapshotFiles(
      (snapshot.files || []).filter((file) => !file.deleted),
      allFileGroups,
    )
    const serverBaselines = baselinesFromSnapshot(snapshot.files)
    const differences = classifyTaskSnapshots(localGroups, serverGroups)
    const actionable = differences.filter((item) => item.type !== 'same')
    const mode = initialSyncModeFor(binding)

    if (mode === 'review' && actionable.length) {
      this.emitControl({
        type: 'initial_sync_review',
        taskSpaceId: binding.taskSpaceId,
        revision: snapshot.revision,
        differences: controlDifferences(differences),
      })
      return {
        conflicts: actionable.filter((item) =>
          new Set(['content-conflict', 'move-delete-conflict', 'invalid']).has(item.type),
        ),
        differences,
        revision: snapshot.revision,
        pendingReview: true,
      }
    }

    let latestRevision = Number(snapshot.revision || 0)
    let completionBaselines = { ...serverBaselines }
    let deferred = {}
    if (mode === 'bootstrap') {
      const blocking = actionable.filter((item) => item.type !== 'local-only')
      if (blocking.length) {
        this.emitControl({
          type: 'initial_sync_review',
          taskSpaceId: binding.taskSpaceId,
          revision: snapshot.revision,
          differences: controlDifferences(differences),
        })
        return {
          conflicts: actionable.filter((item) =>
            new Set(['content-conflict', 'move-delete-conflict', 'invalid']).has(item.type),
          ),
          differences,
          revision: snapshot.revision,
          pendingReview: true,
        }
      }
      const localOnlyDirectories = differences
        .filter((item) => item.type === 'local-only')
        .map((item) => item.local?.taskDir)
        .filter(Boolean)
      if (localOnlyDirectories.length) {
        const uploaded = await this._uploadDirectories(binding, localOnlyDirectories, {
          reconcile: false,
        })
        if (uploaded?.code === 'TASK_FILE_CONFLICT') {
          return {
            conflicts: [uploaded],
            differences,
            revision: snapshot.revision,
            pendingReview: true,
          }
        }
        latestRevision = Math.max(latestRevision, Number(uploaded.revision || 0))
        completionBaselines = mergeSnapshotBaselines(completionBaselines, uploaded.baselineFiles)
      }
    } else if (mode === 'safe') {
      const serverOnly = differences
        .filter((item) => item.type === 'server-only')
        .map((item) => item.server)
        .filter(Boolean)
      await this._applyServerGroups(binding, snapshot.revision, serverOnly, 'safe', {
        persistCursor: false,
      })
      for (const difference of actionable) {
        if (difference.type === 'server-only' || !difference.local) continue
        deferred[difference.local.taskDir] = fileStateFromGroup(difference.local)
      }
    }

    if (mode === 'bootstrap') {
      const verifiedSnapshot = await api.fetchTaskSpaceSnapshot(binding.taskSpaceId, {
        afterRevision: 0,
      })
      const verifiedLocalGroups = groupTaskSnapshotFiles(
        await this._localFiles(binding),
        allFileGroups,
      )
      const verifiedServerGroups = groupTaskSnapshotFiles(
        (verifiedSnapshot.files || []).filter((file) => !file.deleted),
        allFileGroups,
      )
      const verifiedDifferences = classifyTaskSnapshots(verifiedLocalGroups, verifiedServerGroups)
      const unresolved = verifiedDifferences.filter((item) => item.type !== 'same')
      if (unresolved.length) {
        this.emitControl({
          type: 'initial_sync_review',
          taskSpaceId: binding.taskSpaceId,
          revision: verifiedSnapshot.revision,
          differences: controlDifferences(verifiedDifferences),
        })
        return {
          conflicts: verifiedDifferences.filter((item) =>
            new Set(['content-conflict', 'move-delete-conflict', 'invalid']).has(item.type),
          ),
          differences: verifiedDifferences,
          revision: verifiedSnapshot.revision,
          pendingReview: true,
        }
      }
      latestRevision = Math.max(latestRevision, Number(verifiedSnapshot.revision || 0))
      completionBaselines = baselinesFromSnapshot(verifiedSnapshot.files)
    }

    await this._writeCursor(binding.taskSpaceId, {
      revision: latestRevision,
      baselines: completionBaselines,
      deferred,
    })
    await api.writeTaskSpaceCursor(binding.taskSpaceId, { revision: latestRevision })
    await this._completeInitialSync(binding.taskSpaceId, mode)
    return {
      conflicts: [],
      differences,
      revision: latestRevision,
      pendingReview: false,
    }
  }

  async _pull(binding) {
    const { api } = await this.loadContext()
    let cursorBefore = await this._readCursor(binding.taskSpaceId)
    const initialSync = binding.initialSyncCompleted === false
    if (cursorBefore.pending) {
      const retried = await this._retryPendingBatch(binding, api, cursorBefore)
      if (retried?.conflict) {
        return {
          conflicts: [retried.result],
          revision: cursorBefore.revision,
          pendingReview: true,
        }
      }
      cursorBefore = await this._readCursor(binding.taskSpaceId)
    }
    const effectiveAfterRevision = initialSync ? 0 : cursorBefore.revision
    const snapshot = await api.fetchTaskSpaceSnapshot(binding.taskSpaceId, {
      afterRevision: effectiveAfterRevision,
    })
    if (initialSync) {
      return this._pullInitialSync(binding, snapshot)
    }
    const serverFiles = (snapshot.files || []).filter((file) => !file.deleted)
    const deletedDirs = new Set(
      (snapshot.files || [])
        .filter((file) => file.deleted)
        .map((file) => file.taskDir)
        .filter(Boolean),
    )
    const allFileGroups = { maxFiles: Number.POSITIVE_INFINITY, maxBytes: Number.POSITIVE_INFINITY }
    const serverGroups = groupTaskSnapshotFiles(serverFiles, allFileGroups)
    const snapshotBaselines =
      effectiveAfterRevision === 0
        ? baselinesFromSnapshot(snapshot.files)
        : mergeSnapshotBaselines(cursorBefore.baselines, snapshot.files)
    let latestRevision = Number(snapshot.revision || 0)
    let baselineFiles = []
    const localSync = await this._localSyncState(binding, cursorBefore)
    if (!sameFileState({ ...cursorBefore.deferred }, { ...localSync.deferred })) {
      await this._writeCursor(binding.taskSpaceId, { deferred: localSync.deferred })
      cursorBefore = await this._readCursor(binding.taskSpaceId)
    }
    if (localSync.dirtyTaskDirs.length) {
      const uploaded = await this._uploadDirectories(binding, localSync.dirtyTaskDirs, {
        reconcile: false,
      })
      if (uploaded?.code === 'TASK_FILE_CONFLICT') {
        return {
          conflicts: [uploaded],
          revision: cursorBefore.revision,
          pendingReview: true,
        }
      }
      const nextCursor = await this._readCursor(binding.taskSpaceId)
      return this._pull(binding)
    }
    if (effectiveAfterRevision === 0) {
      const localGroups = groupTaskSnapshotFiles(await this._localFiles(binding), allFileGroups)
      const differences = classifyTaskSnapshots(localGroups, serverGroups)
      const conflicts = differences.filter((item) =>
        new Set(['content-conflict', 'move-delete-conflict', 'invalid']).has(item.type),
      )
      if (binding.initialReviewPending === true || conflicts.length) {
        this.emitControl({
          type: 'initial_sync_review',
          taskSpaceId: binding.taskSpaceId,
          revision: snapshot.revision,
          differences: controlDifferences(differences),
        })
        return {
          conflicts,
          differences,
          revision: snapshot.revision,
          pendingReview: true,
        }
      }
      await this._applyServerGroups(
        binding,
        snapshot.revision,
        serverGroups.filter((group) =>
          differences.some(
            (item) => item.type === 'server-only' && item.server?.taskDir === group.taskDir,
          ),
        ),
        'safe',
        { persistCursor: false },
      )
      const localOnlyDirectories = differences
        .filter((item) => item.type === 'local-only')
        .map((item) => item.local?.taskDir)
        .filter((taskDir) => taskDir && !localSync.deferred[taskDir])
      if (localOnlyDirectories.length) {
        const uploaded = await this._uploadDirectories(binding, localOnlyDirectories, {
          reconcile: false,
        })
        if (uploaded?.code === 'TASK_FILE_CONFLICT') {
          return {
            conflicts: [uploaded],
            differences,
            revision: snapshot.revision,
            pendingReview: true,
          }
        }
        latestRevision = Math.max(latestRevision, Number(uploaded.revision || 0))
        baselineFiles.push(...(uploaded.baselineFiles || []))
      }
    } else {
      const changedDirs = new Set([...serverGroups.map((group) => group.taskDir), ...deletedDirs])
      const byDir = new Map()
      for (const taskDir of changedDirs) {
        const directory = await api.fetchTaskDirectory(binding.taskSpaceId, taskDir)
        byDir.set(taskDir, { taskDir, files: directory.files || [] })
      }
      const protectedDirs = new Set(
        Object.keys(cursorBefore.deferred).filter((taskDir) => byDir.has(taskDir)),
      )
      if (protectedDirs.size) {
        const localGroups = groupTaskSnapshotFiles(await this._localFiles(binding), allFileGroups)
        const changedGroups = [...byDir.values()].filter((group) =>
          protectedDirs.has(group.taskDir),
        )
        const differences = classifyTaskSnapshots(
          localGroups.filter((group) => protectedDirs.has(group.taskDir)),
          changedGroups,
        )
        this.emitControl({
          type: 'initial_sync_review',
          taskSpaceId: binding.taskSpaceId,
          revision: snapshot.revision,
          differences: controlDifferences(differences),
        })
        return {
          conflicts: differences.filter((item) =>
            new Set(['content-conflict', 'move-delete-conflict', 'invalid']).has(item.type),
          ),
          differences,
          revision: snapshot.revision,
          pendingReview: true,
        }
      }
      await this._applyServerGroups(
        binding,
        snapshot.revision,
        [...byDir.values()],
        'incremental',
        {
          persistCursor: false,
        },
      )
    }
    await this._writeCursor(binding.taskSpaceId, {
      revision: latestRevision,
      baselines: mergeSnapshotBaselines(snapshotBaselines, baselineFiles),
    })
    await api.writeTaskSpaceCursor(binding.taskSpaceId, { revision: latestRevision })
    return { conflicts: [], revision: latestRevision }
  }

  async pullTaskSpace(taskSpaceId) {
    const binding = this._binding(taskSpaceId)
    return this._enqueue(taskSpaceId, () => this._pull(binding))
  }

  async _uploadDirty(taskSpaceId, dirtyPaths) {
    const binding = this._binding(taskSpaceId)
    const taskDirs = new Set()
    for (const dirtyPath of dirtyPaths) {
      const taskDir = taskDirectoryFromRelative(dirtyPath)
      if (!taskDir) continue
      if (await this._suppressedWatcherEvent(binding, dirtyPath)) continue
      taskDirs.add(taskDir)
    }
    if (!taskDirs.size) return
    return this._uploadDirectories(binding, [...taskDirs])
  }

  async _runUploadWithSlot(taskSpaceId, minimumDelayMs, operation) {
    const previous = this.uploadGates.get(taskSpaceId) || Promise.resolve()
    const current = previous
      .catch(() => {})
      .then(async () => {
        const now = Date.now()
        const readyAt = Math.max(now + minimumDelayMs, this.nextUploadAt.get(taskSpaceId) || 0)
        if (readyAt > now) {
          await wait(readyAt - now)
        }
        try {
          return await operation()
        } finally {
          this.nextUploadAt.set(taskSpaceId, Date.now() + UPLOAD_MIN_INTERVAL_MS)
        }
      })
    this.uploadGates.set(taskSpaceId, current)
    try {
      return await current
    } finally {
      if (this.uploadGates.get(taskSpaceId) === current) {
        this.uploadGates.delete(taskSpaceId)
      }
    }
  }

  async _uploadBatch(binding, api, batch) {
    let result
    let retryDelayMs = 0
    const request = {
      batchId: batch.batchId,
      clientSequence: batch.clientSequence,
      files: batch.files,
    }
    for (let retryCount = 0; ; retryCount += 1) {
      try {
        result = await this._runUploadWithSlot(binding.taskSpaceId, retryDelayMs, () =>
          api.uploadTaskSpaceChanges(binding.taskSpaceId, request),
        )
        break
      } catch (error) {
        const conflict = taskConflictFromError(error)
        if (conflict) {
          result = conflict
          break
        }
        if (!isRateLimitError(error) || retryCount >= MAX_RATE_LIMIT_RETRIES) throw error
        retryDelayMs = rateLimitRetryDelay(error)
      }
    }
    const cursor = await this._readCursor(binding.taskSpaceId)
    if (result.code === 'TASK_FILE_CONFLICT') {
      await this._writeCursor(binding.taskSpaceId, {
        revision: cursor.revision,
        sequence: batch.clientSequence,
        deferred: clearDeferredForFiles(cursor.deferred, batch.files),
        pending: null,
      })
      this.emitControl({
        type: 'task_file_conflict',
        taskSpaceId: binding.taskSpaceId,
        conflict: conflictSummary(result),
      })
      return { result, conflict: true }
    }
    const revision = Math.max(cursor.revision, Number(result.revision || 0))
    const baselines = mergeSnapshotBaselines(cursor.baselines, batch.files)
    await this._writeCursor(binding.taskSpaceId, {
      revision,
      sequence: batch.clientSequence,
      baselines,
      deferred: clearDeferredForFiles(cursor.deferred, batch.files),
      pending: null,
    })
    return {
      result,
      conflict: false,
      revision,
      baselines,
      baselineFiles: batch.files,
    }
  }

  async _uploadPersistedBatch(binding, api, cursor, files) {
    if (!files.length) return null
    const batch = {
      batchId: crypto.randomUUID(),
      clientSequence: cursor.sequence + 1,
      files,
    }
    // 先持久化原始批次，网络响应丢失时必须复用同一 batchId。
    await this._writeCursor(binding.taskSpaceId, {
      revision: cursor.revision,
      sequence: cursor.sequence,
      pending: batch,
    })
    return this._uploadBatch(binding, api, batch)
  }

  async _retryPendingBatch(binding, api, cursor) {
    if (!cursor.pending) return null
    return this._uploadBatch(binding, api, cursor.pending)
  }

  _filesForDirectory(taskDir, localGroup, serverFiles, baseShaByPath) {
    const current = new Map((serverFiles || []).map((file) => [file.path, file.sha256]))
    const local = localGroup || { taskDir, files: [] }
    const localPaths = new Set(local.files.map((file) => file.path))
    const baselines = normalizeBaselines(baseShaByPath)
    const files = local.files.map((file) => ({
      path: file.path,
      content: file.content,
      sha256: file.sha256,
      baseSha256: Object.hasOwn(baselines, file.path) ? baselines[file.path] : null,
    }))
    for (const pathName of current.keys()) {
      if (!localPaths.has(pathName)) {
        files.push({
          path: pathName,
          content: '',
          deleted: true,
          baseSha256: Object.hasOwn(baselines, pathName) ? baselines[pathName] : null,
        })
      }
    }
    return files
  }

  _movePair(entries) {
    const sources = entries.filter(
      (entry) => !entry.local?.files?.length && entry.serverFiles.length,
    )
    const targets = entries.filter(
      (entry) => entry.local?.files?.length && !entry.serverFiles.length,
    )
    const pairs = []
    for (const source of sources) {
      const taskId = source.serverFiles.find((file) => file.path.endsWith('/task.json'))?.taskId
      const target = taskId ? targets.find((entry) => entry.local?.taskId === taskId) : null
      if (target) pairs.push([source, target])
    }
    return pairs
  }

  async _uploadDirectories(binding, taskDirs, { reconcile = true, baseShaByPath = null } = {}) {
    const { api } = await this.loadContext()
    let cursor = await this._readCursor(binding.taskSpaceId)
    let latestRevision = cursor.revision
    let baselineFiles = []
    const retryFiles = cursor.pending?.files || []
    const retried = await this._retryPendingBatch(binding, api, cursor)
    if (retried) {
      if (retried.conflict) return retried.result
      latestRevision = Math.max(latestRevision, Number(retried.revision || 0))
      baselineFiles.push(...retryFiles)
      cursor = await this._readCursor(binding.taskSpaceId)
    }

    const allLocal = groupTaskSnapshotFiles(await this._localFiles(binding), {
      maxFiles: Number.POSITIVE_INFINITY,
      maxBytes: Number.POSITIVE_INFINITY,
    })
    const localByDir = new Map(allLocal.map((group) => [group.taskDir, group]))
    const entries = []
    for (const taskDir of new Set(taskDirs)) {
      const server = await api.fetchTaskDirectory(binding.taskSpaceId, taskDir)
      entries.push({
        taskDir,
        local: localByDir.get(taskDir) || null,
        serverFiles: server.files || [],
      })
    }

    const handled = new Set()
    for (const [source, target] of this._movePair(entries)) {
      const files = [
        ...this._filesForDirectory(
          source.taskDir,
          null,
          source.serverFiles,
          baseShaByPath ?? cursor.baselines,
        ),
        ...this._filesForDirectory(
          target.taskDir,
          target.local,
          target.serverFiles,
          baseShaByPath ?? cursor.baselines,
        ),
      ]
      const uploaded = await this._uploadPersistedBatch(binding, api, cursor, files)
      if (!uploaded) continue
      if (uploaded.conflict) return uploaded.result
      handled.add(source.taskDir)
      handled.add(target.taskDir)
      latestRevision = Math.max(latestRevision, Number(uploaded.revision || 0))
      baselineFiles.push(...files)
      cursor = await this._readCursor(binding.taskSpaceId)
    }

    for (const entry of entries) {
      if (handled.has(entry.taskDir)) continue
      const files = this._filesForDirectory(
        entry.taskDir,
        entry.local,
        entry.serverFiles,
        baseShaByPath ?? cursor.baselines,
      )
      const uploaded = await this._uploadPersistedBatch(binding, api, cursor, files)
      if (!uploaded) continue
      if (uploaded.conflict) return uploaded.result
      latestRevision = Math.max(latestRevision, Number(uploaded.revision || 0))
      baselineFiles.push(...files)
      cursor = await this._readCursor(binding.taskSpaceId)
    }
    if (reconcile) {
      await this._pull(binding)
    }
    return {
      revision: latestRevision,
      sequence: cursor.sequence,
      baselineFiles,
    }
  }

  async syncTaskDirectories(taskSpaceId, taskDirs, options = {}) {
    const binding = this._binding(taskSpaceId)
    return this._enqueue(binding.taskSpaceId, () =>
      this._uploadDirectories(binding, taskDirs, options),
    )
  }

  async syncDeferredTasks(taskSpaceId) {
    const binding = this._binding(taskSpaceId)
    if (binding.readOnly) {
      throw new AgentError(AGENT_ERROR_CODE.COMMAND_INVALID, '只读关联不能上传本地任务')
    }
    let failure = null
    const result = await this._enqueue(binding.taskSpaceId, async () => {
      try {
        const cursor = await this._readCursor(binding.taskSpaceId)
        const taskDirs = Object.keys(cursor.deferred)
        if (!taskDirs.length) {
          return {
            taskSpaceId: binding.taskSpaceId,
            syncedCount: 0,
            remainingCount: 0,
            remainingTaskDirs: [],
            conflict: false,
          }
        }

        const uploaded = await this._uploadDirectories(binding, taskDirs)
        const nextCursor = await this._readCursor(binding.taskSpaceId)
        const remainingTaskDirs = Object.keys(nextCursor.deferred).sort()
        const conflict = uploaded?.code === 'TASK_FILE_CONFLICT'
        return {
          taskSpaceId: binding.taskSpaceId,
          syncedCount: conflict ? 0 : Math.max(0, taskDirs.length - remainingTaskDirs.length),
          remainingCount: remainingTaskDirs.length,
          remainingTaskDirs,
          conflict,
          conflictId: conflict ? uploaded.conflictId || null : null,
        }
      } catch (error) {
        // _enqueue 默认吞掉异常并发出控制事件；显式操作仍需把失败返回给 Tauri。
        failure = error
        throw error
      }
    })
    if (failure) throw failure
    return result
  }

  async _completeInitialSync(taskSpaceId, mode) {
    const completedAt = new Date().toISOString()
    const binding = this.bindings.get(taskSpaceId)
    if (binding) {
      this.bindings.set(taskSpaceId, {
        ...binding,
        initialSyncMode: mode,
        initialSyncCompleted: true,
        initialReviewPending: false,
        liveSyncStatus: 'ready',
        liveSyncError: null,
        lastSyncedAt: completedAt,
      })
    }
    await this.store.updateConfig((config) => ({
      ...config,
      bindings: config.bindings.map((item) =>
        item.taskSpaceId === taskSpaceId
          ? {
              ...item,
              initialSyncMode: mode,
              initialSyncCompleted: true,
              initialReviewPending: false,
              liveSyncStatus: 'ready',
              liveSyncError: null,
              lastSyncedAt: completedAt,
            }
          : item,
      ),
    }))
    if (!this.stopped) this.updateBindings([...this.bindings.values()])
  }

  async _uploadReviewedLocalTask(binding, localGroup, serverGroup) {
    const { api } = await this.loadContext()
    const localDir = localGroup?.taskDir
    if (!localDir || !localGroup.files.length) {
      throw new AgentError(
        AGENT_ERROR_CODE.INVALID_RESPONSE,
        '本地任务目录不存在，无法使用本地版本',
      )
    }
    const reviewedBaselines = baselinesFromSnapshot(serverGroup?.files || [])
    if (localDir === serverGroup?.taskDir) {
      return this._uploadDirectories(binding, [localDir], {
        reconcile: false,
        baseShaByPath: reviewedBaselines,
      })
    }
    const serverDir = serverGroup?.taskDir
    const server = serverDir
      ? await api.fetchTaskDirectory(binding.taskSpaceId, serverDir)
      : { files: [] }
    const cursor = await this._readCursor(binding.taskSpaceId)
    const files = localGroup.files.map((file) => ({
      path: file.path,
      content: file.content,
      sha256: file.sha256,
      baseSha256: null,
    }))
    for (const file of server.files || []) {
      files.push({
        path: file.path,
        content: '',
        deleted: true,
        baseSha256: file.sha256,
      })
    }
    const uploaded = await this._uploadPersistedBatch(binding, api, cursor, files)
    return uploaded?.result
  }

  async resolveInitialSync({ taskSpaceId, mode = 'safe', decisions = [] }) {
    if (!new Set(['safe', 'review']).has(mode)) {
      throw new AgentError(AGENT_ERROR_CODE.COMMAND_INVALID, '首次同步处理方式无效')
    }
    const binding = this._binding(taskSpaceId)
    const { api } = await this.loadContext()
    const snapshot = await api.fetchTaskSpaceSnapshot(binding.taskSpaceId, {
      afterRevision: 0,
    })
    const allFileGroups = { maxFiles: Number.POSITIVE_INFINITY, maxBytes: Number.POSITIVE_INFINITY }
    const localGroups = groupTaskSnapshotFiles(await this._localFiles(binding), allFileGroups)
    const serverGroups = groupTaskSnapshotFiles(
      (snapshot.files || []).filter((file) => !file.deleted),
      allFileGroups,
    )
    const snapshotBaselines = baselinesFromSnapshot(snapshot.files)
    const differences = classifyTaskSnapshots(localGroups, serverGroups)
    if (mode === 'safe') {
      const serverOnly = differences
        .filter((item) => item.type === 'server-only' && item.server?.taskId)
        .map((item) => item.server)
      await this._applyServerGroups(binding, snapshot.revision, serverOnly, 'safe', {
        persistCursor: false,
      })
      const deferred = {}
      for (const difference of differences) {
        if (difference.type === 'same' || difference.type === 'server-only' || !difference.local) {
          continue
        }
        deferred[difference.local.taskDir] = fileStateFromGroup(difference.local)
      }
      await this._writeCursor(binding.taskSpaceId, {
        revision: snapshot.revision,
        baselines: snapshotBaselines,
        deferred,
      })
      await api.writeTaskSpaceCursor(binding.taskSpaceId, {
        revision: snapshot.revision,
      })
      await this._completeInitialSync(taskSpaceId, mode)
      return {
        taskSpaceId,
        mode,
        revision: snapshot.revision,
        downloaded: serverOnly.length,
        skipped: differences.filter((item) => item.type !== 'same').length - serverOnly.length,
      }
    }

    const decisionMap = new Map(
      decisions.map((item) => [
        String(item.taskId || item.taskDir || ''),
        String(item.action || 'skip'),
      ]),
    )
    let latestRevision = Number(snapshot.revision || 0)
    let baselineFiles = []
    const deferred = {}
    const counts = { downloaded: 0, uploaded: 0, savedLocal: 0, skipped: 0 }
    for (const difference of differences) {
      if (difference.type === 'same') continue
      const key = String(difference.taskId || difference.taskDir || '')
      const action = decisionMap.get(key) || 'skip'
      const localGroup = difference.local || null
      const serverGroup = difference.server || null
      if (action === 'skip') {
        if (localGroup) {
          deferred[localGroup.taskDir] = fileStateFromGroup(localGroup)
        }
        counts.skipped += 1
        continue
      }
      if (difference.type === 'server-only' || action === 'use-server') {
        if (localGroup && localGroup.taskDir !== serverGroup?.taskDir) {
          await this._backupDirectory(binding, localGroup.taskDir)
        }
        const groups = serverGroup?.files?.length ? [serverGroup] : []
        await this._applyServerGroups(binding, snapshot.revision, groups, 'safe', {
          persistCursor: false,
        })
        if (localGroup && localGroup.taskDir !== serverGroup?.taskDir) {
          await this._removeTaskDirectory(binding, localGroup.taskDir)
        }
        counts.downloaded += 1
        continue
      }
      if (difference.type === 'local-only' || action === 'use-local') {
        if (!localGroup) {
          throw new AgentError(AGENT_ERROR_CODE.INVALID_RESPONSE, '本地任务目录不存在')
        }
        const uploaded = await this._uploadReviewedLocalTask(binding, localGroup, serverGroup)
        latestRevision = Math.max(latestRevision, Number(uploaded.revision || 0))
        baselineFiles.push(...(uploaded.baselineFiles || []))
        counts.uploaded += 1
        continue
      }
      if (action === 'save-local') {
        if (!localGroup) {
          throw new AgentError(AGENT_ERROR_CODE.INVALID_RESPONSE, '本地任务目录不存在')
        }
        await this._backupDirectory(binding, localGroup.taskDir)
        deferred[localGroup.taskDir] = fileStateFromGroup(localGroup)
        counts.savedLocal += 1
      }
    }
    await this._writeCursor(binding.taskSpaceId, {
      revision: latestRevision,
      baselines: mergeSnapshotBaselines(snapshotBaselines, baselineFiles),
      deferred,
    })
    await api.writeTaskSpaceCursor(binding.taskSpaceId, { revision: latestRevision })
    await this._completeInitialSync(taskSpaceId, mode)
    return {
      taskSpaceId,
      mode,
      revision: latestRevision,
      ...counts,
    }
  }

  async decideConflict({ taskSpaceId, conflictId, action, files = null }) {
    const binding = this._binding(taskSpaceId)
    const { api } = await this.loadContext()
    const conflict = (await api.fetchTaskSpaceConflicts(taskSpaceId)).conflicts.find(
      (item) => item.id === conflictId,
    )
    if (!conflict) {
      throw new AgentError(AGENT_ERROR_CODE.INVALID_RESPONSE, '冲突不存在或已处理')
    }
    const directories = await this._conflictDirectories(binding, api, taskSpaceId, conflict)
    if (action === 'use-server') {
      if (!directories.server) {
        throw new AgentError(AGENT_ERROR_CODE.INVALID_RESPONSE, '冲突缺少服务端任务目录')
      }
      if (directories.local && directories.local !== directories.server) {
        await this._backupDirectory(binding, directories.local)
      }
      const snapshot = {
        revision: conflict.serverRevision,
        files: directories.serverFiles,
      }
      await this._applyServerGroups(binding, snapshot.revision, [
        { taskDir: directories.server, files: snapshot.files || [] },
      ])
      if (directories.local && directories.local !== directories.server) {
        await this._removeTaskDirectory(binding, directories.local)
      }
      const cursor = await this._readCursor(taskSpaceId)
      const baselines = { ...cursor.baselines }
      if (directories.local && directories.local !== directories.server) {
        for (const pathName of Object.keys(baselines)) {
          if (pathName.startsWith(`${directories.local}/`)) delete baselines[pathName]
        }
      }
      for (const [pathName, sha256] of Object.entries(
        baselinesFromSnapshot(directories.serverFiles),
      )) {
        baselines[pathName] = sha256
      }
      await this._writeCursor(taskSpaceId, {
        revision: Math.max(cursor.revision, Number(snapshot.revision || 0)),
        baselines,
      })
      return api.resolveTaskSpaceConflict(taskSpaceId, conflictId, { action })
    }
    if (action === 'save-local-copy') {
      if (!directories.local) {
        throw new AgentError(AGENT_ERROR_CODE.INVALID_RESPONSE, '冲突缺少本地任务目录')
      }
      const backup = await this._backupDirectory(binding, directories.local)
      return { conflictId, action, resolved: false, backup }
    }
    if (action !== 'overwrite-server') {
      throw new AgentError(AGENT_ERROR_CODE.COMMAND_INVALID, '冲突处理动作无效')
    }
    let selected = Array.isArray(files) ? files : []
    if (!selected.length) {
      const taskDir = directories.local
      const localGroup = groupTaskSnapshotFiles(
        await this._localFiles(binding, new Set([taskDir])),
      ).find((group) => group.taskDir === taskDir)
      selected = localGroup?.files || []
    }
    if (!selected.length) {
      throw new AgentError(AGENT_ERROR_CODE.COMMAND_INVALID, '覆盖服务端时必须提供本地任务文件')
    }
    const selectedPaths = new Set(selected.map((file) => String(file.path || '')))
    if (directories.server) {
      for (const file of directories.serverFiles || []) {
        if (selectedPaths.has(file.path)) continue
        selected.push({
          path: file.path,
          content: '',
          deleted: true,
          baseSha256: file.sha256,
        })
      }
    }
    const cursor = await this._readCursor(taskSpaceId)
    const backup = await this._backupDirectory(binding, directories.local)
    const result = await api.resolveTaskSpaceConflict(taskSpaceId, conflictId, {
      action,
      batchId: crypto.randomUUID(),
      clientSequence: cursor.sequence + 1,
      files: selected,
    })
    if (result?.code !== 'TASK_FILE_CONFLICT') {
      const nextSequence = cursor.sequence + 1
      const nextRevision = Math.max(cursor.revision, Number(result?.revision || 0))
      await this._writeCursor(taskSpaceId, {
        revision: nextRevision,
        sequence: nextSequence,
        baselines: mergeSnapshotBaselines(cursor.baselines, selected),
        pending: null,
      })
      await api.writeTaskSpaceCursor(taskSpaceId, { revision: nextRevision })
    }
    return { ...result, backup }
  }

  async conflictDetails({ taskSpaceId, conflictId }) {
    const binding = this._binding(taskSpaceId)
    const { api } = await this.loadContext()
    const conflict = (await api.fetchTaskSpaceConflicts(taskSpaceId)).conflicts.find(
      (item) => item.id === conflictId,
    )
    if (!conflict) throw new AgentError(AGENT_ERROR_CODE.INVALID_RESPONSE, '冲突不存在或已处理')
    const bindingDirectories = await this._conflictDirectories(binding, api, taskSpaceId, conflict)
    const directories = {
      local: bindingDirectories.local,
      server: bindingDirectories.server,
      serverFiles: bindingDirectories.serverFiles,
    }
    const localTaskDir = directories.local
    const serverTaskDir = directories.server
    const localFiles = localTaskDir ? await this._localFiles(binding, new Set([localTaskDir])) : []
    const server = { files: directories.serverFiles || [] }
    const conflictFiles = new Map(
      (conflict.files || []).map((file) => [String(file.path || ''), file]),
    )
    const paths = new Set([
      ...localFiles.map((file) => file.path),
      ...(server.files || []).map((file) => file.path),
      ...conflictFiles.keys(),
    ])
    return {
      taskSpaceId,
      conflictId,
      taskId: conflict.taskId || null,
      taskTitle: conflict.taskTitle || conflict.taskId || conflict.taskDir || '任务',
      taskDir: conflict.taskDir || null,
      localTaskDir: localTaskDir || null,
      serverTaskDir: serverTaskDir || null,
      files: [...paths].sort().map((filePath) => {
        const local = localFiles.find((file) => file.path === filePath)
        const remote = (server.files || []).find((file) => file.path === filePath)
        const detail = conflictFiles.get(filePath)
        return {
          path: filePath,
          localContent: local?.content ?? null,
          serverContent: remote?.content ?? null,
          changedBy: detail?.changedBy || remote?.changedBy || null,
        }
      }),
    }
  }
}

export async function restoreLiveBackup({ store, backupId }) {
  const value = String(backupId || '').trim()
  if (!/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw new AgentError(AGENT_ERROR_CODE.INVALID_RESPONSE, '备份 ID 无效')
  }
  const entries = await fs.readdir(store.paths.liveBackupsDir, { withFileTypes: true })
  for (const taskSpace of entries) {
    if (!taskSpace.isDirectory()) continue
    const target = path.join(store.paths.liveBackupsDir, taskSpace.name, value)
    try {
      const stat = await fs.lstat(target)
      if (stat.isDirectory()) return { backupId: value, backupPath: target }
    } catch {
      // 继续查找其他任务空间。
    }
  }
  throw new AgentError(AGENT_ERROR_CODE.INVALID_RESPONSE, '备份不存在')
}
