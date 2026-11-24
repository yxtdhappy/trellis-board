import crypto from 'node:crypto'
import { parseCookie, stringifySetCookie } from 'cookie'
import { withTransaction } from '../database.js'
import { normalizeUsername, validatePassword } from './credentials.js'
import { ERROR_CODES, teamError } from './errors.js'
import { listActiveTeamMemberships, setUserTeams, validateTeamAssignments } from './teams.js'

export { normalizeUsername, validatePassword }

export const SESSION_COOKIE = 'trellis_team_session'
export const PASSWORD_PARAMS = Object.freeze({
  name: 'scrypt',
  N: 32768,
  r: 8,
  p: 1,
  keylen: 64,
  maxmem: 64 * 1024 * 1024,
})

const LOGIN_WINDOW_MS = 15 * 60 * 1000
const LOGIN_MAX_FAILURES = 5
const LAST_SEEN_WRITE_MS = 5 * 60 * 1000
const SESSION_RETENTION_MS = 24 * 60 * 60 * 1000
const DUMMY_SALT = Buffer.from('trellis-team-dummy-password-salt')
let activeDerivations = 0
const derivationQueue = []

function deriveKey(password, salt, params = PASSWORD_PARAMS) {
  return new Promise((resolve, reject) => {
    const run = () => {
      activeDerivations += 1
      crypto.scrypt(
        password,
        salt,
        params.keylen,
        {
          N: params.N,
          r: params.r,
          p: params.p,
          maxmem: params.maxmem,
        },
        (error, key) => {
          activeDerivations -= 1
          const next = derivationQueue.shift()
          if (next) next()
          if (error) reject(error)
          else resolve(key)
        },
      )
    }
    if (activeDerivations < 4) run()
    else derivationQueue.push(run)
  })
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex')
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url')
}

function publicUser(row) {
  if (!row) return null
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    systemAdmin: Boolean(row.system_admin),
    status: row.status,
    mustChangePassword: Boolean(row.must_change_password),
    passwordChangedAt: row.password_changed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function hashPassword(password) {
  validatePassword(password)
  const salt = crypto.randomBytes(16)
  const key = await deriveKey(password, salt)
  return {
    hash: key.toString('base64'),
    paramsJson: JSON.stringify({
      ...PASSWORD_PARAMS,
      salt: salt.toString('base64'),
    }),
  }
}

async function verifyStoredPassword(password, passwordHash, paramsJson) {
  let params
  try {
    params = JSON.parse(paramsJson)
  } catch {
    return false
  }
  if (
    params?.name !== 'scrypt' ||
    params.N !== PASSWORD_PARAMS.N ||
    params.r !== PASSWORD_PARAMS.r ||
    params.p !== PASSWORD_PARAMS.p ||
    typeof params.salt !== 'string'
  ) {
    return false
  }
  const expected = Buffer.from(passwordHash, 'base64')
  const actual = await deriveKey(password, Buffer.from(params.salt, 'base64'), {
    ...PASSWORD_PARAMS,
    keylen: expected.length,
  })
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual)
}

async function runDummyPasswordCheck(password) {
  const value = typeof password === 'string' ? password : ''
  await deriveKey(value, DUMMY_SALT)
}

function countActiveAdmins(db) {
  return Number(
    db
      .prepare(`
    SELECT COUNT(*) AS count
    FROM user_account
    WHERE system_admin = 1 AND status = 'active'
  `)
      .get().count,
  )
}

function assertNotLastAdmin(db, userId) {
  const user = db
    .prepare(`
    SELECT system_admin, status
    FROM user_account
    WHERE id = ?
  `)
    .get(userId)
  if (user?.system_admin === 1 && user.status === 'active' && countActiveAdmins(db) <= 1) {
    throw teamError(409, ERROR_CODES.CONFLICT, '不能禁用或降级最后一名有效系统管理员')
  }
}

function assertNotLastProjectLead(db, userId) {
  const row = db
    .prepare(`
    SELECT p.repository_id
    FROM project_member m
    JOIN team_project p ON p.repository_id = m.project_id
    WHERE m.user_id = ?
      AND m.role = 'lead'
      AND p.sync_status IN ('current', 'stale', 'pending_push', 'needs_repair')
      AND (
        SELECT COUNT(*)
        FROM project_member other
        JOIN user_account other_user ON other_user.id = other.user_id
        WHERE other.project_id = m.project_id
          AND other.role = 'lead'
          AND other_user.status = 'active'
      ) <= 1
    LIMIT 1
  `)
    .get(userId)
  if (row) {
    throw teamError(409, ERROR_CODES.CONFLICT, '禁用该账号会让已启用项目失去最后一名有效负责人')
  }
}

