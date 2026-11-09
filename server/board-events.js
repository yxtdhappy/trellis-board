const DEFAULT_HEARTBEAT_MS = 15_000
const DEFAULT_RETRY_MS = 3_000
const DEFAULT_DEBOUNCE_MS = 50

function duration(value, fallback, minimum = 0) {
  const number = Number(value)
  return Number.isFinite(number) && number >= minimum ? number : fallback
}

export function createBoardEventService({
  heartbeatMs = DEFAULT_HEARTBEAT_MS,
  retryMs = DEFAULT_RETRY_MS,
  debounceMs = DEFAULT_DEBOUNCE_MS,
  authorize = () => true,
  now = () => new Date(),
} = {}) {
  const connections = new Set()
  const heartbeatInterval = duration(heartbeatMs, DEFAULT_HEARTBEAT_MS, 1)
  const retryDelay = duration(retryMs, DEFAULT_RETRY_MS, 1)
  const publishDelay = duration(debounceMs, DEFAULT_DEBOUNCE_MS)
  let publishTimer = null
  let pendingEvent = null
  let closed = false

  function allowed(connection) {
    try {
      return connection.authorize() === true
    } catch {
      return false
    }
  }

  function drop(connection, endResponse = true) {
    if (!connections.delete(connection)) return
    if (connection.heartbeat) clearInterval(connection.heartbeat)
    connection.response.off?.('close', connection.onClose)
    connection.response.off?.('error', connection.onError)
    if (endResponse && !connection.response.destroyed && !connection.response.writableEnded) {
      try {
        connection.response.end()
      } catch {
        connection.response.destroy?.()
      }
    }
  }

  function write(connection, chunk) {
    if (connection.response.destroyed || connection.response.writableEnded) {
      drop(connection)
      return false
    }
    try {
      // write=false 表示客户端消费过慢；关闭慢连接比无限堆积服务端内存安全。
      if (!connection.response.write(chunk)) {
        drop(connection)
        return false
      }
      return true
    } catch {
      drop(connection)
      return false
    }
  }

  function open({ response, authorize: connectionAuthorize = authorize } = {}) {
    if (closed || !response || response.destroyed || response.headersSent) return false
    const connection = {
      response,
      authorize: typeof connectionAuthorize === 'function' ? connectionAuthorize : authorize,
      heartbeat: null,
      onClose: null,
      onError: null,
    }
    if (!allowed(connection)) return false

    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    response.flushHeaders?.()

    connection.onClose = () => drop(connection, false)
    connection.onError = () => drop(connection, false)
    response.once('close', connection.onClose)
    response.once('error', connection.onError)
    connections.add(connection)
    response.socket?.setTimeout?.(0)

    connection.heartbeat = setInterval(() => {
      if (!allowed(connection)) {
        drop(connection)
        return
      }
      write(connection, ': heartbeat\n\n')
    }, heartbeatInterval)
    connection.heartbeat.unref?.()

    write(connection, `retry: ${retryDelay}\n\n`)
    return true
  }

  function flush() {
    publishTimer = null
    const event = pendingEvent
    pendingEvent = null
    if (!event) return
    for (const connection of [...connections]) {
      if (!allowed(connection)) {
        drop(connection)
        continue
      }
      const payload = { generatedAt: event.generatedAt }
      if (event.revision != null) payload.revision = event.revision
      write(connection, `event: tasks.changed\ndata: ${JSON.stringify(payload)}\n\n`)
    }
  }

  function publish(event = {}) {
    if (closed) return
    const revision = Number.isSafeInteger(event.revision) ? event.revision : null
    const generatedAt =
      typeof event.generatedAt === 'string' && event.generatedAt
        ? event.generatedAt
        : now().toISOString()
    pendingEvent = {
      generatedAt,
      revision:
        revision == null
          ? pendingEvent?.revision
          : pendingEvent?.revision == null
            ? revision
            : Math.max(pendingEvent.revision, revision),
    }
    if (publishTimer) clearTimeout(publishTimer)
    publishTimer = setTimeout(flush, publishDelay)
    publishTimer.unref?.()
  }

  function close() {
    if (closed) return
    closed = true
    if (publishTimer) clearTimeout(publishTimer)
    publishTimer = null
    pendingEvent = null
    for (const connection of [...connections]) drop(connection)
  }

  return {
    open,
    publish,
    close,
    connectionCount: () => connections.size,
  }
}
