import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { TextDecoder } from 'node:util'
import { AgentApiClient } from './api.js'
import { createTrellisWatcher } from '../shared/trellis-watcher.js'

const MAX_FILE_BYTES = 1024 * 1024
const MAX_BATCH_FILES = 64
const MAX_BATCH_BYTES = 8 * 1024 * 1024
const WATCH_DEBOUNCE_MS = 250
const EXPECTED_WRITE_MS = 10_000
const RETRY_MS = 5_000
const UNLINK_RETRY_DELAYS_MS = [25, 50, 100, 200, 400]
const TRANSIENT_FILE_LOCK_CODES = new Set(['EACCES', 'EBUSY', 'EPERM'])
const BACKUP_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const SAFE_LOCAL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/
const TEXT_EXTENSIONS = new Set(['.json', '.jsonl', '.md', '.txt', '.yaml', '.yml'])
const utf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function unlinkWithRetry(file) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.unlink(file)
      return
    } catch (error) {
      if (error?.code === 'ENOENT') return
      if (!TRANSIENT_FILE_LOCK_CODES.has(error?.code) || attempt >= UNLINK_RETRY_DELAYS_MS.length) {
        throw error
      }
      await sleep(UNLINK_RETRY_DELAYS_MS[attempt])
    }
  }
}

function isLivePath(value) {
  const relative = String(value || '').replaceAll('\\', '/')
  if (relative === '.trellis/.developer') return true
  if (!relative.startsWith('.trellis/tasks/') && !relative.startsWith('.trellis/workspace/')) {
    return false
  }
  return TEXT_EXTENSIONS.has(path.posix.extname(relative).toLowerCase())
}

function normalizeLiveFilePath(value) {
  const raw = String(value || '')
    .replaceAll('\\', '/')
    .trim()
  if (!raw || raw.includes('\0') || raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) {
    throw new Error('实时文件路径无效')
  }
  const normalized = path.posix.normalize(raw)
  if (
    normalized !== raw ||
    normalized.startsWith('../') ||
    normalized === '..' ||
    (normalized !== '.trellis/.developer' &&
      !normalized.startsWith('.trellis/tasks/') &&
      !normalized.startsWith('.trellis/workspace/'))
  ) {
    throw new Error('实时文件路径越界')
  }
  if (!isLivePath(normalized)) {
    throw new Error('实时文件不是允许的文本文件')
  }
  return normalized
}

function safeProjectPath(root, relativePath) {
  const normalized = path.posix.normalize(String(relativePath || '').replaceAll('\\', '/'))
  if (normalized.startsWith('../') || normalized.startsWith('/') || normalized === '..') {
    throw new Error('实时文件路径越界')
  }
  const target = path.resolve(root, ...normalized.split('/'))
  const relative = path.relative(root, target)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('实时文件路径越界')
  }
  return target
}

async function assertNoSymlink(root, relativePath) {
  let current = root
  for (const part of String(relativePath).replaceAll('\\', '/').split('/')) {
    current = path.join(current, part)
    try {
      if ((await fs.lstat(current)).isSymbolicLink()) {
        throw new Error('实时同步路径不能经过符号链接')
      }
    } catch (error) {
      if (error?.code === 'ENOENT') return
      throw error
    }
  }
}

async function atomicWrite(target, content) {
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
  const temp = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  let handle
  try {
    handle = await fs.open(temp, 'wx', 0o600)
    await handle.writeFile(content, 'utf8')
    await handle.sync()
    await handle.close()
    handle = null
    await fs.rename(temp, target)
  } catch (error) {
    await handle?.close().catch(() => {})
    await fs.unlink(temp).catch(() => {})
    throw error
  }
}

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    return fallback
  }
}

function publicBinding(binding) {
  return {
    localId: binding.localId,
    serverBindingId: binding.serverBindingId,
    projectId: binding.projectId,
    localRepoKey: binding.localRepoKey,
    remoteIdentityKey: binding.remoteIdentityKey,
    displayName: binding.displayName,
    branchName: binding.branchName,
    teamId: binding.teamId ?? null,
    readOnly: binding.readOnly === true,
    status: binding.syncStatus,
  }
}

