import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import http from 'node:http'

import { createBoardEventService } from '../server/board-events.js'

class FakeResponse extends EventEmitter {
  constructor({ backpressure = false } = {}) {
    super()
    this.backpressure = backpressure
    this.chunks = []
    this.destroyed = false
    this.headers = null
    this.statusCode = null
    this.writableEnded = false
    this.socket = { setTimeout() {} }
  }

  flushHeaders() {}

  writeHead(statusCode, headers) {
    this.statusCode = statusCode
    this.headers = headers
  }

  write(chunk) {
    if (this.destroyed || this.writableEnded) return false
    this.chunks.push(String(chunk))
    return !this.backpressure
  }

  end() {
    if (this.writableEnded) return
    this.writableEnded = true
    this.emit('close')
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await delay(10)
  }
  assert.fail('等待测试条件超时')
}

test('Board SSE 设置协议头并合并短时间内的变更', async () => {
  const service = createBoardEventService({
    heartbeatMs: 1000,
    retryMs: 2500,
    debounceMs: 10,
  })
  const denied = new FakeResponse()
  assert.equal(service.open({ response: denied, authorize: () => false }), false)
  assert.equal(denied.statusCode, null)
  const uncertain = new FakeResponse()
  assert.equal(service.open({ response: uncertain, authorize: () => undefined }), false)
  assert.equal(uncertain.statusCode, null)

  const response = new FakeResponse()
  assert.equal(service.open({ response }), true)
  assert.equal(response.statusCode, 200)
  assert.equal(response.headers['content-type'], 'text/event-stream; charset=utf-8')
  assert.equal(response.headers['cache-control'], 'no-store')
  assert.equal(response.headers.connection, 'keep-alive')
  assert.equal(response.headers['x-accel-buffering'], 'no')
  assert.match(response.chunks.join(''), /retry: 2500/)

  service.publish({ revision: 1, generatedAt: '2026-11-09T00:00:01.000Z' })
  service.publish({ revision: 3, generatedAt: '2026-11-09T00:00:02.000Z' })
  service.publish({ revision: 2, generatedAt: '2026-11-09T00:00:03.000Z' })
  await waitFor(() => response.chunks.join('').includes('event: tasks.changed'))

  const text = response.chunks.join('')
  assert.equal(text.match(/event: tasks\.changed/g)?.length, 1)
  const dataLine = text.split('\n').find((line) => line.startsWith('data: '))
  assert.ok(dataLine)
  assert.deepEqual(JSON.parse(dataLine.slice(6)), {
    generatedAt: '2026-11-09T00:00:03.000Z',
    revision: 3,
  })

  service.close()
  assert.equal(service.connectionCount(), 0)
  assert.equal(response.writableEnded, true)
  assert.equal(response.listenerCount('close'), 0)
  assert.equal(response.listenerCount('error'), 0)
})

test('Board SSE 在鉴权失效和背压时关闭连接', async () => {
  let authorized = true
  const service = createBoardEventService({
    heartbeatMs: 10,
    debounceMs: 5,
  })
  const sessionResponse = new FakeResponse()
  assert.equal(
    service.open({
      response: sessionResponse,
      authorize: () => authorized,
    }),
    true,
  )
  await waitFor(() => sessionResponse.chunks.join('').includes(': heartbeat'))
  authorized = false
  await waitFor(() => service.connectionCount() === 0)
  assert.equal(sessionResponse.writableEnded, true)

  const slowResponse = new FakeResponse()
  assert.equal(service.open({ response: slowResponse }), true)
  slowResponse.backpressure = true
  service.publish({ revision: 4 })
  await waitFor(() => service.connectionCount() === 0)
  assert.equal(slowResponse.writableEnded, true)

  service.close()
})

test('Board SSE 通过真实 HTTP 通知后可从 REST 读取新快照', async () => {
  const service = createBoardEventService({ heartbeatMs: 1000, debounceMs: 5 })
  let snapshot = { title: '旧标题' }
  const server = http.createServer((request, response) => {
    if (request.url === '/api/board/events') {
      service.open({ response })
      return
    }
    if (request.url === '/api/board') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify(snapshot))
      return
    }
    response.writeHead(404)
    response.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()

  let stream
  try {
    stream = await new Promise((resolve, reject) => {
      const request = http.get(
        {
          hostname: '127.0.0.1',
          port,
          path: '/api/board/events',
          headers: { accept: 'text/event-stream' },
        },
        (response) => {
          const chunks = []
          response.setEncoding('utf8')
          response.on('data', (chunk) => chunks.push(chunk))
          resolve({ request, response, text: () => chunks.join('') })
        },
      )
      request.on('error', reject)
    })
    assert.equal(stream.response.statusCode, 200)
    assert.equal(stream.response.headers['content-type'], 'text/event-stream; charset=utf-8')

    snapshot = { title: '新标题' }
    service.publish({ generatedAt: '2026-11-09T00:00:01.000Z' })
    await waitFor(() => stream.text().includes('event: tasks.changed'))

    const board = await new Promise((resolve, reject) => {
      http
        .get(`http://127.0.0.1:${port}/api/board`, (response) => {
          const chunks = []
          response.on('data', (chunk) => chunks.push(chunk))
          response.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))))
        })
        .on('error', reject)
    })
    assert.deepEqual(board, snapshot)
  } finally {
    stream?.request.destroy()
    service.close()
    await new Promise((resolve) => server.close(resolve))
  }
})
