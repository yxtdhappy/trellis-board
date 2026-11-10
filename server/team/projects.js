import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { normalizeTrellisAgentTools } from '../../shared/trellis-agent-tools.js'
import { withTransaction } from '../database.js'
import { appendAuditEvent } from './audit.js'
import { ERROR_CODES, teamError } from './errors.js'
import { normalizeGitRemote, readGitProject } from './git-manager.js'
import { CAPABILITIES, authorizeProject, roleCanWrite } from './permissions.js'
import { assertTeamMember, resolveProjectTeam } from './teams.js'
import {
  computeScriptTreeHash,
  precheckLifecycleHooks,
  resolveDeveloperWorkspace,
  validateDeveloperId,
} from './toolchain.js'

const ROLES = new Set(['lead', 'member', 'read_only'])

function cleanName(value, label, max = 80) {
  const result = String(value || '').trim()
  if (!result || Array.from(result).length > max) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, `${label}必须是 1 到 ${max} 个字符`)
  }
  return result
}

function projectRow(db, projectId) {
  return (
    db
      .prepare(`
    SELECT
      p.*, r.name AS repository_name, r.path AS repository_path,
      t.name AS team_name,
      c.name AS credential_name, c.host AS credential_host,
      c.auth_type AS credential_auth_type
    FROM team_project p
    JOIN repositories r ON r.id = p.repository_id
    JOIN team t ON t.id = p.team_id
    LEFT JOIN git_credential c ON c.id = p.git_credential_id
    WHERE p.repository_id = ?
  `)
      .get(projectId) || null
  )
}

function storedAgentTools(value) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : []
  } catch {
    return []
  }
}

function validatedAgentTools(value) {
  try {
    return normalizeTrellisAgentTools(value)
  } catch (error) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, error.message)
  }
}

function uniqueAgentTools(values) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value))]
}

