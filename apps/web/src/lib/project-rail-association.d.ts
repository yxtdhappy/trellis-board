type ProjectRailTaskSpace = {
  id: string
}

type ProjectRailAssociation = {
  status: string
  liveSyncStatus: 'pending' | 'syncing' | 'ready' | 'error'
  deferredCount?: number
  lastErrorCode?: string | null
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
