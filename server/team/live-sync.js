import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { TextDecoder } from 'node:util'
import { withTransaction } from '../database.js'
import { appendAuditEvent } from './audit.js'
import { ERROR_CODES, teamError } from './errors.js'
import { readGitProject } from './git-manager.js'
import { readableProjectIds, roleCanWrite } from './permissions.js'
import {
  TASK_SNAPSHOT_MAX_BATCH_BYTES,
  TASK_SNAPSHOT_MAX_FILE_BYTES,
  TASK_SNAPSHOT_MAX_FILES,
} from '../../shared/task-snapshot.js'

const RATE_WINDOW_MS = 1000
const RATE_LIMIT = 5
const WARNING_TTL_MS = 5 * 60 * 1000
const PROJECTION_RETRY_BASE_MS = 1000
const PROJECTION_RETRY_MAX_MS = 30_000
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SAFE_BATCH_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/
const TEXT_EXTENSIONS = new Set(['.json', '.jsonl', '.md', '.txt', '.yaml', '.yml'])
const LIVE_STATUSES = new Set(['current', 'stale', 'pending_push', 'needs_repair'])
const utf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
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

function requestHash(value) {
  return digest(JSON.stringify(stableValue(value)))
}

function normalizeLivePath(value) {
  const raw = String(value || '')
    .replaceAll('\\', '/')
    .trim()
  if (!raw || raw.includes('\0') || raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, '实时文件路径无效')
  }
  const normalized = path.posix.normalize(raw).replace(/^\.\/+/, '')
  if (normalized.startsWith('../') || normalized === '..' || normalized !== raw) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, '实时文件路径不允许目录穿越')
  }
  if (
    normalized !== '.trellis/.developer' &&
    !normalized.startsWith('.trellis/tasks/') &&
    !normalized.startsWith('.trellis/workspace/')
  ) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, '实时文件不在允许的 .trellis 目录')
  }
  if (normalized.endsWith('/')) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, '实时文件路径不能是目录')
  }
  if (normalized !== '.trellis/.developer') {
    const extension = path.posix.extname(normalized).toLowerCase()
    if (!TEXT_EXTENSIONS.has(extension)) {
      throw teamError(400, ERROR_CODES.INVALID_INPUT, '实时同步只接受 UTF-8 文本文件')
    }
  }
  return normalized
}

function assertNoSymlink(root, relativePath) {
  let current = root
  for (const part of relativePath.split('/')) {
    current = path.join(current, part)
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        throw teamError(400, ERROR_CODES.INVALID_INPUT, '实时同步路径不能经过符号链接')
      }
    } catch (error) {
      if (error?.code === 'ENOENT') return
      throw error
    }
  }
}

function relativeTaskDir(relativePath) {
  if (!relativePath.startsWith('.trellis/tasks/') || relativePath === '.trellis/tasks/') {
    return null
  }
  const rest = relativePath.slice('.trellis/tasks/'.length)
  const parts = rest.split('/')
  if (parts[0] === 'archive') {
    return parts.length >= 4 ? `.trellis/tasks/archive/${parts[1]}/${parts[2]}` : null
  }
  return parts.length >= 2 ? `.trellis/tasks/${parts[0]}` : null
}

function taskDirFromIndex(db, projectId, relativePath) {
  const candidates = db
    .prepare(`
    SELECT relative_dir, task_key, execution_task_key
    FROM team_task_index
    WHERE project_id = ? AND ? LIKE relative_dir || '/%'
    ORDER BY length(relative_dir) DESC
    LIMIT 1
  `)
    .get(projectId, relativePath)
  if (candidates) return candidates
  const relativeDir = relativeTaskDir(relativePath)
  return relativeDir
    ? {
        relative_dir: relativeDir,
        task_key: `${projectId}::${relativeDir}`,
        execution_task_key: null,
      }
    : null
}

