import fs from 'node:fs'
import path from 'node:path'

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
  watch = fs.watch,
  debounceMs = 0,
  roots = DEFAULT_RELEVANT_ROOTS,
}) {
  let watchers = []
  let watchedRepositories = []
  let lastEvent = null
  let eventsSeen = 0
  let closed = false
  let pending = []
  let timer = null
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
    if (timer) clearTimeout(timer)
    timer = setTimeout(emit, debounceMs)
    timer.unref?.()
  }

  const closeWatchers = () => {
    watchers.forEach((watcher) => watcher.close())
    watchers = []
    watchedRepositories = []
  }

  const rebuild = (nextRepositories = []) => {
    closeWatchers()
    pending = []
    if (timer) clearTimeout(timer)
    timer = null
    for (const repository of nextRepositories) {
      const root = path.join(repository.path, '.trellis')
      if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) continue
      try {
        const watcher = watch(
          root,
          { recursive: true, encoding: 'utf8', persistent: true },
          (eventType, filename) => {
            const relativePath = normalizeWatchPath(filename)
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
          },
        )
        watcher.on('error', (error) => {
          const record = {
            repositoryId: repository.id,
            message: error instanceof Error ? error.message : String(error),
            at: new Date().toISOString(),
          }
          errors.set(repository.id, record)
          onError(record)
        })
        watchers.push(watcher)
        watchedRepositories.push(repository.id)
      } catch (error) {
        const record = {
          repositoryId: repository.id,
          message: error instanceof Error ? error.message : String(error),
          at: new Date().toISOString(),
        }
        errors.set(repository.id, record)
        onError(record)
      }
    }
  }

  rebuild(repositories)

  return {
    get watchedRepositories() {
      return [...watchedRepositories]
    },
    rebuild,
    status() {
      return {
        enabled: watchers.length > 0,
        watchedRepositories: [...watchedRepositories],
        watchedRoots: [...watchedRoots],
        eventsSeen,
        lastEvent,
        errors: [...errors.values()],
      }
    },
    close() {
      if (closed) return
      closed = true
      closeWatchers()
      pending = []
      if (timer) clearTimeout(timer)
      timer = null
    },
  }
}
