import type { TaskSpace } from '@/api/board'

export type Project = {
  id: string
  name: string
  teamId?: string | null
  syncBranch?: string | null
  teamName?: string | null
  taskSpaces?: TaskSpace[]
  trellisDevId?: string | null
  ownershipInboxCount?: number
}

export type LiveSyncStatus = 'pending' | 'syncing' | 'ready' | 'error'

export type LocalAssociation = {
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
  deferredCount: number
  deferredTaskDirs: string[]
  deferredTasks?: Array<{ taskDir: string; title?: string | null }>
  ownershipPausedCount: number
  ownershipPausedTaskDirs: string[]
  ownershipPendingCount: number
  ownershipPendingTaskDirs: string[]
  pendingUploadCount: number
  pendingUploadTaskDirs: string[]
  pendingRejectedCount: number
  pendingRejectedTaskDirs: string[]
  conflictPendingCount: number
  conflictPendingTaskDirs: string[]
  detachPending: boolean
  initialReviewPending: boolean
}

export type WorktreeStatus = {
  path: string
  branchName: string
  taskSpaceId: string | null
  autoManaged: boolean
  status: string
  visibility: 'hidden' | 'visible' | 'hidden_empty' | 'hidden_missing'
  archiveSyncPending: boolean
  activeTaskCount: number
  serverActiveTaskCount: number
  lastError: string | null
  lastVisibilityError: string | null
  lastVisibilityAt: string | null
}

export type SidecarStatus = {
  running: boolean
  paused: boolean
}

export type ProjectAssociationView = {
  label: string
  detail: string | null
  dotClassName: string
  textClassName: string
}

export type TauriInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>

export type ProjectRailProps = {
  projects: Project[]
  teams: { id: string; name: string }[]
  defaultDeveloperId: string
  current: string
  teamId: string
  onSelect: (id: string) => void
  currentTaskSpace: string
  onSelectTaskSpace: (taskSpaceId: string) => void
  ownershipInboxOpen: boolean
  onSelectOwnershipInbox: (projectId: string) => void
  onManage: () => void
  manageEnabled?: boolean
  syncLabel: string
  syncLive: boolean
  refreshing: boolean
  onRefresh: () => void
  onAssociationsChange?: (associations: LocalAssociation[]) => void
}
