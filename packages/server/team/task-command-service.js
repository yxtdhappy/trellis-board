import crypto from 'node:crypto'
import { withTransaction } from '../database.js'
import { ERROR_CODES, teamError } from './errors.js'

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const TASK_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const ACTIVE_TASK_DIR = /^\.trellis\/tasks\/[a-z0-9][a-z0-9._-]{0,127}$/i
const PRIORITIES = new Set(['P0', 'P1', 'P2', 'P3'])

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  )
}

function hashJson(value) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(stableValue(value)))
    .digest('hex')
}

function requiredText(value, label, max = 500) {
  const result = String(value || '').trim()
  if (!result || Array.from(result).length > max) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, `${label}格式无效`)
  }
  return result
}

function optionalText(value, max = 4000) {
  const result = String(value || '').trim()
  return result ? result.slice(0, max) : null
}

function taskIdFromContent(value) {
  try {
    const task = JSON.parse(String(value || ''))
    return typeof task?.id === 'string' && task.id.trim() ? task.id.trim() : null
  } catch {
    return null
  }
}

function safeId(value, label) {
  const text = String(value || '').trim()
  if (!SAFE_ID.test(text)) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, `${label}格式无效`)
  }
  return text
}

function slugifyTitle(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

function taskSlug(value) {
  const slug = String(value || '')
    .trim()
    .toLowerCase()
  if (!TASK_SLUG.test(slug)) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, '任务 slug 格式无效')
  }
  return slug
}

function activeTaskRelativeDir(value) {
  const relativeDir = String(value || '').trim()
  if (
    !ACTIVE_TASK_DIR.test(relativeDir) ||
    relativeDir.slice('.trellis/tasks/'.length) === 'archive'
  ) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, '任务目录必须位于活动任务根下')
  }
  return relativeDir
}

