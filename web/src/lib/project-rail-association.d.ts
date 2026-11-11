type ProjectRailTaskSpace = {
  id: string
}

type ProjectRailAssociation = {
  status: string
  liveSyncStatus: 'pending' | 'syncing' | 'ready' | 'error'
}

export function selectProjectAssociation<
  TProject extends { taskSpaces?: ProjectRailTaskSpace[] },
  TAssociation extends ProjectRailAssociation,
>(project: TProject, associations: ReadonlyMap<string, TAssociation>): TAssociation | undefined
