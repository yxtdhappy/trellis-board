import { ERROR_CODES, teamError } from "./errors.js";

export const PROJECT_ROLES = Object.freeze({
  LEAD: "lead",
  MEMBER: "member",
  READ_ONLY: "read_only"
});

export const CAPABILITIES = Object.freeze({
  VIEW: "view",
  WRITE_TASK: "write_task",
  ACCEPT_TASK: "accept_task",
  MANAGE_MEMBERS: "manage_members",
  MANAGE_AGENTS: "manage_agents",
  VIEW_AUDIT: "view_audit",
  MANAGE_PROJECT: "manage_project",
  REFRESH_PROJECT: "refresh_project"
});

const VISIBLE_STATUSES = new Set(["current", "stale", "pending_push", "needs_repair"]);
const WRITABLE_ROLES = new Set([PROJECT_ROLES.LEAD, PROJECT_ROLES.MEMBER]);

export function canManageSystem(actor) {
  return Boolean(actor?.systemAdmin);
}

export function roleCanWrite(role) {
  return WRITABLE_ROLES.has(role);
}

export function isTeamManager(actor, teamId) {
  if (actor?.systemAdmin) return true;
  return Boolean(
    actor?.userId &&
    actor.teamRole === "admin" &&
    actor.activeTeamId &&
    actor.activeTeamId === teamId
  );
}

function projectRow(db, projectId) {
  return db.prepare(`
    SELECT
      p.repository_id AS project_id,
      p.team_id,
      p.sync_status,
      p.sync_branch,
      t.status AS team_status,
      t.name AS team_name
    FROM team_project p
    JOIN team t ON t.id = p.team_id
    WHERE p.repository_id = ?
  `).get(projectId) || null;
}

function memberRole(db, projectId, userId) {
  return db.prepare(`
    SELECT role, trellis_dev_id
    FROM project_member
    WHERE project_id = ? AND user_id = ?
  `).get(projectId, userId) || null;
}

export function readProjectAccess(db, projectId, actor) {
  const row = projectRow(db, projectId);
  if (!row) return null;
  const member = actor?.userId ? memberRole(db, projectId, actor.userId) : null;
  return {
    ...row,
    role: member?.role || null,
    trellis_dev_id: member?.trellis_dev_id || null,
    team_manager: isTeamManager(actor, row.team_id)
  };
}

function findProjectAccess(db, projectId, actor) {
  const access = readProjectAccess(db, projectId, actor);
  if (!access) throw teamError(404, ERROR_CODES.NOT_FOUND, "项目不存在");
  if (!actor.systemAdmin) {
    if (
      access.team_status !== "active" ||
      !actor.activeTeamId ||
      access.team_id !== actor.activeTeamId ||
      !actor.teamRole
    ) {
      // 不泄露其他团队的项目是否存在。
      throw teamError(404, ERROR_CODES.NOT_FOUND, "项目不存在");
    }
  }
  return access;
}

function denied(message = "无权访问该项目") {
  return teamError(403, ERROR_CODES.FORBIDDEN, message);
}

export function authorizeProject(actor, projectId, capability, { db } = {}) {
  if (!actor?.userId) {
    throw teamError(401, ERROR_CODES.AUTH_REQUIRED, "需要登录");
  }
  if (!db) throw new Error("授权需要数据库连接");
  const access = findProjectAccess(db, projectId, actor);
  const role = access.role;
  const teamManager = access.team_manager;

  if (capability === CAPABILITIES.MANAGE_PROJECT) {
    if (!teamManager) throw denied("只有系统管理员或团队管理员可以管理项目接入");
    return { ...access, via: actor.systemAdmin ? "system_admin" : "team_admin" };
  }

  if (capability === CAPABILITIES.MANAGE_MEMBERS || capability === CAPABILITIES.MANAGE_AGENTS) {
    if (teamManager) {
      return { ...access, via: actor.systemAdmin ? "system_admin" : "team_admin" };
    }
    if (role === PROJECT_ROLES.LEAD) return { ...access, via: "lead" };
    throw denied("只有项目负责人或团队管理员可以执行该操作");
  }

  if (capability === CAPABILITIES.VIEW_AUDIT) {
    if (teamManager) {
      return { ...access, via: actor.systemAdmin ? "system_admin" : "team_admin" };
    }
    if (role === PROJECT_ROLES.LEAD) return { ...access, via: "lead" };
    throw denied("无权查看项目审计");
  }

  if (!VISIBLE_STATUSES.has(access.sync_status)) {
    throw teamError(
      409,
      ERROR_CODES.PROJECT_NOT_READY,
      "项目尚未启用或已停用"
    );
  }
  if (actor.systemAdmin && !role) {
    return { ...access, role: "system_admin", via: "system_admin" };
  }
  if (!role && !teamManager) throw denied();

  if (capability === CAPABILITIES.VIEW) {
    return {
      ...access,
      role: role || "team_admin",
      via: teamManager ? (actor.systemAdmin ? "system_admin" : "team_admin") : role
    };
  }

  if (capability === CAPABILITIES.REFRESH_PROJECT) {
    if (teamManager || role === PROJECT_ROLES.LEAD) {
      return {
        ...access,
        role: role || "team_admin",
        via: actor.systemAdmin ? "system_admin" : teamManager ? "team_admin" : "lead"
      };
    }
    throw denied("只有项目负责人、团队管理员或系统管理员可以刷新项目");
  }

  if (capability === CAPABILITIES.WRITE_TASK || capability === CAPABILITIES.ACCEPT_TASK) {
    if (!roleCanWrite(role)) throw denied("只读成员不能修改任务");
    if (access.sync_status !== "current") {
      throw teamError(
        409,
        ERROR_CODES.PROJECT_NOT_READY,
        "项目当前不可写，请先完成同步或修复"
      );
    }
    return { ...access, role, via: role };
  }

  throw new Error(`未知项目能力: ${capability}`);
}

