import crypto from 'node:crypto'
import { withTransaction } from '../database.js'
import { appendAuditEvent } from './audit.js'
import { ERROR_CODES, teamError } from './errors.js'
import { listTeamsForActor } from './teams.js'

export const AGENT_PROTOCOL_VERSION = 3
export const MINIMUM_AGENT_VERSION = '0.1.0'

const PAIRING_TTL_MS = 10 * 60 * 1000
const AGENT_STALE_MS = 60 * 1000
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const LOCAL_REPO_KEY = /^[a-f0-9]{64}$/
const SEMVER = /^\d+\.\d+\.\d+$/

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex')
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url')
}

function text(value, label, { min = 1, max = 200 } = {}) {
  if (typeof value !== 'string') {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, `${label}格式无效`)
  }
  const result = value.trim()
  if (Array.from(result).length < min || Array.from(result).length > max) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, `${label}长度无效`)
  }
  return result
}

function safeId(value, label) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, `${label}格式无效`)
  }
  return value
}

function protocolVersion(value) {
  if (Number(value) !== AGENT_PROTOCOL_VERSION) {
    throw teamError(
      426,
      ERROR_CODES.AGENT_PROTOCOL_UNSUPPORTED,
      'Agent 协议版本不兼容，请升级 Agent',
      { details: { protocolVersion: AGENT_PROTOCOL_VERSION } },
    )
  }
  return AGENT_PROTOCOL_VERSION
}

function agentVersion(value) {
  const version = String(value || '').trim()
  if (!SEMVER.test(version)) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, 'Agent 版本格式无效')
  }
  return version.slice(0, 32)
}

function publicAgent(row) {
  return {
    id: row.id,
    userId: row.user_id,
    deviceName: row.device_name,
    platform: row.platform,
    agentVersion: row.agent_version,
    protocolVersion: Number(row.protocol_version),
    status: row.status,
    lastSeenAt: row.last_seen_at || null,
    createdAt: row.created_at,
    revokedAt: row.revoked_at || null,
  }
}

