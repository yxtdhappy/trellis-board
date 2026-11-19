import { getRepositories } from '../repositories.js'
import { publishRepositoryChange } from '../plugins/repository-events.js'
import { writeBoardState } from './board-state.js'
import { refreshBoardFromFiles } from './refresh.js'
import { restartFileWatcher } from './watcher.js'

export function repositoryInputs(payload) {
  if (Array.isArray(payload.paths)) {
    if (!payload.paths.length) throw new Error('请至少选择一个项目文件夹')
    return payload.paths.map((repoPath) => ({ path: repoPath }))
  }
  if (Array.isArray(payload.repositories)) {
    if (!payload.repositories.length) throw new Error('请至少选择一个项目文件夹')
    return payload.repositories
  }
  return [payload]
}

export async function refreshAfterRepositoryChange(state, action, repositories) {
  const changed = Array.isArray(repositories) ? repositories : [repositories]
  writeBoardState(state, {
    repositoriesUpdatedAt: new Date().toISOString(),
    repositoriesUpdatedAction: action,
    repositoriesUpdatedIds: changed.map((repository) => repository.id),
  })
  restartFileWatcher(state)
  state.pluginRuntime?.setRepositories?.(getRepositories())

  // 如果扫描在项目白名单变更前启动，先等旧快照结束，再按新白名单完整扫描一次。
  if (state.inflightScan) await state.inflightScan.catch(() => {})
  state.boardCache = null
  return refreshBoardFromFiles(state, 'repositories', null, {
    refreshRepositoryMetadata: true,
  })
}

export function createRepositoryService(state) {
  return {
    list: () => state.repositoryStore.list(),
    async addMany(inputs) {
      const added = state.repositoryStore.addMany(inputs)
      await refreshAfterRepositoryChange(state, 'add', added)
      publishRepositoryChange(state.pluginRuntime, 'add', added)
      return { added }
    },
    async remove(input) {
      const removed = state.repositoryStore.remove(input)
      await refreshAfterRepositoryChange(state, 'remove', [removed])
      publishRepositoryChange(state.pluginRuntime, 'remove', [removed])
      return { removed }
    },
  }
}