function taskKeysFromFiles(projectId, files) {
  return [
    ...new Set(
      files.flatMap((file) => {
        const relative = String(file.path || '')
        if (!relative.startsWith('.trellis/tasks/')) return []
        const rest = relative.slice('.trellis/tasks/'.length).split('/')
        const dir =
          rest[0] === 'archive'
            ? rest.length >= 3
              ? `.trellis/tasks/archive/${rest[1]}/${rest[2]}`
              : null
            : rest.length >= 2
              ? `.trellis/tasks/${rest[0]}`
              : null
        return dir ? [`${projectId}::${dir}`] : []
      }),
    ),
  ]
}

function splitLiveBatches(projectId, files) {
  const groups = new Map()
  for (const file of files) {
    const key = taskKeysFromFiles(projectId, [file])[0] || '__project__'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(file)
  }
  const batches = []
  for (const group of groups.values()) {
    let batch = []
    let bytes = 0
    for (const file of group) {
      const fileBytes =
        file.operation === 'delete'
          ? 0
          : Buffer.byteLength(JSON.stringify(String(file.content || '')), 'utf8')
      if (
        batch.length >= MAX_BATCH_FILES ||
        (batch.length && bytes + fileBytes > MAX_BATCH_BYTES)
      ) {
        batches.push(batch)
        batch = []
        bytes = 0
      }
      batch.push(file)
      bytes += fileBytes
    }
    if (batch.length) batches.push(batch)
  }
  return batches
}

function gitHeadFile(binding, relativePath) {
  const result = spawnSync('git', ['show', `HEAD:${relativePath}`], {
    cwd: binding.repoPath,
    encoding: 'utf8',
    maxBuffer: MAX_FILE_BYTES + 1,
    windowsHide: true,
  })
  return result.status === 0 ? result.stdout : null
}

export class AgentLiveSync {
  constructor(options = {}) {
    this.store = options.store
    this.loadContext = options.loadContext
    this.logger = options.logger
    this.emitControl = options.emitControl || (() => {})
    this.watch = options.watch
    this.debounceMs = options.debounceMs ?? WATCH_DEBOUNCE_MS
    this.expectedWrites = new Map()
    this.bindings = new Map()
    this.pullInFlight = new Map()
    this.projectQueues = new Map()
    this.liveCursors = {}
    this.clientSequence = Date.now()
    this.watcher = null
    this.retryTimer = null
    this.closed = false
  }

  async start() {
    await this._loadLiveCursors()
    await this.cleanupBackups()
    const { config } = await this.loadContext()
    this.updateBindings(config.bindings)
    await this._emitPendingDecisions()
    this.retryTimer = setInterval(() => {
      void this.retryPendingUploads()
    }, RETRY_MS)
    this.retryTimer.unref?.()
  }

  notifyControl(event) {
    this.emitControl(event)
  }

  stop() {
    this.closed = true
    this.watcher?.close()
    this.watcher = null
    if (this.retryTimer) clearInterval(this.retryTimer)
    this.retryTimer = null
  }

  async _emitPendingDecisions() {
    let entries
    try {
      entries = await fs.readdir(this.store.paths.pendingLiveDir)
    } catch {
      return
    }
    const now = new Date().toISOString()
    for (const name of entries) {
      if (!name.endsWith('.json')) continue
      const file = path.join(this.store.paths.pendingLiveDir, name)
      const pending = await readJson(file, null)
      if (!pending || pending.kind !== 'decision') continue
      if (pending.warning?.expiresAt && pending.warning.expiresAt <= now) {
        await fs.unlink(file).catch(() => {})
        continue
      }
      this.emitControl({
        type: 'assignment_warning',
        pendingId: pending.batchId,
        projectId: pending.projectId,
        task: pending.warning?.task,
        assignee: pending.warning?.assignee,
        expiresAt: pending.warning?.expiresAt,
      })
    }
  }

  updateBindings(bindings) {
    if (this.closed) return
    const next = new Map()
    for (const binding of bindings || []) {
      if (binding.syncStatus === 'approved' && binding.teamId && binding.readOnly !== true) {
        next.set(binding.projectId, binding)
      }
    }
    const signature = [...next.values()]
      .map((binding) => `${binding.projectId}:${binding.repoPath}:${binding.serverBindingId}`)
      .sort()
      .join('|')
    const previous = [...this.bindings.values()]
      .map((binding) => `${binding.projectId}:${binding.repoPath}:${binding.serverBindingId}`)
      .sort()
      .join('|')
    this.bindings = next
    if (signature === previous && this.watcher) return
    this.watcher?.close()
    this.watcher = createTrellisWatcher({
      repositories: [...next.values()].map((binding) => ({
        id: binding.projectId,
        name: binding.displayName,
        path: binding.repoPath,
      })),
      debounceMs: this.debounceMs,
      watch: this.watch,
      onChange: (events) => {
        void this._handleWatcherEvents(events)
      },
      onError: (error) => {
        this.logger?.warn('本地实时监听失败', error)
      },
    })
  }

