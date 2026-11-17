export type OwnershipInboxSourceClient = {
  displayName: string
  username: string
}

export type OwnershipInboxItem = {
  projectId: string
  projectName: string
  taskId: string
  taskDir: string
  title: string
  reason: string
  sourceBranches: string[]
  sourceClients: OwnershipInboxSourceClient[]
  firstSeenAt: string
  lastSeenAt: string
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

export function ownershipInboxReasonLabel(reason: unknown): string
