import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHarness, startHttpServer } from '@trellis-board/test-support/plugin-runtime.js'

const ID = 'accounts-core'
const MODULE = fileURLToPath(new URL('../index.js', import.meta.url))
const MANIFEST = JSON.parse(
  fs.readFileSync(fileURLToPath(new URL('../plugin.json', import.meta.url)), 'utf8'),
)

test('accounts-core 目录名与清单 id 一致', () => {
  const dir = path.basename(path.dirname(fileURLToPath(new URL('../plugin.json', import.meta.url))))
  assert.equal(MANIFEST.id, dir)
  assert.match(MANIFEST.id, /^[a-z][a-z0-9-]{1,31}$/)
})

test('accounts-core 声明 capability、面板与必要权限', () => {
  assert.notEqual(MANIFEST.name, MANIFEST.id)
  assert.ok(MANIFEST.description && MANIFEST.description.length > 0)
  assert.ok(MANIFEST.permissions.includes('panels'))
  assert.ok(MANIFEST.permissions.includes('secrets:write'))
  assert.ok(MANIFEST.permissions.includes('capabilities:provide'))
  const capability = MANIFEST.provides.find((item) => item.name === 'accounts.credentials')
  assert.ok(capability, '未声明 accounts.credentials')
  assert.equal(capability.methods['credential.resolve'].access, 'read')
})

test('accounts-core 通过真实清单启动并出现在插件列表', async () => {
  const harness = await createHarness({
    plugins: [{ id: ID, module: MODULE, enabled: true, config: {} }],
    hostVersion: '0.4.24',
  })
  const http = await startHttpServer(harness.runtime)
  try {
    const state = harness.supervisor.plugins.get(ID)
    assert.equal(state.status, 'running', `${ID} 未运行: ${state.lastError}`)

    const payload = await fetch(`${http.baseUrl}/api/plugins`).then((response) => response.json())
    const plugin = payload.plugins.find((item) => item.id === ID)
    assert.ok(plugin, `${ID} 不在插件列表`)
    assert.equal(plugin.status, 'running')

    const panels = await fetch(`${http.baseUrl}/api/panels`).then((response) => response.json())
    assert.ok(
      panels.panels.some((item) => item.pluginId === ID),
      '面板未注册',
    )

    const page = await fetch(`${http.baseUrl}/api/plugins/${ID}/panel`)
    assert.equal(page.status, 200)
    assert.match(await page.text(), /统一账号/)
  } finally {
    await http.close()
    await harness.cleanup()
  }
})
