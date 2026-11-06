import fs from "node:fs";
import path from "node:path";
import { ERROR_CODES, teamError } from "./errors.js";

export const AGENT_EVENT_TYPES = Object.freeze({
  TASK_CREATED: "task.created",
  TASK_ASSIGNED: "task.assigned",
  TASK_UPDATED: "task.updated",
  TASK_CANCELLED: "task.cancelled",
  TASK_SNAPSHOT_REQUIRED: "task.snapshot_required",
  SYNC_REQUIRED: "sync.required",
  COMMAND: "command",
  AGENT_REVOKED: "agent.revoked",
  RESYNC_REQUIRED: "resync.required",
  SERVER_SHUTDOWN: "server.shutdown"
});

export const MAX_EVENT_PAYLOAD_BYTES = 256 * 1024;
export const EVENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const STREAM_HEARTBEAT_MS = 15_000;
const STREAM_RETRY_MS = 3_000;
const STREAM_PAGE_SIZE = 50;
const STREAM_DRAIN_TIMEOUT_MS = 20_000;
const COMMAND_SCAN_MS = 5_000;
const MAX_STREAMS_PER_AGENT = 4;
const TASK_ARTIFACTS = ["prd", "design", "implement"];

function safeParse(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function readArtifact(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_EVENT_PAYLOAD_BYTES) {
      return { text: null, tooLarge: stat.isFile() && stat.size > MAX_EVENT_PAYLOAD_BYTES };
    }
    return { text: fs.readFileSync(filePath, "utf8"), tooLarge: false };
  } catch {
    return { text: null, tooLarge: false };
  }
}

function parseLastEventId(value) {
  if (value == null || value === "") return null;
  const raw = String(value).trim();
  if (!/^\d{1,15}$/.test(raw)) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, "Last-Event-ID 必须是非负整数");
  }
  return Number(raw);
}

function eventFrameData(row) {
  return {
    id: row.id,
    teamId: row.team_id,
    type: row.type,
    projectId: row.project_id || null,
    taskId: row.task_id || null,
    taskVersion: row.task_version || null,
    createdAt: row.created_at,
    payload: safeParse(row.payload_json, {})
  };
}

