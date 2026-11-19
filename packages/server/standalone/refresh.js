import { projectBoardExecution } from '../execution-projection.js'
import { SCAN_SCHEMA_VERSION } from './state.js'
import { readBoardState, writeBoardState } from './board-state.js'
import { runScanWorker } from './scan-worker.js'

export function watchEventList(value) {
  if (Array.isArray(value)) return value.filter(Boolean)
  return value ? [value] : []
}

export function latestWatchEvent(value) {
  return watchEventList(value).at(-1) || null
}

export function refreshBoardFromFiles(state, reason = 'manual', event = null, options = {}) {
  options = {
    ...options,
    events: [...(Array.isArray(options.events) ? options.events : []), ...watchEventList(event)],
  }
  if (state.inflightScan) {
    const queuedEvents = state.queuedRefresh ? watchEventList(state.queuedRefresh.event) : []
    const queuedOptions = state.queuedRefresh?.options || {}
    state.queuedRefresh = {
      reason,
      event: [...queuedEvents, ...watchEventList(event)],
      options: {
        ...queuedOptions,
        ...options,
        forceFull: Boolean(queuedOptions.forceFull || options.forceFull),
        refreshRepositoryMetadata: Boolean(
          queuedOptions.refreshRepositoryMetadata || options.refreshRepositoryMetadata,
        ),
        events: [
          ...(Array.isArray(queuedOptions.events) ? queuedOptions.events : []),
          ...options.events,
        ],
      },
      queuedAt: new Date().toISOString(),
    }
    writeBoardState(state, {
      refreshQueued: true,
      refreshQueuedReason: reason,
    })
    return state.inflightScan
  }

  const initialReason = reason
  const initialEvent = event
  const initialOptions = options
  state.inflightScan = (async () => {
    let activeReason = initialReason
    let activeEvent = initialEvent
    let activeOptions = initialOptions
    let board = null

    do {
      writeBoardState(state, {
        refreshStartedAt: new Date().toISOString(),
        refreshReason: activeReason,
        refreshQueued: false,
        refreshQueuedReason: null,
        lastRefreshError: null,
      })
      const previousBoard = state.boardCache || readScanCache(state)
      const result = await runScanWorker(state, activeOptions)
      board = result.board
      const scannedAt = new Date().toISOString()
      state.persistence.writeScanCache(board, SCAN_SCHEMA_VERSION, {
        beforeCommit: () =>
          state.executionStore.recordScanObservationsInTransaction({
            tasks: board.tasks || [],
            previousTasks: activeOptions.suppressStageObservation ? [] : previousBoard?.tasks || [],
            occurredAt: scannedAt,
            actor: 'system',
          }),
      })
      state.boardCache = board
      writeBoardState(state, {
        lastRefreshAt: board.generatedAt,
        refreshFinishedAt: new Date().toISOString(),
        refreshReason: activeReason,
        lastRefreshTrigger: activeReason,
        refreshQueued: Boolean(state.queuedRefresh),
        refreshQueuedReason: state.queuedRefresh?.reason || null,
        lastWatchEvent:
          latestWatchEvent(activeEvent) || readBoardState(state).lastWatchEvent || null,
        lastScanStats: result.stats,
      })
      state.boardEventService?.publish({ generatedAt: board.generatedAt })
      state.pluginRuntime?.publishScan(previousBoard, board, result.stats, activeReason)

      if (state.queuedRefresh) {
        activeReason = state.queuedRefresh.reason
        activeEvent = state.queuedRefresh.event
        activeOptions = state.queuedRefresh.options || {}
        state.queuedRefresh = null
      } else {
        activeReason = null
        activeEvent = null
        activeOptions = {}
      }
    } while (activeReason)

    return board
  })()
    .catch((error) => {
      writeBoardState(state, {
        refreshFinishedAt: new Date().toISOString(),
        lastRefreshError: error instanceof Error ? error.message : String(error),
        refreshQueued: Boolean(state.queuedRefresh),
        refreshQueuedReason: state.queuedRefresh?.reason || null,
      })
      throw error
    })
    .finally(() => {
      state.inflightScan = null
      // The debounce can fire in the narrow window after the worker finishes
      // but before this promise settles. Drain that event instead of losing it.
      if (state.queuedRefresh && !state.watchDebounceTimer) {
        const next = state.queuedRefresh
        state.queuedRefresh = null
        refreshBoardFromFiles(state, next.reason, next.event, next.options).catch((error) => {
          state.logger.error('排队中的看板刷新失败', error)
        })
      }
    })
  return state.inflightScan
}

export function readScanCache(state) {
  return state.persistence.readScanCache(SCAN_SCHEMA_VERSION)
}

export function projectBoardWithExecution(state, board, source) {
  return withRefreshState(
    state,
    projectBoardExecution(
      board,
      state.executionStore.listSavedViews(),
      state.database,
      new Date(),
      {
        executionWipLimit: state.persistence.readExecutionWipLimit(),
      },
    ),
    source,
  )
}

export function withRefreshState(state, board, source) {
  const boardState = readBoardState(state)
  return {
    ...board,
    source,
    refreshReason: boardState.refreshReason || null,
    refreshQueued: Boolean(state.inflightScan || state.queuedRefresh || state.watchDebounceTimer),
    watcher: state.watchRuntime?.status() || {
      enabled: false,
      watchedRepositories: [],
      watchedRoots: [],
      eventsSeen: 0,
      lastEvent: null,
      errors: [],
    },
    servedAt: new Date().toISOString(),
  }
}

export async function getBoardWithBackgroundRefresh(state, forceRefresh = false) {
  if (forceRefresh) {
    return projectBoardWithExecution(
      state,
      await refreshBoardFromFiles(state, 'manual', null, {
        refreshRepositoryMetadata: true,
        forceFull: true,
      }),
      'fresh',
    )
  }
  const cached = readScanCache(state)
  if (!cached) {
    return projectBoardWithExecution(state, await refreshBoardFromFiles(state), 'fresh')
  }
  if (!state.boardCache && cached.tasks?.length) {
    state.boardCache = cached
  }
  return projectBoardWithExecution(state, cached, 'cache')
}
