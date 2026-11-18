import crypto from 'node:crypto'
import { withTransaction } from '../database.js'
import { validateGitBranchName } from '@trellis-board/shared/remote-identity.js'
import { ERROR_CODES, teamError } from './errors.js'

export const TASK_OWNERSHIP_INBOX_BATCH_LIMIT = 200

const MAX_TASK_ID_LENGTH = 128
const MAX_TASK_DIR_LENGTH = 512
const MAX_TITLE_LENGTH = 300
const MAX_REASON_LENGTH = 128
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SAFE_REASON = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SHA256 = /^[a-f0-9]{64}$/

function textLength(value) {
  return Array.from(value).length
}

function requiredText(value, label, max) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text || textLength(text) > max || text.includes('\u0000')) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, `${label}格式无效`)
  }
  return text
}

function taskId(value) {
  const text = String(value || '').trim()
  if (!SAFE_ID.test(text) || text.length > MAX_TASK_ID_LENGTH) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, '任务 ID 格式无效')
  }
  return text
}

function taskDir(value) {
  const text = String(value || '').trim()
  const prefix = '.trellis/tasks/'
  const name = text.startsWith(prefix) ? text.slice(prefix.length) : ''
  if (
    !name ||
    name === '.' ||
    name === '..' ||
    name === 'archive' ||
    name.includes('/') ||
    name.includes('\\') ||
    /[\u0000-\u001f\u007f]/.test(name) ||
    text.length > MAX_TASK_DIR_LENGTH
  ) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, '任务目录格式无效')
  }
  return text
}

function changes(input, key) {
  const value = input?.[key]
  if (value == null) return []
  if (!Array.isArray(value)) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, `${key} 必须是数组`)
  }
  return value
}

function normalizeUpsert(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, '待归属摘要格式无效')
  }
  const reason = String(value.reason || '').trim()
  const fingerprint = String(value.fingerprint || '').trim()
  if (!SAFE_REASON.test(reason) || reason.length > MAX_REASON_LENGTH) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, '待归属原因格式无效')
  }
  if (!SHA256.test(fingerprint)) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, '任务指纹必须是 64 位小写 SHA-256')
  }
  return {
    taskId: taskId(value.taskId),
    taskDir: taskDir(value.taskDir),
    title: requiredText(value.title, '任务标题', MAX_TITLE_LENGTH),
    reason,
    fingerprint,
  }
}

function normalizeDelete(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, '待归属删除项格式无效')
  }
  const normalized = {
    taskDir: taskDir(value.taskDir),
  }
  // 新客户端只依赖稳定目录；旧客户端携带 taskId 时继续做格式校验以保持兼容。
  if (value.taskId != null) {
    normalized.taskId = taskId(value.taskId)
  }
  return normalized
}

function normalizeObservedBranch(input, space, binding) {
  const value = input?.observedBranchName
  if (typeof value !== 'string' || !value.trim()) {
    throw teamError(400, 'BRANCH_OBSERVATION_REQUIRED', '待归属摘要写入必须上报真实 Git 分支')
  }
  let observed
  try {
    observed = validateGitBranchName(value)
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

function projectIds(value) {
  const values = Array.isArray(value) ? value : value == null ? [] : [value]
  return [
    ...new Set(
      values
        .flatMap((item) => String(item || '').split(','))
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ]
}

function pageLimit(value) {
  if (value == null || value === '') return DEFAULT_LIMIT
  const limit = Number(value)
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, `limit 必须是 1 到 ${MAX_LIMIT} 的整数`)
  }
  return limit
}

function encodeCursor(item) {
  return Buffer.from(
    JSON.stringify({
      lastSeenAt: item.lastSeenAt,
      projectId: item.projectId,
      taskId: item.taskId,
    }),
  ).toString('base64url')
}

function decodeCursor(value) {
  if (!value) return null
  let parsed
  try {
    parsed = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'))
  } catch {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, '分页游标无效')
  }
  if (
    !parsed ||
    typeof parsed.lastSeenAt !== 'string' ||
    typeof parsed.projectId !== 'string' ||
    typeof parsed.taskId !== 'string' ||
    !parsed.projectId ||
    !parsed.taskId ||
    Number.isNaN(Date.parse(parsed.lastSeenAt))
  ) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, '分页游标无效')
  }
  return parsed
}

export function deleteTaskOwnershipInboxRows(db, projectId, taskIdValue) {
  if (!projectId || !taskIdValue) return 0
  return Number(
    db
      .prepare(`
        DELETE FROM sync_task_ownership_inbox
        WHERE project_id = ? AND task_id = ?
      `)
      .run(projectId, taskIdValue).changes,
  )
}

