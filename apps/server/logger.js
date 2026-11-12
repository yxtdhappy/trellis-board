import fsp from 'node:fs/promises'
import path from 'node:path'
import { formatWithOptions } from 'node:util'

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024
const DEFAULT_MAX_FILES = 5
const DEFAULT_FLUSH_DELAY_MS = 500
const DEFAULT_FLUSH_BYTES = 64 * 1024
const DEFAULT_MAX_BUFFER_BYTES = 1024 * 1024

const SENSITIVE_KEY = String.raw`[A-Za-z0-9_-]*(?:authorization|cookie|session|api[-_]?key|password|pairing[-_]?code|credential|token|secret)[A-Za-z0-9_-]*`
const SENSITIVE_HEADER_ASSIGNMENT = new RegExp(
  String.raw`(["']?(?:authorization|cookie|set-cookie)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\r\n]+)`,
  'gi',
)
const SENSITIVE_ASSIGNMENT = new RegExp(
  String.raw`(["']?${SENSITIVE_KEY}["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\r\n,}\]]+)`,
  'gi',
)

export function serverLogFile(dataDir) {
  return path.join(dataDir, 'logs', 'server.log')
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
  logFile = serverLogFile(dataDir),
  console: consoleWriter = console,
  maxBytes = DEFAULT_MAX_BYTES,
  maxFiles = DEFAULT_MAX_FILES,
  flushDelayMs = DEFAULT_FLUSH_DELAY_MS,
  flushBytes = DEFAULT_FLUSH_BYTES,
  maxBufferBytes = DEFAULT_MAX_BUFFER_BYTES,
} = {}) {
  const logsDir = path.dirname(logFile)
  let buffer = ''
  let bufferBytes = 0
  let timer = null
  let pending = Promise.resolve()
  let disabled = false
  let closed = false
  let closePromise = null

  function reportFailure(error) {
    try {
      consoleWriter.error('服务端日志文件写入失败，已降级为仅控制台输出', error)
    } catch {
      // 控制台不可用时不能再制造二次异常。
    }
  }

  function writeConsole(method, args) {
    try {
      consoleWriter[method](...args)
    } catch {
      // 控制台异常不能影响文件日志或业务请求。
    }
  }

  function scheduleFlush() {
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      void flush()
    }, flushDelayMs)
    timer.unref?.()
  }

  function write(level, method, args) {
    writeConsole(method, args)
    if (closed || disabled) return

    const message = redactServerLogText(formatMessage(args)).replace(/\r\n?|\n/g, '\\n')
    const line = `${new Date().toISOString()} ${level} ${message}\n`
    const lineBytes = Buffer.byteLength(line, 'utf8')
    if (bufferBytes + lineBytes > maxBufferBytes) {
      // 磁盘长期阻塞时丢弃新增文件行，避免日志反过来拖住服务。
      return
    }

    buffer += line
    bufferBytes += lineBytes
    if (bufferBytes >= flushBytes) {
      void flush()
    } else {
      scheduleFlush()
    }
  }

  async function rotateIfNeeded(incomingBytes) {
    let size = 0
    try {
      size = (await fsp.stat(logFile)).size
    } catch (error) {
      if (error.code === 'ENOENT') return
      throw error
    }
    if (size + incomingBytes <= maxBytes) return

    for (let index = maxFiles - 1; index >= 1; index -= 1) {
      const source = index === 1 ? logFile : `${logFile}.${index - 1}`
      const destination = `${logFile}.${index}`
      try {
        await fsp.rename(source, destination)
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
    }
  }

  async function append(content) {
    await fsp.mkdir(logsDir, { recursive: true, mode: 0o700 })
    await rotateIfNeeded(Buffer.byteLength(content, 'utf8'))
    await fsp.appendFile(logFile, content, { encoding: 'utf8', mode: 0o600 })
  }

  function flush() {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (!buffer || disabled) return pending

    const content = buffer
    buffer = ''
    bufferBytes = 0
    pending = pending.then(async () => {
      if (disabled) return
      try {
        await append(content)
      } catch (error) {
        disabled = true
        reportFailure(error)
      }
    })
    return pending
  }

  function close() {
    if (!closePromise) {
      closed = true
      closePromise = flush().then(() => pending)
    }
    return closePromise
  }

  return {
    log(...args) {
      write('LOG', 'log', args)
    },
    info(...args) {
      write('INFO', 'info', args)
    },
    warn(...args) {
      write('WARN', 'warn', args)
    },
    error(...args) {
      write('ERROR', 'error', args)
    },
    flush,
    close,
  }
}
