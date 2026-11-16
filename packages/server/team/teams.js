import crypto from 'node:crypto'
import { withTransaction } from '../database.js'
import { appendAuditEvent } from './audit.js'
import { ERROR_CODES, teamError } from './errors.js'

export const TEAM_ROLES = Object.freeze({
  ADMIN: 'admin',
  MEMBER: 'member',
})

const TEAM_STATUSES = new Set(['active', 'disabled'])
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/

function cleanTeamName(value) {
  const name = String(value || '').trim()
  if (!name || Array.from(name).length > 80) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, '团队名称必须是 1 到 80 个字符')
  }
  return name
}

function cleanSlug(value, name) {
  const source =
    String(value || '').trim() ||
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
  const slug = source.slice(0, 64)
  if (!SLUG_PATTERN.test(slug)) {
    return `team-${crypto.randomUUID().slice(0, 8)}`
  }
  return slug
}

function uniqueSlug(db, requested, excludingTeamId = null) {
  let slug = requested
  let suffix = 1
  while (
    db
      .prepare(`
    SELECT 1 FROM team WHERE slug = ? AND (? IS NULL OR id <> ?)
  `)
      .get(slug, excludingTeamId, excludingTeamId)
  ) {
    slug = `${requested.slice(0, 58)}-${suffix}`
    suffix += 1
  }
  return slug
}

function teamRow(db, teamId) {
  return db.prepare('SELECT * FROM team WHERE id = ?').get(teamId) || null
}

function publicTeam(row, { role = null, active = false } = {}) {
  if (!row) return null
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    role,
    active,
    memberCount: Number(row.member_count || 0),
    projectCount: Number(row.project_count || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function teamWithCounts(db, teamId) {
  return (
    db
      .prepare(`
    SELECT
      t.*,
      (SELECT COUNT(*) FROM team_member m WHERE m.team_id = t.id) AS member_count,
      (SELECT COUNT(*) FROM team_project p WHERE p.team_id = t.id) AS project_count
    FROM team t
    WHERE t.id = ?
  `)
      .get(teamId) || null
  )
}

function requireTeamId(value) {
  const teamId = String(value || '').trim()
  if (!teamId) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, '缺少团队 ID')
  }
  return teamId
}

export function readTeam(db, teamId) {
  const row = teamWithCounts(db, requireTeamId(teamId))
  return row ? publicTeam(row) : null
}

function readTeamMembership(db, teamId, userId) {
  if (!teamId || !userId) return null
  return (
    db
      .prepare(`
    SELECT m.*, t.status AS team_status, t.name AS team_name
    FROM team_member m
    JOIN team t ON t.id = m.team_id
    WHERE m.team_id = ? AND m.user_id = ?
  `)
      .get(teamId, userId) || null
  )
}

export function listTeamsForActor(db, actor, { activeOnly = false } = {}) {
  if (actor?.systemAdmin) {
    return db
      .prepare(`
      SELECT
        t.*,
        (SELECT COUNT(*) FROM team_member m WHERE m.team_id = t.id) AS member_count,
        (SELECT COUNT(*) FROM team_project p WHERE p.team_id = t.id) AS project_count
      FROM team t
      ${activeOnly ? "WHERE t.status = 'active'" : ''}
      ORDER BY t.name COLLATE NOCASE, t.id
    `)
      .all()
      .map((row) => publicTeam(row))
  }
  if (!actor?.userId) return []
  return db
    .prepare(`
    SELECT
      t.*, m.role,
      (SELECT COUNT(*) FROM team_member member WHERE member.team_id = t.id) AS member_count,
      (SELECT COUNT(*) FROM team_project p WHERE p.team_id = t.id) AS project_count
    FROM team t
    JOIN team_member m ON m.team_id = t.id AND m.user_id = ?
    WHERE t.status = 'active'
    ORDER BY t.name COLLATE NOCASE, t.id
  `)
    .all(actor.userId)
    .map((row) =>
      publicTeam(row, {
        role: row.role,
      }),
    )
}

