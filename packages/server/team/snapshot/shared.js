import crypto from 'node:crypto'
import {
  ARCHIVE_SYNC_SERVER_MANAGED,
  groupTaskSnapshotFiles,
  isArchiveTaskDirectory,
  TASK_SNAPSHOT_LIMIT_ERROR_CODE,
} from '@trellis-board/shared/task-snapshot.js'
import { validateGitBranchName } from '@trellis-board/shared/remote-identity.js'
import { ERROR_CODES, teamError } from '../errors.js'

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

export function requireSnapshotGroups(files, options) {
  try {
    return groupTaskSnapshotFiles(files, options)
  } catch (error) {
    if (error?.code === TASK_SNAPSHOT_LIMIT_ERROR_CODE) {
      throw teamError(413, ERROR_CODES.BODY_TOO_LARGE, error.message)
    }
    throw error
  }
}

export function rejectArchiveGroups(groups) {
  if ((groups || []).some((group) => group.archived)) {
    throw teamError(
      409,
      ARCHIVE_SYNC_SERVER_MANAGED,
      '归档任务由服务端 Git 索引管理，Agent 批次已整批拒绝',
    )
  }
  return groups
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

export function hashJson(value) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(stableValue(value)))
    .digest('hex')
}

export function parseJson(value, fallback = null) {
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

export function requestId(value, label) {
  const text = String(value || '').trim()
  if (!SAFE_ID.test(text)) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, `${label}格式无效`)
  }
  return text
}

export function observedBranchName(input, space, binding) {
  if (input.observedBranchName == null) return null
  let observed
  try {
    observed = validateGitBranchName(input.observedBranchName)
  } catch {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, 'observedBranchName 格式无效')
  }
  if (observed !== space.branch_name || observed !== binding.branch_name) {
    throw teamError(
      400,
      'BRANCH_TASK_SPACE_MISMATCH',
      `上报分支 ${observed} 与任务空间分支 ${space.branch_name} 不一致`,
    )
  }
  return observed
}

export function sequence(value) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, 'clientSequence 必须是正整数')
  }
  return parsed
}

export function taskIdFromJson(content) {
  const value = parseJson(content, null)
  return typeof value?.id === 'string' && value.id.trim() ? value.id.trim() : null
}

export function taskBranchFromJson(content) {
  const value = parseJson(content, null)
  return typeof value?.branch === 'string' && value.branch.trim() ? value.branch.trim() : null
}

export function taskTitleFromJson(content) {
  const value = parseJson(content, null)
  return typeof value?.title === 'string' && value.title.trim() ? value.title.trim() : null
}

export function normalizeMergeEvidence(value) {
  if (value == null) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, 'mergeEvidence 格式无效')
  }
  if (value.version !== 1 || value.type !== 'tracked-in-head') {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, 'mergeEvidence 类型或版本无效')
  }
  const taskDir = String(value.taskDir || '').trim()
  if (!taskDir.startsWith('.trellis/tasks/')) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, 'mergeEvidence 任务目录无效')
  }
  if (isArchiveTaskDirectory(taskDir) || taskDir.startsWith('.trellis/tasks/archive/')) {
    throw teamError(
      409,
      ARCHIVE_SYNC_SERVER_MANAGED,
      '归档任务由服务端 Git 索引管理，不能提交合入证据',
    )
  }
  const trackedPath = String(value.trackedPath || '').trim()
  if (trackedPath !== `${taskDir}/task.json`) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, 'mergeEvidence 受控路径无效')
  }
  let sourceBranch
  let baselineBranch
  try {
    sourceBranch = validateGitBranchName(value.sourceBranch)
    baselineBranch = validateGitBranchName(value.baselineBranch)
  } catch {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, 'mergeEvidence 分支格式无效')
  }
  const headCommit = String(value.headCommit || '').trim()
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(headCommit)) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, 'mergeEvidence HEAD 提交格式无效')
  }
  return {
    version: 1,
    type: 'tracked-in-head',
    taskId: requestId(value.taskId, 'mergeEvidence 任务 ID'),
    taskDir,
    trackedPath,
    sourceBranch,
    baselineBranch,
    headCommit,
  }
}

export function createBindingContext({ statements, taskSpaces }) {
  return function bindingContext(agent, taskSpaceId) {
    const space = taskSpaces.readTaskSpace(taskSpaceId, taskSpaces.actorContext(agent.userId))
    if (!space || space.project_status !== 'active' || space.status === 'disabled') {
      throw teamError(404, ERROR_CODES.NOT_FOUND, '任务空间不存在或已停用')
    }
    const binding = statements.agentBinding.get(agent.id, taskSpaceId)
    if (!binding) {
      throw teamError(403, ERROR_CODES.FORBIDDEN, 'Agent 尚未绑定该任务空间')
    }
    return { space, binding }
  }
}