  async _loadLiveCursors() {
    const payload = await readJson(this.store.paths.liveCursorsFile, null)
    this.liveCursors = {}
    if (payload?.schemaVersion !== 1 || !payload.cursors) return
    for (const [projectId, value] of Object.entries(payload.cursors)) {
      const revision = Number(value?.revision)
      if (Number.isSafeInteger(revision) && revision >= 0) {
        this.liveCursors[projectId] = revision
      }
    }
  }

  async _writeLiveCursor(projectId, revision) {
    const current = Number(this.liveCursors[projectId] || 0)
    if (current >= revision) return
    this.liveCursors[projectId] = revision
    const payload = {
      schemaVersion: 1,
      cursors: Object.fromEntries(
        Object.entries(this.liveCursors).map(([id, value]) => [
          id,
          { revision: value, updatedAt: new Date().toISOString() },
        ]),
      ),
    }
    await this.store.writeAtomic(
      this.store.paths.liveCursorsFile,
      `${JSON.stringify(payload, null, 2)}\n`,
    )
  }

  async _loadExternalSuppressions() {
    const payload = await readJson(this.store.paths.liveSuppressionFile, null)
    if (payload?.schemaVersion !== 1 || !payload.entries) return
    const now = Date.now()
    for (const [target, value] of Object.entries(payload.entries)) {
      const expiresAt = Number(value?.expiresAt || 0)
      if (expiresAt <= now) continue
      this.expectedWrites.set(target, {
        sha256: String(value.sha256 || ''),
        expiresAt,
      })
    }
  }

  async _recordSuppression(binding, files) {
    await recordSuppression(this.store, binding, files)
  }

  _binding(projectId) {
    return this.bindings.get(projectId) || null
  }

  async _fileDescriptor(binding, trellisPath) {
    if (!isLivePath(trellisPath)) return null
    const target = safeProjectPath(binding.repoPath, trellisPath)
    await assertNoSymlink(binding.repoPath, trellisPath)
    const expected = this.expectedWrites.get(target)
    let content
    try {
      const stat = await fs.lstat(target)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) return null
      const bytes = await fs.readFile(target)
      try {
        content = utf8Decoder.decode(bytes)
      } catch {
        this.logger?.warn('忽略非 UTF-8 实时文件', { path: trellisPath })
        return null
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      if (expected && expected.expiresAt > Date.now() && expected.sha256 === sha256('')) {
        return null
      }
      const file = {
        path: trellisPath,
        operation: 'delete',
        sha256: sha256(''),
      }
      if (expected) this.expectedWrites.delete(target)
      return file
    }
    const digest = sha256(Buffer.from(content, 'utf8'))
    if (expected) {
      if (expected.expiresAt > Date.now() && expected.sha256 === digest) return null
      this.expectedWrites.delete(target)
    }
    return {
      path: trellisPath,
      operation: 'upsert',
      sha256: digest,
      content,
    }
  }

  async _handleWatcherEvents(events) {
    if (this.closed) return
    const byProject = new Map()
    for (const event of events) {
      if (!event?.trellisPath) continue
      if (!byProject.has(event.repositoryId)) byProject.set(event.repositoryId, new Set())
      byProject.get(event.repositoryId).add(event.trellisPath)
    }
    await Promise.all(
      [...byProject].map(([projectId, paths]) => this._enqueueProject(projectId, paths)),
    )
  }

  _enqueueProject(projectId, paths) {
    const previous = this.projectQueues.get(projectId) || Promise.resolve()
    const current = previous.catch(() => {}).then(() => this._processProjectPaths(projectId, paths))
    this.projectQueues.set(projectId, current)
    current
      .finally(() => {
        if (this.projectQueues.get(projectId) === current) {
          this.projectQueues.delete(projectId)
        }
      })
      .catch(() => {})
    return current
  }

