export type ChangedBy = { displayName?: string; deviceName?: string; occurredAt?: string }
export type ConflictFile = {
  path?: string
  revision?: number
  changeType?: string
  changedBy?: ChangedBy
}
export type Conflict = {
  conflictId?: string
  taskId?: string
  taskTitle?: string
  files?: ConflictFile[]
  suggestion?: string
}
export type DifferenceSide = { taskId?: string; taskDir?: string; title?: string }
export type Difference = {
  type: string
  taskId?: string
  taskDir?: string
  title?: string
  local?: DifferenceSide | null
  server?: DifferenceSide | null
}
export type DiffFile = {
  path?: string
  localContent?: string | null
  serverContent?: string | null
  changedBy?: ChangedBy | string
}
export type DiffResult = { taskId?: string; taskTitle?: string; files?: DiffFile[] }
export type OwnershipChoice = { taskSpaceId?: string; branchName?: string }
export type OwnershipItem = {
  taskId?: string
  taskDir: string
  title?: string
  branchName?: string | null
  choices?: OwnershipChoice[]
}
export type ControlEvent =
  | {
      type: 'initial_sync_review'
      taskSpaceId?: string
      projectName?: string
      branchName?: string
      differences?: Difference[]
    }
  | { type: 'task_file_conflict'; taskSpaceId?: string; conflict?: Conflict }
  | {
      type: 'task_ownership_review'
      taskSpaceId?: string
      branchName?: string
      items?: OwnershipItem[]
    }
  | {
      type: 'task_sync_error'
      taskSpaceId?: string
      projectName?: string
      branchName?: string
      taskDir?: string
      message?: string
      errorCode?: string
      serverCode?: string
    }
export type ReviewOption = { value: string; label: string }
export type Action = {
  label: string
  action: string
  variant?: 'default' | 'destructive' | 'outline'
}
