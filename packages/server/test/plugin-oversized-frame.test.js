import test from 'node:test'
import assert from 'node:assert/strict'
import { createHarness, waitFor } from '@trellis-board/test-support/plugin-runtime.js'

test('单帧超过 1 MiB 时宿主断开插件并写 frame-too-large 审计', async () => {
  const harness = await createHarness({
    plugins: [
      {
        id: 'oversized-frame',
        module: './packages/test-support/fixtures/plugins/oversized-frame/index.js',
        enabled: true,
        config: {},
      },
    ],
    hostVersion: '0.2.0',
  })
  try {
    assert.ok(
      await waitFor(
        () =>
          harness.store
            .listAudit('oversized-frame')
            .some((entry) => entry.kind === 'frame-too-large'),
        { timeoutMs: 5000 },
      ),
      JSON.stringify(harness.store.listAudit('oversized-frame')),
    )
    assert.ok(
      await waitFor(() => {
        const state = harness.supervisor.plugins.get('oversized-frame')
        return state.status !== 'running'
      }),
    )
  } finally {
    await harness.cleanup()
  }
})