function movedTaskFile(db, project, liveFile) {
  const projectPrefix = `${project.id}::`
  const sourceDir = String(liveFile.task_key || '').startsWith(projectPrefix)
    ? String(liveFile.task_key).slice(projectPrefix.length)
    : relativeTaskDir(liveFile.relative_path)
  if (!sourceDir?.startsWith('.trellis/tasks/')) return null
  if (!liveFile.relative_path.startsWith(`${sourceDir}/`)) return null

  const sourceName = path.posix.basename(sourceDir)
  const destinations = db
    .prepare(`
      SELECT relative_dir, task_key
      FROM team_task_index
      WHERE project_id = ? AND archived = 1 AND relative_dir LIKE '.trellis/tasks/archive/%'
      ORDER BY archived_at DESC
    `)
    .all(project.id)
    .filter((destination) => path.posix.basename(destination.relative_dir) === sourceName)
  const suffix = liveFile.relative_path.slice(sourceDir.length + 1)
  for (const destination of destinations) {
    const relativePath = path.posix.join(destination.relative_dir, suffix)
    const target = path.resolve(project.path, ...relativePath.split('/'))
    const relative = path.relative(project.path, target)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue
    try {
      if (!fs.lstatSync(target).isFile()) continue
      return {
        relativePath,
        taskKey: destination.task_key,
        sha256: digest(fs.readFileSync(target)),
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  return null
}

function parseJson(content) {
  try {
    return JSON.parse(content)
  } catch {
    return null
  }
}

export function createLiveSyncService({
  db,
  taskIndex,
  agentEvents,
  now = () => new Date(),
  logger = console,
}) {
  const warnings = new Map()
  const rateBuckets = new Map()
  const liveBoards = new Map()
  const liveDetails = new Map()
  const projectionStates = new Map()
  let closed = false

  function readBinding(agent, projectId, { write = false } = {}) {
    const row = db
      .prepare(`
      SELECT
        b.id, b.agent_id, b.project_id,
        b.sync_status AS binding_sync_status,
        p.team_id AS project_team_id,
        p.sync_status AS project_sync_status,
        p.sync_branch,
        r.name AS project_name, r.path AS project_path,
        t.status AS team_status, u.id AS user_id, u.system_admin,
        tm.user_id AS team_member_id, pm.role, pm.trellis_dev_id
      FROM agent_project_binding b
      JOIN team_project p ON p.repository_id = b.project_id
      JOIN repositories r ON r.id = p.repository_id
      JOIN team t ON t.id = p.team_id
      JOIN agent_device a ON a.id = b.agent_id
      JOIN user_account u ON u.id = a.user_id
      LEFT JOIN team_member tm
        ON tm.team_id = p.team_id AND tm.user_id = u.id
      LEFT JOIN project_member pm
        ON pm.project_id = p.repository_id AND pm.user_id = u.id
      WHERE b.agent_id = ? AND b.project_id = ?
    `)
      .get(agent.id, projectId)
    if (
      !row ||
      row.binding_sync_status !== 'approved' ||
      row.team_status !== 'active' ||
      !LIVE_STATUSES.has(row.project_sync_status)
    ) {
      throw teamError(403, ERROR_CODES.FORBIDDEN, '项目关联未生效')
    }
    if (!row.system_admin && !row.team_member_id) {
      throw teamError(403, ERROR_CODES.FORBIDDEN, 'Agent 账号不属于该项目团队')
    }
    if (!LIVE_STATUSES.has(row.project_sync_status)) {
      throw teamError(409, ERROR_CODES.PROJECT_NOT_READY, '项目尚未启用')
    }
    if (write && (row.role === 'read_only' || (!row.system_admin && !roleCanWrite(row.role)))) {
      throw teamError(403, ERROR_CODES.FORBIDDEN, '只读成员不能上传实时任务修改')
    }
    return row
  }

  function currentRevision(projectId) {
    return Number(
      db
        .prepare(`
      SELECT revision FROM project_live_revision WHERE project_id = ?
    `)
        .get(projectId)?.revision || 0,
    )
  }

  function readTaskState(binding, files, input = {}) {
    const firstTask = files
      .map((file) => taskDirFromIndex(db, binding.project_id, file.path))
      .find(Boolean)
    const requestedTaskKey = String(input.taskKey || '').trim()
    let indexed = firstTask
    if (requestedTaskKey) {
      indexed =
        db
          .prepare(`
        SELECT relative_dir, task_key, execution_task_key
        FROM team_task_index
        WHERE project_id = ? AND task_key = ?
      `)
          .get(binding.project_id, requestedTaskKey) || indexed
    }
    if (!indexed?.relative_dir) {
      return {
        relativeDir: null,
        taskKey: requestedTaskKey || null,
        executionTaskKey: null,
        assigneeDevId: null,
        assigneeUserId: null,
        title: null,
      }
    }
    let taskJson = null
    const incoming = files.find(
      (file) => file.path === `${indexed.relative_dir}/task.json` && file.operation === 'upsert',
    )
    if (incoming) {
      taskJson = parseJson(incoming.content)
    }
    if (!taskJson) {
      const live = db
        .prepare(`
        SELECT content_text, deleted
        FROM project_live_file
        WHERE project_id = ? AND relative_path = ?
      `)
        .get(binding.project_id, `${indexed.relative_dir}/task.json`)
      if (live && !live.deleted) taskJson = parseJson(live.content_text)
    }
    if (!taskJson) {
      try {
        taskJson = JSON.parse(
          fs.readFileSync(
            path.join(binding.project_path, indexed.relative_dir, 'task.json'),
            'utf8',
          ),
        )
      } catch {
        taskJson = null
      }
    }
    const assigneeDevId = String(taskJson?.assignee || '').trim() || null
    const member = assigneeDevId
      ? db
          .prepare(`
          SELECT user_id, trellis_dev_id
          FROM project_member
          WHERE project_id = ? AND trellis_dev_id = ? COLLATE NOCASE
        `)
          .get(binding.project_id, assigneeDevId)
      : null
    const index = db
      .prepare(`
      SELECT execution_task_key, assignee_user_id, assignee_dev_id, title
      FROM team_task_index
      WHERE project_id = ? AND task_key = ?
    `)
      .get(binding.project_id, indexed.task_key)
    return {
      relativeDir: indexed.relative_dir,
      taskKey: indexed.task_key,
      executionTaskKey: indexed.execution_task_key || index?.execution_task_key || null,
      assigneeDevId: assigneeDevId || index?.assignee_dev_id || null,
      assigneeUserId: member?.user_id || index?.assignee_user_id || null,
      title: taskJson?.title || index?.title || null,
    }
  }

  function normalizeFiles(rawFiles) {
    if (!Array.isArray(rawFiles) || !rawFiles.length) {
      throw teamError(400, ERROR_CODES.INVALID_INPUT, '实时批次没有文件')
    }
    if (rawFiles.length > TASK_SNAPSHOT_MAX_FILES) {
      throw teamError(413, ERROR_CODES.BODY_TOO_LARGE, '实时批次文件数超过限制')
    }
    let totalBytes = 0
    const seen = new Set()
    return rawFiles.map((file) => {
      if (!file || typeof file !== 'object') {
        throw teamError(400, ERROR_CODES.INVALID_INPUT, '实时文件项无效')
      }
      const relativePath = normalizeLivePath(file.path)
      if (seen.has(relativePath)) {
        throw teamError(400, ERROR_CODES.INVALID_INPUT, '实时批次不能重复包含同一文件')
      }
      seen.add(relativePath)
      const operation = String(file.operation || 'upsert')
      if (!new Set(['upsert', 'delete']).has(operation)) {
        throw teamError(400, ERROR_CODES.INVALID_INPUT, '实时文件操作无效')
      }
      if (operation === 'upsert') {
        const content = String(file.content ?? '')
        const bytes = Buffer.byteLength(content, 'utf8')
        if (bytes > TASK_SNAPSHOT_MAX_FILE_BYTES) {
          throw teamError(413, ERROR_CODES.BODY_TOO_LARGE, '单个实时文件超过 1 MiB')
        }
        totalBytes += bytes
        if (totalBytes > TASK_SNAPSHOT_MAX_BATCH_BYTES) {
          throw teamError(413, ERROR_CODES.BODY_TOO_LARGE, '实时批次超过 64 MiB')
        }
        let decoded
        try {
          decoded = utf8Decoder.decode(Buffer.from(content, 'utf8'))
        } catch {
          throw teamError(400, ERROR_CODES.INVALID_INPUT, '实时文件不是有效 UTF-8')
        }
        if (decoded !== content) {
          throw teamError(400, ERROR_CODES.INVALID_INPUT, '实时文件不是规范 UTF-8')
        }
        if (!/^[a-f0-9]{64}$/.test(String(file.sha256 || ''))) {
          throw teamError(400, ERROR_CODES.INVALID_INPUT, '实时文件摘要格式无效')
        }
        const sha256 = digest(Buffer.from(content, 'utf8'))
        if (sha256 !== file.sha256) {
          throw teamError(400, ERROR_CODES.INVALID_INPUT, '实时文件摘要不匹配')
        }
        return { path: relativePath, operation, content, sha256 }
      }
      return {
        path: relativePath,
        operation,
        content: null,
        sha256: digest(''),
      }
    })
  }

  function taskKeysForFiles(projectId, files) {
    return [
      ...new Set(
        files.map((file) => taskDirFromIndex(db, projectId, file.path)?.task_key).filter(Boolean),
      ),
    ]
  }

  function affectedLiveTaskKeys(projectId, rows) {
    const affectsWholeProject = rows.some(
      (row) =>
        row.relative_path === '.trellis/.developer' ||
        row.relative_path.startsWith('.trellis/workspace/'),
    )
    if (affectsWholeProject) return null
    const taskKeys = new Set(
      rows
        .map((row) => row.task_key || taskDirFromIndex(db, projectId, row.relative_path)?.task_key)
        .filter(Boolean),
    )
    // 无法映射到具体任务的项目级文件按保守方式刷新全部任务。
    return taskKeys.size ? taskKeys : null
  }

  function assertTaskScopedBatch(projectId, files, requestedTaskKey = null) {
    const taskKeys = taskKeysForFiles(projectId, files)
    const projectLevel = files.some((file) => !taskDirFromIndex(db, projectId, file.path))
    if (taskKeys.length > 1 || (taskKeys.length === 1 && projectLevel)) {
      throw teamError(400, ERROR_CODES.INVALID_INPUT, '实时批次只能包含同一个任务的文件')
    }
    const requested = String(requestedTaskKey || '').trim()
    if (requested && requested !== (taskKeys[0] || null)) {
      throw teamError(400, ERROR_CODES.INVALID_INPUT, '实时批次任务标识不一致')
    }
    return taskKeys
  }

  function validateBatchId(value) {
    const batchId = String(value || '').trim()
    if (!SAFE_BATCH_ID.test(batchId)) {
      throw teamError(400, ERROR_CODES.INVALID_INPUT, 'batchId 格式无效')
    }
    return batchId
  }

  function validateClientSequence(value) {
    if (value == null || value === '') return null
    const sequence = Number(value)
    if (!Number.isSafeInteger(sequence) || sequence < 1) {
      throw teamError(400, ERROR_CODES.INVALID_INPUT, 'clientSequence 必须是正整数')
    }
    return sequence
  }

  function assertProjectFilesSafe(binding, files) {
    for (const file of files) {
      assertNoSymlink(binding.project_path, file.path)
      const target = path.resolve(binding.project_path, ...file.path.split('/'))
      try {
        const stat = fs.lstatSync(target)
        if (stat.isDirectory() || stat.isSymbolicLink()) {
          throw teamError(400, ERROR_CODES.INVALID_INPUT, '实时同步不能覆盖目录或符号链接')
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
    }
  }

  function validateProjectId(value) {
    const projectId = String(value || '').trim()
    if (!SAFE_ID.test(projectId)) {
      throw teamError(400, ERROR_CODES.INVALID_INPUT, '项目 ID 格式无效')
    }
    return projectId
  }

  function checkRate(agentId, projectId) {
    const key = `${agentId}:${projectId}`
    const current = now().getTime()
    const bucket = (rateBuckets.get(key) || []).filter((time) => current - time < RATE_WINDOW_MS)
    if (bucket.length >= RATE_LIMIT) {
      throw teamError(429, ERROR_CODES.RATE_LIMITED, '实时上报过于频繁，请稍后重试', {
        recoverable: true,
      })
    }
    bucket.push(current)
    rateBuckets.set(key, bucket)
  }

  function confirmationFor(binding, files, input = {}, { createWarning = true } = {}) {
    const timestamp = now().toISOString()
    for (const [id, warning] of warnings) {
      if (warning.expiresAt <= timestamp) warnings.delete(id)
    }
    const task = readTaskState(binding, files, input)
    const sameUser = task.assigneeUserId && task.assigneeUserId === binding.user_id
    const sameDeveloper =
      task.assigneeDevId &&
      binding.trellis_dev_id &&
      task.assigneeDevId.toLowerCase() === binding.trellis_dev_id.toLowerCase()
    if ((task.assigneeUserId || task.assigneeDevId) && !sameUser && !sameDeveloper) {
      const warningId = createWarning ? crypto.randomUUID() : null
      const expiresAt = new Date(now().getTime() + WARNING_TTL_MS).toISOString()
      const revision = currentRevision(binding.project_id)
      if (warningId) {
        warnings.set(warningId, {
          warningId,
          agentId: binding.agent_id,
          projectId: binding.project_id,
          taskKey: task.taskKey,
          assigneeUserId: task.assigneeUserId,
          assigneeDevId: task.assigneeDevId,
          revision,
          expiresAt,
        })
      }
      const assignee = task.assigneeUserId
        ? db
            .prepare(`
            SELECT username, display_name
            FROM user_account
            WHERE id = ?
          `)
            .get(task.assigneeUserId)
        : null
      return {
        requiresConfirmation: true,
        warningId,
        assignee: {
          userId: task.assigneeUserId || null,
          username: assignee?.username || null,
          displayName: assignee?.display_name || task.assigneeDevId || null,
        },
        task: {
          taskKey: task.taskKey,
          title: task.title,
          assigneeDevId: task.assigneeDevId || null,
        },
        revision,
        expiresAt,
      }
    }
    return { requiresConfirmation: false, task }
  }

  function takeOverFiles(binding, files, task) {
    if (!binding.trellis_dev_id) {
      throw teamError(403, ERROR_CODES.FORBIDDEN, '当前账号尚未映射 Trellis developer ID')
    }
    const taskJsonPath = `${task.relativeDir}/task.json`
    let current = null
    const incoming = files.find((file) => file.path === taskJsonPath && file.operation === 'upsert')
    if (incoming) {
      current = parseJson(incoming.content)
    }
    if (!current) {
      const live = db
        .prepare(`
        SELECT content_text, deleted
        FROM project_live_file
        WHERE project_id = ? AND relative_path = ?
      `)
        .get(binding.project_id, taskJsonPath)
      if (live && !live.deleted) current = parseJson(live.content_text)
    }
    if (!current) {
      try {
        current = JSON.parse(fs.readFileSync(path.join(binding.project_path, taskJsonPath), 'utf8'))
      } catch {
        current = null
      }
    }
    if (!current) {
      throw teamError(409, ERROR_CODES.CONFLICT, '无法读取任务 task.json，不能接管任务')
    }
    const content = `${JSON.stringify({ ...current, assignee: binding.trellis_dev_id }, null, 2)}\n`
    const next = files.filter((file) => file.path !== taskJsonPath)
    next.push({
      path: taskJsonPath,
      operation: 'upsert',
      content,
      sha256: digest(Buffer.from(content, 'utf8')),
    })
    return next
  }

  function validateDecision(binding, confirmation, decision) {
    if (!confirmation.requiresConfirmation) return null
    const warningId = String(decision?.warningId || '').trim()
    const action = String(decision?.action || '').trim()
    const warning = warnings.get(warningId)
    if (
      !warning ||
      warning.expiresAt <= now().toISOString() ||
      warning.agentId !== binding.agent_id ||
      warning.projectId !== binding.project_id ||
      warning.revision !== currentRevision(binding.project_id) ||
      warning.assigneeUserId !== confirmation.assignee.userId ||
      warning.assigneeDevId !== confirmation.task.assigneeDevId ||
      !new Set(['continue', 'takeover']).has(action)
    ) {
      throw teamError(
        409,
        'ASSIGNEE_CONFIRMATION_REQUIRED',
        '任务责任人已变化或确认已过期，请重新确认',
        { recoverable: true, details: confirmation },
      )
    }
    return { ...warning, action }
  }

  function preflight(agent, input = {}) {
    const projectId = validateProjectId(input.projectId)
    const binding = readBinding(agent, projectId, { write: true })
    const files = normalizeFiles(input.files)
    assertProjectFilesSafe(binding, files)
    assertTaskScopedBatch(projectId, files, input.taskKey)
    return confirmationFor(binding, files, input)
  }

  function replayBatch(agent, projectId, batchId) {
    return (
      db
        .prepare(`
      SELECT revision, request_sha256 FROM project_live_batch
      WHERE agent_id = ? AND project_id = ? AND batch_id = ?
    `)
        .get(agent.id, projectId, batchId) || null
    )
  }

  function applyChanges(agent, input = {}) {
    const projectId = validateProjectId(input.projectId)
    const batchId = validateBatchId(input.batchId)
    const binding = readBinding(agent, projectId, { write: true })
    let files = normalizeFiles(input.files)
    assertProjectFilesSafe(binding, files)
    const requestedTaskKeys = assertTaskScopedBatch(projectId, files, input.taskKey)
    const clientSequence = validateClientSequence(input.clientSequence)
    const clientHash = requestHash({ projectId, clientSequence, files })
    const existing = replayBatch(agent, projectId, batchId)
    if (existing) {
      if (clientHash !== existing.request_sha256) {
        throw teamError(409, ERROR_CODES.IDEMPOTENCY_CONFLICT, '同一 batchId 不能提交不同内容')
      }
      if (!liveBoards.has(projectId)) {
        scheduleProjectProjection(projectId, {
          revision: Number(existing.revision),
          taskKeys: requestedTaskKeys,
          sourceAgentId: agent.id,
        })
      }
      return {
        revision: Number(existing.revision),
        batchId,
        taskKeys: requestedTaskKeys,
        replayed: true,
      }
    }
    checkRate(agent.id, projectId)
    const confirmation = confirmationFor(binding, files, input, {
      createWarning: false,
    })
    const decision = validateDecision(binding, confirmation, input.assigneeDecision)
    if (confirmation.requiresConfirmation && !decision) {
      throw teamError(409, 'ASSIGNEE_CONFIRMATION_REQUIRED', '修改他人负责的任务前需要确认', {
        recoverable: true,
        details: confirmation,
      })
    }
    if (decision?.action === 'takeover') {
      files = takeOverFiles(binding, files, confirmation.task)
    }
    const timestamp = now().toISOString()
    let revision
    let taskKeys = []
    const appliedFiles = []
    const skippedPaths = []
    withTransaction(db, () => {
      const existingFile = db.prepare(`
        SELECT source_agent_id, source_client_sequence
        FROM project_live_file
        WHERE project_id = ? AND relative_path = ?
      `)
      for (const file of files) {
        const existing = existingFile.get(projectId, file.path)
        if (
          clientSequence != null &&
          existing?.source_agent_id === agent.id &&
          existing.source_client_sequence != null &&
          Number(existing.source_client_sequence) >= clientSequence
        ) {
          skippedPaths.push(file.path)
        } else {
          appliedFiles.push(file)
        }
      }
      if (!appliedFiles.length) {
        revision = currentRevision(projectId)
        db.prepare(`
          INSERT INTO project_live_batch(
            batch_id, project_id, agent_id, user_id, revision,
            client_sequence, request_sha256, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          batchId,
          projectId,
          agent.id,
          binding.user_id,
          revision,
          clientSequence,
          clientHash,
          timestamp,
        )
        appendAuditEvent(db, {
          actorUserId: binding.user_id,
          actorAgentId: agent.id,
          projectId,
          action: 'project_live_changes',
          targetType: 'project_live_batch',
          targetId: batchId,
          detail: {
            revision,
            fileCount: 0,
            paths: [],
            skippedPaths,
            taskKeys: [],
          },
          occurredAt: timestamp,
        })
        return
      }
      db.prepare(`
        INSERT INTO project_live_revision(project_id, revision, updated_at)
        VALUES (?, 1, ?)
        ON CONFLICT(project_id) DO UPDATE SET
          revision = project_live_revision.revision + 1,
          updated_at = excluded.updated_at
      `).run(projectId, timestamp)
      revision = currentRevision(projectId)
      db.prepare(`
        INSERT INTO project_live_batch(
          batch_id, project_id, agent_id, user_id, revision,
          client_sequence, request_sha256, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        batchId,
        projectId,
        agent.id,
        binding.user_id,
        revision,
        clientSequence,
        clientHash,
        timestamp,
      )
      const upsert = db.prepare(`
        INSERT INTO project_live_file(
          project_id, relative_path, revision, sha256, content_text,
          deleted, task_key, source_agent_id, source_user_id,
          source_client_sequence, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, relative_path) DO UPDATE SET
          revision = excluded.revision,
          sha256 = excluded.sha256,
          content_text = excluded.content_text,
          deleted = excluded.deleted,
          task_key = excluded.task_key,
          source_agent_id = excluded.source_agent_id,
          source_user_id = excluded.source_user_id,
          source_client_sequence = excluded.source_client_sequence,
          updated_at = excluded.updated_at
      `)
      for (const file of appliedFiles) {
        const task = taskDirFromIndex(db, projectId, file.path)
        upsert.run(
          projectId,
          file.path,
          revision,
          file.sha256,
          file.operation === 'delete' ? null : file.content,
          file.operation === 'delete' ? 1 : 0,
          task?.task_key || null,
          agent.id,
          binding.user_id,
          clientSequence,
          timestamp,
        )
      }
      taskKeys = taskKeysForFiles(projectId, appliedFiles)
      appendAuditEvent(db, {
        actorUserId: binding.user_id,
        actorAgentId: agent.id,
        projectId,
        action: 'project_live_changes',
        targetType: 'project_live_batch',
        targetId: batchId,
        detail: {
          revision,
          fileCount: appliedFiles.length,
          paths: appliedFiles.map((file) => file.path),
          skippedPaths,
          decision: decision?.action || null,
          taskKeys,
        },
        occurredAt: timestamp,
      })
    })
    if (!appliedFiles.length) {
      return {
        revision,
        batchId,
        taskKeys: [],
        stale: true,
        skippedPaths,
      }
    }
    taskKeys = taskKeysForFiles(projectId, appliedFiles)
    scheduleProjectProjection(projectId, {
      revision,
      taskKeys,
      sourceAgentId: agent.id,
    })
    db.prepare(`
      DELETE FROM project_live_batch
      WHERE created_at < ?
    `).run(new Date(now().getTime() - 30 * 24 * 60 * 60 * 1000).toISOString())
    if (decision) {
      agentEvents?.publishLiveOverridden({
        projectId,
        taskKey: confirmation.task.taskKey,
        revision,
        assigneeUserId: confirmation.assignee.userId || null,
        actorAgentId: agent.id,
        action: decision.action,
      })
      warnings.delete(decision.warningId)
    }
    return { revision, batchId, taskKeys }
  }

  function listFiles(agent, input = {}) {
    const projectId = validateProjectId(input.projectId)
    readBinding(agent, projectId)
    const revision = currentRevision(projectId)
    let after = Number(input.afterRevision || 0)
    if (!Number.isSafeInteger(after) || after < 0 || after > revision) after = 0
    const files = db
      .prepare(`
      SELECT relative_path, revision, sha256, content_text, deleted,
             task_key, source_agent_id, updated_at
      FROM project_live_file
      WHERE project_id = ? AND revision > ?
      ORDER BY relative_path
    `)
      .all(projectId, after)
      .map((row) => ({
        path: row.relative_path,
        revision: Number(row.revision),
        sha256: row.sha256,
        content: row.deleted ? null : row.content_text,
        operation: row.deleted ? 'delete' : 'upsert',
        taskKey: row.task_key || null,
        sourceAgentId: row.source_agent_id || null,
        updatedAt: row.updated_at,
      }))
    return { projectId, revision, files }
  }

  function writeCursor(agent, input = {}) {
    const projectId = validateProjectId(input.projectId)
    readBinding(agent, projectId)
    const revision = Number(input.revision)
    if (!Number.isSafeInteger(revision) || revision < 0) {
      throw teamError(400, ERROR_CODES.INVALID_INPUT, '实时游标无效')
    }
    if (revision > currentRevision(projectId)) {
      throw teamError(409, ERROR_CODES.VERSION_CONFLICT, '实时游标超过服务端当前版本')
    }
    const timestamp = now().toISOString()
    db.prepare(`
      INSERT INTO agent_live_cursor(agent_id, project_id, revision, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(agent_id, project_id) DO UPDATE SET
        revision = MAX(agent_live_cursor.revision, excluded.revision),
        updated_at = excluded.updated_at
    `).run(agent.id, projectId, revision, timestamp)
    return { projectId, revision, updatedAt: timestamp }
  }

  function notifyAssigneeOverride({
    projectId,
    taskKey,
    assigneeUserId,
    action,
    notificationId = null,
  }) {
    if (!assigneeUserId) return []
    return (
      agentEvents?.publishLiveOverridden({
        projectId,
        taskKey,
        revision: currentRevision(projectId),
        assigneeUserId,
        actorAgentId: null,
        action,
        dedupeKey: notificationId,
      }) || []
    )
  }

  function takeoverTask({ projectId, taskKey, actorUserId, actorDevId }) {
    const indexed = db
      .prepare(`
      SELECT relative_dir, execution_task_key, assignee_user_id
      FROM team_task_index
      WHERE project_id = ? AND task_key = ?
    `)
      .get(projectId, taskKey)
    if (!indexed) {
      throw teamError(404, ERROR_CODES.NOT_FOUND, '任务不存在')
    }
    if (!actorDevId) {
      throw teamError(403, ERROR_CODES.FORBIDDEN, '当前账号尚未映射 Trellis developer ID')
    }
    const project = readGitProject(db, projectId)
    if (!project) throw teamError(404, ERROR_CODES.NOT_FOUND, '项目不存在')
    const relativePath = `${indexed.relative_dir}/task.json`
    const live = db
      .prepare(`
      SELECT content_text, deleted
      FROM project_live_file
      WHERE project_id = ? AND relative_path = ?
    `)
      .get(projectId, relativePath)
    let taskJson
    try {
      taskJson =
        live && !live.deleted
          ? JSON.parse(live.content_text)
          : JSON.parse(fs.readFileSync(path.join(project.path, relativePath), 'utf8'))
    } catch {
      throw teamError(409, ERROR_CODES.CONFLICT, '无法读取任务 task.json')
    }
    const content = `${JSON.stringify(
      {
        ...taskJson,
        assignee: actorDevId,
      },
      null,
      2,
    )}\n`
    const sha256 = digest(Buffer.from(content, 'utf8'))
    const timestamp = now().toISOString()
    let revision
    withTransaction(db, () => {
      db.prepare(`
        INSERT INTO project_live_revision(project_id, revision, updated_at)
        VALUES (?, 1, ?)
        ON CONFLICT(project_id) DO UPDATE SET
          revision = project_live_revision.revision + 1,
          updated_at = excluded.updated_at
      `).run(projectId, timestamp)
      revision = currentRevision(projectId)
      db.prepare(`
        INSERT INTO project_live_file(
          project_id, relative_path, revision, sha256, content_text,
          deleted, task_key, source_agent_id, source_user_id, updated_at
        ) VALUES (?, ?, ?, ?, ?, 0, ?, NULL, ?, ?)
        ON CONFLICT(project_id, relative_path) DO UPDATE SET
          revision = excluded.revision,
          sha256 = excluded.sha256,
          content_text = excluded.content_text,
          deleted = 0,
          task_key = excluded.task_key,
          source_agent_id = NULL,
          source_user_id = excluded.source_user_id,
          updated_at = excluded.updated_at
      `).run(projectId, relativePath, revision, sha256, content, taskKey, actorUserId, timestamp)
      appendAuditEvent(db, {
        actorUserId,
        projectId,
        action: 'task_live_takeover',
        targetType: 'task',
        targetId: indexed.execution_task_key,
        detail: {
          revision,
          taskKey,
          assigneeDevId: actorDevId,
        },
        occurredAt: timestamp,
      })
    })
    scheduleProjectProjection(projectId, {
      revision,
      taskKeys: [taskKey],
      sourceAgentId: null,
    })
    agentEvents?.publishLiveOverridden({
      projectId,
      taskKey,
      revision,
      assigneeUserId: indexed.assignee_user_id,
      actorAgentId: null,
      action: 'takeover',
    })
    return { revision, taskKey }
  }

  function liveRevisionForActor(actor, teamId = 'all') {
    const ids = readableProjectIds(actor, { db })
    if (!ids.length) {
      return { revision: 0, revisionKey: '', projects: [], notifications: [] }
    }
    const placeholders = ids.map(() => '?').join(', ')
    const scopedTeam = String(teamId || 'all').trim()
    const rows = db
      .prepare(`
      SELECT r.project_id, r.revision
      FROM project_live_revision r
      JOIN team_project p ON p.repository_id = r.project_id
      WHERE r.project_id IN (${placeholders})
        AND (? = 'all' OR p.team_id = ?)
      ORDER BY r.project_id
    `)
      .all(...ids, scopedTeam || 'all', scopedTeam || 'all')
    const projects = rows.map((row) => ({
      projectId: row.project_id,
      revision: Number(row.revision),
    }))
    const notifications = db
      .prepare(`
      SELECT e.id, e.project_id, e.task_id, e.payload_json, e.created_at
      FROM agent_event e
      JOIN team_project p ON p.repository_id = e.project_id
      WHERE e.project_id IN (${placeholders})
        AND e.type = 'task.live.overridden'
        AND e.target_user_id = ?
        AND e.target_agent_id IS NULL
        AND e.expires_at > ?
        AND (? = 'all' OR p.team_id = ?)
      ORDER BY e.id DESC
      LIMIT 20
    `)
      .all(...ids, actor.userId, now().toISOString(), scopedTeam || 'all', scopedTeam || 'all')
      .map((row) => {
        const payload = parseJson(row.payload_json) || {}
        return {
          id: Number(row.id),
          type: 'task.live.overridden',
          projectId: row.project_id,
          taskKey: row.task_id || payload.taskKey || null,
          taskTitle: payload.taskTitle || null,
          revision: Number(payload.revision || 0),
          action: payload.action || null,
          actorAgentId: payload.actorAgentId || null,
          createdAt: row.created_at,
        }
      })
    return {
      revision: projects.reduce((max, item) => Math.max(max, item.revision), 0),
      revisionKey: projects.map((item) => `${item.projectId}:${item.revision}`).join('|'),
      projects,
      notifications,
    }
  }

  function projectionState(projectId) {
    if (!projectionStates.has(projectId)) {
      projectionStates.set(projectId, {
        running: false,
        scheduled: false,
        requestedRevision: 0,
        retryAttempt: 0,
        retryTimer: null,
        taskKeys: new Set(),
        sourceAgentIds: new Set(),
        forceBroadcast: false,
      })
    }
    return projectionStates.get(projectId)
  }

  function readProjectionRows(projectId) {
    return db
      .prepare(`
      SELECT relative_path, content_text, deleted, task_key
      FROM project_live_file
      WHERE project_id = ?
      ORDER BY relative_path
    `)
      .all(projectId)
  }

  function taskKeysForRows(projectId, rows) {
    return [
      ...new Set(
        rows
          .map(
            (row) => row.task_key || taskDirFromIndex(db, projectId, row.relative_path)?.task_key,
          )
          .filter(Boolean),
      ),
    ]
  }

  function applyProjectProjection(projectId, rows, revision, scan) {
    const affectedTaskKeys = affectedLiveTaskKeys(projectId, rows)
    const isAffected = (taskKey) => affectedTaskKeys === null || affectedTaskKeys.has(taskKey)
    const details = new Map(
      scan.tasks.map((task) => [
        task.taskKey,
        {
          ...task,
          liveRevision: isAffected(task.taskKey) ? revision : 0,
        },
      ]),
    )
    const board = taskIndex.buildBoard(scan)
    board.tasks = (board.tasks || []).map((task) => ({
      ...task,
      liveRevision: isAffected(task.taskKey) ? revision : 0,
    }))
    taskIndex.replaceProjectIndex({
      projectId,
      board,
      boardVersion: `live:${revision}`,
      persistCache: false,
      skipLiveHook: true,
      publishEvents: false,
      liveRevision: revision,
      affectedTaskKeys,
    })
    liveDetails.set(projectId, details)
    liveBoards.set(projectId, board)
  }

  function resetProjectionNotification(state) {
    state.taskKeys.clear()
    state.sourceAgentIds.clear()
    state.forceBroadcast = false
  }

  async function runProjectProjection(projectId) {
    const state = projectionStates.get(projectId)
    if (!state || state.running || closed) return
    state.running = true
    try {
      while (!closed) {
        const revision = Math.max(state.requestedRevision, currentRevision(projectId))
        state.requestedRevision = revision
        const rows = readProjectionRows(projectId)
        if (!rows.length) {
          liveBoards.delete(projectId)
          liveDetails.delete(projectId)
          state.retryAttempt = 0
          resetProjectionNotification(state)
          return
        }
        const project = readGitProject(db, projectId)
        if (!project || !fs.existsSync(path.join(project.path, '.trellis'))) {
          throw new Error('项目工作副本不可用')
        }
        const result = await taskIndex.materializeLiveProject(project, rows, revision)
        if (closed) return
        const latestRevision = Math.max(state.requestedRevision, currentRevision(projectId))
        if (latestRevision !== revision) {
          state.requestedRevision = latestRevision
          continue
        }
        if (Number(result?.revision) !== revision || !result?.scan) {
          throw new Error('实时投影返回了无效结果')
        }
        applyProjectProjection(projectId, rows, revision, result.scan)
        const taskKeys = state.taskKeys.size
          ? [...state.taskKeys]
          : taskKeysForRows(projectId, rows)
        const sourceAgentId =
          state.forceBroadcast || state.sourceAgentIds.size !== 1
            ? null
            : [...state.sourceAgentIds][0]
        state.retryAttempt = 0
        resetProjectionNotification(state)
        agentEvents?.publishLiveChanged({
          projectId,
          revision,
          taskKeys,
          sourceAgentId,
        })
        return
      }
    } catch (error) {
      if (closed) return
      const attempt = (state.retryAttempt += 1)
      const delay = Math.min(
        PROJECTION_RETRY_MAX_MS,
        PROJECTION_RETRY_BASE_MS * 2 ** Math.min(attempt - 1, 5),
      )
      logger.warn('实时投影失败，将按退避重试', {
        projectId,
        revision: state.requestedRevision,
        attempt,
        retryInMs: delay,
        error: error instanceof Error ? error.message : String(error),
      })
      state.retryTimer = setTimeout(() => {
        state.retryTimer = null
        void runProjectProjection(projectId)
      }, delay)
      state.retryTimer.unref?.()
    } finally {
      state.running = false
    }
  }

  function scheduleProjectProjection(
    projectId,
    { revision = currentRevision(projectId), taskKeys = [], sourceAgentId = null } = {},
  ) {
    if (closed) return false
    const state = projectionState(projectId)
    state.requestedRevision = Math.max(state.requestedRevision, Number(revision) || 0)
    for (const taskKey of taskKeys || []) {
      if (taskKey) state.taskKeys.add(String(taskKey))
    }
    if (sourceAgentId === null) state.forceBroadcast = true
    else if (sourceAgentId) state.sourceAgentIds.add(String(sourceAgentId))
    if (state.retryTimer) {
      clearTimeout(state.retryTimer)
      state.retryTimer = null
    }
    if (!state.running && !state.scheduled) {
      state.scheduled = true
      queueMicrotask(() => {
        state.scheduled = false
        void runProjectProjection(projectId)
      })
    }
    return true
  }

  function reapplyProject(projectId) {
    return scheduleProjectProjection(projectId)
  }

  function convergeGit(projectId) {
    const project = readGitProject(db, projectId)
    if (!project) return false
    const rows = db
      .prepare(`
      SELECT relative_path, sha256, deleted, task_key
      FROM project_live_file
      WHERE project_id = ?
    `)
      .all(projectId)
    let changed = false
    for (const row of rows) {
      const target = path.resolve(project.path, ...row.relative_path.split('/'))
      const gitDeleted = !fs.existsSync(target)
      const gitSha = gitDeleted ? null : digest(fs.readFileSync(target))
      const converged =
        (row.deleted && gitDeleted) || (!row.deleted && !gitDeleted && gitSha === row.sha256)
      if (converged) {
        db.prepare(`
          DELETE FROM project_live_file
          WHERE project_id = ? AND relative_path = ?
        `).run(projectId, row.relative_path)
        changed = true
        continue
      }
      if (!gitDeleted) continue

      const moved = movedTaskFile(db, project, row)
      if (!moved) continue
      if (row.deleted || moved.sha256 === row.sha256) {
        db.prepare(`
          DELETE FROM project_live_file
          WHERE project_id = ? AND relative_path = ?
        `).run(projectId, row.relative_path)
        changed = true
        continue
      }
      const destinationLive = db
        .prepare(`
          SELECT relative_path
          FROM project_live_file
          WHERE project_id = ? AND relative_path = ?
        `)
        .get(projectId, moved.relativePath)
      if (destinationLive) {
        db.prepare(`
          DELETE FROM project_live_file
          WHERE project_id = ? AND relative_path = ?
        `).run(projectId, row.relative_path)
        changed = true
        continue
      }
      db.prepare(`
        UPDATE project_live_file
        SET relative_path = ?, task_key = ?
        WHERE project_id = ? AND relative_path = ?
      `).run(moved.relativePath, moved.taskKey, projectId, row.relative_path)
      changed = true
    }
    if (changed) taskIndex.incrementQueryRevision()
    return changed
  }

  function onProjectIndexed(projectId) {
    const converged = convergeGit(projectId)
    const remaining = Number(
      db
        .prepare(`
      SELECT COUNT(*) AS count FROM project_live_file WHERE project_id = ?
    `)
        .get(projectId).count,
    )
    if (remaining > 0) {
      const timestamp = now().toISOString()
      db.prepare(`
        INSERT INTO project_live_revision(project_id, revision, updated_at)
        VALUES (?, 1, ?)
        ON CONFLICT(project_id) DO UPDATE SET
          revision = project_live_revision.revision + 1,
          updated_at = excluded.updated_at
      `).run(projectId, timestamp)
    } else if (converged) {
      const timestamp = now().toISOString()
      db.prepare(`
        INSERT INTO project_live_revision(project_id, revision, updated_at)
        VALUES (?, 1, ?)
        ON CONFLICT(project_id) DO UPDATE SET
          revision = project_live_revision.revision + 1,
          updated_at = excluded.updated_at
      `).run(projectId, timestamp)
      liveBoards.delete(projectId)
      liveDetails.delete(projectId)
    }
    if (remaining > 0 || converged) {
      const taskKeys = db
        .prepare(`
        SELECT DISTINCT task_key
        FROM project_live_file
        WHERE project_id = ? AND task_key IS NOT NULL
      `)
        .all(projectId)
        .map((row) => row.task_key)
      if (remaining > 0) {
        scheduleProjectProjection(projectId, {
          revision: currentRevision(projectId),
          taskKeys,
          sourceAgentId: null,
        })
      } else {
        agentEvents?.publishLiveChanged({
          projectId,
          revision: currentRevision(projectId),
          taskKeys,
          sourceAgentId: null,
        })
      }
      return remaining > 0
    }
    return false
  }

  taskIndex.setProjectIndexedHook(onProjectIndexed)

  return {
    preflight,
    applyChanges,
    listFiles,
    writeCursor,
    notifyAssigneeOverride,
    takeoverTask,
    liveRevisionForActor,
    reapplyProject,
    scheduleProjectProjection,
    convergeGit,
    close() {
      closed = true
      for (const state of projectionStates.values()) {
        if (state.retryTimer) clearTimeout(state.retryTimer)
      }
      projectionStates.clear()
    },
    board(projectId) {
      return liveBoards.get(projectId) || null
    },
    ensureProject(projectId) {
      if (liveBoards.has(projectId)) return liveBoards.get(projectId)
      const hasRows = db
        .prepare(`
        SELECT 1 FROM project_live_file WHERE project_id = ? LIMIT 1
      `)
        .get(projectId)
      if (hasRows) reapplyProject(projectId)
      return liveBoards.get(projectId) || null
    },
    findTask(projectId, taskKey, executionTaskKey = null) {
      const tasks = liveBoards.get(projectId)?.tasks || []
      const boardTask =
        tasks.find(
          (task) =>
            task.taskKey === taskKey ||
            (executionTaskKey && task.executionTaskKey === executionTaskKey),
        ) || null
      const detail = liveDetails.get(projectId)?.get(taskKey) || null
      if (!boardTask) return detail
      return detail
        ? {
            ...detail,
            ...boardTask,
            artifacts: detail.artifacts,
          }
        : boardTask
    },
  }
}