export function createSyncAgentService({
  db,
  config = {},
  events = null,
  now = () => new Date(),
  staleMs = AGENT_STALE_MS,
}) {
  const pairAttempts = new Map()

  function actorContext(userId, requestedTeamId = null) {
    const user = db
      .prepare(`
      SELECT id, username, display_name, system_admin, status
      FROM user_account WHERE id = ?
    `)
      .get(userId)
    if (!user || user.status !== 'active') {
      throw teamError(401, ERROR_CODES.AUTH_REQUIRED, '账号不存在或已禁用')
    }
    const actor = {
      userId: user.id,
      user: {
        id: user.id,
        username: user.username,
        displayName: user.display_name,
        systemAdmin: Boolean(user.system_admin),
      },
      systemAdmin: Boolean(user.system_admin),
      teams: [],
    }
    actor.teams = listTeamsForActor(db, actor, { activeOnly: true })
    const teamId = String(requestedTeamId || '').trim()
    if (teamId && teamId !== 'all') {
      if (!actor.systemAdmin && !actor.teams.some((team) => team.id === teamId)) {
        throw teamError(403, ERROR_CODES.FORBIDDEN, '无权访问该团队')
      }
    }
    return actor
  }

  function consumePairAttempt(ip) {
    const key = String(ip || 'unknown').slice(0, 128)
    const timestamp = Date.now()
    const recent = (pairAttempts.get(key) || []).filter((at) => timestamp - at < 60 * 60 * 1000)
    if (recent.length >= 30) {
      throw teamError(429, ERROR_CODES.RATE_LIMITED, '配对尝试过多，请稍后再试')
    }
    recent.push(timestamp)
    pairAttempts.set(key, recent)
  }

  function pairingTeamId(actor, requestedTeamId) {
    const requested = String(requestedTeamId || '').trim()
    if (actor.systemAdmin) {
      const team = requested
        ? db.prepare("SELECT id FROM team WHERE id = ? AND status = 'active'").get(requested)
        : db.prepare("SELECT id FROM team WHERE status = 'active' ORDER BY name LIMIT 1").get()
      if (!team) throw teamError(409, ERROR_CODES.CONFLICT, '系统还没有可用团队')
      return team.id
    }
    if (requested) {
      if (!actor.teams.some((team) => team.id === requested)) {
        throw teamError(403, ERROR_CODES.FORBIDDEN, '无权为该团队创建配对码')
      }
      return requested
    }
    if (actor.teams.length === 1) return actor.teams[0].id
    if (!actor.teams.length) throw teamError(403, ERROR_CODES.FORBIDDEN, '当前账号没有可用团队')
    throw teamError(400, ERROR_CODES.INVALID_INPUT, '请先选择目标团队')
  }

  function createPairingCode(actor, input = {}) {
    const teamId = pairingTeamId(actor, input.teamId)
    const code = randomToken(32)
    const createdAt = now()
    const expiresAt = new Date(createdAt.getTime() + PAIRING_TTL_MS).toISOString()
    withTransaction(db, () => {
      db.prepare(`
        UPDATE agent_pairing_code
        SET used_at = ?
        WHERE user_id = ? AND team_id = ? AND used_at IS NULL
      `).run(createdAt.toISOString(), actor.userId, teamId)
      db.prepare(`
        INSERT INTO agent_pairing_code(id, user_id, team_id, code_hash, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        crypto.randomUUID(),
        actor.userId,
        teamId,
        sha256(code),
        expiresAt,
        createdAt.toISOString(),
      )
    })
    return {
      pairingCode: code,
      expiresAt,
      teamId,
      protocolVersion: AGENT_PROTOCOL_VERSION,
    }
  }

  function validateEnrollment(input = {}) {
    protocolVersion(input.protocolVersion)
    const version = agentVersion(input.agentVersion)
    const platform = text(input.platform, '平台', { max: 32 })
    if (!/^[A-Za-z0-9._-]+$/.test(platform)) {
      throw teamError(400, ERROR_CODES.INVALID_INPUT, '平台格式无效')
    }
    return {
      name: text(input.deviceName, '设备名称', { max: 80 }),
      platform,
      version,
    }
  }

  function insertDevice({ userId, name, platform, version, action, detail, teamId = null }) {
    const credential = randomToken(32)
    const agentId = crypto.randomUUID()
    const timestamp = now().toISOString()
    const revokedAgentIds = db
      .prepare(`
        SELECT id
        FROM agent_device
        WHERE user_id = ? AND status = 'active'
      `)
      .all(userId)
      .map((row) => row.id)
    db.prepare(`
      UPDATE sync_task_command
      SET status = 'cancelled', error_text = '账号已在其他设备登录', updated_at = ?
      WHERE agent_id IN (
        SELECT id FROM agent_device WHERE user_id = ? AND status = 'active'
      ) AND status IN ('pending', 'delivered', 'running')
    `).run(timestamp, userId)
    db.prepare(`
      UPDATE sync_agent_binding
      SET sync_status = 'revoked', updated_at = ?
      WHERE agent_id IN (
        SELECT id FROM agent_device WHERE user_id = ? AND status = 'active'
      ) AND sync_status <> 'revoked'
    `).run(timestamp, userId)
    db.prepare(`
      UPDATE agent_device
      SET status = 'revoked', revoked_at = ?
      WHERE user_id = ? AND status = 'active'
    `).run(timestamp, userId)
    db.prepare(`
      INSERT INTO agent_device(
        id, user_id, device_name, platform, agent_version, protocol_version,
        credential_hash, status, last_seen_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
    `).run(
      agentId,
      userId,
      name,
      platform,
      version,
      AGENT_PROTOCOL_VERSION,
      sha256(credential),
      timestamp,
      timestamp,
    )
    db.prepare(`
      INSERT INTO sync_active_agent(user_id, agent_id, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        agent_id = excluded.agent_id,
        updated_at = excluded.updated_at
    `).run(userId, agentId, timestamp)
    appendAuditEvent(db, {
      actorUserId: userId,
      actorAgentId: agentId,
      teamId,
      action,
      targetType: 'agent',
      targetId: agentId,
      detail: { ...detail, deviceId: agentId, userId },
    })
    return {
      agentId,
      credential,
      protocolVersion: AGENT_PROTOCOL_VERSION,
      username:
        db.prepare('SELECT username FROM user_account WHERE id = ?').get(userId)?.username || null,
      teamId: null,
      teams: actorContext(userId).teams,
      revokedAgentIds,
    }
  }

  function publishReplacedAgents(enrolled) {
    for (const agentId of enrolled.revokedAgentIds || []) {
      events?.publishAgentRevoked?.(agentId)
    }
    const { revokedAgentIds: _revokedAgentIds, ...result } = enrolled
    return {
      ...result,
      allowLocalGitRemotes: Boolean(config.allowLocalGitRemotes),
    }
  }

  function enroll(input = {}, { ip = '' } = {}) {
    consumePairAttempt(ip)
    const { name, platform, version } = validateEnrollment(input)
    const pairingCode = text(input.pairingCode, '配对码', { min: 16, max: 512 })
    const timestamp = now().toISOString()
    const pairing = db
      .prepare(`
      SELECT *
      FROM agent_pairing_code
      WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?
    `)
      .get(sha256(pairingCode), timestamp)
    if (!pairing) {
      throw teamError(401, ERROR_CODES.AUTH_FAILED, '配对码无效、已使用或已过期')
    }
    const enrolled = withTransaction(db, () => {
      const consumed = db
        .prepare(`
        UPDATE agent_pairing_code
        SET used_at = ?
        WHERE id = ? AND used_at IS NULL AND expires_at > ?
      `)
        .run(timestamp, pairing.id, timestamp)
      if (consumed.changes !== 1) {
        throw teamError(401, ERROR_CODES.AUTH_FAILED, '配对码无效、已使用或已过期')
      }
      return insertDevice({
        userId: pairing.user_id,
        teamId: pairing.team_id,
        name,
        platform,
        version,
        action: 'agent_enrolled',
        detail: { deviceName: name, platform, agentVersion: version },
      })
    })
    return publishReplacedAgents(enrolled)
  }

  function enrollDesktop(
    input = {},
    { userId, teamId = null, deviceName: tokenDeviceName = null } = {},
  ) {
    if (!userId) {
      throw teamError(401, ERROR_CODES.DESKTOP_TOKEN_INVALID, '设备令牌无效，请在 Board 重新生成')
    }
    const account = db.prepare('SELECT status FROM user_account WHERE id = ?').get(userId)
    if (!account || account.status !== 'active') {
      throw teamError(403, ERROR_CODES.FORBIDDEN, '账号已禁用，无法注册桌面设备')
    }
    const { name, platform, version } = validateEnrollment({
      ...input,
      deviceName: tokenDeviceName || input.deviceName,
    })
    const enrolled = withTransaction(db, () =>
      insertDevice({
        userId,
        teamId,
        name,
        platform,
        version,
        action: 'desktop_device_enrolled',
        detail: {
          deviceName: name,
          platform,
          agentVersion: version,
          userId,
          source: 'desktop_enroll_token',
        },
      }),
    )
    return publishReplacedAgents(enrolled)
  }

  function authenticate(request) {
    const authorization = String(request?.headers?.authorization || '')
    const match = /^Bearer ([A-Za-z0-9._~+/-]+={0,2})$/.exec(authorization)
    if (!match || match[1].length < 32 || match[1].length > 512) {
      throw teamError(401, ERROR_CODES.AGENT_AUTH_REQUIRED, 'Agent 凭证无效或已撤销')
    }
    const row = db
      .prepare(`
      SELECT a.*, u.status AS user_status
      FROM agent_device a
      JOIN user_account u ON u.id = a.user_id
      JOIN sync_active_agent active ON active.user_id = a.user_id AND active.agent_id = a.id
      WHERE a.credential_hash = ? AND a.status = 'active' AND u.status = 'active'
    `)
      .get(sha256(match[1]))
    if (!row) {
      throw teamError(401, ERROR_CODES.AGENT_AUTH_REQUIRED, 'Agent 凭证无效或已撤销')
    }
    return { ...publicAgent(row), userId: row.user_id }
  }

  function heartbeat(agent, input = {}) {
    protocolVersion(input.protocolVersion)
    agentVersion(input.agentVersion)
    safeId(input.agentId || input.deviceId, 'Agent ID')
    if ((input.agentId || input.deviceId) !== agent.id) {
      throw teamError(403, ERROR_CODES.FORBIDDEN, 'Agent 身份不匹配')
    }
    const name = text(input.deviceName || agent.deviceName, '设备名称', { max: 80 })
    const timestamp = now().toISOString()
    db.prepare(`
      UPDATE agent_device
      SET device_name = ?, agent_version = ?, protocol_version = ?,
          last_seen_at = ?, last_heartbeat_json = ?
      WHERE id = ?
    `).run(
      name,
      agentVersion(input.agentVersion),
      AGENT_PROTOCOL_VERSION,
      timestamp,
      JSON.stringify({ taskSpaces: Array.isArray(input.bindings) ? input.bindings.length : 0 }),
      agent.id,
    )
    const bindings = []
    for (const value of Array.isArray(input.bindings) ? input.bindings.slice(0, 64) : []) {
      const taskSpaceId = safeId(value.taskSpaceId, '任务空间 ID')
      const binding = db
        .prepare(`
        SELECT b.*, s.project_id, s.branch_name AS task_space_branch, s.status AS task_space_status
        FROM sync_agent_binding b
        JOIN sync_task_space s ON s.id = b.task_space_id
        WHERE b.agent_id = ? AND b.task_space_id = ?
      `)
        .get(agent.id, taskSpaceId)
      if (!binding) {
        bindings.push({
          taskSpaceId,
          taskSpace_id: taskSpaceId,
          status: 'rejected',
          errorCode: 'BINDING_UNKNOWN',
          error: '当前设备尚未接入该任务空间',
        })
        continue
      }
      const localRepoKey = String(value.localRepoKey || '')
      if (!LOCAL_REPO_KEY.test(localRepoKey) || localRepoKey !== binding.local_repo_key) {
        bindings.push({
          id: binding.id,
          taskSpaceId,
          taskSpace_id: taskSpaceId,
          status: 'rejected',
          errorCode: 'REMOTE_MISMATCH',
          error: '本地仓库与已绑定仓库不一致',
        })
        continue
      }
      bindings.push({
        id: binding.id,
        taskSpaceId,
        taskSpace_id: taskSpaceId,
        projectId: binding.project_id,
        project_id: binding.project_id,
        localRepoKey: binding.local_repo_key,
        branchName: binding.task_space_branch,
        status:
          binding.sync_status === 'approved' && binding.task_space_status === 'active'
            ? 'approved'
            : binding.sync_status,
      })
    }
    return {
      protocolVersion: AGENT_PROTOCOL_VERSION,
      minimumAgentVersion: MINIMUM_AGENT_VERSION,
      compatible: true,
      bindings,
    }
  }

  function onlineAgentForTaskSpace(taskSpaceId, userId) {
    const staleCutoff = new Date(now().getTime() - staleMs).toISOString()
    return db
      .prepare(`
      SELECT a.*, s.project_id, b.id AS binding_id, b.task_space_id,
             b.local_repo_key, b.branch_name
      FROM sync_active_agent active
      JOIN agent_device a ON a.id = active.agent_id
      JOIN sync_agent_binding b ON b.agent_id = a.id
      JOIN sync_task_space s ON s.id = b.task_space_id
      JOIN sync_project p ON p.id = s.project_id
      WHERE active.user_id = ? AND a.user_id = ? AND a.status = 'active'
        AND b.task_space_id = ? AND b.sync_status = 'approved'
        AND s.status = 'active' AND p.status = 'active'
        AND a.last_seen_at >= ?
      LIMIT 2
    `)
      .all(userId, userId, taskSpaceId, staleCutoff)
  }

  function manageableTeamIds(actor, requestedTeamId) {
    const requested = String(requestedTeamId || '').trim()
    if (!actor?.systemAdmin && !(actor?.teams || []).some((team) => team.role === 'admin')) {
      throw teamError(403, ERROR_CODES.FORBIDDEN, '只有团队管理员可以查看 Agent')
    }
    if (actor.systemAdmin) {
      if (!requested || requested === 'all') return null
      const team = db
        .prepare("SELECT id FROM team WHERE id = ? AND status = 'active'")
        .get(requested)
      if (!team) throw teamError(404, ERROR_CODES.NOT_FOUND, '团队不存在')
      return [requested]
    }
    const adminTeamIds = (actor.teams || [])
      .filter((team) => team.role === 'admin')
      .map((team) => team.id)
    if (!requested || requested === 'all') return adminTeamIds
    if (!adminTeamIds.includes(requested)) {
      throw teamError(403, ERROR_CODES.FORBIDDEN, '无权管理该团队的 Agent')
    }
    return [requested]
  }

  function listDevices(actor, { teamId = null } = {}) {
    const teamIds = manageableTeamIds(actor, teamId)
    const rows =
      teamIds == null
        ? db
            .prepare(`
          SELECT a.*, u.username, u.display_name,
                 active.agent_id = a.id AS current_effective
          FROM agent_device a
          JOIN user_account u ON u.id = a.user_id
          LEFT JOIN sync_active_agent active
            ON active.user_id = a.user_id AND active.agent_id = a.id
          ORDER BY a.created_at DESC
        `)
            .all()
        : teamIds.length
          ? db
              .prepare(`
            SELECT DISTINCT a.*, u.username, u.display_name,
                   active.agent_id = a.id AS current_effective
            FROM agent_device a
            JOIN user_account u ON u.id = a.user_id
            JOIN team_member tm ON tm.user_id = a.user_id
            LEFT JOIN sync_active_agent active
              ON active.user_id = a.user_id AND active.agent_id = a.id
            WHERE tm.team_id IN (${teamIds.map(() => '?').join(', ')})
            ORDER BY a.created_at DESC
          `)
              .all(...teamIds)
          : []
    return rows.map((row) => ({
      ...publicAgent(row),
      username: row.username,
      displayName: row.display_name,
      current: Boolean(row.current_effective),
    }))
  }

  function revokeDevice(actor, agentId, { teamId = null } = {}) {
    const teamIds = manageableTeamIds(actor, teamId)
    const agent = db
      .prepare('SELECT * FROM agent_device WHERE id = ?')
      .get(safeId(agentId, 'Agent ID'))
    if (!agent) throw teamError(404, ERROR_CODES.NOT_FOUND, 'Agent 不存在')
    if (teamIds != null) {
      const member = teamIds.length
        ? db
            .prepare(`
            SELECT 1
            FROM team_member
            WHERE user_id = ? AND team_id IN (${teamIds.map(() => '?').join(', ')})
            LIMIT 1
          `)
            .get(agent.user_id, ...teamIds)
        : null
      if (!member) throw teamError(404, ERROR_CODES.NOT_FOUND, 'Agent 不存在')
    }
    const timestamp = now().toISOString()
    withTransaction(db, () => {
      db.prepare(`
        UPDATE sync_task_command
        SET status = 'cancelled', error_text = 'Agent 已被撤销', updated_at = ?
        WHERE agent_id = ? AND status IN ('pending', 'delivered', 'running')
      `).run(timestamp, agentId)
      db.prepare(`
        UPDATE sync_agent_binding
        SET sync_status = 'revoked', updated_at = ?
        WHERE agent_id = ? AND sync_status <> 'revoked'
      `).run(timestamp, agentId)
      db.prepare(`
        UPDATE agent_device SET status = 'revoked', revoked_at = ? WHERE id = ?
      `).run(timestamp, agentId)
      db.prepare('DELETE FROM sync_active_agent WHERE agent_id = ?').run(agentId)
      appendAuditEvent(db, {
        actorUserId: actor.userId,
        action: 'agent_revoked',
        targetType: 'agent',
        targetId: agentId,
        teamId: String(teamId || '') || null,
      })
    })
    events?.publishAgentRevoked(agentId)
    return { revoked: true, agentId }
  }

  return {
    createPairingCode,
    enroll,
    enrollDesktop,
    authenticate,
    heartbeat,
    onlineAgentForTaskSpace,
    listDevices,
    revokeDevice,
  }
}
