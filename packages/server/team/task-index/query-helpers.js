import crypto from 'node:crypto'
import { ERROR_CODES, teamError } from '../errors.js'
import { text } from './projection-state.js'

export const CURSOR_KEY = crypto.randomBytes(32)

export const CURSOR_TTL_MS = 10 * 60 * 1000

export const DEFAULT_LIMIT = 100

export const MAX_LIMIT = 200

export function encryptCursor(payload) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', CURSOR_KEY, iv)
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url')
}

export function decryptCursor(value) {
  try {
    const data = Buffer.from(String(value), 'base64url')
    if (data.length < 29) throw new Error('short')
    const decipher = crypto.createDecipheriv('aes-256-gcm', CURSOR_KEY, data.subarray(0, 12))
    decipher.setAuthTag(data.subarray(12, 28))
    return JSON.parse(
      Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8'),
    )
  } catch {
    throw teamError(409, ERROR_CODES.CURSOR_INVALID, '查询游标无效，请从第一页重新获取', {
      recoverable: true,
    })
  }
}

export function shanghaiDay(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

export function addDays(day, days) {
  const date = new Date(`${day}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

export function normalizedLimit(value) {
  if (value == null || value === '') return DEFAULT_LIMIT
  const limit = Number(value)
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, 'limit 必须是 1 到 200 的整数')
  }
  return limit
}

export function stringList(value, label, { maxItems = 50, maxLength = 100 } = {}) {
  if (value == null || value === '') return []
  const values = Array.isArray(value) ? value : [value]
  if (values.length > maxItems) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, `${label} 数量过多`)
  }
  return [
    ...new Set(
      values.map((item) => {
        if (typeof item !== 'string' || !item.trim() || item.length > maxLength) {
          throw teamError(400, ERROR_CODES.INVALID_INPUT, `${label} 格式无效`)
        }
        return item.trim()
      }),
    ),
  ]
}

export function boolFilter(value, label) {
  if (value == null || value === '') return null
  if (value === true || value === 'true' || value === '1') return true
  if (value === false || value === 'false' || value === '0') return false
  throw teamError(400, ERROR_CODES.INVALID_INPUT, `${label} 只能是 true 或 false`)
}

export function normalizeFilters(input = {}) {
  const scope = input.scope == null || input.scope === '' ? 'all' : String(input.scope)
  if (!new Set(['all', 'mine']).has(scope)) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, 'scope 只能是 all 或 mine')
  }
  const preset = input.preset == null || input.preset === '' ? null : String(input.preset)
  if (preset != null && !new Set(['today', 'unblocked-ready']).has(preset)) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, 'preset 无效')
  }
  const q = text(input.q).trim().toLowerCase()
  if (q.length > 200) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, '搜索词不能超过 200 个字符')
  }
  const branch = text(input.branch).trim().toLowerCase()
  if (branch.length > 200) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, '分支筛选不能超过 200 个字符')
  }
  const days = (name) => {
    if (input[name] == null || input[name] === '') return null
    const value = Number(input[name])
    if (!Number.isInteger(value) || value < 0 || value > 3650) {
      throw teamError(400, ERROR_CODES.INVALID_INPUT, `${name} 必须是 0 到 3650 的整数`)
    }
    return value
  }
  return {
    scope,
    q,
    branch,
    priorities: stringList(input.priorities, 'priorities', { maxItems: 4, maxLength: 2 }),
    stages: stringList(input.stages, 'stages', { maxItems: 20, maxLength: 30 }),
    tags: stringList(input.tags, 'tags', { maxItems: 50, maxLength: 50 }),
    assignee: text(input.assignee).trim() || null,
    dueWithinDays: days('dueWithinDays'),
    staleDays: days('staleDays'),
    blocked: boolFilter(input.blocked, 'blocked'),
    archived: boolFilter(input.archived, 'archived') ?? false,
    preset,
    limit: normalizedLimit(input.limit),
  }
}

export function bindList(values) {
  return values.map(() => '?').join(', ')
}

export function stableTaskIdSql(alias) {
  return `substr(${alias}.execution_task_key, instr(${alias}.execution_task_key, '::') + 2)`
}

export function publicRow(row) {
  let attentionReasons = []
  try {
    const parsed = JSON.parse(row.attention_flags_json)
    if (Array.isArray(parsed)) attentionReasons = parsed.map(String)
  } catch {
    // 损坏的关注摘要不影响任务主体。
  }
  const syncStatus =
    row.task_space_status === 'active' &&
    !row.archive_candidate_snapshot_id &&
    Number(row.indexed_revision) === Number(row.revision) &&
    Number(row.archive_indexed_revision) === Number(row.archive_revision)
      ? 'current'
      : row.task_space_status === 'error'
        ? 'needs_repair'
        : 'stale'
  const identityConflict =
    row.execution_identity_conflict === 1 || Number(row.execution_identity_count || 1) > 1
  if (identityConflict) attentionReasons = [...new Set([...attentionReasons, 'identity_conflict'])]
  return {
    taskKey: row.task_key,
    executionTaskKey: row.execution_task_key,
    taskVersion: row.task_version,
    executionIdentityValid: !identityConflict && Boolean(row.execution_task_key),
    executionIdentityConflict: identityConflict,
    projectId: row.project_id,
    projectName: row.project_name,
    taskSpaceId: row.task_space_id,
    taskSpaceRevision: Number(row.revision),
    taskSpaceIndexedRevision: Number(row.indexed_revision),
    branchName: row.branch_name,
    sourceBranchName: row.source_branch_name || row.branch_name,
    teamId: row.team_id || null,
    teamName: row.team_name || null,
    relativeDir: row.relative_dir,
    title: row.title,
    priority: row.priority,
    derivedStage: row.derived_stage,
    archived: Boolean(row.archived),
    archivedAt: row.archived_at || null,
    assignee: row.assignee_dev_id || null,
    assigneeDevId: row.assignee_dev_id || null,
    assigneeUserId: row.assignee_user_id || null,
    previousAssigneeUserId: row.task_previous_assignee_user_id || null,
    materializationState: row.task_materialization_state || 'materialized',
    controlTaskVersion: row.control_task_version == null ? null : Number(row.control_task_version),
    handoffState: row.task_handoff_state || 'none',
    leaseStatus: row.task_lease_status || null,
    leaseExpiresAt: row.task_lease_expires_at || null,
    dueDate: row.due_date || null,
    lastActivityAt: row.last_activity_at || row.updated_at,
    isBlocked: Boolean(row.is_blocked),
    isUnblockedReady: Boolean(row.is_unblocked_ready),
    attentionReasons,
    groupKey: row.group_key,
    groupRole: row.group_role,
    projectSyncStatus: syncStatus,
    stale: syncStatus !== 'current',
    syncError: row.task_space_error || null,
  }
}

export function searchText(task) {
  return [
    task.title,
    task.description,
    task.projectName,
    task.branchName,
    task.taskKey,
    task.executionTaskKey,
    task.assignee,
    task.priority,
    task.derivedStage,
    ...(task.stages || []).flatMap((stage) =>
      stage.complete ? [stage.label, stage.evidence] : [],
    ),
    ...(task.execution?.tags || []),
  ]
    .filter(Boolean)
    .join('\n')
    .toLowerCase()
}
