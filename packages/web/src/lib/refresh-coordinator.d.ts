export type RefreshCoordinator = {
  request: () => Promise<void>
  dispose: () => void
}

export function createRefreshCoordinator(run: () => Promise<void>): RefreshCoordinator