export function readTaskSpaceRevision(statements, taskSpaceId) {
  return Number(statements.taskSpaceRevision.get(taskSpaceId)?.revision || 0)
}

export function publicFile(row, includeContent = true) {
  return {
    path: row.relative_path,
    revision: Number(row.revision),
    sha256: row.sha256,
    deleted: Boolean(row.deleted),
    taskId: row.task_id || null,
    taskDir: row.task_dir,
    sourceClientSequence: row.source_client_sequence || null,
    changedBy: {
      displayName: row.source_display_name || row.source_username || null,
      deviceName: row.source_device_name || null,
      occurredAt: row.updated_at,
    },
    ...(includeContent && !row.deleted ? { content: row.content_text || '' } : {}),
  }
}

export function sourceIdentity(statements, row) {
  if (!row) return null
  const user = row.source_user_id ? statements.userIdentity.get(row.source_user_id) : null
  const agent = row.source_agent_id ? statements.agentDevice.get(row.source_agent_id) : null
  return {
    displayName: user?.display_name || user?.username || null,
    deviceName: agent?.device_name || null,
    occurredAt: row.updated_at,
  }
}

export function currentPathRows(statements, taskSpaceId, paths) {
  if (!paths.length) return new Map()
  return new Map(statements.filesInPaths(taskSpaceId, paths).map((row) => [row.relative_path, row]))
}

export function affectedDirectoryRows(statements, taskSpaceId, taskDirs) {
  const rows = []
  for (const taskDir of taskDirs) {
    rows.push(...statements.directoryRows(taskSpaceId, taskDir))
  }
  return rows
}

