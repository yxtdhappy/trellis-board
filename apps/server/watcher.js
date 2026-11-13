import {
  createTrellisWatcher,
  isRelevantTrellisChange,
  normalizeWatchPath,
} from '@trellis-board/shared/trellis-watcher.js'

export { isRelevantTrellisChange, normalizeWatchPath }

export function createWatchRuntime(options = {}) {
  let lastEvent = null
  const runtime = createTrellisWatcher({
    ...options,
    onChange(events) {
      for (const event of events) {
        lastEvent = event
        options.onChange?.(event)
      }
    },
  })
  return {
    get watchedRepositories() {
      return runtime.watchedRepositories
    },
    status() {
      return {
        ...runtime.status(),
        lastEvent,
      }
    },
    close: runtime.close,
  }
}
