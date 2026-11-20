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
    taskSpaceId: text(row.taskSpaceId),
    title: text(row.title) || fallbackTitle,
    reason: text(row.reason) || 'TASK_OWNERSHIP_REQUIRED',
    assigneeUserId: text(row.assigneeUserId) || null,
    assigneeDevId: text(row.assigneeDevId) || null,
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

export function normalizeOwnershipBranches(taskSpaces) {
  if (!Array.isArray(taskSpaces)) return []
  const branches = []
  const seen = new Set()
  for (const space of taskSpaces) {
    if (!space || typeof space !== 'object') continue
    const taskSpaceId = text(space.id)
    const branchName = text(space.branchName)
    if (!taskSpaceId || !branchName || seen.has(taskSpaceId)) continue
    if (space.status && space.status !== 'active') continue
    seen.add(taskSpaceId)
    branches.push({ taskSpaceId, branchName })
  }
  return branches
}

export function defaultOwnershipBranch(item, branches) {
  const options = Array.isArray(branches) ? branches : []
  for (const branch of Array.isArray(item?.sourceBranches) ? item.sourceBranches : []) {
    const match = options.find((option) => option.branchName === text(branch))
    if (match) return match
  }
  return options[0] || null
}

export function ownershipAssignAvailability({
  item,
  currentUserId,
  isTauri = false,
  branches = [],
  association = null,
} = {}) {
  const options = Array.isArray(branches) ? branches : []
  const unavailable = (reason) => ({ available: false, reason, branches: options })
  if (!item) return unavailable('待归属任务信息不完整')
  if (!text(item.assigneeUserId)) return unavailable('负责人未知，等待来源客户端重新同步')
  if (!text(currentUserId) || text(item.assigneeUserId) !== text(currentUserId)) {
    return unavailable('仅任务负责人可操作')
  }
  if (!isTauri) return unavailable('请在桌面客户端中操作')
  if (!text(item.taskSpaceId)) return unavailable('缺少来源任务空间，无法定位本地任务')
  if (!association) return unavailable('请在本机关联该分支后操作')
  if (association.status !== 'approved') return unavailable('当前本地关联已失效，请重新关联')
  if (association.readOnly) return unavailable('当前关联为只读，不能修改任务归属')
  if (association.detachPending) return unavailable('当前分支正在解绑，请稍后再试')
  if (
    association.lastErrorCode === 'BRANCH_MISMATCH' ||
    association.lastErrorCode === 'BINDING_BRANCH_MISMATCH'
  ) {
    return unavailable('当前 Git 分支与关联分支不一致，请切回绑定分支后重试')
  }
  if (!options.length) return unavailable('当前项目没有可用的任务空间分支')
  return { available: true, reason: '', branches: options }
}

export function ownershipAssignErrorMessage(error) {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : typeof error?.message === 'string'
          ? error.message
          : ''
  const message = raw.replace(/^Error:\s*/i, '').trim()
  if (!message) return '任务归属失败，请稍后重试'
  if (message.includes('无效的任务目录')) return '本机没有该任务副本，请在负责人本机操作'
  if (message.includes('有效分支')) return '所选分支不属于当前项目的有效任务空间'
  return message
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