export async function createUser(
  db,
  {
    username,
    displayName,
    password,
    teams = null,
    systemAdmin = false,
    mustChangePassword = false,
    createdBy = null,
  },
) {
  const normalized = normalizeUsername(username)
  const display = String(displayName || username).trim()
  if (!display || Array.from(display).length > 80) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, '显示名必须是 1 到 80 个字符')
  }
  if (teams != null) validateTeamAssignments(db, teams)
  const passwordRecord = await hashPassword(password)
  // 密码哈希会让出事件循环；插入前再次校验，避免团队在校验后被并发停用/删除。
  if (teams != null) validateTeamAssignments(db, teams)
  const now = new Date().toISOString()
  const id = crypto.randomUUID()
  try {
    db.prepare(`
      INSERT INTO user_account(
        id, username_key, username, display_name, password_hash,
        password_params_json, system_admin, status, must_change_password,
        password_changed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
    `).run(
      id,
      normalized.usernameKey,
      normalized.username,
      display,
      passwordRecord.hash,
      passwordRecord.paramsJson,
      systemAdmin ? 1 : 0,
      mustChangePassword ? 1 : 0,
      now,
      now,
      now,
    )
  } catch (error) {
    if (String(error?.message || '').includes('UNIQUE')) {
      throw teamError(409, ERROR_CODES.CONFLICT, '登录名已存在')
    }
    throw error
  }
  if (Array.isArray(teams) && teams.length) {
    setUserTeams(db, {
      userId: id,
      teams,
      actorUserId: createdBy,
    })
  }
  return readUser(db, id)
}

export function readUser(db, userId) {
  return publicUser(db.prepare('SELECT * FROM user_account WHERE id = ?').get(userId))
}

export function listUsers(db) {
  return db
    .prepare(`
    SELECT *
    FROM user_account
    ORDER BY username_key
  `)
    .all()
    .map(publicUser)
}

export function hasActiveAdmin(db) {
  return countActiveAdmins(db) > 0
}

export async function updateUserAdmin(db, { userId, updates, actorUserId }) {
  const current = readUser(db, userId)
  if (!current) throw teamError(404, ERROR_CODES.NOT_FOUND, '账号不存在')
  const nextDisplay =
    updates.displayName == null ? current.displayName : String(updates.displayName).trim()
  if (!nextDisplay || Array.from(nextDisplay).length > 80) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, '显示名必须是 1 到 80 个字符')
  }
  const nextStatus = updates.status ?? current.status
  if (!new Set(['active', 'disabled']).has(nextStatus)) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, '账号状态无效')
  }
  const nextAdmin = updates.systemAdmin == null ? current.systemAdmin : Boolean(updates.systemAdmin)
  const accountChanged =
    nextDisplay !== current.displayName ||
    nextStatus !== current.status ||
    nextAdmin !== current.systemAdmin
  withTransaction(db, () => {
    if (current.status === 'active' && (nextStatus === 'disabled' || !nextAdmin)) {
      assertNotLastAdmin(db, userId)
    }
    if (current.status === 'active' && nextStatus === 'disabled') {
      assertNotLastProjectLead(db, userId)
    }
    db.prepare(`
      UPDATE user_account
      SET display_name = ?, status = ?, system_admin = ?, updated_at = ?
      WHERE id = ?
    `).run(nextDisplay, nextStatus, nextAdmin ? 1 : 0, new Date().toISOString(), userId)
    if (nextStatus === 'disabled' || (current.systemAdmin && !nextAdmin)) {
      db.prepare(`
        UPDATE user_session
        SET revoked_at = ?
        WHERE user_id = ? AND revoked_at IS NULL
      `).run(new Date().toISOString(), userId)
    }
    if (!accountChanged) return
    db.prepare(`
      INSERT INTO audit_event(
        actor_user_id, project_id, action, target_type, target_id,
        result, correlation_id, detail_json, occurred_at
      ) VALUES (?, NULL, 'user_updated', 'user', ?, 'success', ?, ?, ?)
    `).run(
      actorUserId,
      userId,
      crypto.randomUUID(),
      JSON.stringify({
        displayName: nextDisplay,
        previousDisplayName: current.displayName,
        status: nextStatus,
        systemAdmin: nextAdmin,
      }),
      new Date().toISOString(),
    )
  })
  return readUser(db, userId)
}

