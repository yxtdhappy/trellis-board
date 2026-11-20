export type OwnershipInboxSourceClient = {
  displayName: string
  username: string
}

export type OwnershipInboxItem = {
  projectId: string
  projectName: string
  taskId: string
  taskDir: string
  taskSpaceId: string
  title: string
  reason: string
  assigneeUserId: string | null
  assigneeDevId: string | null
  sourceBranches: string[]
  sourceClients: OwnershipInboxSourceClient[]
  firstSeenAt: string
  lastSeenAt: string
}

export type OwnershipBranchOption = {
  taskSpaceId: string
  branchName: string
}

export type OwnershipLocalAssociation = {
  status: string
  readOnly: boolean
  detachPending: boolean
  lastErrorCode: string | null
}

export type OwnershipAssignAvailability = {
  available: boolean
  reason: string
  branches: OwnershipBranchOption[]
}

export type OwnershipInboxPage = {
  items: OwnershipInboxItem[]
  total: number
  nextCursor: string | null
}

export type OwnershipInboxProjectGroup = {
  projectId: string
  projectName: string
  count: number
}

export type OwnershipInboxSummary = {
  count: number
  groups: OwnershipInboxProjectGroup[]
}

export function ownershipInboxItemKey(item: OwnershipInboxItem): string

export function mergeOwnershipInboxItems(
  current: OwnershipInboxItem[] | null | undefined,
  next: OwnershipInboxItem[] | null | undefined,
): OwnershipInboxItem[]

export function normalizeOwnershipInboxCount(value: unknown): number

export function normalizeOwnershipInboxPage(payload: unknown): OwnershipInboxPage

export function summarizeOwnershipInbox(
  projects: Array<{ id?: string; name?: string; ownershipInboxCount?: unknown }> | null | undefined,
  projectId?: string,
): OwnershipInboxSummary

export function buildOwnershipInboxQuery(input?: {
  teamId?: string
  projectId?: string
  limit?: number
  cursor?: string | null
}): string

export function normalizeOwnershipBranches(
  taskSpaces: Array<{ id?: string; branchName?: string; status?: string }> | null | undefined,
): OwnershipBranchOption[]

export function defaultOwnershipBranch(
  item: OwnershipInboxItem | null | undefined,
  branches: OwnershipBranchOption[] | null | undefined,
): OwnershipBranchOption | null

export function ownershipAssignAvailability(input?: {
  item?: OwnershipInboxItem | null
  currentUserId?: string
  isTauri?: boolean
  branches?: OwnershipBranchOption[] | null
  association?: OwnershipLocalAssociation | null
}): OwnershipAssignAvailability

export function ownershipAssignErrorMessage(error: unknown): string

export function ownershipInboxReasonLabel(reason: unknown): string
