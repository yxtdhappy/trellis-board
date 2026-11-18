import crypto from 'node:crypto'
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

const workerFile = fileURLToPath(new URL('./scan-worker.js', import.meta.url))
const CURSOR_KEY = crypto.randomBytes(32)
const CURSOR_TTL_MS = 10 * 60 * 1000
const DEFAULT_LIMIT = 100
const MAX_LIMIT = 200
const RETRY_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000]
const PROJECTION_STATE_SCHEMA_VERSION = 3

function text(value, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function serializeProjectionState({
  project,
  tasks,
  dirFingerprints,
  projectError,
  manualStageFingerprint,
  taskControlFingerprint,
  detailTasks,
  archiveSnapshotId,
  stats,
}) {
  try {
    return JSON.stringify(
      {
        schemaVersion: PROJECTION_STATE_SCHEMA_VERSION,
        project,
        tasks: [...tasks.entries()],
        dirFingerprints: [...dirFingerprints.entries()],
        projectError: projectError || null,
        manualStageFingerprint,
        taskControlFingerprint,
        detailTasks,
        archiveSnapshotId,
        stats,
      },
      (key, value) => (key === 'repoPath' ? 'trellis-task-space-cache' : value),
    )
  } catch {
    return null
  }
}

function parseProjectionState(value) {
  const state = parseJson(value, null)
  if (
    !state ||
    state.schemaVersion !== PROJECTION_STATE_SCHEMA_VERSION ||
    !state.project ||
    typeof state.project !== 'object' ||
    !Array.isArray(state.tasks) ||
    !Array.isArray(state.dirFingerprints) ||
    !Array.isArray(state.detailTasks) ||
    !Object.prototype.hasOwnProperty.call(state, 'archiveSnapshotId') ||
    (state.archiveSnapshotId !== null && typeof state.archiveSnapshotId !== 'string') ||
    typeof state.manualStageFingerprint !== 'string'
  ) {
    return null
  }
  try {
    const tasks = new Map(state.tasks)
    const dirFingerprints = new Map(state.dirFingerprints)
    if (
      tasks.size !== state.tasks.length ||
      dirFingerprints.size !== state.dirFingerprints.length ||
      [...tasks.values()].some((task) => !task || typeof task !== 'object') ||
      [...dirFingerprints.values()].some((fingerprint) => typeof fingerprint !== 'string')
    ) {
      return null
    }
    return {
      project: state.project,
      rawTasksByDir: tasks,
      dirFingerprints,
      projectError: state.projectError || null,
      manualStageFingerprint: state.manualStageFingerprint,
      taskControlFingerprint:
        typeof state.taskControlFingerprint === 'string' ? state.taskControlFingerprint : null,
      detailTasks: state.detailTasks,
      archiveSnapshotId: state.archiveSnapshotId,
      stats: state.stats && typeof state.stats === 'object' ? state.stats : null,
    }
  } catch {
    return null
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  )
}

function hashValue(value) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(stableValue(value)))
    .digest('hex')
}

function taskDirFingerprints(rows) {
  const grouped = new Map()
  for (const row of rows) {
    const taskDir = String(row.task_dir || '')
    if (!taskDir) continue
    if (!grouped.has(taskDir)) grouped.set(taskDir, [])
    grouped
      .get(taskDir)
      .push([
        String(row.relative_path || ''),
        row.deleted ? 1 : 0,
        row.deleted ? null : String(row.sha256 || ''),
      ])
  }
  return new Map(
    [...grouped.entries()].map(([taskDir, entries]) => [
      taskDir,
      hashValue(entries.sort((left, right) => left[0].localeCompare(right[0], 'en'))),
    ]),
  )
}

function manualStageFingerprint(taskSpaceId, records) {
  return hashValue(
    Object.entries(records)
      .filter(([key]) => key.startsWith(`${taskSpaceId}/`))
      .sort(([left], [right]) => left.localeCompare(right, 'en')),
  )
}

function taskControlFingerprint(authority) {
  return hashValue(
    [...authority.values()]
      .map((task) => [
        task.execution_task_key,
        task.task_key,
        task.relative_dir,
        task.title,
        task.priority,
        task.assignee_user_id,
        task.assignee_dev_id,
        task.archived,
        task.archived_at,
        task.materialization_state,
        task.task_version,
      ])
      .sort(([left], [right]) => left.localeCompare(right, 'en')),
  )
}

function rawTaskMap(tasks) {
  return new Map(tasks.map((task) => [task.relativeDir, task]))
}

class ProjectionSuperseded extends Error {
  constructor(revision) {
    super(`任务空间 revision ${revision} 已被更新`)
    this.revision = revision
  }
}

function encryptCursor(payload) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', CURSOR_KEY, iv)
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url')
}

function decryptCursor(value) {
  try {
    const data = Buffer.from(String(value), 'base64url')
    if (data.length < 29) throw new Error('short')
    const decipher = crypto.createDecipheriv('aes-256-gcm', CURSOR_KEY, data.subarray(0, 12))
    decipher.setAuthTag(data.subarray(12, 28))
    return JSON.parse(
      Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8'),
    )
  } catch {
    throw teamError(409, ERROR_CODES.CURSOR_INVALID, '查询游标无效，请从第一页重新获取', {
      recoverable: true,
    })
  }
}