  async _processProjectPaths(projectId, paths) {
    if (this.closed) return
    await this._loadExternalSuppressions()
    const binding = this._binding(projectId)
    if (!binding) return
    let files = []
    try {
      for (const relativePath of paths) {
        const descriptor = await this._fileDescriptor(binding, relativePath)
        if (descriptor) files.push(descriptor)
      }
      if (!files.length) return
    } catch (error) {
      this.logger?.warn('本地实时变化上报失败，稍后重试', error)
      for (const batchFiles of splitLiveBatches(binding.projectId, files)) {
        await this._persistUpload(binding, batchFiles, null).catch(() => {})
      }
      return
    }
    for (const batchFiles of splitLiveBatches(binding.projectId, files)) {
      if (this.closed) return
      try {
        await this._submitOrWait(binding, batchFiles)
      } catch (error) {
        this.logger?.warn('本地实时变化上报失败，稍后重试', error)
      }
    }
  }

  _batch(binding, files, warning = null) {
    this.clientSequence += 1
    return {
      kind: warning ? 'decision' : 'upload',
      createdAt: new Date().toISOString(),
      projectId: binding.projectId,
      bindingId: binding.serverBindingId,
      batchId: warning?.batchId || crypto.randomUUID(),
      clientSequence: this.clientSequence,
      observedAt: new Date().toISOString(),
      files,
      warning,
    }
  }

  async _persistUpload(binding, files, warning) {
    const payload = this._batch(binding, files, warning)
    await this._writePending(payload)
    return payload
  }

  async _writePending(payload) {
    const file = path.join(this.store.paths.pendingLiveDir, `${payload.batchId}.json`)
    await this.store.writeAtomic(file, `${JSON.stringify(payload, null, 2)}\n`)
  }

  async _submitOrWait(binding, files) {
    const { api } = await this.loadContext()
    const batch = this._batch(binding, files)
    // 先持久化原始批次，网络超时后必须用同一个 batchId 重试。
    await this._writePending(batch)
    const preflight = await api.preflightLiveChanges({
      projectId: binding.projectId,
      bindingId: binding.serverBindingId,
      batchId: batch.batchId,
      taskKey: taskKeysFromFiles(binding.projectId, files)[0] || null,
      files,
    })
    if (preflight.requiresConfirmation) {
      const pending = {
        ...batch,
        kind: 'decision',
        warning: {
          warningId: preflight.warningId,
          assignee: preflight.assignee,
          task: preflight.task,
          expiresAt: preflight.expiresAt,
          batchId: batch.batchId,
        },
      }
      await this._writePending(pending)
      this.emitControl({
        type: 'assignment_warning',
        pendingId: pending.batchId,
        projectId: binding.projectId,
        task: preflight.task,
        assignee: preflight.assignee,
        expiresAt: preflight.expiresAt,
      })
      return
    }
    await this._uploadBatch(api, binding, batch, null)
  }

  async _uploadBatch(api, binding, batch, decision) {
    const result = await api.uploadLiveChanges({
      projectId: binding.projectId,
      bindingId: binding.serverBindingId,
      batchId: batch.batchId,
      clientSequence: batch.clientSequence,
      observedAt: batch.observedAt,
      assigneeDecision: decision,
      files: batch.files,
    })
    const pendingFile = path.join(this.store.paths.pendingLiveDir, `${batch.batchId}.json`)
    await unlinkWithRetry(pendingFile).catch((error) => {
      this.logger?.warn('已同步批次清理失败，将在重试时幂等跳过', {
        projectId: binding.projectId,
        batchId: batch.batchId,
        error: error instanceof Error ? error.message : String(error),
      })
    })
    this.logger?.info('实时任务变化已同步', {
      projectId: binding.projectId,
      batchId: batch.batchId,
      revision: result?.revision ?? null,
    })
  }

