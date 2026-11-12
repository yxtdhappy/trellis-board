export type ProjectInspection = {
  root: string
  repositoryName: string
  remoteUrl: string
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