function taskDatePrefix(now) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.month}-${values.day}`
}

function parseJsonOr(value, fallback = {}) {
  try {
    return JSON.parse(String(value ?? ''))
  } catch {
    return fallback
  }
}

function operationPublic(row) {
  return {
    id: row.id,
    taskSpaceId: row.task_space_id,
    projectId: row.project_id,
    targetUserId: row.target_user_id,
    agentId: row.agent_id,
    bindingId: row.binding_id,
    commandType: row.command_type,
    status: row.status,
    payload: parseJsonOr(row.payload_json),
    result: row.result_json ? parseJsonOr(row.result_json, null) : null,
    error: row.error_text || null,
    attempts: Number(row.attempts || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function createTaskCommandService({
  db,
  taskSpaces,
  agents,
  taskControl = null,
  events = null,
  onTaskControlChanged = null,
  now = () => new Date(),
  deliveredLeaseMs = 5 * 60 * 1000,
  runningLeaseMs = 30 * 60 * 1000,
}) {
  function commandTarget(actor, taskSpaceId, assigneeUserId) {
    taskSpaces.authorizeTaskSpace(actor, taskSpaceId, 'write')
    const space = taskSpaces.loadTaskSpaceRow(taskSpaceId)
    const userId = safeId(assigneeUserId, '负责人用户 ID')
    const member = db
      .prepare(`
      SELECT m.*, s.project_id, u.display_name, u.username
      FROM sync_project_member m
      JOIN sync_task_space s ON s.project_id = m.project_id
      JOIN user_account u ON u.id = m.user_id
      WHERE s.id = ? AND m.user_id = ? AND u.status = 'active'
    `)
      .get(taskSpaceId, userId)
    if (!member || !['lead', 'member'].includes(member.role)) {
      throw teamError(
        409,
        'ASSIGNEE_NOT_WRITABLE',
        '目标用户不是该项目的可写成员，请先配置 Trellis developer ID',
      )
    }
    return { space, userId, member }
  }

  function uniqueOnlineTarget(taskSpaceId, assigneeUserId) {
    if (agents.onlineListenerCount(taskSpaceId) === 0) return null
    const candidates = agents.onlineAgentForTaskSpace(taskSpaceId, assigneeUserId)
    return candidates.length === 1 ? candidates[0] : null
  }

  function enqueue(actor, input = {}) {
    const taskSpaceId = safeId(input.taskSpaceId, '任务空间 ID')
    const commandType = String(input.commandType || '')
    if (!new Set(['create_task', 'assign_task']).has(commandType)) {
      throw teamError(400, ERROR_CODES.INVALID_INPUT, '任务命令类型无效')
    }
    const assigneeUserId = requiredText(input.assigneeUserId, '负责人', 128)
    const idempotencyKey = String(input.idempotencyKey || crypto.randomUUID()).trim()
    if (!SAFE_ID.test(idempotencyKey)) {
      throw teamError(400, ERROR_CODES.INVALID_INPUT, '幂等键格式无效')
    }
    const targetContext = commandTarget(actor, taskSpaceId, assigneeUserId)
    let payload
    let plannedTask = null
    if (commandType === 'create_task') {
      const priority = String(input.priority || 'P2')
        .trim()
        .toUpperCase()
      if (!PRIORITIES.has(priority)) {
        throw teamError(400, ERROR_CODES.INVALID_INPUT, '优先级必须是 P0、P1、P2 或 P3')
      }
      const title = requiredText(input.title, '任务标题', 200)
      const requestedSlug = String(input.slug || '').trim()
      const requestedRelativeDir = String(input.relativeDir || '').trim()
      const taskId = requestedSlug
        ? taskSlug(requestedSlug)
        : slugifyTitle(title) || `board-${hashJson({ title, idempotencyKey }).slice(0, 12)}`
      const relativeDir =
        (requestedRelativeDir && activeTaskRelativeDir(requestedRelativeDir)) ||
        `.trellis/tasks/${taskDatePrefix(now())}-${taskId}`
      payload = {
        title,
        description: optionalText(input.description, 4000),
        priority,
        slug: taskId,
        taskId,
        relativeDir,
        assigneeUserId,
        assigneeDevId: targetContext.member.trellis_dev_id,
      }
    } else {
      const executionTaskKey = requiredText(input.executionTaskKey, '任务身份', 500)
      const authoritative = taskControl
        ? taskControl.authoritativeTasks(taskSpaceId).get(executionTaskKey)
        : null
      const indexed =
        authoritative ||
        db
          .prepare(`
          SELECT * FROM sync_task_index
          WHERE task_space_id = ? AND execution_task_key = ?
          LIMIT 1
        `)
          .get(taskSpaceId, executionTaskKey)
      if (!indexed) throw teamError(404, ERROR_CODES.NOT_FOUND, '目标任务不存在')
      const taskJson = db
        .prepare(`
        SELECT sha256, content_text
        FROM sync_task_space_file
        WHERE task_space_id = ? AND task_dir = ?
          AND relative_path LIKE '%/task.json' AND deleted = 0
        ORDER BY relative_path
        LIMIT 1
      `)
        .get(taskSpaceId, indexed.relative_dir)
      const taskId =
        taskIdFromContent(taskJson?.content_text) ||
        indexed.task_id ||
        String(executionTaskKey).slice(String(executionTaskKey).indexOf('::') + 2)
      if (!taskId || `${taskSpaceId}::${taskId}` !== executionTaskKey) {
        throw teamError(409, ERROR_CODES.CONFLICT, '任务执行身份不稳定，不能改派')
      }
      payload = {
        executionTaskKey,
        taskKey: indexed.task_key || indexed.taskKey,
        relativeDir: indexed.relative_dir,
        assigneeUserId,
        assigneeDevId: targetContext.member.trellis_dev_id,
        baseTaskVersion: indexed.task_version,
        baseTaskSha256: taskJson?.sha256 || null,
      }
    }
    const requestHash = hashJson({ commandType, taskSpaceId, payload })
    const existing = db
      .prepare(`
      SELECT *
      FROM sync_task_command
      WHERE created_by_user_id = ? AND command_type = ? AND idempotency_key = ?
    `)
      .get(actor.userId, commandType, idempotencyKey)
    if (existing) {
      if (existing.request_hash !== requestHash) {
        throw teamError(409, ERROR_CODES.CONFLICT, '同一幂等键不能提交不同任务命令')
      }
      return { statusCode: 202, operation: operationPublic(existing), idempotent: true }
    }
    const target = uniqueOnlineTarget(taskSpaceId, assigneeUserId)
    const id = withTransaction(db, () => {
      if (taskControl && commandType === 'create_task') {
        plannedTask = taskControl.createPendingTask(actor.userId, {
          ...payload,
          taskSpaceId,
          idempotencyKey,
        })
        payload.executionTaskKey = plannedTask.executionTaskKey
        payload.taskKey = plannedTask.taskKey
        payload.relativeDir = plannedTask.relativeDir
        payload.taskVersion = plannedTask.taskVersion
      }
      if (taskControl && commandType === 'assign_task') {
        plannedTask = taskControl.assignPendingTask(payload)
        payload.taskKey = plannedTask.taskKey
        payload.relativeDir = plannedTask.relativeDir
        payload.baseTaskVersion = plannedTask.taskVersion
      }
      const timestamp = now().toISOString()
      const commandId = crypto.randomUUID()
      db.prepare(`
        INSERT INTO sync_task_command(
          id, task_space_id, project_id, target_user_id, agent_id, binding_id,
          command_type, idempotency_key, request_hash, payload_json, status,
          attempts, created_by_user_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
      `).run(
        commandId,
        taskSpaceId,
        targetContext.space.project_id,
        assigneeUserId,
        target?.id || null,
        target?.binding_id || null,
        commandType,
        idempotencyKey,
        requestHash,
        JSON.stringify(payload),
        actor.userId,
        timestamp,
        timestamp,
      )
      return commandId
    })
    const row = db.prepare('SELECT * FROM sync_task_command WHERE id = ?').get(id)
    if (target) events?.notifyCommandAvailable(target.id)
    onTaskControlChanged?.({
      taskSpaceId,
      executionTaskKey: plannedTask?.executionTaskKey || null,
      reason: commandType,
    })
    return { statusCode: 202, operation: operationPublic(row), idempotent: false }
  }

  function list(actor, input = {}) {
    const taskSpaceId = safeId(input.taskSpaceId, '任务空间 ID')
    taskSpaces.authorizeTaskSpace(actor, taskSpaceId, 'view')
    return {
      operations: db
        .prepare(`
        SELECT *
        FROM sync_task_command
        WHERE task_space_id = ?
        ORDER BY created_at DESC
        LIMIT 100
      `)
        .all(taskSpaceId)
        .map(operationPublic),
    }
  }

  function get(actor, operationId) {
    const row = db
      .prepare('SELECT * FROM sync_task_command WHERE id = ?')
      .get(safeId(operationId, '操作 ID'))
    if (!row) throw teamError(404, ERROR_CODES.NOT_FOUND, '任务操作不存在')
    taskSpaces.authorizeTaskSpace(actor, row.task_space_id, 'view')
    return { operation: operationPublic(row) }
  }

  function retry(actor, operationId) {
    const row = db
      .prepare('SELECT * FROM sync_task_command WHERE id = ?')
      .get(safeId(operationId, '操作 ID'))
    if (!row) throw teamError(404, ERROR_CODES.NOT_FOUND, '任务操作不存在')
    taskSpaces.authorizeTaskSpace(actor, row.task_space_id, 'write')
    if (row.status !== 'failed') {
      throw teamError(409, ERROR_CODES.CONFLICT, '只有失败的任务操作可以重试')
    }
    const payload = operationPublic(row).payload
    const target = uniqueOnlineTarget(row.task_space_id, payload.assigneeUserId)
    const timestamp = now().toISOString()
    db.prepare(`
      UPDATE sync_task_command
      SET target_user_id = ?, agent_id = ?, binding_id = ?, status = 'pending',
          attempts = 0, error_text = NULL, result_json = NULL,
          lease_expires_at = NULL, updated_at = ?
      WHERE id = ?
    `).run(
      payload.assigneeUserId,
      target?.id || null,
      target?.binding_id || null,
      timestamp,
      row.id,
    )
    if (target) events?.notifyCommandAvailable(target.id)
    return {
      operation: operationPublic(
        db.prepare('SELECT * FROM sync_task_command WHERE id = ?').get(row.id),
      ),
    }
  }

  function cancel(actor, operationId) {
    const row = db
      .prepare('SELECT * FROM sync_task_command WHERE id = ?')
      .get(safeId(operationId, '操作 ID'))
    if (!row) throw teamError(404, ERROR_CODES.NOT_FOUND, '任务操作不存在')
    taskSpaces.authorizeTaskSpace(actor, row.task_space_id, 'write')
    if (new Set(['succeeded', 'cancelled']).has(row.status)) {
      return { operation: operationPublic(row), idempotent: true }
    }
    db.prepare(`
      UPDATE sync_task_command
      SET status = 'cancelled', error_text = '用户已取消', updated_at = ?
      WHERE id = ?
    `).run(now().toISOString(), row.id)
    return {
      operation: operationPublic(
        db.prepare('SELECT * FROM sync_task_command WHERE id = ?').get(row.id),
      ),
      idempotent: false,
    }
  }

  function available(agentId) {
    const agent = db
      .prepare(`
      SELECT device.id, device.user_id
      FROM agent_device device
      JOIN sync_active_agent active
        ON active.user_id = device.user_id AND active.agent_id = device.id
      WHERE device.id = ? AND device.status = 'active'
    `)
      .get(agentId)
    if (!agent) return []
    return withTransaction(db, () => {
      const rows = db
        .prepare(`
        SELECT c.*, s.branch_name
        FROM sync_task_command c
        JOIN sync_task_space s ON s.id = c.task_space_id
        JOIN sync_agent_binding binding
          ON binding.task_space_id = c.task_space_id
         AND binding.agent_id = ?
         AND binding.sync_status = 'approved'
        WHERE c.target_user_id = ? AND c.status = 'pending'
          AND (c.agent_id IS NULL OR c.agent_id = ?)
        ORDER BY c.created_at, c.id
        LIMIT 20
      `)
        .all(agentId, agent.user_id, agentId)
      const availableRows = []
      for (const row of rows) {
        const online = agents.onlineAgentForTaskSpace(row.task_space_id, agent.user_id)
        if (online.length !== 1) continue
        const binding = online[0]
        if (row.binding_id && row.binding_id !== binding.binding_id) continue
        const updated = db
          .prepare(`
          UPDATE sync_task_command
          SET agent_id = ?, binding_id = ?, project_id = ?, updated_at = ?
          WHERE id = ? AND status = 'pending'
            AND (agent_id IS NULL OR agent_id = ?)
        `)
          .run(
            agentId,
            binding.binding_id,
            binding.project_id,
            now().toISOString(),
            row.id,
            agentId,
          )
        if (Number(updated.changes) !== 1) continue
        availableRows.push({
          ...row,
          agent_id: agentId,
          binding_id: binding.binding_id,
          project_id: binding.project_id,
          local_repo_key: binding.local_repo_key,
        })
      }
      return availableRows.map((row) => ({
        id: row.id,
        bindingId: row.binding_id,
        type: row.command_type,
        payload: {
          taskSpaceId: row.task_space_id,
          projectId: row.project_id,
          branchName: row.branch_name,
          ...parseJsonOr(row.payload_json),
        },
      }))
    })
  }

  function markDelivered(agentId, commandId) {
    const timestamp = now()
    const leaseExpiresAt = new Date(timestamp.getTime() + deliveredLeaseMs).toISOString()
    db.prepare(`
      UPDATE sync_task_command
      SET status = 'delivered', attempts = attempts + 1,
          lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND agent_id = ? AND status = 'pending'
    `).run(leaseExpiresAt, timestamp.toISOString(), commandId, agentId)
  }

  function start(agentId, commandId) {
    const row = db
      .prepare('SELECT * FROM sync_task_command WHERE id = ? AND agent_id = ?')
      .get(safeId(commandId, '命令 ID'), safeId(agentId, 'Agent ID'))
    if (!row) throw teamError(404, ERROR_CODES.NOT_FOUND, '任务命令不存在')
    if (new Set(['succeeded', 'cancelled', 'failed']).has(row.status)) {
      return {
        execute: false,
        operation: operationPublic(row),
      }
    }
    if (row.status === 'running') {
      return {
        execute: false,
        operation: operationPublic(row),
      }
    }
    const timestamp = now()
    const leaseExpiresAt = new Date(timestamp.getTime() + runningLeaseMs).toISOString()
    const result = db
      .prepare(`
      UPDATE sync_task_command
      SET status = 'running', lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND agent_id = ? AND status IN ('pending', 'delivered')
    `)
      .run(leaseExpiresAt, timestamp.toISOString(), row.id, agentId)
    if (result.changes !== 1) {
      const current = db.prepare('SELECT * FROM sync_task_command WHERE id = ?').get(row.id)
      return {
        execute: false,
        operation: operationPublic(current),
      }
    }
    return {
      execute: true,
      operation: operationPublic(
        db.prepare('SELECT * FROM sync_task_command WHERE id = ?').get(row.id),
      ),
    }
  }

  function complete(agent, commandId, input = {}) {
    const row = db
      .prepare(`
      SELECT c.*, s.indexed_revision
      FROM sync_task_command c
      JOIN sync_task_space s ON s.id = c.task_space_id
      WHERE c.id = ? AND c.agent_id = ?
    `)
      .get(safeId(commandId, '命令 ID'), agent.id)
    if (!row) throw teamError(404, ERROR_CODES.NOT_FOUND, '任务命令不存在')
    if (new Set(['succeeded', 'cancelled']).has(row.status)) {
      return { operation: operationPublic(row), idempotent: true }
    }
    if (row.status !== 'running') {
      throw teamError(409, ERROR_CODES.CONFLICT, '任务命令尚未进入运行状态，不能提交执行结果')
    }
    const success = input.status === 'succeeded'
    if (!success) {
      const timestamp = now().toISOString()
      db.prepare(`
        UPDATE sync_task_command
        SET status = 'failed', error_text = ?, updated_at = ?
        WHERE id = ?
      `).run(String(input.error || 'Agent 执行任务命令失败').slice(0, 1000), timestamp, row.id)
      return {
        operation: operationPublic(
          db.prepare('SELECT * FROM sync_task_command WHERE id = ?').get(row.id),
        ),
        idempotent: false,
      }
    }
    const result = input.result && typeof input.result === 'object' ? input.result : {}
    const revision = Number(result.revision)
    if (!Number.isSafeInteger(revision) || revision < 1) {
      throw teamError(400, ERROR_CODES.INVALID_INPUT, '成功结果缺少有效 revision')
    }
    if (Number(row.indexed_revision) < revision) {
      throw teamError(
        409,
        'COMMAND_WAITING_INDEX',
        '任务文件已上传但服务端尚未完成索引，请稍后重试命令结果',
        { recoverable: true },
      )
    }
    const payload = operationPublic(row).payload
    const resultTaskId = requiredText(result.taskId, '任务 ID', 200)
    const payloadTaskId =
      payload.taskId ||
      String(payload.executionTaskKey || '').slice(
        String(payload.executionTaskKey || '').indexOf('::') + 2,
      )
    const expectedTaskId = payloadTaskId || resultTaskId
    const expectedExecutionTaskKey =
      payload.executionTaskKey || `${row.task_space_id}::${expectedTaskId}`
    const expectedTaskKey = payload.taskKey || ''
    const expectedRelativeDir = payload.relativeDir || ''
    if (
      !expectedTaskId ||
      resultTaskId !== expectedTaskId ||
      (result.executionTaskKey && result.executionTaskKey !== expectedExecutionTaskKey) ||
      (result.taskKey && expectedTaskKey && result.taskKey !== expectedTaskKey) ||
      (result.relativeDir && expectedRelativeDir && result.relativeDir !== expectedRelativeDir)
    ) {
      throw teamError(409, ERROR_CODES.CONFLICT, '命令结果与目标任务身份不一致')
    }
    const indexedRows = db
      .prepare(`
      SELECT *
      FROM sync_task_index
      WHERE task_space_id = ?
        AND (task_key = ? OR execution_task_key = ? OR relative_dir = ?)
      LIMIT 2
    `)
      .all(row.task_space_id, expectedTaskKey, expectedExecutionTaskKey, expectedRelativeDir)
    if (indexedRows.length === 0) {
      throw teamError(
        409,
        'COMMAND_WAITING_INDEX',
        '服务端索引中还没有目标任务，请稍后重试命令结果',
        { recoverable: true },
      )
    }
    if (indexedRows.length > 1) {
      throw teamError(409, ERROR_CODES.CONFLICT, '任务执行身份冲突，不能确认命令结果')
    }
    const indexed = indexedRows[0]
    if (
      indexed.execution_task_key !== expectedExecutionTaskKey ||
      (expectedRelativeDir && indexed.relative_dir !== expectedRelativeDir)
    ) {
      throw teamError(
        409,
        'COMMAND_WAITING_INDEX',
        '服务端索引中的任务身份与命令结果不一致，请稍后重试',
        { recoverable: true },
      )
    }
    if (payload.assigneeUserId && indexed.assignee_user_id !== payload.assigneeUserId) {
      throw teamError(
        409,
        'COMMAND_WAITING_INDEX',
        '服务端任务负责人尚未更新为命令目标，请稍后重试',
        { recoverable: true },
      )
    }
    const controlledTask = withTransaction(db, () => {
      const timestamp = now().toISOString()
      const update = db
        .prepare(`
        UPDATE sync_task_command
        SET status = 'succeeded', result_json = ?, error_text = NULL, updated_at = ?
        WHERE id = ? AND status = 'running'
      `)
        .run(
          JSON.stringify({
            ...result,
            taskId: expectedTaskId,
            executionTaskKey: expectedExecutionTaskKey,
          }),
          timestamp,
          row.id,
        )
      if (Number(update.changes) !== 1) {
        throw teamError(409, ERROR_CODES.CONFLICT, '任务命令状态已变化，请刷新后重试')
      }
      if (!taskControl || !new Set(['create_task', 'assign_task']).has(row.command_type)) {
        return null
      }
      const task = taskControl.completeCommand(agent, row.task_space_id, {
        ...result,
        commandType: row.command_type,
        taskId: expectedTaskId,
        executionTaskKey: expectedExecutionTaskKey,
      })
      if (!task) {
        throw teamError(409, 'COMMAND_WAITING_INDEX', '权威任务尚未建立，请稍后重试', {
          recoverable: true,
        })
      }
      return task
    })
    if (controlledTask) {
      onTaskControlChanged?.({
        taskSpaceId: row.task_space_id,
        executionTaskKey: controlledTask.executionTaskKey,
        reason: `${row.command_type}_completed`,
      })
      events?.notifyTaskControlChanged?.(row.task_space_id)
    }
    return {
      operation: operationPublic(
        db.prepare('SELECT * FROM sync_task_command WHERE id = ?').get(row.id),
      ),
      ...(controlledTask ? { task: controlledTask } : {}),
      idempotent: false,
    }
  }

  function staleLeases(agentId) {
    const timestamp = now().toISOString()
    db.prepare(`
      UPDATE sync_task_command
      SET status = 'pending', agent_id = NULL, binding_id = NULL,
          lease_expires_at = NULL, updated_at = ?
      WHERE agent_id = ?
        AND status IN ('delivered', 'running')
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at <= ?
    `).run(timestamp, agentId, timestamp)
  }

  return {
    enqueue,
    list,
    get,
    retry,
    cancel,
    available,
    markDelivered,
    start,
    complete,
    staleLeases,
  }
}
