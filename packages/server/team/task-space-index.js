import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { withTransaction } from '../database.js'
import { linkTaskGroups, toTaskListItem, withManualStages } from '../loader.js'
import { getManualRecords } from '../metadata.js'
import { projectBoardExecution } from '../execution-projection.js'
import { ERROR_CODES, teamError } from './errors.js'
import { isArchiveTextMimeType } from './archive-local-snapshot.js'
import { resolveTeamScope } from './teams.js'
import {
  ProjectionSuperseded,
  hashValue,
  manualStageFingerprint,
  parseJson,
  parseProjectionState,
  rawTaskMap,
  serializeProjectionState,
  taskControlFingerprint,
  taskDirFingerprints,
} from './task-index/projection-state.js'
import {
  CURSOR_TTL_MS,
  encryptCursor,
  decryptCursor,
  shanghaiDay,
  addDays,
  stringList,
  normalizeFilters,
  bindList,
  stableTaskIdSql,
  publicRow,
  searchText,
} from './task-index/query-helpers.js'
import { syncAssignments } from './task-index/sync-assignments.js'
import { replaceIndexInTransaction } from './task-index/index-write.js'
import { materializeOnce } from './task-index/materialize.js'
import { queryTasks, resolveQueryScope } from './task-index/query.js'

const workerFile = fileURLToPath(new URL('./scan-worker.js', import.meta.url))
const RETRY_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000]

