const LIVE_SYNC_PRIORITY = {
  error: 4,
  syncing: 3,
  pending: 2,
  ready: 1,
}

const LISTENER_STATES = new Set([
  'online',
  'inactive',
  'unassociated',
  'unknown_legacy',
  'disabled',
])

export function associationOwnershipCounts(association) {
  const count = (value) => (Number.isSafeInteger(value) && value > 0 ? value : 0)
  const pausedCount = count(association?.ownershipPausedCount)
  const pendingCount = count(association?.ownershipPendingCount)
  return {
    pausedCount,
    pendingCount,
    totalCount: pausedCount + pendingCount,
  }
}

function associationPriority(association) {
  if (!association) return 0
  if (association.status !== 'approved') return 5
  const syncPriority = LIVE_SYNC_PRIORITY[association.liveSyncStatus] || LIVE_SYNC_PRIORITY.pending
  return Math.max(
    syncPriority,
    association.deferredCount > 0 || associationOwnershipCounts(association).totalCount > 0
      ? 2.5
      : 0,
  )
}

export function isBranchAssociationPaused(association) {
  return (
    association?.status === 'approved' &&
    (association.lastErrorCode === 'BRANCH_MISMATCH' ||
      association.lastErrorCode === 'BINDING_BRANCH_MISMATCH')
  )
}

export function countProjectPausedBranches(project, associations) {
  const taskSpaces = Array.isArray(project?.taskSpaces) ? project.taskSpaces : []
  return taskSpaces.reduce(
    (count, taskSpace) =>
      count + (isBranchAssociationPaused(associations.get(taskSpace?.id)) ? 1 : 0),
    0,
  )
}

export function detachPendingAssociationView(association) {
  const error = association?.lastError?.trim()
  return {
    label: '已关联 · 服务端解绑待确认',
    detail: error
      ? `本地已停止同步，服务端未确认：${error}`
      : '本地已停止同步，客户端会自动重试服务端解绑。',
    dotClassName: 'bg-warning',
    textClassName: 'text-warning',
  }
}

export function projectListenerView(taskSpace) {
  const state = taskSpace?.listenerState
  if (!LISTENER_STATES.has(state)) return null
  const onlineListenerCount = Math.max(0, Number(taskSpace?.onlineListenerCount) || 0)
  const approvedBindingCount = Math.max(0, Number(taskSpace?.approvedBindingCount) || 0)
  const counts = `在线监听 ${onlineListenerCount} / 已关联 ${approvedBindingCount}`
  if (state === 'online') {
    return {
      state,
      counts,
      label: '在线监听',
      detail: '至少一个客户端正在监听该分支。',
      dotClassName: 'bg-primary',
      textClassName: 'text-muted-foreground',
    }
  }
  if (state === 'inactive') {
    return {
      state,
      counts,
      label: '当前未激活，关联保留',
      detail: '当前没有客户端监听该分支，已批准的关联仍然保留。',
      dotClassName: 'bg-warning',
      textClassName: 'text-warning',
    }
  }
  if (state === 'unassociated') {
    return {
      state,
      counts,
      label: '无客户端关联',
      detail: '所有客户端都已主动解除该分支关联。',
      dotClassName: 'bg-destructive',
      textClassName: 'text-destructive',
    }
  }
  if (state === 'unknown_legacy') {
    return {
      state,
      counts,
      label: '旧客户端，监听状态未知',
      detail: '客户端未上报监听状态，请升级客户端或服务端。',
      dotClassName: 'bg-warning',
      textClassName: 'text-warning',
    }
  }
  return {
    state,
    counts,
    label: '已停用',
    detail: '任务空间已停用，不参与在线监听告警。',
    dotClassName: 'bg-muted-foreground/50',
    textClassName: 'text-muted-foreground',
  }
}

export function selectProjectAssociation(project, associations, preferredTaskSpaceId) {
  const taskSpaces = Array.isArray(project?.taskSpaces) ? project.taskSpaces : []
  const candidates = taskSpaces.map((taskSpace) => associations.get(taskSpace?.id)).filter(Boolean)
  const hasPreferredTaskSpace = taskSpaces.some(
    (taskSpace) => taskSpace?.id === preferredTaskSpaceId,
  )
  if (hasPreferredTaskSpace) return associations.get(preferredTaskSpaceId)
  return candidates.reduce(
    (selected, candidate) =>
      associationPriority(candidate) > associationPriority(selected) ? candidate : selected,
    undefined,
  )
}
