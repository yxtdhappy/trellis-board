import test from 'node:test'
import assert from 'node:assert/strict'
import { createHarness, fixtureModule, waitFor } from '@trellis-board/test-support/plugin-runtime.js'

function echoPlugin(extra = {}) {
  return {
    id: 'echo',
    module: fixtureModule('echo'),
    enabled: true,
    config: {},
    ...extra,
  }
}

test('加载并启动 echo 插件，回显版本与握手信息', async () => {
  const harness = await createHarness({ plugins: [echoPlugin()] })
  try {
    const plugin = harness.supervisor.list().find((item) => item.id === 'echo')
    assert.equal(plugin.status, 'running')
    assert.equal(plugin.compatible, true)
    assert.equal(plugin.version, '1.0.0')
    assert.equal(plugin.apiVersion, 1)
    assert.ok(plugin.pid > 0)
    const auditKinds = harness.store.listAudit('echo').map((entry) => entry.kind)
    assert.ok(auditKinds.includes('loaded'))
    assert.ok(auditKinds.includes('started'))
  } finally {
    await harness.cleanup()
  }
})

test('插件命名空间路由经宿主转发到子进程', async () => {
  const harness = await createHarness({ plugins: [echoPlugin()] })
  try {
    const state = harness.supervisor.plugins.get('echo')
    const result = await harness.supervisor.forwardHttp(state, {
      method: 'GET',
      path: '/echo',
      headers: {},
      body: '',
    })
    assert.equal(result.status, 200)
    assert.deepEqual(result.body, { ok: true, path: '/echo', plugin: 'echo' })
  } finally {
    await harness.cleanup()
  }
})

test('事件按 at-least-once 投递，插件 ack 后落库', async () => {
  const harness = await createHarness({ plugins: [echoPlugin()] })
  try {
    harness.runtime.publish('task.created', { taskKey: 'repo::t1' })
    const stored = await waitFor(() => harness.store.getState('echo', 'last:task.created') !== null)
    assert.equal(stored, true)
    assert.deepEqual(harness.store.getState('echo', 'last:task.created'), {
      taskKey: 'repo::t1',
    })
  } finally {
    await harness.cleanup()
  }
})

test('插件崩溃后按退避重启并累加 restarts', async () => {
  const harness = await createHarness({
    plugins: [
      { id: 'crash-on-event', module: fixtureModule('crash-on-event'), enabled: true, config: {} },
    ],
    restartDelaysMs: [30],
    healthIntervalMs: 0,
  })
  try {
    harness.runtime.publish('crash', {})
    const recovered = await waitFor(
      () => {
        const state = harness.supervisor.plugins.get('crash-on-event')
        return state.status === 'running' && state.restarts >= 1 && state.pid
      },
      { timeoutMs: 5000 },
    )
    assert.equal(recovered, true)
    const auditKinds = harness.store.listAudit('crash-on-event').map((entry) => entry.kind)
    assert.ok(auditKinds.includes('crashed'))
  } finally {
    await harness.cleanup()
  }
})

test('10 分钟内达到重启上限后自动禁用', async () => {
  const harness = await createHarness({
    plugins: [
      { id: 'crash-on-event', module: fixtureModule('crash-on-event'), enabled: true, config: {} },
    ],
    restartDelaysMs: [20],
    autoDisableLimit: 2,
    healthIntervalMs: 0,
  })
  try {
    harness.runtime.publish('crash', {})
    const restarted = await waitFor(
      () => {
        const state = harness.supervisor.plugins.get('crash-on-event')
        return state.status === 'running' && state.restarts >= 1
      },
      { timeoutMs: 4000 },
    )
    assert.equal(restarted, true)
    harness.runtime.publish('crash', {})
    const disabled = await waitFor(
      () => harness.supervisor.plugins.get('crash-on-event').status === 'disabled',
      { timeoutMs: 4000 },
    )
    assert.equal(disabled, true)
    const state = harness.supervisor.plugins.get('crash-on-event')
    assert.equal(state.manualStopped, true)
    assert.match(state.lastError, /自动禁用/)
    const restartedManually = await harness.supervisor.startPlugin('crash-on-event')
    assert.equal(restartedManually.status, 'running')
    assert.equal(restartedManually.enabled, true)
  } finally {
    await harness.cleanup()
  }
})

test('握手版本与清单不一致时标记 incompatible 并回 1008', async () => {
  const harness = await createHarness({
    plugins: [
      { id: 'bad-handshake', module: fixtureModule('bad-handshake'), enabled: true, config: {} },
    ],
    start: true,
  })
  try {
    const state = harness.supervisor.plugins.get('bad-handshake')
    assert.equal(state.status, 'incompatible')
    assert.equal(state.reason, '1008')
    assert.equal(state.pid, null)
    assert.match(state.lastError, /版本与清单不一致/)
  } finally {
    await harness.cleanup()
  }
})

