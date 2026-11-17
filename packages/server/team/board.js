import crypto from 'node:crypto'
import { projectBoardExecution, projectTaskDetailExecution } from '../execution-projection.js'
import { undoLastOperation } from '../execution-history.js'
import { createExecutionStore } from '../execution-store.js'
import { setManualStage, STAGE_IDS } from '../metadata.js'
import { resolveTaskLocation } from '../task-location.js'
import { acceptAssignment, readAssignment } from './assignments.js'
import { appendAuditEvent } from './audit.js'
import { ERROR_CODES, teamError } from './errors.js'
import {
  CAPABILITIES,
  authorizeExecutionTask,
  authorizeProject,
  readableProjectIds,
} from './permissions.js'
import { resolveTeamScope } from './teams.js'

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

function publicAssignment(row) {
  if (!row) return null
  return {
    executionTaskKey: row.execution_task_key,
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

function indexRow(row) {
  let attentionReasons = []
  try {
    const parsed = JSON.parse(row.attention_flags_json)
    if (Array.isArray(parsed)) attentionReasons = parsed.map(String)
  } catch {
    // 损坏的关注摘要不影响任务主体。
  }
  return {
    taskKey: row.task_key,
    executionTaskKey: row.execution_task_key,
    taskVersion: row.task_version,
    projectId: row.project_id,
    projectName: row.project_name,
    teamId: row.team_id || null,
    teamName: row.team_name || null,
    relativeDir: row.relative_dir,
    title: row.title,
    priority: row.priority,
    derivedStage: row.derived_stage,
    archived: Boolean(row.archived),
    assignee: row.assignee_dev_id || null,
    assigneeDevId: row.assignee_dev_id || null,
    assigneeUserId: row.assignee_user_id || null,
    dueDate: row.due_date || null,
    lastActivityAt: row.last_activity_at || row.updated_at,
    isBlocked: Boolean(row.is_blocked),
    isUnblockedReady: Boolean(row.is_unblocked_ready),
    attentionReasons,
    groupKey: row.group_key,
    groupRole: row.group_role,
    projectSyncStatus: row.sync_status,
    stale: row.sync_status !== 'current',
    syncError: row.last_error || null,
  }
}

function assignmentMap(db, executionTaskKeys) {
  if (!executionTaskKeys.length) return new Map()
  const placeholders = executionTaskKeys.map(() => '?').join(', ')
  return new Map(
    db
      .prepare(`
    SELECT *
    FROM task_assignment
    WHERE execution_task_key IN (${placeholders})
  `)
      .all(...executionTaskKeys)
      .map((row) => [row.execution_task_key, publicAssignment(row)]),
  )
}

export function createBoardService({
  db,
  taskIndex,
  projectService,
  liveSync = null,
  executionWipLimit = 2,
}) {
  const executionStore = createExecutionStore({
    db,
    stageIds: STAGE_IDS,
  })
  let statusAgentCache = null
  const assigneeWarnings = new Map()

  function parseUserState(value, fallback) {
    try {
      return JSON.parse(value)
    } catch {
      return fallback
    }
  }

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
    const value = parseUserState(row?.value_json, null)
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

  function requireMutableTask(task) {
    if (task.archived) {
      throw teamError(409, ERROR_CODES.CONFLICT, '归档任务只读，不能修改执行数据')
    }
    if (task.executionIdentityValid === false || task.executionIdentityConflict) {
      throw teamError(409, ERROR_CODES.CONFLICT, '任务执行身份冲突，请修正 task.json id')
    }
  }

  function projectRepository(project) {
    return {
      id: project.repository_id,
      name: project.repository_name,
      path: project.repository_path,
    }
  }

  function resolveTask(actor, input = {}, capability = CAPABILITIES.WRITE_TASK) {
    const identity = taskIdentity(input)
    const indexed = identity.executionTaskKey
      ? db
          .prepare(`
          SELECT *
          FROM team_task_index
          WHERE project_id = ? AND execution_task_key = ?
        `)
          .get(identity.projectId, identity.executionTaskKey)
      : input.taskPath
        ? db
            .prepare(`
            SELECT *
            FROM team_task_index
            WHERE project_id = ? AND relative_dir = ?
          `)
            .get(identity.projectId, String(input.taskPath))
        : null
    if (!indexed) throw teamError(404, ERROR_CODES.NOT_FOUND, '任务不存在')
    const access = authorizeExecutionTask(actor, indexed.execution_task_key, capability, { db })
    const project = projectService.read(identity.projectId)
    if (!project) throw teamError(404, ERROR_CODES.NOT_FOUND, '项目不存在')
    const liveBoard =
      Number(indexed.live_revision || 0) > 0
        ? liveSync?.ensureProject(identity.projectId) || null
        : null
    const liveTask = liveBoard
      ? liveSync.findTask(identity.projectId, indexed.task_key, indexed.execution_task_key)
      : null
    if (liveTask) {
      return {
        task: liveTask,
        access,
        cached: { board: liveBoard },
        project,
        indexed,
      }
    }
    const cached = readCachedProject(identity.projectId)
    let resolved
    try {
      resolved = resolveTaskLocation(
        {
          projectId: identity.projectId,
          taskPath: indexed.relative_dir,
        },
        {
          repositories: [projectRepository(project)],
          currentBoard: cached?.board || null,
          db,
        },
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message === '未找到任务') {
        throw teamError(404, ERROR_CODES.NOT_FOUND, message)
      }
      throw teamError(409, ERROR_CODES.CONFLICT, message)
    }
    if (
      resolved.task.executionTaskKey !== indexed.execution_task_key ||
      resolved.identityConflict
    ) {
      throw teamError(409, ERROR_CODES.CONFLICT, '任务文件身份已变化，必须等待项目同步刷新后重试')
    }
    return {
      ...resolved,
      access,
      cached,
      indexed,
    }
  }

  function auditTaskWrite(actor, projectId, action, executionTaskKey, detail, correlationId) {
    appendAuditEvent(db, {
      actorUserId: actor.userId,
      projectId,
      action,
      targetType: 'task',
      targetId: executionTaskKey,
      correlationId: correlationId || crypto.randomUUID(),
      detail,
    })
  }

  function assertAssigneeConfirmation(actor, context, input) {
    const timestamp = Date.now()
    for (const [id, warning] of assigneeWarnings) {
      if (warning.expiresAt <= timestamp) assigneeWarnings.delete(id)
    }
    const row = db
      .prepare(`
      SELECT
        t.assignee_user_id, t.assignee_dev_id,
        m.trellis_dev_id AS actor_dev_id
      FROM team_task_index t
      LEFT JOIN project_member m
        ON m.project_id = t.project_id AND m.user_id = ?
      WHERE t.project_id = ? AND t.task_key = ?
    `)
      .get(actor.userId, context.indexed.project_id, context.indexed.task_key)
    if (!row || (!row.assignee_user_id && !row.assignee_dev_id)) return
    const sameUser = row.assignee_user_id === actor.userId
    const sameDeveloper =
      row.assignee_dev_id &&
      row.actor_dev_id &&
      row.assignee_dev_id.toLowerCase() === row.actor_dev_id.toLowerCase()
    if (sameUser || sameDeveloper) return
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
        if (decision.action === 'takeover') {
          if (!row.actor_dev_id) {
            throw teamError(403, ERROR_CODES.FORBIDDEN, '当前账号尚未映射 Trellis developer ID')
          }
          liveSync.takeoverTask({
            projectId: context.indexed.project_id,
            taskKey: context.indexed.task_key,
            actorUserId: actor.userId,
            actorDevId: row.actor_dev_id,
          })
          auditTaskWrite(
            actor,
            context.indexed.project_id,
            'task_assignee_confirmation_takeover',
            context.indexed.execution_task_key,
            {
              previousAssigneeUserId: row.assignee_user_id,
              action: 'takeover',
              assigneeDevId: row.actor_dev_id,
            },
          )
          return { action: 'takeover' }
        }
        return {
          action: 'continue',
          assigneeUserId: row.assignee_user_id,
        }
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
          .prepare(`
          SELECT username, display_name
          FROM user_account
          WHERE id = ?
        `)
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
          title: context.task.title,
        },
      },
    })
  }

  function completeAssigneeConfirmation(actor, context, confirmation) {
    if (confirmation?.action !== 'continue') return
    auditTaskWrite(
      actor,
      context.indexed.project_id,
      'task_assignee_confirmation_continued',
      context.indexed.execution_task_key,
      {
        assigneeUserId: confirmation.assigneeUserId,
        action: 'continue',
      },
    )
    liveSync?.notifyAssigneeOverride({
      projectId: context.indexed.project_id,
      taskKey: context.indexed.task_key,
      assigneeUserId: confirmation.assigneeUserId,
      action: 'continue',
      notificationId: `task.live.overridden:${context.indexed.task_key}:${crypto.randomUUID()}`,
    })
  }

  function refreshProjectProjection(projectId, actor) {
    const cached = readCachedProject(projectId)
    if (!cached?.board) return
    const project = db
      .prepare(`
      SELECT team_id FROM team_project WHERE repository_id = ?
    `)
      .get(projectId)
    const board = projectBoardExecution(
      {
        ...cached.board,
        tasks: cached.board.tasks || [],
      },
      [],
      db,
      new Date(),
      { executionWipLimit: readWipLimit(actor, project?.team_id || null) },
    )
    taskIndex.refreshProjectIndexFromDatabase({
      projectId,
      board,
      boardVersion: cached.contentKey || cached.boardVersion || projectId,
      persistCache: true,
    })
  }

  function refreshProjectsForKeys(keys, actor) {
    const projectIds = new Set(
      keys.map((key) => String(key || '').split('::', 1)[0]).filter(Boolean),
    )
    projectIds.forEach((projectId) => {
      try {
        refreshProjectProjection(projectId, actor)
      } catch {
        // 非当前项目的数据刷新失败不回滚已经提交的扩展数据。
      }
    })
  }

  function listProjects(actor) {
    return projectService.listReadable(actor)
  }

  function listStatusProjects(actor) {
    return projectService.listStatusReadable(actor)
  }

  function listAssociationProjects(actor) {
    return projectService.listAssociationCandidates(actor)
  }

  function projectAgentSummaries(projectIds, onlineSince) {
    if (!projectIds.length) return new Map()
    const cacheKey = projectIds.join('\0')
    if (
      statusAgentCache &&
      statusAgentCache.expiresAt > Date.now() &&
      statusAgentCache.key === cacheKey &&
      statusAgentCache.onlineSince === onlineSince
    ) {
      return statusAgentCache.value
    }
    const placeholders = projectIds.map(() => '?').join(', ')
    const rows = db
      .prepare(`
      SELECT
        b.project_id,
        COUNT(*) AS total,
        SUM(CASE WHEN b.sync_status = 'pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN b.sync_status = 'approved' THEN 1 ELSE 0 END) AS approved,
        SUM(CASE WHEN a.last_seen_at >= ? THEN 1 ELSE 0 END) AS online
      FROM agent_project_binding b
      JOIN agent_device a ON a.id = b.agent_id
      WHERE b.project_id IN (${placeholders}) AND a.status = 'active'
      GROUP BY b.project_id
    `)
      .all(onlineSince, ...projectIds)
    const summaries = new Map(
      rows.map((row) => [
        row.project_id,
        {
          total: Number(row.total || 0),
          pending: Number(row.pending || 0),
          approved: Number(row.approved || 0),
          online: Number(row.online || 0),
        },
      ]),
    )
    statusAgentCache = {
      key: cacheKey,
      onlineSince,
      expiresAt: Date.now() + 1000,
      value: summaries,
    }
    return summaries
  }

  function status(actor, { staleMs = 60_000 } = {}) {
    const projects = listStatusProjects(actor)
    const now = Date.now()
    const agentSummaries = projectAgentSummaries(
      projects.map((project) => project.id),
      new Date(Math.floor((now - staleMs) / 1000) * 1000).toISOString(),
    )
    const projectIds = new Set(projects.map((project) => project.id))
    const pendingAssignments = db
      .prepare(`
      SELECT project_id
      FROM task_assignment
      WHERE assigned_user_id = ? AND state = 'pending'
    `)
      .all(actor.userId)
      .filter((row) => projectIds.has(row.project_id)).length
    return {
      queryRevision: taskIndex.queryRevision(),
      queryDay: shanghaiDay(),
      assignments: { pending: pendingAssignments },
      boardVersions: Object.fromEntries(
        projects.map((project) => [project.id, project.boardVersion || null]),
      ),
      projects: projects.map((project) => ({
        id: project.id,
        teamId: project.teamId || null,
        teamName: project.teamName || null,
        name: project.name,
        syncStatus: project.syncStatus,
        syncBranch: project.syncBranch,
        role: project.role,
        boardVersion: project.boardVersion || null,
        stale: project.stale,
        lastError: project.lastError || null,
        agents: agentSummaries.get(project.id) || {
          total: 0,
          pending: 0,
          approved: 0,
          online: 0,
        },
      })),
      associationProjects: listAssociationProjects(actor),
      serverTime: new Date().toISOString(),
    }
  }

  function readCachedProject(projectId) {
    return taskIndex.readProjectScanCache(projectId)
  }

  function getBoard(actor, projectId, input = {}) {
    const id = String(projectId || '').trim()
    if (!id) {
      throw teamError(400, ERROR_CODES.INVALID_INPUT, '/api/board 必须指定 projectId')
    }
    const access = authorizeProject(actor, id, CAPABILITIES.VIEW, { db })
    const page = taskIndex.queryTasks(actor, [id], {
      ...input,
      projectIds: [id],
    })
    const cached = readCachedProject(id)
    const liveBoard = liveSync?.ensureProject(id) || null
    const preferenceTeamId = resolveTeamScope(db, actor, input.teamId || access.team_id)
    if (preferenceTeamId && preferenceTeamId !== access.team_id) {
      throw teamError(400, ERROR_CODES.INVALID_INPUT, '团队筛选与项目所属团队不一致')
    }
    const executionWipLimitForUser = readWipLimit(actor, preferenceTeamId)
    const savedViews = executionStore.listSavedViews(actor.userId, preferenceTeamId || null)
    const projected =
      liveBoard || cached?.board
        ? projectBoardExecution(
            {
              ...(liveBoard || cached.board),
              tasks: (liveBoard || cached.board).tasks || [],
            },
            savedViews,
            db,
            new Date(),
            { executionWipLimit: executionWipLimitForUser },
          )
        : null
    const cachedByKey = new Map((projected?.tasks || []).map((task) => [task.taskKey, task]))
    const assignments = assignmentMap(
      db,
      page.tasks.map((task) => task.executionTaskKey),
    )
    const tasks = page.tasks.map((task) => {
      const detail = cachedByKey.get(task.taskKey) || task
      return {
        ...detail,
        teamId: task.teamId,
        teamName: task.teamName,
        assignment: assignments.get(task.executionTaskKey) || null,
      }
    })
    const project = listProjects(actor).find((item) => item.id === id) || {
      id,
      teamId: access.team_id,
      teamName: access.team_name,
      syncStatus: access.sync_status,
      syncBranch: access.sync_branch,
      role: access.role,
    }
    const board = {
      ...(projected || cached?.board || {}),
      savedViews,
      executionWipLimit: executionWipLimitForUser,
      generatedAt: liveBoard?.generatedAt || cached?.savedAt || new Date().toISOString(),
      projects: [
        {
          ...project,
          taskCount: Number(
            db
              .prepare(`
          SELECT COUNT(*) AS count FROM team_task_index WHERE project_id = ?
        `)
              .get(id).count,
          ),
          activeCount: Number(
            db
              .prepare(`
          SELECT COUNT(*) AS count
          FROM team_task_index WHERE project_id = ? AND archived = 0
        `)
              .get(id).count,
          ),
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

  function taskIdentity(input = {}) {
    const executionTaskKey = String(input.executionTaskKey || input.taskKey || '').trim()
    const projectId = executionTaskKey.includes('::')
      ? executionTaskKey.slice(0, executionTaskKey.indexOf('::'))
      : String(input.projectId || '').trim()
    if (!projectId) {
      throw teamError(400, ERROR_CODES.INVALID_INPUT, '缺少任务项目身份')
    }
    return { executionTaskKey, projectId }
  }

  function getTask(actor, input = {}) {
    const context = resolveTask(actor, input, CAPABILITIES.VIEW)
    const executionTaskKey = context.indexed.execution_task_key
    const detail = projectTaskDetailExecution(
      {
        ...context.task,
        taskVersion: context.indexed.task_version,
        executionTaskKey,
      },
      db,
      new Date(),
      200,
      {
        boardTasks: context.cached?.board?.tasks || [],
        executionWipLimit: readWipLimit(actor, context.access.team_id),
        actorUserId: actor.userId,
      },
    )
    return {
      task: {
        ...detail,
        projectId: context.indexed.project_id,
        projectName: context.project.repository_name,
        teamId: context.project.team_id || null,
        teamName: context.project.team_name || null,
        projectSyncStatus: context.access.sync_status,
        stale: context.access.sync_status !== 'current',
        assignment: readAssignment(db, executionTaskKey),
      },
    }
  }

  function listAssignments(actor, input = {}) {
    const state = input.state == null || input.state === '' ? null : String(input.state)
    if (state != null && !new Set(['pending', 'accepted']).has(state)) {
      throw teamError(400, ERROR_CODES.INVALID_INPUT, 'assignment state 无效')
    }
    const projectIds = [...new Set(readableProjectIds(actor, { db }))]
    if (!projectIds.length) {
      return { assignments: [] }
    }
    const placeholders = projectIds.map(() => '?').join(', ')
    const rows = db
      .prepare(`
      SELECT
        a.*, t.*, p.sync_status AS project_sync_status,
        p.last_error AS project_error, p.team_id,
        team_info.name AS team_name, r.name AS project_name
      FROM task_assignment a
      JOIN team_task_index t
        ON t.project_id = a.project_id
        AND t.execution_task_key = a.execution_task_key
      JOIN team_project p ON p.repository_id = a.project_id
      JOIN team team_info ON team_info.id = p.team_id
      JOIN repositories r ON r.id = a.project_id
      WHERE a.assigned_user_id = ?
        AND (? IS NULL OR a.state = ?)
        AND t.archived = 0
        AND a.project_id IN (${placeholders})
      ORDER BY
        CASE a.state WHEN 'pending' THEN 0 ELSE 1 END,
        a.assigned_at DESC
      LIMIT 200
    `)
      .all(actor.userId, state, state, ...projectIds)
    return {
      assignments: rows.map((row) => ({
        ...indexRow({
          ...row,
          task_key: row.task_key,
          execution_task_key: row.execution_task_key,
          attention_flags_json: row.attention_flags_json,
          due_date: row.due_date,
          last_activity_at: row.last_activity_at,
          updated_at: row.updated_at,
          sync_status: row.project_sync_status,
          last_error: row.project_error,
        }),
        assignment: publicAssignment(row),
        assignmentVersion: Number(row.version),
        state: row.state,
        acceptedAt: row.accepted_at || null,
      })),
    }
  }

  function accept(actor, input = {}) {
    const result = acceptAssignment(db, actor, input)
    return {
      ...result,
      assignment: {
        ...result.assignment,
        assignmentVersion: result.assignment.version,
      },
    }
  }

  function updatePlan(actor, input = {}) {
    const context = resolveTask(actor, input, CAPABILITIES.WRITE_TASK)
    requireMutableTask(context.task)
    const confirmation = assertAssigneeConfirmation(actor, context, input)
    const result = userError(() =>
      executionStore.updatePlan(
        context.indexed.execution_task_key,
        input,
        actor.user.username,
        actor.userId,
      ),
    )
    if (result.changed) {
      completeAssigneeConfirmation(actor, context, confirmation)
      auditTaskWrite(
        actor,
        context.indexed.project_id,
        'task_plan_updated',
        context.indexed.execution_task_key,
        { plan: result.plan },
        result.correlationId,
      )
      refreshProjectsForKeys([context.indexed.execution_task_key], actor)
    }
    return {
      message: result.changed ? '计划字段已保存' : '计划字段没有变化',
      ...result,
    }
  }

  function setStage(actor, input = {}) {
    const context = resolveTask(actor, input, CAPABILITIES.WRITE_TASK)
    requireMutableTask(context.task)
    const confirmation = assertAssigneeConfirmation(actor, context, input)
    const stage = userError(() =>
      setManualStage(context.indexed.project_id, context.indexed.relative_dir, input.stage, db, {
        executionTaskKey: context.indexed.execution_task_key,
        actor: actor.user.username,
        actorUserId: actor.userId,
      }),
    )
    completeAssigneeConfirmation(actor, context, confirmation)
    auditTaskWrite(
      actor,
      context.indexed.project_id,
      'task_stage_updated',
      context.indexed.execution_task_key,
      { stage: stage.stage },
      stage.correlationId,
    )
    refreshProjectsForKeys([context.indexed.execution_task_key], actor)
    return { message: '流程检查点已记录', stage }
  }

  function dependencyTaskLabels(contexts) {
    return Object.fromEntries(
      contexts.flatMap((context) =>
        (context.cached?.board?.tasks || []).map((task) => [task.executionTaskKey, task.title]),
      ),
    )
  }

  function createDependency(actor, input = {}) {
    const blocked = resolveTask(actor, input.blocked, CAPABILITIES.WRITE_TASK)
    const blocker = resolveTask(actor, input.blocker, CAPABILITIES.VIEW)
    requireMutableTask(blocked.task)
    requireMutableTask(blocker.task)
    const confirmation = assertAssigneeConfirmation(actor, blocked, input)
    const dependency = userError(() =>
      executionStore.createDependency(
        {
          blockerTaskKey: blocker.indexed.execution_task_key,
          blockedTaskKey: blocked.indexed.execution_task_key,
          reason: input.reason,
          blockerLabel: blocker.task.title,
          blockedLabel: blocked.task.title,
          taskLabels: dependencyTaskLabels([blocked, blocker]),
        },
        actor.user.username,
        actor.userId,
      ),
    )
    completeAssigneeConfirmation(actor, blocked, confirmation)
    auditTaskWrite(
      actor,
      blocked.indexed.project_id,
      'dependency_created',
      blocked.indexed.execution_task_key,
      {
        dependencyId: dependency.id,
        blockerTaskKey: blocker.indexed.execution_task_key,
      },
      dependency.correlationId,
    )
    refreshProjectsForKeys(
      [blocker.indexed.execution_task_key, blocked.indexed.execution_task_key],
      actor,
    )
    return {
      message: '阻断依赖已创建',
      dependency: {
        ...dependency,
        blocker: {
          taskKey: blocker.task.taskKey,
          executionTaskKey: blocker.indexed.execution_task_key,
          title: blocker.task.title,
          projectName: blocker.project.repository_name,
        },
        blocked: {
          taskKey: blocked.task.taskKey,
          executionTaskKey: blocked.indexed.execution_task_key,
          title: blocked.task.title,
          projectName: blocked.project.repository_name,
        },
      },
    }
  }

  function resolveDependency(actor, input = {}) {
    const dependencyId = String(input.id || '').trim()
    if (!dependencyId) {
      throw teamError(400, ERROR_CODES.INVALID_INPUT, '缺少依赖 ID')
    }
    const row = db
      .prepare(`
      SELECT blocker_task_key, blocked_task_key, resolved_at
      FROM task_dependency
      WHERE id = ?
    `)
      .get(dependencyId)
    if (!row) throw teamError(404, ERROR_CODES.NOT_FOUND, '依赖不存在')
    const blocked = resolveTask(
      actor,
      {
        executionTaskKey: row.blocked_task_key,
      },
      CAPABILITIES.WRITE_TASK,
    )
    const blocker = resolveTask(
      actor,
      {
        executionTaskKey: row.blocker_task_key,
      },
      CAPABILITIES.VIEW,
    )
    if (row.resolved_at) {
      throw teamError(409, ERROR_CODES.CONFLICT, '这条依赖已经解除')
    }
    requireMutableTask(blocked.task)
    requireMutableTask(blocker.task)
    const confirmation = assertAssigneeConfirmation(actor, blocked, input)
    const dependency = userError(() =>
      executionStore.resolveDependency(dependencyId, actor.user.username, actor.userId),
    )
    completeAssigneeConfirmation(actor, blocked, confirmation)
    auditTaskWrite(
      actor,
      blocked.indexed.project_id,
      'dependency_resolved',
      blocked.indexed.execution_task_key,
      {
        dependencyId,
        blockerTaskKey: row.blocker_task_key,
      },
      dependency.correlationId,
    )
    refreshProjectsForKeys([row.blocker_task_key, row.blocked_task_key], actor)
    return { message: '阻断依赖已解除', dependency }
  }

  function undo(actor, input = {}) {
    const context = resolveTask(actor, input, CAPABILITIES.WRITE_TASK)
    requireMutableTask(context.task)
    const confirmation = assertAssigneeConfirmation(actor, context, input)
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
    completeAssigneeConfirmation(actor, context, confirmation)
    auditTaskWrite(
      actor,
      context.indexed.project_id,
      'task_operation_undone',
      context.indexed.execution_task_key,
      {
        targetCorrelationId: undone.targetCorrelationId,
        label: undone.label,
      },
      undone.correlationId,
    )
    const affectedKeys = [context.indexed.execution_task_key]
    ;(undone.restored || []).forEach((item) => {
      if (item.restored?.blockerTaskKey) affectedKeys.push(item.restored.blockerTaskKey)
      if (item.restored?.blockedTaskKey) affectedKeys.push(item.restored.blockedTaskKey)
    })
    refreshProjectsForKeys(affectedKeys, actor)
    return { message: '最近操作已撤销', ...undone }
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
    const executionWipLimitForUser = writeWipLimit(
      actor,
      Number(input.executionWipLimit),
      input.teamId,
    )
    return {
      message: '实现中 WIP 软上限已保存',
      executionWipLimit: executionWipLimitForUser,
    }
  }

  function readSettings(actor, input = {}) {
    const scope = resolveTeamScope(db, actor, input.teamId)
    return {
      teamId: scope,
      executionWipLimit: readWipLimit(actor, scope),
    }
  }

  return {
    listProjects,
    status,
    getBoard,
    getTask,
    listAssignments,
    accept,
    updatePlan,
    setStage,
    createDependency,
    resolveDependency,
    undo,
    listSavedViews,
    createSavedView,
    updateSavedView,
    deleteSavedView,
    readSettings,
    updateWipLimit,
  }
}
