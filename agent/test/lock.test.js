import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { SingleInstanceLock } from '../lock.js'
import { AGENT_ERROR_CODE } from '../protocol.js'

async function makeLockFile(metadata) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'trellis-agent-lock-'))
  const lockFile = path.join(directory, 'agent.lock')
  await fs.writeFile(lockFile, `${JSON.stringify(metadata)}\n`)
  return { directory, lockFile }
}

test('活动进程持有的锁不会被当作陈旧锁删除', async () => {
  const { directory, lockFile } = await makeLockFile({
    pid: process.pid,
    hostname: process.env.COMPUTERNAME || 'local',
    token: 'active',
  })
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000)
  await fs.utimes(lockFile, old, old)
  try {
    const lock = new SingleInstanceLock(lockFile)
    await assert.rejects(lock.acquire(), (error) => error.code === AGENT_ERROR_CODE.LOCKED)
    assert.equal(
      await fs.readFile(lockFile, 'utf8'),
      `${JSON.stringify({
        pid: process.pid,
        hostname: process.env.COMPUTERNAME || 'local',
        token: 'active',
      })}\n`,
    )
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test('同机已退出进程留下的锁可立即恢复', async () => {
  const { directory, lockFile } = await makeLockFile({
    pid: 2_000_000_000,
    hostname: process.env.COMPUTERNAME || 'local',
    token: 'dead',
  })
  const lock = new SingleInstanceLock(lockFile)
  try {
    await lock.acquire()
    assert.ok(lock.token)
  } finally {
    await lock.release()
    await fs.rm(directory, { recursive: true, force: true })
  }
})
