import test from 'node:test'
import assert from 'node:assert/strict'
import { createRefreshCoordinator } from '../src/lib/refresh-coordinator.js'

test('请求在途时只保留一次后续刷新', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  let runs = 0
  const coordinator = createRefreshCoordinator(async () => {
    runs += 1
    if (runs === 1) await gate
  })

  const first = coordinator.request()
  const second = coordinator.request()
  const third = coordinator.request()
  await Promise.resolve()
  assert.equal(runs, 1)

  release()
  await Promise.all([first, second, third])
  assert.equal(runs, 2)
  coordinator.dispose()
})

test('dispose 后不再安排刷新', async () => {
  let runs = 0
  const coordinator = createRefreshCoordinator(async () => {
    runs += 1
  })
  coordinator.request()
  coordinator.dispose()
  await coordinator.request()
  assert.equal(runs, 1)
})
