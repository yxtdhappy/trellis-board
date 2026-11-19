import crypto from 'node:crypto'
import { ERROR_CODES, teamError } from '../errors.js'

export const LEASE_DURATION_MS = 10 * 60 * 1000
export const WRITABLE_ROLES = new Set(['lead', 'member'])
export const ACTIVE_LEASE = 'active'
export const HANDOFF_OUTCOMES = new Set(['cleaned', 'conflict'])
export const HANDOFF_BACKUP_ID = /^handoff-[a-f0-9]{16}$/
export const HANDOFF_CONFLICT_REASONS = new Set([
  'missing',
  'git_tracked',
  'git_modified',
  'not_untracked',
  'no_files',
  'baseline_mismatch',
  'branch_mismatch',
  'backup_failed',
  'backup_too_large',
  'cleanup_failed',
  'lease_active',
  'unknown',
])
export const TASK_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const ACTIVE_TASK_DIR = /^\.trellis\/tasks\/[a-z0-9][a-z0-9._-]{0,127}$/i

export function text(value, max = 500) {
  return String(value || '')
    .trim()
    .slice(0, max)
}

export function required(value, label, max = 500) {
  const result = text(value, max)
  if (!result) throw teamError(400, ERROR_CODES.INVALID_INPUT, `${label}格式无效`)
  return result
}

export function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stable(value[key])]),
  )
}

export function hashJson(value) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(stable(value)))
    .digest('hex')
}

