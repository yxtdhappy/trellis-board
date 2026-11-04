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

export function readProjectAccess(db, projectId, userId) {
  return db.prepare(`
    SELECT
      p.repository_id AS project_id,
      p.sync_status,
      p.sync_branch,
      m.role,
      m.trellis_dev_id
    FROM team_project p
    LEFT JOIN project_member m
      ON m.project_id = p.repository_id AND m.user_id = ?
    WHERE p.repository_id = ?
  `).get(userId, projectId) || null;
}

function denied(message = "无权访问该项目") {
  return teamError(403, ERROR_CODES.FORBIDDEN, message);
}

export function authorizeProject(actor, projectId, capability, { db } = {}) {
  if (!actor?.userId) {
    throw teamError(401, ERROR_CODES.AUTH_REQUIRED, "需要登录");
  }
  if (!db) throw new Error("授权需要数据库连接");
  const access = readProjectAccess(db, projectId, actor.userId);
  if (!access) throw teamError(404, ERROR_CODES.NOT_FOUND, "项目不存在");
  const role = access.role || null;

  if (capability === CAPABILITIES.MANAGE_PROJECT) {
    if (!canManageSystem(actor)) throw denied("只有系统管理员可以管理项目接入");
    return { ...access, role, via: "system_admin" };
  }

  if (capability === CAPABILITIES.MANAGE_MEMBERS || capability === CAPABILITIES.MANAGE_AGENTS) {
    if (canManageSystem(actor)) return { ...access, role, via: "system_admin" };
    if (role === PROJECT_ROLES.LEAD) return { ...access, role, via: "lead" };
    throw denied("只有项目负责人可以执行该操作");
  }

  if (capability === CAPABILITIES.VIEW_AUDIT) {
    if (canManageSystem(actor)) return { ...access, role, via: "system_admin" };
    if (role === PROJECT_ROLES.LEAD) return { ...access, role, via: "lead" };
    throw denied("无权查看项目审计");
  }

  if (!VISIBLE_STATUSES.has(access.sync_status)) {
    throw teamError(
      409,
      ERROR_CODES.PROJECT_NOT_READY,
      "项目尚未启用或已停用"
    );
  }
  if (!role) throw denied();

  if (capability === CAPABILITIES.VIEW) {
    return { ...access, role, via: role };
  }

  if (capability === CAPABILITIES.REFRESH_PROJECT) {
    if (canManageSystem(actor) || role === PROJECT_ROLES.LEAD) {
      return { ...access, role, via: canManageSystem(actor) ? "system_admin" : "lead" };
    }
    throw denied("只有项目负责人或系统管理员可以刷新项目");
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

export function listAuthorizedProjects(actor, { db } = {}) {
  if (!actor?.userId) {
    throw teamError(401, ERROR_CODES.AUTH_REQUIRED, "需要登录");
  }
  return db.prepare(`
    SELECT
      p.repository_id AS id,
      p.sync_status,
      p.sync_branch,
      m.role,
      m.trellis_dev_id
    FROM team_project p
    JOIN project_member m
      ON m.project_id = p.repository_id AND m.user_id = ?
    WHERE p.sync_status IN ('current', 'stale', 'pending_push', 'needs_repair')
    ORDER BY p.repository_id
  `).all(actor.userId);
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