export function listTeamMembers(db, teamId) {
  return db
    .prepare(`
    SELECT
      m.user_id, m.role AS team_role, m.created_at, m.updated_at,
      u.username, u.display_name, u.system_admin, u.status
    FROM team_member m
    JOIN user_account u ON u.id = m.user_id
    WHERE m.team_id = ?
    ORDER BY
      CASE m.role WHEN 'admin' THEN 0 ELSE 1 END,
      u.username_key
  `)
    .all(requireTeamId(teamId))
    .map((row) => ({
      userId: row.user_id,
      username: row.username,
      displayName: row.display_name,
      systemAdmin: Boolean(row.system_admin),
      status: row.status,
      role: row.team_role,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }))
}

export function listUserTeams(db, userId) {
  return db
    .prepare(`
    SELECT t.*, m.role
    FROM team_member m
    JOIN team t ON t.id = m.team_id
    WHERE m.user_id = ?
    ORDER BY t.name COLLATE NOCASE, t.id
  `)
    .all(userId)
    .map((row) => publicTeam(row, { role: row.role }))
}

export function listActiveTeamMemberships(db, userId) {
  return db
    .prepare(`
    SELECT t.*, m.role
    FROM team_member m
    JOIN team t ON t.id = m.team_id
    WHERE m.user_id = ? AND t.status = 'active'
    ORDER BY t.name COLLATE NOCASE, t.id
  `)
    .all(userId)
    .map((row) => publicTeam(row, { role: row.role }))
}

export function resolveTeamScope(db, actor, requestedTeamId, { adminOnly = false } = {}) {
  const requested = String(requestedTeamId || '').trim()
  if (!requested || requested === 'all') return null
  if (actor?.systemAdmin) {
    const team = teamRow(db, requested)
    if (!team || team.status !== 'active') {
      throw teamError(404, ERROR_CODES.NOT_FOUND, '团队不存在')
    }
    return requested
  }
  if (!actor?.userId) {
    throw teamError(401, ERROR_CODES.AUTH_REQUIRED, '需要登录')
  }
  const membership = readTeamMembership(db, requested, actor.userId)
  if (!membership || membership.team_status !== 'active') {
    throw teamError(403, ERROR_CODES.FORBIDDEN, '无权访问该团队')
  }
  if (adminOnly && membership.role !== TEAM_ROLES.ADMIN) {
    throw teamError(403, ERROR_CODES.FORBIDDEN, '只有团队管理员可以执行该操作')
  }
  return requested
}

export function createTeam(db, { name, slug, actorUserId = null }) {
  const teamName = cleanTeamName(name)
  const now = new Date().toISOString()
  const id = crypto.randomUUID()
  const teamSlug = uniqueSlug(db, cleanSlug(slug, teamName))
  withTransaction(db, () => {
    db.prepare(`
      INSERT INTO team(id, name, slug, status, created_at, updated_at)
      VALUES (?, ?, ?, 'active', ?, ?)
    `).run(id, teamName, teamSlug, now, now)
    appendAuditEvent(db, {
      actorUserId,
      teamId: id,
      action: 'team_created',
      targetType: 'team',
      targetId: id,
      detail: { name: teamName, slug: teamSlug },
    })
  })
  return readTeam(db, id)
}