export function createTaskOwnershipInboxService({
  db,
  taskSpaces,
  taskSnapshots,
  now = () => new Date(),
}) {
  function apply(agent, taskSpaceId, input = {}) {
    const { space, binding } = taskSnapshots.bindingContext(agent, taskSpaceId)
    const actor = taskSpaces.actorContext(agent.userId)
    taskSpaces.authorizeTaskSpace(actor, taskSpaceId, 'write')
    normalizeObservedBranch(input, space, binding)

    const rawUpserts = changes(input, 'upserts')
    const rawDeletes = changes(input, 'deletes')
    if (rawUpserts.length + rawDeletes.length > TASK_OWNERSHIP_INBOX_BATCH_LIMIT) {
      throw teamError(
        400,
        ERROR_CODES.INVALID_INPUT,
        `单次最多提交 ${TASK_OWNERSHIP_INBOX_BATCH_LIMIT} 个待归属变更`,
      )
    }
    const upserts = rawUpserts.map(normalizeUpsert)
    const deletes = rawDeletes.map(normalizeDelete)
    if (!upserts.length && !deletes.length) {
      return { taskSpaceId, upserts: 0, deletes: 0, changed: false }
    }

    const timestamp = now().toISOString()
    let changed = 0
    withTransaction(db, () => {
      const upsert = db.prepare(`
        INSERT INTO sync_task_ownership_inbox(
          id, project_id, source_task_space_id, source_agent_id, source_user_id,
          task_id, task_dir, title, reason, source_branch_name, fingerprint,
          first_seen_at, last_seen_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_task_space_id, source_agent_id, task_id) DO UPDATE SET
          project_id = excluded.project_id,
          source_user_id = excluded.source_user_id,
          task_dir = excluded.task_dir,
          title = excluded.title,
          reason = excluded.reason,
          source_branch_name = excluded.source_branch_name,
          fingerprint = excluded.fingerprint,
          last_seen_at = excluded.last_seen_at,
          updated_at = excluded.updated_at
      `)
      for (const item of upserts) {
        changed += Number(
          upsert.run(
            crypto.randomUUID(),
            space.project_id,
            taskSpaceId,
            agent.id,
            binding.user_id,
            item.taskId,
            item.taskDir,
            item.title,
            item.reason,
            space.branch_name,
            item.fingerprint,
            timestamp,
            timestamp,
            timestamp,
          ).changes,
        )
      }

      const remove = db.prepare(`
        DELETE FROM sync_task_ownership_inbox
        WHERE project_id = ? AND source_task_space_id = ?
          AND source_agent_id = ? AND task_dir = ?
      `)
      for (const item of deletes) {
        changed += Number(remove.run(space.project_id, taskSpaceId, agent.id, item.taskDir).changes)
      }
    })
    return {
      taskSpaceId,
      upserts: upserts.length,
      deletes: deletes.length,
      changed: changed > 0,
    }
  }

  function list(actor, input = {}) {
    const accessible = taskSpaces.listReadable(actor, { teamId: input.teamId })
    const accessibleIds = new Set(accessible.map((project) => project.id))
    const requestedIds = projectIds(input.projectIds)
    if (requestedIds.some((projectId) => !accessibleIds.has(projectId))) {
      throw teamError(403, ERROR_CODES.FORBIDDEN, '无权访问指定项目')
    }
    const selectedIds = (requestedIds.length ? requestedIds : [...accessibleIds]).sort()
    const limit = pageLimit(input.limit)
    const cursor = decodeCursor(input.cursor)
    if (!selectedIds.length) return { items: [], total: 0, nextCursor: null }
    const projectPlaceholders = selectedIds.map(() => '?').join(', ')
    const groupedSql = `
      WITH ranked AS (
        SELECT i.*,
               MAX(i.last_seen_at) OVER (
                 PARTITION BY i.project_id, i.task_id
               ) AS grouped_last_seen_at,
               MIN(i.first_seen_at) OVER (
                 PARTITION BY i.project_id, i.task_id
               ) AS grouped_first_seen_at,
               ROW_NUMBER() OVER (
                 PARTITION BY i.project_id, i.task_id
                 ORDER BY i.last_seen_at DESC, i.updated_at DESC, i.id
               ) AS source_rank
        FROM sync_task_ownership_inbox i
        JOIN sync_task_space s ON s.id = i.source_task_space_id
        JOIN sync_project p ON p.id = i.project_id
        WHERE i.project_id IN (${projectPlaceholders})
          AND s.status != 'disabled'
          AND s.retired_at IS NULL
          AND p.status = 'active'
      ),
      grouped AS (
        SELECT project_id, task_id, task_dir, title, reason,
               grouped_first_seen_at AS first_seen_at,
               grouped_last_seen_at AS last_seen_at
        FROM ranked
        WHERE source_rank = 1
      )
    `
    const total = Number(
      db.prepare(`${groupedSql} SELECT COUNT(*) AS count FROM grouped`).get(...selectedIds).count,
    )
    const cursorWhere = cursor
      ? `
        WHERE (
          g.last_seen_at < ?
          OR (g.last_seen_at = ? AND g.project_id > ?)
          OR (g.last_seen_at = ? AND g.project_id = ? AND g.task_id > ?)
        )
      `
      : ''
    const cursorValues = cursor
      ? [
          cursor.lastSeenAt,
          cursor.lastSeenAt,
          cursor.projectId,
          cursor.lastSeenAt,
          cursor.projectId,
          cursor.taskId,
        ]
      : []
    const rows = db
      .prepare(`
        ${groupedSql}
        SELECT g.project_id, g.task_id, g.task_dir, g.title, g.reason,
               g.first_seen_at, g.last_seen_at, p.name AS project_name
        FROM grouped g
        JOIN sync_project p ON p.id = g.project_id
        ${cursorWhere}
        ORDER BY g.last_seen_at DESC, g.project_id ASC, g.task_id ASC
        LIMIT ?
      `)
      .all(...selectedIds, ...cursorValues, limit + 1)
    const hasMore = rows.length > limit
    const pageRows = hasMore ? rows.slice(0, limit) : rows
    if (!pageRows.length) return { items: [], total, nextCursor: null }

    const keyWhere = pageRows.map(() => '(i.project_id = ? AND i.task_id = ?)').join(' OR ')
    const sourceRows = db
      .prepare(`
        SELECT i.project_id, i.task_id, i.source_agent_id, i.source_branch_name,
               a.device_name, u.username
        FROM sync_task_ownership_inbox i
        JOIN sync_task_space s ON s.id = i.source_task_space_id
        JOIN sync_project p ON p.id = i.project_id
        JOIN agent_device a ON a.id = i.source_agent_id
        JOIN user_account u ON u.id = i.source_user_id
        WHERE (${keyWhere})
          AND s.status != 'disabled'
          AND s.retired_at IS NULL
          AND p.status = 'active'
        ORDER BY i.project_id, i.task_id, i.source_branch_name, a.device_name, u.username
      `)
      .all(...pageRows.flatMap((row) => [row.project_id, row.task_id]))
    const sources = new Map()
    for (const row of sourceRows) {
      const key = `${row.project_id}\0${row.task_id}`
      if (!sources.has(key)) {
        sources.set(key, { branches: new Set(), clients: new Map() })
      }
      const group = sources.get(key)
      group.branches.add(row.source_branch_name)
      group.clients.set(row.source_agent_id, {
        displayName: row.device_name,
        username: row.username,
      })
    }

    const items = pageRows.map((row) => {
      const source = sources.get(`${row.project_id}\0${row.task_id}`)
      return {
        projectId: row.project_id,
        projectName: row.project_name,
        taskId: row.task_id,
        taskDir: row.task_dir,
        title: row.title,
        reason: row.reason,
        sourceBranches: [...(source?.branches || [])].sort(),
        sourceClients: [...(source?.clients.values() || [])],
        firstSeenAt: row.first_seen_at,
        lastSeenAt: row.last_seen_at,
      }
    })
    return {
      items,
      total,
      nextCursor: hasMore ? encodeCursor(items[items.length - 1]) : null,
    }
  }

  function countByProject(projectIdValues = null) {
    const ids = projectIdValues == null ? null : projectIds(projectIdValues)
    if (ids && !ids.length) return new Map()
    const where = ids ? `AND i.project_id IN (${ids.map(() => '?').join(', ')})` : ''
    const rows = db
      .prepare(`
        SELECT i.project_id, COUNT(DISTINCT i.task_id) AS count
        FROM sync_task_ownership_inbox i
        JOIN sync_task_space s ON s.id = i.source_task_space_id
        JOIN sync_project p ON p.id = i.project_id
        WHERE s.status != 'disabled'
          AND s.retired_at IS NULL
          AND p.status = 'active'
          ${where}
        GROUP BY i.project_id
      `)
      .all(...(ids || []))
    return new Map(rows.map((row) => [row.project_id, Number(row.count)]))
  }

  return {
    apply,
    list,
    countByProject,
  }
}
