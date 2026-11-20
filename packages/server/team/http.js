import crypto from 'node:crypto'
import http from 'node:http'
import path from 'node:path'
import { databaseFile as defaultDatabaseFile, dataDir as defaultDataDir } from '../config.js'
import { createBoardEventService } from '../board-events.js'
import { openDatabase } from '../database.js'
import { STAGE_IDS } from '../metadata.js'
import { createAgentEventStream } from './agent-event-stream.js'
import { createArchiveSnapshotStore } from './archive-local-snapshot.js'
import { createArchiveGitSyncService } from './archive-git-sync.js'
import { createDesktopAuthService } from './desktop-auth.js'
import { diagnosticError } from './error-diagnostics.js'
import { hasActiveAdmin } from './auth.js'
import { ERROR_CODES, errorPayload, teamError } from './errors.js'
import { createGitlessBoardService } from './gitless-board-service.js'
import { createTeamPluginHost } from './plugins/host.js'
import { createDisabledTeamPluginRoutes, createTeamPluginRoutes } from './plugins/http.js'
import { createSyncAgentService } from './sync-agent-service.js'
import { createTaskCommandService } from './task-command-service.js'
import { createTaskControlService } from './task-control-service.js'
import { createTaskOwnershipInboxService } from './task-ownership-inbox.js'
import { createTaskSnapshotBackupService } from './task-snapshot-backup.js'
import { createTaskSnapshotService } from './task-snapshot-service.js'
import { createTaskSpaceIndex } from './task-space-index.js'
import { createTaskSpaceService } from './task-space-service.js'
import {
  readHostVersion,
  sendJson,
  requestHostOrigin,
  assertHost,
  assertJsonWrite,
  requireAdmin,
  servePluginUi,
  serveStatic,
  appRoot,
  defaultPublicDir,
  EXECUTION_WIP_LIMIT,
  teamPluginsEnabled,
} from './http/common.js'
import { createRequestContext } from './http/context.js'
import { createWorkspaceTemplateRoutes } from './http/routes/workspace-template.js'
import { createAgentRoutes } from './http/routes/agent.js'
import { createAuthRoutes } from './http/routes/auth.js'
import { createAdminRoutes } from './http/routes/admin.js'
import { createDesktopRoutes } from './http/routes/desktop.js'
import { createProjectRoutes } from './http/routes/projects.js'
import { createTeamRoutes } from './http/routes/team.js'
import { createTaskRoutes } from './http/routes/tasks.js'

const DEFAULT_REFRESH_CONCURRENCY = 4
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