export function updateTeam(db, { teamId, updates = {}, actorUserId = null }) {
  const id = requireTeamId(teamId)
  const current = teamRow(db, id)
  if (!current) throw teamError(404, ERROR_CODES.NOT_FOUND, '团队不存在')
  const name = updates.name == null ? current.name : cleanTeamName(updates.name)
  const status = updates.status == null ? current.status : String(updates.status)
  if (!TEAM_STATUSES.has(status)) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, '团队状态无效')
  }
  const slug =
    updates.slug == null ? current.slug : uniqueSlug(db, cleanSlug(updates.slug, name), id)
  const now = new Date().toISOString()
  withTransaction(db, () => {
    db.prepare(`
      UPDATE team
      SET name = ?, slug = ?, status = ?, updated_at = ?
      WHERE id = ?
    `).run(name, slug, status, now, id)
    if (status === 'disabled') {
      db.prepare('UPDATE user_session SET active_team_id = NULL WHERE active_team_id = ?').run(id)
      db.prepare(`
        UPDATE agent_project_binding
        SET sync_status = 'revoked', updated_at = ?
        WHERE team_id = ? AND sync_status <> 'revoked'
      `).run(now, id)
    }
    appendAuditEvent(db, {
      actorUserId,
      teamId: id,
      action: 'team_updated',
      targetType: 'team',
      targetId: id,
      detail: {
        name,
        slug,
        status,
        previousStatus: current.status,
      },
    })
  })
  return readTeam(db, id)
}

function normalizeTeamAssignments(db, teams) {
  if (!Array.isArray(teams)) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, 'teams 必须是数组')
  }
  const seen = new Set()
  return teams.map((item) => {
    const teamId = requireTeamId(item?.teamId || item?.id)
    if (seen.has(teamId)) {
      throw teamError(400, ERROR_CODES.INVALID_INPUT, '团队分配不能重复')
    }
    seen.add(teamId)
    const row = teamRow(db, teamId)
    if (!row) throw teamError(404, ERROR_CODES.NOT_FOUND, '团队不存在')
    const role = String(item?.role || TEAM_ROLES.MEMBER)
    if (!Object.values(TEAM_ROLES).includes(role)) {
      throw teamError(400, ERROR_CODES.INVALID_INPUT, '团队成员角色无效')
    }
    return { teamId, role }
  })
}

function cleanupUserInTeam(db, userId, teamId, now) {
  const projectIds = db
    .prepare(`
    SELECT repository_id FROM team_project WHERE team_id = ?
  `)
    .all(teamId)
    .map((row) => row.repository_id)
  if (projectIds.length) {
    const placeholders = projectIds.map(() => '?').join(', ')
    db.prepare(`
      DELETE FROM project_member
      WHERE user_id = ? AND project_id IN (${placeholders})
    `).run(userId, ...projectIds)
    db.prepare(`
      UPDATE agent_command
      SET status = 'cancelled', completed_at = ?
      WHERE status IN ('pending', 'delivered')
        AND binding_id IN (
          SELECT b.id
          FROM agent_project_binding b
          JOIN agent_device a ON a.id = b.agent_id
          WHERE b.team_id = ? AND a.user_id = ?
        )
    `).run(now, teamId, userId)
    db.prepare(`
      DELETE FROM agent_project_binding
      WHERE team_id = ? AND agent_id IN (
        SELECT id FROM agent_device WHERE user_id = ?
      )
    `).run(teamId, userId)
  }
  db.prepare('DELETE FROM user_board_state WHERE user_id = ? AND team_id = ?').run(userId, teamId)
  db.prepare('DELETE FROM saved_view WHERE owner_user_id = ? AND team_id = ?').run(userId, teamId)
  db.prepare(`
    DELETE FROM agent_event_cursor
    WHERE team_id = ? AND agent_id IN (
      SELECT id FROM agent_device WHERE user_id = ?
    )
  `).run(teamId, userId)
  db.prepare(`
    UPDATE agent_pairing_code
    SET used_at = ?
    WHERE user_id = ? AND team_id = ? AND used_at IS NULL
  `).run(now, userId, teamId)
  db.prepare(`
    UPDATE user_session
    SET active_team_id = NULL
    WHERE user_id = ? AND active_team_id = ?
  `).run(userId, teamId)
}