function shanghaiDay(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

function addDays(day, days) {
  const date = new Date(`${day}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function normalizedLimit(value) {
  if (value == null || value === '') return DEFAULT_LIMIT
  const limit = Number(value)
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, 'limit 必须是 1 到 200 的整数')
  }
  return limit
}

function stringList(value, label, { maxItems = 50, maxLength = 100 } = {}) {
  if (value == null || value === '') return []
  const values = Array.isArray(value) ? value : [value]
  if (values.length > maxItems) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, `${label} 数量过多`)
  }
  return [
    ...new Set(
      values.map((item) => {
        if (typeof item !== 'string' || !item.trim() || item.length > maxLength) {
          throw teamError(400, ERROR_CODES.INVALID_INPUT, `${label} 格式无效`)
        }
        return item.trim()
      }),
    ),
  ]
}

function boolFilter(value, label) {
  if (value == null || value === '') return null
  if (value === true || value === 'true' || value === '1') return true
  if (value === false || value === 'false' || value === '0') return false
  throw teamError(400, ERROR_CODES.INVALID_INPUT, `${label} 只能是 true 或 false`)
}

function normalizeFilters(input = {}) {
  const scope = input.scope == null || input.scope === '' ? 'all' : String(input.scope)
  if (!new Set(['all', 'mine']).has(scope)) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, 'scope 只能是 all 或 mine')
  }
  const preset = input.preset == null || input.preset === '' ? null : String(input.preset)
  if (preset != null && !new Set(['today', 'unblocked-ready']).has(preset)) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, 'preset 无效')
  }
  const q = text(input.q).trim().toLowerCase()
  if (q.length > 200) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, '搜索词不能超过 200 个字符')
  }
  const branch = text(input.branch).trim().toLowerCase()
  if (branch.length > 200) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, '分支筛选不能超过 200 个字符')
  }
  const days = (name) => {
    if (input[name] == null || input[name] === '') return null
    const value = Number(input[name])
    if (!Number.isInteger(value) || value < 0 || value > 3650) {
      throw teamError(400, ERROR_CODES.INVALID_INPUT, `${name} 必须是 0 到 3650 的整数`)
    }
    return value
  }
  return {
    scope,
    q,
    branch,
    priorities: stringList(input.priorities, 'priorities', { maxItems: 4, maxLength: 2 }),
    stages: stringList(input.stages, 'stages', { maxItems: 20, maxLength: 30 }),
    tags: stringList(input.tags, 'tags', { maxItems: 50, maxLength: 50 }),
    assignee: text(input.assignee).trim() || null,
    dueWithinDays: days('dueWithinDays'),
    staleDays: days('staleDays'),
    blocked: boolFilter(input.blocked, 'blocked'),
    archived: boolFilter(input.archived, 'archived') ?? false,
    preset,
    limit: normalizedLimit(input.limit),
  }
}

function bindList(values) {
  return values.map(() => '?').join(', ')
}

function stableTaskIdSql(alias) {
  return `substr(${alias}.execution_task_key, instr(${alias}.execution_task_key, '::') + 2)`
}

function publicRow(row) {
  let attentionReasons = []
  try {
    const parsed = JSON.parse(row.attention_flags_json)
    if (Array.isArray(parsed)) attentionReasons = parsed.map(String)
  } catch {
    // 损坏的关注摘要不影响任务主体。
  }
  const syncStatus =
    row.task_space_status === 'active' &&
    !row.archive_candidate_snapshot_id &&
    Number(row.indexed_revision) === Number(row.revision) &&
    Number(row.archive_indexed_revision) === Number(row.archive_revision)
      ? 'current'
      : row.task_space_status === 'error'
        ? 'needs_repair'
        : 'stale'
  const identityConflict =
    row.execution_identity_conflict === 1 || Number(row.execution_identity_count || 1) > 1
  if (identityConflict) attentionReasons = [...new Set([...attentionReasons, 'identity_conflict'])]
  return {
    taskKey: row.task_key,
    executionTaskKey: row.execution_task_key,
    taskVersion: row.task_version,
    executionIdentityValid: !identityConflict && Boolean(row.execution_task_key),
    executionIdentityConflict: identityConflict,
    projectId: row.project_id,
    projectName: row.project_name,
    taskSpaceId: row.task_space_id,
    taskSpaceRevision: Number(row.revision),
    taskSpaceIndexedRevision: Number(row.indexed_revision),
    branchName: row.branch_name,
    sourceBranchName: row.source_branch_name || row.branch_name,
    teamId: row.team_id || null,
    teamName: row.team_name || null,
    relativeDir: row.relative_dir,
    title: row.title,
    priority: row.priority,
    derivedStage: row.derived_stage,
    archived: Boolean(row.archived),
    archivedAt: row.archived_at || null,
    assignee: row.assignee_dev_id || null,
    assigneeDevId: row.assignee_dev_id || null,
    assigneeUserId: row.assignee_user_id || null,
    previousAssigneeUserId: row.task_previous_assignee_user_id || null,
    materializationState: row.task_materialization_state || 'materialized',
    controlTaskVersion: row.control_task_version == null ? null : Number(row.control_task_version),
    handoffState: row.task_handoff_state || 'none',
    leaseStatus: row.task_lease_status || null,
    leaseExpiresAt: row.task_lease_expires_at || null,
    dueDate: row.due_date || null,
    lastActivityAt: row.last_activity_at || row.updated_at,
    isBlocked: Boolean(row.is_blocked),
    isUnblockedReady: Boolean(row.is_unblocked_ready),
    attentionReasons,
    groupKey: row.group_key,
    groupRole: row.group_role,
    projectSyncStatus: syncStatus,
    stale: syncStatus !== 'current',
    syncError: row.task_space_error || null,
  }
}

function searchText(task) {
  return [
    task.title,
    task.description,
    task.projectName,
    task.branchName,
    task.taskKey,
    task.executionTaskKey,
    task.assignee,
    task.priority,
    task.derivedStage,
    ...(task.stages || []).flatMap((stage) =>
      stage.complete ? [stage.label, stage.evidence] : [],
    ),
    ...(task.execution?.tags || []),
  ]
    .filter(Boolean)
    .join('\n')
    .toLowerCase()
}

function syncAssignments(db, taskSpaceId, projectId, board) {
  const users = new Map(
    db
      .prepare(`
      SELECT m.trellis_dev_id, m.user_id
      FROM sync_project_member m
      JOIN user_account u ON u.id = m.user_id
      WHERE m.project_id = ? AND m.role IN ('lead', 'member') AND u.status = 'active'
    `)
      .all(projectId)
      .map((row) => [String(row.trellis_dev_id).toLowerCase(), row.user_id]),
  )
  const tasks = new Map(
    (board.tasks || [])
      .filter(
        (task) =>
          task.executionTaskKey &&
          task.executionIdentityValid !== false &&
          task.executionIdentityConflict !== true,
      )
      .map((task) => [task.executionTaskKey, task]),
  )
  const existing = db
    .prepare('SELECT * FROM sync_task_assignment WHERE task_space_id = ?')
    .all(taskSpaceId)
  const existingKeys = new Set(existing.map((row) => row.execution_task_key))
  for (const row of existing) {
    const task = tasks.get(row.execution_task_key)
    const userId = task?.assignee ? users.get(String(task.assignee).toLowerCase()) || null : null
    if (!task || !userId) {
      db.prepare('DELETE FROM sync_task_assignment WHERE execution_task_key = ?').run(
        row.execution_task_key,
      )
      continue
    }
    if (userId === row.assigned_user_id) continue
    db.prepare(`
      UPDATE sync_task_assignment
      SET assigned_user_id = ?, state = 'pending', assigned_at = ?,
          accepted_at = NULL, base_task_version = ?, version = version + 1
      WHERE execution_task_key = ?
    `).run(
      userId,
      new Date().toISOString(),
      task.taskVersion || row.base_task_version,
      row.execution_task_key,
    )
  }
  for (const task of tasks.values()) {
    if (existingKeys.has(task.executionTaskKey) || !task.assignee) continue
    const userId = users.get(String(task.assignee).toLowerCase())
    if (!userId) continue
    const now = new Date().toISOString()
    db.prepare(`
      INSERT OR IGNORE INTO sync_task_assignment(
        execution_task_key, task_space_id, project_id, assigned_user_id,
        state, assigned_by, assigned_at, accepted_at, base_task_version, version
      ) VALUES (?, ?, ?, ?, 'pending', ?, ?, NULL, ?, 1)
    `).run(
      task.executionTaskKey,
      taskSpaceId,
      projectId,
      userId,
      userId,
      now,
      task.taskVersion || null,
    )
  }
}

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

  function replaceIndexInTransaction({
    taskSpace,
    board,
    boardVersion,
    targetRevision,
    targetArchiveRevision,
    targetArchiveSnapshotId,
    projectionStateJson,
    expectedManualFingerprint,
  }) {
    return withTransaction(db, () => {
      const latest = taskSpaceRow(taskSpace.id)
      if (
        !latest ||
        Number(latest.revision) !== Number(targetRevision) ||
        Number(latest.archive_revision) !== Number(targetArchiveRevision) ||
        archiveSnapshotIdForTaskSpace(latest) !== targetArchiveSnapshotId ||
        latest.retired_at ||
        latest.status === 'disabled'
      ) {
        throw new ProjectionSuperseded(targetRevision)
      }
      const manualRecords = getManualRecords(db)
      if (manualStageFingerprint(taskSpace.id, manualRecords) !== expectedManualFingerprint) {
        throw new ProjectionSuperseded(targetRevision)
      }

      const users = assigneeUserMap(latest.project_id)
      const timestamp = new Date().toISOString()
      const candidateSnapshotId = latest.archive_candidate_snapshot_id || null
      let archiveChanged = Boolean(candidateSnapshotId)
      if (candidateSnapshotId) {
        const candidate = db
          .prepare(`
            SELECT id
            FROM sync_archive_snapshot
            WHERE id = ? AND task_space_id = ? AND status = 'published'
          `)
          .get(candidateSnapshotId, latest.id)
        if (!candidate) throw new Error('归档候选快照不存在，拒绝提交索引')
        db.prepare(`
          UPDATE sync_archive_snapshot
          SET status = 'retired', active = 0, retired_at = ?
          WHERE task_space_id = ? AND id <> ? AND active = 1
        `).run(timestamp, latest.id, candidateSnapshotId)
        db.prepare(`
          UPDATE sync_archive_snapshot
          SET status = 'published', active = 1, published_at = ?, retired_at = NULL
          WHERE id = ?
        `).run(timestamp, candidateSnapshotId)
      }
      const existingRows = db
        .prepare('SELECT * FROM sync_task_index WHERE task_space_id = ?')
        .all(taskSpace.id)
      const existingByKey = new Map(existingRows.map((row) => [row.task_key, row]))
      const existingTags = new Map()
      for (const row of db
        .prepare(
          `SELECT task_key, tag_key FROM sync_task_index_tag
           WHERE task_space_id = ? ORDER BY task_key, tag_key`,
        )
        .all(taskSpace.id)) {
        if (!existingTags.has(row.task_key)) existingTags.set(row.task_key, [])
        existingTags.get(row.task_key).push(row.tag_key)
      }

      const tasksByExecutionKey = new Map()
      for (const task of board.tasks || []) {
        if (!task.taskVersion) continue
        const executionTaskKey = task.executionTaskKey || task.taskKey
        const group = tasksByExecutionKey.get(executionTaskKey) || []
        group.push(task)
        tasksByExecutionKey.set(executionTaskKey, group)
      }
      const projectedTasks = [...tasksByExecutionKey.values()].flatMap((group) => {
        const archived = group.filter((task) => task.archived)
        return archived.length > 0 ? archived : group
      })
      const authority = taskControl?.authoritativeTasks(taskSpace.id) || new Map()
      const desired = new Map()
      const desiredTags = new Map()
      for (const task of projectedTasks) {
        const row = indexRowForTask(task, latest, users, boardVersion, timestamp)
        const controlled = authority.get(row.execution_task_key)
        if (controlled) {
          if (controlled.archived && controlled.task_key) row.task_key = controlled.task_key
          row.relative_dir = controlled.relative_dir || row.relative_dir
          row.title = controlled.title || row.title
          row.assignee_user_id = controlled.assignee_user_id || row.assignee_user_id
          row.assignee_dev_id = controlled.assignee_dev_id || row.assignee_dev_id
          row.archived = controlled.archived ? 1 : row.archived
          row.archived_at = controlled.archived_at || row.archived_at
        }
        desired.set(row.task_key, row)
        desiredTags.set(
          row.task_key,
          [...new Set((task.execution?.tags || []).map((tag) => String(tag).toLowerCase()))].sort(),
        )
      }
      for (const pending of taskControl?.pendingTasks(taskSpace.id) || []) {
        const taskKey = pending.task_key
        if (desired.has(taskKey)) continue
        desired.set(taskKey, {
          task_space_id: taskSpace.id,
          project_id: taskSpace.project_id,
          task_key: taskKey,
          execution_task_key: pending.execution_task_key,
          relative_dir: pending.relative_dir,
          branch_name: taskSpace.branch_name,
          title: pending.title,
          search_text: searchText({
            title: pending.title,
            taskKey,
            relativeDir: pending.relative_dir,
            projectName: taskSpace.project_name,
            branchName: taskSpace.branch_name,
          }),
          archived: 0,
          archived_at: null,
          priority: pending.priority,
          derived_stage: 'planning',
          assignee_dev_id: pending.assignee_dev_id,
          assignee_user_id: pending.assignee_user_id,
          due_date: null,
          last_activity_at: pending.updated_at,
          is_blocked: 0,
          is_unblocked_ready: 0,
          attention_flags_json: '[]',
          group_key: taskKey,
          group_role: 'parent',
          task_version: String(pending.task_version),
          board_version: boardVersion,
          updated_at: timestamp,
        })
        desiredTags.set(taskKey, [])
      }
      taskControl?.reconcileProjection({
        taskSpaceId: taskSpace.id,
        projectId: taskSpace.project_id,
        tasks: projectedTasks,
      })

      const upsert = db.prepare(`
        INSERT INTO sync_task_index(
          task_space_id, project_id, task_key, execution_task_key, relative_dir,
          branch_name, title, search_text, archived, archived_at, priority,
          derived_stage, assignee_dev_id, assignee_user_id, due_date,
          last_activity_at, is_blocked, is_unblocked_ready, attention_flags_json,
          group_key, group_role, task_version, board_version, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(task_space_id, task_key) DO UPDATE SET
          project_id = excluded.project_id,
          execution_task_key = excluded.execution_task_key,
          relative_dir = excluded.relative_dir,
          branch_name = excluded.branch_name,
          title = excluded.title,
          search_text = excluded.search_text,
          archived = excluded.archived,
          archived_at = excluded.archived_at,
          priority = excluded.priority,
          derived_stage = excluded.derived_stage,
          assignee_dev_id = excluded.assignee_dev_id,
          assignee_user_id = excluded.assignee_user_id,
          due_date = excluded.due_date,
          last_activity_at = excluded.last_activity_at,
          is_blocked = excluded.is_blocked,
          is_unblocked_ready = excluded.is_unblocked_ready,
          attention_flags_json = excluded.attention_flags_json,
          group_key = excluded.group_key,
          group_role = excluded.group_role,
          task_version = excluded.task_version,
          board_version = excluded.board_version,
          updated_at = excluded.updated_at
      `)
      const insertTag = db.prepare(`
        INSERT OR IGNORE INTO sync_task_index_tag(task_space_id, task_key, tag_key)
        VALUES (?, ?, ?)
      `)
      const deleteTag = db.prepare(
        'DELETE FROM sync_task_index_tag WHERE task_space_id = ? AND task_key = ?',
      )
      const deleteIndex = db.prepare(
        'DELETE FROM sync_task_index WHERE task_space_id = ? AND task_key = ?',
      )
      const changedKeys = new Set()

      for (const [taskKey, row] of desired) {
        const previous = existingByKey.get(taskKey)
        const tagsChanged = !sameTags(existingTags.get(taskKey) || [], desiredTags.get(taskKey))
        if (!previous || !sameIndexValues(previous, row) || tagsChanged) {
          upsert.run(...INDEX_FIELDS.map((field) => row[field]), row.board_version, row.updated_at)
          if (tagsChanged || !previous) {
            deleteTag.run(taskSpace.id, taskKey)
            for (const tag of desiredTags.get(taskKey)) insertTag.run(taskSpace.id, taskKey, tag)
          }
          changedKeys.add(taskKey)
          if (row.archived || previous?.archived) archiveChanged = true
        }
      }
      for (const taskKey of existingByKey.keys()) {
        if (desired.has(taskKey)) continue
        deleteIndex.run(taskSpace.id, taskKey)
        changedKeys.add(taskKey)
        if (existingByKey.get(taskKey)?.archived) archiveChanged = true
      }

      // ponytail: 归档版本只看归档行；baseline 空间的身份增删会改变归档去重可见性，
      // 若该极端场景成真，把 baseline 空间插入/删除的执行身份纳入 archiveChanged 判定。

      db.prepare(`
        INSERT INTO sync_task_space_scan_cache(
          task_space_id, indexed_revision, indexed_archive_revision,
          projection_state_json, board_json, saved_at
        )
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(task_space_id) DO UPDATE SET
          indexed_revision = excluded.indexed_revision,
          indexed_archive_revision = excluded.indexed_archive_revision,
          projection_state_json = excluded.projection_state_json,
          board_json = excluded.board_json,
          saved_at = excluded.saved_at
      `).run(
        taskSpace.id,
        targetRevision,
        targetArchiveRevision,
        projectionStateJson,
        JSON.stringify(board),
        timestamp,
      )
      syncAssignments(db, taskSpace.id, latest.project_id, board)
      const updated = db
        .prepare(`
        UPDATE sync_task_space
        SET status = 'active', indexed_revision = ?, archive_indexed_revision = ?,
            archive_snapshot_id = ?, archive_candidate_snapshot_id = NULL,
            last_error = NULL, updated_at = ?
        WHERE id = ? AND revision = ? AND archive_revision = ?
          AND archive_snapshot_id IS ? AND archive_candidate_snapshot_id IS ?
          AND retired_at IS NULL AND status != 'disabled'
      `)
        .run(
          targetRevision,
          targetArchiveRevision,
          targetArchiveSnapshotId,
          timestamp,
          taskSpace.id,
          targetRevision,
          targetArchiveRevision,
          latest.archive_snapshot_id || null,
          candidateSnapshotId,
        )
      if (Number(updated.changes) !== 1) throw new ProjectionSuperseded(targetRevision)
      return {
        queryRevision: incrementQueryRevision({ publish: false }),
        archiveQueryRevision: archiveChanged
          ? incrementArchiveQueryRevision()
          : archiveQueryRevision(),
        changedIndexCount: changedKeys.size,
      }
    })
  }

  async function materializeOnce(taskSpaceId, options = {}) {
    const startedAt = Date.now()
    const taskSpace = taskSpaceRow(taskSpaceId)
    if (!taskSpace) throw new Error('任务空间不存在')
    const targetRevision = Number(taskSpace.revision)
    const targetArchiveRevision = Number(taskSpace.archive_revision)
    const targetArchiveSnapshotId = archiveSnapshotIdForTaskSpace(taskSpace)
    let state = materialized.get(taskSpaceId)
    if (!state) {
      const cached = readTaskSpaceCache(taskSpaceId)
      if (cached?.board && cached.projection) {
        state = {
          ...cached.projection,
          revision: cached.revision,
          archiveRevision: cached.archiveRevision,
          board: cached.board,
          savedAt: cached.savedAt,
        }
        materialized.set(taskSpaceId, state)
      }
    }
    const currentManualRecords = getManualRecords(db)
    const currentManualFingerprint = manualStageFingerprint(taskSpace.id, currentManualRecords)
    const authority = taskControl?.authoritativeTasks(taskSpace.id) || new Map()
    const currentTaskControlFingerprint = taskControlFingerprint(authority)
    const canIncremental = canUseProjectionState(state, taskSpace)
    const stats = {
      mode: canIncremental ? 'incremental' : 'full',
      baseRevision: canIncremental ? Number(state.revision) : null,
      baseArchiveRevision: canIncremental ? Number(state.archiveRevision) : null,
      targetRevision,
      targetArchiveRevision,
      queueWaitMs: Number(options.queueWaitMs || 0),
      changedTaskCount: 0,
      scannedTaskCount: 0,
      reusedTaskCount: 0,
      contentRowsRead: 0,
      workerMs: 0,
      relationshipMs: 0,
      databaseMs: 0,
      totalMs: 0,
      result: 'committed',
    }

    if (
      canIncremental &&
      targetRevision === Number(state.revision) &&
      targetArchiveRevision === Number(state.archiveRevision) &&
      targetArchiveSnapshotId === state.archiveSnapshotId &&
      !taskSpace.archive_candidate_snapshot_id &&
      currentManualFingerprint === state.manualStageFingerprint &&
      currentTaskControlFingerprint === state.taskControlFingerprint
    ) {
      const lastStats = state.stats || stats
      return {
        superseded: false,
        noop: true,
        revision: targetRevision,
        archiveRevision: targetArchiveRevision,
        archiveSnapshotId: targetArchiveSnapshotId,
        board: state.board,
        stats: {
          ...lastStats,
          result: 'noop',
          totalMs: Date.now() - startedAt,
        },
      }
    }

    const metadata = readFileMetadata(taskSpaceId, targetArchiveSnapshotId)
    const changeState = canIncremental
      ? changedTaskDirs(state, metadata)
      : { currentFingerprints: taskDirFingerprints(metadata), changed: [] }
    const changedSet = new Set(changeState.changed)
    const changedRows = canIncremental
      ? readContentRows(taskSpaceId, changeState.changed, targetArchiveSnapshotId)
      : []
    const manualOnly =
      canIncremental &&
      !changeState.changed.length &&
      currentManualFingerprint !== state.manualStageFingerprint
    if (manualOnly) stats.mode = 'manual-reproject'
    stats.changedTaskCount = changeState.changed.length
    stats.contentRowsRead = canIncremental
      ? changedRows.length
      : metadata.filter((row) => !row.deleted).length

    let scan = null
    let project = canIncremental ? state.project : null
    let projectError = canIncremental ? state.projectError || null : null
    if (!canIncremental) {
      const rows = readContentRows(taskSpaceId, null, targetArchiveSnapshotId)
      stats.contentRowsRead = rows.length
      const workerStartedAt = Date.now()
      const rawScan = (
        await requestWorker(
          'snapshot-materialize',
          {
            project: {
              id: taskSpace.id,
              projectId: taskSpace.project_id,
              name: taskSpace.project_name,
              teamId: taskSpace.owner_team_id,
              teamName: taskSpace.team_name,
              branchName: taskSpace.branch_name,
              members: db
                .prepare(`
                SELECT trellis_dev_id
                FROM sync_project_member
                WHERE project_id = ? AND trellis_dev_id IS NOT NULL
                ORDER BY trellis_dev_id
              `)
                .all(taskSpace.project_id)
                .map((row) => row.trellis_dev_id),
            },
            rows,
            revision: targetRevision,
          },
          'snapshot-materialize-result',
        )
      ).scan
      scan = {
        ...rawScan,
        tasks: withSnapshotFileMetadata(rawScan.tasks, rows),
      }
      stats.workerMs = Date.now() - workerStartedAt
      project = projectForTaskSpace(taskSpace, scan.project)
      projectError = scan.error || null
      stats.scannedTaskCount = scan.tasks.length
    } else if (changedRows.length) {
      const workerStartedAt = Date.now()
      const rawScan = (
        await requestWorker(
          'snapshot-materialize',
          {
            project: {
              ...state.project,
              id: taskSpace.id,
              projectId: taskSpace.project_id,
              name: taskSpace.project_name,
              teamId: taskSpace.owner_team_id,
              teamName: taskSpace.team_name,
              branchName: taskSpace.branch_name,
            },
            rows: changedRows,
            revision: targetRevision,
          },
          'snapshot-materialize-result',
        )
      ).scan
      scan = {
        ...rawScan,
        tasks: withSnapshotFileMetadata(rawScan.tasks, changedRows),
      }
      stats.workerMs = Date.now() - workerStartedAt
      if (scan.error) throw new Error(`增量任务扫描失败：${scan.error}`)
      projectError = metadata.some((row) => !row.deleted) ? null : state.projectError || null
      stats.scannedTaskCount = scan.tasks.length
    }

    const latest = taskSpaceRow(taskSpaceId)
    if (
      !latest ||
      Number(latest.revision) !== targetRevision ||
      Number(latest.archive_revision) !== targetArchiveRevision
    ) {
      stats.totalMs = Date.now() - startedAt
      stats.result = 'superseded'
      return { superseded: true, revision: targetRevision, stats }
    }
    if (latest.retired_at || latest.status === 'disabled') {
      stats.totalMs = Date.now() - startedAt
      stats.result = 'superseded'
      return { superseded: true, revision: targetRevision, stats }
    }

    const nextRawTasks = canIncremental
      ? new Map(state.rawTasksByDir)
      : rawTaskMap(scan?.tasks || [])
    if (canIncremental) {
      for (const taskDir of changeState.changed) nextRawTasks.delete(taskDir)
      for (const task of scan?.tasks || []) {
        if (!changedSet.has(task.relativeDir)) {
          throw new Error('增量扫描返回了未请求的任务目录')
        }
        nextRawTasks.set(task.relativeDir, task)
      }
    }
    stats.reusedTaskCount = canIncremental
      ? [...nextRawTasks.keys()].filter((taskDir) => !changedSet.has(taskDir)).length
      : 0

    const relationshipStartedAt = Date.now()
    const materializedBoard = buildBoard(
      {
        project,
        tasks: [...nextRawTasks.values()],
        error: projectError,
      },
      latest,
    )
    stats.relationshipMs = Date.now() - relationshipStartedAt
    const board = materializedBoard.board
    const boardVersion = hashValue({
      taskSpaceId,
      revision: targetRevision,
      archiveRevision: targetArchiveRevision,
      manualStageFingerprint: materializedBoard.manualStageFingerprint,
      taskControlFingerprint: currentTaskControlFingerprint,
      tasks: [...nextRawTasks.entries()]
        .sort(([left], [right]) => left.localeCompare(right, 'en'))
        .map(([taskDir, task]) => [taskDir, task.taskVersion || null]),
    })
    const projectionStateJson = serializeProjectionState({
      project,
      tasks: nextRawTasks,
      dirFingerprints: changeState.currentFingerprints,
      projectError,
      manualStageFingerprint: materializedBoard.manualStageFingerprint,
      taskControlFingerprint: currentTaskControlFingerprint,
      detailTasks: materializedBoard.detailTasks,
      archiveSnapshotId: targetArchiveSnapshotId,
      stats,
    })

    let result
    const databaseStartedAt = Date.now()
    try {
      result = replaceIndexInTransaction({
        taskSpace: latest,
        board,
        boardVersion,
        targetRevision,
        targetArchiveRevision,
        targetArchiveSnapshotId,
        projectionStateJson,
        expectedManualFingerprint: materializedBoard.manualStageFingerprint,
      })
    } catch (error) {
      if (error instanceof ProjectionSuperseded) {
        stats.totalMs = Date.now() - startedAt
        stats.result = 'superseded'
        return { superseded: true, revision: targetRevision, stats }
      }
      throw error
    }
    stats.databaseMs = Date.now() - databaseStartedAt
    stats.totalMs = Date.now() - startedAt
    onQueryRevisionChanged?.(result.queryRevision)
    onProjected?.({
      taskSpaceId,
      projectId: latest.project_id,
      revision: targetRevision,
      archiveRevision: targetArchiveRevision,
      archiveSnapshotId: targetArchiveSnapshotId,
      source: options.source || 'agent',
      activeAdvanced:
        (options.source || 'agent') === 'agent' ||
        Boolean(state && targetRevision > Number(state.revision)),
      archiveAdvanced: state
        ? targetArchiveRevision > Number(state.archiveRevision)
        : targetArchiveRevision > 0 || targetArchiveSnapshotId !== null,
      board,
    })
    const nextState = {
      revision: targetRevision,
      archiveRevision: targetArchiveRevision,
      archiveSnapshotId: targetArchiveSnapshotId,
      board,
      detailTasks: materializedBoard.detailTasks,
      rawTasksByDir: nextRawTasks,
      dirFingerprints: changeState.currentFingerprints,
      project,
      projectError,
      manualStageFingerprint: materializedBoard.manualStageFingerprint,
      taskControlFingerprint: currentTaskControlFingerprint,
      stats: { ...stats },
    }
    materialized.set(taskSpaceId, nextState)
    logger.info?.('任务空间投影完成', {
      ...stats,
      taskCount: nextRawTasks.size,
      changedIndexCount: result.changedIndexCount,
    })
    return {
      superseded: false,
      revision: targetRevision,
      archiveRevision: targetArchiveRevision,
      archiveSnapshotId: targetArchiveSnapshotId,
      boardVersion,
      board,
      queryRevision: result.queryRevision,
      stats,
    }
  }

  async function materializeUntilCurrent(taskSpaceId, options) {
    for (;;) {
      const result = await materializeOnce(taskSpaceId, options)
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

  function resolveQueryScope(actor, input) {
    const requestedTaskSpaceId = String(input.taskSpaceId || '').trim()
    const taskSpaceId = requestedTaskSpaceId === 'all' ? '' : requestedTaskSpaceId
    const requestedProjectIds = stringList(input.projectIds, 'projectIds', {
      maxItems: 200,
      maxLength: 200,
    })
    if (taskSpaceId) {
      const context = taskSpaces.authorizeTaskSpace(actor, taskSpaceId, 'view')
      const projectId = context.taskSpace.project_id
      if (
        requestedProjectIds.length &&
        (requestedProjectIds.length !== 1 || requestedProjectIds[0] !== projectId)
      ) {
        throw teamError(403, ERROR_CODES.FORBIDDEN, '查询包含无权访问的项目')
      }
      const teamScope = String(input.teamId || '').trim()
      if (teamScope && teamScope !== 'all') {
        const readable = taskSpaces.listReadable(actor, { teamId: teamScope })
        const scoped = readable.some(
          (project) =>
            project.id === projectId &&
            project.taskSpaces.some((taskSpace) => taskSpace.id === taskSpaceId),
        )
        if (!scoped) {
          throw teamError(404, ERROR_CODES.NOT_FOUND, '任务空间不存在')
        }
      }
      return {
        projectIds: [projectId],
        taskSpaceIds: [taskSpaceId],
      }
    }
    const readable = taskSpaces.listReadable(actor, { teamId: input.teamId })
    const byProjectId = new Map(readable.map((project) => [project.id, project]))
    const requested = requestedProjectIds.filter((projectId) => byProjectId.has(projectId))
    if (requested.length !== requestedProjectIds.length) {
      throw teamError(403, ERROR_CODES.FORBIDDEN, '查询包含无权访问的项目')
    }
    const projects = requested.length
      ? requested.map((projectId) => byProjectId.get(projectId))
      : readable
    return {
      projectIds: [...new Set(projects.map((project) => project.id))].sort(),
      taskSpaceIds: [
        ...new Set(
          projects.flatMap((project) => project.taskSpaces.map((taskSpace) => taskSpace.id)),
        ),
      ].sort(),
    }
  }

  function queryTasks(actor, input = {}) {
    const filters = normalizeFilters(input)
    const teamScope = resolveTeamScope(db, actor, input.teamId)
    const scope = resolveQueryScope(actor, input)
    const scopeHash = hashValue(scope)
    const filterHash = hashValue(filters)
    const mineMembers = filters.scope === 'mine' ? mineMemberSignature(actor.userId) : null
    const revision = filters.archived ? archiveQueryRevision() : queryRevision()
    const day = shanghaiDay()
    const etag = `"${hashValue({
      user: actor.userId,
      team: teamScope,
      scope,
      filterHash,
      members: mineMembers,
      revision,
      day,
    })}"`
    if (input.ifNoneMatch && input.ifNoneMatch === etag) {
      return {
        notModified: true,
        etag,
        queryRevision: revision,
        queryDay: day,
      }
    }
    const cacheKey = hashValue({
      user: filters.scope === 'mine' || input.cursor ? actor.userId : null,
      team: teamScope,
      scopeHash,
      filterHash,
      members: mineMembers,
      cursor: input.cursor || null,
      revision,
      day,
    })
    if (!scope.taskSpaceIds.length) {
      return {
        tasks: [],
        total: 0,
        assignees: [],
        nextCursor: null,
        etag,
        queryRevision: revision,
        queryDay: day,
      }
    }
    const where = [
      `t.task_space_id IN (${bindList(scope.taskSpaceIds)})`,
      't.archived = ?',
      `NOT EXISTS (
        SELECT 1
        FROM sync_project owner
        JOIN sync_task_space baseline
          ON baseline.project_id = owner.id
         AND baseline.branch_name = owner.baseline_branch
        JOIN sync_task_index baseline_task
          ON baseline_task.task_space_id = baseline.id
         AND baseline_task.execution_task_key = baseline.id || '::' || ${stableTaskIdSql('t')}
        WHERE owner.id = t.project_id
          AND baseline.id <> t.task_space_id
      )`,
    ]
    const params = [...scope.taskSpaceIds, filters.archived ? 1 : 0]
    if (filters.scope === 'mine') {
      // 成员 dev id 变更不重建索引，按任务所属项目当前配置的 developer id 判定。
      where.push(`EXISTS (
        SELECT 1 FROM sync_project_member mine
        WHERE mine.project_id = t.project_id
          AND mine.user_id = ?
          AND mine.trellis_dev_id IS NOT NULL
          AND t.assignee_dev_id = mine.trellis_dev_id COLLATE NOCASE
      )`)
      params.push(actor.userId)
    }
    if (filters.q) {
      where.push("t.search_text LIKE ? ESCAPE '\\'")
      params.push(`%${filters.q.replace(/[\\%_]/g, '\\$&')}%`)
    }
    if (filters.branch) {
      where.push("trellis_lower(t.branch_name) LIKE ? ESCAPE '\\'")
      params.push(`%${filters.branch.replace(/[\\%_]/g, '\\$&')}%`)
    }
    if (filters.priorities.length) {
      where.push(`t.priority IN (${bindList(filters.priorities)})`)
      params.push(...filters.priorities)
    }
    if (filters.stages.length) {
      where.push(`t.derived_stage IN (${bindList(filters.stages)})`)
      params.push(...filters.stages)
    }
    if (filters.tags.length) {
      where.push(`EXISTS (
        SELECT 1 FROM sync_task_index_tag tag
        WHERE tag.task_space_id = t.task_space_id
          AND tag.task_key = t.task_key
          AND tag.tag_key IN (${bindList(filters.tags)})
      )`)
      params.push(...filters.tags.map((tag) => tag.toLowerCase()))
    }
    const assigneeFacetWhere = [...where]
    const assigneeFacetParams = [...params]
    if (filters.assignee) {
      where.push('(t.assignee_user_id = ? OR t.assignee_dev_id = ? COLLATE NOCASE)')
      params.push(filters.assignee, filters.assignee)
    }
    if (filters.dueWithinDays != null) {
      where.push('t.due_date IS NOT NULL AND t.due_date <= ?')
      params.push(addDays(day, filters.dueWithinDays))
    }
    if (filters.staleDays != null) {
      where.push('COALESCE(t.last_activity_at, t.updated_at) <= ?')
      params.push(new Date(Date.now() - filters.staleDays * 86_400_000).toISOString())
    }
    if (filters.blocked != null) {
      where.push('t.is_blocked = ?')
      params.push(filters.blocked ? 1 : 0)
    }
    if (filters.preset === 'today') {
      where.push('t.due_date IS NOT NULL AND t.due_date <= ?')
      params.push(day)
    }
    if (filters.preset === 'unblocked-ready') where.push('t.is_unblocked_ready = 1')
    const total = Number(
      db
        .prepare(`SELECT COUNT(*) AS count FROM sync_task_index t WHERE ${where.join(' AND ')}`)
        .get(...params).count,
    )
    const assignees = filters.archived
      ? db
          .prepare(`
          SELECT DISTINCT t.assignee_dev_id AS assignee
          FROM sync_task_index t
          WHERE ${assigneeFacetWhere.join(' AND ')}
            AND t.assignee_dev_id IS NOT NULL
            AND length(trim(t.assignee_dev_id)) > 0
          ORDER BY t.assignee_dev_id COLLATE NOCASE
        `)
          .all(...assigneeFacetParams)
          .map((row) => row.assignee)
      : []
    const pageWhere = [...where]
    const pageParams = [...params]
    const orderAnchor = filters.archived
      ? 'COALESCE(t.archived_at, t.updated_at)'
      : 'COALESCE(t.last_activity_at, t.updated_at)'
    if (input.cursor) {
      const cursor = decryptCursor(input.cursor)
      if (
        Date.now() > cursor.exp ||
        cursor.u !== actor.userId ||
        cursor.g !== teamScope ||
        cursor.s !== scopeHash ||
        cursor.f !== filterHash ||
        cursor.r !== revision ||
        cursor.d !== day
      ) {
        throw teamError(409, ERROR_CODES.CURSOR_INVALID, '查询游标已过期，请从第一页重试', {
          recoverable: true,
        })
      }
      pageWhere.push(`(
        ${orderAnchor} < ?
        OR (
          ${orderAnchor} = ?
          AND (
            t.task_space_id < ?
            OR (t.task_space_id = ? AND t.task_key < ?)
          )
        )
      )`)
      pageParams.push(cursor.sa, cursor.sa, cursor.ts, cursor.ts, cursor.tk)
    }
    const rows = db
      .prepare(`
      SELECT
        t.*,
        (SELECT COUNT(*)
         FROM sync_task_index duplicate
         WHERE duplicate.task_space_id = t.task_space_id
           AND duplicate.execution_task_key = t.execution_task_key) AS execution_identity_count,
        p.name AS project_name, p.owner_team_id AS team_id, team.name AS team_name,
        s.status AS task_space_status, s.revision, s.indexed_revision,
        s.archive_revision, s.archive_indexed_revision, s.archive_candidate_snapshot_id,
        s.last_error AS task_space_error,
        evidence.source_branch_name,
        controlled.materialization_state AS task_materialization_state,
        controlled.task_version AS control_task_version,
        controlled.previous_assignee_user_id AS task_previous_assignee_user_id,
        controlled.handoff_state AS task_handoff_state,
        currentLease.status AS task_lease_status,
        currentLease.expires_at AS task_lease_expires_at
      FROM sync_task_index t
      JOIN sync_task_space s ON s.id = t.task_space_id
      JOIN sync_project p ON p.id = t.project_id
      JOIN team ON team.id = p.owner_team_id
      LEFT JOIN sync_task controlled
        ON controlled.task_space_id = t.task_space_id
       AND controlled.execution_task_key = t.execution_task_key
      LEFT JOIN sync_task_lease currentLease
        ON currentLease.id = (
          SELECT lease.id
          FROM sync_task_lease lease
          WHERE lease.execution_task_key = controlled.execution_task_key
          ORDER BY lease.created_at DESC, lease.id DESC
          LIMIT 1
        )
      LEFT JOIN sync_task_merge_evidence evidence
        ON evidence.project_id = t.project_id
       AND evidence.task_id = ${stableTaskIdSql('t')}
      WHERE ${pageWhere.join(' AND ')}
      ORDER BY ${orderAnchor} DESC, t.task_space_id DESC, t.task_key DESC
      LIMIT ?
    `)
      .all(...pageParams, filters.limit + 1)
    const pageRows = rows.slice(0, filters.limit)
    const last = rows.length > filters.limit ? pageRows.at(-1) : null
    const nextCursor = last
      ? encryptCursor({
          u: actor.userId,
          g: teamScope,
          s: scopeHash,
          f: filterHash,
          r: revision,
          d: day,
          sa: filters.archived
            ? last.archived_at || last.updated_at
            : last.last_activity_at || last.updated_at,
          ts: last.task_space_id,
          tk: last.task_key,
          exp: Date.now() + CURSOR_TTL_MS,
        })
      : null
    const tasks = pageRows.map(publicRow)
    const result = {
      tasks,
      total,
      assignees,
      nextCursor,
      etag,
      queryRevision: revision,
      queryDay: day,
    }
    queryCache.set(cacheKey, result)
    if (queryCache.size > 64) queryCache.delete(queryCache.keys().next().value)
    return result
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

  return {
    buildBoard,
    materializeNow,
    enqueue,
    readTaskSpaceCache,
    ensureMaterialized,
    warmActive,
    queryTasks,
    queryRevision,
    archiveQueryRevision,
    incrementQueryRevision,
    close,
  }
}
