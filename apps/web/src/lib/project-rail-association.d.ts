type ProjectRailTaskSpace = {
  id: string
}

type ProjectRailAssociation = {
  status: string
  liveSyncStatus: 'pending' | 'syncing' | 'ready' | 'error'
  deferredCount?: number
  ownershipPausedCount?: number
  ownershipPendingCount?: number
  lastErrorCode?: string | null
}

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

export function selectProjectAssociation<
  TProject extends { taskSpaces?: ProjectRailTaskSpace[] },
  TAssociation extends ProjectRailAssociation,
>(
  project: TProject,
  associations: ReadonlyMap<string, TAssociation>,
  preferredTaskSpaceId?: string,
): TAssociation | undefined
