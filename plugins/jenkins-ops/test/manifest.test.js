import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHarness, startHttpServer } from '@trellis-board/test-support/plugin-runtime.js'

const ID = 'jenkins-ops'
const MODULE = fileURLToPath(new URL('../index.js', import.meta.url))
const MANIFEST = JSON.parse(
  fs.readFileSync(fileURLToPath(new URL('../plugin.json', import.meta.url)), 'utf8'),
)

test('jenkins-ops 目录名与清单 id 一致', () => {
  const dir = path.basename(path.dirname(fileURLToPath(new URL('../plugin.json', import.meta.url))))
  assert.equal(MANIFEST.id, dir)
  assert.match(MANIFEST.id, /^[a-z][a-z0-9-]{1,31}$/)
})

test('jenkins-ops 声明面板时必须带 panels 权限', () => {
  assert.ok(Array.isArray(MANIFEST.panels) && MANIFEST.panels.length > 0)
  assert.ok(MANIFEST.permissions.includes('panels'))
  assert.ok(MANIFEST.permissions.includes('capabilities:provide'))
})

test('jenkins-ops 通过真实清单校验与握手', async () => {
  const harness = await createHarness({
    plugins: [{ id: ID, module: MODULE, enabled: true, config: {} }],
    hostVersion: '0.4.24',
  })
  const http = await startHttpServer(harness.runtime)
  try {
    const state = harness.supervisor.plugins.get(ID)
    assert.equal(state.status, 'running', `${ID} 未运行: ${state.lastError}`)
    assert.equal(state.manifest.id, ID)
    assert.equal(state.manifest.apiVersion, 1)
    assert.match(state.manifest.version, /^\d+\.\d+\.\d+/)
    assert.ok(state.manifest.permissions.includes('secrets:write'))

    const capability = state.manifest.provides.find((item) => item.name === 'jenkins.ops')
    assert.ok(capability, '未声明 jenkins.ops capability')
    assert.equal(capability.methods['build.trigger'].access, 'write')
    assert.equal(capability.methods['jobs.list'].access, 'read')

    const payload = await fetch(`${http.baseUrl}/api/plugins`).then((response) => response.json())
    const plugin = payload.plugins.find((item) => item.id === ID)
    assert.ok(plugin, `${ID} 不在插件列表`)
    assert.equal(plugin.compatible, true)
    assert.equal(plugin.status, 'running')

    const panels = await fetch(`${http.baseUrl}/api/panels`).then((response) => response.json())
    const panel = panels.panels.find((item) => item.pluginId === ID)
    assert.ok(panel, '面板未出现在 /api/panels')
    assert.equal(panel.src, `/api/plugins/${ID}/panel`)
  } finally {
    await http.close()
    await harness.cleanup()
  }
})

test('未配置时面板可用且给出版本与配置状态', async () => {
  const harness = await createHarness({
    plugins: [{ id: ID, module: MODULE, enabled: true, config: {} }],
    hostVersion: '0.4.24',
  })
  const http = await startHttpServer(harness.runtime)
  try {
    const page = await fetch(`${http.baseUrl}/api/plugins/${ID}/panel`)
    assert.equal(page.status, 200)
    assert.match(page.headers.get('content-type') ?? '', /text\/html/)
    assert.match(await page.text(), /Jenkins 构建/)

    const status = await fetch(`${http.baseUrl}/api/plugins/${ID}/status`).then((response) =>
      response.json(),
    )
    assert.equal(status.plugin, ID)
    assert.equal(status.configured, false)
    assert.equal(status.hasPassword, false)
    assert.match(status.error, /未配置 Jenkins 地址/)

    const jobs = await fetch(`${http.baseUrl}/api/plugins/${ID}/jobs`)
    assert.equal(jobs.status, 400)
    const body = await jobs.json()
    assert.match(body.error, /未配置 Jenkins 地址/)
  } finally {
    await http.close()
    await harness.cleanup()
  }
})