export function parseTask(value) {
  try {
    const parsed = JSON.parse(String(value || ''))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function datePrefix(now) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.month}-${values.day}`
}

export function slugify(value) {
  return text(value, 200)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

export function taskId(value) {
  const result = text(value, 200).toLowerCase()
  if (!TASK_ID_PATTERN.test(result)) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, '任务 ID 格式无效')
  }
  return result
}

export function activeTaskDir(value) {
  const result = text(value, 500)
  if (!ACTIVE_TASK_DIR.test(result) || result.slice('.trellis/tasks/'.length) === 'archive') {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, '任务目录必须位于活动任务根下')
  }
  return result
}

export function taskIdFromExecutionKey(executionTaskKey) {
  const index = executionTaskKey.indexOf('::')
  return index >= 0 ? executionTaskKey.slice(index + 2) : executionTaskKey
}

export function canonicalKey(taskSpaceId, taskId) {
  return `${taskSpaceId}::${taskId}`
}

export function safeInteger(value, label, max) {
  const number = Number(value ?? 0)
  if (!Number.isSafeInteger(number) || number < 0 || number > max) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, `${label}格式无效`)
  }
  return number
}

export function normalizeHandoffAck(input = {}) {
  const outcome = text(input.outcome, 20)
  if (!HANDOFF_OUTCOMES.has(outcome)) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, 'handoff ACK 结果无效')
  }
  const backupId = text(input.backupId, 128)
  if (backupId && !HANDOFF_BACKUP_ID.test(backupId)) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, 'handoff 备份 ID 格式无效')
  }
  const manifestSha256 = text(input.manifestSha256, 64).toLowerCase()
  if (manifestSha256 && !/^[a-f0-9]{64}$/.test(manifestSha256)) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, 'handoff manifest 摘要格式无效')
  }
  const reason = text(input.reason, 80)
  const fileCount = safeInteger(input.fileCount, '备份文件数', 100_000)
  const totalBytes = safeInteger(input.totalBytes, '备份字节数', 64 * 1024 * 1024)
  if (outcome === 'cleaned' && (!backupId || !manifestSha256 || fileCount < 1 || totalBytes < 1)) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, '清理 ACK 缺少备份信息')
  }
  if (outcome === 'conflict' && !HANDOFF_CONFLICT_REASONS.has(reason)) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, '冲突 ACK 原因无效')
  }
  return {
    outcome,
    backupId: backupId || null,
    manifestSha256: manifestSha256 || null,
    reason: reason || null,
    fileCount,
    totalBytes,
  }
}

/** 全部预编译语句的唯一来源；子模块只接收这份实例，不再各自 prepare。 */
export function createStatements(db) {
  return {
    readTask: db.prepare('SELECT * FROM sync_task WHERE execution_task_key = ?'),
    readSpace: db.prepare('SELECT * FROM sync_task_space WHERE id = ?'),
    readProject: db.prepare('SELECT * FROM sync_project WHERE id = ?'),
    readMember: db.prepare(`
      SELECT m.*, u.username, u.display_name
      FROM sync_project_member m
      JOIN user_account u ON u.id = m.user_id
      WHERE m.project_id = ? AND m.user_id = ? AND u.status = 'active'
    `),
    readMemberByDev: db.prepare(`
      SELECT m.*, u.username, u.display_name
      FROM sync_project_member m
      JOIN user_account u ON u.id = m.user_id
      WHERE m.project_id = ? AND lower(m.trellis_dev_id) = lower(?)
        AND u.status = 'active'
    `),
    expireActiveLeases: db.prepare(`
      UPDATE sync_task_lease
      SET status = 'expired', updated_at = ?
      WHERE status = 'active' AND expires_at <= ?
    `),
    clearStaleTaskLeases: db.prepare(`
      UPDATE sync_task
      SET lease_id = NULL
      WHERE lease_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM sync_task_lease lease
          WHERE lease.id = sync_task.lease_id
            AND lease.status = 'active'
            AND lease.expires_at > ?
        )
    `),
    readAgentBinding: db.prepare(`
      SELECT binding.id
      FROM sync_agent_binding binding
      JOIN agent_device device ON device.id = binding.agent_id
      JOIN sync_active_agent active
        ON active.user_id = device.user_id AND active.agent_id = device.id
      JOIN sync_task_space space ON space.id = binding.task_space_id
      JOIN sync_project project ON project.id = space.project_id
      JOIN sync_project_member member
        ON member.project_id = space.project_id AND member.user_id = ?
      WHERE binding.agent_id = ? AND binding.task_space_id = ?
        AND binding.sync_status = 'approved' AND device.status = 'active'
        AND member.role IN ('lead', 'member')
        AND space.status <> 'disabled' AND space.retired_at IS NULL
        AND project.status = 'active'
    `),
    readTaskDirFiles: db.prepare(`
      SELECT relative_path, content_text, deleted, task_dir
      FROM sync_task_space_file
      WHERE task_space_id = ? AND task_dir = ?
    `),
    readActiveLease: db.prepare(`
      SELECT * FROM sync_task_lease
      WHERE execution_task_key = ? AND status = 'active' AND expires_at > ?
      ORDER BY created_at DESC
      LIMIT 1
    `),
    revokeLeases: db.prepare(`
      UPDATE sync_task_lease
      SET status = 'revoked', updated_at = ?
      WHERE execution_task_key = ? AND status = 'active'
    `),
    clearRevokedTaskLease: db.prepare(
      'UPDATE sync_task SET lease_id = NULL WHERE execution_task_key = ?',
    ),
    clearTaskLease: db.prepare(
      'UPDATE sync_task SET lease_id = NULL, updated_at = ? WHERE execution_task_key = ?',
    ),
    releaseLease: db.prepare(`
      UPDATE sync_task_lease SET status = 'released', updated_at = ? WHERE id = ?
    `),
    touchLease: db.prepare(`
      UPDATE sync_task_lease
      SET last_heartbeat_at = ?, expires_at = ?, updated_at = ?
      WHERE id = ?
    `),
    setTaskLease: db.prepare(
      'UPDATE sync_task SET lease_id = ?, updated_at = ? WHERE execution_task_key = ?',
    ),
    insertLease: db.prepare(`
      INSERT INTO sync_task_lease(
        id, execution_task_key, agent_id, user_id, lease_token, status,
        expires_at, last_heartbeat_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
    `),
    insertTask: db.prepare(`
      INSERT INTO sync_task(
        execution_task_key, task_key, task_space_id, project_id, task_id,
        relative_dir, title, description, priority, created_by_user_id,
        assignee_user_id, assignee_dev_id, stage, archived,
        materialization_state, task_version, content_revision, handoff_state,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planning', 0,
        'pending', 1, NULL, ?, ?, ?)
    `),
    updateTaskAssignee: db.prepare(`
      UPDATE sync_task
      SET assignee_user_id = ?, assignee_dev_id = ?, previous_assignee_user_id = ?,
          materialization_state = 'pending',
          handoff_state = CASE WHEN ? = created_by_user_id THEN 'none' ELSE 'handoff_pending' END,
          task_version = task_version + 1, lease_id = NULL, updated_at = ?
      WHERE execution_task_key = ?
    `),
    readCommandByIdempotency: db.prepare(`
      SELECT * FROM sync_task_command
      WHERE created_by_user_id = ? AND command_type = 'assign_task' AND idempotency_key = ?
    `),
    insertCommand: db.prepare(`
      INSERT INTO sync_task_command(
        id, task_space_id, project_id, target_user_id, agent_id, binding_id,
        command_type, idempotency_key, request_hash, payload_json, status,
        attempts, created_by_user_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, NULL, NULL, 'assign_task', ?, ?, ?, 'pending', 0, ?, ?, ?)
    `),
    readCommandById: db.prepare('SELECT * FROM sync_task_command WHERE id = ?'),
    insertTaskFromUpload: db.prepare(`
      INSERT INTO sync_task(
        execution_task_key, task_key, task_space_id, project_id, task_id,
        relative_dir, title, description, priority, created_by_user_id,
        assignee_user_id, assignee_dev_id, stage, archived,
        materialization_state, task_version, content_revision, handoff_state,
        materialized_by_agent_id, materialized_at, materialized_revision,
        materialized_manifest_sha256, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?)
    `),
    updateTaskFromUpload: db.prepare(`
      UPDATE sync_task
      SET task_key = ?, relative_dir = ?, title = ?, description = ?, priority = ?,
          assignee_user_id = ?, assignee_dev_id = ?,
          previous_assignee_user_id = ?,
          stage = ?, archived = 0, archived_at = NULL,
          materialization_state = ?,
          task_version = ?, content_revision = ?, handoff_state = ?,
          materialized_by_agent_id = CASE WHEN ? THEN ? ELSE materialized_by_agent_id END,
          materialized_at = CASE WHEN ? THEN ? ELSE materialized_at END,
          materialized_revision = CASE WHEN ? THEN ? ELSE materialized_revision END,
          materialized_manifest_sha256 = CASE WHEN ? THEN ? ELSE materialized_manifest_sha256 END,
          updated_at = ?
      WHERE execution_task_key = ?
    `),
    updateTaskCommandComplete: db.prepare(`
      UPDATE sync_task
      SET materialization_state = 'materialized',
          materialized_by_agent_id = ?, materialized_at = ?,
          materialized_revision = ?, handoff_state = ?, updated_at = ?
      WHERE execution_task_key = ?
    `),
    readVisibleTaskIds: db.prepare(`
      SELECT task_id FROM sync_task
      WHERE task_space_id = ? AND assignee_user_id = ? AND archived = 0
    `),
    readTaskByDir: db.prepare(`
      SELECT * FROM sync_task
      WHERE task_space_id = ? AND relative_dir = ?
      LIMIT 1
    `),
    readArchivedTaskByBasename: db.prepare(`
      SELECT 1 FROM sync_task
      WHERE task_space_id = ? AND archived = 1 AND relative_dir LIKE ? ESCAPE '\\'
      LIMIT 1
    `),
    readLegacyTaskFile: db.prepare(`
      SELECT 1 FROM sync_task_space_file
      WHERE task_space_id = ? AND task_dir = ? AND deleted = 0
      LIMIT 1
    `),
    readAgentControls: db.prepare(`
      SELECT * FROM sync_task
      WHERE task_space_id = ?
        AND (
          assignee_user_id = ? OR created_by_user_id = ? OR previous_assignee_user_id = ?
        )
      ORDER BY updated_at DESC
    `),
    readPendingTasks: db.prepare(`
      SELECT * FROM sync_task
      WHERE task_space_id = ? AND archived = 0
        AND materialization_state IN ('pending', 'claimed')
      ORDER BY created_at, execution_task_key
    `),
    readSpaceTasks: db.prepare('SELECT * FROM sync_task WHERE task_space_id = ?'),
    insertProjectionTask: db.prepare(`
      INSERT OR IGNORE INTO sync_task(
        execution_task_key, task_key, task_space_id, project_id, task_id,
        relative_dir, title, description, priority, created_by_user_id,
        assignee_user_id, assignee_dev_id, stage, archived,
        materialization_state, task_version, content_revision, handoff_state,
        created_at, updated_at, archived_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?,
        'materialized', 1, NULL, 'none', ?, ?, ?)
    `),
    archiveProjectionTask: db.prepare(`
      UPDATE sync_task
      SET task_key = ?, relative_dir = ?, archived = 1, archived_at = ?,
          materialization_state = 'materialized', task_version = task_version + 1,
          lease_id = NULL, updated_at = ?
      WHERE execution_task_key = ?
    `),
    resolveArchivedConflicts: db.prepare(`
      UPDATE sync_conflict SET status = 'resolved', resolved_at = ?
      WHERE task_space_id = ? AND status = 'pending'
        AND (task_dir = ? OR task_id = ?)
    `),
    updateProjectionDir: db.prepare(`
      UPDATE sync_task
      SET task_key = ?, relative_dir = ?, updated_at = ?
      WHERE execution_task_key = ?
    `),
    markTaskClaimed: db.prepare(`
      UPDATE sync_task
      SET materialization_state = 'claimed', handoff_state = CASE
        WHEN created_by_user_id IS NOT NULL AND created_by_user_id <> assignee_user_id
          THEN 'target_materializing' ELSE handoff_state END,
        updated_at = ?
      WHERE execution_task_key = ?
    `),
    readLastHandoffAudit: db.prepare(`
      SELECT detail_json FROM audit_event
      WHERE actor_user_id = ? AND action = 'task_handoff_cleanup_ack'
        AND target_id = ? AND result = ?
      ORDER BY id DESC LIMIT 1
    `),
    updateHandoffState: db.prepare(`
      UPDATE sync_task
      SET handoff_state = ?, updated_at = ?
      WHERE execution_task_key = ? AND handoff_state = 'source_cleanup_pending'
    `),
  }
}
