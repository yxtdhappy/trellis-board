import './env-bootstrap.js'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { dataDir } from './config.js'
import { createServerLogger } from './logger.js'
import { startApplication } from './standalone/server.js'

export {
  startApplication,
  startStandaloneServer,
  stopStandaloneServer,
} from './standalone/server.js'

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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
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
