type ProjectRailTaskSpace = {
  id: string
}

type ProjectRailAssociation = {
  status: string
  liveSyncStatus: 'pending' | 'syncing' | 'ready' | 'error'
  deferredCount?: number
  initialReviewPending?: boolean
  ownershipPausedCount?: number
  ownershipPendingCount?: number
  lastErrorCode?: string | null
  lastError?: string | null
}

type ProjectRailTaskSpaceListener = {
  listenerState?: 'online' | 'inactive' | 'unassociated' | 'unknown_legacy' | 'disabled'
  onlineListenerCount?: number
  approvedBindingCount?: number
}

export type ProjectListenerView = {
  state: NonNullable<ProjectRailTaskSpaceListener['listenerState']>
  counts: string
  label: string
  detail: string
  dotClassName: string
  textClassName: string
}

export function desktopStateTopics(payload: unknown): Set<'associations' | 'sidecar'>

export function associationSignature(associations: unknown[]): string

export function associationOwnershipCounts<TAssociation extends ProjectRailAssociation>(
  association: TAssociation | undefined,
): {
  pausedCount: number
  pendingCount: number
  totalCount: number
}

export function isBranchAssociationPaused(association: ProjectRailAssociation | undefined): boolean

export function countProjectPausedBranches<
  TProject extends { taskSpaces?: ProjectRailTaskSpace[] },
  TAssociation extends ProjectRailAssociation,
>(project: TProject, associations: ReadonlyMap<string, TAssociation>): number

export function detachPendingAssociationView(
  association:
    | Pick<ProjectRailAssociation, 'status' | 'liveSyncStatus' | 'lastErrorCode' | 'lastError'>
    | null
    | undefined,
): Omit<ProjectListenerView, 'state' | 'counts'>

export function projectListenerView(
  taskSpace: ProjectRailTaskSpaceListener | null | undefined,
): ProjectListenerView | null

export function selectProjectAssociation<
  TProject extends { taskSpaces?: ProjectRailTaskSpace[] },
  TAssociation extends ProjectRailAssociation,
>(
  project: TProject,
  associations: ReadonlyMap<string, TAssociation>,
  preferredTaskSpaceId?: string,
): TAssociation | undefined