export function createTaskSpaceIndex({
  db,
  stageIds,
  taskSpaces,
  archiveSnapshots = null,
  taskControl = null,
  executionWipLimit = 2,
  onQueryRevisionChanged = null,
  onProjected = null,
  onProjectionFailed = null,
  logger = console,
}) {
  let worker = null
  let requestId = 0
  const pending = new Map()
  const queues = new Map()
  const queryCache = new Map()
  const materialized = new Map()
  const inflight = new Map()
  let stopped = false

  function ensureWorker() {
    if (worker) return worker
    const current = new Worker(workerFile)
    worker = current
    current.on('message', (message) => {
      const request = pending.get(message?.id)
      if (!request) return
      clearTimeout(request.timer)
      pending.delete(message.id)
      if (message.type === 'scan-error') request.reject(new Error(message.error))
      else if (message.type !== request.expectedType) {
        request.reject(new Error('任务空间扫描 Worker 返回了无效结果'))
      } else request.resolve(message)
    })
    current.on('error', (error) => {
      if (worker === current) worker = null
      for (const request of pending.values()) {
        clearTimeout(request.timer)
        request.reject(error)
      }
      pending.clear()
    })
    current.on('exit', (code) => {
      if (worker === current) worker = null
      if (pending.size) {
        for (const request of pending.values()) {
          clearTimeout(request.timer)
          request.reject(new Error(`任务空间扫描 Worker 退出：${code}`))
        }
        pending.clear()
      }
    })
    return current
  }

  function requestWorker(type, payload, expectedType) {
    const current = ensureWorker()
    const id = ++requestId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error('任务空间扫描超过 180 秒'))
      }, 180_000)
      pending.set(id, { resolve, reject, timer, expectedType })
      current.postMessage({ ...payload, type, id })
    })
  }

  function queryRevision() {
    return Number(
      db.prepare("SELECT value FROM app_meta WHERE key = 'queryRevision'").get()?.value || 0,
    )
  }

  function incrementQueryRevision({ publish = true } = {}) {
    db.prepare(`
      INSERT INTO app_meta(key, value, updated_at)
      VALUES ('queryRevision', '1', ?)
      ON CONFLICT(key) DO UPDATE SET
        value = CAST(CAST(value AS INTEGER) + 1 AS TEXT),
        updated_at = excluded.updated_at
    `).run(new Date().toISOString())
    const revision = queryRevision()
    if (publish) onQueryRevisionChanged?.(revision)
    return revision
  }

  function archiveQueryRevision() {
    return Number(
      db.prepare("SELECT value FROM app_meta WHERE key = 'archiveQueryRevision'").get()?.value || 0,
    )
  }

  function incrementArchiveQueryRevision() {
    db.prepare(`
      INSERT INTO app_meta(key, value, updated_at)
      VALUES ('archiveQueryRevision', '1', ?)
      ON CONFLICT(key) DO UPDATE SET
        value = CAST(CAST(value AS INTEGER) + 1 AS TEXT),
        updated_at = excluded.updated_at
    `).run(new Date().toISOString())
    return archiveQueryRevision()
  }

  function taskSpaceRow(taskSpaceId) {
    return db
      .prepare(`
      SELECT s.*, p.name AS project_name, p.owner_team_id, p.status AS project_status,
             t.name AS team_name
      FROM sync_task_space s
      JOIN sync_project p ON p.id = s.project_id
      JOIN team t ON t.id = p.owner_team_id
      WHERE s.id = ?
    `)
      .get(taskSpaceId)
  }

  function assigneeUserMap(projectId) {
    return new Map(
      db
        .prepare(`
        SELECT m.trellis_dev_id, m.user_id
        FROM sync_project_member m
        JOIN user_account u ON u.id = m.user_id
        WHERE m.project_id = ? AND u.status = 'active'
      `)
        .all(projectId)
        .map((row) => [String(row.trellis_dev_id).toLowerCase(), row.user_id]),
    )
  }

  function mineMemberSignature(userId) {
    return db
      .prepare(`
        SELECT project_id, trellis_dev_id
        FROM sync_project_member
        WHERE user_id = ? AND trellis_dev_id IS NOT NULL
      `)
      .all(userId)
      .map((row) => `${row.project_id}:${String(row.trellis_dev_id).toLowerCase()}`)
      .sort()
  }

  function archiveFilesByTaskDirectory(taskSpaceId) {
    const grouped = new Map()
    for (const row of db
      .prepare(`
        SELECT id, relative_path, size_bytes, mime_type
        FROM sync_archive_file
        WHERE task_space_id = ? AND storage_key IS NOT NULL
        ORDER BY relative_path
      `)
      .all(taskSpaceId)) {
      const taskDir = String(row.relative_path || '')
        .split('/')
        .slice(0, 5)
        .join('/')
      if (!grouped.has(taskDir)) grouped.set(taskDir, [])
      grouped.get(taskDir).push({
        id: row.id,
        path: row.relative_path,
        name: path.posix.basename(row.relative_path),
        sizeBytes: Number(row.size_bytes || 0),
        mimeType: row.mime_type || 'application/octet-stream',
        downloadUrl: `/api/archive-files/${encodeURIComponent(row.id)}?taskSpaceId=${encodeURIComponent(taskSpaceId)}`,
      })
    }
    return grouped
  }

  function buildBoard(scan, taskSpace) {
    const manualRecords = getManualRecords(db)
    const manualFingerprint = manualStageFingerprint(taskSpace.id, manualRecords)
    const workspaceMembers = Array.isArray(scan.project.workspaceMembers)
      ? scan.project.workspaceMembers
      : Array.isArray(scan.project.members)
        ? scan.project.members
        : []
    const project = {
      ...scan.project,
      workspaceMembers,
      members: [
        ...new Set([
          ...workspaceMembers,
          ...scan.tasks.map((task) => task.assignee || task.creator).filter(Boolean),
        ]),
      ].sort((left, right) => left.localeCompare(right, 'zh-CN')),
    }
    const versions = new Map(scan.tasks.map((task) => [task.relativeDir, task.taskVersion]))
    const linkedTasks = linkTaskGroups([
      {
        tasks: scan.tasks.map((task) => ({
          ...task,
          projectId: taskSpace.id,
          projectName: taskSpace.project_name,
          branchName: taskSpace.branch_name,
          ...withManualStages(task, manualRecords[`${taskSpace.id}/${task.relativeDir}`] || null),
        })),
      },
    ])
    const tasks = linkedTasks.map((task) => ({
      ...toTaskListItem(task),
      taskSpaceId: taskSpace.id,
      taskSpaceRevision: Number(taskSpace.revision),
      branchName: taskSpace.branch_name,
      taskVersion: versions.get(task.relativeDir) || null,
    }))
    const archiveFiles = archiveFilesByTaskDirectory(taskSpace.id)
    const board = {
      generatedAt: new Date().toISOString(),
      projects: [
        {
          ...project,
          id: taskSpace.id,
          projectId: taskSpace.project_id,
          name: taskSpace.project_name,
          branchName: taskSpace.branch_name,
          taskCount: tasks.length,
          activeCount: tasks.filter((task) => !task.archived).length,
          archivedCount: tasks.filter((task) => task.archived).length,
          error: scan.error,
        },
      ],
      tasks,
      stages: stageIds.map((id) => ({ id })),
    }
    return {
      board: projectBoardExecution(board, [], db, new Date(), { executionWipLimit }),
      detailTasks: linkedTasks.map((task) => ({
        ...task,
        taskSpaceId: taskSpace.id,
        taskSpaceRevision: Number(taskSpace.revision),
        branchName: taskSpace.branch_name,
        taskVersion: versions.get(task.relativeDir) || null,
        ...(task.archived ? { files: archiveFiles.get(task.relativeDir) || [] } : {}),
      })),
      manualStageFingerprint: manualFingerprint,
    }
  }

  function readFileMetadata(taskSpaceId, archiveSnapshotId) {
    return db
      .prepare(`
        SELECT relative_path, sha256, deleted, task_dir, revision, 'active' AS source
        FROM sync_task_space_file
        WHERE task_space_id = ?
        UNION ALL
        SELECT f.relative_path, f.sha256, 0 AS deleted, f.task_dir,
               s.archive_revision AS revision, 'archive' AS source
        FROM sync_archive_file f
        JOIN sync_task_space s ON s.id = f.task_space_id
        WHERE f.task_space_id = ?
          AND (f.snapshot_id = ? OR (? IS NULL AND f.snapshot_id IS NULL))
        ORDER BY task_dir, relative_path
      `)
      .all(taskSpaceId, taskSpaceId, archiveSnapshotId, archiveSnapshotId)
  }

  function readContentRows(taskSpaceId, taskDirs = null, archiveSnapshotId = null) {
    if (Array.isArray(taskDirs) && !taskDirs.length) return []
    const activeParams = [taskSpaceId]
    const archiveParams = [taskSpaceId, archiveSnapshotId, archiveSnapshotId]
    let activeFilter = ''
    let archiveFilter = ''
    if (Array.isArray(taskDirs)) {
      const placeholders = bindList(taskDirs)
      activeFilter = ` AND task_dir IN (${placeholders})`
      archiveFilter = ` AND f.task_dir IN (${placeholders})`
      activeParams.push(...taskDirs)
      archiveParams.push(...taskDirs)
    }
    const active = db
      .prepare(`
        SELECT relative_path, content_text, sha256, deleted, task_dir, updated_at,
               'active' AS source, NULL AS source_head, NULL AS storage_key,
               NULL AS mime_type, NULL AS text_excerpt
        FROM sync_task_space_file
        WHERE task_space_id = ? AND deleted = 0${activeFilter}
      `)
      .all(...activeParams)
    const archived = db
      .prepare(`
        SELECT f.relative_path, f.content_text, f.sha256, 0 AS deleted,
               f.task_dir, f.updated_at, 'archive' AS source, f.source_head,
               f.storage_key, f.mime_type, f.text_excerpt
        FROM sync_archive_file f
        WHERE f.task_space_id = ?
          AND (f.snapshot_id = ? OR (? IS NULL AND f.snapshot_id IS NULL))
          ${archiveFilter}
      `)
      .all(...archiveParams)
    const rows = [...active, ...archived].map((row) => {
      if (row.source !== 'archive' || !row.storage_key) return row
      if (!isArchiveTextMimeType(row.mime_type)) return { ...row, content_text: '' }
      if (!archiveSnapshots) {
        throw new Error('归档本地快照存储未装配')
      }
      return {
        ...row,
        content_text: archiveSnapshots.readText(row.storage_key),
      }
    })
    return rows.sort((left, right) =>
      String(left.relative_path).localeCompare(String(right.relative_path), 'en'),
    )
  }

  function canUseProjectionState(state, taskSpace) {
    return Boolean(
      state &&
      state.rawTasksByDir instanceof Map &&
      state.dirFingerprints instanceof Map &&
      state.project &&
      Object.prototype.hasOwnProperty.call(state, 'manualStageFingerprint') &&
      Object.prototype.hasOwnProperty.call(state, 'archiveSnapshotId') &&
      (state.archiveSnapshotId === null || typeof state.archiveSnapshotId === 'string') &&
      Number(state.revision) === Number(taskSpace.indexed_revision) &&
      Number(state.archiveRevision) === Number(taskSpace.archive_indexed_revision),
    )
  }

  function archiveSnapshotIdForTaskSpace(taskSpace) {
    return taskSpace.archive_candidate_snapshot_id || taskSpace.archive_snapshot_id || null
  }

  function changedTaskDirs(state, metadata) {
    const currentFingerprints = taskDirFingerprints(metadata)
    const changed = new Set()
    for (const [taskDir, fingerprint] of currentFingerprints) {
      if (
        !state.dirFingerprints.has(taskDir) ||
        state.dirFingerprints.get(taskDir) !== fingerprint
      ) {
        changed.add(taskDir)
      }
    }
    for (const taskDir of state.dirFingerprints.keys()) {
      if (!currentFingerprints.has(taskDir)) changed.add(taskDir)
    }
    return {
      currentFingerprints,
      changed: [...changed].filter(Boolean),
    }
  }

  function withSnapshotFileMetadata(tasks, rows) {
    // 临时目录文件的 mtime 每次扫描都会变化，归档时间必须取稳定的快照写入时间。
    const taskJsonMetadata = new Map(
      rows
        .filter((row) => row.relative_path === `${row.task_dir}/task.json`)
        .map((row) => [
          row.task_dir,
          {
            updatedAt: row.updated_at,
            source: row.source,
            sourceHead: row.source_head || null,
          },
        ]),
    )
    const archivedMonth = new Map(
      rows
        .filter((row) => row.source === 'archive')
        .map((row) => {
          const match = /^\.trellis\/tasks\/archive\/(\d{4}-\d{2})\//.exec(row.task_dir)
          return [row.task_dir, match?.[1] || null]
        }),
    )
    return tasks.map((task) => {
      if (!task.archived) return { ...task, archivedAt: null }
      const month = archivedMonth.get(task.relativeDir)
      const metadata = taskJsonMetadata.get(task.relativeDir)
      return {
        ...task,
        archivedAt:
          (metadata?.source === 'archive' && metadata.sourceHead && month
            ? `${month}-01T00:00:00.000Z`
            : metadata?.updatedAt) ||
          (month ? `${month}-01T00:00:00.000Z` : null) ||
          task.archivedAt ||
          null,
      }
    })
  }

  function projectForTaskSpace(taskSpace, source = null) {
    return {
      ...(source || {}),
      id: taskSpace.id,
      projectId: taskSpace.project_id,
      name: taskSpace.project_name,
      teamId: taskSpace.owner_team_id,
      teamName: taskSpace.team_name,
      branchName: taskSpace.branch_name,
      branch: taskSpace.branch_name,
      branches: [taskSpace.branch_name],
      head: null,
    }
  }

  function indexRowForTask(task, taskSpace, users, boardVersion, timestamp) {
    const assigneeDevId = task.assignee || null
    return {
      task_space_id: taskSpace.id,
      project_id: taskSpace.project_id,
      task_key: task.taskKey,
      execution_task_key: task.executionTaskKey || task.taskKey,
      relative_dir: task.relativeDir,
      branch_name: taskSpace.branch_name,
      title: String(task.title || ''),
      search_text: searchText({
        ...task,
        projectName: taskSpace.project_name,
        branchName: taskSpace.branch_name,
      }),
      archived: task.archived ? 1 : 0,
      archived_at: task.archivedAt || null,
      priority: String(task.priority || '').trim(),
      derived_stage: String(task.derivedStage || '').trim(),
      assignee_dev_id: assigneeDevId,
      assignee_user_id: assigneeDevId
        ? users.get(String(assigneeDevId).toLowerCase()) || null
        : null,
      due_date: task.execution?.dueDate || null,
      last_activity_at: task.execution?.lastActivityAt || null,
      is_blocked: task.execution?.isBlocked ? 1 : 0,
      is_unblocked_ready: task.execution?.isUnblockedReady ? 1 : 0,
      attention_flags_json: JSON.stringify(task.execution?.attentionReasons || []),
      group_key: task.groupKey || task.taskKey,
      group_role: task.groupRole || 'parent',
      task_version: task.taskVersion,
      board_version: boardVersion,
      updated_at: timestamp,
    }
  }

  const INDEX_FIELDS = [
    'task_space_id',
    'project_id',
    'task_key',
    'execution_task_key',
    'relative_dir',
    'branch_name',
    'title',
    'search_text',
    'archived',
    'archived_at',
    'priority',
    'derived_stage',
    'assignee_dev_id',
    'assignee_user_id',
    'due_date',
    'last_activity_at',
    'is_blocked',
    'is_unblocked_ready',
    'attention_flags_json',
    'group_key',
    'group_role',
    'task_version',
  ]

  function sameIndexValues(left, right) {
    return INDEX_FIELDS.every((field) => left[field] === right[field])
  }

  function sameTags(left, right) {
    return left.length === right.length && left.every((value, index) => value === right[index])
  }

  async function materializeUntilCurrent(taskSpaceId, options) {
    for (;;) {
      const result = await materializeOnce(deps, taskSpaceId, options)
      const latest = taskSpaceRow(taskSpaceId)
      if (
        !latest ||
        latest.retired_at ||
        latest.status === 'disabled' ||
        (Number(latest.indexed_revision) >= Number(latest.revision) &&
          Number(latest.archive_indexed_revision) >= Number(latest.archive_revision))
      ) {
        return result
      }
      options = { ...options, queueWaitMs: 0 }
    }
  }

  function materializeNow(taskSpaceId, options = {}) {
    const id = String(taskSpaceId || '')
    const current = inflight.get(id)
    if (current) return current
    const promise = materializeUntilCurrent(id, options).finally(() => {
      if (inflight.get(id) === promise) inflight.delete(id)
    })
    inflight.set(id, promise)
    return promise
  }

  function enqueue(taskSpaceId, options = {}) {
    const id = String(taskSpaceId || '')
    const source = String(options.source || 'agent')
    const current = queues.get(id)
    if (current) {
      current.requested = true
      current.queuedAt = Date.now()
      current.sources.add(source)
      return current.promise
    }
    const entry = {
      requested: true,
      running: true,
      attempts: 0,
      timer: null,
      promise: null,
      queuedAt: Date.now(),
      sources: new Set([source]),
    }
    async function drain() {
      let lastResult = null
      while (!stopped && entry.requested) {
        entry.requested = false
        const currentSources = new Set(entry.sources)
        entry.sources.clear()
        try {
          const queueWaitMs = entry.queuedAt ? Date.now() - entry.queuedAt : 0
          const source = currentSources.has('agent')
            ? 'agent'
            : currentSources.has('archive')
              ? 'archive'
              : 'warmup'
          const result = await materializeNow(id, {
            queueWaitMs,
            source,
          })
          lastResult = result
          entry.attempts = 0
          if (result?.superseded) {
            const latest = taskSpaceRow(id)
            if (
              latest &&
              (Number(latest.revision) > Number(latest.indexed_revision) ||
                Number(latest.archive_revision) > Number(latest.archive_indexed_revision))
            ) {
              entry.requested = true
              entry.queuedAt = Date.now()
            }
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          logger.warn('任务空间投影失败', { taskSpaceId: id, error: message })
          const latest = taskSpaceRow(id)
          const activeBehind = Boolean(
            latest && Number(latest.revision) > Number(latest.indexed_revision),
          )
          if (activeBehind || currentSources.has('agent')) {
            db.prepare(`
              UPDATE sync_task_space
              SET status = 'error', last_error = ?, updated_at = ?
              WHERE id = ? AND retired_at IS NULL AND status != 'disabled'
            `).run(message.slice(0, 1000), new Date().toISOString(), id)
          }
          onProjectionFailed?.({ taskSpaceId: id, error, sources: [...currentSources] })
          const delay = RETRY_DELAYS[Math.min(entry.attempts, RETRY_DELAYS.length - 1)]
          entry.attempts += 1
          await new Promise((resolve) => {
            entry.timer = setTimeout(resolve, delay)
            entry.timer.unref?.()
          })
          if (!stopped) entry.requested = true
        }
      }
      entry.running = false
      queues.delete(id)
      return lastResult
    }
    entry.promise = drain()
    queues.set(id, entry)
    return entry.promise
  }

  function readTaskSpaceCache(taskSpaceId) {
    const row = db
      .prepare('SELECT * FROM sync_task_space_scan_cache WHERE task_space_id = ?')
      .get(taskSpaceId)
    if (!row) return null
    return {
      board: parseJson(row.board_json, null),
      revision: Number(row.indexed_revision),
      archiveRevision: Number(row.indexed_archive_revision || 0),
      projection: parseProjectionState(row.projection_state_json),
      savedAt: row.saved_at,
    }
  }

  async function ensureMaterialized(taskSpaceId) {
    for (;;) {
      const taskSpace = taskSpaceRow(taskSpaceId)
      if (!taskSpace) return null
      const currentManualFingerprint = manualStageFingerprint(taskSpaceId, getManualRecords(db))
      const currentTaskControlFingerprint = taskControlFingerprint(
        taskControl?.authoritativeTasks(taskSpaceId) || new Map(),
      )
      const targetArchiveSnapshotId = archiveSnapshotIdForTaskSpace(taskSpace)
      const cached = materialized.get(taskSpaceId)
      if (
        !taskSpace.archive_candidate_snapshot_id &&
        cached?.revision === Number(taskSpace.revision) &&
        cached?.archiveRevision === Number(taskSpace.archive_revision) &&
        cached?.archiveSnapshotId === targetArchiveSnapshotId &&
        cached.manualStageFingerprint === currentManualFingerprint &&
        cached.taskControlFingerprint === currentTaskControlFingerprint
      ) {
        return cached
      }
      const result = await materializeNow(taskSpaceId)
      const next = materialized.get(taskSpaceId)
      if (
        !taskSpace.archive_candidate_snapshot_id &&
        next?.revision === Number(taskSpace.revision) &&
        next?.archiveRevision === Number(taskSpace.archive_revision) &&
        next?.archiveSnapshotId === targetArchiveSnapshotId &&
        next.manualStageFingerprint === currentManualFingerprint &&
        next.taskControlFingerprint === currentTaskControlFingerprint
      ) {
        return next
      }
      if (!result?.superseded) return next
    }
  }

  function warmActive() {
    const taskSpaces = db
      .prepare(`
        SELECT s.id
        FROM sync_task_space s
        JOIN sync_project p ON p.id = s.project_id
        WHERE s.status IN ('active', 'indexing', 'error')
          AND s.retired_at IS NULL
          AND p.status = 'active'
        ORDER BY s.created_at, s.id
      `)
      .all()
    return Promise.all(
      taskSpaces.map(async (taskSpace) => {
        try {
          return await enqueue(taskSpace.id, { source: 'warmup' })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          logger.warn?.('任务空间预热失败', { taskSpaceId: taskSpace.id, error: message })
          return null
        }
      }),
    )
  }

  async function close() {
    stopped = true
    for (const entry of queues.values()) {
      if (entry.timer) clearTimeout(entry.timer)
    }
    queues.clear()
    inflight.clear()
    materialized.clear()
    if (!worker) return
    const current = worker
    worker = null
    await current.terminate()
  }

  const deps = {
    archiveQueryRevision,
    archiveSnapshotIdForTaskSpace,
    assigneeUserMap,
    buildBoard,
    canUseProjectionState,
    changedTaskDirs,
    INDEX_FIELDS,
    db,
    incrementArchiveQueryRevision,
    incrementQueryRevision,
    indexRowForTask,
    logger,
    materialized,
    mineMemberSignature,
    onProjected,
    onQueryRevisionChanged,
    pending,
    projectForTaskSpace,
    queryCache,
    queryRevision,
    readContentRows,
    readFileMetadata,
    readTaskSpaceCache,
    replaceIndexInTransaction,
    requestWorker,
    resolveQueryScope: (actor, input) => resolveQueryScope(deps, actor, input),
    sameIndexValues,
    sameTags,
    taskControl,
    taskSpaces,
    taskSpaceRow,
    withSnapshotFileMetadata,
  }

  return {
    buildBoard,
    materializeNow,
    enqueue,
    readTaskSpaceCache,
    ensureMaterialized,
    warmActive,
    queryTasks: (actor, input) => queryTasks(deps, actor, input),
    queryRevision,
    archiveQueryRevision,
    incrementQueryRevision,
    close,
  }
}
