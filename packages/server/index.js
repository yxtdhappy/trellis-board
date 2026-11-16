import './env-bootstrap.js'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { parseTeamConfig, dataDir, pluginsDir } from './config.js'
import {
  readJsonBody as readJsonBodyCommon,
  sendJson as sendJsonCommon,
  serveStatic as serveStaticCommon,
} from './http-common.js'
import { migrateLegacyRuntimeData } from './data-migration.js'
import { getDefaultDatabase } from './database.js'
import { createTeamRuntime } from './team/http.js'
import { STAGE_IDS, setManualStage } from './metadata.js'
import { assignTask, createTask } from './actions.js'
import { createRepositoryStore, getRepositories } from './repositories.js'
import { createPersistenceStore } from './persistence.js'
import { createWatchRuntime } from './watcher.js'
import { createExecutionStore } from './execution-store.js'
import { undoLastOperation } from './execution-history.js'
import { projectBoardExecution, projectTaskDetailExecution } from './execution-projection.js'
import { resolveTaskLocation } from './task-location.js'
import { createPluginRuntime } from './plugins/runtime.js'
import { publishRepositoryChange } from './plugins/repository-events.js'
import { createBoardEventService } from './board-events.js'
import { createServerLogger } from './logger.js'

const serverDir = path.dirname(fileURLToPath(import.meta.url))
const appDir = path.resolve(serverDir, '../..')
const publicDir = path.join(serverDir, 'public')
const workerFile = path.join(serverDir, 'scan-worker.js')
const folderPickerFile = path.join(serverDir, 'pick-folders.ps1')
const SCAN_SCHEMA_VERSION = 11
let port = 4317
let database = null
let persistence = null
let repositoryStore = null
let executionStore = null
let boardCache = null
let inflightScan = null
let queuedRefresh = null
let pendingWatchEvents = []
let watchRuntime = null
let watchDebounceTimer = null
let folderPickerActive = false
let scanWorkerRuntime = null
let pluginRuntime = null
let boardEventService = null
let nextScanRequestId = 0
let activeLogger = console
const pendingScanRequests = new Map()
const WATCH_DEBOUNCE_MS = Math.max(100, Number(process.env.TRELLIS_WATCH_DEBOUNCE_MS || 400))

function initializeStandaloneState(
  standalonePort = Number(process.env.PORT || 4317),
  logger = console,
) {
  activeLogger = logger
  if (database) return
  port = standalonePort
  database = getDefaultDatabase({ logger })
  persistence = createPersistenceStore()
  repositoryStore = createRepositoryStore()
  executionStore = createExecutionStore({ db: database, stageIds: STAGE_IDS })
  boardEventService = createBoardEventService()
}

function sendJson(response, status, payload) {
  sendJsonCommon(response, status, payload)
}

function readJsonBody(request) {
  return readJsonBodyCommon(request, {
    errors: {
      tooLarge: () => new Error('请求体过大'),
      invalidJson: () => new Error('请求体不是合法 JSON'),
    },
  })
}

function rejectPendingScans(error) {
  for (const pending of pendingScanRequests.values()) {
    clearTimeout(pending.timer)
    pending.reject(error)
  }
  pendingScanRequests.clear()
}

function ensureScanWorker() {
  if (scanWorkerRuntime) return scanWorkerRuntime
  const worker = new Worker(workerFile)
  scanWorkerRuntime = worker
  worker.on('message', (message) => {
    const pending = pendingScanRequests.get(message?.id)
    if (!pending) return
    clearTimeout(pending.timer)
    pendingScanRequests.delete(message.id)
    if (message.type === 'scan-error') {
      pending.reject(new Error(message.error || '扫描失败'))
      return
    }
    if (message.type !== 'scan-result') return
    pending.resolve({ board: message.board, stats: message.stats })
  })
  worker.on('error', (error) => {
    if (scanWorkerRuntime === worker) scanWorkerRuntime = null
    rejectPendingScans(error)
  })
  worker.on('exit', (code) => {
    if (scanWorkerRuntime === worker) scanWorkerRuntime = null
    if (pendingScanRequests.size) {
      rejectPendingScans(new Error(`扫描 worker 已退出，退出码 ${code}`))
    }
  })
  return worker
}

