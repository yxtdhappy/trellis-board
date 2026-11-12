import crypto from 'node:crypto'
import { projectBoardExecution, projectTaskDetailExecution } from '../execution-projection.js'
import { undoLastOperation } from '../execution-history.js'
import { createExecutionStore } from '../execution-store.js'
import { setManualStage, STAGE_IDS } from '../metadata.js'
import { appendAuditEvent } from './audit.js'
import { ERROR_CODES, teamError } from './errors.js'
import { resolveTeamScope } from './teams.js'

const EXECUTION_WIP_LIMIT = 2
const ASSIGNABLE_ROLES = new Set(['lead', 'member'])

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

function parseJson(value, fallback) {
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function requiredText(value, label, max = 500) {
  const result = String(value || '').trim()
  if (!result || Array.from(result).length > max) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, `${label}格式无效`)
  }
  return result
}

function taskSpaceIdFromInput(input = {}) {
  const explicit = String(input.taskSpaceId || '').trim()
  if (explicit) return explicit
  const executionTaskKey = String(input.executionTaskKey || input.taskKey || '').trim()
  if (executionTaskKey.includes('::'))
    return executionTaskKey.slice(0, executionTaskKey.indexOf('::'))
  return ''
}

function publicAssignment(row) {
  if (!row) return null
  return {
    executionTaskKey: row.execution_task_key,
    taskSpaceId: row.task_space_id,
    projectId: row.project_id,
    assignedUserId: row.assigned_user_id,
    state: row.state,
    assignedBy: row.assigned_by,
    assignedAt: row.assigned_at,
    acceptedAt: row.accepted_at || null,
    baseTaskVersion: row.base_task_version || null,
    version: Number(row.version),
  }
}

