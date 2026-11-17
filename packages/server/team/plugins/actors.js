import crypto from 'node:crypto'
import { ERROR_CODES, appError } from '../../plugins/protocol.js'
import { ERROR_CODES as TEAM_CODES, teamError } from '../errors.js'

/**
 * actor 上下文：把"这次请求是谁发起的"安全地传给插件进程。
 *
 * - 插件进程是全局单实例，靠 `actorRef` 区分用户（design.md §4）；
 * - `actorRef` 只在宿主内存里，绑定 pluginId、默认 60s 过期；
 * - 载荷里绝不含密码、token、session cookie。
 */

export const DEFAULT_ACTOR_TTL_MS = 60_000
export const DEFAULT_MAX_ACTORS = 2_000

export function createActorContext({
  db,
  ttlMs = DEFAULT_ACTOR_TTL_MS,
  maxEntries = DEFAULT_MAX_ACTORS,
  now = () => Date.now(),
} = {}) {
  /** ref -> { payload, pluginId, expiresAt } */
  const refs = new Map()

  function projectsOf(userId) {
    if (!db) return []
    return db
      .prepare(
        `
      SELECT m.project_id AS id, m.role, p.team_id
      FROM project_member m
      JOIN team_project p ON p.repository_id = m.project_id
      WHERE m.user_id = ?
      ORDER BY m.project_id
    `,
      )
      .all(String(userId))
      .map((row) => ({ id: row.id, role: row.role, teamId: row.team_id }))
  }

  function sweep() {
    const stamp = now()
    let removed = 0
    for (const [ref, entry] of refs) {
      if (entry.expiresAt <= stamp) {
        refs.delete(ref)
        removed += 1
      }
    }
    return removed
  }

  function evictIfNeeded() {
    if (refs.size < maxEntries) return
    const ordered = [...refs.entries()].sort(
      (left, right) => left[1].expiresAt - right[1].expiresAt,
    )
    const overflow = refs.size - maxEntries + 1
    for (const [ref] of ordered.slice(0, overflow)) refs.delete(ref)
  }

  function issue({ actor, pluginId }) {
    if (!actor?.userId) {
      throw teamError(401, TEAM_CODES.AUTH_REQUIRED, '需要登录')
    }
    if (!pluginId) throw teamError(400, TEAM_CODES.INVALID_INPUT, '缺少插件 id')
    sweep()
    evictIfNeeded()
    const stamp = now()
    const payload = {
      ref: `act_${crypto.randomUUID()}`,
      userId: actor.userId,
      displayName: actor.user?.displayName ?? null,
      systemAdmin: Boolean(actor.systemAdmin),
      teams: (actor.teams ?? []).map((team) => ({
        id: team.id,
        name: team.name,
        role: team.role,
      })),
      projects: projectsOf(actor.userId),
      activeTeamId: actor.activeTeamId ?? null,
      issuedAt: stamp,
      expiresAt: stamp + ttlMs,
    }
    refs.set(payload.ref, {
      payload,
      pluginId: String(pluginId),
      expiresAt: payload.expiresAt,
    })
    return payload
  }

  /**
   * 插件回传的 actorRef 必须存在、未过期、且属于同一个插件，否则按权限拒绝。
   * 返回的是同一个载荷对象，保证插件拿到的身份与宿主签发的一致。
   */
  function resolve({ ref, pluginId }) {
    if (!ref) {
      throw appError(ERROR_CODES.PERMISSION_DENIED, 'team 模式调用缺少 actor 上下文')
    }
    const entry = refs.get(String(ref))
    if (!entry) {
      throw appError(ERROR_CODES.PERMISSION_DENIED, 'actor 上下文无效或已过期')
    }
    if (entry.expiresAt <= now()) {
      refs.delete(String(ref))
      throw appError(ERROR_CODES.PERMISSION_DENIED, 'actor 上下文已过期')
    }
    if (pluginId && entry.pluginId !== String(pluginId)) {
      throw appError(ERROR_CODES.PERMISSION_DENIED, 'actor 上下文不属于该插件')
    }
    return entry.payload
  }

  const timer = setInterval(sweep, ttlMs)
  timer.unref?.()

  function stop() {
    clearInterval(timer)
    refs.clear()
  }

  return { issue, resolve, sweep, stop, size: () => refs.size }
}