function clientIp(request, trustProxy) {
  if (trustProxy) {
    const forwarded = String(request.headers['x-forwarded-for'] || '')
      .split(',')[0]
      .trim()
    if (forwarded && forwarded.length <= 128) return forwarded
  }
  return String(request.socket.remoteAddress || '').slice(0, 128)
}

function purgeStaleAuthRows(db, now) {
  const attemptsBefore = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()
  const sessionsBefore = new Date(now.getTime() - SESSION_RETENTION_MS).toISOString()
  db.prepare('DELETE FROM login_attempt WHERE occurred_at < ?').run(attemptsBefore)
  db.prepare(`
    DELETE FROM user_session
    WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)
  `).run(now.toISOString(), sessionsBefore)
}

export async function login(
  db,
  { username, password, request, trustProxy = false, sessionTtlMs = 12 * 60 * 60 * 1000 },
) {
  const normalized = normalizeUsername(username)
  const ip = clientIp(request, trustProxy)
  const now = new Date()
  const windowStart = new Date(now.getTime() - LOGIN_WINDOW_MS).toISOString()
  purgeStaleAuthRows(db, now)

  const failuresForUser = Number(
    db
      .prepare(`
    SELECT COUNT(*) AS count
    FROM login_attempt
    WHERE username_key = ? AND ip = ? AND succeeded = 0 AND occurred_at >= ?
  `)
      .get(normalized.usernameKey, ip, windowStart).count,
  )
  const failuresForIp = Number(
    db
      .prepare(`
    SELECT COUNT(*) AS count
    FROM login_attempt
    WHERE ip = ? AND succeeded = 0 AND occurred_at >= ?
  `)
      .get(ip, windowStart).count,
  )
  if (failuresForUser >= LOGIN_MAX_FAILURES || failuresForIp >= LOGIN_MAX_FAILURES) {
    throw teamError(429, ERROR_CODES.RATE_LIMITED, '登录尝试过多，请稍后再试')
  }

  const account = db
    .prepare(`
    SELECT *
    FROM user_account
    WHERE username_key = ?
  `)
    .get(normalized.usernameKey)
  let valid = false
  if (account && account.status === 'active') {
    valid = await verifyStoredPassword(
      typeof password === 'string' ? password : '',
      account.password_hash,
      account.password_params_json,
    )
  } else {
    await runDummyPasswordCheck(password)
  }
  db.prepare(`
    INSERT INTO login_attempt(username_key, ip, succeeded, occurred_at)
    VALUES (?, ?, ?, ?)
  `).run(normalized.usernameKey, ip, valid ? 1 : 0, new Date().toISOString())

  if (!valid) {
    throw teamError(401, ERROR_CODES.AUTH_FAILED, '用户名或密码错误')
  }
  db.prepare(`
    DELETE FROM login_attempt
    WHERE username_key = ? AND succeeded = 0
  `).run(normalized.usernameKey)

  const session = createSession(db, {
    userId: account.id,
    request,
    ttlMs: sessionTtlMs,
    ip,
  })
  return {
    token: session.token,
    expiresAt: session.expiresAt,
    user: publicUser(account),
  }
}

