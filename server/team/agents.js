import crypto from "node:crypto";
import { withTransaction } from "../database.js";
import { appendAuditEvent } from "./audit.js";
import { ERROR_CODES, teamError } from "./errors.js";
import { CAPABILITIES, authorizeProject } from "./permissions.js";
import {
  semanticLocalPathIdentityHash,
  semanticRemoteIdentityHash
} from "./remote-identity.js";

export const AGENT_PROTOCOL_VERSION = 1;
const PAIRING_TTL_MS = 10 * 60 * 1000;
const COMMAND_LEASE_MS = 5 * 60 * 1000;
const MAX_FAILURES = 3;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SEMVER = /^\d+\.\d+\.\d+$/;
const LOCAL_REPO_KEY = /^[a-f0-9]{64}$/;
const ALLOWED_COMMANDS = new Set(["sync_branch", "refresh_status"]);

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function text(value, label, { min = 1, max = 200 } = {}) {
  if (typeof value !== "string") {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, `${label}格式无效`);
  }
  const result = value.trim();
  if (Array.from(result).length < min || Array.from(result).length > max) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, `${label}长度无效`);
  }
  return result;
}

function safeId(value, label) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, `${label}格式无效`);
  }
  return value;
}

function protocolVersion(value) {
  if (Number(value) !== AGENT_PROTOCOL_VERSION) {
    throw teamError(
      426,
      ERROR_CODES.AGENT_PROTOCOL_UNSUPPORTED,
      "Agent 协议版本不兼容，请升级 Agent",
      { details: { protocolVersion: AGENT_PROTOCOL_VERSION } }
    );
  }
  return AGENT_PROTOCOL_VERSION;
}

function agentVersion(value) {
  const version = String(value || "").trim();
  if (!SEMVER.test(version)) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, "Agent 版本格式无效");
  }
  return version.slice(0, 32);
}

function deviceName(value) {
  return text(value, "设备名称", { max: 80 });
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
    revokedAt: row.revoked_at || null
  };
}

function publicBinding(row) {
  return {
    id: row.id,
    agentId: row.agent_id,
    teamId: row.team_id || null,
    projectId: row.project_id,
    localRepoKey: row.local_repo_key,
    displayName: row.local_display_name || null,
    branchName: row.branch_name,
    status: row.sync_status,
    lastSyncedAt: row.last_synced_at || null,
    lastError: row.last_error || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    agentStatus: row.agent_status || null,
    deviceName: row.device_name || null,
    lastSeenAt: row.last_seen_at || null
  };
}

function safeCommandResult(value) {
  let encoded;
  try {
    encoded = JSON.stringify(value ?? {});
  } catch {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, "命令结果不是合法 JSON");
  }
  if (Buffer.byteLength(encoded, "utf8") > 16 * 1024) {
    throw teamError(413, ERROR_CODES.BODY_TOO_LARGE, "命令结果过大");
  }
  if (
    /(?:[A-Za-z]:[\\/]|\\\\[^\\\s]+\\|file:\/\/)/i.test(encoded)
  ) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, "命令结果不能包含本地路径");
  }
  return value ?? {};
}

function commandErrorParts(value) {
  if (value == null) return { code: null, message: null };
  if (typeof value === "string") {
    return { code: null, message: value.slice(0, 1000) };
  }
  if (typeof value === "object") {
    const code = value.code == null
      ? null
      : String(value.code).slice(0, 100);
    const message = value.message == null
      ? null
      : String(value.message).slice(0, 1000);
    return {
      code,
      message: message || code || "Agent 命令执行失败"
    };
  }
  return { code: null, message: String(value).slice(0, 1000) };
}

function projectRemoteIdentityHash(remoteUrl, config) {
  const remote = String(remoteUrl || "").trim();
  if (
    /^[A-Za-z]:[\\/]/.test(remote) ||
    remote.startsWith("/") ||
    remote.startsWith("\\\\")
  ) {
    return semanticLocalPathIdentityHash(
      remote.replaceAll("\\", "/")
    );
  }
  return semanticRemoteIdentityHash(remote, {
    allowFileRemote: Boolean(config.allowLocalGitRemotes)
  });
}

