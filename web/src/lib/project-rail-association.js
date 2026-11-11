const LIVE_SYNC_PRIORITY = {
  error: 4,
  syncing: 3,
  pending: 2,
  ready: 1,
}

function associationPriority(association) {
  if (!association) return 0
  if (association.status !== 'approved') return 5
  return LIVE_SYNC_PRIORITY[association.liveSyncStatus] || LIVE_SYNC_PRIORITY.pending
}

export function selectProjectAssociation(project, associations) {
  const candidates = (Array.isArray(project?.taskSpaces) ? project.taskSpaces : [])
    .map((taskSpace) => associations.get(taskSpace?.id))
    .filter(Boolean)
  return candidates.reduce(
    (selected, candidate) =>
      associationPriority(candidate) > associationPriority(selected) ? candidate : selected,
    undefined,
  )
}
