import { ERROR_CODES, teamError } from './errors.js'

export const EXECUTION_WIP_LIMIT = 2
export const ASSIGNABLE_ROLES = new Set(['lead', 'member'])

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

export function parseJson(value, fallback) {
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

export function requiredText(value, label, max = 500) {
  const result = String(value || '').trim()
  if (!result || Array.from(result).length > max) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, `${label}格式无效`)
  }
  return result
}

export function taskSpaceIdFromInput(input = {}) {
  const explicit = String(input.taskSpaceId || '').trim()
  if (explicit) return explicit
  const executionTaskKey = String(input.executionTaskKey || input.taskKey || '').trim()
  if (executionTaskKey.includes('::'))
    return executionTaskKey.slice(0, executionTaskKey.indexOf('::'))
  return ''
}

export function publicAssignment(row) {
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
