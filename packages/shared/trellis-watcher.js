import fs from 'node:fs'
import path from 'node:path'
import { watch as chokidarWatch } from 'chokidar'

export const WATCHED_TRELLIS_ROOTS = Object.freeze(['tasks', 'workspace'])
const DEFAULT_RELEVANT_ROOTS = Object.freeze([...WATCHED_TRELLIS_ROOTS, '.developer'])

export function normalizeWatchPath(value) {
  if (value == null) return ''
  return String(value)
    .replaceAll('\\', '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+|\/+$/g, '')
}

function relevantPath(value, roots = DEFAULT_RELEVANT_ROOTS) {
  const relativePath = normalizeWatchPath(value)
  if (!relativePath) return null
  if (roots.includes('.developer') && relativePath === '.developer') return relativePath
  const root = roots.find(
    (candidate) => relativePath === candidate || relativePath.startsWith(`${candidate}/`),
  )
  return root ? relativePath : null
}

export function isRelevantTrellisChange(value, roots = DEFAULT_RELEVANT_ROOTS) {
  return Boolean(relevantPath(value, roots))
}

export function createTrellisWatcher({
  repositories,
  onChange,
  onError = () => {},
  watch = chokidarWatch,
  debounceMs = 0,
  roots = DEFAULT_RELEVANT_ROOTS,
}) {
  let watchers = []
  let watchedRepositories = []
  let lastEvent = null
  let eventsSeen = 0
  let closed = false
  let ready = false
  let pending = []
  let timer = null
  let readyPromise = Promise.resolve()
  const errors = new Map()
  const watchedRoots = [...new Set(roots)]

  const emit = () => {
    timer = null
    if (!pending.length || closed) return
    const events = pending
    pending = []
    onChange(events)
  }

  const enqueue = (event) => {
    lastEvent = event
    eventsSeen += 1
    pending.push(event)
    if (debounceMs <= 0) {
      emit()
      return
    }
    clearTimeout(timer)
    timer = setTimeout(emit, debounceMs)
    timer.unref?.()
  }

  function recordError(repository, error) {
    const record = {
      repositoryId: repository.id,
      message: error instanceof Error ? error.message : String(error),
      at: new Date().toISOString(),
    }
    errors.set(repository.id, record)
    onError(record)
  }

  async function closeWatchers() {
    const current = watchers
    watchers = []
    watchedRepositories = []
    ready = false
    await Promise.all(current.map((watcher) => watcher.close()))
  }

  function watchRepository(root, repository) {
    return new Promise((resolve) => {
      let watcher
      try {
        watcher = watch(root, { ignoreInitial: true, persistent: true, depth: 20 })
      } catch (error) {
        recordError(repository, error)
        resolve()
        return
      }
      watcher.on('all', (eventType, changedPath) => {
        const relativePath = normalizeWatchPath(path.relative(root, changedPath))
        if (relativePath && !isRelevantTrellisChange(relativePath, watchedRoots)) return
        enqueue({
          repositoryId: repository.id,
          repositoryName: repository.name,
          eventType,
          relativePath,
          trellisPath: relativePath ? `.trellis/${relativePath}` : '',
          filePath: relativePath ? path.join(root, ...relativePath.split('/')) : root,
          observedAt: new Date().toISOString(),
        })
      })
      watcher.on('error', (error) => {
        recordError(repository, error)
        resolve()
      })
      watcher.on('ready', resolve)
      watchers.push(watcher)
      watchedRepositories.push(repository.id)
    })
  }

  const rebuild = (nextRepositories = []) => {
    readyPromise = (async () => {
      await closeWatchers()
      pending = []
      clearTimeout(timer)
      timer = null
      if (closed) return
      const starting = []
      for (const repository of nextRepositories) {
        const root = path.join(repository.path, '.trellis')
        if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) continue
        starting.push(watchRepository(root, repository))
      }
      await Promise.all(starting)
      ready = !closed
    })()
    return readyPromise
  }

  void rebuild(repositories)

  return {
    get watchedRepositories() {
      return [...watchedRepositories]
    },
    rebuild,
    ready() {
      return readyPromise
    },
    status() {
      return {
        enabled: ready && watchers.length > 0,
        watchedRepositories: [...watchedRepositories],
        watchedRoots: [...watchedRoots],
        eventsSeen,
        lastEvent,
        errors: [...errors.values()],
      }
    },
    async close() {
      if (closed) return
      closed = true
      pending = []
      clearTimeout(timer)
      timer = null
      await closeWatchers()
    },
  }
}
