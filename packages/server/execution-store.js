import crypto from 'node:crypto'
import { getDefaultDatabase, withTransaction } from './database.js'
import {
  chunk,
  isPlainObject,
  normalizeActor,
  normalizeTags,
  normalizeMilestone,
  normalizeDueDate,
  normalizeSavedViewFilter,
  normalizeDependencyReason,
  normalizeDependencyTaskKey,
  normalizeViewName,
  placeholders,
} from './execution-normalize.js'
import {
  findBlockedByPath,
  readPlan,
  readTaskDependencies,
  readExecutionDetail,
  rowToDependency,
  rowToSavedView,
  samePlan,
  readExecutionMap,
  readExecutionEvents,
  readExecutionEventsBatch,
} from './execution-reads.js'

export { isValidCalendarDate } from './execution-normalize.js'
export { normalizeSavedViewFilter, normalizeTags }
export {
  readExecutionDetail,
  readExecutionEvents,
  readExecutionEventsBatch,
  readExecutionMap,
  readTaskDependencies,
}

export function appendTaskEvent(
  db,
  {
    executionTaskKey,
    eventType,
    source,
    actor = null,
    actorUserId = null,
    correlationId,
    occurredAt = new Date().toISOString(),
    payload = {},
    reversible = false,
  },
) {
  const key = String(executionTaskKey || '').trim()
  const type = String(eventType || '').trim()
  const eventSource = String(source || '').trim()
  const operationId = String(correlationId || '').trim()
  const occurred = String(occurredAt || '').trim()
  if (!key || !type || !eventSource || !operationId || !occurred) {
    throw new Error('事件缺少必要字段')
  }
  const result = db
    .prepare(`
    INSERT INTO task_event(
      execution_task_key, event_type, source, actor, correlation_id,
      occurred_at, payload_json, reversible, actor_user_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
    .run(
      key,
      type,
      eventSource,
      normalizeActor(actor),
      operationId,
      occurred,
      JSON.stringify(payload),
      reversible ? 1 : 0,
      normalizeActor(actorUserId),
    )
  return Number(result.lastInsertRowid)
}

export function purgeProjectExecutionData(db, projectId) {
  const prefix = `${String(projectId || '').trim()}::`
  if (prefix === '::') throw new Error('缺少项目 ID')
  for (const table of ['task_event', 'task_tag', 'task_execution']) {
    db.prepare(`
      DELETE FROM ${table}
      WHERE substr(execution_task_key, 1, ?) = ?
    `).run(prefix.length, prefix)
  }
  db.prepare(`
    DELETE FROM task_dependency
    WHERE substr(blocker_task_key, 1, ?) = ?
       OR substr(blocked_task_key, 1, ?) = ?
  `).run(prefix.length, prefix, prefix.length, prefix)
}

export function createExecutionStore({ db = getDefaultDatabase(), stageIds = [] } = {}) {
  const allowedStages = [...new Set(stageIds)]

  function updatePlan(executionTaskKey, input = {}, actor = null, actorUserId = null) {
    const key = String(executionTaskKey || '').trim()
    if (!key) throw new Error('缺少任务执行身份')
    if (!isPlainObject(input)) throw new Error('计划字段必须是对象')
    const updatedAt = new Date().toISOString()
    return withTransaction(db, () => {
      const before = readPlan(db, key)
      const after = {
        dueDate: Object.hasOwn(input, 'dueDate') ? normalizeDueDate(input.dueDate) : before.dueDate,
        milestone: Object.hasOwn(input, 'milestone')
          ? normalizeMilestone(input.milestone)
          : before.milestone,
        tags: Object.hasOwn(input, 'tags') ? normalizeTags(input.tags) : before.tags,
      }
      if (samePlan(before, after)) {
        return {
          changed: false,
          correlationId: null,
          plan: {
            dueDate: after.dueDate,
            milestone: after.milestone,
            tags: after.tags,
          },
        }
      }

      db.prepare(`
        INSERT INTO task_execution(
          execution_task_key, due_date, milestone, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(execution_task_key) DO UPDATE SET
          due_date = excluded.due_date,
          milestone = excluded.milestone,
          updated_at = excluded.updated_at
      `).run(key, after.dueDate, after.milestone, before.createdAt || updatedAt, updatedAt)
      db.prepare('DELETE FROM task_tag WHERE execution_task_key = ?').run(key)
      const insertTag = db.prepare(`
        INSERT INTO task_tag(execution_task_key, tag, created_at)
        VALUES (?, ?, ?)
      `)
      after.tags.forEach((tag) => insertTag.run(key, tag, updatedAt))

      const correlationId = crypto.randomUUID()
      appendTaskEvent(db, {
        executionTaskKey: key,
        eventType: 'task_plan_updated',
        source: 'user',
        actor,
        actorUserId,
        correlationId,
        occurredAt: updatedAt,
        payload: {
          before: {
            dueDate: before.dueDate,
            milestone: before.milestone,
            tags: before.tags,
          },
          after: {
            dueDate: after.dueDate,
            milestone: after.milestone,
            tags: after.tags,
          },
        },
        reversible: true,
      })
      return {
        changed: true,
        correlationId,
        plan: {
          dueDate: after.dueDate,
          milestone: after.milestone,
          tags: after.tags,
        },
      }
    })
  }

  function createDependency(input = {}, actor = null, actorUserId = null) {
    if (!isPlainObject(input)) throw new Error('依赖参数必须是对象')
    const blockerTaskKey = normalizeDependencyTaskKey(input.blockerTaskKey, '阻断方')
    const blockedTaskKey = normalizeDependencyTaskKey(input.blockedTaskKey, '被阻断')
    const reason = normalizeDependencyReason(input.reason)
    if (blockerTaskKey === blockedTaskKey) throw new Error('任务不能阻断自身')
    const id = crypto.randomUUID()
    const createdAt = new Date().toISOString()
    const labels =
      input.taskLabels instanceof Map
        ? new Map(input.taskLabels)
        : new Map(Object.entries(input.taskLabels || {}))
    labels.set(
      blockerTaskKey,
      String(input.blockerLabel || labels.get(blockerTaskKey) || blockerTaskKey),
    )
    labels.set(
      blockedTaskKey,
      String(input.blockedLabel || labels.get(blockedTaskKey) || blockedTaskKey),
    )

    return withTransaction(db, () => {
      const dependencies = readTaskDependencies(db)
      const duplicate = dependencies.find(
        (dependency) =>
          !dependency.resolvedAt &&
          dependency.blockerTaskKey === blockerTaskKey &&
          dependency.blockedTaskKey === blockedTaskKey,
      )
      if (duplicate) throw new Error('这条活动依赖已经存在')

      // A blocked by B 表示 A -> B；新增前从 B 搜索是否已经能回到 A。
      const path = findBlockedByPath(dependencies, blockerTaskKey, blockedTaskKey)
      if (path) {
        const cycle = [blockedTaskKey, ...path].map((key) => labels.get(key) || key).join(' → ')
        throw new Error(`依赖会形成循环：${cycle}`)
      }

      db.prepare(`
        INSERT INTO task_dependency(
          id, blocker_task_key, blocked_task_key, reason, created_by,
          created_at, resolved_at
        ) VALUES (?, ?, ?, ?, ?, ?, NULL)
      `).run(id, blockerTaskKey, blockedTaskKey, reason, normalizeActor(actor), createdAt)
      const correlationId = crypto.randomUUID()
      appendTaskEvent(db, {
        executionTaskKey: blockedTaskKey,
        eventType: 'dependency_created',
        source: 'user',
        actor,
        actorUserId,
        correlationId,
        occurredAt: createdAt,
        payload: {
          dependencyId: id,
          blockerTaskKey,
          blockedTaskKey,
          reason,
          before: null,
          after: { status: 'active' },
        },
        reversible: true,
      })
      return {
        id,
        blockerTaskKey,
        blockedTaskKey,
        reason,
        createdBy: normalizeActor(actor),
        createdAt,
        resolvedAt: null,
        correlationId,
      }
    })
  }

  function resolveDependency(id, actor = null, actorUserId = null) {
    const dependencyId = String(id || '').trim()
    if (!dependencyId) throw new Error('缺少依赖 ID')
    const resolvedAt = new Date().toISOString()
    return withTransaction(db, () => {
      const row = db
        .prepare(`
        SELECT
          id, blocker_task_key, blocked_task_key, reason, created_by,
          created_at, resolved_at
        FROM task_dependency
        WHERE id = ?
      `)
        .get(dependencyId)
      if (!row) throw new Error('依赖不存在')
      if (row.resolved_at) throw new Error('这条依赖已经解除')
      const result = db
        .prepare(`
        UPDATE task_dependency
        SET resolved_at = ?
        WHERE id = ? AND resolved_at IS NULL
      `)
        .run(resolvedAt, dependencyId)
      if (!result.changes) throw new Error('这条依赖已经解除')
      const correlationId = crypto.randomUUID()
      appendTaskEvent(db, {
        executionTaskKey: row.blocked_task_key,
        eventType: 'dependency_resolved',
        source: 'user',
        actor,
        actorUserId,
        correlationId,
        occurredAt: resolvedAt,
        payload: {
          dependencyId,
          blockerTaskKey: row.blocker_task_key,
          blockedTaskKey: row.blocked_task_key,
          reason: row.reason,
          before: { status: 'active' },
          after: { status: 'resolved', resolvedAt },
        },
        reversible: true,
      })
      return {
        ...rowToDependency({ ...row, resolved_at: resolvedAt }),
        correlationId,
      }
    })
  }

  function recordScanObservationsInTransaction({
    tasks = [],
    previousTasks = [],
    occurredAt = new Date().toISOString(),
    actor = 'system',
  } = {}) {
    const activeTasks = tasks.filter(
      (task) => !task.archived && task.executionIdentityValid !== false && task.executionTaskKey,
    )
    const previousByKey = new Map(
      previousTasks
        .filter(
          (task) =>
            task.executionTaskKey &&
            !task.archived &&
            task.executionIdentityValid !== false &&
            task.executionIdentityConflict !== true,
        )
        .map((task) => [task.executionTaskKey, task]),
    )
    const keys = [...new Set(activeTasks.map((task) => task.executionTaskKey))]
    if (!keys.length) return { baselines: 0, observations: 0 }

    const trackingKeys = new Set()
    for (const group of chunk(keys)) {
      const rows = db
        .prepare(`
        SELECT DISTINCT execution_task_key
        FROM task_event
        WHERE event_type = 'tracking_started'
          AND execution_task_key IN (${placeholders(group.length)})
      `)
        .all(...group)
      rows.forEach((row) => trackingKeys.add(row.execution_task_key))
    }

    let baselines = 0
    let observations = 0
    const correlationId = crypto.randomUUID()
    for (const task of activeTasks) {
      const hadTracking = trackingKeys.has(task.executionTaskKey)
      if (!hadTracking) {
        appendTaskEvent(db, {
          executionTaskKey: task.executionTaskKey,
          eventType: 'tracking_started',
          source: 'system',
          actor,
          correlationId,
          occurredAt,
          payload: {
            before: null,
            after: {
              derivedStage: task.derivedStage,
              trackingStartedAt: occurredAt,
            },
          },
        })
        trackingKeys.add(task.executionTaskKey)
        baselines += 1
        continue
      }
      const previous = previousByKey.get(task.executionTaskKey)
      if (previous?.derivedStage && previous.derivedStage !== task.derivedStage) {
        appendTaskEvent(db, {
          executionTaskKey: task.executionTaskKey,
          eventType: 'stage_observed',
          source: 'scan',
          actor,
          correlationId,
          occurredAt,
          payload: {
            before: { derivedStage: previous.derivedStage },
            after: { derivedStage: task.derivedStage },
          },
        })
        observations += 1
      }
    }
    return { baselines, observations }
  }

  function recordScanObservations(options = {}) {
    return withTransaction(db, () => recordScanObservationsInTransaction(options))
  }

  function getExecutionDetail(executionTaskKey, limit = 200) {
    return readExecutionDetail(db, executionTaskKey, limit)
  }

  function listSavedViews(ownerUserId = null, teamId = null) {
    const owner = normalizeActor(ownerUserId)
    return db
      .prepare(`
      SELECT id, name, filter_json, position, created_at, updated_at
      FROM saved_view
      WHERE owner_user_id IS ? AND team_id IS ?
      ORDER BY position, id
    `)
      .all(owner, teamId ?? null)
      .map(rowToSavedView)
  }

  function createSavedView(input = {}, ownerUserId = null, teamId = null) {
    if (!isPlainObject(input)) throw new Error('保存视图必须是对象')
    const name = normalizeViewName(input.name)
    const filter = normalizeSavedViewFilter(input.filter, allowedStages)
    const owner = normalizeActor(ownerUserId)
    const now = new Date().toISOString()
    const id = crypto.randomUUID()
    return withTransaction(db, () => {
      const next = db
        .prepare(`
        SELECT COALESCE(MAX(position), -1) + 1 AS position
        FROM saved_view
        WHERE owner_user_id IS ? AND team_id IS ?
      `)
        .get(owner, teamId ?? null)
      db.prepare(`
        INSERT INTO saved_view(
          id, name, filter_json, position, team_id, created_at, updated_at, owner_user_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        name,
        JSON.stringify(filter),
        Number(next.position),
        teamId ?? null,
        now,
        now,
        owner,
      )
      return {
        id,
        name,
        filter,
        position: Number(next.position),
        createdAt: now,
        updatedAt: now,
      }
    })
  }

  function updateSavedView(input = {}, ownerUserId = null, teamId = null) {
    if (!isPlainObject(input)) throw new Error('保存视图必须是对象')
    const id = String(input.id || '').trim()
    if (!id) throw new Error('缺少保存视图 ID')
    const name = normalizeViewName(input.name)
    const filter = normalizeSavedViewFilter(input.filter, allowedStages)
    const owner = normalizeActor(ownerUserId)
    const updatedAt = new Date().toISOString()
    const result = db
      .prepare(`
      UPDATE saved_view
      SET name = ?, filter_json = ?, updated_at = ?
      WHERE id = ? AND owner_user_id IS ? AND team_id IS ?
    `)
      .run(name, JSON.stringify(filter), updatedAt, id, owner, teamId ?? null)
    if (!result.changes) throw new Error('保存视图不存在')
    return {
      ...rowToSavedView(
        db
          .prepare(`
        SELECT id, name, filter_json, position, created_at, updated_at
        FROM saved_view
        WHERE id = ? AND owner_user_id IS ? AND team_id IS ?
      `)
          .get(id, owner, teamId ?? null),
      ),
    }
  }

  function deleteSavedView(id, ownerUserId = null, teamId = null) {
    const viewId = String(id || '').trim()
    if (!viewId) throw new Error('缺少保存视图 ID')
    const owner = normalizeActor(ownerUserId)
    return withTransaction(db, () => {
      const row = db
        .prepare(`
        SELECT id, name, filter_json, position, created_at, updated_at
        FROM saved_view
        WHERE id = ? AND owner_user_id IS ? AND team_id IS ?
      `)
        .get(viewId, owner, teamId ?? null)
      if (!row) throw new Error('保存视图不存在')
      db.prepare('DELETE FROM saved_view WHERE id = ? AND owner_user_id IS ? AND team_id IS ?').run(
        viewId,
        owner,
        teamId ?? null,
      )
      db.prepare(`
        UPDATE saved_view
        SET position = position - 1
        WHERE position > ? AND owner_user_id IS ? AND team_id IS ?
      `).run(row.position, owner, teamId ?? null)
      return rowToSavedView(row)
    })
  }

  return {
    updatePlan,
    createDependency,
    resolveDependency,
    recordScanObservations,
    recordScanObservationsInTransaction,
    getExecutionDetail,
    listSavedViews,
    createSavedView,
    updateSavedView,
    deleteSavedView,
  }
}
