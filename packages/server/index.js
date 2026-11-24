import './env-bootstrap.js'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { dataDir, parseTeamConfig } from './config.js'
import { createServerLogger } from './logger.js'
import { migrateLegacyRuntimeData } from './data-migration.js'
import { createTeamRuntime } from './team/http.js'

/**
 * 唯一启动入口：Team 服务端。
 * standalone 模式已删除，TRELLIS_BOARD_MODE 只接受 `team`。
 */
export async function startApplication(config = parseTeamConfig(), logger = console) {
  migrateLegacyRuntimeData()
  const runtime = await createTeamRuntime({ config, logger })
  const started = await runtime.start()
  void started.services.taskSpaceIndex.warmActive()
  return started
}

let activeRuntime = null
let stopping = false
let activeLogger = console

async function stopActiveRuntime() {
  if (stopping || !activeRuntime) return
  stopping = true
  try {
    await activeRuntime.stop()
  } catch (error) {
    activeLogger.error('关闭服务失败', error)
  }
}

export function runServerEntry() {
  const logger = createServerLogger({ dataDir })
  activeLogger = logger
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runServerEntry()
}
