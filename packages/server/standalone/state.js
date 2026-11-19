import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getDefaultDatabase } from '../database.js'
import { STAGE_IDS } from '../metadata.js'
import { createRepositoryStore } from '../repositories.js'
import { createPersistenceStore } from '../persistence.js'
import { createExecutionStore } from '../execution-store.js'
import { createBoardEventService } from '../board-events.js'

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const PATHS = {
  serverDir,
  publicDir: path.join(serverDir, 'public'),
  // 宿主提供给插件面板的通用 UI 资源（combo 等），与插件开关无关
  pluginUiDir: path.join(serverDir, 'plugin-ui'),
  workerFile: path.join(serverDir, 'scan-worker.js'),
  folderPickerFile: path.join(serverDir, 'pick-folders.ps1'),
}

export const SCAN_SCHEMA_VERSION = 11
export const WATCH_DEBOUNCE_MS = Math.max(100, Number(process.env.TRELLIS_WATCH_DEBOUNCE_MS || 400))

// 独立运行时的全部可变状态：以前是模块级 let，多个状态互相依赖且无法在测试里隔离。
export function createStandaloneState({
  port = Number(process.env.PORT || 4317),
  logger = console,
} = {}) {
  return {
    port,
    logger,
    database: null,
    persistence: null,
    repositoryStore: null,
    executionStore: null,
    boardCache: null,
    inflightScan: null,
    queuedRefresh: null,
    pendingWatchEvents: [],
    watchRuntime: null,
    watchDebounceTimer: null,
    folderPickerActive: false,
    scanWorkerRuntime: null,
    pluginRuntime: null,
    boardEventService: null,
    nextScanRequestId: 0,
    pendingScanRequests: new Map(),
  }
}

export function initializeStandaloneState(state, { port, logger } = {}) {
  if (port !== undefined) state.port = port
  if (logger) state.logger = logger
  if (state.database) return state
  state.database = getDefaultDatabase({ logger: state.logger })
  state.persistence = createPersistenceStore()
  state.repositoryStore = createRepositoryStore()
  state.executionStore = createExecutionStore({ db: state.database, stageIds: STAGE_IDS })
  state.boardEventService = createBoardEventService()
  return state
}