function runScanWorker({ refreshRepositoryMetadata = false, forceFull = false, events = [] } = {}) {
  const worker = ensureScanWorker()
  const id = ++nextScanRequestId
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingScanRequests.delete(id)
      reject(new Error('扫描超过 180 秒，已中止本次请求'))
    }, 180_000)
    pendingScanRequests.set(id, { resolve, reject, timer })
    worker.postMessage({
      type: 'scan',
      id,
      refreshRepositoryMetadata,
      forceFull,
      events,
    })
  })
}

function watchEventList(value) {
  if (Array.isArray(value)) return value.filter(Boolean)
  return value ? [value] : []
}

function latestWatchEvent(value) {
  return watchEventList(value).at(-1) || null
}

function refreshBoardFromFiles(reason = 'manual', event = null, options = {}) {
  options = {
    ...options,
    events: [...(Array.isArray(options.events) ? options.events : []), ...watchEventList(event)],
  }
  if (inflightScan) {
    const queuedEvents = queuedRefresh ? watchEventList(queuedRefresh.event) : []
    const queuedOptions = queuedRefresh?.options || {}
    queuedRefresh = {
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
    writeBoardState({
      refreshQueued: true,
      refreshQueuedReason: reason,
    })
    return inflightScan
  }

  const initialReason = reason
  const initialEvent = event
  const initialOptions = options
  inflightScan = (async () => {
    let activeReason = initialReason
    let activeEvent = initialEvent
    let activeOptions = initialOptions
    let board = null

    do {
      writeBoardState({
        refreshStartedAt: new Date().toISOString(),
        refreshReason: activeReason,
        refreshQueued: false,
        refreshQueuedReason: null,
        lastRefreshError: null,
      })
      const previousBoard = boardCache || readScanCache()
      const result = await runScanWorker(activeOptions)
      board = result.board
      const scannedAt = new Date().toISOString()
      persistence.writeScanCache(board, SCAN_SCHEMA_VERSION, {
        beforeCommit: () =>
          executionStore.recordScanObservationsInTransaction({
            tasks: board.tasks || [],
            previousTasks: activeOptions.suppressStageObservation ? [] : previousBoard?.tasks || [],
            occurredAt: scannedAt,
            actor: 'system',
          }),
      })
      boardCache = board
      writeBoardState({
        lastRefreshAt: board.generatedAt,
        refreshFinishedAt: new Date().toISOString(),
        refreshReason: activeReason,
        lastRefreshTrigger: activeReason,
        refreshQueued: Boolean(queuedRefresh),
        refreshQueuedReason: queuedRefresh?.reason || null,
        lastWatchEvent: latestWatchEvent(activeEvent) || readBoardState().lastWatchEvent || null,
        lastScanStats: result.stats,
      })
      boardEventService?.publish({ generatedAt: board.generatedAt })
      pluginRuntime?.publishScan(previousBoard, board, result.stats, activeReason)

      if (queuedRefresh) {
        activeReason = queuedRefresh.reason
        activeEvent = queuedRefresh.event
        activeOptions = queuedRefresh.options || {}
        queuedRefresh = null
      } else {
        activeReason = null
        activeEvent = null
        activeOptions = {}
      }
    } while (activeReason)

    return board
  })()
    .catch((error) => {
      writeBoardState({
        refreshFinishedAt: new Date().toISOString(),
        lastRefreshError: error instanceof Error ? error.message : String(error),
        refreshQueued: Boolean(queuedRefresh),
        refreshQueuedReason: queuedRefresh?.reason || null,
      })
      throw error
    })
    .finally(() => {
      inflightScan = null
      // The debounce can fire in the narrow window after the worker finishes
      // but before this promise settles. Drain that event instead of losing it.
      if (queuedRefresh && !watchDebounceTimer) {
        const next = queuedRefresh
        queuedRefresh = null
        refreshBoardFromFiles(next.reason, next.event, next.options).catch((error) => {
          activeLogger.error('排队中的看板刷新失败', error)
        })
      }
    })
  return inflightScan
}

function scheduleWatchRefresh(event) {
  pendingWatchEvents.push(event)
  if (watchDebounceTimer) clearTimeout(watchDebounceTimer)
  watchDebounceTimer = setTimeout(() => {
    watchDebounceTimer = null
    const events = pendingWatchEvents
    pendingWatchEvents = []
    refreshBoardFromFiles('watcher', events).catch((error) => {
      activeLogger.error('文件变更后自动刷新失败', error)
    })
  }, WATCH_DEBOUNCE_MS)
}

async function startFileWatcher() {
  let status
  try {
    watchRuntime = createWatchRuntime({
      repositories: getRepositories(),
      onChange: scheduleWatchRefresh,
      onError: (error) => activeLogger.error('Trellis 文件监听失败', error),
    })
    // chokidar 的初始扫描是异步的，就绪前的 status() 一定是 disabled。
    await watchRuntime.ready()
    status = watchRuntime.status()
  } catch (error) {
    activeLogger.error('启动 Trellis 文件监听失败', error)
    return
  }
  try {
    writeBoardState({
      watcherStartedAt: new Date().toISOString(),
      watcherEnabled: status.enabled,
    })
    activeLogger.log(
      `Trellis watcher: ${status.enabled ? 'enabled' : 'disabled'}, ` +
        `${status.watchedRepositories.length} repositories, debounce=${WATCH_DEBOUNCE_MS}ms`,
    )
  } catch (error) {
    activeLogger.error('启动 Trellis 文件监听后保存状态失败', error)
    throw error
  }
}

function restartFileWatcher() {
  const previous = watchRuntime
  watchRuntime = null
  previous?.close().catch((error) => {
    activeLogger.error('关闭旧 Trellis 文件监听失败', error)
  })
  void startFileWatcher()
}

function pickFoldersFromDesktop() {
  if (folderPickerActive) {
    return Promise.reject(new Error('文件夹选择框已经打开，请先完成当前选择'))
  }
  folderPickerActive = true

  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', folderPickerFile],
      {
        cwd: appDir,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    let stdout = ''
    let stderr = ''
    let settled = false

    const finish = (handler, value) => {
      if (settled) return
      settled = true
      folderPickerActive = false
      handler(value)
    }

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.once('error', (error) => finish(reject, error))
    child.once('close', (code) => {
      if (code !== 0) {
        finish(reject, new Error(stderr.trim() || `文件夹选择器退出码 ${code}`))
        return
      }
      try {
        const marker = 'TRELLIS_JSON:'
        const jsonLine = stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.startsWith(marker))
          .pop()
        if (!jsonLine) throw new Error('文件夹选择器没有返回路径结果')
        const parsed = JSON.parse(jsonLine.slice(marker.length))
        if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
          throw new Error('文件夹选择器返回了无效结果')
        }
        finish(resolve, parsed)
      } catch (error) {
        finish(reject, error)
      }
    })
  })
}

