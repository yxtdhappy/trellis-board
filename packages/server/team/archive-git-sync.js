import crypto from 'node:crypto'
import { withTransaction } from '../database.js'
import { appendAuditEvent } from './audit.js'
import { diagnosticError, errorSummary, sanitizeDiagnosticText } from './error-diagnostics.js'
import { ERROR_CODES, teamError } from './errors.js'
import {
  formatGitRemote,
  normalizeGitRemote,
} from '@trellis-board/shared/remote-identity.js'
import {
  archiveCredentialOrigin,
  createArchiveGitCredentialService,
} from './archive-git-credentials.js'
import { createArchiveGitStore } from './archive-git-store.js'

const MIN_INTERVAL_SECONDS = 60
const MAX_INTERVAL_SECONDS = 24 * 60 * 60
const MAX_CONCURRENT_TASKS = 2
const MAX_FAILURE_LOGS = 100
const BACKOFF_SECONDS = [30, 60, 120, 300, 600, 1800]

function boundedInteger(value, label, minimum, maximum) {
  const number = Number(value)
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw teamError(
      400,
      ERROR_CODES.INVALID_INPUT,
      `${label}必须是 ${minimum} 到 ${maximum} 的整数`,
    )
  }
  return number
}

function booleanValue(value, label) {
  if (value === true || value === 1 || value === '1' || value === 'true') return true
  if (value === false || value === 0 || value === '0' || value === 'false') return false
  throw teamError(400, ERROR_CODES.INVALID_INPUT, `${label}必须是布尔值`)
}

function phaseForError(error) {
  if (error?.archivePhase === 'fetch' || error?.archivePhase === 'import') {
    return error.archivePhase
  }
  const code = String(error?.code || '')
  if (
    code.startsWith('ARCHIVE_ENTRY_') ||
    code.startsWith('ARCHIVE_FILE_') ||
    code === 'ARCHIVE_PATH_INVALID' ||
    code === 'ARCHIVE_TREE_TOO_LARGE'
  ) {
    return 'import'
  }
  return 'fetch'
}

function normalizedErrorCode(error, phase) {
  const code = String(error?.code || '').trim()
  if (code && /^[A-Z0-9_:-]{2,100}$/.test(code)) return code
  return phase === 'index' ? 'ARCHIVE_INDEX_FAILED' : 'ARCHIVE_SYNC_FAILED'
}

function normalizedLimit(value, fallback = 50) {
  if (value == null || value === '') return fallback
  return boundedInteger(value, 'limit', 1, 100)
}