  async retryPendingUploads() {
    if (this.closed) return
    let entries
    try {
      entries = await fs.readdir(this.store.paths.pendingLiveDir)
    } catch {
      return
    }
    for (const name of entries) {
      if (!name.endsWith('.json')) continue
      const file = path.join(this.store.paths.pendingLiveDir, name)
      const pending = await readJson(file, null)
      if (!pending) continue
      if (pending.kind === 'decision') {
        if (pending.warning?.expiresAt <= new Date().toISOString()) {
          await fs.unlink(file).catch(() => {})
          continue
        }
        this.emitControl({
          type: 'assignment_warning',
          pendingId: pending.batchId,
          projectId: pending.projectId,
          task: pending.warning?.task,
          assignee: pending.warning?.assignee,
          expiresAt: pending.warning?.expiresAt,
        })
        continue
      }
      if (pending.kind !== 'upload') continue
      const binding = this._binding(pending.projectId)
      if (!binding) continue
      try {
        const { api } = await this.loadContext()
        try {
          await this._uploadBatch(api, binding, pending, null)
          continue
        } catch (error) {
          if (error?.serverCode !== 'ASSIGNEE_CONFIRMATION_REQUIRED') {
            throw error
          }
        }
        const preflight = await api.preflightLiveChanges({
          projectId: binding.projectId,
          bindingId: binding.serverBindingId,
          batchId: pending.batchId,
          taskKey: taskKeysFromFiles(binding.projectId, pending.files)[0] || null,
          files: pending.files,
        })
        if (preflight.requiresConfirmation) {
          const next = {
            ...pending,
            kind: 'decision',
            warning: {
              warningId: preflight.warningId,
              assignee: preflight.assignee,
              task: preflight.task,
              expiresAt: preflight.expiresAt,
              batchId: pending.batchId,
            },
          }
          await this.store.writeAtomic(file, `${JSON.stringify(next, null, 2)}\n`)
          this.emitControl({
            type: 'assignment_warning',
            pendingId: pending.batchId,
            projectId: binding.projectId,
            task: preflight.task,
            assignee: preflight.assignee,
            expiresAt: preflight.expiresAt,
          })
          continue
        }
        await this._uploadBatch(api, binding, pending, null)
      } catch {
        // 保留 pending 文件，下一轮继续。
      }
    }
  }

  async pullTeam(teamId) {
    const { config } = await this.loadContext()
    for (const binding of config.bindings.filter(
      (item) => item.teamId === teamId && item.syncStatus === 'approved',
    )) {
      await this.pullProject(teamId, binding.projectId).catch((error) => {
        this.logger?.warn('拉取实时任务变化失败', error)
      })
    }
  }

  async pullProject(teamId, projectId) {
    const previous = this.pullInFlight.get(projectId) || Promise.resolve()
    const current = previous.catch(() => {}).then(() => this._pullProject(teamId, projectId))
    this.pullInFlight.set(projectId, current)
    try {
      return await current
    } finally {
      if (this.pullInFlight.get(projectId) === current) {
        this.pullInFlight.delete(projectId)
      }
    }
  }

  async _pullProject(teamId, projectId) {
    const { config, api } = await this.loadContext()
    const binding = config.bindings.find(
      (item) =>
        item.teamId === teamId && item.projectId === projectId && item.syncStatus === 'approved',
    )
    if (!binding) return null
    const payload = await api.fetchLiveFiles({
      projectId,
      afterRevision: this.liveCursors[projectId] || 0,
    })
    await this._applyRemoteFiles(binding, payload)
    return payload
  }