// 预编译语句只在这里创建一份；IN 列表长度随输入变化的三条查询保留为构建函数。
export function createStatements(db) {
  function filesInPaths(taskSpaceId, paths) {
    return db
      .prepare(`
        SELECT *
        FROM sync_task_space_file
        WHERE task_space_id = ?
          AND relative_path IN (${paths.map(() => '?').join(', ')})
      `)
      .all(taskSpaceId, ...paths)
  }

  function directoryRows(taskSpaceId, taskDir) {
    return db
      .prepare(`
        SELECT *
        FROM sync_task_space_file
        WHERE task_space_id = ? AND task_dir = ? AND deleted = 0
      `)
      .all(taskSpaceId, taskDir)
  }

  function activeFilesInTaskDirs(taskSpaceId, taskDirs) {
    return db
      .prepare(`
      SELECT relative_path, sha256, task_id
      FROM sync_task_space_file
      WHERE task_space_id = ? AND deleted = 0
        AND task_dir IN (${taskDirs.map(() => '?').join(', ')})
      ORDER BY relative_path
    `)
      .all(taskSpaceId, ...taskDirs)
  }

  function projectFilesByTaskIds(projectId, taskIds) {
    return db
      .prepare(`
        SELECT f.task_space_id, f.task_id, f.task_dir, f.relative_path, f.content_text
        FROM sync_task_space_file f
        JOIN sync_task_space s ON s.id = f.task_space_id
        WHERE s.project_id = ? AND s.status != 'disabled' AND f.deleted = 0
          AND f.task_id IN (${taskIds.map(() => '?').join(', ')})
        ORDER BY f.task_space_id, f.task_dir
      `)
      .all(projectId, ...taskIds)
  }

  return {
    archivedTaskDirs: db.prepare(
      'SELECT DISTINCT task_dir FROM sync_archive_file WHERE task_space_id = ?',
    ),
    taskSpace: db.prepare(
      'SELECT id, revision, status, retired_at FROM sync_task_space WHERE id = ?',
    ),
    taskSpaceRevision: db.prepare('SELECT revision FROM sync_task_space WHERE id = ?'),
    archiveRevision: db.prepare('SELECT archive_revision FROM sync_task_space WHERE id = ?'),
    tombstoneFile: db.prepare(`
      UPDATE sync_task_space_file
      SET deleted = 1, content_text = NULL, sha256 = ?, revision = ?, updated_at = ?
      WHERE task_space_id = ? AND relative_path = ? AND deleted = 0
    `),
    bumpTaskSpaceRevision: db.prepare(`
      UPDATE sync_task_space
      SET revision = ?, status = 'indexing', updated_at = ?
      WHERE id = ? AND status != 'disabled' AND retired_at IS NULL
    `),
    deleteFileAudit: db.prepare(`
      INSERT INTO sync_file_audit(
        task_space_id, relative_path, task_id, operation, old_sha256,
        new_sha256, revision, source_user_id, source_agent_id, occurred_at
      ) VALUES (?, ?, ?, 'delete', ?, NULL, ?, NULL, NULL, ?)
    `),
    insertFileAudit: db.prepare(`
      INSERT INTO sync_file_audit(
        task_space_id, relative_path, task_id, operation, old_sha256,
        new_sha256, revision, source_user_id, source_agent_id, occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    agentBinding: db.prepare(`
      SELECT b.*, a.status AS agent_status, a.user_id
      FROM sync_agent_binding b
      JOIN agent_device a ON a.id = b.agent_id
      JOIN sync_active_agent aa ON aa.user_id = a.user_id AND aa.agent_id = a.id
      WHERE b.agent_id = ? AND b.task_space_id = ?
        AND b.sync_status = 'approved' AND a.status = 'active'
    `),
    fileRows: db.prepare(`
      SELECT f.*, u.username AS source_username, u.display_name AS source_display_name,
             a.device_name AS source_device_name
      FROM sync_task_space_file f
      LEFT JOIN user_account u ON u.id = f.source_user_id
      LEFT JOIN agent_device a ON a.id = f.source_agent_id
      WHERE f.task_space_id = ? AND f.revision > ?
        AND f.task_dir NOT LIKE '.trellis/tasks/archive/%'
        AND f.relative_path NOT LIKE '.trellis/tasks/archive/%'
      ORDER BY f.revision, f.relative_path
    `),
    directoryFiles: db.prepare(`
      SELECT *
      FROM sync_task_space_file
      WHERE task_space_id = ? AND task_dir = ? AND deleted = 0
      ORDER BY relative_path
    `),
    taskSummaries: db.prepare(`
      SELECT task_id, relative_dir, title, stage, assignee_user_id, created_by_user_id, updated_at
      FROM sync_task
      WHERE task_space_id = ? AND archived = 0
      ORDER BY updated_at DESC
    `),
    taskRowById: db.prepare(`
      SELECT task_id, relative_dir FROM sync_task
      WHERE task_space_id = ? AND task_id = ? AND archived = 0
      LIMIT 1
    `),
    taskFilesByDir: db.prepare(`
      SELECT relative_path, sha256, content_text FROM sync_task_space_file
      WHERE task_space_id = ? AND task_dir = ? AND deleted = 0
      ORDER BY relative_path
    `),
    serverSnapshotFiles: db.prepare(`
      SELECT relative_path AS path, content_text AS content, sha256, task_id
      FROM sync_task_space_file
      WHERE task_space_id = ? AND deleted = 0
        AND task_dir NOT LIKE '.trellis/tasks/archive/%'
        AND relative_path NOT LIKE '.trellis/tasks/archive/%'
    `),
    baselineOwnsTask: db.prepare(`
      SELECT 1
      FROM sync_project p
      JOIN sync_task_space s
        ON s.project_id = p.id AND s.branch_name = p.baseline_branch
      JOIN sync_task_space_file f
        ON f.task_space_id = s.id AND f.task_id = ? AND f.deleted = 0
      WHERE p.id = ? AND f.relative_path = f.task_dir || '/task.json'
      LIMIT 1
    `),
    mergeEvidence: db.prepare(
      'SELECT * FROM sync_task_merge_evidence WHERE project_id = ? AND task_id = ?',
    ),
    updateMergeEvidence: db.prepare(`
      UPDATE sync_task_merge_evidence
      SET execution_task_key = ?, task_dir = ?, tracked_path = ?, head_commit = ?,
          source_agent_id = ?, source_user_id = ?
      WHERE id = ?
    `),
    insertMergeEvidence: db.prepare(`
      INSERT INTO sync_task_merge_evidence(
        id, project_id, task_id, execution_task_key, baseline_task_space_id,
        task_dir, tracked_path, source_branch_name, baseline_branch_name,
        evidence_type, head_commit, source_agent_id, source_user_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'tracked-in-head', ?, ?, ?, ?)
    `),
    userIdentity: db.prepare('SELECT username, display_name FROM user_account WHERE id = ?'),
    agentDevice: db.prepare('SELECT device_name FROM agent_device WHERE id = ?'),
    pendingConflictForAgent: db.prepare(`
      SELECT *
      FROM sync_conflict
      WHERE task_space_id = ? AND created_by_agent_id = ?
        AND (task_id = ? OR (task_id IS NULL AND task_dir = ?))
        AND status = 'pending'
      ORDER BY (task_id = ?) DESC, created_at DESC, rowid DESC
      LIMIT 1
    `),
    updatePendingConflict: db.prepare(`
      UPDATE sync_conflict
      SET task_id = ?, task_dir = ?, files_json = ?, server_revision = ?,
          client_sequence = ?, batch_id = ?
      WHERE id = ?
    `),
    insertConflict: db.prepare(`
      INSERT INTO sync_conflict(
        id, task_space_id, task_id, task_dir, files_json, server_revision,
        client_sequence, batch_id, status, created_by_user_id, created_by_agent_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
    `),
    batchCountInWindow: db.prepare(`
      SELECT COUNT(*) AS count
      FROM sync_task_space_batch
      WHERE agent_id = ? AND task_space_id = ? AND created_at >= ?
    `),
    batchById: db.prepare(`
      SELECT *
      FROM sync_task_space_batch
      WHERE agent_id = ? AND task_space_id = ? AND batch_id = ?
    `),
    maxClientSequence: db.prepare(`
      SELECT COALESCE(MAX(client_sequence), 0) AS sequence
      FROM sync_task_space_batch
      WHERE agent_id = ? AND task_space_id = ?
    `),
    upsertFile: db.prepare(`
      INSERT INTO sync_task_space_file(
        task_space_id, relative_path, revision, sha256, content_text, deleted,
        task_id, task_dir, source_agent_id, source_user_id,
        source_client_sequence, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_space_id, relative_path) DO UPDATE SET
        revision = excluded.revision,
        sha256 = excluded.sha256,
        content_text = excluded.content_text,
        deleted = excluded.deleted,
        task_id = excluded.task_id,
        task_dir = excluded.task_dir,
        source_agent_id = excluded.source_agent_id,
        source_user_id = excluded.source_user_id,
        source_client_sequence = excluded.source_client_sequence,
        updated_at = excluded.updated_at
    `),
    insertBatch: db.prepare(`
      INSERT INTO sync_task_space_batch(
        batch_id, task_space_id, agent_id, user_id, revision,
        request_sha256, client_sequence, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `),
    upsertCursor: db.prepare(`
      INSERT INTO sync_agent_cursor(agent_id, task_space_id, revision, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(agent_id, task_space_id) DO UPDATE SET
        revision = MAX(sync_agent_cursor.revision, excluded.revision),
        updated_at = excluded.updated_at
    `),
    cursorRevision: db.prepare(`
      SELECT revision FROM sync_agent_cursor
      WHERE agent_id = ? AND task_space_id = ?
    `),
    pendingConflicts: db.prepare(`
      WITH ranked AS (
        SELECT c.*, c.rowid AS conflict_rowid,
               st.title AS task_title,
               ROW_NUMBER() OVER (
                 PARTITION BY c.created_by_agent_id, COALESCE(c.task_id, c.task_dir)
                 ORDER BY c.created_at DESC, c.rowid DESC
               ) AS conflict_rank
        FROM sync_conflict c
        LEFT JOIN sync_task st
          ON st.task_space_id = c.task_space_id
         AND st.task_id = c.task_id
         AND c.task_id IS NOT NULL
        WHERE c.task_space_id = ? AND c.status = 'pending'
          AND NOT EXISTS (
            SELECT 1 FROM sync_task t
            WHERE t.task_space_id = c.task_space_id AND t.archived = 1
              AND (t.task_id = c.task_id OR t.relative_dir = c.task_dir)
          )
      )
      SELECT * FROM ranked
      WHERE conflict_rank = 1
      ORDER BY created_at DESC, conflict_rowid DESC
    `),
    conflictById: db.prepare('SELECT * FROM sync_conflict WHERE id = ?'),
    insertConflictBackup: db.prepare(`
      INSERT INTO sync_conflict_backup(
        id, conflict_id, task_space_id, relative_path, old_content,
        new_content, revision, created_by_user_id, created_by_agent_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    resolveConflictRow: db.prepare(`
      UPDATE sync_conflict SET status = 'resolved', resolved_at = ? WHERE id = ?
    `),
    archiveFiles: db.prepare(`
      SELECT *
      FROM sync_archive_file
      WHERE task_space_id = ? AND task_dir = ?
      ORDER BY relative_path
    `),
    filesInPaths,
    directoryRows,
    activeFilesInTaskDirs,
    projectFilesByTaskIds,
  }
}
