const LIVE_SYNC_PRIORITY = {
  error: 4,
  syncing: 3,
  pending: 2,
  ready: 1,
}

function associationPriority(association) {
  if (!association) return 0
  if (association.status !== 'approved') return 5
  const syncPriority = LIVE_SYNC_PRIORITY[association.liveSyncStatus] || LIVE_SYNC_PRIORITY.pending
  return Math.max(syncPriority, association.deferredCount > 0 ? 2.5 : 0)
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
