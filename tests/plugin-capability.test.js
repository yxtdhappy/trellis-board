import test from 'node:test'
import assert from 'node:assert/strict'
import { createHarness, fixtureModule, startHttpServer } from './helpers/plugin-runtime.js'

function plugin(id, extra = {}) {
  return {
    id,
    module: fixtureModule(id),
    enabled: true,
    ...extra,
  }
}

async function request(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method ?? 'GET',
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  })
  const text = await response.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  return { status: response.status, json, text }
}

test('provider 先于 consumer 启动，consumer 能调用声明的 capability', async () => {
  const harness = await createHarness({
    plugins: [plugin('cap-consumer'), plugin('cap-provider')],
  })
  const http = await startHttpServer(harness.runtime)
  try {
    assert.equal(harness.supervisor.plugins.get('cap-provider').status, 'running')
    assert.equal(harness.supervisor.plugins.get('cap-consumer').status, 'running')
    const response = await request(http.baseUrl, '/api/plugins/cap-consumer/echo')
    assert.equal(response.status, 200)
    assert.deepEqual(response.json.result, { text: 'hello', caller: 'cap-consumer' })
  } finally {
    await http.close()
    await harness.cleanup()
  }
})

test('consumer 调用未声明的方法被拒绝', async () => {
  const harness = await createHarness({
    plugins: [plugin('cap-provider'), plugin('cap-consumer')],
  })
  const http = await startHttpServer(harness.runtime)
  try {
    const response = await request(http.baseUrl, '/api/plugins/cap-consumer/forbidden')
    assert.equal(response.status, 403)
    assert.equal(response.json.code, 1001)
  } finally {
    await http.close()
    await harness.cleanup()
  }
})

test('缺少 provider 时 consumer 仍启动，调用返回 capability 不可用', async () => {
  const harness = await createHarness({ plugins: [plugin('cap-consumer')] })
  const http = await startHttpServer(harness.runtime)
  try {
    const state = harness.supervisor.plugins.get('cap-consumer')
    assert.equal(state.status, 'running')
    const status = await request(http.baseUrl, '/api/plugins')
    const described = status.json.plugins.find((item) => item.id === 'cap-consumer')
    assert.equal(described.capabilityStatus[0].available, false)
    const response = await request(http.baseUrl, '/api/plugins/cap-consumer/echo')
    assert.equal(response.status, 503)
    assert.equal(response.json.code, 1009)
  } finally {
    await http.close()
    await harness.cleanup()
  }
})

test('provider 停止后 capability 不可用', async () => {
  const harness = await createHarness({
    plugins: [plugin('cap-consumer'), plugin('cap-provider')],
  })
  const http = await startHttpServer(harness.runtime)
  try {
    const stopped = await request(http.baseUrl, '/api/plugins/cap-provider/stop', {
      method: 'POST',
    })
    assert.equal(stopped.status, 200)
    const response = await request(http.baseUrl, '/api/plugins/cap-consumer/echo')
    assert.equal(response.status, 503)
    assert.equal(response.json.code, 1009)
  } finally {
    await http.close()
    await harness.cleanup()
  }
})

test('provider 未注册清单声明的 capability 时启动失败', async () => {
  const harness = await createHarness({ plugins: [plugin('cap-provider-empty')] })
  try {
    const state = harness.supervisor.plugins.get('cap-provider-empty')
    assert.notEqual(state.status, 'running')
    assert.match(state.lastError, /未注册清单声明的 capability/)
  } finally {
    await harness.cleanup()
  }
})
