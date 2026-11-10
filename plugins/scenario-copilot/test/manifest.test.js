import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createHarness, startHttpServer } from '../../../tests/helpers/plugin-runtime.js'

const ID = 'scenario-copilot'
const MODULE = fileURLToPath(new URL('../index.js', import.meta.url))

test('scenario-copilot 通过清单校验并提供面板与空大纲提示', async () => {
  const harness = await createHarness({
    plugins: [{ id: ID, module: MODULE, enabled: true, config: {} }],
    hostVersion: '0.2.0',
  })
  const http = await startHttpServer(harness.runtime)
  try {
    const state = harness.supervisor.plugins.get(ID)
    assert.equal(state.status, 'running', `${ID} 未运行: ${state.lastError}`)
    assert.equal(state.manifest.id, ID)
    assert.equal(state.manifest.apiVersion, 1)
    assert.equal(state.manifest.panels?.[0]?.id, ID)

    const panels = await fetch(`${http.baseUrl}/api/panels`).then((response) => response.json())
    assert.deepEqual(
      panels.panels.map((panel) => panel.id),
      [ID],
    )

    const defaults = await fetch(`${http.baseUrl}/api/plugins/${ID}/defaults`).then((response) =>
      response.json(),
    )
    assert.deepEqual(defaults.outlines, [])

    const panel = await fetch(`${http.baseUrl}/api/plugins/${ID}/panel`)
    assert.equal(panel.status, 200)
    assert.match(panel.headers.get('content-type') ?? '', /text\/html/)

    const script = await fetch(`${http.baseUrl}/api/plugins/${ID}/app.js`)
    assert.equal(script.status, 200)
  } finally {
    await http.close()
    await harness.cleanup()
  }
})
