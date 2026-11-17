export type RefreshCoordinator = {
  activate: () => void
  request: () => Promise<void>
  dispose: () => void
}

export function createRefreshCoordinator(run: () => Promise<void>): RefreshCoordinator