function publicAccessRow(row) {
  return {
    id: row.repository_id,
    teamId: row.team_id,
    sync_status: row.sync_status,
    syncStatus: row.sync_status,
    sync_branch: row.sync_branch,
    syncBranch: row.sync_branch,
    role: row.role,
    trellis_dev_id: row.trellis_dev_id,
    trellisDevId: row.trellis_dev_id,
    via: row.via
  };
}

export function listAuthorizedProjects(actor, { db } = {}) {
  if (!actor?.userId) {
    throw teamError(401, ERROR_CODES.AUTH_REQUIRED, "需要登录");
  }
  const visible = "p.sync_status IN ('current', 'stale', 'pending_push', 'needs_repair')";
  let rows;
  if (actor.systemAdmin) {
    if (actor.activeTeamId) {
      rows = db.prepare(`
        SELECT
          p.repository_id, p.team_id, p.sync_status, p.sync_branch,
          m.role, m.trellis_dev_id
        FROM team_project p
        JOIN team t ON t.id = p.team_id
        LEFT JOIN project_member m
          ON m.project_id = p.repository_id AND m.user_id = ?
        WHERE ${visible} AND p.team_id = ? AND t.status = 'active'
        ORDER BY p.repository_id
      `).all(actor.userId, actor.activeTeamId);
    } else {
      rows = db.prepare(`
        SELECT
          p.repository_id, p.team_id, p.sync_status, p.sync_branch,
          m.role, m.trellis_dev_id
        FROM team_project p
        JOIN team t ON t.id = p.team_id
        LEFT JOIN project_member m
          ON m.project_id = p.repository_id AND m.user_id = ?
        WHERE ${visible} AND t.status = 'active'
        ORDER BY p.repository_id
      `).all(actor.userId);
    }
    return rows.map((row) => publicAccessRow({ ...row, via: "system_admin" }));
  }
  if (!actor.activeTeamId || !actor.teamRole) return [];
  if (actor.teamRole === "admin") {
    rows = db.prepare(`
      SELECT
        p.repository_id, p.team_id, p.sync_status, p.sync_branch,
        m.role, m.trellis_dev_id
      FROM team_project p
      JOIN team t ON t.id = p.team_id
      LEFT JOIN project_member m
        ON m.project_id = p.repository_id AND m.user_id = ?
      WHERE ${visible} AND p.team_id = ? AND t.status = 'active'
      ORDER BY p.repository_id
    `).all(actor.userId, actor.activeTeamId);
    return rows.map((row) => publicAccessRow({ ...row, via: "team_admin" }));
  }
  rows = db.prepare(`
    SELECT
      p.repository_id, p.team_id, p.sync_status, p.sync_branch,
      m.role, m.trellis_dev_id
    FROM team_project p
    JOIN team t ON t.id = p.team_id
    JOIN project_member m
      ON m.project_id = p.repository_id AND m.user_id = ?
    WHERE ${visible} AND p.team_id = ? AND t.status = 'active'
    ORDER BY p.repository_id
  `).all(actor.userId, actor.activeTeamId);
  return rows.map((row) => publicAccessRow({ ...row, via: row.role }));
}

export function readableProjectIds(actor, { db } = {}) {
  return listAuthorizedProjects(actor, { db }).map((item) => item.id);
}

export function projectIdFromExecutionTaskKey(executionTaskKey) {
  const value = String(executionTaskKey || "");
  const separator = value.indexOf("::");
  return separator > 0 ? value.slice(0, separator) : null;
}

export function authorizeExecutionTask(actor, executionTaskKey, capability, options) {
  const projectId = projectIdFromExecutionTaskKey(executionTaskKey);
  if (!projectId) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, "任务执行身份无效");
  }
  return authorizeProject(actor, projectId, capability, options);
}