function createRequestHandler({
  config,
  db,
  boardService,
  taskSpaces,
  taskSnapshots,
  ownershipInbox,
  taskSpaceIndex,
  taskCommands,
  taskControl,
  archiveGitSync,
  agentService,
  agentEvents,
  boardEvents,
  desktopAuth,
  pluginRoutes,
  publicDir,
  logger,
  isClosing,
}) {
  const ctx = {
    config,
    db,
    boardService,
    taskSpaces,
    taskSnapshots,
    ownershipInbox,
    taskSpaceIndex,
    taskCommands,
    taskControl,
    archiveGitSync,
    agentService,
    agentEvents,
    boardEvents,
    desktopAuth,
    pluginRoutes,
    publicDir,
    logger,
    isClosing,
  }
  const context = createRequestContext(ctx)
  Object.assign(ctx, context)
  const { requireActor } = context
  const { handleWorkspaceTemplate } = createWorkspaceTemplateRoutes(ctx)
  const { handleAgent } = createAgentRoutes(ctx)
  const { handleAuth } = createAuthRoutes(ctx)
  const { handleAdmin } = createAdminRoutes(ctx)
  const { handleDesktop } = createDesktopRoutes(ctx)
  const { handleProjects } = createProjectRoutes(ctx)
  const { handleTeam } = createTeamRoutes(ctx)
  const { handleTasks } = createTaskRoutes(ctx)

  async function dispatch(request, response) {
    response.setHeader('x-request-id', crypto.randomUUID())
    assertHost(request)
    if (isClosing()) {
      throw teamError(503, ERROR_CODES.SERVICE_SHUTTING_DOWN, '服务正在关闭')
    }
    const url = new URL(request.url || '/', requestHostOrigin(request))
    const isAgent = url.pathname === '/api/agent/enroll' || url.pathname.startsWith('/api/agent/')
    if (isAgent) {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        const contentType = String(request.headers['content-type'] || '').toLowerCase()
        if (!/^application\/json\s*(?:;|$)/.test(contentType)) {
          throw teamError(415, ERROR_CODES.JSON_REQUIRED, 'Agent 写请求必须使用 application/json')
        }
      }
      if (await handleAgent(request, response, url)) return
      throw teamError(404, ERROR_CODES.NOT_FOUND, 'Agent 接口不存在')
    }

    if (url.pathname === '/api/health') {
      sendJson(response, 200, {
        status: 'ok',
        mode: 'team',
        processId: process.pid,
        serverStartedAt: serverStartedAt,
        version: readHostVersion(),
      })
      return
    }
    // 插件面板共用资源（tokens/base/ui/bridge）属于宿主，也必须免登录：
    // 面板 iframe 没有 same-origin，取子资源时不带 Cookie。
    if (url.pathname.startsWith('/plugin-ui/')) {
      servePluginUi(request, response, url)
      return
    }
    if (!url.pathname.startsWith('/api/')) {
      serveStatic(request, response, url, publicDir)
      return
    }
    if (url.pathname === '/api/auth/register') {
      throw teamError(404, ERROR_CODES.NOT_FOUND, '接口不存在')
    }
    // 面板静态资源必须先于登录校验：sandbox iframe 没有 same-origin，
    // 它自己去取 HTML/JS/CSS 时不带 Cookie，带鉴权就永远是 401。
    if (
      request.method === 'GET' &&
      url.pathname.startsWith('/api/plugins/') &&
      url.pathname.includes('/app/panel')
    ) {
      if (await pluginRoutes(request, response, url, null)) return
    }
    if (WRITE_METHODS.has(request.method)) assertJsonWrite(request)
    if (await handleAuth(request, response, url)) return
    if (await handleWorkspaceTemplate(request, response, url)) return

    const actor = requireActor(request)
    if (
      actor.user.mustChangePassword &&
      !new Set(['/api/auth/password', '/api/auth/logout']).has(url.pathname)
    ) {
      throw teamError(
        403,
        ERROR_CODES.PASSWORD_CHANGE_REQUIRED,
        '首次登录或密码重置后必须先修改密码',
      )
    }
    if (
      url.pathname === '/api/plugins' ||
      url.pathname.startsWith('/api/plugins/') ||
      url.pathname === '/api/panels' ||
      url.pathname === '/api/events'
    ) {
      if (await pluginRoutes(request, response, url, actor)) return
      throw teamError(404, ERROR_CODES.NOT_FOUND, '接口不存在')
    }
    if (await handleAdmin(request, response, url)) return
    if (await handleDesktop(request, response, url, actor)) return
    if (await handleProjects(request, response, url)) return
    if (await handleTeam(request, response, url)) return
    if (await handleTasks(request, response, url)) return
    throw teamError(404, ERROR_CODES.NOT_FOUND, '接口不存在')
  }

  let serverStartedAt = null
  return {
    async handle(request, response) {
      try {
        await dispatch(request, response)
      } catch (error) {
        const mapped = errorPayload(error)
        if (mapped.status >= 500) {
          logger.error('团队 HTTP 请求失败', {
            requestId: response.getHeader('x-request-id'),
            method: request.method,
            url: request.url,
            error: error instanceof Error ? error.message : String(error),
          })
        }
        sendJson(response, mapped.status, mapped.body)
      }
    },
    setStartedAt(value) {
      serverStartedAt = value
    },
  }
}

function listen(server, port, host) {
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
    server.listen({ port, host, backlog: 1024 })
  })
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve()
      return
    }
    server.close(() => resolve())
    const timer = setTimeout(() => server.closeAllConnections?.(), 5_000)
    timer.unref?.()
  })
}

export function createRefreshScheduler({
  concurrency = DEFAULT_REFRESH_CONCURRENCY,
  refresh,
  logger = console,
}) {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new TypeError('refresh concurrency 必须是正整数')
  }
  if (typeof refresh !== 'function') {
    throw new TypeError('refresh 必须是函数')
  }
  const pending = new Map()
  const inFlight = new Map()
  let stopped = false

  function drain() {
    while (!stopped && inFlight.size < concurrency && pending.size) {
      const [projectId] = pending.keys()
      pending.delete(projectId)
      const operation = Promise.resolve()
        .then(() => refresh(projectId))
        .catch((error) => {
          const diagnostic = diagnosticError(error)
          logger.warn('团队项目定时拉取失败', {
            projectId,
            ...diagnostic,
            error: diagnostic.message,
          })
        })
        .finally(() => {
          inFlight.delete(projectId)
          drain()
        })
      inFlight.set(projectId, operation)
    }
  }

  return {
    enqueue(projectId) {
      if (stopped || pending.has(projectId) || inFlight.has(projectId)) {
        return false
      }
      pending.set(projectId, true)
      drain()
      return true
    },
    snapshot() {
      return {
        active: inFlight.size,
        queued: pending.size,
        projectIds: [...inFlight.keys()],
      }
    },
    async stop() {
      if (stopped) return
      stopped = true
      pending.clear()
      await Promise.allSettled([...inFlight.values()])
    },
  }
}