export function createGitlessBoardService({
  db,
  taskSpaces,
  taskSpaceIndex,
  agents = null,
  executionWipLimit = EXECUTION_WIP_LIMIT,
}) {
  const executionStore = createExecutionStore({ db, stageIds: STAGE_IDS })
  const assigneeWarnings = new Map()

  function teamScope(actor, requestedTeamId) {
    return resolveTeamScope(db, actor, requestedTeamId) || ''
  }

  function readWipLimit(actor, requestedTeamId) {
    const scope = teamScope(actor, requestedTeamId)
    const row = db
      .prepare(`
      SELECT value_json
      FROM user_board_state
      WHERE user_id = ? AND team_id = ? AND key = 'executionWipLimit'
    `)
      .get(actor.userId, scope)
    const value = parseJson(row?.value_json, null)
    return Number.isInteger(value) && value >= 1 && value <= 9 ? value : executionWipLimit
  }

  function writeWipLimit(actor, value, requestedTeamId) {
    if (!Number.isInteger(value) || value < 1 || value > 9) {
      throw teamError(400, ERROR_CODES.INVALID_INPUT, '实现中 WIP 软上限必须是 1 到 9 的整数')
    }
    db.prepare(`
      INSERT INTO user_board_state(user_id, team_id, key, value_json, updated_at)
      VALUES (?, ?, 'executionWipLimit', ?, ?)
      ON CONFLICT(user_id, team_id, key) DO UPDATE SET
        value_json = excluded.value_json,
        updated_at = excluded.updated_at
    `).run(
      actor.userId,
      teamScope(actor, requestedTeamId),
      JSON.stringify(value),
      new Date().toISOString(),
    )
    return value
  }

  function userError(callback) {
    try {
      return callback()
    } catch (error) {
      if (error?.status && error?.code) throw error
      throw teamError(
        400,
        ERROR_CODES.INVALID_INPUT,
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  function listProjects(actor, input = {}) {
    return taskSpaces.listReadable(actor, input)
  }

  function listStatusReadable(actor) {
    return taskSpaces.listStatusReadable(actor)
  }

  function projectAgentSummaries(projectIds, onlineSince) {
    if (!projectIds.length) return new Map()
    const placeholders = projectIds.map(() => '?').join(', ')
    const rows = db
      .prepare(`
      SELECT
        s.project_id,
        COUNT(*) AS total,
        SUM(CASE WHEN b.sync_status = 'approved' THEN 1 ELSE 0 END) AS approved,
        SUM(CASE
          WHEN b.sync_status = 'approved'
            AND active.agent_id = a.id
            AND a.status = 'active'
            AND a.last_seen_at >= ?
          THEN 1 ELSE 0
        END) AS online
      FROM sync_agent_binding b
      JOIN sync_task_space s ON s.id = b.task_space_id
      JOIN agent_device a ON a.id = b.agent_id
      LEFT JOIN sync_active_agent active ON active.user_id = a.user_id
      WHERE s.project_id IN (${placeholders})
      GROUP BY s.project_id
    `)
      .all(onlineSince, ...projectIds)
    return new Map(
      rows.map((row) => [
        row.project_id,
        {
          total: Number(row.total || 0),
          pending: 0,
          approved: Number(row.approved || 0),
          online: Number(row.online || 0),
        },
      ]),
    )
  }

  function status(actor, { staleMs = 60_000 } = {}) {
    const projects = listStatusReadable(actor)
    const onlineSince = new Date(Math.floor((Date.now() - staleMs) / 1000) * 1000).toISOString()
    const summaries = projectAgentSummaries(
      projects.map((project) => project.id),
      onlineSince,
    )
    const taskSpaceIds = new Set(
      projects.flatMap((project) => (project.taskSpaces || []).map((space) => space.id)),
    )
    const pendingAssignments = Number(
      db
        .prepare(`
        SELECT COUNT(*) AS count
        FROM sync_task_assignment
        WHERE assigned_user_id = ? AND state = 'pending'
      `)
        .get(actor.userId).count,
    )
    const operations = [...taskSpaceIds].flatMap((taskSpaceId) =>
      db
        .prepare(`
        SELECT id, task_space_id, command_type, status, payload_json, error_text, updated_at
        FROM sync_task_command
        WHERE task_space_id = ? AND status IN ('pending', 'delivered', 'running', 'failed')
        ORDER BY created_at DESC
        LIMIT 10
      `)
        .all(taskSpaceId),
    )
    return {
      queryRevision: taskSpaceIndex.queryRevision(),
      queryDay: shanghaiDay(),
      assignments: { pending: pendingAssignments },
      boardVersions: Object.fromEntries(
        projects.flatMap((project) =>
          (project.taskSpaces || []).map((space) => [
            space.id,
            `${space.revision}:${space.indexedRevision}`,
          ]),
        ),
      ),
      projects: projects.map((project) => ({
        ...project,
        agents: summaries.get(project.id) || {
          total: 0,
          pending: 0,
          approved: 0,
          online: 0,
        },
      })),
      operations: operations.map((row) => ({
        id: row.id,
        taskSpaceId: row.task_space_id,
        commandType: row.command_type,
        status: row.status,
        payload: parseJson(row.payload_json, {}),
        error: row.error_text || null,
        updatedAt: row.updated_at,
      })),
      associationProjects: projects,
      serverTime: new Date().toISOString(),
    }
  }

  function resolveTask(actor, input = {}, capability = 'write') {
    const taskSpaceId = taskSpaceIdFromInput(input)
    if (!taskSpaceId) {
      throw teamError(400, ERROR_CODES.INVALID_INPUT, '任务操作必须指定 taskSpaceId')
    }
    taskSpaces.authorizeTaskSpace(actor, taskSpaceId, capability)
    const executionTaskKey = String(input.executionTaskKey || input.taskKey || '').trim()
    const taskKey = String(input.taskKey || '').trim()
    const taskPath = String(input.taskPath || input.relativeDir || '').trim()
    let indexed = null
    if (executionTaskKey) {
      const rows = db
        .prepare(`
        SELECT *
        FROM sync_task_index
        WHERE task_space_id = ? AND execution_task_key = ?
        ORDER BY task_key
        LIMIT 2
      `)
        .all(taskSpaceId, executionTaskKey)
      if (rows.length > 1) {
        throw teamError(409, ERROR_CODES.CONFLICT, '任务执行身份冲突，请修正 task.json id')
      }
      indexed = rows[0] || null
    } else if (taskKey) {
      indexed = db
        .prepare('SELECT * FROM sync_task_index WHERE task_space_id = ? AND task_key = ?')
        .get(taskSpaceId, taskKey)
    } else if (taskPath) {
      const rows = db
        .prepare(`
        SELECT *
        FROM sync_task_index
        WHERE task_space_id = ? AND relative_dir = ?
        LIMIT 2
      `)
        .all(taskSpaceId, taskPath)
      if (rows.length > 1) {
        throw teamError(409, ERROR_CODES.CONFLICT, '任务路径身份冲突，请刷新任务空间')
      }
      indexed = rows[0] || null
    }
    if (!indexed) throw teamError(404, ERROR_CODES.NOT_FOUND, '任务不存在')
    return { taskSpaceId, indexed }
  }

  function requireMutableTask(task) {
    if (task.archived) {
      throw teamError(409, ERROR_CODES.CONFLICT, '归档任务只读，不能修改执行数据')
    }
    if (task.executionIdentityValid === false || task.executionIdentityConflict) {
      throw teamError(409, ERROR_CODES.CONFLICT, '任务执行身份冲突，请修正 task.json id')
    }
  }

  async function materializedTask(actor, input, capability = 'view') {
    const context = resolveTask(actor, input, capability)
    const materialized = await taskSpaceIndex.ensureMaterialized(context.taskSpaceId)
    if (!materialized) throw teamError(503, ERROR_CODES.CONFLICT, '任务空间尚未完成索引')
    const task = materialized.detailTasks.find(
      (item) =>
        item.taskKey === context.indexed.task_key ||
        item.executionTaskKey === context.indexed.execution_task_key ||
        item.relativeDir === context.indexed.relative_dir,
    )
    if (!task) throw teamError(404, ERROR_CODES.NOT_FOUND, '任务不存在')
    return { ...context, materialized, task }
  }

  function getBoard(actor, input = {}) {
    const taskSpaceId = requiredText(input.taskSpaceId, '任务空间 ID', 128)
    const context = taskSpaces.authorizeTaskSpace(actor, taskSpaceId, 'view')
    const page = taskSpaceIndex.queryTasks(actor, { ...input, taskSpaceId })
    const cached = taskSpaceIndex.readTaskSpaceCache(taskSpaceId)
    const preferenceTeamId = resolveTeamScope(
      db,
      actor,
      input.teamId || context.project.owner_team_id,
    )
    const savedViews = executionStore.listSavedViews(actor.userId, preferenceTeamId || null)
    const projected = cached?.board
      ? projectBoardExecution(cached.board, savedViews, db, new Date(), {
          executionWipLimit: readWipLimit(actor, preferenceTeamId),
        })
      : null
    const cachedByKey = new Map((projected?.tasks || []).map((task) => [task.taskKey, task]))
    const tasks = page.tasks.map((task) => ({
      ...(cachedByKey.get(task.taskKey) || task),
      taskSpaceId,
      branchName: context.taskSpace.branch_name,
    }))
    const project = listProjects(actor).find((item) => item.id === context.project.id) || {
      id: context.project.id,
      name: context.project.name,
      teamId: context.project.owner_team_id,
    }
    const board = {
      ...(projected || cached?.board || {}),
      savedViews,
      executionWipLimit: readWipLimit(actor, preferenceTeamId),
      generatedAt: cached?.savedAt || new Date().toISOString(),
      projects: [
        {
          ...project,
          taskSpaceId,
          branchName: context.taskSpace.branch_name,
          revision: Number(context.taskSpace.revision),
          indexedRevision: Number(context.taskSpace.indexed_revision),
          taskCount: page.total,
          activeCount: page.tasks.filter((task) => !task.archived).length,
        },
      ],
      tasks,
    }
    return {
      board,
      tasks,
      total: page.total,
      nextCursor: page.nextCursor,
      etag: page.etag,
      queryRevision: page.queryRevision,
      queryDay: page.queryDay,
    }
  }

  async function getTask(actor, input = {}) {
    const context = await materializedTask(actor, input, 'view')
    const detail = projectTaskDetailExecution(
      {
        ...context.task,
        taskVersion: context.indexed.task_version,
        executionTaskKey: context.indexed.execution_task_key,
      },
      db,
      new Date(),
      200,
      {
        boardTasks: context.materialized.board.tasks || [],
        executionWipLimit: readWipLimit(actor, context.materialized.board.projects?.[0]?.teamId),
        actorUserId: actor.userId,
      },
    )
    const space = taskSpaces.readTaskSpace(context.taskSpaceId, actor)
    return {
      task: {
        ...detail,
        projectId: space.project.id,
        projectName: space.project.name,
        taskSpaceId: context.taskSpaceId,
        branchName: space.branch_name,
        teamId: space.project.owner_team_id,
        teamName: space.project.owner_team_name || null,
        projectSyncStatus:
          Number(space.indexed_revision) === Number(space.revision) ? 'current' : 'stale',
        stale: Number(space.indexed_revision) !== Number(space.revision),
        assignment: publicAssignment(
          db
            .prepare('SELECT * FROM sync_task_assignment WHERE execution_task_key = ?')
            .get(context.indexed.execution_task_key),
        ),
      },
    }
  }

  function auditTaskWrite(actor, projectId, taskSpaceId, action, executionTaskKey, detail) {
    appendAuditEvent(db, {
      actorUserId: actor.userId,
      projectId,
      action,
      targetType: 'task',
      targetId: executionTaskKey,
      correlationId: crypto.randomUUID(),
      detail: { ...detail, taskSpaceId },
    })
  }

  function assertAssigneeConfirmation(actor, context, task, input) {
    const timestamp = Date.now()
    for (const [id, warning] of assigneeWarnings) {
      if (warning.expiresAt <= timestamp) assigneeWarnings.delete(id)
    }
    const row = db
      .prepare(`
      SELECT t.assignee_user_id, t.assignee_dev_id, m.trellis_dev_id AS actor_dev_id
      FROM sync_task_index t
      LEFT JOIN sync_project_member m
        ON m.project_id = t.project_id AND m.user_id = ?
      WHERE t.task_space_id = ? AND t.task_key = ?
    `)
      .get(actor.userId, context.taskSpaceId, context.indexed.task_key)
    if (!row || (!row.assignee_user_id && !row.assignee_dev_id)) return null
    const sameUser = row.assignee_user_id === actor.userId
    const sameDeveloper =
      row.assignee_dev_id &&
      row.actor_dev_id &&
      row.assignee_dev_id.toLowerCase() === row.actor_dev_id.toLowerCase()
    if (sameUser || sameDeveloper) return null
    const decision = input.assigneeDecision
    if (decision?.action === 'continue' || decision?.action === 'takeover') {
      const warning = assigneeWarnings.get(String(decision.warningId || ''))
      if (
        warning &&
        warning.expiresAt > timestamp &&
        warning.actorUserId === actor.userId &&
        warning.taskKey === context.indexed.task_key &&
        warning.taskVersion === context.indexed.task_version
      ) {
        assigneeWarnings.delete(String(decision.warningId))
        return { action: decision.action }
      }
    }
    const warningId = crypto.randomUUID()
    const expiresAt = Date.now() + 5 * 60 * 1000
    assigneeWarnings.set(warningId, {
      warningId,
      actorUserId: actor.userId,
      taskKey: context.indexed.task_key,
      taskVersion: context.indexed.task_version,
      expiresAt,
    })
    const assignee = row.assignee_user_id
      ? db
          .prepare('SELECT username, display_name FROM user_account WHERE id = ?')
          .get(row.assignee_user_id)
      : null
    throw teamError(409, 'ASSIGNEE_CONFIRMATION_REQUIRED', '修改他人负责的任务前需要确认', {
      recoverable: true,
      details: {
        warningId,
        expiresAt: new Date(expiresAt).toISOString(),
        assignee: {
          userId: row.assignee_user_id || null,
          username: assignee?.username || null,
          displayName: assignee?.display_name || row.assignee_dev_id || null,
        },
        actorAssignee: row.actor_dev_id || null,
        task: {
          taskKey: context.indexed.task_key,
          executionTaskKey: context.indexed.execution_task_key,
          title: task.title,
        },
      },
    })
  }

  async function refreshTaskSpace(taskSpaceId) {
    await taskSpaceIndex.ensureMaterialized(taskSpaceId)
  }

  async function updatePlan(actor, input = {}) {
    const context = await materializedTask(actor, input, 'write')
    requireMutableTask(context.task)
    assertAssigneeConfirmation(actor, context, context.task, input)
    const result = userError(() =>
      executionStore.updatePlan(
        context.indexed.execution_task_key,
        input,
        actor.user.username,
        actor.userId,
      ),
    )
    if (result.changed) {
      auditTaskWrite(
        actor,
        context.indexed.project_id,
        context.taskSpaceId,
        'task_plan_updated',
        context.indexed.execution_task_key,
        { plan: result.plan },
      )
      await refreshTaskSpace(context.taskSpaceId)
    }
    return {
      message: result.changed ? '计划字段已保存' : '计划字段没有变化',
      ...result,
    }
  }

  async function setStage(actor, input = {}) {
    const context = await materializedTask(actor, input, 'write')
    requireMutableTask(context.task)
    assertAssigneeConfirmation(actor, context, context.task, input)
    const stage = userError(() =>
      setManualStage(context.taskSpaceId, context.indexed.relative_dir, input.stage, db, {
        executionTaskKey: context.indexed.execution_task_key,
        actor: actor.user.username,
        actorUserId: actor.userId,
      }),
    )
    auditTaskWrite(
      actor,
      context.indexed.project_id,
      context.taskSpaceId,
      'task_stage_updated',
      context.indexed.execution_task_key,
      { stage: stage.stage },
    )
    await refreshTaskSpace(context.taskSpaceId)
    return { message: '流程检查点已记录', stage }
  }

  function taskLabels(tasks) {
    return Object.fromEntries(tasks.map((task) => [task.executionTaskKey, task.title]))
  }

  async function createDependency(actor, input = {}) {
    const blocked = await materializedTask(actor, input.blocked, 'write')
    const blocker = await materializedTask(actor, input.blocker, 'view')
    if (blocked.taskSpaceId !== blocker.taskSpaceId) {
      throw teamError(400, ERROR_CODES.INVALID_INPUT, '依赖双方必须位于同一任务空间')
    }
    requireMutableTask(blocked.task)
    requireMutableTask(blocker.task)
    assertAssigneeConfirmation(actor, blocked, blocked.task, input)
    const dependency = userError(() =>
      executionStore.createDependency(
        {
          blockerTaskKey: blocker.indexed.execution_task_key,
          blockedTaskKey: blocked.indexed.execution_task_key,
          reason: input.reason,
          blockerLabel: blocker.task.title,
          blockedLabel: blocked.task.title,
          taskLabels: taskLabels([blocked.task, blocker.task]),
        },
        actor.user.username,
        actor.userId,
      ),
    )
    auditTaskWrite(
      actor,
      blocked.indexed.project_id,
      blocked.taskSpaceId,
      'dependency_created',
      blocked.indexed.execution_task_key,
      {
        dependencyId: dependency.id,
        blockerTaskKey: blocker.indexed.execution_task_key,
      },
    )
    await refreshTaskSpace(blocked.taskSpaceId)
    return {
      message: '阻断依赖已创建',
      dependency: {
        ...dependency,
        blocker: {
          taskKey: blocker.indexed.task_key,
          executionTaskKey: blocker.indexed.execution_task_key,
          title: blocker.task.title,
        },
        blocked: {
          taskKey: blocked.indexed.task_key,
          executionTaskKey: blocked.indexed.execution_task_key,
          title: blocked.task.title,
        },
      },
    }
  }

  async function resolveDependency(actor, input = {}) {
    const dependencyId = requiredText(input.id, '依赖 ID', 128)
    const row = db
      .prepare(`
      SELECT blocker_task_key, blocked_task_key, resolved_at
      FROM task_dependency
      WHERE id = ?
    `)
      .get(dependencyId)
    if (!row) throw teamError(404, ERROR_CODES.NOT_FOUND, '依赖不存在')
    if (row.resolved_at) throw teamError(409, ERROR_CODES.CONFLICT, '这条依赖已经解除')
    const blocked = await materializedTask(
      actor,
      { executionTaskKey: row.blocked_task_key },
      'write',
    )
    const blocker = await materializedTask(
      actor,
      { executionTaskKey: row.blocker_task_key },
      'view',
    )
    requireMutableTask(blocked.task)
    requireMutableTask(blocker.task)
    assertAssigneeConfirmation(actor, blocked, blocked.task, input)
    const dependency = userError(() =>
      executionStore.resolveDependency(dependencyId, actor.user.username, actor.userId),
    )
    auditTaskWrite(
      actor,
      blocked.indexed.project_id,
      blocked.taskSpaceId,
      'dependency_resolved',
      blocked.indexed.execution_task_key,
      { dependencyId, blockerTaskKey: row.blocker_task_key },
    )
    await refreshTaskSpace(blocked.taskSpaceId)
    return { message: '阻断依赖已解除', dependency }
  }

  async function undo(actor, input = {}) {
    const context = await materializedTask(actor, input, 'write')
    requireMutableTask(context.task)
    assertAssigneeConfirmation(actor, context, context.task, input)
    const undone = userError(() =>
      undoLastOperation({
        db,
        executionTaskKey: context.indexed.execution_task_key,
        projectId: context.indexed.project_id,
        taskPath: context.indexed.relative_dir,
        task: context.task,
        actor: actor.user.username,
        actorUserId: actor.userId,
      }),
    )
    auditTaskWrite(
      actor,
      context.indexed.project_id,
      context.taskSpaceId,
      'task_operation_undone',
      context.indexed.execution_task_key,
      {
        targetCorrelationId: undone.targetCorrelationId,
        label: undone.label,
      },
    )
    await refreshTaskSpace(context.taskSpaceId)
    return { message: '最近操作已撤销', ...undone }
  }

  function listAssignments(actor, input = {}) {
    const state = input.state == null || input.state === '' ? null : String(input.state)
    if (state != null && !new Set(['pending', 'accepted']).has(state)) {
      throw teamError(400, ERROR_CODES.INVALID_INPUT, 'assignment state 无效')
    }
    const rows = db
      .prepare(`
      SELECT a.*, t.*, s.branch_name AS task_space_branch,
             p.name AS project_name, p.owner_team_id AS team_id, team.name AS team_name
      FROM sync_task_assignment a
      JOIN sync_task_index t
        ON t.task_space_id = a.task_space_id
        AND t.execution_task_key = a.execution_task_key
      JOIN sync_task_space s ON s.id = a.task_space_id
      JOIN sync_project p ON p.id = a.project_id
      JOIN team ON team.id = p.owner_team_id
      WHERE a.assigned_user_id = ?
        AND (? IS NULL OR a.state = ?)
        AND t.archived = 0
      ORDER BY CASE a.state WHEN 'pending' THEN 0 ELSE 1 END, a.assigned_at DESC
      LIMIT 200
    `)
      .all(actor.userId, state, state)
      .filter((row) => taskSpaces.readTaskSpace(row.task_space_id, actor))
    return {
      assignments: rows.map((row) => ({
        taskKey: row.task_key,
        executionTaskKey: row.execution_task_key,
        taskVersion: row.task_version,
        projectId: row.project_id,
        projectName: row.project_name,
        taskSpaceId: row.task_space_id,
        branchName: row.task_space_branch,
        teamId: row.team_id || null,
        teamName: row.team_name,
        relativeDir: row.relative_dir,
        title: row.title,
        priority: row.priority,
        derivedStage: row.derived_stage,
        assignee: row.assignee_dev_id || null,
        assigneeUserId: row.assignee_user_id || null,
        dueDate: row.due_date || null,
        lastActivityAt: row.last_activity_at || row.updated_at,
        archived: false,
        assignment: publicAssignment(row),
        assignmentVersion: Number(row.version),
        state: row.state,
        acceptedAt: row.accepted_at || null,
      })),
    }
  }

  function accept(actor, input = {}) {
    const executionTaskKey = requiredText(input.executionTaskKey, '任务身份', 500)
    const row = db
      .prepare('SELECT * FROM sync_task_assignment WHERE execution_task_key = ?')
      .get(executionTaskKey)
    if (!row) throw teamError(404, ERROR_CODES.NOT_FOUND, '任务分派不存在')
    if (row.assigned_user_id !== actor.userId) {
      throw teamError(403, ERROR_CODES.FORBIDDEN, '只能接受分派给自己的任务')
    }
    taskSpaces.authorizeTaskSpace(actor, row.task_space_id, 'view')
    if (row.state !== 'accepted') {
      db.prepare(`
        UPDATE sync_task_assignment
        SET state = 'accepted', accepted_at = ?, version = version + 1
        WHERE execution_task_key = ?
      `).run(new Date().toISOString(), executionTaskKey)
    }
    const updated = db
      .prepare('SELECT * FROM sync_task_assignment WHERE execution_task_key = ?')
      .get(executionTaskKey)
    return {
      message: '任务已接受',
      assignment: { ...publicAssignment(updated), assignmentVersion: Number(updated.version) },
    }
  }

  function listSavedViews(actor, input = {}) {
    const scope = resolveTeamScope(db, actor, input.teamId)
    return executionStore.listSavedViews(actor.userId, scope || null)
  }

  function createSavedView(actor, input = {}) {
    const scope = resolveTeamScope(db, actor, input.teamId)
    const view = userError(() => executionStore.createSavedView(input, actor.userId, scope || null))
    return { message: '组合视图已保存', view }
  }

  function updateSavedView(actor, input = {}) {
    const scope = resolveTeamScope(db, actor, input.teamId)
    const view = userError(() => executionStore.updateSavedView(input, actor.userId, scope || null))
    return { message: '组合视图已更新', view }
  }

  function deleteSavedView(actor, input = {}) {
    const scope = resolveTeamScope(db, actor, input.teamId)
    const view = userError(() =>
      executionStore.deleteSavedView(input.id, actor.userId, scope || null),
    )
    return { message: '组合视图已删除', view }
  }

  function updateWipLimit(actor, input = {}) {
    const value = writeWipLimit(actor, Number(input.executionWipLimit), input.teamId)
    return { message: '实现中 WIP 软上限已保存', executionWipLimit: value }
  }

  function readSettings(actor, input = {}) {
    const scope = resolveTeamScope(db, actor, input.teamId)
    return {
      teamId: scope,
      executionWipLimit: readWipLimit(actor, scope),
    }
  }

  function assigneeCandidates(actor, taskSpaceId) {
    const space = taskSpaces.authorizeTaskSpace(actor, taskSpaceId, 'view')
    return db
      .prepare(`
      SELECT m.user_id, m.role, m.trellis_dev_id, u.username, u.display_name
      FROM sync_project_member m
      JOIN user_account u ON u.id = m.user_id
      WHERE m.project_id = ? AND m.role IN ('lead', 'member') AND u.status = 'active'
      ORDER BY u.display_name COLLATE NOCASE, u.username COLLATE NOCASE
    `)
      .all(space.project.id)
      .filter((row) => ASSIGNABLE_ROLES.has(row.role))
      .map((row) => ({
        userId: row.user_id,
        username: row.username,
        displayName: row.display_name,
        role: row.role,
        trellisDevId: row.trellis_dev_id,
        online: agents?.onlineAgentForTaskSpace(taskSpaceId, row.user_id).length === 1,
      }))
  }

  return {
    listProjects,
    status,
    getBoard,
    getTask,
    updatePlan,
    setStage,
    createDependency,
    resolveDependency,
    undo,
    listAssignments,
    accept,
    listSavedViews,
    createSavedView,
    updateSavedView,
    deleteSavedView,
    readSettings,
    updateWipLimit,
    assigneeCandidates,
    refreshTaskSpace,
  }
}
