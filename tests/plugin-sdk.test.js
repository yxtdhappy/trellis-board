import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { startPluginRuntime } from '../server/plugins/sdk.js'
import { createFrameDecoder } from '../server/plugins/protocol.js'

function createHost() {
  const inbound = new PassThrough()
  const outbound = new PassThrough()
  const messages = []
  const decoder = createFrameDecoder({
    onMessage: (message) => messages.push(message),
  })
  outbound.on('data', (chunk) => decoder.push(chunk))
  return {
    inbound,
    outbound,
    messages,
    send(message) {
      inbound.write(`${JSON.stringify(message)}\n`)
    },
    async waitFor(predicate, timeoutMs = 2000) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const found = messages.find(predicate)
        if (found) return found
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      throw new Error(`等待消息超时，已收到: ${JSON.stringify(messages)}`)
    },
  }
}

async function startPlugin(plugin, host) {
  const runtime = startPluginRuntime(plugin, {
    input: host.inbound,
    output: host.outbound,
    exit: () => {},
  })
  host.send({
    jsonrpc: '2.0',
    id: 'init',
    method: 'initialize',
    params: {
      apiVersion: 1,
      hostVersion: '0.1.0',
      pluginId: plugin.name,
      config: { greeting: 'hi' },
      permissions: plugin.permissions,
      dataDir: '/tmp',
      repositories: [],
    },
  })
  const handshake = await host.waitFor((message) => message.id === 'init')
  return { runtime, handshake }
}

test('initialize 回握手信息，capabilities 反映已注册能力', async () => {
  const host = createHost()
  const plugin = {
    name: 'unit',
    version: '1.2.3',
    apiVersion: 1,
    permissions: ['http:route', 'events'],
    async onStart(ctx) {
      ctx.http.route('GET', '/ping', () => ({ status: 200, body: { pong: true } }))
      ctx.events.on('x', () => {})
    },
  }
  const { runtime, handshake } = await startPlugin(plugin, host)
  try {
    assert.deepEqual(handshake.result, {
      apiVersion: 1,
      id: 'unit',
      name: 'unit',
      version: '1.2.3',
      capabilities: { http: true, events: true, schedule: false },
    })
  } finally {
    await runtime.stop()
  }
})

test('http/request 命中路由并归一化返回值', async () => {
  const host = createHost()
  const plugin = {
    name: 'unit',
    version: '1.0.0',
    apiVersion: 1,
    permissions: ['http:route'],
    async onStart(ctx) {
      ctx.http.route('POST', '/echo', (request) => ({
        status: 201,
        body: { received: request.json() },
      }))
    },
  }
  const { runtime } = await startPlugin(plugin, host)
  try {
    host.send({
      jsonrpc: '2.0',
      id: 'h1',
      method: 'http/request',
      params: {
        method: 'POST',
        path: '/echo?x=1',
        headers: {},
        body: JSON.stringify({ a: 1 }),
      },
    })
    const response = await host.waitFor((message) => message.id === 'h1')
    assert.equal(response.result.status, 201)
    assert.deepEqual(response.result.body, { received: { a: 1 } })

    host.send({
      jsonrpc: '2.0',
      id: 'h2',
      method: 'http/request',
      params: { method: 'GET', path: '/missing' },
    })
    const missing = await host.waitFor((message) => message.id === 'h2')
    assert.equal(missing.result.status, 404)
  } finally {
    await runtime.stop()
  }
})

test('event/dispatch 调用处理器并发回 event/ack', async () => {
  const host = createHost()
  const seen = []
  const plugin = {
    name: 'unit',
    version: '1.0.0',
    apiVersion: 1,
    permissions: ['events'],
    async onStart(ctx) {
      ctx.events.on('task.*', (event) => {
        seen.push(event)
      })
    },
  }
  const { runtime } = await startPlugin(plugin, host)
  try {
    host.send({
      jsonrpc: '2.0',
      id: 'e1',
      method: 'event/dispatch',
      params: {
        eventId: 7,
        name: 'task.created',
        payload: { taskKey: 'repo::t' },
        occurredAt: '2026-01-01T00:00:00.000Z',
      },
    })
    await host.waitFor((message) => message.id === 'e1')
    const ack = await host.waitFor((message) => message.method === 'event/ack')
    assert.deepEqual(ack.params, { eventId: 7 })
    assert.equal(seen.length, 1)
    assert.equal(seen[0].payload.taskKey, 'repo::t')
  } finally {
    await runtime.stop()
  }
})

test('ctx.store 走宿主 RPC 并等待响应', async () => {
  const host = createHost()
  const plugin = {
    name: 'unit',
    version: '1.0.0',
    apiVersion: 1,
    permissions: ['store'],
    async onStart(ctx) {
      ctx.store.set('k', { v: 1 })
    },
  }
  const { runtime } = await startPlugin(plugin, host)
  try {
    const request = await host.waitFor((message) => message.method === 'store/set')
    assert.equal(request.params.key, 'k')
    assert.deepEqual(request.params.value, { v: 1 })
    host.send({ jsonrpc: '2.0', id: request.id, result: { value: { v: 1 } } })
  } finally {
    await runtime.stop()
  }
})

test('shutdown 逆序执行 effect 并调用 onStop', async () => {
  const host = createHost()
  const order = []
  const plugin = {
    name: 'unit',
    version: '1.0.0',
    apiVersion: 1,
    permissions: [],
    async onStart(ctx) {
      ctx.effect(() => order.push('first'))
      ctx.effect(() => order.push('second'))
    },
    async onStop() {
      order.push('onStop')
    },
  }
  const { runtime } = await startPlugin(plugin, host)
  try {
    host.send({ jsonrpc: '2.0', id: 's1', method: 'shutdown', params: {} })
    await host.waitFor((message) => message.id === 's1')
    assert.deepEqual(order, ['second', 'first', 'onStop'])
  } finally {
    await runtime.stop()
  }
})

test('处理器抛 PluginError 时按 data.code 返回', async () => {
  const host = createHost()
  const plugin = {
    name: 'unit',
    version: '1.0.0',
    apiVersion: 1,
    permissions: ['http:route'],
    async onStart(ctx) {
      ctx.http.route('GET', '/boom', () => {
        throw ctx.error(1004, '写任务被拒绝')
      })
    },
  }
  const { runtime } = await startPlugin(plugin, host)
  try {
    host.send({
      jsonrpc: '2.0',
      id: 'b1',
      method: 'http/request',
      params: { method: 'GET', path: '/boom' },
    })
    const response = await host.waitFor((message) => message.id === 'b1')
    assert.equal(response.error.data.code, 1004)
    assert.equal(response.error.message, '写任务被拒绝')
  } finally {
    await runtime.stop()
  }
})

test('未知宿主方法回 -32601', async () => {
  const host = createHost()
  const plugin = {
    name: 'unit',
    version: '1.0.0',
    apiVersion: 1,
    permissions: [],
  }
  const { runtime } = await startPlugin(plugin, host)
  try {
    host.send({ jsonrpc: '2.0', id: 'u1', method: 'wat/read', params: {} })
    const response = await host.waitFor((message) => message.id === 'u1')
    assert.equal(response.error.code, -32601)
  } finally {
    await runtime.stop()
  }
})
