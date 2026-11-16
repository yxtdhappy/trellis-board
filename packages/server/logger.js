import path from 'node:path'
import { formatWithOptions } from 'node:util'
import pino from 'pino'
import pinoRoll from 'pino-roll'

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024
const DEFAULT_MAX_FILES = 5
const QUEUE_LIMIT = 1000

const SENSITIVE_KEY = String.raw`[A-Za-z0-9_-]*(?:authorization|cookie|session|api[-_]?key|password|pairing[-_]?code|credential|token|secret)[A-Za-z0-9_-]*`
const SENSITIVE_HEADER_ASSIGNMENT = new RegExp(
  String.raw`(["']?(?:authorization|cookie|set-cookie)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\r\n]+)`,
  'gi',
)
const SENSITIVE_ASSIGNMENT = new RegExp(
  String.raw`(["']?${SENSITIVE_KEY}["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\r\n,}\]]+)`,
  'gi',
)

export function serverLogDir(dataDir) {
  return path.join(dataDir, 'logs')
}

export function redactServerLogText(value) {
  return String(value ?? '')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/((?:[a-z][a-z0-9+.-]*):\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, '$1[REDACTED]@')
    .replace(SENSITIVE_HEADER_ASSIGNMENT, '$1[REDACTED]')
    .replace(SENSITIVE_ASSIGNMENT, '$1[REDACTED]')
    .replace(/(["'])(?:[A-Za-z]:[\\/]|\\\\[^\\\s]+\\)[^\r\n]*?\1/g, '$1[本地路径]$1')
    .replace(/\b[A-Za-z]:[\\/][^\s"'<>|,;)\]}]+/g, '[本地路径]')
    .replace(/\\\\[^\\\s]+\\[^\s"'<>|,;)\]}]+/g, '[本地路径]')
}

function formatMessage(args) {
  return formatWithOptions(
    {
      colors: false,
      depth: 6,
      breakLength: Infinity,
      maxArrayLength: 100,
      maxStringLength: 50_000,
    },
    ...args,
  )
}

export function createServerLogger({
  dataDir,
  console: consoleWriter = console,
  maxBytes = DEFAULT_MAX_BYTES,
  maxFiles = DEFAULT_MAX_FILES,
} = {}) {
  let stream = null
  let fileLogger = null
  let disabled = false
  let closed = false
  let closePromise = null
  const queued = []

  function reportFailure(error) {
    try {
      consoleWriter.error('服务端日志文件写入失败，已降级为仅控制台输出', error)
    } catch {
      // 控制台不可用时不能再制造二次异常。
    }
  }

  function degrade(error) {
    if (disabled) return
    disabled = true
    queued.length = 0
    reportFailure(error)
  }

  function writeConsole(method, args) {
    try {
      consoleWriter[method](...args)
    } catch {
      // 控制台异常不能影响文件日志或业务请求。
    }
  }

  // pino-roll 需要异步探测已有序号，启动瞬间的日志先排队再补写。
  const ready = pinoRoll({
    file: path.join(serverLogDir(dataDir), 'server'),
    extension: '.log',
    size: `${maxBytes}b`,
    limit: { count: Math.max(1, maxFiles - 1) },
    mkdir: true,
  })
    .then((destination) => {
      stream = destination
      destination.on('error', degrade)
      fileLogger = pino(
        { base: null, timestamp: pino.stdTimeFunctions.isoTime, level: 'trace' },
        destination,
      )
      for (const [method, message] of queued.splice(0)) fileLogger[method](message)
    })
    .catch(degrade)

  function write(consoleMethod, fileMethod, args) {
    writeConsole(consoleMethod, args)
    if (closed || disabled) return
    const message = redactServerLogText(formatMessage(args))
    if (fileLogger) {
      fileLogger[fileMethod](message)
      return
    }
    // shortcut: 只有启动探测与磁盘阻塞期间会排队，超过上限就丢弃，避免日志拖住服务。
    if (queued.length < QUEUE_LIMIT) queued.push([fileMethod, message])
  }

  async function flush() {
    await ready
    if (!fileLogger) return
    await new Promise((resolve) => fileLogger.flush(resolve))
  }

  function close() {
    if (!closePromise) {
      closed = true
      // SonicBoom 异步打开文件，end() 的 close 事件是数据落盘的唯一可靠信号。
      closePromise = ready.then(
        () =>
          new Promise((resolve) => {
            if (!stream || disabled) {
              resolve()
              return
            }
            stream.once('close', resolve)
            stream.end()
          }),
      )
    }
    return closePromise
  }

  return {
    log(...args) {
      write('log', 'info', args)
    },
    info(...args) {
      write('info', 'info', args)
    },
    warn(...args) {
      write('warn', 'warn', args)
    },
    error(...args) {
      write('error', 'error', args)
    },
    flush,
    close,
  }
}
