export type CompanySpecTemplateOption = {
  id: string
  label: string
  group: string
}

export type CompanySpecDetected = {
  projectType: string
  template: string
  evidence: string[]
  warning: string
}

export type CompanySpecAvailability = {
  available: boolean
  enabledByDefault: boolean
  name: string
  templates: CompanySpecTemplateOption[]
  detected: CompanySpecDetected | null
}

export type CompanySpecOutcome = {
  attempted: boolean
  applied: boolean
  projectType: string | null
  template: string | null
  warning: string | null
  evidence: string[]
}

export type ProjectInspection = {
  root: string
  repositoryName: string
  remoteUrl: string
  remoteIdentityKey: string
  developerName: string
  branchName: string
  head: string
  clean: boolean
  hasTrellis: boolean
  hasTasks: boolean
  hasCommittedTrellis: boolean
  requiresInitialization: boolean
  existingAgentTools: string[]
}

export function normalizeProjectInspection(value: unknown): ProjectInspection | null
export function normalizeCompanySpecAvailability(value: unknown): CompanySpecAvailability | null
export function normalizeCompanySpecOutcome(value: unknown): CompanySpecOutcome | null
