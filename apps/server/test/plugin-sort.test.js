import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import {
  createHarness,
  fixtureModule,
  startHttpServer,
} from '@trellis-board/test-support/plugin-runtime.js'

function entries() {
  return [
    { id: 'panel-alpha', module: fixtureModule('panel-alpha'), enabled: true },
    { id: 'panel-beta', module: fixtureModule('panel-beta'), enabled: true },
  ]
}

async function setup() {
  const harness = await createHarness({ plugins: entries(), hostVersion: '0.1.0' })
  const http = await startHttpServer(harness.runtime)
  const api = async (method, path, body) => {
    const response = await fetch(`${http.baseUrl}${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await response.text()
    return { status: response.status, data: text ? JSON.parse(text) : null }
  }
  return {
    async cleanup() {
      await http.close()
      await harness.cleanup()
    },
    api,
    harness,
    async config() {
      return JSON.parse(fs.readFileSync(harness.workspace.configFile, 'utf8'))
    },
  }
}

test('面板默认按清单里的 order 排序', async () => {
  const { api, cleanup } = await setup()
  try {
    const { status, data } = await api('GET', '/api/panels')
    assert.equal(status, 200)
    assert.deepEqual(
      data.panels.map((panel) => panel.pluginId),
      ['panel-alpha', 'panel-beta'],
    )
    assert.deepEqual(
      data.panels.map((panel) => panel.sort),
      [10, 20],
    )
  } finally {
    await cleanup()
  }
})

test('设置 sort 后写回 plugins.json 并立即改面板顺序', async () => {
  const { api, cleanup, config, harness } = await setup()
  try {
    const { status, data } = await api('POST', '/api/plugins/panel-beta/sort', { sort: 1 })
    assert.equal(status, 200)
    assert.equal(data.plugin.sort, 1)

    const { data: panels } = await api('GET', '/api/panels')
    assert.deepEqual(
      panels.panels.map((panel) => panel.pluginId),
      ['panel-beta', 'panel-alpha'],
    )
    assert.deepEqual(
      panels.panels.map((panel) => panel.sort),
      [1, 10],
    )

    const { data: list } = await api('GET', '/api/plugins')
    const beta = list.plugins.find((plugin) => plugin.id === 'panel-beta')
    assert.equal(beta.sort, 1)

    const raw = await config()
    assert.equal(raw.plugins.find((entry) => entry.id === 'panel-beta').sort, 1)
    // 其它插件、其它字段都要原样保留
    const alpha = raw.plugins.find((entry) => entry.id === 'panel-alpha')
    assert.equal(alpha.sort, undefined)
    assert.equal(alpha.module, fixtureModule('panel-alpha'))
    assert.equal(alpha.enabled, true)
    // 排序不重启插件
    const state = harness.supervisor.plugins.get('panel-beta')
    assert.equal(state.status, 'running')
    assert.equal(state.restarts, 0)
  } finally {
    await cleanup()
  }
})

test('sort 为 null 时清掉字段并回到清单顺序', async () => {
  const { api, cleanup, config } = await setup()
  try {
    await api('POST', '/api/plugins/panel-beta/sort', { sort: -5 })
    const { data: reordered } = await api('GET', '/api/panels')
    assert.equal(reordered.panels[0].pluginId, 'panel-beta')

    const { status, data } = await api('POST', '/api/plugins/panel-beta/sort', { sort: null })
    assert.equal(status, 200)
    assert.equal(data.plugin.sort, null)

    const raw = await config()
    assert.equal('sort' in raw.plugins.find((entry) => entry.id === 'panel-beta'), false)

    const { data: panels } = await api('GET', '/api/panels')
    assert.deepEqual(
      panels.panels.map((panel) => panel.pluginId),
      ['panel-alpha', 'panel-beta'],
    )
  } finally {
    await cleanup()
  }
})

test('sort 不是数字时返回 400 且不写文件', async () => {
  const { api, cleanup, config } = await setup()
  try {
    const { status, data } = await api('POST', '/api/plugins/panel-alpha/sort', { sort: 'abc' })
    assert.equal(status, 400)
    assert.match(data.error, /sort 必须是数字/)
    const raw = await config()
    assert.equal('sort' in raw.plugins.find((entry) => entry.id === 'panel-alpha'), false)

    const unknown = await api('POST', '/api/plugins/nope/sort', { sort: 1 })
    assert.equal(unknown.status, 404)
  } finally {
    await cleanup()
  }
})

test('reload 后 sort 仍然生效', async () => {
  const { api, cleanup, harness, config } = await setup()
  try {
    await api('POST', '/api/plugins/panel-beta/sort', { sort: 2 })
    await harness.supervisor.reloadConfig({ reason: 'test' })
    const raw = await config()
    assert.equal(raw.plugins.find((entry) => entry.id === 'panel-beta').sort, 2)
    assert.equal(harness.supervisor.plugins.get('panel-beta').sort, 2)

    const { data } = await api('GET', '/api/panels')
    assert.deepEqual(
      data.panels.map((panel) => panel.pluginId),
      ['panel-beta', 'panel-alpha'],
    )
  } finally {
    await cleanup()
  }
})

test('同一 sort 时按清单 order、再按标题排序', async () => {
  const { api, cleanup } = await setup()
  try {
    await api('POST', '/api/plugins/panel-beta/sort', { sort: 10 })
    const { data } = await api('GET', '/api/panels')
    // alpha order 10、beta order 20 → alpha 在前
    assert.deepEqual(
      data.panels.map((panel) => panel.id),
      ['alpha', 'beta'],
    )
  } finally {
    await cleanup()
  }
})