  async _backupConflicts(binding, revision, files) {
    const conflicts = []
    for (const file of files) {
      const target = safeProjectPath(binding.repoPath, file.path)
      let local = null
      try {
        const stat = await fs.lstat(target)
        if (stat.isFile() && !stat.isSymbolicLink()) local = await fs.readFile(target)
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
      const localSha = local == null ? null : sha256(local)
      const remoteSha = file.operation === 'delete' ? null : file.sha256
      if (localSha !== remoteSha) conflicts.push({ file, local })
    }
    if (!conflicts.length) return null
    const backupId = `${Date.now()}-${revision}-${crypto.randomUUID().slice(0, 8)}`
    const root = path.join(this.store.paths.liveBackupsDir, binding.projectId, backupId)
    const manifestFiles = []
    for (const conflict of conflicts) {
      const relative = conflict.file.path.replace(/^\.trellis\//, '')
      const backupPath = path.join(root, 'files', relative)
      if (conflict.local != null) {
        await atomicWrite(backupPath, conflict.local.toString('utf8'))
      }
      manifestFiles.push({
        path: conflict.file.path,
        localSha256: conflict.local == null ? null : sha256(conflict.local),
        remoteSha256: conflict.file.sha256 || null,
        existedLocally: conflict.local != null,
      })
    }
    const manifest = {
      schemaVersion: 1,
      backupId,
      projectId: binding.projectId,
      revision,
      createdAt: new Date().toISOString(),
      taskKeys: taskKeysFromFiles(binding.projectId, files),
      restoredAt: null,
      files: manifestFiles,
    }
    await this.store.writeAtomic(
      path.join(root, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
    )
    return manifest
  }

  async _applyRemoteFiles(binding, payload) {
    const files = (Array.isArray(payload?.files) ? payload.files : []).map((file) => ({
      ...file,
      path: normalizeLiveFilePath(file.path),
    }))
    const revision = Number(payload?.revision || 0)
    if (!files.length) {
      await this._writeLiveCursor(binding.projectId, revision)
      return
    }
    const backup = await this._backupConflicts(binding, revision, files)
    for (const file of files) {
      const target = safeProjectPath(binding.repoPath, file.path)
      const relative = path.relative(binding.repoPath, target).replaceAll('\\', '/')
      await assertNoSymlink(binding.repoPath, relative)
      if (file.operation === 'delete') {
        try {
          const stat = await fs.lstat(target)
          if (stat.isSymbolicLink() || !stat.isFile()) {
            throw new Error('拒绝删除非普通文件')
          }
          await fs.unlink(target)
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error
        }
      } else {
        await atomicWrite(target, String(file.content ?? ''))
      }
      this.expectedWrites.set(target, {
        sha256: file.operation === 'delete' ? sha256('') : file.sha256,
        expiresAt: Date.now() + EXPECTED_WRITE_MS,
      })
    }
    await this._recordSuppression(binding, files)
    await this._writeLiveCursor(binding.projectId, revision)
    await this.loadContext()
      .then(({ api }) => api.writeLiveCursor({ projectId: binding.projectId, revision }))
      .catch(() => {})
    if (backup) {
      this.emitControl({
        type: 'remote_overwrite',
        backupId: backup.backupId,
        projectId: binding.projectId,
        revision,
        taskKeys: taskKeysFromFiles(binding.projectId, files),
        fileCount: backup.files.length,
        backupPath: path.join(this.store.paths.liveBackupsDir, binding.projectId, backup.backupId),
      })
    }
  }

  async cleanupBackups() {
    const cutoff = Date.now() - BACKUP_RETENTION_MS
    let projectDirs
    try {
      projectDirs = await fs.readdir(this.store.paths.liveBackupsDir, { withFileTypes: true })
    } catch {
      return
    }
    for (const projectDir of projectDirs) {
      if (!projectDir.isDirectory()) continue
      const root = path.join(this.store.paths.liveBackupsDir, projectDir.name)
      let backups
      try {
        backups = await fs.readdir(root, { withFileTypes: true })
      } catch {
        continue
      }
      const groups = new Map()
      for (const backup of backups.filter((item) => item.isDirectory())) {
        const target = path.join(root, backup.name)
        const manifest = await readJson(path.join(target, 'manifest.json'), null)
        const key = (manifest?.taskKeys || []).join('|') || projectDir.name
        if (!groups.has(key)) groups.set(key, [])
        groups.get(key).push({
          target,
          name: backup.name,
          manifest,
        })
      }
      for (const group of groups.values()) {
        group.sort((left, right) => right.name.localeCompare(left.name, 'en'))
        for (let index = 0; index < group.length; index += 1) {
          const backup = group[index]
          const createdAt = Date.parse(backup.manifest?.createdAt || '')
          if (Number.isFinite(createdAt) && createdAt >= cutoff) {
            continue
          }
          if (index < 20) continue
          await fs.rm(backup.target, { recursive: true, force: true })
        }
      }
    }
  }
}

function bindingFor(config, projectId) {
  return (
    config.bindings.find(
      (binding) =>
        binding.projectId === projectId && binding.syncStatus === 'approved' && binding.teamId,
    ) || null
  )
}

async function recordSuppression(store, binding, files) {
  const payload = await readJson(store.paths.liveSuppressionFile, null)
  const now = Date.now()
  const entries = {}
  for (const [target, value] of Object.entries(payload?.entries || {})) {
    if (Number(value?.expiresAt || 0) > now) entries[target] = value
  }
  for (const file of files) {
    const relativePath = normalizeLiveFilePath(file.path)
    const target = safeProjectPath(binding.repoPath, relativePath)
    entries[target] = {
      sha256: file.operation === 'delete' ? sha256('') : file.sha256,
      expiresAt: now + EXPECTED_WRITE_MS,
    }
  }
  await store.writeAtomic(
    store.paths.liveSuppressionFile,
    `${JSON.stringify({ schemaVersion: 1, entries }, null, 2)}\n`,
  )
}

async function createApiContext(options) {
  const config = await options.store.readConfig({ allowMissing: false })
  const credential = await options.credentialStore.loadCredential()
  const api = options.apiClientFactory
    ? options.apiClientFactory(config, credential)
    : new AgentApiClient({ serverUrl: config.serverUrl, credential })
  return { config, api }
}

export async function decidePendingLiveChange(options = {}) {
  const pendingId = String(options.pendingId || '')
  if (!SAFE_LOCAL_ID.test(pendingId)) {
    throw new Error('待确认 ID 格式无效')
  }
  const pendingFile = path.join(options.store.paths.pendingLiveDir, `${pendingId}.json`)
  const pending = await readJson(pendingFile, null)
  if (!pending || pending.kind !== 'decision') {
    throw new Error('待确认的实时修改不存在或已处理')
  }
  if (pending.warning?.expiresAt <= new Date().toISOString()) {
    await fs.unlink(pendingFile).catch(() => {})
    throw new Error('责任人确认已过期，请重新修改任务')
  }
  const { config, api } = await createApiContext(options)
  const binding = bindingFor(config, pending.projectId)
  if (!binding) throw new Error('项目关联已失效')
  const action = String(options.action || '')
  if (!new Set(['continue', 'takeover', 'cancel']).has(action)) {
    throw new Error('未知的责任人确认动作')
  }
  if (action === 'cancel') {
    const backupId = `cancel-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`
    const backupRoot = path.join(options.store.paths.liveBackupsDir, binding.projectId, backupId)
    const manifestFiles = []
    for (const file of pending.files) {
      const relativePath = normalizeLiveFilePath(file.path)
      const target = safeProjectPath(binding.repoPath, relativePath)
      try {
        const stat = await fs.lstat(target)
        if (!stat.isFile() || stat.isSymbolicLink()) continue
        const content = await fs.readFile(target, 'utf8')
        const relative = relativePath.replace(/^\.trellis\//, '')
        await atomicWrite(path.join(backupRoot, 'files', relative), content)
        manifestFiles.push({
          path: relativePath,
          localSha256: sha256(Buffer.from(content, 'utf8')),
          remoteSha256: null,
          existedLocally: true,
        })
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
    }
    if (manifestFiles.length) {
      await options.store.writeAtomic(
        path.join(backupRoot, 'manifest.json'),
        `${JSON.stringify(
          {
            schemaVersion: 1,
            backupId,
            projectId: binding.projectId,
            revision: 0,
            createdAt: new Date().toISOString(),
            taskKeys: taskKeysFromFiles(binding.projectId, pending.files),
            files: manifestFiles,
          },
          null,
          2,
        )}\n`,
      )
    }
    const payload = await api.fetchLiveFiles({
      projectId: binding.projectId,
      afterRevision: 0,
    })
    const affected = new Map(
      (payload.files || []).map((file) => {
        const relativePath = normalizeLiveFilePath(file.path)
        return [relativePath, { ...file, path: relativePath }]
      }),
    )
    const restoredFiles = []
    for (const file of pending.files) {
      const relativePath = normalizeLiveFilePath(file.path)
      const target = safeProjectPath(binding.repoPath, relativePath)
      await assertNoSymlink(binding.repoPath, relativePath)
      const remote = affected.get(relativePath)
      if (remote?.operation === 'upsert') {
        await atomicWrite(target, remote.content)
        restoredFiles.push({
          path: relativePath,
          operation: 'upsert',
          sha256: remote.sha256,
          content: remote.content,
        })
      } else if (remote?.operation === 'delete') {
        await fs.unlink(target).catch((error) => {
          if (error?.code !== 'ENOENT') throw error
        })
        restoredFiles.push({
          path: relativePath,
          operation: 'delete',
          sha256: sha256(''),
        })
      } else {
        const head = gitHeadFile(binding, relativePath)
        if (head == null) {
          await fs.unlink(target).catch((error) => {
            if (error?.code !== 'ENOENT') throw error
          })
          restoredFiles.push({
            path: relativePath,
            operation: 'delete',
            sha256: sha256(''),
          })
        } else {
          await atomicWrite(target, head)
          restoredFiles.push({
            path: relativePath,
            operation: 'upsert',
            sha256: sha256(Buffer.from(head, 'utf8')),
            content: head,
          })
        }
      }
    }
    await recordSuppression(options.store, binding, restoredFiles)
    await fs.unlink(pendingFile).catch(() => {})
    return { action, projectId: binding.projectId }
  }
  const preflight = await api.preflightLiveChanges({
    projectId: binding.projectId,
    bindingId: binding.serverBindingId,
    batchId: pending.batchId,
    taskKey: taskKeysFromFiles(binding.projectId, pending.files)[0] || null,
    files: pending.files,
  })
  const assigneeDecision = preflight.requiresConfirmation
    ? { warningId: preflight.warningId, action }
    : null
  const result = await api.uploadLiveChanges({
    projectId: binding.projectId,
    bindingId: binding.serverBindingId,
    batchId: pending.batchId,
    clientSequence: pending.clientSequence,
    observedAt: pending.observedAt,
    assigneeDecision,
    files: pending.files,
  })
  await fs.unlink(pendingFile).catch(() => {})
  const taskKey = pending.warning?.task?.taskKey || null
  const latest = await api.fetchLiveFiles({
    projectId: binding.projectId,
    afterRevision: 0,
  })
  const relevant = (latest.files || []).filter(
    (file) =>
      (taskKey && file.taskKey === taskKey) ||
      pending.files.some((item) => item.path === file.path),
  )
  if (relevant.length) {
    const sync = new AgentLiveSync({
      store: options.store,
      logger: { info() {}, warn() {}, error() {} },
      loadContext: async () => ({ config, api }),
    })
    await sync._applyRemoteFiles(binding, {
      revision: latest.revision,
      files: relevant,
    })
    sync.stop()
  }
  return { action, projectId: binding.projectId, revision: result.revision }
}

export async function restoreLiveBackup(options = {}) {
  const { config, api } = await createApiContext(options)
  const backupId = String(options.backupId || '')
  if (!SAFE_LOCAL_ID.test(backupId)) throw new Error('备份 ID 无效')
  let found = null
  for (const binding of config.bindings.filter((item) => item.syncStatus === 'approved')) {
    const manifestFile = path.join(
      options.store.paths.liveBackupsDir,
      binding.projectId,
      backupId,
      'manifest.json',
    )
    const manifest = await readJson(manifestFile, null)
    if (manifest?.projectId === binding.projectId) {
      found = { binding, manifest, manifestFile }
      break
    }
  }
  if (!found) throw new Error('实时同步备份不存在')
  const files = []
  for (const item of found.manifest.files || []) {
    const relativePath = normalizeLiveFilePath(item.path)
    const relative = relativePath.replace(/^\.trellis\//, '')
    const backupFile = safeProjectPath(
      path.join(path.dirname(found.manifestFile), 'files'),
      relative,
    )
    if (item.existedLocally) {
      const stat = await fs.stat(backupFile)
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
        throw new Error('实时同步备份文件无效或超过 1 MiB')
      }
      const content = await fs.readFile(backupFile, 'utf8')
      files.push({
        path: relativePath,
        operation: 'upsert',
        sha256: sha256(Buffer.from(content, 'utf8')),
        content,
      })
    } else {
      files.push({
        path: relativePath,
        operation: 'delete',
        sha256: sha256(''),
      })
    }
  }
  let revision = 0
  for (const batchFiles of splitLiveBatches(found.binding.projectId, files)) {
    const batchId = crypto.randomUUID()
    const preflight = await api.preflightLiveChanges({
      projectId: found.binding.projectId,
      bindingId: found.binding.serverBindingId,
      batchId,
      taskKey: taskKeysFromFiles(found.binding.projectId, batchFiles)[0] || null,
      files: batchFiles,
    })
    const result = await api.uploadLiveChanges({
      projectId: found.binding.projectId,
      bindingId: found.binding.serverBindingId,
      batchId,
      clientSequence: Date.now(),
      observedAt: new Date().toISOString(),
      assigneeDecision: preflight.requiresConfirmation
        ? { warningId: preflight.warningId, action: 'continue' }
        : undefined,
      files: batchFiles,
    })
    revision = Math.max(revision, Number(result.revision || 0))
    for (const file of batchFiles) {
      const target = safeProjectPath(found.binding.repoPath, file.path)
      await assertNoSymlink(found.binding.repoPath, file.path)
      if (file.operation === 'delete') {
        await fs.unlink(target).catch((error) => {
          if (error?.code !== 'ENOENT') throw error
        })
      } else {
        await atomicWrite(target, file.content)
      }
    }
    await recordSuppression(options.store, found.binding, batchFiles)
  }
  await options.store.writeAtomic(
    found.manifestFile,
    `${JSON.stringify(
      {
        ...found.manifest,
        restoredAt: new Date().toISOString(),
        restoreRevision: revision,
      },
      null,
      2,
    )}\n`,
  )
  return {
    projectId: found.binding.projectId,
    backupId,
    revision,
  }
}

export function liveControlLine(event) {
  return `${JSON.stringify({ control: event })}\n`
}
