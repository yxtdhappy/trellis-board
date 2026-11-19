import http from 'node:http'
import { parseTeamConfig } from '../config.js'
import { migrateLegacyRuntimeData } from '../data-migration.js'
import { createTeamRuntime } from '../team/http.js'
import { createStandaloneState, initializeStandaloneState } from './state.js'
import { writeBoardState } from './board-state.js'
import { sendJson } from './http-io.js'
import { handleApi } from './api.js'
import { startFileWatcher } from './watcher.js'
import { handlePluginRequest, startPluginRuntime } from './plugins.js'
import { refreshBoardFromFiles } from './refresh.js'
import { rejectPendingScans } from './scan-worker.js'
import { servePluginUi, serveStatic } from './static.js'

let activeState = null
let activeServer = null

function createStandaloneServer(state) {
  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`)
      if (url.pathname.startsWith('/api/')) await handleApi(state, request, response, url)
      else if (url.pathname.startsWith('/plugin-ui/')) servePluginUi(state, request, response, url)
      else if (!(await handlePluginRequest(state, request, response, url))) {
        serveStatic(state, request, response, url)
      }
    } catch (error) {
      state.logger.error(error)
      sendJson(response, 400, { error: error instanceof Error ? error.message : '执行失败' })
    }
  })
}

function listen(server, port, bindHost) {
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
  const state = createStandaloneState({ port: standalonePort, logger })
  initializeStandaloneState(state)
  const server = createStandaloneServer(state)
  activeState = state
  activeServer = server
  try {
    await listen(server, state.port, bindHost)
    writeBoardState(state, {
      serverStartedAt: new Date().toISOString(),
      refreshStartedAt: null,
      refreshQueued: false,
      refreshQueuedReason: null,
      executionWipLimit: state.persistence.readExecutionWipLimit(),
    })
    await startFileWatcher(state)
    await startPluginRuntime(state)
    refreshBoardFromFiles(state, 'startup').catch((error) => {
      state.logger.error('启动后的后台扫描失败', error)
    })
    const loopbackHost = bindHost === '127.0.0.1' || bindHost === 'localhost' || bindHost === '::1'
    const allInterfaces = bindHost === '0.0.0.0' || bindHost === '::' || bindHost === '[::]'
    const address = server.address()
    const shownPort = address && typeof address === 'object' ? address.port : state.port
    if (!loopbackHost) {
      state.logger.warn(
        `Trellis Board 监听 ${bindHost}，standalone 模式没有账号鉴权，请只在可信网络内使用`,
      )
    }
    state.logger.log(
      `Trellis Board: http://${loopbackHost ? '127.0.0.1' : bindHost}:${shownPort}${
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
  const state = activeState
  const server = activeServer
  activeState = null
  activeServer = null
  if (!state) return
  state.boardEventService?.close()
  state.boardEventService = null
  await state.pluginRuntime?.stop()
  state.pluginRuntime = null
  await state.watchRuntime?.close()
  state.watchRuntime = null
  clearTimeout(state.watchDebounceTimer)
  state.watchDebounceTimer = null
  if (state.scanWorkerRuntime) {
    const worker = state.scanWorkerRuntime
    state.scanWorkerRuntime = null
    rejectPendingScans(state, new Error('服务正在关闭'))
    await worker.terminate()
  }
  if (server?.listening) {
    await new Promise((resolve) => {
      server.close(() => resolve())
      const timer = setTimeout(() => server.closeAllConnections?.(), 5_000)
      timer.unref?.()
    })
  }
  state.database?.close()
  state.database = null
}

export async function startApplication(config = parseTeamConfig(), logger = console) {
  migrateLegacyRuntimeData()
  if (config.mode === 'team') {
    const runtime = await createTeamRuntime({ config, logger })
    const started = await runtime.start()
    void started.services.taskSpaceIndex.warmActive()
    return started
  }
  return startStandaloneServer({
    standalonePort: config.port,
    bindHost: config.bindHost,
    logger,
  })
}
