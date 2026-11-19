export type TeamOption = {
  id: string
  name: string
}

export type PushState = {
  state: string
  message?: string
  dirtySummary?: string
}

export type SnapshotDifference = {
  type: string
  taskId: string | null
  taskDir: string | null
}

export type PreflightCounts = {
  same: number
  localOnly: number
  serverOnly: number
  conflicts: number
  invalid: number
}

export type PreflightResult = {
  status: string
  revision: number
  differences: SnapshotDifference[]
  counts: PreflightCounts
}

export type InitialSyncMode = 'bootstrap' | 'safe' | 'review'

export type LiveSyncStatus = 'pending' | 'syncing' | 'ready' | 'error'

export type Association = {
  projectId: string
  taskSpaceId: string
  repoPath: string
  displayName: string
  branchName: string
  teamId: string | null
  status: string
  readOnly: boolean
  lastErrorCode: string | null
  lastError: string | null
  liveSyncStatus: LiveSyncStatus
  liveSyncError: string | null
}

export type TauriInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>

export type ProjectIdentity = {
  id: string
  remoteIdentityHash?: string | null
  trellisDevId?: string | null
}

export type ProjectOnboardingDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  path: string
  projects: ProjectIdentity[]
  teams: TeamOption[]
  defaultTeamId: string
  defaultDeveloperId: string
  invoke: TauriInvoke
  onAssociated: (association: Association) => void
}
