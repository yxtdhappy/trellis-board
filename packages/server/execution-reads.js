import { chunk, parseJson, placeholders } from './execution-normalize.js'

export function rowToDependency(row) {
  return {
    id: row.id,
    blockerTaskKey: row.blocker_task_key,
    blockedTaskKey: row.blocked_task_key,
    reason: row.reason,
    createdBy: row.created_by || null,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at || null,
  }
}

export function readTaskDependencies(db) {
  return db
    .prepare(`
    SELECT
      id, blocker_task_key, blocked_task_key, reason, created_by,
      created_at, resolved_at
    FROM task_dependency
    ORDER BY created_at, rowid
  `)
    .all()
    .map(rowToDependency)
}

export function createBlockedByGraph(dependencies) {
  const graph = new Map()
  dependencies
    .filter((dependency) => !dependency.resolvedAt)
    .forEach((dependency) => {
      if (!graph.has(dependency.blockedTaskKey)) {
        graph.set(dependency.blockedTaskKey, [])
      }
      graph.get(dependency.blockedTaskKey).push(dependency.blockerTaskKey)
    })
  return graph
}

export function findBlockedByPath(dependencies, start, target) {
  if (start === target) return [start]
  const graph = createBlockedByGraph(dependencies)
  const queue = [start]
  const previous = new Map([[start, null]])
  while (queue.length) {
    const current = queue.shift()
    for (const next of graph.get(current) || []) {
      if (previous.has(next)) continue
      previous.set(next, current)
      if (next === target) {
        const path = [target]
        let cursor = current
        while (cursor != null) {
          path.push(cursor)
          cursor = previous.get(cursor)
        }
        return path.reverse()
      }
      queue.push(next)
    }
  }
  return null
}

export function readPlanRow(db, executionTaskKey) {
  return (
    db
      .prepare(`
    SELECT due_date, milestone, created_at, updated_at
    FROM task_execution
    WHERE execution_task_key = ?
  `)
      .get(executionTaskKey) || null
  )
}

export function readTags(db, executionTaskKey) {
  return db
    .prepare(`
    SELECT tag
    FROM task_tag
    WHERE execution_task_key = ?
    ORDER BY rowid
  `)
    .all(executionTaskKey)
    .map((row) => row.tag)
}

export function readPlan(db, executionTaskKey) {
  const row = readPlanRow(db, executionTaskKey)
  return {
    dueDate: row?.due_date ?? null,
    milestone: row?.milestone || '',
    tags: readTags(db, executionTaskKey),
    createdAt: row?.created_at || null,
    updatedAt: row?.updated_at || null,
  }
}

export function samePlan(left, right) {
  return (
    left.dueDate === right.dueDate &&
    left.milestone === right.milestone &&
    left.tags.length === right.tags.length &&
    left.tags.every((tag, index) => tag === right.tags[index])
  )
}

export function readEventSummaries(db, keys) {
  const summaries = new Map()
  for (const group of chunk(keys)) {
    if (!group.length) continue
    const rows = db
      .prepare(`
      SELECT
        execution_task_key,
        COUNT(*) AS event_count,
        MAX(occurred_at) AS last_activity_at,
        MIN(CASE WHEN event_type = 'tracking_started' THEN occurred_at END) AS tracking_started_at
      FROM task_event
      WHERE execution_task_key IN (${placeholders(group.length)})
      GROUP BY execution_task_key
    `)
      .all(...group)
    rows.forEach((row) => summaries.set(row.execution_task_key, row))
  }
  return summaries
}

export function readTagsBatch(db, keys) {
  const tagsByKey = new Map()
  for (const group of chunk(keys)) {
    if (!group.length) continue
    const rows = db
      .prepare(`
      SELECT execution_task_key, tag
      FROM task_tag
      WHERE execution_task_key IN (${placeholders(group.length)})
      ORDER BY execution_task_key, rowid
    `)
      .all(...group)
    rows.forEach((row) => {
      if (!tagsByKey.has(row.execution_task_key)) tagsByKey.set(row.execution_task_key, [])
      tagsByKey.get(row.execution_task_key).push(row.tag)
    })
  }
  return tagsByKey
}

