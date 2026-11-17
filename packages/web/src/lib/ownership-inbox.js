function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function nonNegativeInteger(value, fallback = 0) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback
}

function uniqueTexts(value) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map(text).filter(Boolean))]
}

function normalizeSourceClients(value) {
  if (!Array.isArray(value)) return []
  const clients = []
  const seen = new Set()
  for (const row of value) {
    if (!row || typeof row !== 'object') continue
    const username = text(row.username)
    const displayName = text(row.displayName) || username
    if (!displayName) continue
    const key = `${displayName}\0${username}`
    if (seen.has(key)) continue
    seen.add(key)
    clients.push({ displayName, username })
  }
  return clients
}

function normalizeItem(value) {
  if (!value || typeof value !== 'object') return null
  const row = value
  const projectId = text(row.projectId)
  const taskId = text(row.taskId)
  const taskDir = text(row.taskDir)
  if (!projectId || !taskId || !taskDir) return null
  const fallbackTitle = taskDir.split('/').filter(Boolean).at(-1) || taskId
  return {
    projectId,
    projectName: text(row.projectName) || projectId,
    taskId,
    taskDir,
    title: text(row.title) || fallbackTitle,
    reason: text(row.reason) || 'TASK_OWNERSHIP_REQUIRED',
    sourceBranches: uniqueTexts(row.sourceBranches),
    sourceClients: normalizeSourceClients(row.sourceClients),
    firstSeenAt: text(row.firstSeenAt),
    lastSeenAt: text(row.lastSeenAt),
  }
}

export function ownershipInboxItemKey(item) {
  return `${item?.projectId || ''}::${item?.taskId || ''}`
}

export function mergeOwnershipInboxItems(current, next) {
  const merged = new Map()
  for (const item of Array.isArray(current) ? current : []) {
    if (item) merged.set(ownershipInboxItemKey(item), item)
  }
  for (const item of Array.isArray(next) ? next : []) {
    if (item) merged.set(ownershipInboxItemKey(item), item)
  }
  return [...merged.values()]
}

export function normalizeOwnershipInboxCount(value) {
  const number = nonNegativeInteger(value)
  return number > 0 ? number : 0
}

export function normalizeOwnershipInboxPage(payload) {
  const source = payload?.page ?? payload ?? {}
  const rows = Array.isArray(source.items) ? source.items : []
  const items = mergeOwnershipInboxItems([], rows.map(normalizeItem).filter(Boolean))
  const total = Math.max(nonNegativeInteger(source.total), items.length)
  const nextCursor = text(source.nextCursor)
  return {
    items,
    total,
    nextCursor: nextCursor || null,
  }
}

export function summarizeOwnershipInbox(projects, projectId = 'all') {
  const seen = new Set()
  const groups = []
  for (const project of Array.isArray(projects) ? projects : []) {
    const id = text(project?.id)
    if (!id || seen.has(id) || (projectId !== 'all' && id !== projectId)) continue
    seen.add(id)
    const count = normalizeOwnershipInboxCount(project?.ownershipInboxCount)
    if (count > 0) {
      groups.push({
        projectId: id,
        projectName: text(project?.name) || id,
        count,
      })
    }
  }
  return {
    count: groups.reduce((total, group) => total + group.count, 0),
    groups,
  }
}

export function buildOwnershipInboxQuery({
  teamId = 'all',
  projectId = 'all',
  limit = 50,
  cursor = null,
} = {}) {
  const params = new URLSearchParams()
  if (teamId && teamId !== 'all') params.set('teamId', teamId)
  if (projectId && projectId !== 'all') params.set('projectIds', projectId)
  params.set('limit', String(Math.max(1, Math.min(200, Number(limit) || 50))))
  if (cursor) params.set('cursor', cursor)
  return params.toString()
}

export function ownershipInboxReasonLabel(reason) {
  const labels = {
    TASK_OWNERSHIP_REQUIRED: '尚未确定分支归属',
    TASK_OWNERSHIP_MISMATCH: '任务分支与来源空间不一致',
    TASK_MERGE_EVIDENCE_REQUIRED: '缺少基线合入证据',
    TASK_MERGE_EVIDENCE_INVALID: '基线合入证据无效',
    TASK_OWNED_BY_BASELINE: '任务已由基线分支接管',
  }
  const key = text(reason)
  return labels[key] || key || '等待确认任务归属'
}
