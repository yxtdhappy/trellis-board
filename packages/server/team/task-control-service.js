import crypto from 'node:crypto'
import { withTransaction } from '../database.js'
import { appendAuditEvent } from './audit.js'
import { ERROR_CODES, teamError } from './errors.js'

const LEASE_DURATION_MS = 10 * 60 * 1000
const WRITABLE_ROLES = new Set(['lead', 'member'])
const ACTIVE_LEASE = 'active'
const HANDOFF_OUTCOMES = new Set(['cleaned', 'conflict'])
const HANDOFF_BACKUP_ID = /^handoff-[a-f0-9]{16}$/
const HANDOFF_CONFLICT_REASONS = new Set([
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
const TASK_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const ACTIVE_TASK_DIR = /^\.trellis\/tasks\/[a-z0-9][a-z0-9._-]{0,127}$/i

function text(value, max = 500) {
  return String(value || '')
    .trim()
    .slice(0, max)
}

function required(value, label, max = 500) {
  const result = text(value, max)
  if (!result) throw teamError(400, ERROR_CODES.INVALID_INPUT, `${label}格式无效`)
  return result
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stable(value[key])]),
  )
}

function hashJson(value) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(stable(value)))
    .digest('hex')
}

function parseTask(value) {
  try {
    const parsed = JSON.parse(String(value || ''))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function datePrefix(now) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.month}-${values.day}`
}

function slugify(value) {
  return text(value, 200)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

function taskId(value) {
  const result = text(value, 200).toLowerCase()
  if (!TASK_ID_PATTERN.test(result)) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, '任务 ID 格式无效')
  }
  return result
}

function activeTaskDir(value) {
  const result = text(value, 500)
  if (!ACTIVE_TASK_DIR.test(result) || result.slice('.trellis/tasks/'.length) === 'archive') {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, '任务目录必须位于活动任务根下')
  }
  return result
}

function taskIdFromExecutionKey(executionTaskKey) {
  const index = executionTaskKey.indexOf('::')
  return index >= 0 ? executionTaskKey.slice(index + 2) : executionTaskKey
}

function canonicalKey(taskSpaceId, taskId) {
  return `${taskSpaceId}::${taskId}`
}

function safeInteger(value, label, max) {
  const number = Number(value ?? 0)
  if (!Number.isSafeInteger(number) || number < 0 || number > max) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, `${label}格式无效`)
  }
  return number
}

function normalizeHandoffAck(input = {}) {
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

export function createTaskControlService({
  db,
  now = () => new Date(),
  leaseDurationMs = LEASE_DURATION_MS,
}) {
  const readTask = db.prepare('SELECT * FROM sync_task WHERE execution_task_key = ?')
  const readSpace = db.prepare('SELECT * FROM sync_task_space WHERE id = ?')
  const readProject = db.prepare('SELECT * FROM sync_project WHERE id = ?')
  const readMember = db.prepare(`
    SELECT m.*, u.username, u.display_name
    FROM sync_project_member m
    JOIN user_account u ON u.id = m.user_id
    WHERE m.project_id = ? AND m.user_id = ? AND u.status = 'active'
  `)
  const readMemberByDev = db.prepare(`
    SELECT m.*, u.username, u.display_name
    FROM sync_project_member m
    JOIN user_account u ON u.id = m.user_id
    WHERE m.project_id = ? AND lower(m.trellis_dev_id) = lower(?)
      AND u.status = 'active'
  `)

  function expireLeases(timestamp = now().toISOString()) {
    db.prepare(`
      UPDATE sync_task_lease
      SET status = 'expired', updated_at = ?
      WHERE status = 'active' AND expires_at <= ?
    `).run(timestamp, timestamp)
    db.prepare(`
      UPDATE sync_task
      SET lease_id = NULL
      WHERE lease_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM sync_task_lease lease
          WHERE lease.id = sync_task.lease_id
            AND lease.status = 'active'
            AND lease.expires_at > ?
        )
    `).run(timestamp)
  }

  function taskRow(executionTaskKey) {
    return readTask.get(required(executionTaskKey, '任务身份')) || null
  }

  function assertAgentAccess(agent, taskSpaceId) {
    const binding = db
      .prepare(`
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
    `)
      .get(agent.userId, agent.id, required(taskSpaceId, '任务空间 ID'))
    if (!binding) {
      throw teamError(403, ERROR_CODES.FORBIDDEN, 'Agent 尚未绑定该任务空间')
    }
  }

  function resolveAssignee(projectId, taskDocument, fallbackUserId) {
    const devId = text(
      taskDocument?.assignee || taskDocument?.assigneeDevId || taskDocument?.owner,
      128,
    )
    if (devId) {
      const member = readMemberByDev.get(projectId, devId.toLowerCase())
      if (member && WRITABLE_ROLES.has(member.role)) {
        return {
          userId: member.user_id,
          devId: member.trellis_dev_id,
          member,
        }
      }
    }
    const member = readMember.get(projectId, fallbackUserId)
    return {
      userId: fallbackUserId,
      // 未知 dev id 仍保留为看板可见性元数据；控制面负责人回退到当前用户。
      devId: devId || member?.trellis_dev_id || null,
      member,
    }
  }

  function documentForUpload(taskSpaceId, taskDir, files) {
    const rows = new Map(
      db
        .prepare(`
        SELECT relative_path, content_text, deleted, task_dir
        FROM sync_task_space_file
        WHERE task_space_id = ? AND task_dir = ?
      `)
        .all(taskSpaceId, taskDir)
        .map((row) => [row.relative_path, row]),
    )
    for (const file of files) {
      if (file.deleted) rows.delete(file.path)
      else {
        rows.set(file.path, {
          relative_path: file.path,
          content_text: file.content,
          deleted: 0,
          task_dir: file.taskDir,
        })
      }
    }
    const taskJson = [...rows.values()].find(
      (row) => !row.deleted && row.relative_path.endsWith('/task.json'),
    )
    return {
      document: parseTask(taskJson?.content_text),
      taskJsonSha256: taskJson
        ? crypto
            .createHash('sha256')
            .update(taskJson.content_text || '')
            .digest('hex')
        : null,
    }
  }

  function activeLease(executionTaskKey) {
    return (
      db
        .prepare(`
        SELECT * FROM sync_task_lease
        WHERE execution_task_key = ? AND status = 'active' AND expires_at > ?
        ORDER BY created_at DESC
        LIMIT 1
      `)
        .get(executionTaskKey, now().toISOString()) || null
    )
  }

  function revokeLeases(executionTaskKey, timestamp) {
    db.prepare(`
      UPDATE sync_task_lease
      SET status = 'revoked', updated_at = ?
      WHERE execution_task_key = ? AND status = 'active'
    `).run(timestamp, executionTaskKey)
    db.prepare('UPDATE sync_task SET lease_id = NULL WHERE execution_task_key = ?').run(
      executionTaskKey,
    )
  }

  function ensureLease(executionTaskKey, agent) {
    const timestampDate = now()
    const timestamp = timestampDate.toISOString()
    expireLeases(timestamp)
    const current = activeLease(executionTaskKey)
    if (current && current.agent_id !== agent.id) {
      throw teamError(409, 'TASK_LEASE_HELD', '任务正由其他客户端修改，请等待租约释放后接管', {
        details: {
          executionTaskKey,
          leaseExpiresAt: current.expires_at,
          holderUserId: current.user_id,
        },
      })
    }
    const expiresAt = new Date(timestampDate.getTime() + leaseDurationMs).toISOString()
    if (current) {
      db.prepare(`
        UPDATE sync_task_lease
        SET last_heartbeat_at = ?, expires_at = ?, updated_at = ?
        WHERE id = ?
      `).run(timestamp, expiresAt, timestamp, current.id)
      db.prepare(
        'UPDATE sync_task SET lease_id = ?, updated_at = ? WHERE execution_task_key = ?',
      ).run(current.id, timestamp, executionTaskKey)
      return { ...current, expires_at: expiresAt, last_heartbeat_at: timestamp }
    }
    const lease = {
      id: crypto.randomUUID(),
      token: crypto.randomUUID(),
      expiresAt,
      lastHeartbeatAt: timestamp,
    }
    db.prepare(`
      INSERT INTO sync_task_lease(
        id, execution_task_key, agent_id, user_id, lease_token, status,
        expires_at, last_heartbeat_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
    `).run(
      lease.id,
      executionTaskKey,
      agent.id,
      agent.userId,
      lease.token,
      expiresAt,
      timestamp,
      timestamp,
      timestamp,
    )
    db.prepare(
      'UPDATE sync_task SET lease_id = ?, updated_at = ? WHERE execution_task_key = ?',
    ).run(lease.id, timestamp, executionTaskKey)
    return {
      id: lease.id,
      execution_task_key: executionTaskKey,
      agent_id: agent.id,
      user_id: agent.userId,
      lease_token: lease.token,
      status: ACTIVE_LEASE,
      expires_at: expiresAt,
      last_heartbeat_at: timestamp,
    }
  }

  function publicTask(row) {
    if (!row) return null
    return {
      executionTaskKey: row.execution_task_key,
      taskKey: row.task_key,
      taskSpaceId: row.task_space_id,
      projectId: row.project_id,
      taskId: row.task_id,
      relativeDir: row.relative_dir,
      title: row.title,
      description: row.description,
      priority: row.priority,
      createdByUserId: row.created_by_user_id,
      assigneeUserId: row.assignee_user_id,
      assigneeDevId: row.assignee_dev_id,
      stage: row.stage,
      archived: Boolean(row.archived),
      materializationState: row.materialization_state,
      taskVersion: Number(row.task_version),
      contentRevision: row.content_revision == null ? null : Number(row.content_revision),
      leaseId: row.lease_id || null,
      previousAssigneeUserId: row.previous_assignee_user_id || null,
      handoffState: row.handoff_state,
      materializedRevision:
        row.materialized_revision == null ? null : Number(row.materialized_revision),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      archivedAt: row.archived_at || null,
    }
  }

  function publicLease(row) {
    if (!row) return null
    return {
      id: row.id,
      executionTaskKey: row.execution_task_key,
      agentId: row.agent_id,
      userId: row.user_id,
      token: row.lease_token,
      status: row.status,
      expiresAt: row.expires_at,
      lastHeartbeatAt: row.last_heartbeat_at,
    }
  }

  function pendingSlug(title, fallbackKey) {
    const slug = slugify(title)
    if (slug && slug !== 'archive') return slug
    return `board-${hashJson({ title, fallbackKey }).slice(0, 12)}`
  }

  function createPendingTask(actorUserId, input = {}) {
    const space = readSpace.get(required(input.taskSpaceId, '任务空间 ID'))
    if (!space) throw teamError(404, ERROR_CODES.NOT_FOUND, '任务空间不存在')
    const project = readProject.get(space.project_id)
    if (!project) throw teamError(404, ERROR_CODES.NOT_FOUND, '项目不存在')
    const title = required(input.title, '任务标题', 200)
    const requestedTaskId = text(input.taskId || input.slug, 200)
    const requestedRelativeDir = text(input.relativeDir, 500)
    const taskIdValue = taskId(requestedTaskId || pendingSlug(title, input.idempotencyKey || title))
    const relativeDir =
      (requestedRelativeDir && activeTaskDir(requestedRelativeDir)) ||
      `.trellis/tasks/${datePrefix(now())}-${taskIdValue}`
    const executionTaskKey = canonicalKey(space.id, taskIdValue)
    const existing = readTask.get(executionTaskKey)
    if (existing) {
      if (existing.archived) {
        throw teamError(409, 'TASK_ARCHIVED', '已归档任务不能重新创建')
      }
      throw teamError(409, 'TASK_EXISTS', '同一任务 ID 已存在，不能重复创建')
    }
    const assigneeUserId = required(input.assigneeUserId || actorUserId, '负责人用户 ID', 128)
    const member = readMember.get(project.id, assigneeUserId)
    if (!member || !WRITABLE_ROLES.has(member.role)) {
      throw teamError(409, 'ASSIGNEE_NOT_WRITABLE', '目标用户不是该项目的可写成员')
    }
    const timestamp = now().toISOString()
    db.prepare(`
      INSERT INTO sync_task(
        execution_task_key, task_key, task_space_id, project_id, task_id,
        relative_dir, title, description, priority, created_by_user_id,
        assignee_user_id, assignee_dev_id, stage, archived,
        materialization_state, task_version, content_revision, handoff_state,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planning', 0,
        'pending', 1, NULL, ?, ?, ?)
    `).run(
      executionTaskKey,
      `${space.id}::${relativeDir}`,
      space.id,
      project.id,
      taskIdValue,
      relativeDir,
      title,
      text(input.description, 4000),
      text(input.priority, 8) || 'P2',
      actorUserId,
      assigneeUserId,
      member.trellis_dev_id,
      actorUserId === assigneeUserId ? 'none' : 'handoff_pending',
      timestamp,
      timestamp,
    )
    return publicTask(readTask.get(executionTaskKey))
  }

  function assignPendingTask(input = {}) {
    const row = taskRow(input.executionTaskKey)
    if (!row) throw teamError(404, ERROR_CODES.NOT_FOUND, '目标任务不存在')
    if (row.archived) throw teamError(409, 'TASK_ARCHIVED', '归档任务不能改派')
    const assigneeUserId = required(input.assigneeUserId, '负责人用户 ID', 128)
    const member = readMember.get(row.project_id, assigneeUserId)
    if (!member || !WRITABLE_ROLES.has(member.role)) {
      throw teamError(409, 'ASSIGNEE_NOT_WRITABLE', '目标用户不是该项目的可写成员')
    }
    const changed = row.assignee_user_id !== assigneeUserId
    if (!changed) return publicTask(row)
    const timestamp = now().toISOString()
    db.prepare(`
      UPDATE sync_task
      SET assignee_user_id = ?, assignee_dev_id = ?, previous_assignee_user_id = ?,
          materialization_state = 'pending',
          handoff_state = CASE WHEN ? = created_by_user_id THEN 'none' ELSE 'handoff_pending' END,
          task_version = task_version + 1, lease_id = NULL, updated_at = ?
      WHERE execution_task_key = ?
    `).run(
      assigneeUserId,
      member.trellis_dev_id,
      row.assignee_user_id,
      assigneeUserId,
      timestamp,
      row.execution_task_key,
    )
    revokeLeases(row.execution_task_key, timestamp)
    return publicTask(readTask.get(row.execution_task_key))
  }

  function assertUploadAllowed(agent, taskSpaceId, complete, input = {}) {
    assertAgentAccess(agent, taskSpaceId)
    const executionTaskKey =
      complete.taskId == null ? null : canonicalKey(taskSpaceId, complete.taskId)
    const row = executionTaskKey ? readTask.get(executionTaskKey) : null
    if (!row) return { task: null, lease: null }
    if (row.archived) {
      throw teamError(409, 'TASK_ARCHIVED', '任务已归档，拒绝旧客户端重新写回', {
        details: {
          executionTaskKey,
          taskId: row.task_id,
          archivedAt: row.archived_at,
        },
      })
    }
    if (row.assignee_user_id && row.assignee_user_id !== agent.userId) {
      throw teamError(409, 'TASK_WRITE_FORBIDDEN', '任务已改派给其他负责人，本客户端只读', {
        details: {
          executionTaskKey,
          taskId: row.task_id,
          assigneeUserId: row.assignee_user_id,
        },
      })
    }
    const incomingVersion = Number(input.taskVersion)
    if (!Number.isSafeInteger(incomingVersion)) {
      throw teamError(409, 'TASK_VERSION_REQUIRED', '客户端必须先获取任务版本再写入', {
        details: {
          executionTaskKey,
          expectedTaskVersion: Number(row.task_version),
        },
      })
    }
    if (incomingVersion !== Number(row.task_version)) {
      throw teamError(409, 'TASK_VERSION_STALE', '本地任务版本已落后，请先拉取最新控制状态', {
        details: {
          executionTaskKey,
          expectedTaskVersion: Number(row.task_version),
          receivedTaskVersion: incomingVersion,
        },
      })
    }
    const lease = activeLease(executionTaskKey)
    if (lease && lease.agent_id !== agent.id) {
      throw teamError(409, 'TASK_LEASE_HELD', '任务正由其他客户端修改', {
        details: { executionTaskKey, leaseExpiresAt: lease.expires_at },
      })
    }
    const token = text(input.leaseToken, 200)
    if (!token) {
      throw teamError(409, 'TASK_LEASE_REQUIRED', '客户端必须先认领任务写租约再上传')
    }
    if (!lease || lease.lease_token !== token) {
      throw teamError(409, 'TASK_LEASE_INVALID', '任务写租约无效或已过期')
    }
    return { task: row, lease }
  }

  function enqueueAssignmentCommand({
    actorUserId,
    taskSpaceId,
    task,
    assigneeUserId,
    assigneeDevId,
  }) {
    const payload = {
      executionTaskKey: task.execution_task_key,
      taskKey: task.task_key,
      relativeDir: task.relative_dir,
      assigneeUserId,
      assigneeDevId,
      baseTaskVersion: Number(task.task_version),
    }
    const requestHash = hashJson({ commandType: 'assign_task', taskSpaceId, payload })
    const idempotencyKey = `local-assign-${task.execution_task_key}-${task.task_version}`
    const existing = db
      .prepare(`
      SELECT * FROM sync_task_command
      WHERE created_by_user_id = ? AND command_type = 'assign_task' AND idempotency_key = ?
    `)
      .get(actorUserId, idempotencyKey)
    if (existing) {
      if (existing.request_hash !== requestHash) {
        throw teamError(409, ERROR_CODES.CONFLICT, '本任务改派命令发生内容冲突')
      }
      return existing
    }
    const id = crypto.randomUUID()
    const timestamp = now().toISOString()
    db.prepare(`
      INSERT INTO sync_task_command(
        id, task_space_id, project_id, target_user_id, agent_id, binding_id,
        command_type, idempotency_key, request_hash, payload_json, status,
        attempts, created_by_user_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, NULL, NULL, 'assign_task', ?, ?, ?, 'pending', 0, ?, ?, ?)
    `).run(
      id,
      taskSpaceId,
      task.project_id,
      assigneeUserId,
      idempotencyKey,
      requestHash,
      JSON.stringify(payload),
      actorUserId,
      timestamp,
      timestamp,
    )
    return db.prepare('SELECT * FROM sync_task_command WHERE id = ?').get(id)
  }

  function commitUpload({ agent, space, complete, files, revision, contentChanged = false }) {
    const taskDir = complete.taskDir
    if (!taskDir || !complete.taskId) return { task: null, lease: null }
    const { document } = documentForUpload(space.id, taskDir, files)
    const existing = readTask.get(canonicalKey(space.id, complete.taskId))
    if (existing?.archived) {
      throw teamError(409, 'TASK_ARCHIVED', '任务已归档，拒绝旧客户端重新写回')
    }
    const assignee = existing?.assignee_user_id
      ? {
          userId: existing.assignee_user_id,
          devId: existing.assignee_dev_id || null,
        }
      : resolveAssignee(space.project_id, document, agent.userId)
    const timestamp = now().toISOString()
    const title = text(document?.title, 200) || existing?.title || complete.taskId
    const description = document ? text(document.description, 4000) : existing?.description || ''
    const priority = text(document?.priority, 8) || existing?.priority || 'P2'
    const stage =
      text(document?.execution?.stage || document?.stage, 80) || existing?.stage || 'planning'
    const taskKey = `${space.id}::${taskDir}`
    const metadataChanged =
      !existing ||
      existing.relative_dir !== taskDir ||
      existing.title !== title ||
      existing.description !== description ||
      existing.priority !== priority ||
      existing.stage !== stage ||
      existing.assignee_user_id !== assignee.userId ||
      existing.assignee_dev_id !== assignee.devId
    const taskVersion = existing
      ? Number(existing.task_version) + (contentChanged || metadataChanged ? 1 : 0)
      : 1
    const isTargetWriter = assignee.userId === agent.userId
    // 内容上传只推进 materialization；来源清理必须等命令结果和索引校验完成后由
    // completeCommand() 按命令类型收敛，避免 create_task 在命令确认前误触发清理。
    const handoffState = existing?.handoff_state || 'none'
    if (!existing) {
      db.prepare(`
        INSERT INTO sync_task(
          execution_task_key, task_key, task_space_id, project_id, task_id,
          relative_dir, title, description, priority, created_by_user_id,
          assignee_user_id, assignee_dev_id, stage, archived,
          materialization_state, task_version, content_revision, handoff_state,
          materialized_by_agent_id, materialized_at, materialized_revision,
          materialized_manifest_sha256, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?)
      `).run(
        canonicalKey(space.id, complete.taskId),
        taskKey,
        space.id,
        space.project_id,
        complete.taskId,
        taskDir,
        title,
        description,
        priority,
        agent.userId,
        assignee.userId,
        assignee.devId,
        stage,
        isTargetWriter ? 'materialized' : 'pending',
        taskVersion,
        revision,
        handoffState,
        isTargetWriter ? agent.id : null,
        isTargetWriter ? timestamp : null,
        isTargetWriter ? revision : null,
        document ? hashJson(document) : null,
        timestamp,
        timestamp,
      )
    } else {
      db.prepare(`
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
      `).run(
        taskKey,
        taskDir,
        title,
        description,
        priority,
        assignee.userId,
        assignee.devId,
        existing.assignee_user_id !== assignee.userId
          ? existing.assignee_user_id
          : existing.previous_assignee_user_id,
        stage,
        isTargetWriter ? 'materialized' : 'pending',
        taskVersion,
        revision,
        handoffState,
        isTargetWriter ? 1 : 0,
        agent.id,
        isTargetWriter ? 1 : 0,
        timestamp,
        isTargetWriter ? 1 : 0,
        revision,
        isTargetWriter ? 1 : 0,
        document ? hashJson(document) : null,
        timestamp,
        existing.execution_task_key,
      )
      if (existing.assignee_user_id !== assignee.userId) {
        revokeLeases(existing.execution_task_key, timestamp)
      }
    }
    const task = readTask.get(canonicalKey(space.id, complete.taskId))
    let lease = null
    if (isTargetWriter) {
      lease = ensureLease(task.execution_task_key, agent)
    } else if (existing?.assignee_user_id !== assignee.userId) {
      enqueueAssignmentCommand({
        actorUserId: agent.userId,
        taskSpaceId: space.id,
        task,
        assigneeUserId: assignee.userId,
        assigneeDevId: assignee.devId,
      })
    }
    return { task: publicTask(task), lease: publicLease(lease) }
  }

  function completeCommand(agent, taskSpaceId, input = {}) {
    const taskId = required(input.taskId, '任务 ID', 200)
    const row = readTask.get(canonicalKey(taskSpaceId, taskId))
    if (!row) return null
    if (row.task_id !== taskId) {
      throw teamError(409, ERROR_CODES.CONFLICT, '命令结果与权威任务身份不一致')
    }
    if (row.archived) {
      throw teamError(409, 'TASK_ARCHIVED', '归档任务不能确认命令结果')
    }
    if (row.assignee_user_id !== agent.userId) {
      throw teamError(403, ERROR_CODES.FORBIDDEN, '只能确认分配给自己的任务命令')
    }
    const revision = Number(input.revision)
    if (
      row.content_revision != null &&
      Number.isSafeInteger(revision) &&
      revision !== Number(row.content_revision)
    ) {
      throw teamError(409, 'TASK_VERSION_STALE', '命令结果 revision 已过期，请先拉取最新任务')
    }
    const timestamp = now().toISOString()
    const handoffState =
      input.commandType === 'create_task'
        ? 'none'
        : input.commandType === 'assign_task' &&
            row.created_by_user_id &&
            row.created_by_user_id !== row.assignee_user_id &&
            row.assignee_user_id === agent.userId
          ? 'source_cleanup_pending'
          : row.handoff_state
    db.prepare(`
      UPDATE sync_task
      SET materialization_state = 'materialized',
          materialized_by_agent_id = ?, materialized_at = ?,
          materialized_revision = ?, handoff_state = ?, updated_at = ?
      WHERE execution_task_key = ?
    `).run(
      agent.id,
      timestamp,
      Number(input.revision) || null,
      handoffState,
      timestamp,
      row.execution_task_key,
    )
    return publicTask(readTask.get(row.execution_task_key))
  }

  function visibleTaskIds(agent, taskSpaceId) {
    assertAgentAccess(agent, taskSpaceId)
    return new Set(
      db
        .prepare(`
        SELECT task_id FROM sync_task
        WHERE task_space_id = ? AND assignee_user_id = ? AND archived = 0
      `)
        .all(taskSpaceId, agent.userId)
        .map((row) => row.task_id),
    )
  }

  function assertReadable(agent, taskSpaceId, taskDir) {
    assertAgentAccess(agent, taskSpaceId)
    const row = db
      .prepare(`
      SELECT * FROM sync_task
      WHERE task_space_id = ? AND relative_dir = ?
      LIMIT 1
    `)
      .get(taskSpaceId, taskDir)
    if (!row) {
      const basename = taskDir.split('/').filter(Boolean).pop() || ''
      if (basename) {
        const pattern = `.trellis/tasks/archive/%/${basename.replace(/[\\%_]/g, (ch) => `\\${ch}`)}`
        const archived = db
          .prepare(`
          SELECT 1 FROM sync_task
          WHERE task_space_id = ? AND archived = 1 AND relative_dir LIKE ? ESCAPE '\\'
          LIMIT 1
        `)
          .get(taskSpaceId, pattern)
        if (archived) throw teamError(409, 'TASK_ARCHIVED', '任务已归档')
      }
      const legacy = db
        .prepare(`
        SELECT 1 FROM sync_task_space_file
        WHERE task_space_id = ? AND task_dir = ? AND deleted = 0
        LIMIT 1
      `)
        .get(taskSpaceId, taskDir)
      if (legacy) throw teamError(403, ERROR_CODES.FORBIDDEN, '只能读取本人任务内容')
      throw teamError(404, ERROR_CODES.NOT_FOUND, '任务不存在')
    }
    if (row.archived) throw teamError(409, 'TASK_ARCHIVED', '任务已归档')
    if (row.assignee_user_id !== agent.userId) {
      throw teamError(403, ERROR_CODES.FORBIDDEN, '只能读取本人任务内容')
    }
    return publicTask(row)
  }

  function controlsForAgent(agent, taskSpaceId) {
    return db
      .prepare(`
      SELECT * FROM sync_task
      WHERE task_space_id = ?
        AND (
          assignee_user_id = ? OR created_by_user_id = ? OR previous_assignee_user_id = ?
        )
      ORDER BY updated_at DESC
    `)
      .all(taskSpaceId, agent.userId, agent.userId, agent.userId)
      .map((row) => {
        let state = null
        if (row.archived) state = 'archived'
        else if (
          row.created_by_user_id === agent.userId &&
          row.assignee_user_id !== agent.userId &&
          row.materialization_state === 'materialized'
        ) {
          state = 'handoff_materialized'
        } else if (
          row.previous_assignee_user_id === agent.userId &&
          row.assignee_user_id !== agent.userId
        ) {
          state = 'reassigned'
        } else if (row.assignee_user_id === agent.userId) {
          if (row.materialization_state === 'pending') state = 'pending_delivery'
          else if (row.materialization_state === 'materialized') state = 'materialized'
          else state = 'claimed'
        }
        if (!state) return null
        const lease = state === 'handoff_materialized' ? activeLease(row.execution_task_key) : null
        return {
          executionTaskKey: row.execution_task_key,
          taskId: row.task_id,
          relativeDir: row.relative_dir,
          title: row.title,
          state,
          taskVersion: Number(row.task_version),
          assigneeUserId: row.assignee_user_id,
          handoffState: row.handoff_state,
          materializedRevision:
            row.materialized_revision == null ? null : Number(row.materialized_revision),
          materializedAt: row.materialized_at,
          // 目标负责人自己的租约说明任务正在由新的负责人正常使用，不应阻止
          // 创建者清理自己的来源副本；只有第三方租约才意味着真正的并发写入。
          leaseHeldByOtherUser: Boolean(
            lease &&
              lease.user_id !== agent.userId &&
              lease.user_id !== row.assignee_user_id,
          ),
          updatedAt: row.updated_at,
        }
      })
      .filter(Boolean)
  }

  function pendingTasks(taskSpaceId) {
    return db
      .prepare(`
      SELECT * FROM sync_task
      WHERE task_space_id = ? AND archived = 0
        AND materialization_state IN ('pending', 'claimed')
      ORDER BY created_at, execution_task_key
    `)
      .all(taskSpaceId)
  }

  function authoritativeTasks(taskSpaceId) {
    return new Map(
      db
        .prepare('SELECT * FROM sync_task WHERE task_space_id = ?')
        .all(taskSpaceId)
        .map((row) => [row.execution_task_key, row]),
    )
  }

  function reconcileProjection({ taskSpaceId, projectId, tasks }) {
    const timestamp = now().toISOString()
    const project = readProject.get(projectId)
    const taskGroups = new Map()
    for (const task of tasks) {
      const key = text(task.executionTaskKey || task.taskKey, 500)
      if (!key) continue
      const group = taskGroups.get(key) || []
      group.push(task)
      taskGroups.set(key, group)
    }
    const authoritativeTasks = [...taskGroups.values()].flatMap((group) => {
      const archived = group.filter((task) => task.archived)
      if (archived.length === 1) return archived
      return archived.length === 0 && group.length === 1 ? group : []
    })
    for (const task of authoritativeTasks) {
      const executionTaskKey = text(task.executionTaskKey || task.taskKey, 500)
      if (!executionTaskKey) continue
      const taskId = taskIdFromExecutionKey(executionTaskKey)
      const existing = readTask.get(executionTaskKey)
      const assignee =
        resolveAssignee(projectId, { assignee: task.assignee }, project?.created_by_user_id) || null
      if (!existing) {
        db.prepare(`
          INSERT OR IGNORE INTO sync_task(
            execution_task_key, task_key, task_space_id, project_id, task_id,
            relative_dir, title, description, priority, created_by_user_id,
            assignee_user_id, assignee_dev_id, stage, archived,
            materialization_state, task_version, content_revision, handoff_state,
            created_at, updated_at, archived_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?,
            'materialized', 1, NULL, 'none', ?, ?, ?)
        `).run(
          executionTaskKey,
          task.taskKey || `${taskSpaceId}::${task.relativeDir}`,
          taskSpaceId,
          projectId,
          taskId,
          task.relativeDir,
          text(task.title, 200) || taskId,
          text(task.priority, 8) || 'P2',
          assignee?.userId || project?.created_by_user_id || null,
          assignee?.userId || null,
          assignee?.devId || task.assignee || null,
          text(task.derivedStage, 80) || 'planning',
          task.archived ? 1 : 0,
          timestamp,
          timestamp,
          task.archived ? task.archivedAt || timestamp : null,
        )
        continue
      }
      if (task.archived && !existing.archived) {
        db.prepare(`
          UPDATE sync_task
          SET task_key = ?, relative_dir = ?, archived = 1, archived_at = ?,
              materialization_state = 'materialized', task_version = task_version + 1,
              lease_id = NULL, updated_at = ?
          WHERE execution_task_key = ?
        `).run(
          task.taskKey || existing.task_key,
          task.relativeDir || existing.relative_dir,
          task.archivedAt || timestamp,
          timestamp,
          executionTaskKey,
        )
        revokeLeases(executionTaskKey, timestamp)
        db.prepare(`
          UPDATE sync_conflict SET status = 'resolved', resolved_at = ?
          WHERE task_space_id = ? AND status = 'pending'
            AND (task_dir = ? OR task_id = ?)
        `).run(timestamp, taskSpaceId, existing.relative_dir, existing.task_id)
      } else if (!task.archived && !existing.archived && task.relativeDir) {
        db.prepare(`
          UPDATE sync_task
          SET task_key = ?, relative_dir = ?, updated_at = ?
          WHERE execution_task_key = ?
        `).run(task.taskKey || existing.task_key, task.relativeDir, timestamp, executionTaskKey)
      }
    }
  }

  function claim(agent, taskSpaceId, executionTaskKey) {
    assertAgentAccess(agent, taskSpaceId)
    return withTransaction(db, () => {
      const row = taskRow(executionTaskKey)
      if (!row || row.task_space_id !== taskSpaceId) {
        throw teamError(404, ERROR_CODES.NOT_FOUND, '任务不存在')
      }
      if (row.archived) throw teamError(409, 'TASK_ARCHIVED', '归档任务不能认领')
      if (row.assignee_user_id !== agent.userId) {
        throw teamError(403, ERROR_CODES.FORBIDDEN, '只能认领分配给自己的任务')
      }
      const lease = ensureLease(row.execution_task_key, agent)
      if (row.materialization_state === 'pending') {
        db.prepare(`
          UPDATE sync_task
          SET materialization_state = 'claimed', handoff_state = CASE
            WHEN created_by_user_id IS NOT NULL AND created_by_user_id <> assignee_user_id
              THEN 'target_materializing' ELSE handoff_state END,
            updated_at = ?
          WHERE execution_task_key = ?
        `).run(now().toISOString(), row.execution_task_key)
      }
      return {
        task: publicTask(readTask.get(row.execution_task_key)),
        lease: publicLease(lease),
      }
    })
  }

  function heartbeat(agent, taskSpaceId, executionTaskKey, input = {}) {
    assertAgentAccess(agent, taskSpaceId)
    return withTransaction(db, () => {
      const row = taskRow(executionTaskKey)
      if (!row || row.task_space_id !== taskSpaceId) {
        throw teamError(404, ERROR_CODES.NOT_FOUND, '任务不存在')
      }
      const lease = activeLease(row.execution_task_key)
      if (!lease || lease.agent_id !== agent.id || lease.user_id !== agent.userId) {
        throw teamError(409, 'TASK_LEASE_INVALID', '任务写租约无效或已过期')
      }
      const token = text(input.leaseToken, 200)
      if (token && token !== lease.lease_token) {
        throw teamError(409, 'TASK_LEASE_INVALID', '任务写租约令牌不匹配')
      }
      const timestampDate = now()
      const timestamp = timestampDate.toISOString()
      const expiresAt = new Date(timestampDate.getTime() + leaseDurationMs).toISOString()
      db.prepare(`
        UPDATE sync_task_lease
        SET expires_at = ?, last_heartbeat_at = ?, updated_at = ?
        WHERE id = ?
      `).run(expiresAt, timestamp, timestamp, lease.id)
      return {
        task: publicTask(row),
        lease: publicLease({
          ...lease,
          expires_at: expiresAt,
          last_heartbeat_at: timestamp,
        }),
      }
    })
  }

  function release(agent, taskSpaceId, executionTaskKey, input = {}) {
    assertAgentAccess(agent, taskSpaceId)
    return withTransaction(db, () => {
      const row = taskRow(executionTaskKey)
      if (!row || row.task_space_id !== taskSpaceId) {
        throw teamError(404, ERROR_CODES.NOT_FOUND, '任务不存在')
      }
      const lease = activeLease(row.execution_task_key)
      if (!lease) return { released: true, idempotent: true }
      if (lease.agent_id !== agent.id || lease.user_id !== agent.userId) {
        throw teamError(403, ERROR_CODES.FORBIDDEN, '不能释放其他客户端的任务租约')
      }
      const token = text(input.leaseToken, 200)
      if (token && token !== lease.lease_token) {
        throw teamError(409, 'TASK_LEASE_INVALID', '任务写租约令牌不匹配')
      }
      const timestamp = now().toISOString()
      db.prepare(`
        UPDATE sync_task_lease SET status = 'released', updated_at = ? WHERE id = ?
      `).run(timestamp, lease.id)
      db.prepare(`
        UPDATE sync_task SET lease_id = NULL, updated_at = ? WHERE execution_task_key = ?
      `).run(timestamp, row.execution_task_key)
      return { released: true, idempotent: false }
    })
  }

  function ackHandoff(agent, taskSpaceId, executionTaskKey, input = {}) {
    assertAgentAccess(agent, taskSpaceId)
    const ack = normalizeHandoffAck(input)
    return withTransaction(db, () => {
      const row = taskRow(executionTaskKey)
      if (!row || row.task_space_id !== taskSpaceId) {
        throw teamError(404, ERROR_CODES.NOT_FOUND, '任务不存在')
      }
      if (row.created_by_user_id !== agent.userId) {
        throw teamError(403, ERROR_CODES.FORBIDDEN, '只能由任务创建者处理 handoff 清理')
      }
      const nextState = ack.outcome === 'cleaned' ? 'completed' : 'source_cleanup_conflict'
      if (
        (row.handoff_state === 'completed' && ack.outcome === 'cleaned') ||
        (row.handoff_state === 'source_cleanup_conflict' && ack.outcome === 'conflict')
      ) {
        const audit = db
          .prepare(`
          SELECT detail_json FROM audit_event
          WHERE actor_user_id = ? AND action = 'task_handoff_cleanup_ack'
            AND target_id = ? AND result = ?
          ORDER BY id DESC LIMIT 1
        `)
          .get(agent.userId, row.execution_task_key, ack.outcome)
        let detail = null
        try {
          detail = audit ? JSON.parse(audit.detail_json) : null
        } catch {
          detail = null
        }
        const sameAck =
          detail &&
          detail.outcome === ack.outcome &&
          (detail.reason || null) === ack.reason &&
          (detail.backupId || null) === ack.backupId &&
          (detail.manifestSha256 || null) === ack.manifestSha256 &&
          Number(detail.fileCount || 0) === ack.fileCount &&
          Number(detail.totalBytes || 0) === ack.totalBytes
        if (!sameAck) {
          throw teamError(409, 'HANDOFF_ACK_MISMATCH', '重复 handoff ACK 与已完成结果不一致')
        }
        return {
          handoffState: row.handoff_state,
          outcome: ack.outcome,
          idempotent: true,
          updatedAt: row.updated_at,
        }
      }
      if (row.handoff_state !== 'source_cleanup_pending') {
        throw teamError(409, 'HANDOFF_NOT_READY', '任务当前没有待确认的 handoff 清理状态')
      }
      const lease = activeLease(row.execution_task_key)
      if (
        ack.outcome === 'cleaned' &&
        lease &&
        lease.user_id !== agent.userId &&
        lease.user_id !== row.assignee_user_id
      ) {
        throw teamError(409, 'HANDOFF_LEASE_HELD', '任务仍被其他客户端修改，暂不能确认清理')
      }
      const timestamp = now().toISOString()
      const project = readProject.get(row.project_id)
      appendAuditEvent(db, {
        actorUserId: agent.userId,
        actorAgentId: agent.id,
        teamId: project?.owner_team_id || null,
        projectId: row.project_id,
        action: 'task_handoff_cleanup_ack',
        targetType: 'sync_task',
        targetId: row.execution_task_key,
        result: ack.outcome,
        occurredAt: timestamp,
        detail: {
          outcome: ack.outcome,
          reason: ack.reason,
          backupId: ack.backupId,
          manifestSha256: ack.manifestSha256,
          fileCount: ack.fileCount,
          totalBytes: ack.totalBytes,
        },
      })
      const update = db
        .prepare(`
        UPDATE sync_task
        SET handoff_state = ?, updated_at = ?
        WHERE execution_task_key = ? AND handoff_state = 'source_cleanup_pending'
      `)
        .run(nextState, timestamp, row.execution_task_key)
      if (Number(update.changes) !== 1) {
        throw teamError(409, ERROR_CODES.CONFLICT, 'handoff 状态已变化，请刷新后重试')
      }
      return {
        handoffState: nextState,
        outcome: ack.outcome,
        idempotent: false,
        updatedAt: timestamp,
      }
    })
  }

  function getTask(agent, taskSpaceId, executionTaskKey) {
    assertAgentAccess(agent, taskSpaceId)
    const row = taskRow(executionTaskKey)
    if (!row || row.task_space_id !== taskSpaceId) {
      throw teamError(404, ERROR_CODES.NOT_FOUND, '任务不存在')
    }
    if (row.assignee_user_id !== agent.userId) {
      return { task: publicTask(row), contentAvailable: false }
    }
    const lease = activeLease(row.execution_task_key)
    return {
      task: publicTask(row),
      contentAvailable: !row.archived && Boolean(lease && lease.agent_id === agent.id),
    }
  }

  return {
    createPendingTask,
    assignPendingTask,
    assertAgentAccess,
    assertUploadAllowed,
    commitUpload,
    completeCommand,
    visibleTaskIds,
    assertReadable,
    controlsForAgent,
    pendingTasks,
    authoritativeTasks,
    reconcileProjection,
    claim,
    heartbeat,
    release,
    ackHandoff,
    getTask,
    expireLeases,
    publicTask,
    publicLease,
  }
}
