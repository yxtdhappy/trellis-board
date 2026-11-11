import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { AgentApiClient } from '../api.js'
import { AGENT_ERROR_CODE, AgentApiError } from '../protocol.js'

async function withServer(handler, callback) {
  const server = http.createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  try {
    return await callback(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

test('HTTP stub 验证配对、心跳、SSE 事件和 Bearer', async () => {
  const seen = []
  await withServer(
    async (request, response) => {
      const body = await readBody(request)
      seen.push({
        url: request.url,
        authorization: request.headers.authorization,
        lastEventId: request.headers['last-event-id'],
        body,
      })
      response.setHeader('content-type', 'application/json')
      if (request.url === '/api/agent/enroll') {
        response.end(
          JSON.stringify({
            agentId: 'agent-1',
            credential: 'c'.repeat(32),
            protocolVersion: 3,
          }),
        )
        return
      }
      if (request.url === '/api/agent/heartbeat') {
        response.end(
          JSON.stringify({
            protocolVersion: 3,
            compatible: true,
            bindings: [],
          }),
        )
        return
      }
      if (request.url === '/api/agent/task-spaces/preflight') {
        response.end(JSON.stringify({ status: 'new', revision: 0, tasks: [] }))
        return
      }
      if (request.url === '/api/agent/events') {
        response.setHeader('content-type', 'text/event-stream')
        response.write('retry: 3000\n\n')
        response.write('id: 7\n')
        response.write('event: command\n')
        response.write(
          'data: {"type":"command","payload":{"command":{"id":"command-1","bindingId":"binding-1","type":"create_task","payload":{"taskSpaceId":"space-1","projectId":"project-1","branchName":"main","title":"客户端任务","assigneeUserId":"user-1","assigneeDevId":"alice"}}}}\n\n',
        )
        response.end()
        return
      }
      if (request.url === '/api/agent/commands/command-1/result') {
        response.end('{}')
        return
      }
      if (request.url === '/api/agent/commands/command-1/start') {
        response.end(JSON.stringify({ execute: true }))
        return
      }
      response.statusCode = 404
      response.end(JSON.stringify({ error: 'not found' }))
    },
    async (serverUrl) => {
      const client = new AgentApiClient({ serverUrl })
      const enroll = await client.enroll({ pairingCode: 'p'.repeat(16), deviceName: 'PC' })
      assert.equal(enroll.agentId, 'agent-1')
      client.setCredential(enroll.credential)
      const heartbeat = await client.heartbeat({ agentId: enroll.agentId })
      assert.equal(heartbeat.compatible, true)
      const preflight = await client.preflightTaskSpaceAccess({
        remoteUrl: 'https://example.com/repo.git',
        branchName: 'main',
        teamId: 'team-1',
      })
      assert.equal(preflight.status, 'new')
      const events = []
      await client.streamEvents({ lastEventId: 6 }, { onEvent: (event) => events.push(event) })
      assert.equal(events.length, 1)
      assert.equal(events[0].id, '7')
      assert.equal(events[0].type, 'command')
      assert.equal(events[0].data.payload.command.payload.taskSpaceId, 'space-1')
      assert.equal(events[0].data.payload.command.type, 'create_task')
      assert.equal((await client.startCommand('command-1')).execute, true)
      await client.submitCommandResult('command-1', { status: 'failed' })
    },
  )
  assert.equal(seen.find((item) => item.url === '/api/agent/enroll').authorization, undefined)
  const streamRequest = seen.find((item) => item.url === '/api/agent/events')
  assert.equal(streamRequest.authorization, `Bearer ${'c'.repeat(32)}`)
  const preflightRequest = seen.find((item) => item.url === '/api/agent/task-spaces/preflight')
  assert.equal(preflightRequest.authorization, `Bearer ${'c'.repeat(32)}`)
  assert.match(preflightRequest.body, /https:\/\/example\.com\/repo\.git/)
  assert.equal(streamRequest.lastEventId, '6')
  assert.equal(
    seen.some((item) => item.body.includes('pairingCode')),
    true,
  )
})

test('401 作为不可重试的凭证撤销错误返回', async () => {
  await withServer(
    async (request, response) => {
      await readBody(request)
      response.statusCode = 401
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ error: 'revoked' }))
    },
    async (serverUrl) => {
      const client = new AgentApiClient({
        serverUrl,
        credential: 'c'.repeat(32),
      })
      await assert.rejects(
        () => client.heartbeat({ agentId: 'agent-1' }),
        (error) => {
          assert.equal(error instanceof AgentApiError, true)
          assert.equal(error.code, AGENT_ERROR_CODE.AUTH_REVOKED)
          assert.equal(error.retryable, false)
          return true
        },
      )
    },
  )
})

test('426 和 429 保留协议及 Retry-After 信息', async () => {
  let calls = 0
  await withServer(
    async (request, response) => {
      await readBody(request)
      calls += 1
      response.statusCode = calls === 1 ? 426 : 429
      response.setHeader('content-type', 'application/json')
      response.setHeader('retry-after', '3')
      response.end(
        JSON.stringify({
          error: 'slow down',
          code: calls === 1 ? 'AGENT_PROTOCOL_UNSUPPORTED' : 'BUSY',
        }),
      )
    },
    async (serverUrl) => {
      const client = new AgentApiClient({
        serverUrl,
        credential: 'c'.repeat(32),
      })
      await assert.rejects(
        () => client.heartbeat({ agentId: 'agent-1' }),
        (error) => error.code === AGENT_ERROR_CODE.PROTOCOL_INCOMPATIBLE,
      )
      await assert.rejects(
        () => client.heartbeat({ agentId: 'agent-1' }),
        (error) =>
          error.code === AGENT_ERROR_CODE.HTTP_ERROR &&
          error.retryable === true &&
          error.retryAfterMs === 3000,
      )
    },
  )
})