test('握手超时把插件标为 error 并终止进程', async () => {
  const harness = await createHarness({
    plugins: [
      {
        id: 'slow',
        module: fixtureModule('slow'),
        enabled: true,
        config: { initializeDelayMs: 1000 },
      },
    ],
    timeoutOverrides: { initialize: 100 },
    healthIntervalMs: 0,
  })
  try {
    const state = harness.supervisor.plugins.get('slow')
    assert.equal(state.status, 'error')
    assert.match(state.lastError, /超时/)
    assert.equal(state.pid, null)
  } finally {
    await harness.cleanup()
  }
})

test('未声明权限的宿主方法回 1001', async () => {
  const harness = await createHarness({ plugins: [echoPlugin()] })
  try {
    const state = harness.supervisor.plugins.get('echo')
    await assert.rejects(
      () =>
        harness.supervisor.handlePluginRequest(state, {
          jsonrpc: '2.0',
          id: 1,
          method: 'task/create',
          params: {},
        }),
      (error) => error.code === 1001,
    )
    const auditKinds = harness.store.listAudit('echo').map((entry) => entry.kind)
    assert.ok(auditKinds.includes('permission_denied'))
  } finally {
    await harness.cleanup()
  }
})

test('未知方法回 -32601，未知插件不能启动', async () => {
  const harness = await createHarness({ plugins: [echoPlugin()] })
  try {
    const state = harness.supervisor.plugins.get('echo')
    await assert.rejects(
      () =>
        harness.supervisor.handlePluginRequest(state, {
          jsonrpc: '2.0',
          id: 2,
          method: 'fs/read',
          params: {},
        }),
      (error) => error.rpcCode === -32601,
    )
    await assert.rejects(() => harness.supervisor.startPlugin('nope'), /未知插件/)
  } finally {
    await harness.cleanup()
  }
})

test('stopPlugin 优雅停止并写审计，stop 后请求回 1007', async () => {
  const harness = await createHarness({ plugins: [echoPlugin()] })
  try {
    const state = harness.supervisor.plugins.get('echo')
    await harness.supervisor.stopPlugin('echo')
    assert.equal(state.status, 'stopped')
    assert.equal(state.pid, null)
    await assert.rejects(
      () =>
        harness.supervisor.forwardHttp(state, {
          method: 'GET',
          path: '/echo',
          headers: {},
          body: '',
        }),
      (error) => error.code === 1007,
    )
    const auditKinds = harness.store.listAudit('echo').map((entry) => entry.kind)
    assert.ok(auditKinds.includes('stopped'))
  } finally {
    await harness.cleanup()
  }
})

test('插件日志落内存环并带版本前缀写文件', async () => {
  const harness = await createHarness({ plugins: [echoPlugin()] })
  try {
    const state = harness.supervisor.plugins.get('echo')
    harness.supervisor.writeLog(state, 'info', 'smoke', { a: 1 })
    const logs = harness.supervisor.getLogs('echo', 10)
    assert.equal(logs.entries.at(-1).message, 'smoke')
    const fs = await import('node:fs')
    const content = fs.readFileSync(logs.logFile, 'utf8')
    assert.match(content, /\[echo@1\.0\.0\]/)
    assert.match(content, /smoke/)
  } finally {
    await harness.cleanup()
  }
})

test('run/progress 通知遇到不存在的 run 不会拖垮宿主', async () => {
  const harness = await createHarness({ plugins: [echoPlugin()] })
  try {
    const state = harness.supervisor.plugins.get('echo')
    assert.doesNotThrow(() => {
      harness.supervisor.handlePluginNotification(state, {
        method: 'run/progress',
        params: { runId: 'echo:missing:1', status: 'running' },
      })
    })
    const entries = harness.supervisor.getLogs('echo', 20).entries
    assert.ok(entries.some((entry) => entry.message === 'run/progress 通知被拒绝'))
    assert.equal(harness.supervisor.plugins.get('echo').status, 'running')
  } finally {
    await harness.cleanup()
  }
})

test('run/start 与 run/progress 通知完整写入 plugin_run', async () => {
  const harness = await createHarness({ plugins: [echoPlugin()] })
  try {
    const state = harness.supervisor.plugins.get('echo')
    const { run } = harness.store.startRun({
      pluginId: 'echo',
      pluginVersion: '1.0.0',
      taskKey: 'repo::a',
    })
    harness.supervisor.handlePluginNotification(state, {
      method: 'run/progress',
      params: { runId: run.runId, result: { lastUpdate: 'agent_message_chunk' } },
    })
    const updated = harness.store.getRun(run.runId)
    assert.equal(updated.status, 'running')
    assert.equal(updated.result.lastUpdate, 'agent_message_chunk')
  } finally {
    await harness.cleanup()
  }
})
