import { createWatchRuntime } from '../watcher.js'
import { getRepositories } from '../repositories.js'
import { WATCH_DEBOUNCE_MS } from './state.js'
import { writeBoardState } from './board-state.js'
import { refreshBoardFromFiles } from './refresh.js'

export function scheduleWatchRefresh(state, event) {
  state.pendingWatchEvents.push(event)
  clearTimeout(state.watchDebounceTimer)
  state.watchDebounceTimer = setTimeout(() => {
    state.watchDebounceTimer = null
    const events = state.pendingWatchEvents
    state.pendingWatchEvents = []
    refreshBoardFromFiles(state, 'watcher', events).catch((error) => {
      state.logger.error('文件变更后自动刷新失败', error)
    })
  }, WATCH_DEBOUNCE_MS)
}

export async function startFileWatcher(state) {
  let status
  try {
    state.watchRuntime = createWatchRuntime({
      repositories: getRepositories(),
      onChange: (event) => scheduleWatchRefresh(state, event),
      onError: (error) => state.logger.error('Trellis 文件监听失败', error),
    })
    // chokidar 的初始扫描是异步的，就绪前的 status() 一定是 disabled。
    await state.watchRuntime.ready()
    status = state.watchRuntime.status()
  } catch (error) {
    state.logger.error('启动 Trellis 文件监听失败', error)
    return
  }
  try {
    writeBoardState(state, {
      watcherStartedAt: new Date().toISOString(),
      watcherEnabled: status.enabled,
    })
    state.logger.log(
      `Trellis watcher: ${status.enabled ? 'enabled' : 'disabled'}, ` +
        `${status.watchedRepositories.length} repositories, debounce=${WATCH_DEBOUNCE_MS}ms`,
    )
  } catch (error) {
    state.logger.error('启动 Trellis 文件监听后保存状态失败', error)
    throw error
  }
}

export function restartFileWatcher(state) {
  const previous = state.watchRuntime
  state.watchRuntime = null
  previous?.close().catch((error) => {
    state.logger.error('关闭旧 Trellis 文件监听失败', error)
  })
  void startFileWatcher(state)
}