function repositoryInputs(payload) {
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

async function refreshAfterRepositoryChange(action, repositories) {
  const changed = Array.isArray(repositories) ? repositories : [repositories]
  writeBoardState({
    repositoriesUpdatedAt: new Date().toISOString(),
    repositoriesUpdatedAction: action,
    repositoriesUpdatedIds: changed.map((repository) => repository.id),
  })
  restartFileWatcher()
  pluginRuntime?.setRepositories?.(getRepositories())

  // 如果扫描在项目白名单变更前启动，先等旧快照结束，再按新白名单完整扫描一次。
  if (inflightScan) await inflightScan.catch(() => {})
  boardCache = null
  return refreshBoardFromFiles('repositories', null, {
    refreshRepositoryMetadata: true,
  })
}

function readScanCache() {
  return persistence.readScanCache(SCAN_SCHEMA_VERSION)
}

function projectBoardWithExecution(board, source) {
  return withRefreshState(
    projectBoardExecution(board, executionStore.listSavedViews(), database, new Date(), {
      executionWipLimit: persistence.readExecutionWipLimit(),
    }),
    source,
  )
}

function withRefreshState(board, source) {
  const boardState = readBoardState()
  return {
    ...board,
    source,
    refreshReason: boardState.refreshReason || null,
    refreshQueued: Boolean(inflightScan || queuedRefresh || watchDebounceTimer),
    watcher: watchRuntime?.status() || {
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

async function getBoardWithBackgroundRefresh(forceRefresh = false) {
  if (forceRefresh) {
    return projectBoardWithExecution(
      await refreshBoardFromFiles('manual', null, {
        refreshRepositoryMetadata: true,
        forceFull: true,
      }),
      'fresh',
    )
  }
  const cached = readScanCache()
  if (!cached) {
    return projectBoardWithExecution(await refreshBoardFromFiles(), 'fresh')
  }
  if (!boardCache && cached.tasks?.length) {
    boardCache = cached
  }
  return projectBoardWithExecution(cached, 'cache')
}

function readBoardState() {
  return persistence.readBoardState()
}

function writeBoardState(patch) {
  persistence.writeBoardState(patch)
}

function requireWritableExecution(resolved) {
  if (resolved.task.archived) {
    throw new Error('归档任务只读，不能修改执行数据')
  }
  if (resolved.identityConflict || !resolved.task.executionIdentityValid) {
    throw new Error('任务执行身份冲突，请修正 task.json id')
  }
}

function requireDependencyIdentity(resolved, label) {
  if (resolved.identityConflict || !resolved.task.executionIdentityValid) {
    throw new Error(`${label}任务执行身份冲突，请先修正 task.json id`)
  }
}

function findTask(payload) {
  const resolved = resolveCurrentTask(payload)
  const board = boardCache || readScanCache()
  return projectTaskDetailExecution(resolved.task, database, new Date(), 1000, {
    boardTasks: board?.tasks || [resolved.task],
    executionWipLimit: persistence.readExecutionWipLimit(),
  })
}

function resolveCurrentTask(payload) {
  return resolveTaskLocation(payload, {
    repositories: getRepositories(),
    currentBoard: boardCache || readScanCache(),
    db: database,
  })
}

const repositoryService = {
  list: () => repositoryStore.list(),
  async addMany(inputs) {
    const added = repositoryStore.addMany(inputs)
    await refreshAfterRepositoryChange('add', added)
    publishRepositoryChange(pluginRuntime, 'add', added)
    return { added }
  },
  async remove(input) {
    const removed = repositoryStore.remove(input)
    await refreshAfterRepositoryChange('remove', [removed])
    publishRepositoryChange(pluginRuntime, 'remove', [removed])
    return { removed }
  },
}

async function startPluginRuntime() {
  if (!database) return
  let hostVersion = '0.0.0'
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'))
    hostVersion = String(manifest.version || hostVersion)
  } catch {
    // package.json 不可读时以 0.0.0 启动；版本校验会因此拒绝 engines 有下界的插件。
  }
  pluginRuntime = createPluginRuntime({
    db: database,
    appDir,
    dataDir,
    pluginsDir,
    hostVersion,
    repositories: getRepositories(),
    repositoryService,
    boardProvider: () => boardCache || readScanCache(),
    logger: activeLogger,
  })
  try {
    await pluginRuntime.load()
    const started = await pluginRuntime.start()
    if (!started.disabled) {
      activeLogger.log(`Trellis 插件: ${started.plugins.length} 个已加载`)
    }
  } catch (error) {
    activeLogger.error('加载插件失败，核心功能继续运行', error)
  }
}

function serverContext(request, response, url) {
  return { request, response, url, sendJson }
}

async function handlePluginRequest(request, response, url) {
  if (!pluginRuntime) return false
  try {
    return await pluginRuntime.handleHttp(serverContext(request, response, url))
  } catch (error) {
    activeLogger.error('插件路由处理失败', error)
    sendJson(response, 500, {
      error: error instanceof Error ? error.message : '插件请求失败',
    })
    return true
  }
}

async function handleApi(request, response, url) {
  const pluginPath =
    url.pathname.startsWith('/api/plugins') ||
    url.pathname === '/api/panels' ||
    url.pathname === '/api/events'
  if (pluginPath && (await handlePluginRequest(request, response, url))) {
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/board/events') {
    if (!boardEventService?.open({ response })) {
      sendJson(response, 503, { error: '实时刷新服务不可用' })
    }
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/board') {
    const board = await getBoardWithBackgroundRefresh(false)
    sendJson(response, 200, {
      ...board,
      refreshRunning: Boolean(inflightScan),
      refreshQueued: Boolean(inflightScan || queuedRefresh || watchDebounceTimer),
    })
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/board/status') {
    sendJson(response, 200, {
      ...readBoardState(),
      refreshRunning: Boolean(inflightScan),
      refreshQueued: Boolean(inflightScan || queuedRefresh || watchDebounceTimer),
      watcher: watchRuntime?.status() || {
        enabled: false,
        watchedRepositories: [],
        watchedRoots: [],
        eventsSeen: 0,
        lastEvent: null,
        errors: [],
      },
    })
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/health') {
    sendJson(response, 200, { status: 'ok', processId: process.pid })
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/board/refresh/start') {
    if (!inflightScan) {
      refreshBoardFromFiles('manual', null, {
        refreshRepositoryMetadata: true,
        forceFull: true,
      }).catch((error) => activeLogger.error('后台刷新失败', error))
    }
    sendJson(response, 202, {
      refreshRunning: true,
      refreshQueued: Boolean(queuedRefresh || watchDebounceTimer),
    })
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/board/refresh') {
    sendJson(response, 200, await getBoardWithBackgroundRefresh(true))
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/repositories') {
    sendJson(response, 200, { repositories: repositoryStore.list() })
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/repositories/pick-folders') {
    sendJson(response, 200, { paths: await pickFoldersFromDesktop() })
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/repositories') {
    const payload = await readJsonBody(request)
    const repositories = repositoryStore.addMany(repositoryInputs(payload))
    const board = await refreshAfterRepositoryChange('add', repositories)
    publishRepositoryChange(pluginRuntime, 'add', repositories)
    const projects = repositories.map(
      (repository) =>
        board.projects.find((candidate) => candidate.id === repository.id) || repository,
    )
    sendJson(response, 201, {
      message:
        repositories.length === 1 ? '项目已加入看板' : `已加入 ${repositories.length} 个项目`,
      repositories: projects,
      repository: projects.length === 1 ? projects[0] : undefined,
    })
    return
  }
  if (request.method === 'DELETE' && url.pathname === '/api/repositories') {
    const payload = await readJsonBody(request)
    const repository = repositoryStore.remove(payload)
    await refreshAfterRepositoryChange('remove', [repository])
    publishRepositoryChange(pluginRuntime, 'remove', [repository])
    sendJson(response, 200, {
      message: '项目已从看板移除，源文件未删除',
      repository,
    })
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/task') {
    const payload = await readJsonBody(request)
    sendJson(response, 200, findTask(payload))
    return
  }
  if (request.method === 'PUT' && url.pathname === '/api/tasks/execution') {
    const payload = await readJsonBody(request)
    const resolved = resolveCurrentTask(payload)
    requireWritableExecution(resolved)
    const result = executionStore.updatePlan(
      resolved.task.executionTaskKey,
      payload,
      resolved.actor,
    )
    sendJson(response, 200, {
      message: result.changed ? '计划字段已保存' : '计划字段没有变化',
      ...result,
    })
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/tasks/dependencies') {
    const payload = await readJsonBody(request)
    const blocked = resolveCurrentTask(payload.blocked)
    const blocker = resolveCurrentTask(payload.blocker)
    requireDependencyIdentity(blocked, '被阻断')
    requireDependencyIdentity(blocker, '阻断方')
    const currentBoard = boardCache || readScanCache()
    const taskLabels = Object.fromEntries(
      (currentBoard?.tasks || [])
        .filter((task) => task.executionTaskKey)
        .map((task) => [task.executionTaskKey, task.title]),
    )
    const dependency = executionStore.createDependency(
      {
        blockerTaskKey: blocker.task.executionTaskKey,
        blockedTaskKey: blocked.task.executionTaskKey,
        reason: payload.reason,
        blockerLabel: blocker.task.title,
        blockedLabel: blocked.task.title,
        taskLabels,
      },
      blocked.actor,
    )
    sendJson(response, 201, {
      message: '阻断依赖已创建',
      dependency: {
        ...dependency,
        blocker: {
          taskKey: blocker.task.taskKey,
          executionTaskKey: blocker.task.executionTaskKey,
          title: blocker.task.title,
          projectName: blocker.task.projectName,
        },
        blocked: {
          taskKey: blocked.task.taskKey,
          executionTaskKey: blocked.task.executionTaskKey,
          title: blocked.task.title,
          projectName: blocked.task.projectName,
        },
      },
    })
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/tasks/undo') {
    const payload = await readJsonBody(request)
    const resolved = resolveCurrentTask(payload)
    requireWritableExecution(resolved)
    const undone = undoLastOperation({
      db: database,
      executionTaskKey: resolved.task.executionTaskKey,
      projectId: resolved.project.id,
      taskPath: resolved.task.relativeDir,
      task: resolved.task,
      actor: resolved.actor,
    })
    await refreshBoardFromFiles('undo', null, {
      suppressStageObservation: true,
    })
    sendJson(response, 200, {
      message: '最近操作已撤销',
      ...undone,
      task: findTask(payload),
    })
    return
  }
  if (request.method === 'DELETE' && url.pathname === '/api/tasks/dependencies') {
    const payload = await readJsonBody(request)
    const dependency = executionStore.resolveDependency(payload.id)
    sendJson(response, 200, {
      message: '阻断依赖已解除',
      dependency,
    })
    return
  }
  if (request.method === 'PUT' && url.pathname === '/api/board/settings') {
    const payload = await readJsonBody(request)
    const unknownKeys = Object.keys(payload).filter((key) => key !== 'executionWipLimit')
    if (unknownKeys.length) {
      throw new Error(`看板设置包含未知字段: ${unknownKeys.join(', ')}`)
    }
    const executionWipLimit = persistence.writeExecutionWipLimit(payload.executionWipLimit)
    sendJson(response, 200, {
      message: '实现中 WIP 软上限已保存',
      executionWipLimit,
    })
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/saved-views') {
    const payload = await readJsonBody(request)
    const view = executionStore.createSavedView(payload)
    sendJson(response, 201, { message: '组合视图已保存', view })
    return
  }
  if (request.method === 'PUT' && url.pathname === '/api/saved-views') {
    const payload = await readJsonBody(request)
    const view = executionStore.updateSavedView(payload)
    sendJson(response, 200, { message: '组合视图已更新', view })
    return
  }
  if (request.method === 'DELETE' && url.pathname === '/api/saved-views') {
    const payload = await readJsonBody(request)
    const view = executionStore.deleteSavedView(payload.id)
    sendJson(response, 200, { message: '组合视图已删除', view })
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/tasks') {
    const payload = await readJsonBody(request)
    const result = await createTask(payload)
    boardCache = null
    sendJson(response, 201, {
      message: '任务已创建，尚未启动',
      repository: result.repository,
      stdout: result.output.stdout,
      stderr: result.output.stderr,
    })
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/tasks/assign') {
    const payload = await readJsonBody(request)
    const assigned = await assignTask(payload)
    boardCache = null
    pluginRuntime?.publish('task.assigned', {
      taskKey: `${payload.repositoryId}::${payload.taskDir}`,
      projectId: payload.repositoryId,
      assignee: assigned.assignee,
      occurredAt: new Date().toISOString(),
    })
    sendJson(response, 200, { message: '任务负责人已更新', ...assigned })
    return
  }
  if (request.method === 'PUT' && url.pathname === '/api/tasks/stage') {
    const payload = await readJsonBody(request)
    const resolved = resolveCurrentTask(payload)
    requireWritableExecution(resolved)
    const stage = setManualStage(
      resolved.project.id,
      resolved.task.relativeDir,
      payload.stage,
      database,
      {
        executionTaskKey: resolved.task.executionTaskKey,
        actor: resolved.actor,
      },
    )
    await refreshBoardFromFiles('manual-stage', null, {
      suppressStageObservation: true,
    })
    pluginRuntime?.publish('task.stage.changed', {
      taskKey: resolved.task.taskKey,
      stage: stage.stage,
      occurredAt: stage.updatedAt,
    })
    sendJson(response, 200, { message: '流程检查点已记录', stage })
    return
  }
  sendJson(response, 404, { error: '接口不存在' })
}

function serveStatic(request, response, url) {
  const text = (status, body, headers = {}) => {
    response.writeHead(status, headers)
    response.end(body)
  }
  serveStaticCommon({
    request,
    response,
    pathname: url.pathname,
    publicDir,
    invalidPath: () => text(400, 'Bad request'),
    methodNotAllowed: () => text(405, 'Method not allowed', { allow: 'GET, HEAD' }),
    forbidden: () => text(403, 'Forbidden'),
    notFound: () => text(404, 'Not found'),
  })
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`)
    if (url.pathname.startsWith('/api/')) await handleApi(request, response, url)
    else if (!(await handlePluginRequest(request, response, url))) {
      serveStatic(request, response, url)
    }
  } catch (error) {
    activeLogger.error(error)
    sendJson(response, 400, { error: error instanceof Error ? error.message : '执行失败' })
  }
})

function listenStandalone(bindHost = '0.0.0.0') {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, bindHost)
  })
}

export async function startStandaloneServer({
  standalonePort = Number(process.env.PORT || 4317),
  bindHost = '0.0.0.0',
  logger = console,
} = {}) {
  initializeStandaloneState(standalonePort, logger)
  try {
    await listenStandalone(bindHost)
    writeBoardState({
      serverStartedAt: new Date().toISOString(),
      refreshStartedAt: null,
      refreshQueued: false,
      refreshQueuedReason: null,
      executionWipLimit: persistence.readExecutionWipLimit(),
    })
    await startFileWatcher()
    await startPluginRuntime()
    refreshBoardFromFiles('startup').catch((error) => {
      activeLogger.error('启动后的后台扫描失败', error)
    })
    const loopbackHost = bindHost === '127.0.0.1' || bindHost === 'localhost' || bindHost === '::1'
    const allInterfaces = bindHost === '0.0.0.0' || bindHost === '::' || bindHost === '[::]'
    if (!loopbackHost) {
      activeLogger.warn(
        `Trellis Board 监听 ${bindHost}，standalone 模式没有账号鉴权，请只在可信网络内使用`,
      )
    }
    activeLogger.log(
      `Trellis Board: http://${loopbackHost ? '127.0.0.1' : bindHost}:${port}${
        allInterfaces ? '（所有网络接口）' : ''
      }`,
    )
    return {
      mode: 'standalone',
      server,
      address: () => server.address(),
      stop: stopStandaloneServer,
    }
  } catch (error) {
    await stopStandaloneServer()
    throw error
  }
}

export async function stopStandaloneServer() {
  boardEventService?.close()
  boardEventService = null
  await pluginRuntime?.stop()
  pluginRuntime = null
  await watchRuntime?.close()
  watchRuntime = null
  if (watchDebounceTimer) clearTimeout(watchDebounceTimer)
  watchDebounceTimer = null
  if (scanWorkerRuntime) {
    const worker = scanWorkerRuntime
    scanWorkerRuntime = null
    rejectPendingScans(new Error('服务正在关闭'))
    await worker.terminate()
  }
  if (server.listening) {
    await new Promise((resolve) => {
      server.close(() => resolve())
      const timer = setTimeout(() => server.closeAllConnections?.(), 5_000)
      timer.unref?.()
    })
  }
  database?.close()
  database = null
  activeLogger = console
}

export async function startApplication(config = parseTeamConfig(), logger = console) {
  activeLogger = logger
  migrateLegacyRuntimeData()
  if (config.mode === 'team') {
    const runtime = await createTeamRuntime({ config, logger })
    return runtime.start()
  }
  return startStandaloneServer({
    standalonePort: config.port,
    bindHost: config.bindHost,
    logger,
  })
}

let activeRuntime = null
let stopping = false

async function stopActiveRuntime() {
  if (stopping || !activeRuntime) return
  stopping = true
  try {
    await activeRuntime.stop()
  } catch (error) {
    activeLogger.error('关闭服务失败', error)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const logger = createServerLogger({ dataDir })
  startApplication(undefined, logger)
    .then((runtime) => {
      activeRuntime = runtime
    })
    .catch(async (error) => {
      logger.error('Trellis Board 启动失败', error)
      await logger.close()
      process.exitCode = 1
    })
  let shutdownPromise = null
  const shutdown = () => {
    if (shutdownPromise) return
    shutdownPromise = stopActiveRuntime()
      .then(() => logger.close())
      .finally(() => process.exit())
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
