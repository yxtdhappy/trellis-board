import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ConfigStore } from '../config-store.js'

test('live cursor 锁串行执行跨实例操作并在结束后释放', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'trellis-config-store-'))
  const first = new ConfigStore(root, { secureDirectory: false })
  const second = new ConfigStore(root, { secureDirectory: false })
  let active = 0
  let maxActive = 0
  const runLocked = (store) =>
    store.withLiveCursorLock(async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 30))
      active -= 1
    })
  try {
    await Promise.all([runLocked(first), runLocked(second)])
    assert.equal(maxActive, 1)
    await assert.rejects(fs.stat(first.paths.liveCursorLockFile), { code: 'ENOENT' })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