function publicProject(row) {
  if (!row) return null
  return {
    id: row.repository_id,
    repositoryId: row.repository_id,
    teamId: row.team_id || null,
    teamName: row.team_name || null,
    name: row.repository_name,
    syncBranch: row.sync_branch,
    credential: row.git_credential_id
      ? {
          id: row.git_credential_id,
          name: row.credential_name,
          host: row.credential_host,
          authType: row.credential_auth_type,
        }
      : null,
    syncStatus: row.sync_status,
    agentTools: storedAgentTools(row.agent_tools_json),
    bootstrapLeadUserId: row.bootstrap_lead_user_id || null,
    bootstrapLeadTrellisDevId: row.bootstrap_lead_trellis_dev_id || null,
    trustedToolchainSha256: row.trusted_task_toolchain_sha256 || null,
    lastFetchAt: row.last_fetch_at || null,
    lastPushAt: row.last_push_at || null,
    lastError: row.last_error || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function publicMemberCandidate(row) {
  return {
    userId: row.user_id,
    displayName: row.display_name,
    role: row.role,
    trellisDevId: row.trellis_dev_id || null,
    status: row.status,
  }
}

function memberCandidateRows(db, projectIds) {
  const ids = [...new Set(projectIds.map(String).filter(Boolean))]
  if (!ids.length) return []
  const placeholders = ids.map(() => '?').join(', ')
  return db
    .prepare(`
    SELECT
      m.project_id, m.user_id, m.role, m.trellis_dev_id,
      u.username, u.display_name, u.status
    FROM project_member m
    JOIN user_account u ON u.id = m.user_id
    WHERE m.project_id IN (${placeholders})
      AND m.role IN ('lead', 'member')
      AND u.status = 'active'
      AND m.trellis_dev_id IS NOT NULL
      AND length(trim(m.trellis_dev_id)) > 0
    ORDER BY
      m.project_id,
      CASE m.role WHEN 'lead' THEN 0 ELSE 1 END,
      u.username_key
  `)
    .all(...ids)
}

function activeLeadCount(db, projectId, excludingUserId = null) {
  return Number(
    db
      .prepare(`
    SELECT COUNT(*) AS count
    FROM project_member m
    JOIN user_account u ON u.id = m.user_id
    WHERE m.project_id = ?
      AND m.role = 'lead'
      AND u.status = 'active'
      AND (? IS NULL OR m.user_id <> ?)
  `)
      .get(projectId, excludingUserId, excludingUserId).count,
  )
}

function assertNotLastLead(db, projectId, userId) {
  if (activeLeadCount(db, projectId, userId) === 0) {
    throw teamError(409, ERROR_CODES.CONFLICT, '不能移除或降级项目最后一名有效负责人')
  }
}

function activeUser(db, userId) {
  const user = db
    .prepare(`
    SELECT id, username, display_name, status
    FROM user_account
    WHERE id = ?
  `)
    .get(userId)
  if (!user || user.status !== 'active') {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, '目标成员不是有效启用账号')
  }
  return user
}

export function createProjectService({
  db,
  config,
  dataDir,
  gitManager,
  credentialService,
  taskIndex,
}) {
  const projectsRoot = path.join(dataDir, 'projects')

  function requireProjectManager(actor, projectId) {
    return authorizeProject(actor, projectId, CAPABILITIES.MANAGE_PROJECT, { db })
  }

  function read(projectId) {
    return projectRow(db, projectId)
  }

  function listAll(actor = null, { teamId = null } = {}) {
    const requestedTeamId = String(teamId || '').trim()
    const scopedTeamId = requestedTeamId && requestedTeamId !== 'all' ? requestedTeamId : null
    let teamIds = null
    if (actor && !actor.systemAdmin) {
      teamIds = [
        ...new Set(
          (actor.teams || [])
            .filter((team) => team.role === 'admin' && team.status === 'active')
            .map((team) => team.id),
        ),
      ]
      if (!teamIds.length) return []
      if (scopedTeamId) teamIds = [scopedTeamId]
    } else if (scopedTeamId) {
      teamIds = [scopedTeamId]
    }
    const filter = teamIds?.length
      ? `WHERE p.team_id IN (${teamIds.map(() => '?').join(', ')})`
      : ''
    const params = teamIds || []
    return db
      .prepare(`
      SELECT
        p.*, r.name AS repository_name, r.path AS repository_path,
        t.name AS team_name,
        c.name AS credential_name, c.host AS credential_host,
        c.auth_type AS credential_auth_type
      FROM team_project p
      JOIN repositories r ON r.id = p.repository_id
      JOIN team t ON t.id = p.team_id
      LEFT JOIN git_credential c ON c.id = p.git_credential_id
      ${filter}
      ORDER BY p.created_at DESC
    `)
      .all(...params)
      .map(publicProject)
  }

  function listReadable(actor, { includeAssignees = true } = {}) {
    const params = [actor.userId, actor.userId, actor.systemAdmin ? 1 : 0]
    const rows = db
      .prepare(`
      SELECT
        p.*, r.name AS repository_name, r.path AS repository_path,
        t.name AS team_name,
        gc.name AS credential_name, gc.host AS credential_host,
        gc.auth_type AS credential_auth_type,
        m.role, m.trellis_dev_id, tm.role AS team_role,
        c.scanned_content_key, c.scanned_branch_sha, c.saved_at
      FROM team_project p
      JOIN repositories r ON r.id = p.repository_id
      JOIN team t ON t.id = p.team_id
      LEFT JOIN git_credential gc ON gc.id = p.git_credential_id
      LEFT JOIN team_member tm
        ON tm.team_id = p.team_id AND tm.user_id = ?
      LEFT JOIN project_member m
        ON m.project_id = p.repository_id AND m.user_id = ?
      LEFT JOIN project_scan_cache c ON c.project_id = p.repository_id
      WHERE p.sync_status IN ('current', 'stale', 'pending_push', 'needs_repair')
        AND t.status = 'active'
        AND (? = 1 OR tm.role = 'admin' OR m.user_id IS NOT NULL)
      ORDER BY t.name COLLATE NOCASE, r.name COLLATE NOCASE, p.repository_id
    `)
      .all(...params)
    const candidates = new Map()
    if (includeAssignees) {
      memberCandidateRows(db, [...new Set(rows.map((row) => row.repository_id))]).forEach((row) => {
        if (!candidates.has(row.project_id)) candidates.set(row.project_id, [])
        candidates.get(row.project_id).push(publicMemberCandidate(row))
      })
    }
    return rows.map((row) => ({
      ...publicProject(row),
      teamId: row.team_id,
      teamName: row.team_name,
      teamRole: row.team_role || null,
      role: row.role || (actor.systemAdmin ? 'system_admin' : 'team_admin'),
      trellisDevId: row.trellis_dev_id,
      boardVersion: row.scanned_content_key || null,
      scannedAt: row.saved_at || null,
      stale: row.sync_status !== 'current',
      validAssignees: candidates.get(row.repository_id) || [],
    }))
  }

  function listStatusReadable(actor) {
    return listReadable(actor, { includeAssignees: false })
  }

  function listAssociationCandidates(actor) {
    if (!actor?.userId) return []
    const rows = actor.systemAdmin
      ? db
          .prepare(`
          SELECT
            p.*, r.name AS repository_name, r.path AS repository_path,
            t.name AS team_name, m.role, tm.role AS team_role
          FROM team_project p
          JOIN repositories r ON r.id = p.repository_id
          JOIN team t ON t.id = p.team_id
          LEFT JOIN team_member tm
            ON tm.team_id = p.team_id AND tm.user_id = ?
          LEFT JOIN project_member m
            ON m.project_id = p.repository_id AND m.user_id = ?
          WHERE p.sync_status IN ('current', 'stale', 'pending_push', 'needs_repair')
            AND t.status = 'active'
          ORDER BY t.name COLLATE NOCASE, r.name COLLATE NOCASE, p.repository_id
        `)
          .all(actor.userId, actor.userId)
      : db
          .prepare(`
          SELECT
            p.*, r.name AS repository_name, r.path AS repository_path,
            t.name AS team_name, m.role, tm.role AS team_role
          FROM team_project p
          JOIN repositories r ON r.id = p.repository_id
          JOIN team t ON t.id = p.team_id
          JOIN team_member tm
            ON tm.team_id = p.team_id AND tm.user_id = ?
          LEFT JOIN project_member m
            ON m.project_id = p.repository_id AND m.user_id = ?
          WHERE p.sync_status IN ('current', 'stale', 'pending_push', 'needs_repair')
            AND t.status = 'active'
          ORDER BY t.name COLLATE NOCASE, r.name COLLATE NOCASE, p.repository_id
        `)
          .all(actor.userId, actor.userId)
    return rows.map((row) => ({
      ...publicProject(row),
      role: row.role || (actor.systemAdmin ? 'system_admin' : 'team_admin'),
      teamRole: row.team_role || null,
      readOnly: row.role ? !roleCanWrite(row.role) : !actor.systemAdmin,
    }))
  }

  async function probeRemote(actor, input = {}) {
    const teamId = resolveProjectTeam(db, actor, input.teamId)
    const remote = normalizeGitRemote(input.remoteUrl, config)
    const credentialId = String(input.credentialId || '').trim() || null
    const credential = credentialId
      ? credentialService.resolveForRemote(actor, {
          teamId,
          credentialId,
          remote,
        })
      : null
    return gitManager.probeRemote({ actor, remote, credential, branch: input.branch })
  }

  async function connect(actor, input = {}) {
    const teamId = resolveProjectTeam(db, actor, input.teamId)
    const name = cleanName(input.name, '项目名称')
    const agentTools = validatedAgentTools(input.agentTools)
    const leadUserId = String(input.leadUserId || '').trim()
    activeUser(db, leadUserId)
    assertTeamMember(db, teamId, leadUserId)
    const leadTrellisDevId = validateDeveloperId(input.leadTrellisDevId)
    const syncBranch = await gitManager.assertValidBranch(input.syncBranch)
    const remote = normalizeGitRemote(input.remoteUrl, config)
    const credentialId = String(input.credentialId || '').trim() || null
    const credential = credentialId
      ? credentialService.resolveForRemote(actor, {
          teamId,
          credentialId,
          remote,
        })
      : null
    const existingRepositoryId = String(input.repositoryId || '').trim()
    let repositoryId
    let existing = null
    if (existingRepositoryId) {
      existing = db.prepare('SELECT * FROM repositories WHERE id = ?').get(existingRepositoryId)
      if (!existing) throw teamError(404, ERROR_CODES.NOT_FOUND, '待升级项目不存在')
      if (projectRow(db, existingRepositoryId)) {
        throw teamError(409, ERROR_CODES.CONFLICT, '该项目已接入团队模式')
      }
      repositoryId = existing.id
    } else {
      repositoryId = crypto.randomUUID()
    }
    const workspaceKey = crypto.randomUUID()
    const existingWorkspace = db
      .prepare(`
      SELECT 1 FROM team_project WHERE team_id = ? AND workspace_key = ?
    `)
      .get(teamId, workspaceKey)
    if (existingWorkspace) {
      throw teamError(409, ERROR_CODES.CONFLICT, '团队内工作区标识已存在')
    }
    const cloneProject = {
      id: repositoryId,
      workspaceKey,
      remoteUrl: remote.url,
      syncBranch,
      teamId,
      credentialId,
    }
    const cloned = await gitManager.cloneForTeam(cloneProject, credential, {
      agentTools,
      leadTrellisDevId,
    })
    const target = cloned.target
    const existingAgentTools = Array.isArray(cloned.existingAgentTools)
      ? cloned.existingAgentTools
      : []
    const initializedAgentTools = Array.isArray(cloned.initializedAgentTools)
      ? cloned.initializedAgentTools
      : cloned.initialized
        ? agentTools
        : []
    const persistedAgentTools = uniqueAgentTools([...existingAgentTools, ...initializedAgentTools])
    if (!persistedAgentTools.length) persistedAgentTools.push(...agentTools)
    let toolchain
    try {
      toolchain = computeScriptTreeHash(target)
      const now = new Date().toISOString()

      withTransaction(db, () => {
        if (!existing) {
          db.prepare(`
            INSERT INTO repositories(
              id, name, path, path_key, position, created_at, updated_at
            ) VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM repositories), ?, ?)
          `).run(
            repositoryId,
            name,
            target.replaceAll('\\', '/'),
            (process.platform === 'win32' ? target.toLowerCase() : target).replaceAll('\\', '/'),
            now,
            now,
          )
        }
        db.prepare(`
          INSERT INTO team_project(
            repository_id, team_id, workspace_key, remote_url, remote_identity_hash,
            sync_branch, git_credential_id, trusted_task_toolchain_sha256, sync_status,
            agent_tools_json, bootstrap_lead_user_id, bootstrap_lead_trellis_dev_id,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'provisioning', ?, ?, ?, ?, ?)
        `).run(
          repositoryId,
          teamId,
          workspaceKey,
          remote.url,
          remote.identityHash,
          syncBranch,
          credentialId,
          toolchain.sha256,
          JSON.stringify(persistedAgentTools),
          leadUserId,
          leadTrellisDevId,
          now,
          now,
        )
        appendAuditEvent(db, {
          actorUserId: actor.userId,
          teamId,
          projectId: repositoryId,
          action: 'project_connected',
          targetType: 'project',
          targetId: repositoryId,
          detail: {
            syncBranch,
            credentialId,
            credentialName: credential?.name || null,
            toolchainSha256: toolchain.sha256,
            existingRepository: Boolean(existing),
            agentTools: persistedAgentTools,
            existingAgentTools,
            initializedAgentTools,
            leadUserId,
            trellisDevId: leadTrellisDevId,
            initialized: cloned.initialized === true,
            targetCommit: cloned.remoteCommitSha || null,
          },
        })
      })
    } catch (error) {
      try {
        const expectedTarget = path.resolve(projectsRoot, workspaceKey)
        if (path.resolve(target) !== expectedTarget) {
          throw new Error('拒绝清理非本次 UUID 的项目目录')
        }
        fs.rmSync(expectedTarget, { recursive: true, force: true })
      } catch (cleanupError) {
        error.cleanupError = cleanupError
      }
      throw error
    }
    return {
      project: publicProject(projectRow(db, repositoryId)),
      approval: {
        toolchainSha256: toolchain.sha256,
        files: toolchain.files,
      },
    }
  }

  async function approve(actor, input = {}) {
    const projectId = String(input.projectId || '').trim()
    requireProjectManager(actor, projectId)
    const approved = String(input.toolchainSha256 || '')
      .trim()
      .toLowerCase()
    if (!/^[a-f0-9]{64}$/.test(approved)) {
      throw teamError(400, ERROR_CODES.INVALID_INPUT, '工具链摘要格式无效')
    }
    return gitManager.withProjectLock(projectId, async () => {
      const row = projectRow(db, projectId)
      if (!row) throw teamError(404, ERROR_CODES.NOT_FOUND, '项目不存在')
      const project = readGitProject(db, projectId)
      await gitManager.assertProjectBranch(project)
      const computed = computeScriptTreeHash(project.path)
      if (computed.sha256 !== approved) {
        throw teamError(
          409,
          ERROR_CODES.TOOLCHAIN_MISMATCH,
          '工具链摘要与当前工作副本不一致，请重新核对',
        )
      }
      await precheckLifecycleHooks(project.path)
      const requestedLeadUserId = String(input.leadUserId || '').trim()
      const requestedDeveloperId = validateDeveloperId(input.leadTrellisDevId)
      if (row.bootstrap_lead_user_id && requestedLeadUserId !== row.bootstrap_lead_user_id) {
        throw teamError(409, ERROR_CODES.CONFLICT, '批准负责人必须与项目接入时选择的首个负责人一致')
      }
      if (
        row.bootstrap_lead_trellis_dev_id &&
        requestedDeveloperId !== row.bootstrap_lead_trellis_dev_id
      ) {
        throw teamError(409, ERROR_CODES.CONFLICT, '批准 developer ID 必须与项目接入时的配置一致')
      }
      const leadUserId = row.bootstrap_lead_user_id || requestedLeadUserId
      activeUser(db, leadUserId)
      assertTeamMember(db, row.team_id, leadUserId)
      const developerId = row.bootstrap_lead_trellis_dev_id || requestedDeveloperId
      resolveDeveloperWorkspace(project.path, developerId)
      const now = new Date().toISOString()
      const target = path.join(projectsRoot, project.workspaceKey)

      const result = withTransaction(db, () => {
        db.prepare(`
          INSERT INTO project_member(
            project_id, user_id, role, trellis_dev_id, created_by, created_at, updated_at
          ) VALUES (?, ?, 'lead', ?, ?, ?, ?)
          ON CONFLICT(project_id, user_id) DO UPDATE SET
            role = 'lead',
            trellis_dev_id = excluded.trellis_dev_id,
            updated_at = excluded.updated_at
        `).run(projectId, leadUserId, developerId, actor.userId, now, now)
        if (activeLeadCount(db, projectId) < 1) {
          throw teamError(409, ERROR_CODES.CONFLICT, '项目必须至少保留一名有效负责人')
        }
        db.prepare(`
          UPDATE repositories
          SET path = ?, path_key = ?, updated_at = ?
          WHERE id = ?
        `).run(
          target.replaceAll('\\', '/'),
          (process.platform === 'win32' ? target.toLowerCase() : target).replaceAll('\\', '/'),
          now,
          projectId,
        )
        db.prepare(`
          UPDATE team_project
          SET trusted_task_toolchain_sha256 = ?, sync_status = 'current',
              last_error = NULL, updated_at = ?
          WHERE repository_id = ?
        `).run(computed.sha256, now, projectId)
        taskIndex.incrementQueryRevision()
        appendAuditEvent(db, {
          actorUserId: actor.userId,
          projectId,
          action: 'project_approved',
          targetType: 'project',
          targetId: projectId,
          detail: {
            toolchainSha256: computed.sha256,
            leadUserId,
            trellisDevId: developerId,
            agentTools: storedAgentTools(row.agent_tools_json),
          },
        })
      })
      const approvedProject = readGitProject(db, projectId)
      let scanWarning = null
      try {
        await taskIndex.scanAndIndexProject(approvedProject, { force: true })
      } catch (error) {
        db.prepare(`
          UPDATE team_project
          SET sync_status = 'needs_repair', last_error = ?, updated_at = ?
          WHERE repository_id = ?
        `).run(
          String(error.message || '首次扫描失败').slice(0, 1000),
          new Date().toISOString(),
          projectId,
        )
        taskIndex.incrementQueryRevision()
        scanWarning = {
          code: ERROR_CODES.PROJECT_REPAIR_REQUIRED,
          message: '项目已启用，但首次索引扫描失败，请执行受控修复',
          details: { projectId },
        }
      }
      const response = {
        project: publicProject(projectRow(db, projectId)),
        result,
      }
      if (scanWarning) response.warning = scanWarning
      return response
    })
  }

  function rebuildIndexInTransaction(projectId) {
    const cached = taskIndex.readProjectScanCache(projectId)
    if (!cached?.board) {
      taskIndex.incrementQueryRevision()
      return
    }
    taskIndex.replaceProjectIndexInTransaction({
      projectId,
      board: cached.board,
      boardVersion: cached.contentKey,
      contentKey: cached.contentKey,
      branchSha: cached.branchSha,
      persistCache: true,
    })
    taskIndex.incrementQueryRevision()
  }

  async function changeCredential(actor, projectId, input = {}) {
    const access = requireProjectManager(actor, projectId)
    return gitManager.withProjectLock(projectId, async () => {
      const row = projectRow(db, projectId)
      if (!row) throw teamError(404, ERROR_CODES.NOT_FOUND, '项目不存在')
      const remote = normalizeGitRemote(row.remote_url, config)
      const credentialId = String(input.credentialId || '').trim() || null
      const credential = credentialId
        ? credentialService.resolveForRemote(actor, {
            teamId: row.team_id,
            credentialId,
            remote,
          })
        : null
      await gitManager.probeRemote({
        actor,
        remote,
        credential,
        branch: row.sync_branch,
      })
      if (credentialId !== row.git_credential_id) {
        const now = new Date().toISOString()
        withTransaction(db, () => {
          db.prepare(`
            UPDATE team_project
            SET git_credential_id = ?, updated_at = ?
            WHERE repository_id = ?
          `).run(credentialId, now, projectId)
          appendAuditEvent(db, {
            actorUserId: actor.userId,
            projectId,
            action: 'project_credential_changed',
            targetType: 'project',
            targetId: projectId,
            detail: {
              fromCredentialId: row.git_credential_id || null,
              toCredentialId: credentialId,
              toCredentialName: credential?.name || null,
              via: access.via,
            },
          })
        })
      }
      return publicProject(projectRow(db, projectId))
    })
  }

  function listMembers(actor, projectId) {
    authorizeProject(actor, projectId, CAPABILITIES.MANAGE_MEMBERS, { db })
    return db
      .prepare(`
      SELECT
        m.user_id, m.role, m.trellis_dev_id, m.created_at, m.updated_at,
        u.username, u.display_name, u.status
      FROM project_member m
      JOIN user_account u ON u.id = m.user_id
      WHERE m.project_id = ?
      ORDER BY
        CASE m.role WHEN 'lead' THEN 0 WHEN 'member' THEN 1 ELSE 2 END,
        u.username_key
    `)
      .all(projectId)
      .map((row) => ({
        userId: row.user_id,
        username: row.username,
        displayName: row.display_name,
        status: row.status,
        role: row.role,
        trellisDevId: row.trellis_dev_id || null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }))
  }

  function listVisibleMembers(actor, projectId) {
    if (actor?.systemAdmin) return listMembers(actor, projectId)
    const access = authorizeProject(actor, projectId, CAPABILITIES.VIEW, { db })
    if (access.role === 'lead' || access.team_manager) return listMembers(actor, projectId)
    return memberCandidateRows(db, [projectId]).map(publicMemberCandidate)
  }

  async function upsertMember(actor, input = {}) {
    const projectId = String(input.projectId || '').trim()
    const access = authorizeProject(actor, projectId, CAPABILITIES.MANAGE_MEMBERS, { db })
    const userId = String(input.userId || '').trim()
    activeUser(db, userId)
    const projectMeta = projectRow(db, projectId)
    assertTeamMember(db, projectMeta.team_id, userId)
    const role = String(input.role || '').trim()
    if (!ROLES.has(role)) throw teamError(400, ERROR_CODES.INVALID_INPUT, '项目角色无效')
    const project = readGitProject(db, projectId)
    const developerId = role === 'read_only' ? null : validateDeveloperId(input.trellisDevId)
    if (developerId) resolveDeveloperWorkspace(project.path, developerId)
    const before = db
      .prepare(`
      SELECT role, trellis_dev_id
      FROM project_member
      WHERE project_id = ? AND user_id = ?
    `)
      .get(projectId, userId)
    const now = new Date().toISOString()
    withTransaction(db, () => {
      if (before?.role === 'lead' && role !== 'lead') {
        assertNotLastLead(db, projectId, userId)
      }
      db.prepare(`
        INSERT INTO project_member(
          project_id, user_id, role, trellis_dev_id, created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, user_id) DO UPDATE SET
          role = excluded.role,
          trellis_dev_id = excluded.trellis_dev_id,
          updated_at = excluded.updated_at
      `).run(projectId, userId, role, developerId, actor.userId, now, now)
      rebuildIndexInTransaction(projectId)
      appendAuditEvent(db, {
        actorUserId: actor.userId,
        projectId,
        action: before ? 'project_member_updated' : 'project_member_added',
        targetType: 'project_member',
        targetId: userId,
        detail: {
          role,
          trellisDevId: developerId,
          via: access.via,
        },
      })
    })
    return listMembers(actor, projectId)
  }

  async function removeMember(actor, input = {}) {
    const projectId = String(input.projectId || '').trim()
    const access = authorizeProject(actor, projectId, CAPABILITIES.MANAGE_MEMBERS, { db })
    const userId = String(input.userId || '').trim()
    const member = db
      .prepare(`
      SELECT role FROM project_member WHERE project_id = ? AND user_id = ?
    `)
      .get(projectId, userId)
    if (!member) throw teamError(404, ERROR_CODES.NOT_FOUND, '项目成员不存在')
    const now = new Date().toISOString()
    withTransaction(db, () => {
      if (member.role === 'lead') assertNotLastLead(db, projectId, userId)
      db.prepare('DELETE FROM project_member WHERE project_id = ? AND user_id = ?').run(
        projectId,
        userId,
      )
      const bindings = db
        .prepare(`
        SELECT b.id
        FROM agent_project_binding b
        JOIN agent_device a ON a.id = b.agent_id
        WHERE b.project_id = ? AND a.user_id = ?
      `)
        .all(projectId, userId)
      bindings.forEach((binding) => {
        db.prepare(`
          UPDATE agent_command
          SET status = 'cancelled', completed_at = ?
          WHERE binding_id = ? AND status IN ('pending', 'delivered')
        `).run(now, binding.id)
        db.prepare('DELETE FROM agent_project_binding WHERE id = ?').run(binding.id)
      })
      rebuildIndexInTransaction(projectId)
      appendAuditEvent(db, {
        actorUserId: actor.userId,
        projectId,
        action: 'project_member_removed',
        targetType: 'project_member',
        targetId: userId,
        detail: { role: member.role, via: access.via },
      })
    })
    return listMembers(actor, projectId)
  }

  async function refreshProject(projectId, { force = false, actor = null } = {}) {
    const access = actor
      ? authorizeProject(actor, projectId, CAPABILITIES.REFRESH_PROJECT, { db })
      : null
    return gitManager.withProjectLock(projectId, async () => {
      let project = readGitProject(db, projectId)
      if (!project || project.syncStatus === 'disabled' || project.syncStatus === 'provisioning') {
        throw teamError(409, ERROR_CODES.PROJECT_NOT_READY, '项目已停用')
      }
      if (project.syncStatus === 'needs_repair') {
        throw teamError(
          409,
          ERROR_CODES.PROJECT_REPAIR_REQUIRED,
          '项目需要管理员修复，普通刷新不能清除该状态',
        )
      }
      try {
        await gitManager.fetchAndFastForward(project)
      } catch (error) {
        const nextStatus =
          error?.code === ERROR_CODES.PROJECT_REPAIR_REQUIRED ? 'needs_repair' : 'stale'
        db.prepare(`
          UPDATE team_project
          SET sync_status = ?, last_error = ?, updated_at = ?
          WHERE repository_id = ?
        `).run(
          nextStatus,
          String(error.message || 'Git 同步失败').slice(0, 1000),
          new Date().toISOString(),
          projectId,
        )
        taskIndex.incrementQueryRevision()
        throw error
      }
      let toolchain
      let branchSha
      let scriptsChanged
      try {
        toolchain = computeScriptTreeHash(project.path)
        branchSha = await gitManager.headSha(project)
        scriptsChanged = toolchain.sha256 !== project.trustedToolchainSha256
      } catch (error) {
        db.prepare(`
          UPDATE team_project
          SET sync_status = 'stale', last_error = ?, updated_at = ?
          WHERE repository_id = ?
        `).run(
          String(error.message || '工具链校验失败').slice(0, 1000),
          new Date().toISOString(),
          projectId,
        )
        taskIndex.incrementQueryRevision()
        throw error
      }
      const now = new Date().toISOString()
      withTransaction(db, () => {
        db.prepare(`
          UPDATE team_project
          SET sync_status = CASE
                WHEN trusted_task_toolchain_sha256 = ? THEN 'current'
                ELSE 'stale'
              END,
              last_fetch_at = ?, last_error = NULL, updated_at = ?
          WHERE repository_id = ?
        `).run(toolchain.sha256, now, now, projectId)
        if (actor) {
          appendAuditEvent(db, {
            actorUserId: actor.userId,
            projectId,
            action: 'project_refreshed',
            targetType: 'project',
            targetId: projectId,
            detail: {
              via: access.via,
              scriptsChanged,
              toolchainSha256: toolchain.sha256,
            },
          })
        }
      })
      project = readGitProject(db, projectId)
      let scan
      try {
        scan = await taskIndex.scanAndIndexProject(project, {
          branchSha,
          force: force || scriptsChanged,
        })
      } catch (error) {
        db.prepare(`
          UPDATE team_project
          SET sync_status = 'stale', last_error = ?, updated_at = ?
          WHERE repository_id = ?
        `).run(
          String(error.message || '项目扫描失败').slice(0, 1000),
          new Date().toISOString(),
          projectId,
        )
        taskIndex.incrementQueryRevision()
        throw error
      }
      return {
        project: publicProject(projectRow(db, projectId)),
        status: scriptsChanged ? 'stale' : 'current',
        boardVersion: scan.boardVersion || scan.contentKey,
        queryRevision: scan.queryRevision || taskIndex.queryRevision(),
      }
    })
  }

  async function refresh(actor, projectId, options = {}) {
    return refreshProject(projectId, { ...options, actor })
  }

  async function refreshScheduled(projectId) {
    return refreshProject(projectId, { actor: null })
  }

  async function disable(actor, input = {}) {
    const projectId = String(input.projectId || '').trim()
    requireProjectManager(actor, projectId)
    return gitManager.withProjectLock(projectId, async () => {
      const project = projectRow(db, projectId)
      if (!project) throw teamError(404, ERROR_CODES.NOT_FOUND, '项目不存在')
      const now = new Date().toISOString()
      withTransaction(db, () => {
        db.prepare(`
          UPDATE team_project
          SET sync_status = 'disabled', updated_at = ?
          WHERE repository_id = ?
        `).run(now, projectId)
        db.prepare(`
          UPDATE agent_command
          SET status = 'cancelled', completed_at = ?
          WHERE binding_id IN (
            SELECT id FROM agent_project_binding WHERE project_id = ?
          ) AND status IN ('pending', 'delivered')
        `).run(now, projectId)
        db.prepare('DELETE FROM agent_project_binding WHERE project_id = ?').run(projectId)
        taskIndex.incrementQueryRevision()
        appendAuditEvent(db, {
          actorUserId: actor.userId,
          projectId,
          action: 'project_disabled',
          targetType: 'project',
          targetId: projectId,
        })
      })
      return publicProject(projectRow(db, projectId))
    })
  }

  async function repair(actor, projectId) {
    requireProjectManager(actor, projectId)
    return gitManager.withProjectLock(projectId, async () => {
      const project = readGitProject(db, projectId)
      if (!project) throw teamError(404, ERROR_CODES.NOT_FOUND, '项目不存在')
      await gitManager.assertProjectBranch(project)
      await gitManager.assertClean(project)
      const toolchain = computeScriptTreeHash(project.path)
      const pending = Number(
        db
          .prepare(`
        SELECT COUNT(*) AS count
        FROM git_operation
        WHERE project_id = ?
          AND status IN ('prepared', 'committed', 'pending_push', 'pushed')
      `)
          .get(projectId).count,
      )
      const nextStatus =
        toolchain.sha256 !== project.trustedToolchainSha256
          ? 'stale'
          : pending
            ? 'pending_push'
            : 'current'
      const now = new Date().toISOString()
      withTransaction(db, () => {
        db.prepare(`
          UPDATE team_project
          SET sync_status = ?, last_error = NULL, updated_at = ?
          WHERE repository_id = ?
        `).run(nextStatus, now, projectId)
        taskIndex.incrementQueryRevision()
        appendAuditEvent(db, {
          actorUserId: actor.userId,
          projectId,
          action: 'project_repaired',
          targetType: 'project',
          targetId: projectId,
          detail: { nextStatus, toolchainSha256: toolchain.sha256 },
        })
      })
      return publicProject(projectRow(db, projectId))
    })
  }

  async function ensureSparse(projectId) {
    return gitManager.withProjectLock(projectId, async () => {
      const project = readGitProject(db, projectId)
      if (!project || ['disabled', 'provisioning'].includes(project.syncStatus)) return false
      try {
        await gitManager.ensureSparseTrellis(project)
        return true
      } catch (error) {
        db.prepare(`
          UPDATE team_project
          SET sync_status = 'needs_repair', last_error = ?, updated_at = ?
          WHERE repository_id = ?
        `).run(
          String(error.message || '转换为 .trellis 稀疏检出失败').slice(0, 1000),
          new Date().toISOString(),
          projectId,
        )
        taskIndex.incrementQueryRevision()
        return false
      }
    })
  }

  return {
    connect,
    probeRemote,
    approve,
    listAll,
    listReadable,
    listStatusReadable,
    listAssociationCandidates,
    listMembers,
    listVisibleMembers,
    upsertMember,
    removeMember,
    refresh,
    refreshScheduled,
    disable,
    repair,
    ensureSparse,
    read,
    changeCredential,
    projectsRoot,
  }
}