export function setUserTeams(db, { userId, teams, actorUserId = null }) {
  const assignments = normalizeTeamAssignments(db, teams)
  const current = db.prepare('SELECT id FROM user_account WHERE id = ?').get(userId)
  if (!current) throw teamError(404, ERROR_CODES.NOT_FOUND, '账号不存在')
  const previousTeams = listUserTeams(db, userId)
  const previous = new Map(previousTeams.map((team) => [team.id, team.role]))
  const next = new Set(assignments.map((item) => item.teamId))
  const unchanged =
    assignments.length === previous.size &&
    assignments.every((item) => previous.get(item.teamId) === item.role)
  if (unchanged) return listUserTeams(db, userId)
  const now = new Date().toISOString()
  withTransaction(db, () => {
    for (const [teamId, role] of previous) {
      if (next.has(teamId)) continue
      cleanupUserInTeam(db, userId, teamId, now)
      db.prepare('DELETE FROM team_member WHERE team_id = ? AND user_id = ?').run(teamId, userId)
      appendAuditEvent(db, {
        actorUserId,
        teamId,
        action: 'team_member_removed',
        targetType: 'team_member',
        targetId: userId,
        detail: { previousRole: role },
      })
    }
    for (const item of assignments) {
      const previousRole = previous.get(item.teamId) || null
      db.prepare(`
        INSERT INTO team_member(team_id, user_id, role, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(team_id, user_id) DO UPDATE SET
          role = excluded.role,
          updated_at = excluded.updated_at
      `).run(item.teamId, userId, item.role, now, now)
      if (!previousRole) {
        appendAuditEvent(db, {
          actorUserId,
          teamId: item.teamId,
          action: 'team_member_added',
          targetType: 'team_member',
          targetId: userId,
          detail: { role: item.role },
        })
      } else if (previousRole !== item.role) {
        appendAuditEvent(db, {
          actorUserId,
          teamId: item.teamId,
          action: 'team_member_updated',
          targetType: 'team_member',
          targetId: userId,
          detail: { previousRole, role: item.role },
        })
      }
    }
    appendAuditEvent(db, {
      actorUserId,
      action: 'user_teams_updated',
      targetType: 'user',
      targetId: userId,
      detail: {
        teams: assignments.map((item) => ({ teamId: item.teamId, role: item.role })),
      },
    })
  })
  return listUserTeams(db, userId)
}

export function validateTeamAssignments(db, teams) {
  normalizeTeamAssignments(db, teams)
}

export function assertTeamMember(db, teamId, userId) {
  const membership = readTeamMembership(db, teamId, userId)
  if (!membership || membership.team_status !== 'active') {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, '目标成员不属于该团队')
  }
  return membership
}

export function resolveProjectTeam(db, actor, requestedTeamId) {
  const requested = String(requestedTeamId || '').trim()
  if (actor?.systemAdmin) {
    if (!requested) {
      throw teamError(400, ERROR_CODES.INVALID_INPUT, '请先选择目标团队')
    }
    const team = teamRow(db, requested)
    if (!team || team.status !== 'active') {
      throw teamError(404, ERROR_CODES.NOT_FOUND, '团队不存在')
    }
    return requested
  }
  const adminTeams = listUserTeams(db, actor?.userId).filter(
    (team) => team.status === 'active' && team.role === TEAM_ROLES.ADMIN,
  )
  if (!requested && adminTeams.length === 1) {
    return adminTeams[0].id
  }
  if (!requested) {
    throw teamError(
      adminTeams.length ? 400 : 403,
      adminTeams.length ? ERROR_CODES.INVALID_INPUT : ERROR_CODES.FORBIDDEN,
      adminTeams.length ? '请先选择目标团队' : '只有团队管理员可以接入项目',
    )
  }
  const membership = readTeamMembership(db, requested, actor.userId)
  if (!membership || membership.team_status !== 'active') {
    throw teamError(403, ERROR_CODES.FORBIDDEN, '当前账号不属于目标团队')
  }
  if (membership.role !== TEAM_ROLES.ADMIN) {
    throw teamError(403, ERROR_CODES.FORBIDDEN, '只有团队管理员可以接入项目')
  }
  return requested
}
