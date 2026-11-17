import crypto from 'node:crypto'
import { ERROR_CODES, teamError } from '../errors.js'

/**
 * team 插件的第三方会话缓存。
 *
 * 设计前提（见 design.md §7.0）：WitOps token 12h、无 refresh、**单会话**、logout 吊销全部。
 * 因此这里只做三件事：存放 token、按用户/插件隔离、拒绝同一账号被别人占用。
 * **不存密码**，也不提供任何"自动重登"入口。
 */

export const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000
export const DEFAULT_MAX_SESSIONS = 2_000
const SWEEP_INTERVAL_MS = 60_000

export function maskAccount(account) {
  const text = String(account ?? '').trim()
  if (!text) return ''
  if (text.length <= 3) return `${text[0]}**`
  if (text.length <= 6) return `${text.slice(0, 1)}***${text.slice(-1)}`
  return `${text.slice(0, 2)}***${text.slice(-2)}`
}

function accountKeyOf(pluginId, account) {
  return `${pluginId}\u0000${String(account ?? '')
    .trim()
    .toLowerCase()}`
}

export function createSessionStore({
  db,
  now = () => Date.now(),
  ttlMs = DEFAULT_SESSION_TTL_MS,
  maxEntries = DEFAULT_MAX_SESSIONS,
  sweepIntervalMs = SWEEP_INTERVAL_MS,
  audit = () => {},
} = {}) {
  /** handle -> entry */
  const byHandle = new Map()
  /** `${userId}\u0000${pluginId}` -> handle */
  const byUser = new Map()
  /** `${pluginId}\u0000${accountKey}` -> { userId, handle } */
  const byAccount = new Map()

  const userKey = (userId, pluginId) => `${userId}\u0000${pluginId}`

  function displayNameOf(userId) {
    const row = db
      ?.prepare('SELECT display_name FROM user_account WHERE id = ?')
      .get(String(userId))
    return row?.display_name ?? null
  }

  function drop(entry, reason) {
    byHandle.delete(entry.handle)
    if (byUser.get(userKey(entry.userId, entry.pluginId)) === entry.handle) {
      byUser.delete(userKey(entry.userId, entry.pluginId))
    }
    const claim = byAccount.get(accountKeyOf(entry.pluginId, entry.account))
    if (claim?.handle === entry.handle) {
      byAccount.delete(accountKeyOf(entry.pluginId, entry.account))
    }
    if (reason) {
      audit(entry.pluginId, 'session.close', {
        userId: entry.userId,
        account: maskAccount(entry.account),
        reason,
      })
    }
  }

  function evictIfNeeded() {
    if (byHandle.size < maxEntries) return
    const ordered = [...byHandle.values()].sort((left, right) => left.expiresAt - right.expiresAt)
    const overflow = byHandle.size - maxEntries + 1
    for (const entry of ordered.slice(0, overflow)) {
      drop(entry, 'evicted')
    }
  }

  function sweep() {
    const stamp = now()
    let removed = 0
    for (const entry of byHandle.values()) {
      if (entry.expiresAt <= stamp) {
        drop(entry, 'expired')
        removed += 1
      }
    }
    return removed
  }

  const timer = setInterval(sweep, sweepIntervalMs)
  timer.unref?.()

  /**
   * 建立会话。同一 WitOps 账号被另一个 Board 用户占用时直接拒绝，不做"抢占"。
   */
  function create({ userId, pluginId, token, account, witopsUserId = null, teamId = null }) {
    const id = String(userId)
    const pid = String(pluginId)
    const tokenText = String(token ?? '')
    if (!id || !pid) throw teamError(400, ERROR_CODES.INVALID_INPUT, '会话缺少用户或插件')
    if (!tokenText) throw teamError(400, ERROR_CODES.INVALID_INPUT, '会话缺少访问令牌')

    const accountKey = accountKeyOf(pid, account)
    const claim = byAccount.get(accountKey)
    if (claim && claim.userId !== id) {
      audit(pid, 'session.conflict', {
        userId: id,
        account: maskAccount(account),
        occupiedBy: claim.userId,
      })
      throw teamError(409, ERROR_CODES.ACCOUNT_IN_USE, '该账号已被其他用户使用', {
        details: { displayName: displayNameOf(claim.userId) },
      })
    }

    const previous = byUser.get(userKey(id, pid))
    if (previous && byHandle.has(previous)) drop(byHandle.get(previous), 'replaced')

    evictIfNeeded()
    const stamp = now()
    const entry = {
      handle: crypto.randomUUID(),
      userId: id,
      pluginId: pid,
      teamId: teamId == null ? null : String(teamId),
      token: tokenText,
      account: String(account ?? ''),
      witopsUserId,
      createdAt: stamp,
      lastSeenAt: stamp,
      expiresAt: stamp + ttlMs,
    }
    byHandle.set(entry.handle, entry)
    byUser.set(userKey(id, pid), entry.handle)
    if (entry.account)
      byAccount.set(accountKeyOf(pid, entry.account), {
        userId: id,
        handle: entry.handle,
      })
    audit(pid, 'session.open', {
      userId: id,
      account: maskAccount(entry.account),
      expiresAt: new Date(entry.expiresAt).toISOString(),
    })
    return publicSession(entry)
  }

  function publicSession(entry) {
    return {
      handle: entry.handle,
      userId: entry.userId,
      pluginId: entry.pluginId,
      account: entry.account,
      expiresAt: new Date(entry.expiresAt).toISOString(),
      createdAt: new Date(entry.createdAt).toISOString(),
    }
  }

  /**
   * 校验 handle 属于该用户与该插件。不匹配一律返回 null（不泄露别人是否在线）。
   */
  function resolve({ handle, userId, pluginId }) {
    const entry = byHandle.get(String(handle ?? ''))
    if (!entry) return null
    if (entry.userId !== String(userId) || entry.pluginId !== String(pluginId)) return null
    if (entry.expiresAt <= now()) {
      drop(entry, 'expired')
      return null
    }
    entry.lastSeenAt = now()
    return entry
  }

  function revoke({ handle, reason = 'logout' }) {
    const entry = byHandle.get(String(handle ?? ''))
    if (!entry) return false
    drop(entry, reason)
    return true
  }

  function revokeUser(userId, pluginId, { reason = 'admin' } = {}) {
    const handle = byUser.get(userKey(String(userId), String(pluginId)))
    if (!handle) return false
    const entry = byHandle.get(handle)
    if (entry) drop(entry, reason)
    return true
  }

  /** 仅宿主内部使用：取原始条目（含 token），用于转发请求时携带凭据。 */
  function entryOf(userId, pluginId) {
    const handle = byUser.get(userKey(String(userId), String(pluginId)))
    const entry = handle ? byHandle.get(handle) : null
    if (!entry) return null
    if (entry.expiresAt <= now()) {
      drop(entry, 'expired')
      return null
    }
    entry.lastSeenAt = now()
    return entry
  }

  function statusOf(userId, pluginId) {
    const handle = byUser.get(userKey(String(userId), String(pluginId)))
    const entry = handle ? byHandle.get(handle) : null
    if (!entry || entry.expiresAt <= now()) {
      if (entry) drop(entry, 'expired')
      return null
    }
    return publicSession(entry)
  }

  function listOnline({ pluginId = null } = {}) {
    const stamp = now()
    return [...byHandle.values()]
      .filter((entry) => entry.expiresAt > stamp)
      .filter((entry) => (pluginId ? entry.pluginId === String(pluginId) : true))
      .map((entry) => ({
        userId: entry.userId,
        pluginId: entry.pluginId,
        account: maskAccount(entry.account),
        createdAt: new Date(entry.createdAt).toISOString(),
        lastSeenAt: new Date(entry.lastSeenAt).toISOString(),
        expiresAt: new Date(entry.expiresAt).toISOString(),
      }))
  }

  function size() {
    return byHandle.size
  }

  function stop() {
    clearInterval(timer)
    byHandle.clear()
    byUser.clear()
    byAccount.clear()
  }

  return {
    create,
    entryOf,
    resolve,
    revoke,
    revokeUser,
    statusOf,
    listOnline,
    sweep,
    size,
    stop,
  }
}