export function readExecutionMap(db, executionTaskKeys, limit = 200) {
  const keys = [
    ...new Set(executionTaskKeys.map((key) => String(key || '').trim()).filter(Boolean)),
  ]
  if (!keys.length) return new Map()
  const plans = new Map()
  const tagsByKey = readTagsBatch(db, keys)
  const events = readEventSummaries(db, keys)
  for (const group of chunk(keys)) {
    if (!group.length) continue
    const rows = db
      .prepare(`
      SELECT execution_task_key, due_date, milestone, created_at, updated_at
      FROM task_execution
      WHERE execution_task_key IN (${placeholders(group.length)})
    `)
      .all(...group)
    rows.forEach((row) => plans.set(row.execution_task_key, row))
  }
  return new Map(
    keys.map((key) => {
      const plan = plans.get(key)
      const event = events.get(key)
      return [
        key,
        {
          dueDate: plan?.due_date ?? null,
          milestone: plan?.milestone || '',
          tags: tagsByKey.get(key) || [],
          planCreatedAt: plan?.created_at || null,
          planUpdatedAt: plan?.updated_at || null,
          lastActivityAt: event?.last_activity_at || null,
          trackingStartedAt: event?.tracking_started_at || null,
          eventCount: Number(event?.event_count || 0),
          historyStatus: event?.event_count ? 'tracking' : 'missing',
          eventLimit: limit,
        },
      ]
    }),
  )
}

export function eventRowToObject(row) {
  return {
    id: row.id,
    executionTaskKey: row.execution_task_key,
    type: row.event_type,
    source: row.source,
    actor: row.actor,
    actorUserId: row.actor_user_id || null,
    correlationId: row.correlation_id,
    occurredAt: row.occurred_at,
    payload: parseJson(row.payload_json, {}),
    reversible: Boolean(row.reversible),
  }
}

export function normalizedEventLimit(limit) {
  return Math.min(1000, Math.max(1, Number(limit) || 200))
}

export function readExecutionEvents(db, executionTaskKey, limit = 200) {
  const key = String(executionTaskKey || '').trim()
  if (!key) throw new Error('缺少任务执行身份')
  const safeLimit = normalizedEventLimit(limit)
  const total = Number(
    db
      .prepare(`
    SELECT COUNT(*) AS count
    FROM task_event
    WHERE execution_task_key = ?
  `)
      .get(key)?.count || 0,
  )
  const rows = db
    .prepare(`
    SELECT
      execution_task_key, id, event_type, source, actor, correlation_id, occurred_at,
      payload_json, reversible, actor_user_id
    FROM task_event
    WHERE execution_task_key = ?
    ORDER BY occurred_at DESC, id DESC
    LIMIT ?
  `)
    .all(key, safeLimit)
  return {
    events: rows.map(eventRowToObject),
    eventTotal: total,
    eventLimit: safeLimit,
    eventTruncated: total > rows.length,
    eventWindowStartAt: rows.at(-1)?.occurred_at || null,
  }
}

export function readExecutionEventsBatch(db, executionTaskKeys, limit = 1000) {
  const keys = [
    ...new Set(executionTaskKeys.map((key) => String(key || '').trim()).filter(Boolean)),
  ]
  const safeLimit = normalizedEventLimit(limit)
  const result = new Map()
  if (!keys.length) return result

  const counts = new Map()
  for (const group of chunk(keys)) {
    const rows = db
      .prepare(`
      SELECT execution_task_key, COUNT(*) AS count
      FROM task_event
      WHERE execution_task_key IN (${placeholders(group.length)})
      GROUP BY execution_task_key
    `)
      .all(...group)
    rows.forEach((row) => counts.set(row.execution_task_key, Number(row.count)))
  }

  const eventsByKey = new Map(keys.map((key) => [key, []]))
  for (const group of chunk(keys)) {
    const rows = db
      .prepare(`
      SELECT
        execution_task_key, id, event_type, source, actor, correlation_id,
        occurred_at, payload_json, reversible, actor_user_id
      FROM (
        SELECT
          execution_task_key, id, event_type, source, actor, correlation_id,
          occurred_at, payload_json, reversible, actor_user_id,
          ROW_NUMBER() OVER (
            PARTITION BY execution_task_key
            ORDER BY occurred_at DESC, id DESC
          ) AS event_rank
        FROM task_event
        WHERE execution_task_key IN (${placeholders(group.length)})
      )
      WHERE event_rank <= ?
      ORDER BY execution_task_key, occurred_at DESC, id DESC
    `)
      .all(...group, safeLimit)
    rows.forEach((row) => {
      eventsByKey.get(row.execution_task_key)?.push(eventRowToObject(row))
    })
  }

  keys.forEach((key) => {
    const events = eventsByKey.get(key)
    const total = counts.get(key) || 0
    result.set(key, {
      events,
      eventTotal: total,
      eventLimit: safeLimit,
      eventTruncated: total > events.length,
      eventWindowStartAt: events.at(-1)?.occurredAt || null,
    })
  })
  return result
}

export function readExecutionDetail(db, executionTaskKey, limit = 200) {
  const key = String(executionTaskKey || '').trim()
  if (!key) throw new Error('缺少任务执行身份')
  const summary = readExecutionMap(db, [key], limit).get(key)
  const timeline = readExecutionEvents(db, key, limit)
  return { ...summary, ...timeline }
}

export function rowToSavedView(row) {
  return {
    id: row.id,
    name: row.name,
    filter: parseJson(row.filter_json, {}),
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
