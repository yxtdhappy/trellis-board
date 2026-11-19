import { ERROR_CODES, teamError } from '../errors.js'
import { resolveTeamScope } from '../teams.js'
import { hashValue } from './projection-state.js'
import {
  CURSOR_TTL_MS,
  encryptCursor,
  decryptCursor,
  shanghaiDay,
  addDays,
  normalizeFilters,
  bindList,
  stableTaskIdSql,
  publicRow,
  stringList,
} from './query-helpers.js'

export function queryTasks(deps, actor, input = {}) {
  const { archiveQueryRevision, db, mineMemberSignature, queryCache, queryRevision } = deps
  const filters = normalizeFilters(input)
  const teamScope = resolveTeamScope(db, actor, input.teamId)
  const scope = resolveQueryScope(deps, actor, input)
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

export function resolveQueryScope(deps, actor, input) {
  const { taskSpaces } = deps
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
