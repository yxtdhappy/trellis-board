import crypto from "node:crypto";

const SENSITIVE_KEY = /(password|token|secret|credential|authorization|cookie|private.?key|passphrase)/i;

function sanitize(value, depth = 0) {
  if (depth > 4) return "[truncated]";
  if (value == null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "string") return value.slice(0, 500);
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitize(item, depth + 1));
  if (typeof value !== "object") return String(value).slice(0, 200);
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) {
      result[key] = "[redacted]";
      continue;
    }
    result[key] = sanitize(item, depth + 1);
  }
  return result;
}

export function appendAuditEvent(db, {
  actorUserId = null,
  actorAgentId = null,
  teamId = null,
  projectId = null,
  action,
  targetType,
  targetId = null,
  result = "success",
  correlationId = crypto.randomUUID(),
  detail = {},
  occurredAt = new Date().toISOString()
}) {
  const resolvedTeamId = teamId || (projectId
    ? db.prepare("SELECT team_id FROM team_project WHERE repository_id = ?")
        .get(projectId)?.team_id || null
    : null);
  const info = db.prepare(`
    INSERT INTO audit_event(
      actor_user_id, actor_agent_id, team_id, project_id, action, target_type,
      target_id, result, correlation_id, detail_json, occurred_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    actorUserId,
    actorAgentId,
    resolvedTeamId,
    projectId,
    String(action).slice(0, 100),
    String(targetType).slice(0, 100),
    targetId == null ? null : String(targetId).slice(0, 300),
    String(result).slice(0, 40),
    String(correlationId).slice(0, 100),
    JSON.stringify(sanitize(detail || {})),
    occurredAt
  );
  return {
    id: Number(info.lastInsertRowid),
    correlationId
  };
}

function auditRow(row) {
  let detail = {};
  try {
    detail = JSON.parse(row.detail_json);
  } catch {
    // 损坏的历史审计详情不影响事件本身。
  }
  return {
    id: Number(row.id),
    actorUserId: row.actor_user_id || null,
    actorAgentId: row.actor_agent_id || null,
    teamId: row.team_id || null,
    projectId: row.project_id || null,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id || null,
    result: row.result,
    correlationId: row.correlation_id,
    detail,
    occurredAt: row.occurred_at
  };
}

export function listAuditEvents(db, {
  teamId = null,
  teamIds = null,
  projectId = null,
  limit = 100,
  beforeId = null
} = {}) {
  const boundedLimit = Math.min(200, Math.max(1, Number(limit) || 100));
  const scopedTeamIds = Array.isArray(teamIds)
    ? [...new Set(teamIds.map((id) => String(id || "").trim()).filter(Boolean))]
    : null;
  const teamFilter = scopedTeamIds == null
    ? "(? IS NULL OR team_id = ?)"
    : scopedTeamIds.length
      ? `team_id IN (${scopedTeamIds.map(() => "?").join(", ")})`
      : "0 = 1";
  const teamParams = scopedTeamIds == null ? [teamId, teamId] : scopedTeamIds;
  return db.prepare(`
    SELECT *
    FROM audit_event
    WHERE ${teamFilter}
      AND (? IS NULL OR project_id = ?)
      AND (? IS NULL OR id < ?)
    ORDER BY occurred_at DESC, id DESC
    LIMIT ?
  `).all(
    ...teamParams,
    projectId,
    projectId,
    beforeId,
    beforeId,
    boundedLimit
  ).map(auditRow);
}