export function createAgentEventService({
  db,
  logger = console,
  retentionMs = EVENT_RETENTION_MS,
  now = () => new Date()
}) {
  const streams = new Map();
  let commandDelivery = null;
  let commandLister = null;
  let closed = false;
  let commandTimer = null;

  function purgeExpired() {
    const cutoff = now().toISOString();
    db.prepare("DELETE FROM agent_event WHERE expires_at <= ?").run(cutoff);
  }

  function readProject(projectId) {
    return db.prepare(`
      SELECT
        p.repository_id AS id, p.team_id, p.sync_branch,
        r.name, r.path
      FROM team_project p
      JOIN repositories r ON r.id = p.repository_id
      WHERE p.repository_id = ?
    `).get(projectId) || null;
  }

  function projectTargets(projectId, { userIds = null } = {}) {
    const params = [projectId];
    let filter = "";
    if (userIds) {
      const values = [...new Set(userIds.filter(Boolean))];
      if (!values.length) return [];
      filter = ` AND a.user_id IN (${values.map(() => "?").join(", ")})`;
      params.push(...values);
    }
    return db.prepare(`
      SELECT DISTINCT b.agent_id, b.team_id, a.user_id
      FROM agent_project_binding b
      JOIN agent_device a ON a.id = b.agent_id
      WHERE b.project_id = ?
        AND b.sync_status = 'approved'
        AND a.status = 'active'
        ${filter}
    `).all(...params);
  }

  function projectLeadUserIds(projectId) {
    return db.prepare(`
      SELECT user_id
      FROM project_member
      WHERE project_id = ? AND role = 'lead'
    `).all(projectId).map((row) => row.user_id);
  }

  function taskRelations(projectId, executionTaskKey, taskKey) {
    const tags = taskKey
      ? db.prepare(`
          SELECT tag_key FROM team_task_index_tag
          WHERE project_id = ? AND task_key = ?
          ORDER BY tag_key
        `).all(projectId, taskKey).map((row) => row.tag_key)
      : [];
    const blockedBy = db.prepare(`
      SELECT blocker_task_key FROM task_dependency
      WHERE blocked_task_key = ? AND resolved_at IS NULL
      ORDER BY created_at
    `).all(executionTaskKey).map((row) => row.blocker_task_key);
    const blocks = db.prepare(`
      SELECT blocked_task_key FROM task_dependency
      WHERE blocker_task_key = ? AND resolved_at IS NULL
      ORDER BY created_at
    `).all(executionTaskKey).map((row) => row.blocked_task_key);
    return { tags, blockedBy, blocks };
  }

  function buildTaskSnapshot({
    project,
    relativeDir,
    taskKey,
    executionTaskKey,
    taskVersion,
    taskIndexRow = null,
    changedAt = null
  }) {
    const taskKeyValue = taskKey || taskIndexRow?.task_key || null;
    const executionKey = executionTaskKey || taskIndexRow?.execution_task_key || null;
    const version = taskVersion || taskIndexRow?.task_version || null;
    const base = {
      teamId: project.team_id,
      projectId: project.id,
      projectName: project.name,
      taskKey: taskKeyValue,
      executionTaskKey: executionKey,
      relativeDir: relativeDir || taskIndexRow?.relative_dir || null,
      taskVersion: version,
      changedAt: changedAt || now().toISOString(),
      title: taskIndexRow?.title || null,
      description: null,
      status: null,
      priority: taskIndexRow?.priority || null,
      assigneeDevId: taskIndexRow?.assignee_dev_id || null,
      assigneeUserId: taskIndexRow?.assignee_user_id || null,
      tags: [],
      blockedBy: [],
      blocks: [],
      parentTaskKey: null,
      childTaskKeys: [],
      archived: Boolean(taskIndexRow?.archived),
      artifacts: {}
    };
    const dir = base.relativeDir;
    if (!dir) return base;
    const tasksRoot = path.resolve(project.path, ".trellis", "tasks");
    const taskDir = path.resolve(project.path, dir);
    const relative = path.relative(tasksRoot, taskDir);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      return base;
    }
    const taskJson = safeParse(readText(path.join(taskDir, "task.json")) || "", null);
    if (!taskJson) return base;
    const relations = taskRelations(project.id, executionKey, taskKeyValue);
    const artifacts = {};
    let tooLarge = false;
    for (const name of TASK_ARTIFACTS) {
      const artifact = readArtifact(path.join(taskDir, `${name}.md`));
      if (artifact.tooLarge) tooLarge = true;
      if (artifact.text != null) artifacts[name] = artifact.text;
    }
    return {
      ...base,
      title: taskJson.title || base.title,
      description: taskJson.description || null,
      status: taskJson.status || null,
      priority: taskJson.priority || base.priority,
      assigneeDevId: taskJson.assignee || base.assigneeDevId,
      parentTaskKey: taskJson.parent || null,
      childTaskKeys: Array.isArray(taskJson.children) ? taskJson.children : [],
      tags: relations.tags,
      blockedBy: relations.blockedBy,
      blocks: relations.blocks,
      artifacts,
      tooLarge
    };
  }

  function insertEvent({
    teamId,
    type,
    projectId = null,
    targetAgentId = null,
    targetUserId = null,
    taskId = null,
    taskVersion = null,
    dedupeKey,
    payload,
    createdAt = now()
  }) {
    const timestamp = createdAt.toISOString();
    const expiresAt = new Date(createdAt.getTime() + retentionMs).toISOString();
    const scopedKey = `${dedupeKey}:agent:${targetAgentId || "none"}`;
    db.prepare(`
      INSERT OR IGNORE INTO agent_event(
        team_id, project_id, type, target_agent_id, target_user_id,
        task_id, task_version, dedupe_key, payload_json, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      teamId,
      projectId,
      type,
      targetAgentId,
      targetUserId,
      taskId,
      taskVersion,
      scopedKey,
      JSON.stringify(payload),
      timestamp,
      expiresAt
    );
    const row = db.prepare(`
      SELECT * FROM agent_event WHERE team_id = ? AND dedupe_key = ?
    `).get(teamId, scopedKey);
    return row || null;
  }

  function notifyAgent(agentId, teamId) {
    const list = streams.get(agentId);
    if (!list) return;
    for (const stream of list) {
      if (stream.teamId === teamId) drain(stream);
    }
  }

  function publish({
    teamId,
    type,
    projectId = null,
    targetAgentId = null,
    targetUserId = null,
    taskId = null,
    taskVersion = null,
    dedupeKey,
    payload
  }) {
    if (closed || !teamId || !dedupeKey) return null;
    const row = insertEvent({
      teamId,
      type,
      projectId,
      targetAgentId,
      targetUserId,
      taskId,
      taskVersion,
      dedupeKey,
      payload
    });
    if (targetAgentId) notifyAgent(targetAgentId, teamId);
    return row;
  }

  function snapshotRequiredPayload(base, reason) {
    return {
      teamId: base.teamId,
      projectId: base.projectId,
      projectName: base.projectName,
      taskKey: base.taskKey,
      executionTaskKey: base.executionTaskKey,
      relativeDir: base.relativeDir,
      taskVersion: base.taskVersion,
      changedAt: base.changedAt,
      archived: base.archived,
      reason,
      originalType: base.originalType
    };
  }

  function publishTaskEvent({
    eventType,
    projectId,
    relativeDir,
    taskKey = null,
    executionTaskKey = null,
    taskVersion = null,
    taskIndexRow = null,
    assignedUserIds = null,
    dedupeKey = null,
    changedAt = null
  }) {
    if (closed) return [];
    const project = readProject(projectId);
    if (!project) return [];
    let payload = buildTaskSnapshot({
      project,
      relativeDir,
      taskKey,
      executionTaskKey,
      taskVersion,
      taskIndexRow,
      changedAt
    });
    payload.originalType = eventType;
    let type = eventType;
    const snapshotMissing = !payload.relativeDir;
    if (payload.tooLarge || byteLength(payload) > MAX_EVENT_PAYLOAD_BYTES) {
      type = AGENT_EVENT_TYPES.TASK_SNAPSHOT_REQUIRED;
      payload = snapshotRequiredPayload(
        payload,
        payload.tooLarge ? "artifact_too_large" : "payload_too_large"
      );
    } else {
      delete payload.tooLarge;
    }
    if (snapshotMissing && eventType !== AGENT_EVENT_TYPES.TASK_CANCELLED) {
      type = AGENT_EVENT_TYPES.TASK_SNAPSHOT_REQUIRED;
      delete payload.artifacts;
    }
    const targets = eventType === AGENT_EVENT_TYPES.TASK_ASSIGNED
      ? projectTargets(projectId, {
          userIds: [
            ...(assignedUserIds || []),
            ...projectLeadUserIds(projectId)
          ]
        })
      : projectTargets(projectId);
    const key = dedupeKey || `${eventType}:${payload.executionTaskKey}:${payload.taskVersion}`;
    return targets.map((target) => publish({
      teamId: target.team_id,
      type,
      projectId,
      targetAgentId: target.agent_id,
      targetUserId: target.user_id,
      taskId: payload.executionTaskKey,
      taskVersion: payload.taskVersion,
      dedupeKey: key,
      payload
    })).filter(Boolean);
  }

  function publishSyncRequired({ projectId, dedupeKey, reason = "task_pushed", commitSha = null }) {
    const project = readProject(projectId);
    if (!project) return [];
    return projectTargets(projectId).map((target) => publish({
      teamId: target.team_id,
      type: AGENT_EVENT_TYPES.SYNC_REQUIRED,
      projectId,
      targetAgentId: target.agent_id,
      targetUserId: target.user_id,
      dedupeKey: dedupeKey || `sync.required:${projectId}:${now().toISOString()}`,
      payload: {
        teamId: target.team_id,
        projectId,
        branchName: project.sync_branch,
        commitSha,
        reason
      }
    })).filter(Boolean);
  }

  function publishAgentRevoked(agentId, teamId = null) {
    if (closed) return [];
    const teams = teamId
      ? [teamId]
      : db.prepare(`
          SELECT DISTINCT team_id FROM agent_project_binding WHERE agent_id = ?
        `).all(agentId).map((row) => row.team_id);
    const rows = teams.map((teamId) => publish({
      teamId,
      type: AGENT_EVENT_TYPES.AGENT_REVOKED,
      targetAgentId: agentId,
      dedupeKey: `agent.revoked:${agentId}:${now().toISOString()}`,
      payload: { teamId, agentId, reason: "device_revoked" }
    })).filter(Boolean);
    for (const row of rows) {
      const list = streams.get(agentId);
      if (!list) continue;
      for (const stream of list) {
        if (stream.teamId === row.team_id) drain(stream);
      }
    }
    return rows;
  }

  function resolveTeam(agent, requestedTeamId) {
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
    if (!first) {
      throw teamError(403, ERROR_CODES.FORBIDDEN, "Agent 账号没有可用团队");
    }
    return first.id;
  }

  function assertTeamBinding(agent, teamId) {
    const binding = db.prepare(`
      SELECT 1
      FROM agent_project_binding b
      JOIN team_project p ON p.repository_id = b.project_id
      WHERE b.agent_id = ? AND b.team_id = ?
        AND b.sync_status <> 'revoked'
        AND p.team_id = b.team_id
      LIMIT 1
    `).get(agent.id, teamId);
    if (!binding) {
      throw teamError(403, ERROR_CODES.FORBIDDEN, "Agent 在该团队没有可用项目绑定");
    }
  }

  function readCursor(agentId, teamId) {
    const row = db.prepare(`
      SELECT last_event_id FROM agent_event_cursor
      WHERE agent_id = ? AND team_id = ?
    `).get(agentId, teamId);
    return Number(row?.last_event_id || 0);
  }

  function writeCursor(agentId, teamId, lastEventId) {
    db.prepare(`
      INSERT INTO agent_event_cursor(agent_id, team_id, last_event_id, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(agent_id, team_id) DO UPDATE SET
        last_event_id = MAX(agent_event_cursor.last_event_id, excluded.last_event_id),
        updated_at = excluded.updated_at
    `).run(agentId, teamId, lastEventId, now().toISOString());
  }

  function historyBounds(teamId, agentId) {
    const row = db.prepare(`
      SELECT MIN(id) AS min_id, MAX(id) AS max_id
      FROM agent_event
      WHERE team_id = ? AND target_agent_id = ? AND expires_at > ?
    `).get(teamId, agentId, now().toISOString());
    return {
      minId: row?.min_id == null ? null : Number(row.min_id),
      maxId: row?.max_id == null ? null : Number(row.max_id)
    };
  }

  function nextEvents(stream) {
    return db.prepare(`
      SELECT *
      FROM agent_event
      WHERE team_id = ? AND target_agent_id = ? AND id > ? AND expires_at > ?
      ORDER BY id
      LIMIT ?
    `).all(
      stream.teamId,
      stream.agentId,
      stream.cursor,
      now().toISOString(),
      STREAM_PAGE_SIZE
    );
  }

  function writeFrame(stream, { id = null, event = null, data = null, comment = null }) {
    if (stream.closed || stream.response.destroyed) return false;
    const text = comment != null
      ? `: ${comment}\n\n`
      : `${id == null ? "" : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    try {
      return stream.response.write(text);
    } catch {
      endStream(stream);
      return false;
    }
  }

  function endStream(stream) {
    if (stream.closed) return;
    stream.closed = true;
    clearInterval(stream.heartbeat);
    clearTimeout(stream.drainTimer);
    const list = streams.get(stream.agentId);
    if (list) {
      list.delete(stream);
      if (!list.size) streams.delete(stream.agentId);
    }
    try {
      stream.response.end();
    } catch {
      stream.response.destroy();
    }
  }

  function waitForDrain(stream) {
    if (stream.closed || stream.drainTimer) return;
    stream.drainTimer = setTimeout(() => {
      if (!stream.closed) endStream(stream);
    }, STREAM_DRAIN_TIMEOUT_MS);
    stream.drainTimer.unref?.();
    stream.response.once("drain", () => {
      clearTimeout(stream.drainTimer);
      stream.drainTimer = null;
      drain(stream);
    });
  }

  function drain(stream) {
    if (closed || stream.closed || stream.busy || stream.drainTimer) return;
    stream.busy = true;
    try {
      for (;;) {
        const rows = nextEvents(stream);
        if (!rows.length) break;
        for (const row of rows) {
          if (closed || stream.closed) return;
          let data = eventFrameData(row);
          if (row.type === AGENT_EVENT_TYPES.COMMAND && commandDelivery) {
            const command = commandDelivery(stream.agentId, data.payload.commandId);
            if (!command) {
              stream.cursor = row.id;
              writeCursor(stream.agentId, stream.teamId, row.id);
              continue;
            }
            data = { ...data, payload: { ...data.payload, command } };
          }
          const flushed = writeFrame(stream, {
            id: row.id,
            event: row.type,
            data
          });
          stream.cursor = row.id;
          writeCursor(stream.agentId, stream.teamId, row.id);
          if (
            row.type === AGENT_EVENT_TYPES.AGENT_REVOKED ||
            row.type === AGENT_EVENT_TYPES.SERVER_SHUTDOWN
          ) {
            endStream(stream);
            return;
          }
          if (!flushed) {
            waitForDrain(stream);
            return;
          }
        }
      }
    } finally {
      stream.busy = false;
    }
  }

  function openStream({ agent, teamId: requestedTeamId, lastEventId, response }) {
    if (closed) {
      throw teamError(503, ERROR_CODES.SERVICE_SHUTTING_DOWN, "服务正在关闭");
    }
    const teamId = resolveTeam(agent, requestedTeamId);
    assertTeamBinding(agent, teamId);
    const requested = parseLastEventId(lastEventId);
    const active = streams.get(agent.id);
    if (active && active.size >= MAX_STREAMS_PER_AGENT) {
      throw teamError(
        429,
        ERROR_CODES.RATE_LIMITED,
        "同一 Agent 的事件连接过多，请关闭旧连接后重试",
        { details: { retryAfterMs: 5_000 } }
      );
    }
    purgeExpired();
    let start = requested == null ? readCursor(agent.id, teamId) : requested;
    const bounds = historyBounds(teamId, agent.id);
    let resyncReason = null;
    if (bounds.maxId != null && start > bounds.maxId) {
      resyncReason = "unknown_cursor";
    } else if (start > 0 && bounds.minId != null && start + 1 < bounds.minId) {
      resyncReason = "cursor_expired";
    }
    if (resyncReason) {
      const row = publish({
        teamId,
        type: AGENT_EVENT_TYPES.RESYNC_REQUIRED,
        targetAgentId: agent.id,
        targetUserId: agent.userId,
        dedupeKey: `resync.required:${agent.id}:${start}:${now().toISOString()}`,
        payload: {
          teamId,
          requestedLastEventId: start,
          reason: resyncReason
        }
      });
      start = row ? row.id - 1 : start;
    }
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      "connection": "keep-alive",
      "x-accel-buffering": "no",
      "x-content-type-options": "nosniff"
    });
    response.flushHeaders?.();
    const stream = {
      agentId: agent.id,
      teamId,
      response,
      cursor: start,
      closed: false,
      busy: false,
      drainTimer: null,
      heartbeat: null
    };
    response.write(`retry: ${STREAM_RETRY_MS}\n\n`);
    const list = streams.get(agent.id) || new Set();
    list.add(stream);
    streams.set(agent.id, list);
    stream.heartbeat = setInterval(() => {
      if (stream.closed || stream.busy || stream.drainTimer) return;
      if (!writeFrame(stream, { comment: "heartbeat" })) waitForDrain(stream);
    }, STREAM_HEARTBEAT_MS);
    stream.heartbeat.unref?.();
    response.on("close", () => endStream(stream));
    response.on("error", () => endStream(stream));
    syncPendingCommands(agent.id, teamId);
    drain(stream);
    return { teamId, lastEventId: stream.cursor };
  }

  function syncPendingCommands(agentId, teamId) {
    if (closed || !commandLister) return;
    let commands = [];
    try {
      commands = commandLister(agentId, teamId);
    } catch (error) {
      logger.warn("扫描待投递 Agent 命令失败", {
        agentId,
        error: error instanceof Error ? error.message : String(error)
      });
      return;
    }
    for (const command of commands) {
      publish({
        teamId,
        type: AGENT_EVENT_TYPES.COMMAND,
        projectId: command.projectId || null,
        targetAgentId: agentId,
        targetUserId: command.userId || null,
        dedupeKey: `command:${command.commandId}:${command.attempts}`,
        payload: {
          commandId: command.commandId,
          commandType: command.type,
          bindingId: command.bindingId,
          projectId: command.projectId,
          branchName: command.branchName,
          reason: "pending"
        }
      });
    }
    notifyAgent(agentId, teamId);
  }

  function scanPendingCommands() {
    if (closed || !commandLister) return;
    const pairs = new Map();
    for (const list of streams.values()) {
      for (const stream of list) {
        pairs.set(`${stream.agentId}::${stream.teamId}`, {
          agentId: stream.agentId,
          teamId: stream.teamId
        });
      }
    }
    for (const pair of pairs.values()) {
      syncPendingCommands(pair.agentId, pair.teamId);
    }
  }

  function startCommandScan() {
    if (!commandTimer && commandLister) {
      commandTimer = setInterval(scanPendingCommands, COMMAND_SCAN_MS);
      commandTimer.unref?.();
    }
  }

  async function close() {
    if (closed) return;
    closed = true;
    if (commandTimer) clearInterval(commandTimer);
    commandTimer = null;
    const shutdownAt = now().toISOString();
    for (const list of [...streams.values()]) {
      for (const stream of [...list]) {
        writeFrame(stream, {
          event: AGENT_EVENT_TYPES.SERVER_SHUTDOWN,
          data: { type: AGENT_EVENT_TYPES.SERVER_SHUTDOWN, at: shutdownAt }
        });
        endStream(stream);
      }
    }
    streams.clear();
  }

  return {
    setCommandDelivery(fn) {
      commandDelivery = fn;
    },
    setCommandLister(fn) {
      commandLister = fn;
      startCommandScan();
    },
    publish,
    publishTaskEvent,
    publishSyncRequired,
    publishAgentRevoked,
    syncPendingCommands,
    scanPendingCommands,
    openStream,
    readCursor,
    writeCursor,
    purgeExpired,
    close,
    streamCount(agentId) {
      return streams.get(agentId)?.size || 0;
    }
  };
}