export function createSession(
  db,
  { userId, request, ttlMs = 12 * 60 * 60 * 1000, ip = clientIp(request, false) },
) {
  const token = randomToken()
  const now = new Date()
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString()
  db.prepare(`
    INSERT INTO user_session(
      id, token_hash, user_id, active_team_id, created_at, last_seen_at,
      expires_at, ip, user_agent
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    crypto.randomUUID(),
    tokenHash(token),
    userId,
    null,
    now.toISOString(),
    now.toISOString(),
    expiresAt,
    String(ip || '').slice(0, 128),
    String(request?.headers?.['user-agent'] || '').slice(0, 512),
  )
  return { token, expiresAt, activeTeamId: null }
}

export function readSession(db, token) {
  if (typeof token !== 'string' || token.length < 32 || token.length > 512) return null
  const row = db
    .prepare(`
    SELECT
      s.id AS session_id, s.last_seen_at, s.expires_at,
      u.*
    FROM user_session s
    JOIN user_account u ON u.id = s.user_id
    WHERE s.token_hash = ?
      AND s.revoked_at IS NULL
      AND s.expires_at > ?
      AND u.status = 'active'
  `)
    .get(tokenHash(token), new Date().toISOString())
  if (!row) return null
  const lastSeen = Date.parse(row.last_seen_at)
  if (!Number.isFinite(lastSeen) || Date.now() - lastSeen >= LAST_SEEN_WRITE_MS) {
    db.prepare('UPDATE user_session SET last_seen_at = ? WHERE id = ?').run(
      new Date().toISOString(),
      row.session_id,
    )
  }
  const user = publicUser(row)
  return {
    sessionId: row.session_id,
    expiresAt: row.expires_at,
    activeTeamId: null,
    teamRole: null,
    team: null,
    teams: listActiveTeamMemberships(db, user.id),
    user,
  }
}

export function revokeSession(db, sessionId) {
  db.prepare(`
    UPDATE user_session
    SET revoked_at = ?
    WHERE id = ? AND revoked_at IS NULL
  `).run(new Date().toISOString(), sessionId)
}

export function revokeUserSessions(db, userId, { exceptSessionId = null } = {}) {
  const now = new Date().toISOString()
  if (exceptSessionId) {
    db.prepare(`
      UPDATE user_session
      SET revoked_at = ?
      WHERE user_id = ? AND id <> ? AND revoked_at IS NULL
    `).run(now, userId, exceptSessionId)
  } else {
    db.prepare(`
      UPDATE user_session
      SET revoked_at = ?
      WHERE user_id = ? AND revoked_at IS NULL
    `).run(now, userId)
  }
}

export async function changePassword(
  db,
  { userId, currentPassword, newPassword, currentSessionId = null },
) {
  const account = db.prepare('SELECT * FROM user_account WHERE id = ?').get(userId)
  if (!account || account.status !== 'active') {
    throw teamError(401, ERROR_CODES.AUTH_REQUIRED, '会话无效')
  }
  const valid = await verifyStoredPassword(
    currentPassword,
    account.password_hash,
    account.password_params_json,
  )
  if (!valid) {
    throw teamError(401, ERROR_CODES.AUTH_FAILED, '当前密码错误')
  }
  const passwordRecord = await hashPassword(newPassword)
  const now = new Date().toISOString()
  withTransaction(db, () => {
    db.prepare(`
      UPDATE user_account
      SET password_hash = ?, password_params_json = ?,
          must_change_password = 0, password_changed_at = ?, updated_at = ?
      WHERE id = ?
    `).run(passwordRecord.hash, passwordRecord.paramsJson, now, now, userId)
    // 改密只撤销其他设备，当前会话保留，避免用户刚修改密码就被踢下线。
    revokeUserSessions(db, userId, {
      exceptSessionId: currentSessionId,
    })
  })
}

export async function resetUserPassword(db, { userId, actorUserId, password }) {
  const passwordRecord = await hashPassword(password)
  const now = new Date().toISOString()
  withTransaction(db, () => {
    const result = db
      .prepare(`
      UPDATE user_account
      SET password_hash = ?, password_params_json = ?,
          must_change_password = 0, password_changed_at = ?, updated_at = ?
      WHERE id = ? AND status = 'active'
    `)
      .run(passwordRecord.hash, passwordRecord.paramsJson, now, now, userId)
    if (!result.changes) throw teamError(404, ERROR_CODES.NOT_FOUND, '有效账号不存在')
    revokeUserSessions(db, userId)
    db.prepare(`
      INSERT INTO audit_event(
        actor_user_id, project_id, action, target_type, target_id,
        result, correlation_id, detail_json, occurred_at
      ) VALUES (?, NULL, 'user_password_reset', 'user', ?, 'success', ?, '{}', ?)
    `).run(actorUserId, userId, crypto.randomUUID(), now)
  })
  return readUser(db, userId)
}

export function parseCookieHeader(value) {
  return new Map(Object.entries(parseCookie(String(value || ''))))
}

export function sessionCookie(token, config) {
  return stringifySetCookie({
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: 'strict',
    path: '/',
    secure: Boolean(config.cookieSecure),
  })
}

export function clearSessionCookie(config) {
  return stringifySetCookie({
    name: SESSION_COOKIE,
    value: '',
    maxAge: 0,
    httpOnly: true,
    sameSite: 'strict',
    path: '/',
    secure: Boolean(config.cookieSecure),
  })
}