export function createAgentService({
  db,
  config,
  events = null
}) {
  const pairAttempts = new Map();

  function consumePairAttempt(ip) {
    const key = String(ip || "unknown").slice(0, 128);
    const now = Date.now();
    const recent = (pairAttempts.get(key) || []).filter((at) => now - at < 60 * 60 * 1000);
    if (recent.length >= 30) {
      throw teamError(429, ERROR_CODES.RATE_LIMITED, "配对尝试过多，请稍后再试");
    }
    recent.push(now);
    pairAttempts.set(key, recent);
  }

  function pairingTeamId(actor, requestedTeamId) {
    if (!actor?.userId) {
      throw teamError(401, ERROR_CODES.AUTH_REQUIRED, "需要登录");
    }
    const requested = String(requestedTeamId || "").trim();
    if (actor.activeTeamId) {
      if (requested && requested !== actor.activeTeamId) {
        throw teamError(403, ERROR_CODES.FORBIDDEN, "不能为其他团队创建配对码");
      }
      return actor.activeTeamId;
    }
    if (actor.systemAdmin) {
      const team = requested
        ? db.prepare("SELECT id FROM team WHERE id = ? AND status = 'active'").get(requested)
        : db.prepare("SELECT id FROM team WHERE status = 'active' ORDER BY name LIMIT 1").get();
      if (!team) throw teamError(409, ERROR_CODES.CONFLICT, "系统还没有可用团队");
      return team.id;
    }
    throw teamError(403, ERROR_CODES.FORBIDDEN, "请先切换到目标团队");
  }

  function createPairingCode(actor, input = {}) {
    const teamId = pairingTeamId(actor, input.teamId);
    const code = randomToken(32);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + PAIRING_TTL_MS).toISOString();
    withTransaction(db, () => {
      db.prepare(`
        UPDATE agent_pairing_code
        SET used_at = ?
        WHERE user_id = ? AND team_id = ? AND used_at IS NULL
      `).run(now.toISOString(), actor.userId, teamId);
      db.prepare(`
        INSERT INTO agent_pairing_code(id, user_id, team_id, code_hash, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        crypto.randomUUID(),
        actor.userId,
        teamId,
        sha256(code),
        expiresAt,
        now.toISOString()
      );
      appendAuditEvent(db, {
        actorUserId: actor.userId,
        teamId,
        action: "agent_pairing_code_created",
        targetType: "agent_pairing_code",
        detail: { expiresAt }
      });
    });
    return {
      pairingCode: code,
      expiresAt,
      teamId,
      protocolVersion: AGENT_PROTOCOL_VERSION
    };
  }

  function enroll(input = {}, { ip = "" } = {}) {
    consumePairAttempt(ip);
    protocolVersion(input.protocolVersion);
    const version = agentVersion(input.agentVersion);
    const platform = text(input.platform, "平台", { max: 32 });
    if (!/^[A-Za-z0-9._-]+$/.test(platform)) {
      throw teamError(400, ERROR_CODES.INVALID_INPUT, "平台格式无效");
    }
    const name = deviceName(input.deviceName);
    const pairingCode = text(input.pairingCode, "配对码", { min: 16, max: 512 });
    const now = new Date().toISOString();
    const pairing = db.prepare(`
      SELECT *
      FROM agent_pairing_code
      WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?
    `).get(sha256(pairingCode), now);
    if (!pairing) {
      throw teamError(401, ERROR_CODES.AUTH_FAILED, "配对码无效、已使用或已过期");
    }
    const membership = db.prepare(`
      SELECT 1
      FROM team_member m
      JOIN team t ON t.id = m.team_id
      WHERE m.team_id = ? AND m.user_id = ? AND t.status = 'active'
    `).get(pairing.team_id, pairing.user_id);
    if (!membership) {
      throw teamError(401, ERROR_CODES.AUTH_FAILED, "配对码无效、已使用或已过期");
    }
    const credential = randomToken(32);
    const agentId = crypto.randomUUID();
    withTransaction(db, () => {
      const consumed = db.prepare(`
        UPDATE agent_pairing_code
        SET used_at = ?
        WHERE id = ? AND used_at IS NULL AND expires_at > ?
      `).run(now, pairing.id, now);
      if (consumed.changes !== 1) {
        throw teamError(401, ERROR_CODES.AUTH_FAILED, "配对码无效、已使用或已过期");
      }
      db.prepare(`
        INSERT INTO agent_device(
          id, user_id, device_name, platform, agent_version, protocol_version,
          credential_hash, status, last_seen_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
      `).run(
        agentId,
        pairing.user_id,
        name,
        platform,
        version,
        AGENT_PROTOCOL_VERSION,
        sha256(credential),
        now,
        now
      );
      appendAuditEvent(db, {
        actorUserId: pairing.user_id,
        actorAgentId: agentId,
        teamId: pairing.team_id,
        action: "agent_enrolled",
        targetType: "agent",
        targetId: agentId,
        detail: { deviceName: name, platform, agentVersion: version }
      });
    });
    return {
      agentId,
      credential,
      protocolVersion: AGENT_PROTOCOL_VERSION
    };
  }

  function authenticate(request) {
    const authorization = String(request?.headers?.authorization || "");
    const match = /^Bearer ([A-Za-z0-9._~+/-]+={0,2})$/.exec(authorization);
    if (!match || match[1].length < 32 || match[1].length > 512) {
      throw teamError(401, ERROR_CODES.AGENT_AUTH_REQUIRED, "Agent 凭证无效或已撤销");
    }
    const row = db.prepare(`
      SELECT a.*, u.status AS user_status
      FROM agent_device a
      JOIN user_account u ON u.id = a.user_id
      WHERE a.credential_hash = ?
        AND a.status = 'active'
        AND u.status = 'active'
    `).get(sha256(match[1]));
    if (!row) {
      throw teamError(401, ERROR_CODES.AGENT_AUTH_REQUIRED, "Agent 凭证无效或已撤销");
    }
    return {
      ...publicAgent(row),
      userId: row.user_id,
      lastSeenAt: row.last_seen_at
    };
  }

  function assertAgentIdentity(agent, input) {
    const agentId = safeId(input.agentId || input.deviceId, "Agent ID");
    if (agentId !== agent.id) {
      throw teamError(403, ERROR_CODES.FORBIDDEN, "Agent 身份不匹配");
    }
  }

  function bindingError(message, code) {
    return { errorCode: code, error: message };
  }

  function upsertHeartbeatBinding(agent, value) {
    if (!value || typeof value !== "object") return null;
    const projectId = safeId(value.projectId, "项目 ID");
    const localRepoKey = String(value.localRepoKey || "");
    if (!LOCAL_REPO_KEY.test(localRepoKey)) {
      throw teamError(400, ERROR_CODES.INVALID_INPUT, "本地仓库标识格式无效");
    }
    const branchName = text(value.branchName, "同步分支", { max: 255 });
    const project = db.prepare(`
      SELECT
        p.*, r.name AS project_name,
        m.role, tm.role AS team_role
      FROM team_project p
      JOIN repositories r ON r.id = p.repository_id
      JOIN team t ON t.id = p.team_id
      JOIN team_member tm
        ON tm.team_id = p.team_id AND tm.user_id = ?
      LEFT JOIN project_member m
        ON m.project_id = p.repository_id AND m.user_id = ?
      WHERE p.repository_id = ? AND t.status = 'active'
    `).get(agent.userId, agent.userId, projectId);
    let existing = db.prepare(`
      SELECT *
      FROM agent_project_binding
      WHERE agent_id = ? AND project_id = ?
    `).get(agent.id, projectId);
    if (!existing && value.serverBindingId) {
      const candidate = db.prepare(`
        SELECT *
        FROM agent_project_binding
        WHERE id = ? AND agent_id = ?
      `).get(String(value.serverBindingId), agent.id);
      if (candidate?.project_id === projectId) existing = candidate;
    }
    if (!project || !project.role || !project.team_role) {
      const error = bindingError("当前账号无权绑定该项目", "PROJECT_FORBIDDEN");
      return existing
        ? { ...publicBinding({ ...existing, ...error }), ...error }
        : {
            id: localRepoKey,
            projectId,
            localRepoKey,
            branchName,
            status: "rejected",
            ...error
          };
    }
    if (!new Set(["current", "stale", "pending_push", "needs_repair"]).has(project.sync_status)) {
      const error = bindingError("项目尚未启用或已停用", "PROJECT_NOT_READY");
      return {
        id: existing?.id || localRepoKey,
        projectId,
        localRepoKey,
        branchName,
        status: "rejected",
        ...error
      };
    }
    if (branchName !== project.sync_branch) {
      const error = bindingError("本地分支与项目同步分支不一致", "BINDING_BRANCH_MISMATCH");
      if (existing) {
        db.prepare(`
          UPDATE agent_project_binding
          SET last_error = ?, updated_at = ?
          WHERE id = ?
        `).run(error.error, new Date().toISOString(), existing.id);
        return { ...publicBinding(existing), ...error };
      }
      return {
        id: localRepoKey,
        projectId,
        localRepoKey,
        branchName,
        status: "rejected",
        ...error
      };
    }
    const remoteKey = String(value.remoteIdentityKey || "");
    if (remoteKey) {
      let expectedRemoteKey = null;
      try {
        expectedRemoteKey = projectRemoteIdentityHash(project.remote_url, config);
      } catch {
        expectedRemoteKey = null;
      }
      if (
        !LOCAL_REPO_KEY.test(remoteKey) ||
        !expectedRemoteKey ||
        remoteKey !== expectedRemoteKey
      ) {
        const error = bindingError("本地仓库远端与项目不一致", "REMOTE_MISMATCH");
        if (existing) {
          db.prepare(`
            UPDATE agent_project_binding
            SET last_error = ?, updated_at = ?
            WHERE id = ?
          `).run(error.error, new Date().toISOString(), existing.id);
          return { ...publicBinding(existing), ...error };
        }
        return {
          id: localRepoKey,
          projectId,
          localRepoKey,
          branchName,
          status: "rejected",
          ...error
        };
      }
      if (project.remote_identity_hash !== expectedRemoteKey) {
        db.prepare(`
          UPDATE team_project
          SET remote_identity_hash = ?, updated_at = ?
          WHERE repository_id = ?
        `).run(expectedRemoteKey, new Date().toISOString(), projectId);
      }
    }
    const now = new Date().toISOString();
    const displayName = String(value.displayName || project.project_name || "本地仓库")
      .trim()
      .slice(0, 120);
    if (!existing) {
      const id = crypto.randomUUID();
      db.prepare(`
        INSERT INTO agent_project_binding(
          id, agent_id, team_id, project_id, local_repo_key, local_display_name,
          branch_name, sync_status, last_error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?)
      `).run(
        id,
        agent.id,
        project.team_id,
        projectId,
        localRepoKey,
        displayName,
        branchName,
        now,
        now
      );
      existing = db.prepare("SELECT * FROM agent_project_binding WHERE id = ?").get(id);
      appendAuditEvent(db, {
        actorAgentId: agent.id,
        projectId,
        action: "agent_binding_requested",
        targetType: "agent_binding",
        targetId: id,
        detail: { deviceName: agent.deviceName, branchName }
      });
    } else {
      db.prepare(`
        UPDATE agent_project_binding
        SET local_repo_key = ?, local_display_name = ?, branch_name = ?,
            last_error = NULL, updated_at = ?
        WHERE id = ?
      `).run(localRepoKey, displayName, branchName, now, existing.id);
      existing = db.prepare("SELECT * FROM agent_project_binding WHERE id = ?").get(existing.id);
    }
    const errorCode = value.errorCode || value.lastErrorCode || null;
    const errorMessage = value.error || value.lastError || null;
    if (errorCode || errorMessage) {
      db.prepare(`
        UPDATE agent_project_binding
        SET last_error = ?, updated_at = ?
        WHERE id = ?
      `).run(
        String(errorMessage || errorCode).slice(0, 500),
        now,
        existing.id
      );
      existing.last_error = String(errorMessage || errorCode).slice(0, 500);
    }
    return publicBinding(db.prepare(`
      SELECT b.*, a.status AS agent_status, a.device_name, a.last_seen_at
      FROM agent_project_binding b
      JOIN agent_device a ON a.id = b.agent_id
      WHERE b.id = ?
    `).get(existing.id));
  }

  function heartbeat(agent, input = {}) {
    protocolVersion(input.protocolVersion);
    assertAgentIdentity(agent, input);
    const version = agentVersion(input.agentVersion);
    const name = deviceName(input.deviceName || agent.deviceName);
    const bindings = Array.isArray(input.bindings) ? input.bindings.slice(0, 64) : [];
    const responses = [];
    const update = () => {
      db.prepare(`
        UPDATE agent_device
        SET device_name = ?, agent_version = ?, protocol_version = ?,
            last_seen_at = ?, last_heartbeat_json = ?
        WHERE id = ?
      `).run(
        name,
        version,
        AGENT_PROTOCOL_VERSION,
        new Date().toISOString(),
        JSON.stringify({ bindings: bindings.length }).slice(0, 2000),
        agent.id
      );
      for (const binding of bindings) {
        const row = upsertHeartbeatBinding(agent, binding);
        if (row) responses.push(row);
      }
    };
    if (bindings.length) withTransaction(db, update);
    else update();
    return {
      protocolVersion: AGENT_PROTOCOL_VERSION,
      compatible: true,
      bindings: responses.map((row) => ({
        id: row.id,
        bindingId: row.id,
        projectId: row.projectId,
        localRepoKey: row.localRepoKey,
        status: row.status,
        errorCode: row.errorCode || null,
        error: row.error || null,
        branchName: row.branchName
      }))
    };
  }

  function listProjectBindings(actor, projectId) {
    authorizeProject(actor, projectId, CAPABILITIES.MANAGE_AGENTS, { db });
    return db.prepare(`
      SELECT
        b.*, a.status AS agent_status, a.device_name, a.last_seen_at,
        u.id AS owner_user_id, u.username AS owner_username,
        u.display_name AS owner_display_name
      FROM agent_project_binding b
      JOIN agent_device a ON a.id = b.agent_id
      JOIN user_account u ON u.id = a.user_id
      WHERE b.project_id = ?
      ORDER BY b.created_at DESC
    `).all(projectId).map((row) => ({
      ...publicBinding(row),
      ownerUserId: row.owner_user_id,
      ownerUsername: row.owner_username,
      ownerDisplayName: row.owner_display_name
    }));
  }

  function requireBinding(actor, projectId, bindingId) {
    authorizeProject(actor, projectId, CAPABILITIES.MANAGE_AGENTS, { db });
    const binding = db.prepare(`
      SELECT b.*, a.user_id, a.status AS agent_status
      FROM agent_project_binding b
      JOIN agent_device a ON a.id = b.agent_id
      WHERE b.id = ? AND b.project_id = ?
    `).get(bindingId, projectId);
    if (!binding) throw teamError(404, ERROR_CODES.NOT_FOUND, "Agent 绑定不存在");
    const member = db.prepare(`
      SELECT role
      FROM project_member
      WHERE project_id = ? AND user_id = ?
    `).get(projectId, binding.user_id);
    if (!member) {
      throw teamError(409, ERROR_CODES.CONFLICT, "绑定用户已不属于该项目");
    }
    if (binding.agent_status !== "active") {
      throw teamError(409, ERROR_CODES.CONFLICT, "Agent 设备已撤销");
    }
    return binding;
  }

  function queueCommand(binding, type, payload = {}) {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const result = db.prepare(`
      INSERT OR IGNORE INTO agent_command(
        id, agent_id, binding_id, command_type, payload_json, status,
        attempts, created_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?)
    `).run(
      id,
      binding.agent_id,
      binding.id,
      type,
      JSON.stringify({
        protocolVersion: AGENT_PROTOCOL_VERSION,
        projectId: binding.project_id,
        branchName: binding.branch_name,
        ...payload
      }),
      now
    );
    return result.changes ? id : null;
  }

  function setBindingStatus(actor, projectId, bindingId, status) {
    const binding = requireBinding(actor, projectId, bindingId);
    if (binding.sync_status === "revoked" && status !== "revoked") {
      throw teamError(409, ERROR_CODES.CONFLICT, "已撤销的 Agent 绑定不能恢复");
    }
    const now = new Date().toISOString();
    let commandId = null;
    withTransaction(db, () => {
      db.prepare(`
        UPDATE agent_project_binding
        SET sync_status = ?, last_error = NULL, updated_at = ?
        WHERE id = ?
      `).run(status, now, binding.id);
      if (status !== "approved") {
        db.prepare(`
          UPDATE agent_command
          SET status = 'cancelled', completed_at = ?
          WHERE binding_id = ? AND status IN ('pending', 'delivered')
        `).run(now, binding.id);
      } else {
        commandId = queueCommand(binding, "sync_branch");
      }
      appendAuditEvent(db, {
        actorUserId: actor.userId,
        projectId,
        action: `agent_binding_${status}`,
        targetType: "agent_binding",
        targetId: binding.id,
        detail: { ownerUserId: binding.user_id, commandQueued: Boolean(commandId) }
      });
    });
    if (commandId && events) {
      events.syncPendingCommands(binding.agent_id, binding.team_id);
    }
    return {
      binding: listProjectBindings(actor, projectId)
        .find((item) => item.id === binding.id),
      commandQueued: Boolean(commandId)
    };
  }

  function approveBinding(actor, projectId, bindingId) {
    return setBindingStatus(actor, projectId, bindingId, "approved");
  }

  function rejectBinding(actor, projectId, bindingId) {
    return setBindingStatus(actor, projectId, bindingId, "rejected");
  }

  function revokeBinding(actor, projectId, bindingId) {
    return setBindingStatus(actor, projectId, bindingId, "revoked");
  }

  function listDevices(actor) {
    const scoped = actor?.systemAdmin && !actor.activeTeamId
      ? db.prepare(`
          SELECT a.*, u.username, u.display_name
          FROM agent_device a
          JOIN user_account u ON u.id = a.user_id
          ORDER BY a.created_at DESC
        `).all()
      : actor?.activeTeamId
        ? db.prepare(`
            SELECT DISTINCT a.*, u.username, u.display_name
            FROM agent_device a
            JOIN user_account u ON u.id = a.user_id
            JOIN agent_project_binding b ON b.agent_id = a.id
            WHERE b.team_id = ? AND b.sync_status <> 'revoked'
            ORDER BY a.created_at DESC
          `).all(actor.activeTeamId)
        : [];
    if (!actor?.systemAdmin && actor?.teamRole !== "admin") {
      throw teamError(403, ERROR_CODES.FORBIDDEN, "只有团队管理员可以查看 Agent");
    }
    return scoped.map((row) => ({
      ...publicAgent(row),
      username: row.username,
      displayName: row.display_name
    }));
  }

  function revokeDevice(actor, agentId) {
    if (!actor?.systemAdmin && actor?.teamRole !== "admin") {
      throw teamError(403, ERROR_CODES.FORBIDDEN, "只有团队管理员可以撤销 Agent");
    }
    const device = db.prepare("SELECT * FROM agent_device WHERE id = ?").get(agentId);
    if (!device) throw teamError(404, ERROR_CODES.NOT_FOUND, "Agent 不存在");
    if (!actor.systemAdmin && !actor.activeTeamId) {
      throw teamError(403, ERROR_CODES.FORBIDDEN, "当前账号没有可用的活动团队");
    }
    const teamId = actor.activeTeamId || null;
    let bindingIds = null;
    if (teamId) {
      bindingIds = db.prepare(`
        SELECT id FROM agent_project_binding
        WHERE agent_id = ? AND team_id = ? AND sync_status <> 'revoked'
      `).all(agentId, teamId).map((row) => row.id);
      if (!bindingIds.length) {
        throw teamError(404, ERROR_CODES.NOT_FOUND, "Agent 不存在");
      }
    }
    const now = new Date().toISOString();
    withTransaction(db, () => {
      if (bindingIds) {
        const placeholders = bindingIds.map(() => "?").join(", ");
        db.prepare(`
          UPDATE agent_project_binding
          SET sync_status = 'revoked', updated_at = ?
          WHERE id IN (${placeholders})
        `).run(now, ...bindingIds);
        db.prepare(`
          UPDATE agent_command
          SET status = 'cancelled', completed_at = ?
          WHERE binding_id IN (${placeholders}) AND status IN ('pending', 'delivered')
        `).run(now, ...bindingIds);
        const remaining = db.prepare(`
          SELECT COUNT(*) AS count FROM agent_project_binding
          WHERE agent_id = ? AND sync_status <> 'revoked'
        `).get(agentId).count;
        if (remaining === 0) {
          db.prepare(`
            UPDATE agent_device
            SET status = 'revoked', revoked_at = ?
            WHERE id = ?
          `).run(now, agentId);
        }
      } else {
        db.prepare(`
          UPDATE agent_device
          SET status = 'revoked', revoked_at = ?
          WHERE id = ?
        `).run(now, agentId);
        db.prepare(`
          UPDATE agent_project_binding
          SET sync_status = 'revoked', updated_at = ?
          WHERE agent_id = ?
        `).run(now, agentId);
        db.prepare(`
          UPDATE agent_command
          SET status = 'cancelled', completed_at = ?
          WHERE agent_id = ? AND status IN ('pending', 'delivered')
        `).run(now, agentId);
      }
      appendAuditEvent(db, {
        actorUserId: actor.userId,
        actorAgentId: agentId,
        teamId,
        action: "agent_revoked",
        targetType: "agent",
        targetId: agentId,
        detail: { scope: teamId ? "team" : "global" }
      });
    });
    events?.publishAgentRevoked(agentId, teamId);
    return { revoked: true, agentId };
  }

  function recoverExpiredLeases(agentId) {
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE agent_command
      SET status = 'failed',
          completed_at = ?,
          result_json = ?
      WHERE agent_id = ?
        AND status = 'delivered'
        AND lease_expires_at <= ?
        AND attempts >= ?
    `).run(
      now,
      JSON.stringify({ status: "failed", error: "命令连续投递失败" }),
      agentId,
      now,
      MAX_FAILURES
    );
    db.prepare(`
      UPDATE agent_command
      SET status = 'pending', delivered_at = NULL, lease_expires_at = NULL
      WHERE agent_id = ?
        AND status = 'delivered'
        AND lease_expires_at <= ?
        AND attempts < ?
    `).run(agentId, now, MAX_FAILURES);
  }

  const deliverableCommandSql = `
    SELECT c.*, b.project_id, b.branch_name, b.team_id, a.user_id
    FROM agent_command c
    JOIN agent_project_binding b ON b.id = c.binding_id
    JOIN agent_device a ON a.id = c.agent_id
    JOIN team_project p ON p.repository_id = b.project_id
    WHERE c.agent_id = ?
      AND c.status = 'pending'
      AND b.sync_status = 'approved'
      AND p.sync_status IN ('current', 'stale', 'pending_push', 'needs_repair')
  `;

  function listPendingCommands(agentId, teamId) {
    recoverExpiredLeases(agentId);
    return db.prepare(`${deliverableCommandSql}
      AND b.team_id = ?
      ORDER BY c.created_at, c.id
      LIMIT 50
    `).all(agentId, teamId).map((row) => ({
      commandId: row.id,
      type: row.command_type,
      bindingId: row.binding_id,
      attempts: Number(row.attempts),
      projectId: row.project_id,
      branchName: row.branch_name,
      userId: row.user_id
    }));
  }

  function beginCommandDelivery(agentId, commandId) {
    recoverExpiredLeases(agentId);
    const row = db.prepare(`${deliverableCommandSql}
      AND c.id = ?
      LIMIT 1
    `).get(agentId, String(commandId || ""));
    if (!row) return null;
    if (!ALLOWED_COMMANDS.has(row.command_type)) {
      throw teamError(500, "INTERNAL_ERROR", "Agent 命令类型无效");
    }
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + COMMAND_LEASE_MS).toISOString();
    const delivered = db.prepare(`
      UPDATE agent_command
      SET status = 'delivered',
          attempts = attempts + 1,
          delivered_at = ?,
          lease_expires_at = ?
      WHERE id = ? AND agent_id = ? AND status = 'pending'
    `).run(now.toISOString(), leaseExpiresAt, row.id, agentId);
    if (delivered.changes !== 1) return null;
    let payload;
    try {
      payload = JSON.parse(row.payload_json);
    } catch {
      payload = {};
    }
    return {
      id: row.id,
      bindingId: row.binding_id,
      type: row.command_type,
      payload
    };
  }

  function submitCommandResult(agent, commandId, input = {}) {
    protocolVersion(input.protocolVersion);
    agentVersion(input.agentVersion);
    safeId(commandId, "命令 ID");
    const status = input.status;
    if (!new Set(["succeeded", "failed"]).has(status)) {
      throw teamError(400, ERROR_CODES.INVALID_INPUT, "命令结果状态无效");
    }
    const command = db.prepare(`
      SELECT c.*, b.team_id AS binding_team_id, b.project_id AS binding_project_id
      FROM agent_command c
      LEFT JOIN agent_project_binding b ON b.id = c.binding_id
      WHERE c.id = ? AND c.agent_id = ?
    `).get(commandId, agent.id);
    if (!command) throw teamError(404, ERROR_CODES.NOT_FOUND, "命令不存在");
    if (["completed", "failed", "cancelled"].includes(command.status)) {
      return {
        commandId,
        status: command.status,
        idempotent: true
      };
    }
    const result = safeCommandResult(input.result);
    const commandError = commandErrorParts(input.error);
    const error = commandError.message;
    const now = new Date().toISOString();
    const nextStatus = status === "succeeded"
      ? "completed"
      : command.attempts >= MAX_FAILURES ? "failed" : "pending";
    withTransaction(db, () => {
      db.prepare(`
        UPDATE agent_command
        SET status = ?, completed_at = ?, delivered_at = NULL,
            lease_expires_at = NULL, result_json = ?
        WHERE id = ?
      `).run(
        nextStatus,
        nextStatus === "pending" ? null : now,
        JSON.stringify({
          status,
          result,
          error,
          errorCode: commandError.code,
          submittedAt: now
        }).slice(0, 20_000),
        commandId
      );
      if (nextStatus === "completed" && command.command_type === "sync_branch") {
        db.prepare(`
          UPDATE agent_project_binding
          SET sync_status = 'approved',
              last_synced_at = ?,
              last_error = NULL,
              updated_at = ?
          WHERE id = ?
        `).run(now, now, command.binding_id);
      }
      if (nextStatus === "failed") {
        db.prepare(`
          UPDATE agent_project_binding
          SET last_error = ?, updated_at = ?
          WHERE id = ?
        `).run(error || "命令连续执行失败", now, command.binding_id);
      }
      appendAuditEvent(db, {
        actorAgentId: agent.id,
        teamId: command.binding_team_id || null,
        projectId: command.binding_project_id || null,
        action: `agent_command_${status}`,
        targetType: "agent_command",
        targetId: commandId,
        result: status === "succeeded" ? "success" : "failed",
        detail: { commandType: command.command_type, attempts: command.attempts }
      });
    });
    if (nextStatus === "pending") {
      events?.syncPendingCommands(agent.id, command.binding_team_id);
    }
    return {
      commandId,
      status: nextStatus,
      idempotent: false
    };
  }

  function eventCursorTeam(agent, requestedTeamId, { required = true } = {}) {
    const requested = String(requestedTeamId || "").trim();
    if (requested) {
      const membership = db.prepare(`
        SELECT t.id
        FROM team_member m
        JOIN team t ON t.id = m.team_id
        WHERE m.team_id = ? AND m.user_id = ? AND t.status = 'active'
      `).get(requested, agent.userId);
      if (!membership) {
        throw teamError(403, ERROR_CODES.FORBIDDEN, "Agent 账号不属于该团队");
      }
      return requested;
    }
    const first = db.prepare(`
      SELECT t.id
      FROM team_member m
      JOIN team t ON t.id = m.team_id
      WHERE m.user_id = ? AND t.status = 'active'
      ORDER BY t.name COLLATE NOCASE, t.id
      LIMIT 1
    `).get(agent.userId);
    if (!first && required) {
      throw teamError(403, ERROR_CODES.FORBIDDEN, "Agent 账号没有可用团队");
    }
    return first?.id || null;
  }

  function readEventCursor(agent, input = {}) {
    const teamId = eventCursorTeam(agent, input.teamId);
    const row = db.prepare(`
      SELECT last_event_id, updated_at
      FROM agent_event_cursor
      WHERE agent_id = ? AND team_id = ?
    `).get(agent.id, teamId);
    return {
      teamId,
      lastEventId: Number(row?.last_event_id || 0),
      updatedAt: row?.updated_at || null
    };
  }

  function writeEventCursor(agent, input = {}) {
    const teamId = eventCursorTeam(agent, input.teamId);
    const lastEventId = Number(input.lastEventId);
    if (!Number.isInteger(lastEventId) || lastEventId < 0) {
      throw teamError(400, ERROR_CODES.INVALID_INPUT, "lastEventId 必须是非负整数");
    }
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO agent_event_cursor(agent_id, team_id, last_event_id, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(agent_id, team_id) DO UPDATE SET
        last_event_id = MAX(agent_event_cursor.last_event_id, excluded.last_event_id),
        updated_at = excluded.updated_at
    `).run(agent.id, teamId, lastEventId, now);
    return { teamId, lastEventId, updatedAt: now };
  }

  async function close() {
    // 事件连接由 agentEventService.close() 统一关闭。
  }

  return {
    createPairingCode,
    enroll,
    authenticate,
    heartbeat,
    listProjectBindings,
    approveBinding,
    rejectBinding,
    revokeBinding,
    listDevices,
    revokeDevice,
    readEventCursor,
    writeEventCursor,
    listPendingCommands,
    beginCommandDelivery,
    submitCommandResult,
    close
  };
}
