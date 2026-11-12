import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { AgentError, AGENT_ERROR_CODE } from './protocol.js'

const DEFAULT_STALE_MS = 24 * 60 * 60 * 1000

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false
  }
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // 只有明确不存在才允许回收；权限不足或未知错误均按仍存活处理。
    return error.code !== 'ESRCH'
  }
}

async function readLock(lockFile) {
  try {
    const [raw, stat] = await Promise.all([fs.readFile(lockFile, 'utf8'), fs.stat(lockFile)])
    let metadata = null
    try {
      metadata = JSON.parse(raw)
    } catch {
      // 损坏的锁按创建时间判断是否陈旧。
    }
    return { metadata, mtimeMs: stat.mtimeMs }
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null
    }
    throw error
  }
}

export class SingleInstanceLock {
  constructor(lockFile, options = {}) {
    this.lockFile = lockFile
    this.staleMs = options.staleMs || DEFAULT_STALE_MS
    this.now = options.now || Date.now
    this.processIsAlive = options.processIsAlive || processIsAlive
    this.token = null
    this.heartbeatTimer = null
    this.handle = null
  }

  async acquire() {
    await fs.mkdir(path.dirname(this.lockFile), { recursive: true, mode: 0o700 })
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await fs.open(this.lockFile, 'wx', 0o600)
        const token = crypto.randomBytes(24).toString('base64url')
        const metadata = {
          pid: process.pid,
          hostname: process.env.COMPUTERNAME || 'local',
          startedAt: new Date(this.now()).toISOString(),
          token,
        }
        try {
          await handle.writeFile(`${JSON.stringify(metadata)}\n`)
          await handle.sync()
        } catch (error) {
          await handle.close().catch(() => {})
          await fs.unlink(this.lockFile).catch(() => {})
          throw error
        }
        this.handle = handle
        this.token = token
        this.heartbeatTimer = setInterval(() => {
          const now = new Date()
          fs.utimes(this.lockFile, now, now).catch(() => {})
        }, 60_000)
        this.heartbeatTimer.unref?.()
        return
      } catch (error) {
        if (error.code !== 'EEXIST') {
          throw new AgentError(AGENT_ERROR_CODE.LOCKED, '无法创建 Agent 单实例锁', { cause: error })
        }
        const current = await readLock(this.lockFile)
        if (!current) {
          continue
        }
        const age = this.now() - current.mtimeMs
        const ownerPid = current.metadata?.pid
        const ownerPidValid = Number.isInteger(ownerPid) && ownerPid > 0
        const ownerAlive = ownerPidValid && this.processIsAlive(ownerPid)
        if (ownerAlive || (!ownerPidValid && age <= this.staleMs)) {
          throw new AgentError(
            AGENT_ERROR_CODE.LOCKED,
            '已有 Trellis Agent 实例在运行，本次启动退出',
          )
        }
        const latest = await readLock(this.lockFile)
        if (
          !latest ||
          latest.mtimeMs !== current.mtimeMs ||
          latest.metadata?.token !== current.metadata?.token
        ) {
          continue
        }
        await fs.unlink(this.lockFile).catch((unlinkError) => {
          if (unlinkError.code !== 'ENOENT') {
            throw unlinkError
          }
        })
      }
    }
    throw new AgentError(AGENT_ERROR_CODE.LOCKED, '无法取得 Agent 单实例锁')
  }

  async release() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    if (this.handle) {
      await this.handle.close().catch(() => {})
      this.handle = null
    }
    if (!this.token) {
      return
    }
    const current = await readLock(this.lockFile).catch(() => null)
    if (current?.metadata?.token === this.token) {
      await fs.unlink(this.lockFile).catch(() => {})
    }
    this.token = null
  }
}
