function text(value) {
  return typeof value === 'string' ? value : ''
}

function stringList(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []
}

function templateOption(value) {
  if (!value || typeof value !== 'object') return null
  const id = text(value.id)
  if (!id) return null
  return {
    id,
    label: text(value.label) || id,
    group: text(value.group) || 'other',
  }
}

function detectedInfo(value) {
  if (!value || typeof value !== 'object') return null
  return {
    projectType: text(value.projectType),
    template: text(value.template),
    evidence: stringList(value.evidence),
    warning: text(value.warning),
  }
}

export function normalizeCompanySpecAvailability(value) {
  if (!value || typeof value !== 'object') return null
  const outer = value
  const project = outer.project && typeof outer.project === 'object' ? outer.project : outer
  if (!project || typeof project !== 'object') return null
  const raw = outer.companySpec ?? outer.company_spec ?? project.companySpec ?? project.company_spec
  if (!raw || typeof raw !== 'object') return null
  return {
    available: raw.available === true,
    enabledByDefault: raw.enabledByDefault === true,
    name: text(raw.name),
    templates: Array.isArray(raw.templates)
      ? raw.templates.map(templateOption).filter(Boolean)
      : [],
    detected: detectedInfo(raw.detected),
  }
}

export function normalizeCompanySpecOutcome(value) {
  if (!value || typeof value !== 'object') return null
  const outer = value
  const raw = outer.companySpec ?? outer.company_spec
  if (!raw || typeof raw !== 'object') return null
  return {
    attempted: raw.attempted === true,
    applied: raw.applied === true,
    projectType: text(raw.projectType) || null,
    template: text(raw.template) || null,
    warning: text(raw.warning) || null,
    evidence: stringList(raw.evidence),
  }
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
    remoteIdentityKey: text(project.remoteIdentityKey),
    developerName: text(project.developerName),
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