export function createArchiveGitSyncService({
  db,
  config,
  dataDir,
  taskSpaceIndex,
  logger = console,
  runProcessImpl,
  store: providedStore = null,
}) {
  const credentials = createArchiveGitCredentialService({ db, dataDir })
  const store =
    providedStore ||
    createArchiveGitStore({
      dataDir,
      config,
      credentials,
      logger,
      runProcessImpl,
    })
  const taskLocks = new Map()
  const backoffUntil = new Map()
  const failureCounts = new Map()
  const activeRuns = new Set()
  let activeSlots = 0
  const slotWaiters = []
  let schedulerTimer = null
  let running = false
  let stopped = false
  let abortController = new AbortController()

  function configRow() {
    return db.prepare('SELECT * FROM sync_archive_sync_config WHERE id = 1').get()
  }

  function publicConfig(row = configRow()) {
    return {
      enabled: Boolean(row?.enabled),
      intervalSeconds: Number(row?.interval_seconds || 300),
      updatedAt: row?.updated_at || null,
    }
  }

  function ensureState(taskSpaceId, timestamp = new Date().toISOString()) {
    db.prepare(`
      INSERT INTO sync_archive_sync_state(
        task_space_id, ref_name, remote_head, status, last_attempt_at,
        last_success_at, last_indexed_at, last_error, file_count, byte_count, updated_at
      ) VALUES (?, NULL, NULL, 'idle', NULL, NULL, NULL, NULL, 0, 0, ?)
      ON CONFLICT(task_space_id) DO NOTHING
    `).run(taskSpaceId, timestamp)
  }

  function activeTaskSpaces(taskSpaceId = null) {
    const params = []
    const filter = taskSpaceId ? 'AND s.id = ?' : ''
    if (taskSpaceId) params.push(String(taskSpaceId))
    return db
      .prepare(`
        SELECT
          s.*, p.name AS project_name, p.remote_url, p.status AS project_status,
          p.owner_team_id
        FROM sync_task_space s
        JOIN sync_project p ON p.id = s.project_id
        WHERE s.status = 'active'
          AND s.retired_at IS NULL
          AND p.status = 'active'
          ${filter}
        ORDER BY p.name COLLATE NOCASE, s.branch_name COLLATE NOCASE
      `)
      .all(...params)
  }

  function appendFailureLog({
    taskSpaceId,
    attemptId,
    phase,
    error,
    occurredAt = new Date().toISOString(),
  }) {
    const diagnostic = diagnosticError(error)
    const code = normalizedErrorCode(error, phase)
    const message = sanitizeDiagnosticText(errorSummary(error, '归档同步失败'), {
      maxBytes: 4096,
    })
    const detail = JSON.stringify(diagnostic)
    db.prepare(`
      INSERT INTO sync_archive_sync_log(
        task_space_id, attempt_id, phase, level, error_code, message, detail_json, created_at
      ) VALUES (?, ?, ?, 'error', ?, ?, ?, ?)
    `).run(
      taskSpaceId,
      attemptId,
      phase,
      code,
      message,
      Buffer.byteLength(detail, 'utf8') <= 16 * 1024
        ? detail
        : JSON.stringify({
            name: diagnostic.name,
            code: diagnostic.code,
            message: diagnostic.message,
            details: diagnostic.details,
          }),
      occurredAt,
    )
    db.prepare(`
      DELETE FROM sync_archive_sync_log
      WHERE task_space_id = ?
        AND id NOT IN (
          SELECT id
          FROM sync_archive_sync_log
          WHERE task_space_id = ?
          ORDER BY created_at DESC, id DESC
          LIMIT ${MAX_FAILURE_LOGS}
        )
    `).run(taskSpaceId, taskSpaceId)
    return { code, message }
  }

  function recordFailure(taskSpaceId, attemptId, phase, error) {
    const occurredAt = new Date().toISOString()
    const summary = errorSummary(error, '归档同步失败')
    withTransaction(db, () => {
      ensureState(taskSpaceId, occurredAt)
      appendFailureLog({ taskSpaceId, attemptId, phase, error, occurredAt })
      db.prepare(`
        UPDATE sync_archive_sync_state
        SET status = 'error', last_error = ?, updated_at = ?
        WHERE task_space_id = ?
      `).run(summary, occurredAt, taskSpaceId)
    })
  }

  function markAttemptStarted(taskSpaceId, attemptId) {
    const timestamp = new Date().toISOString()
    withTransaction(db, () => {
      ensureState(taskSpaceId, timestamp)
      db.prepare(`
        UPDATE sync_archive_sync_state
        SET status = 'syncing', last_attempt_at = ?, last_error = NULL, updated_at = ?
        WHERE task_space_id = ?
      `).run(timestamp, timestamp, taskSpaceId)
    })
    return { attemptId, startedAt: timestamp }
  }

  function markImporting(taskSpaceId, head) {
    const timestamp = new Date().toISOString()
    db.prepare(`
      UPDATE sync_archive_sync_state
      SET status = 'importing', ref_name = 'refs/heads/trellis-archive',
          remote_head = ?, updated_at = ?
      WHERE task_space_id = ?
    `).run(head, timestamp, taskSpaceId)
  }

  function importSnapshot(taskSpaceId, snapshot) {
    return withTransaction(db, () => {
      const existingRows = db
        .prepare(`
          SELECT relative_path, blob_oid, sha256, task_dir, task_id
          FROM sync_archive_file
          WHERE task_space_id = ?
        `)
        .all(taskSpaceId)
      const existing = new Map(existingRows.map((row) => [row.relative_path, row]))
      const desired = new Map(snapshot.files.map((file) => [file.relativePath, file]))
      let contentChanged = false
      let legacyMetadataReplaced = false
      for (const [relativePath, file] of desired) {
        const row = existing.get(relativePath)
        if (
          !row ||
          row.sha256 !== file.sha256 ||
          row.task_dir !== file.taskDir ||
          (row.task_id || null) !== (file.taskId || null)
        ) {
          contentChanged = true
          break
        }
        if (row.blob_oid === 'legacy') legacyMetadataReplaced = true
      }
      if (!contentChanged) {
        for (const relativePath of existing.keys()) {
          if (!desired.has(relativePath)) {
            contentChanged = true
            break
          }
        }
      }
      const changed = contentChanged || legacyMetadataReplaced

      const timestamp = new Date().toISOString()
      let archiveRevision = Number(
        db.prepare('SELECT archive_revision FROM sync_task_space WHERE id = ?').get(taskSpaceId)
          ?.archive_revision || 0,
      )
      if (changed) {
        const deleteFile = db.prepare(
          'DELETE FROM sync_archive_file WHERE task_space_id = ? AND relative_path = ?',
        )
        const upsert = db.prepare(`
          INSERT INTO sync_archive_file(
            task_space_id, relative_path, blob_oid, sha256, content_text,
            task_id, task_dir, source_head, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(task_space_id, relative_path) DO UPDATE SET
            blob_oid = excluded.blob_oid,
            sha256 = excluded.sha256,
            content_text = excluded.content_text,
            task_id = excluded.task_id,
            task_dir = excluded.task_dir,
            source_head = excluded.source_head,
            updated_at = excluded.updated_at
        `)
        for (const [relativePath, row] of existing) {
          if (!desired.has(relativePath)) deleteFile.run(taskSpaceId, relativePath)
        }
        for (const file of desired.values()) {
          const row = existing.get(file.relativePath)
          if (
            row &&
            row.sha256 === file.sha256 &&
            row.task_dir === file.taskDir &&
            (row.task_id || null) === (file.taskId || null) &&
            row.blob_oid !== 'legacy'
          ) {
            continue
          }
          upsert.run(
            taskSpaceId,
            file.relativePath,
            file.blobOid,
            file.sha256,
            file.content,
            file.taskId,
            file.taskDir,
            snapshot.head,
            timestamp,
          )
        }
        db.prepare(`
          UPDATE sync_task_space
          SET archive_revision = archive_revision + 1, updated_at = ?
          WHERE id = ?
        `).run(timestamp, taskSpaceId)
        archiveRevision = Number(
          db.prepare('SELECT archive_revision FROM sync_task_space WHERE id = ?').get(taskSpaceId)
            .archive_revision,
        )
      }

      const priorSuccess = db
        .prepare('SELECT last_success_at FROM sync_archive_sync_state WHERE task_space_id = ?')
        .get(taskSpaceId)?.last_success_at
      const archiveIndexedRevision = Number(
        db
          .prepare('SELECT archive_indexed_revision FROM sync_task_space WHERE id = ?')
          .get(taskSpaceId).archive_indexed_revision,
      )
      const needsIndex = changed || archiveIndexedRevision < archiveRevision || !priorSuccess
      db.prepare(`
        UPDATE sync_archive_sync_state
        SET status = ?, ref_name = 'refs/heads/trellis-archive',
            remote_head = ?, last_success_at = ?, last_error = NULL,
            file_count = ?, byte_count = ?, updated_at = ?
        WHERE task_space_id = ?
      `).run(
        needsIndex ? 'indexing' : 'current',
        snapshot.head,
        timestamp,
        snapshot.fileCount,
        snapshot.byteCount,
        timestamp,
        taskSpaceId,
      )
      return {
        changed,
        contentChanged,
        legacyMetadataReplaced,
        needsIndex,
        archiveRevision,
        firstSuccess: !priorSuccess,
      }
    })
  }

  async function acquireSlot() {
    if (activeSlots < MAX_CONCURRENT_TASKS) {
      activeSlots += 1
      return
    }
    await new Promise((resolve) => slotWaiters.push(resolve))
    activeSlots += 1
  }

  function releaseSlot() {
    activeSlots = Math.max(0, activeSlots - 1)
    const next = slotWaiters.shift()
    if (next) next()
  }

  function withTaskSpaceLock(taskSpaceId, callback) {
    const key = String(taskSpaceId)
    const previous = taskLocks.get(key) || Promise.resolve()
    const next = previous.catch(() => {}).then(callback)
    taskLocks.set(key, next)
    next
      .finally(() => {
        if (taskLocks.get(key) === next) taskLocks.delete(key)
      })
      .catch(() => {})
    return next
  }

  async function syncTaskSpace(taskSpace, { manual = false } = {}) {
    const taskSpaceId = taskSpace.id
    const attemptId = crypto.randomUUID()
    let phase = 'fetch'
    markAttemptStarted(taskSpaceId, attemptId)
    try {
      const project = {
        id: taskSpace.project_id,
        name: taskSpace.project_name,
        remote_url: taskSpace.remote_url,
      }
      const priorState = db
        .prepare(`
          SELECT remote_head, file_count, byte_count, last_success_at
          FROM sync_archive_sync_state
          WHERE task_space_id = ?
        `)
        .get(taskSpaceId)
      const currentFileCount = Number(
        db
          .prepare('SELECT COUNT(*) AS count FROM sync_archive_file WHERE task_space_id = ?')
          .get(taskSpaceId).count,
      )
      const knownHead =
        priorState?.last_success_at &&
        priorState.remote_head &&
        currentFileCount === Number(priorState.file_count)
          ? priorState.remote_head
          : null
      const snapshot = await store.readSnapshot({
        taskSpaceId,
        project,
        taskSpace,
        knownHead,
        signal: abortController.signal,
      })
      if (snapshot.skipped) {
        const revisions = db
          .prepare(`
            SELECT archive_revision, archive_indexed_revision
            FROM sync_task_space
            WHERE id = ?
          `)
          .get(taskSpaceId)
        const needsIndex =
          Number(revisions?.archive_indexed_revision || 0) <
          Number(revisions?.archive_revision || 0)
        const timestamp = new Date().toISOString()
        db.prepare(`
          UPDATE sync_archive_sync_state
          SET status = ?, remote_head = ?, last_error = NULL, updated_at = ?
          WHERE task_space_id = ?
        `).run(needsIndex ? 'indexing' : 'current', snapshot.head, timestamp, taskSpaceId)
        if (needsIndex) {
          void taskSpaceIndex.enqueue(taskSpaceId, { source: 'archive' }).catch((error) => {
            logger.warn?.('归档索引排队失败', {
              taskSpaceId,
              error: errorSummary(error, '归档索引排队失败'),
            })
          })
        }
        failureCounts.delete(taskSpaceId)
        backoffUntil.delete(taskSpaceId)
        logger.info?.('归档 Git 无变化', {
          taskSpaceId,
          projectId: taskSpace.project_id,
          branch: taskSpace.branch_name,
          head: snapshot.head,
          needsIndex,
          manual,
          ...snapshot.metrics,
        })
        return {
          taskSpaceId,
          changed: false,
          needsIndex,
          fileCount: Number(priorState.file_count || 0),
          byteCount: Number(priorState.byte_count || 0),
        }
      }
      phase = 'import'
      markImporting(taskSpaceId, snapshot.head)
      const imported = importSnapshot(taskSpaceId, snapshot)
      failureCounts.delete(taskSpaceId)
      backoffUntil.delete(taskSpaceId)
      if (imported.needsIndex) {
        void taskSpaceIndex.enqueue(taskSpaceId, { source: 'archive' }).catch((error) => {
          logger.warn?.('归档索引排队失败', {
            taskSpaceId,
            error: errorSummary(error, '归档索引排队失败'),
          })
        })
      }
      logger.info?.('归档 Git 同步完成', {
        taskSpaceId,
        projectId: taskSpace.project_id,
        branch: taskSpace.branch_name,
        head: snapshot.head,
        fileCount: snapshot.fileCount,
        byteCount: snapshot.byteCount,
        archiveRevision: imported.archiveRevision,
        changed: imported.changed,
        contentChanged: imported.contentChanged,
        legacyMetadataReplaced: imported.legacyMetadataReplaced,
        needsIndex: imported.needsIndex,
        manual,
        ...snapshot.metrics,
      })
      return {
        taskSpaceId,
        changed: imported.changed,
        archiveRevision: imported.archiveRevision,
        needsIndex: imported.needsIndex,
        fileCount: snapshot.fileCount,
        byteCount: snapshot.byteCount,
      }
    } catch (error) {
      if (stopped && abortController.signal.aborted) return { taskSpaceId, aborted: true }
      const failurePhase =
        phase === 'fetch' && error?.code && phaseForError(error) === 'import' ? 'import' : phase
      recordFailure(taskSpaceId, attemptId, failurePhase, error)
      const count = Number(failureCounts.get(taskSpaceId) || 0)
      failureCounts.set(taskSpaceId, count + 1)
      const interval = Number(configRow()?.interval_seconds || 300)
      const delaySeconds = Math.min(
        BACKOFF_SECONDS[Math.min(count, BACKOFF_SECONDS.length - 1)],
        interval,
      )
      backoffUntil.set(taskSpaceId, Date.now() + delaySeconds * 1000)
      logger.warn?.('归档 Git 同步失败', {
        taskSpaceId,
        projectId: taskSpace.project_id,
        branch: taskSpace.branch_name,
        phase: failurePhase,
        error: errorSummary(error),
      })
      return {
        taskSpaceId,
        failed: true,
        error: errorSummary(error),
      }
    }
  }

  function runTaskSpace(taskSpace, options = {}) {
    if (stopped) return Promise.resolve({ taskSpaceId: taskSpace.id, stopped: true })
    const promise = withTaskSpaceLock(taskSpace.id, async () => {
      await acquireSlot()
      try {
        return await syncTaskSpace(taskSpace, options)
      } finally {
        releaseSlot()
      }
    })
    activeRuns.add(promise)
    promise.finally(() => activeRuns.delete(promise)).catch(() => {})
    return promise
  }

  async function runDueTaskSpaces({ manual = false, taskSpaceId = null } = {}) {
    const now = Date.now()
    const spaces = activeTaskSpaces(taskSpaceId)
    const due = spaces.filter((space) => manual || Number(backoffUntil.get(space.id) || 0) <= now)
    const results = []
    for (let index = 0; index < due.length; index += MAX_CONCURRENT_TASKS) {
      const batch = due.slice(index, index + MAX_CONCURRENT_TASKS)
      results.push(
        ...(await Promise.all(
          batch.map((space) =>
            runTaskSpace(space, {
              manual,
            }),
          ),
        )),
      )
    }
    return results
  }

  function schedule(delayMs) {
    if (stopped) return
    if (schedulerTimer) clearTimeout(schedulerTimer)
    schedulerTimer = setTimeout(
      () => {
        schedulerTimer = null
        void tick()
      },
      Math.max(100, delayMs),
    )
    schedulerTimer.unref?.()
  }

  async function tick() {
    if (stopped || running) return
    running = true
    try {
      const current = publicConfig()
      if (current.enabled) await runDueTaskSpaces()
    } catch (error) {
      logger.warn?.('归档 Git 调度失败', { error: errorSummary(error, '归档同步调度失败') })
    } finally {
      running = false
      const current = publicConfig()
      const intervalMs = Math.max(1000, Number(current.intervalSeconds || 300) * 1000)
      const nextBackoff = current.enabled
        ? Math.min(
            ...activeTaskSpaces().map(
              (space) => Number(backoffUntil.get(space.id)) || Number.POSITIVE_INFINITY,
            ),
          )
        : Number.POSITIVE_INFINITY
      const delayMs = Number.isFinite(nextBackoff)
        ? Math.max(1000, Math.min(intervalMs, nextBackoff - Date.now()))
        : intervalMs
      schedule(delayMs)
    }
  }

  function start() {
    if (stopped) return
    stopped = false
    abortController = new AbortController()
    schedule(2000)
  }

  async function stop() {
    if (stopped) return
    stopped = true
    abortController.abort()
    if (schedulerTimer) clearTimeout(schedulerTimer)
    schedulerTimer = null
    await Promise.allSettled([...activeRuns])
  }

  function updateConfig(actor, input = {}) {
    if (input.enabled == null && input.intervalSeconds == null) {
      throw teamError(400, ERROR_CODES.INVALID_INPUT, '没有可更新的归档同步配置')
    }
    const current = configRow()
    const enabled =
      input.enabled == null ? Boolean(current.enabled) : booleanValue(input.enabled, 'enabled')
    const intervalSeconds =
      input.intervalSeconds == null
        ? Number(current.interval_seconds)
        : boundedInteger(
            input.intervalSeconds,
            'intervalSeconds',
            MIN_INTERVAL_SECONDS,
            MAX_INTERVAL_SECONDS,
          )
    const timestamp = new Date().toISOString()
    withTransaction(db, () => {
      db.prepare(`
        UPDATE sync_archive_sync_config
        SET enabled = ?, interval_seconds = ?, updated_by_user_id = ?, updated_at = ?
        WHERE id = 1
      `).run(enabled ? 1 : 0, intervalSeconds, actor.userId, timestamp)
      appendAuditEvent(db, {
        actorUserId: actor.userId,
        action: 'archive_git_config_updated',
        targetType: 'archive_git_config',
        targetId: '1',
        detail: { enabled, intervalSeconds },
      })
    })
    if (enabled) schedule(1000)
    return publicConfig()
  }

  function overview() {
    const credentialRows = credentials.list()
    const credentialsByOrigin = new Map(credentialRows.map((row) => [row.origin, row]))
    const taskSpaces = activeTaskSpaces().map((space) => {
      ensureState(space.id)
      const state = db
        .prepare('SELECT * FROM sync_archive_sync_state WHERE task_space_id = ?')
        .get(space.id)
      const archiveStats = db
        .prepare(`
          SELECT COUNT(*) AS file_count,
                 COALESCE(SUM(length(CAST(content_text AS BLOB))), 0) AS byte_count
          FROM sync_archive_file
          WHERE task_space_id = ?
        `)
        .get(space.id)
      let origin = null
      let remoteUrl = null
      let supported = true
      try {
        const remote = normalizeGitRemote(space.remote_url, {
          allowFileRemote: Boolean(config?.allowLocalGitRemotes),
        })
        origin = archiveCredentialOrigin(remote)
        supported = remote.scheme !== 'file'
        if (supported) remoteUrl = formatGitRemote(remote)
      } catch {
        supported = false
      }
      const credential = origin ? credentialsByOrigin.get(origin) || null : null
      const credentialState = !supported
        ? 'unsupported'
        : credential
          ? 'configured'
          : origin?.startsWith('https://')
            ? 'anonymous'
            : 'missing'
      const failureCount = Number(
        db
          .prepare('SELECT COUNT(*) AS count FROM sync_archive_sync_log WHERE task_space_id = ?')
          .get(space.id).count,
      )
      return {
        taskSpaceId: space.id,
        projectId: space.project_id,
        projectName: space.project_name,
        remoteUrl,
        origin,
        branchName: space.branch_name,
        credentialState,
        credential,
        status: state?.status || 'idle',
        lastAttemptAt: state?.last_attempt_at || null,
        lastSuccessAt: state?.last_success_at || null,
        lastIndexedAt: state?.last_indexed_at || null,
        lastError: state?.last_error || null,
        remoteHead: state?.remote_head || null,
        fileCount: Number(state?.file_count || archiveStats.file_count || 0),
        byteCount: Number(state?.byte_count || archiveStats.byte_count || 0),
        archiveRevision: Number(space.archive_revision || 0),
        archiveIndexedRevision: Number(space.archive_indexed_revision || 0),
        failureCount,
        nextAttemptAt:
          backoffUntil.get(space.id) == null
            ? null
            : new Date(Number(backoffUntil.get(space.id))).toISOString(),
      }
    })
    return {
      config: publicConfig(),
      credentials: credentialRows,
      taskSpaces,
    }
  }

  function listLogs(taskSpaceId, { beforeId = null, limit = 50 } = {}) {
    const id = String(taskSpaceId || '').trim()
    const space = activeTaskSpaces(id)
    if (!space.length) throw teamError(404, ERROR_CODES.NOT_FOUND, '任务空间不存在')
    const bounded = normalizedLimit(limit)
    const before =
      beforeId == null || beforeId === '' ? null : boundedInteger(beforeId, 'beforeId', 1, 2 ** 31)
    const rows = db
      .prepare(`
        SELECT *
        FROM sync_archive_sync_log
        WHERE task_space_id = ?
          AND (? IS NULL OR id < ?)
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `)
      .all(id, before, before, bounded + 1)
    const hasMore = rows.length > bounded
    const page = rows.slice(0, bounded)
    return {
      logs: page.map((row) => ({
        id: Number(row.id),
        taskSpaceId: row.task_space_id,
        attemptId: row.attempt_id,
        phase: row.phase,
        level: row.level,
        errorCode: row.error_code,
        message: sanitizeDiagnosticText(row.message, { maxBytes: 4096 }),
        detail: (() => {
          try {
            return JSON.parse(row.detail_json || '{}')
          } catch {
            return {}
          }
        })(),
        createdAt: row.created_at,
      })),
      nextBeforeId: hasMore ? Number(page.at(-1)?.id || 0) || null : null,
    }
  }

  async function runNow(taskSpaceId = null) {
    const requested = taskSpaceId == null ? '' : String(taskSpaceId).trim()
    if (requested && !activeTaskSpaces(requested).length) {
      throw teamError(404, ERROR_CODES.NOT_FOUND, '任务空间不存在或不可同步')
    }
    const spaces = activeTaskSpaces(requested || null)
    for (const space of spaces) backoffUntil.delete(space.id)
    for (const space of spaces) void runTaskSpace(space, { manual: true })
    return { queued: spaces.length }
  }

  function onIndexProjected(payload) {
    const state = db
      .prepare('SELECT status FROM sync_archive_sync_state WHERE task_space_id = ?')
      .get(payload.taskSpaceId)
    if (
      payload.source !== 'archive' &&
      !payload.archiveAdvanced &&
      !new Set(['indexing', 'index_error']).has(state?.status)
    ) {
      return
    }
    const timestamp = new Date().toISOString()
    ensureState(payload.taskSpaceId, timestamp)
    db.prepare(`
      UPDATE sync_archive_sync_state
      SET status = 'current', last_indexed_at = ?, last_error = NULL, updated_at = ?
      WHERE task_space_id = ?
    `).run(timestamp, timestamp, payload.taskSpaceId)
  }

  function onIndexProjectionFailed({ taskSpaceId, error, attemptId, sources = [] }) {
    const id = String(taskSpaceId || '')
    if (!id) return
    const archiveBehind = Boolean(
      db
        .prepare(`
          SELECT 1
          FROM sync_task_space
          WHERE id = ?
            AND archive_revision > archive_indexed_revision
        `)
        .get(id),
    )
    if (!archiveBehind && !sources.includes('archive')) return
    recordFailure(id, attemptId || crypto.randomUUID(), 'index', error)
    db.prepare(`
      UPDATE sync_archive_sync_state
      SET status = 'index_error', updated_at = ?
      WHERE task_space_id = ?
    `).run(new Date().toISOString(), id)
  }

  async function testCredential(actor, credentialId, signal = null) {
    const profile = credentials.list().find((item) => item.id === String(credentialId || ''))
    if (!profile) throw teamError(404, ERROR_CODES.NOT_FOUND, '归档 Git 凭据不存在')
    const candidates = activeTaskSpaces().filter((space) => {
      try {
        const remote = normalizeGitRemote(space.remote_url, {
          allowFileRemote: Boolean(config?.allowLocalGitRemotes),
        })
        return archiveCredentialOrigin(remote) === profile.origin
      } catch {
        return false
      }
    })
    if (!candidates.length) {
      throw teamError(409, 'ARCHIVE_CREDENTIAL_NO_PROJECT', '该来源下没有可测试的活动任务空间')
    }
    const taskSpace = candidates[0]
    const resolved = credentials.resolveForRemote(taskSpace.remote_url, {
      allowFileRemote: Boolean(config?.allowLocalGitRemotes),
    })
    const result = await store.testCredential({
      credential: resolved.credential,
      remoteUrl: resolved.remote.url,
      branchName: taskSpace.branch_name,
      signal,
    })
    withTransaction(db, () => {
      appendAuditEvent(db, {
        actorUserId: actor.userId,
        action: 'archive_git_credential_tested',
        targetType: 'archive_git_credential',
        targetId: profile.id,
        result: 'success',
        detail: {
          origin: profile.origin,
          taskSpaceId: taskSpace.id,
          branchFound: result.branchFound,
        },
      })
    })
    return {
      ok: true,
      origin: profile.origin,
      taskSpaceId: taskSpace.id,
      branchName: taskSpace.branch_name,
      branchFound: result.branchFound,
    }
  }

  return {
    credentials,
    start,
    stop,
    overview,
    updateConfig,
    runNow,
    listLogs,
    onIndexProjected,
    onIndexProjectionFailed,
    testCredential,
  }
}
