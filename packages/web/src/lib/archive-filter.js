export function resolveArchiveProjectId(projectId, projects) {
  if (!projectId || projectId === 'all') return 'all'
  return projects.some((project) => project.id === projectId) ? projectId : 'all'
}

export function archiveProjectAfterTeamChange(projectId, teamId, projects) {
  if (projectId === 'all') return projectId
  const inTeam = projects.some(
    (project) => project.id === projectId && (teamId === 'all' || project.teamId === teamId),
  )
  return inTeam ? projectId : 'all'
}