export async function createTeamRuntime({
  config,
  databaseFile = defaultDatabaseFile,
  dataDir = defaultDataDir,
  publicDir = defaultPublicDir,
  logger = console,
  requireAdmin = true,
  enablePolling = true,
  refreshConcurrency = DEFAULT_REFRESH_CONCURRENCY,
  scheduledRefresh = null,
  trellisRunner = undefined,
  desktopAuth = {},
  boardEventOptions = {},
  archiveGitRunProcessImpl = undefined,
}) {
  if (config?.mode !== 'team') {
    throw new Error('createTeamRuntime 只接受 team 配置')
  }
  const db = openDatabase({
    databaseFile,
    fallbackRepositories: [],
    importLegacyRepositories: false,
    legacyJsonImport: false,
    logger,
  })
  const archiveSnapshots = createArchiveSnapshotStore({
    db,
    dataDir,
    databaseFile,
    logger,
  })
  try {
    archiveSnapshots.cleanup()
  } catch (error) {
    logger.warn('归档快照启动清理失败', {
      errorCode: error?.code || 'ARCHIVE_SNAPSHOT_CLEANUP_FAILED',
    })
  }
  const taskSnapshotBackups = createTaskSnapshotBackupService({
    db,
    databaseFile,
    logger,
  })
  let closing = false
  const shutdown = new AbortController()

  try {
    if (requireAdmin && !hasActiveAdmin(db)) {
      throw teamError(
        503,
        ERROR_CODES.AUTH_REQUIRED,
        '团队模式尚无系统管理员，请先在本机运行 node packages/server/team/cli.js init-admin',
      )
    }
    const boardEvents = createBoardEventService(boardEventOptions)
    let taskCommands = null
    const commandsProxy = {
      available: (agentId) => taskCommands.available(agentId),
      markDelivered: (agentId, commandId) => taskCommands.markDelivered(agentId, commandId),
      staleLeases: (agentId) => taskCommands.staleLeases(agentId),
    }
    const agentEvents = createAgentEventStream({
      db,
      commands: commandsProxy,
      logger,
    })
    const agentService = createSyncAgentService({
      db,
      config,
      events: {
        publishAgentRevoked: (agentId) => agentEvents.publishAgentRevoked(agentId),
        publishBoardChanged: () => boardEvents.publish({}),
      },
    })
    const taskSpaces = createTaskSpaceService({
      db,
      config,
      backupService: taskSnapshotBackups,
      onTaskSpacePurged: () => {
        try {
          archiveSnapshots.cleanup()
        } catch (error) {
          logger.warn('归档快照移除清理失败', {
            errorCode: error?.code || 'ARCHIVE_SNAPSHOT_CLEANUP_FAILED',
          })
        }
      },
    })
    const taskControl = createTaskControlService({ db, logger })
    let taskSpaceIndex = null
    taskCommands = createTaskCommandService({
      db,
      taskSpaces,
      agents: agentService,
      taskControl,
      events: agentEvents,
      onTaskControlChanged: ({ taskSpaceId }) => {
        const revision = taskSpaceIndex?.incrementQueryRevision({ publish: false }) || 0
        boardEvents.publish({ revision })
        void taskSpaceIndex?.enqueue(taskSpaceId)
      },
    })
    let archiveGitSync = null
    taskSpaceIndex = createTaskSpaceIndex({
      db,
      stageIds: STAGE_IDS,
      taskSpaces,
      archiveSnapshots,
      taskControl,
      executionWipLimit: EXECUTION_WIP_LIMIT,
      onQueryRevisionChanged: (revision) => boardEvents.publish({ revision }),
      onProjected: (projection) => {
        boardEvents.publish({ revision: projection.revision })
        if (projection.activeAdvanced) {
          agentEvents.notifyTaskSpaceChanged(projection.taskSpaceId, projection.revision)
        }
        archiveGitSync?.onIndexProjected(projection)
      },
      onProjectionFailed: (failure) => archiveGitSync?.onIndexProjectionFailed(failure),
      logger,
    })
    const taskSnapshots = createTaskSnapshotService({
      db,
      taskSpaces,
      taskControl,
      onRevisionCommitted: ({ taskSpaceId }) => {
        void taskSpaceIndex.enqueue(taskSpaceId)
      },
      onOwnershipInboxCleared: () => boardEvents.publish({}),
    })
    const ownershipInbox = createTaskOwnershipInboxService({
      db,
      taskSpaces,
      taskSnapshots,
    })
    archiveGitSync = createArchiveGitSyncService({
      db,
      config,
      dataDir,
      taskSpaceIndex,
      logger,
      runProcessImpl: archiveGitRunProcessImpl,
      snapshots: archiveSnapshots,
    })
    const desktopAuthService = createDesktopAuthService({ db, ...desktopAuth })
    const boardService = createGitlessBoardService({
      db,
      taskSpaces,
      taskSpaceIndex,
      archiveSnapshots,
      agents: agentService,
      ownershipInbox,
      executionWipLimit: EXECUTION_WIP_LIMIT,
    })
    const pluginsEnabled = teamPluginsEnabled(config)
    const pluginHost = pluginsEnabled
      ? createTeamPluginHost({
          db,
          appDir: appRoot,
          dataDir,
          pluginsDir: path.join(dataDir, 'plugins'),
          bundledPluginsDir: path.join(appRoot, 'plugins'),
          // 只有运维显式配置 TRELLIS_TEAM_PLUGINS_ALLOWLIST 时才装载插件；
          // 默认空集合，生产 Team 服务器开箱不启动任何插件子进程。
          pluginAllowlist: config.pluginAllowlist,
          hostVersion: readHostVersion(),
          repositoriesProvider: () =>
            db.prepare('SELECT id, name, path FROM repositories ORDER BY position, name').all(),
          logger,
        })
      : null
    const pluginRoutes = pluginsEnabled
      ? createTeamPluginRoutes({ host: pluginHost, logger })
      : createDisabledTeamPluginRoutes()
    const requestHandler = createRequestHandler({
      config,
      db,
      boardService,
      taskSpaces,
      taskSnapshots,
      ownershipInbox,
      taskSpaceIndex,
      taskCommands,
      taskControl,
      archiveGitSync,
      agentService,
      agentEvents,
      boardEvents,
      desktopAuth: desktopAuthService,
      pluginRoutes,
      publicDir,
      logger,
      isClosing: () => closing,
    })
    const server = http.createServer((request, response) => {
      requestHandler.handle(request, response)
    })
    // 长轮询和 3 秒轮询之间允许连接复用，避免 Windows 客户端复用已过期套接字。
    server.keepAliveTimeout = 65_000
    server.headersTimeout = 66_000
    server.on('connection', (socket) => socket.setNoDelay(true))
    server.on('clientError', (error, socket) => {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
      logger.warn('团队 HTTP 客户端连接错误', { error: error.message })
    })
    let started = false

    async function start() {
      if (started) return runtime
      try {
        await listen(server, config.port ?? 4317, config.bindHost || '0.0.0.0')
        started = true
        const address = server.address()
        const port = address && typeof address === 'object' ? address.port : config.port
        taskSnapshotBackups.start()
        archiveGitSync.start()
        requestHandler.setStartedAt(new Date().toISOString())
        if (pluginHost) {
          try {
            const pluginState = await pluginHost.start()
            logger.info('team 插件已装载', {
              plugins: pluginState.plugins.map((plugin) => `${plugin.id}:${plugin.status}`),
            })
          } catch (error) {
            logger.error('team 插件装载失败', { error: error.message })
          }
        } else {
          logger.info('team 插件未启用（默认屏蔽；设置 TRELLIS_TEAM_PLUGINS_ALLOWLIST 显式放行）')
        }
        logger.info('Trellis Team Board 已启动', {
          url: `http://${config.bindHost || '0.0.0.0'}:${port}`,
          bindHost: config.bindHost || '0.0.0.0',
          port,
        })
        return runtime
      } catch (error) {
        closing = true
        shutdown.abort()
        boardEvents.close()
        agentEvents.close()
        taskSnapshotBackups.stop()
        await archiveGitSync.stop()
        await closeServer(server)
        await pluginHost?.stop().catch(() => {})
        await taskSpaceIndex.close().catch(() => {})
        db.close()
        throw error
      }
    }

    async function stop() {
      if (closing) return
      closing = true
      shutdown.abort()
      boardEvents.close()
      agentEvents.close()
      taskSnapshotBackups.stop()
      await archiveGitSync.stop()
      await closeServer(server)
      await pluginHost?.stop().catch(() => {})
      await taskSpaceIndex.close()
      db.close()
    }

    const runtime = {
      mode: 'team',
      config,
      db,
      server,
      services: {
        taskSpaces,
        taskSnapshots,
        ownershipInbox,
        taskSpaceIndex,
        taskCommands,
        taskControl,
        archiveGitSync,
        agentService,
        agentEvents,
        boardEvents,
        boardService,
        taskSnapshotBackups,
        archiveSnapshots,
      },
      start,
      stop,
      address() {
        return server.address()
      },
    }
    return runtime
  } catch (error) {
    db.close()
    throw error
  }
}

export { MAX_JSON_BYTES, MAX_LIVE_BATCH_BYTES, readJsonBody } from './http/common.js'
