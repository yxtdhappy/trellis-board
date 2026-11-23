export const HANDOFF_NOTICE_DISMISSED_STORAGE_KEY = 'trellis.handoff-notice-dismissed.v1'
export const MAX_DISMISSED_NOTICES = 200

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

export function normalizeMaterializedAt(value) {
  return text(value) || null
}

export function normalizeHandoffNotices(value) {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const record = item
    if (
      typeof record.executionTaskKey !== 'string' ||
      typeof record.taskId !== 'string' ||
      typeof record.relativeDir !== 'string' ||
      typeof record.handoffState !== 'string' ||
      typeof record.ackState !== 'string' ||
      typeof record.outcome !== 'string'
    ) {
      return []
    }
    return [
      {
        executionTaskKey: record.executionTaskKey,
        taskId: record.taskId,
        relativeDir: record.relativeDir,
        handoffState: record.handoffState,
        ackState: record.ackState,
        outcome: record.outcome,
        reason: typeof record.reason === 'string' ? record.reason : null,
        backupId: typeof record.backupId === 'string' ? record.backupId : null,
        materializedAt: normalizeMaterializedAt(record.materializedAt),
      },
    ]
  })
}

/** 旧三段键：升级前写入的 toast 去重记录仍按它判断是否已提示。 */
export function legacyHandoffNoticeKey(notice) {
  const executionTaskKey = text(notice?.executionTaskKey)
  const handoffState = text(notice?.handoffState)
  const outcome = text(notice?.outcome) || 'checking'
  return `${executionTaskKey}:${handoffState}:${outcome}`
}

/** 关闭与提示的去重键：附加物化轮次，同一任务再次委派后重新可见。 */
export function handoffNoticeKey(notice) {
  return `${legacyHandoffNoticeKey(notice)}:${normalizeMaterializedAt(notice?.materializedAt) || '-'}`
}

export function normalizeDismissedNoticeIds(ids) {
  const values = ids instanceof Set ? [...ids] : Array.isArray(ids) ? ids : []
  return [...new Set(values.filter((id) => typeof id === 'string' && id.trim()))].slice(
    -MAX_DISMISSED_NOTICES,
  )
}

export function readDismissedNotices(storage) {
  if (!storage || typeof storage.getItem !== 'function') return []
  try {
    const raw = storage.getItem(HANDOFF_NOTICE_DISMISSED_STORAGE_KEY)
    if (!raw) return []
    return normalizeDismissedNoticeIds(JSON.parse(raw))
  } catch {
    return []
  }
}

export function writeDismissedNotices(storage, ids) {
  if (!storage || typeof storage.setItem !== 'function') return false
  try {
    storage.setItem(
      HANDOFF_NOTICE_DISMISSED_STORAGE_KEY,
      JSON.stringify(normalizeDismissedNoticeIds(ids)),
    )
    return true
  } catch {
    return false
  }
}

export function visibleHandoffNotices(notices, dismissedIds) {
  const dismissed = new Set(normalizeDismissedNoticeIds(dismissedIds))
  return (Array.isArray(notices) ? notices : []).filter((notice) => {
    if (!notice || typeof notice !== 'object') return false
    if (notice.outcome === 'cleaned') return false
    return !dismissed.has(handoffNoticeKey(notice))
  })
}
