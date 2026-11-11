import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { createUser, readSession, revokeSession } from '../server/team/auth.js'
import { createTeamRuntime } from '../server/team/http.js'

const PUBLIC_ORIGIN = 'http://127.0.0.1:4317'
const HOST = '127.0.0.1:4317'
const SILENT_LOGGER = { info() {}, warn() {}, error() {} }

function testConfig() {
  return {
    mode: 'team',
    bindHost: '127.0.0.1',
    port: 0,
    publicUrl: new URL(PUBLIC_ORIGIN),
    publicOrigin: PUBLIC_ORIGIN,
    sessionTtlMs: 12 * 60 * 60 * 1000,
    agentStaleMs: 60_000,
    cookieSecure: false,
    trustProxy: false,
    allowLocalGitRemotes: false,
  }
}

function request(runtime, pathname, { method = 'GET', body = null, cookie = null } = {}) {
  const { port } = runtime.address()
  const payload = body == null ? null : JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const headers = { host: HOST }
    if (payload != null) {
      headers['content-type'] = 'application/json'
      headers['content-length'] = Buffer.byteLength(payload)
    }
    if (method !== 'GET' && method !== 'HEAD') headers.origin = PUBLIC_ORIGIN
    if (cookie) headers.cookie = cookie
    const outgoing = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: pathname,
        method,
        headers,
      },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json = null
          if (text) {
            try {
              json = JSON.parse(text)
            } catch {
              json = text
            }
          }
          resolve({ status: response.statusCode, headers: response.headers, body: json })
        })
      },
    )
    outgoing.on('error', reject)
    if (payload != null) outgoing.write(payload)
    outgoing.end()
  })
}

function openEventStream(runtime, cookie) {
  const { port } = runtime.address()
  return new Promise((resolve, reject) => {
    const outgoing = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/api/board/events',
        method: 'GET',
        headers: {
          host: HOST,
          accept: 'text/event-stream',
          cookie,
        },
      },
      (response) => {
        const chunks = []
        response.setEncoding('utf8')
        response.on('data', (chunk) => chunks.push(chunk))
        let closedResolve
        const closed = new Promise((done) => {
          closedResolve = done
        })
        response.once('end', closedResolve)
        response.once('close', closedResolve)
        resolve({
          request: outgoing,
          response,
          closed,
          text: () => chunks.join(''),
        })
      },
    )
    outgoing.on('error', reject)
    outgoing.end()
  })
}

function cookieOf(response) {
  return String((response.headers['set-cookie'] || [])[0] || '').split(';')[0]
}

async function waitFor(predicate, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail('等待团队 SSE 条件超时')
}

test('团队 Board SSE 使用 Session 鉴权并广播任务变更', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-board-events-'))
  const runtime = await createTeamRuntime({
    config: testConfig(),
    databaseFile: path.join(root, 'data', 'board.sqlite'),
    dataDir: path.join(root, 'data'),
    logger: SILENT_LOGGER,
    requireAdmin: false,
    enablePolling: false,
    boardEventOptions: { heartbeatMs: 20, debounceMs: 5 },
  })
  await runtime.start()
  t.after(async () => {
    await runtime.stop()
    fs.rmSync(root, { recursive: true, force: true })
  })

  const unauthorized = await request(runtime, '/api/board/events')
  assert.equal(unauthorized.status, 401)

  await createUser(runtime.db, {
    username: 'sse-user',
    displayName: 'SSE User',
    password: 'SSE-Password-123',
    systemAdmin: true,
    mustChangePassword: false,
  })
  const login = await request(runtime, '/api/auth/login', {
    method: 'POST',
    body: { username: 'sse-user', password: 'SSE-Password-123' },
  })
  assert.equal(login.status, 200)
  const cookie = cookieOf(login)
  const stream = await openEventStream(runtime, cookie)
  t.after(() => stream.request.destroy())

  assert.equal(stream.response.statusCode, 200)
  assert.equal(stream.response.headers['content-type'], 'text/event-stream; charset=utf-8')
  assert.equal(stream.response.headers['cache-control'], 'no-store')
  assert.equal(stream.response.headers['x-accel-buffering'], 'no')

  runtime.services.boardEvents.publish({ revision: 41 })
  runtime.services.boardEvents.publish({ revision: 42 })
  await waitFor(() => stream.text().includes('event: tasks.changed'))
  assert.equal(stream.text().match(/event: tasks\.changed/g)?.length, 1)
  const dataLine = stream
    .text()
    .split('\n')
    .find((line) => line.startsWith('data: '))
  assert.ok(dataLine)
  const event = JSON.parse(dataLine.slice(6))
  assert.equal(event.revision, 42)

  const token = cookie.slice(cookie.indexOf('=') + 1)
  const session = readSession(runtime.db, token)
  assert.ok(session)
  revokeSession(runtime.db, session.sessionId)
  await Promise.race([
    stream.closed,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Session 失效后 SSE 未关闭')), 1500),
    ),
  ])
})
