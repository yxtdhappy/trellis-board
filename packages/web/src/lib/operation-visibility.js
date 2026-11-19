export const OPERATION_DISMISS_STORAGE_PREFIX = 'trellis.dismissed-operations.v1'
export const ACTIVE_OPERATION_STATUSES = ['pending', 'delivered', 'running']
export const DISMISSIBLE_OPERATION_STATUSES = ['succeeded', 'failed', 'cancelled']
export const MAX_VISIBLE_OPERATIONS = 8
export const SUCCEEDED_VISIBLE_MS = 10 * 60 * 1000

function operationStatus(operation) {
  return typeof operation?.status === 'string' ? operation.status : ''
}

export function isActiveOperation(operation) {
  return ACTIVE_OPERATION_STATUSES.includes(operationStatus(operation))
}

export function isDismissibleOperation(operation) {
  return DISMISSIBLE_OPERATION_STATUSES.includes(operationStatus(operation))
}

export function operationDismissStorageKey(userKey, taskSpaceId) {
  const user = String(userKey || '').trim() || 'anonymous'
  const space = String(taskSpaceId || '').trim() || 'all'
  return `${OPERATION_DISMISS_STORAGE_PREFIX}:${user}:${space}`
}

export function normalizeDismissedOperationIds(ids) {
  if (!Array.isArray(ids)) return []
  return [...new Set(ids.filter((id) => typeof id === 'string' && id.trim()))]
}

export function readDismissedOperationIds(storage, key) {
  if (!storage || typeof storage.getItem !== 'function') return []
  try {
    const raw = storage.getItem(key)
    if (!raw) return []
    return normalizeDismissedOperationIds(JSON.parse(raw))
  } catch {
    return []
  }
}

export function writeDismissedOperationIds(storage, key, ids) {
  if (!storage || typeof storage.setItem !== 'function') return false
  try {
    storage.setItem(key, JSON.stringify(normalizeDismissedOperationIds(ids)))
    return true
  } catch {
    return false
  }
}

export function pruneDismissedOperationIds(ids, operations) {
  const present = new Set(
    (Array.isArray(operations) ? operations : []).flatMap((operation) =>
      operation && typeof operation.id === 'string' && operation.id ? [operation.id] : [],
    ),
  )
  return normalizeDismissedOperationIds(ids).filter((id) => present.has(id))
}

function operationUpdatedAt(operation) {
  const raw = operation?.raw
  if (!raw || typeof raw !== 'object') return ''
  const value = raw.updatedAt ?? raw.updated_at
  return typeof value === 'string' ? value : ''
}

function succeededIsRecent(operation, now) {
  const updatedAt = Date.parse(operationUpdatedAt(operation))
  return Number.isFinite(updatedAt) && now - updatedAt < SUCCEEDED_VISIBLE_MS
}

export function visibleOperations(operations, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const dismissed = new Set(normalizeDismissedOperationIds(options.dismissedIds))
  return (Array.isArray(operations) ? operations : [])
    .filter((operation) => {
      if (!operation || typeof operation !== 'object') return false
      if (isDismissibleOperation(operation)) {
        if (typeof operation.id === 'string' && operation.id && dismissed.has(operation.id)) {
          return false
        }
        if (operationStatus(operation) === 'succeeded') return succeededIsRecent(operation, now)
      }
      return true
    })
    .slice(0, MAX_VISIBLE_OPERATIONS)
}
