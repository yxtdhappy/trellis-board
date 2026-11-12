function text(value) {
  return typeof value === 'string' ? value : ''
}

function stringList(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []
}

export function normalizeProjectInspection(value) {
  if (!value || typeof value !== 'object') return null
  const outer = value
  const project = outer.project && typeof outer.project === 'object' ? outer.project : outer
  const root = text(project.root)
  const remoteUrl = text(project.remoteUrl)
  const branchName = text(project.branchName)
  if (!root || !remoteUrl || !branchName) return null
  return {
    root,
    repositoryName: text(project.repositoryName) || '本地项目',
    remoteUrl,
    branchName,
    head: text(project.head),
    clean: project.clean === true,
    hasTrellis: project.hasTrellis === true,
    hasTasks: project.hasTasks === true,
    hasCommittedTrellis: project.hasCommittedTrellis === true,
    requiresInitialization: project.requiresInitialization === true,
    existingAgentTools: stringList(project.existingAgentTools),
  }
}
