import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  createHarness,
  fixtureModule,
  startHttpServer,
  waitFor,
} from '../../../packages/test-support/plugin-runtime.js'

function configEchoPlugin(config = {}) {
  return {
    id: 'config-echo',
    module: fixtureModule('config-echo'),
    enabled: true,
    config,
  }
}

function secretsFile(workspace) {
  return path.join(workspace.dataDir, 'plugins.secrets.json')
}

function writeSecrets(workspace, refs, { mode = 0o600 } = {}) {
  const file = secretsFile(workspace)
  fs.writeFileSync(file, JSON.stringify({ version: 1, refs }, null, 2))
  if (process.platform !== 'win32') fs.chmodSync(file, mode)
  return file
}

function tokenConfig() {
  return { credentials: { mode: 'token', token: 'secret:config-echo/token' } }
}

test('secret 变化后 reload 重启插件并注入新值', async () => {
  const harness = await createHarness({
    plugins: [configEchoPlugin(tokenConfig())],
    secrets: { version: 1, refs: { 'config-echo/token': 'token-v1' } },
  })
  try {
    const state = harness.supervisor.plugins.get('config-echo')
    assert.equal(state.status, 'running')
    assert.equal(state.config.credentials.token, 'token-v1')
    const firstPid = state.pid

    writeSecrets(harness.workspace, { 'config-echo/token': 'token-v2' })
    const result = await harness.runtime.reload()

    assert.equal(result.ok, true)
    assert.deepEqual(result.changed, ['config-echo'])
    assert.deepEqual(result.restarted, ['config-echo'])
    assert.equal(state.config.credentials.token, 'token-v2')
    assert.equal(state.status, 'running')
    assert.notEqual(state.pid, firstPid)
    assert.equal(state.restarts, 0)

    const echoed = await harness.supervisor.forwardHttp(state, {
      method: 'GET',
      path: '/config',
      headers: {},
      body: '',
    })
    assert.equal(echoed.status, 200)
    assert.equal(echoed.body.boot.credentials.token, 'token-v2')
    assert.ok(
      harness.store.listAudit('config-echo').some((entry) => entry.kind === 'config'),
    )
  } finally {
    await harness.cleanup()
  }
})

test('配置未变化时 reload 不重启插件', async () => {
  const harness = await createHarness({
    plugins: [configEchoPlugin(tokenConfig())],
    secrets: { version: 1, refs: { 'config-echo/token': 'token-v1' } },
  })
  try {
    const state = harness.supervisor.plugins.get('config-echo')
    const firstPid = state.pid
    const result = await harness.runtime.reload()
    assert.equal(result.ok, true)
    assert.deepEqual(result.changed, [])
    assert.deepEqual(result.restarted, [])
    assert.equal(state.pid, firstPid)
  } finally {
    await harness.cleanup()
  }
})

test('补齐缺失 secret 后插件自动启动', async () => {
  const harness = await createHarness({
    plugins: [configEchoPlugin(tokenConfig())],
    secrets: { version: 1, refs: {} },
  })
  try {
    const state = harness.supervisor.plugins.get('config-echo')
    assert.equal(state.status, 'missing-secret')
    assert.equal(state.pid, null)

    writeSecrets(harness.workspace, { 'config-echo/token': 'token-v1' })
    const result = await harness.runtime.reload()

    assert.deepEqual(result.started, ['config-echo'])
    assert.equal(state.status, 'running')
    assert.equal(state.config.credentials.token, 'token-v1')
    assert.ok(state.pid > 0)
  } finally {
    await harness.cleanup()
  }
})

test('删除 secret 后插件转 missing-secret 并停止进程', async () => {
  const harness = await createHarness({
    plugins: [configEchoPlugin(tokenConfig())],
    secrets: { version: 1, refs: { 'config-echo/token': 'token-v1' } },
  })
  try {
    const state = harness.supervisor.plugins.get('config-echo')
    assert.equal(state.status, 'running')

    writeSecrets(harness.workspace, {})
    const result = await harness.runtime.reload()

    assert.deepEqual(result.stopped, ['config-echo'])
    assert.equal(state.status, 'missing-secret')
    assert.equal(state.pid, null)
    assert.match(state.lastError, /缺少配置项: secret:config-echo\/token/)
  } finally {
    await harness.cleanup()
  }
})

test('secrets 文件权限过宽时保留旧配置且不打断插件', async () => {
  if (process.platform === 'win32') return
  const harness = await createHarness({
    plugins: [configEchoPlugin(tokenConfig())],
    secrets: { version: 1, refs: { 'config-echo/token': 'token-v1' } },
  })
  try {
    const state = harness.supervisor.plugins.get('config-echo')
    const firstPid = state.pid

    writeSecrets(harness.workspace, { 'config-echo/token': 'token-v2' }, { mode: 0o644 })
    const result = await harness.runtime.reload()

    assert.equal(result.ok, false)
    assert.match(result.error, /权限过宽/)
    assert.equal(state.config.credentials.token, 'token-v1')
    assert.equal(state.pid, firstPid)
    assert.equal(state.status, 'running')
  } finally {
    await harness.cleanup()
  }
})

test('配置里删除插件后 capability 提供者被注销', async () => {
  const harness = await createHarness({
    plugins: [{ id: 'cap-provider', module: fixtureModule('cap-provider'), enabled: true, config: {} }],
  })
  try {
    assert.equal(harness.supervisor.capabilities.get('demo.echo'), 'cap-provider')
    const state = harness.supervisor.plugins.get('cap-provider')
    assert.equal(state.status, 'running')

    fs.writeFileSync(
      harness.workspace.configFile,
      JSON.stringify({ plugins: [] }, null, 2),
    )
    const result = await harness.runtime.reload()

    assert.deepEqual(result.removed, ['cap-provider'])
    assert.equal(harness.supervisor.plugins.has('cap-provider'), false)
    assert.equal(harness.supervisor.capabilities.get('demo.echo'), undefined)
    assert.equal(await waitFor(() => state.process === null), true)
  } finally {
    await harness.cleanup()
  }
})

test('POST /api/plugins/reload 不会被插件管理路由当成插件 id', async () => {
  const harness = await createHarness({
    plugins: [configEchoPlugin(tokenConfig())],
    secrets: { version: 1, refs: { 'config-echo/token': 'token-v1' } },
  })
  const http = await startHttpServer(harness.runtime)
  try {
    writeSecrets(harness.workspace, { 'config-echo/token': 'token-v2' })
    const response = await fetch(`${http.baseUrl}/api/plugins/reload`, { method: 'POST' })
    const payload = await response.json()
    assert.equal(response.status, 200)
    assert.equal(payload.ok, true)
    assert.deepEqual(payload.restarted, ['config-echo'])

    const wrongMethod = await fetch(`${http.baseUrl}/api/plugins/reload`)
    assert.equal(wrongMethod.status, 404)
  } finally {
    await http.close()
    await harness.cleanup()
  }
})
