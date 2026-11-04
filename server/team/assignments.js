import crypto from "node:crypto";
import { withTransaction } from "../database.js";
import { appendAuditEvent } from "./audit.js";
import { ERROR_CODES, teamError } from "./errors.js";
import { CAPABILITIES, authorizeExecutionTask } from "./permissions.js";

function assignmentRow(row) {
  if (!row) return null;
  return {
    executionTaskKey: row.execution_task_key,
    projectId: row.project_id,
    assignedUserId: row.assigned_user_id,
    state: row.state,
    assignedBy: row.assigned_by,
    assignedAt: row.assigned_at,
    acceptedAt: row.accepted_at || null,
    baseTaskVersion: row.base_task_version || null,
    version: Number(row.version)
  };
}

export function readAssignment(db, executionTaskKey) {
  return assignmentRow(db.prepare(`
    SELECT *
    FROM task_assignment
    WHERE execution_task_key = ?
  `).get(executionTaskKey));
}

export function setPendingAssignmentInTransaction(db, {
  projectId,
  executionTaskKey,
  assignedUserId,
  assignedBy,
  baseTaskVersion = null
}) {
  const now = new Date().toISOString();
  const existing = readAssignment(db, executionTaskKey);
  db.prepare(`
    INSERT INTO task_assignment(
      execution_task_key, project_id, assigned_user_id, state,
      assigned_by, assigned_at, accepted_at, base_task_version, version
    ) VALUES (?, ?, ?, 'pending', ?, ?, NULL, ?, ?)
    ON CONFLICT(execution_task_key) DO UPDATE SET
      project_id = excluded.project_id,
      assigned_user_id = excluded.assigned_user_id,
      state = 'pending',
      assigned_by = excluded.assigned_by,
      assigned_at = excluded.assigned_at,
      accepted_at = NULL,
      base_task_version = excluded.base_task_version,
      version = excluded.version
  `).run(
    executionTaskKey,
    projectId,
    assignedUserId,
    assignedBy,
    now,
    baseTaskVersion,
    existing ? existing.version + 1 : 1
  );
  return readAssignment(db, executionTaskKey);
}

export function syncAssignmentsFromBoardInTransaction(db, projectId, board) {
  const users = new Map(db.prepare(`
    SELECT m.trellis_dev_id, m.user_id
    FROM project_member m
    JOIN user_account u ON u.id = m.user_id
    WHERE m.project_id = ?
      AND m.role IN ('lead', 'member')
      AND u.status = 'active'
  `).all(projectId).map((row) => [
    String(row.trellis_dev_id).toLowerCase(),
    row.user_id
  ]));
  const tasks = new Map(
    (board.tasks || [])
      .filter((task) => task.executionTaskKey)
      .map((task) => [task.executionTaskKey, task])
  );
  const existing = db.prepare(`
    SELECT *
    FROM task_assignment
    WHERE project_id = ?
  `).all(projectId).map(assignmentRow);
  const existingKeys = new Set(
    existing.map((assignment) => assignment.executionTaskKey)
  );
  for (const assignment of existing) {
    const task = tasks.get(assignment.executionTaskKey);
    if (!task) {
      db.prepare("DELETE FROM task_assignment WHERE execution_task_key = ?")
        .run(assignment.executionTaskKey);
      continue;
    }
    const userId = task.assignee
      ? users.get(String(task.assignee).toLowerCase()) || null
      : null;
    if (!userId) {
      db.prepare("DELETE FROM task_assignment WHERE execution_task_key = ?")
        .run(assignment.executionTaskKey);
      continue;
    }
    if (userId === assignment.assignedUserId) continue;
    db.prepare(`
      UPDATE task_assignment
      SET assigned_user_id = ?, state = 'pending', assigned_at = ?,
          accepted_at = NULL, base_task_version = ?, version = version + 1
      WHERE execution_task_key = ?
    `).run(
      userId,
      new Date().toISOString(),
      task.taskVersion || assignment.baseTaskVersion,
      assignment.executionTaskKey
    );
  }
  // 远端直接修改 task.json 新增或更换负责人时，也必须在索引刷新内初始化待接受状态。
  for (const task of tasks.values()) {
    if (existingKeys.has(task.executionTaskKey) || !task.assignee) continue;
    const userId = users.get(String(task.assignee).toLowerCase()) || null;
    if (!userId) continue;
    const now = new Date().toISOString();
    db.prepare(`
      INSERT OR IGNORE INTO task_assignment(
        execution_task_key, project_id, assigned_user_id, state,
        assigned_by, assigned_at, accepted_at, base_task_version, version
      ) VALUES (?, ?, ?, 'pending', ?, ?, NULL, ?, 1)
    `).run(
      task.executionTaskKey,
      projectId,
      userId,
      userId,
      now,
      task.taskVersion || null
    );
  }
}

function queueSyncCommandsInTransaction(db, userId, projectId) {
  const now = new Date().toISOString();
  const bindings = db.prepare(`
    SELECT b.id, b.agent_id
    FROM agent_project_binding b
    JOIN agent_device a ON a.id = b.agent_id
    WHERE b.project_id = ? AND a.user_id = ? AND a.status = 'active'
  `).all(projectId, userId);
  const insert = db.prepare(`
    INSERT OR IGNORE INTO agent_command(
      id, agent_id, binding_id, command_type, payload_json, status,
      attempts, created_at
    ) VALUES (?, ?, ?, 'sync_branch', ?, 'pending', 0, ?)
  `);
  bindings.forEach((binding) => {
    insert.run(
      crypto.randomUUID(),
      binding.agent_id,
      binding.id,
      JSON.stringify({ protocolVersion: 1 }),
      now
    );
  });
  return bindings.length;
}

export function acceptAssignment(db, actor, input = {}) {
  const executionTaskKey = String(input.executionTaskKey || "").trim();
  const expectedVersion = Number(input.assignmentVersion);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, "assignmentVersion 无效");
  }
  const access = authorizeExecutionTask(
    actor,
    executionTaskKey,
    CAPABILITIES.ACCEPT_TASK,
    { db }
  );
  const assignment = readAssignment(db, executionTaskKey);
  if (!assignment || assignment.projectId !== access.project_id) {
    throw teamError(404, ERROR_CODES.NOT_FOUND, "任务尚未委派");
  }
  if (assignment.assignedUserId !== actor.userId) {
    throw teamError(403, ERROR_CODES.FORBIDDEN, "只有当前负责人可以接受任务");
  }
  if (assignment.version !== expectedVersion) {
    throw teamError(
      409,
      ERROR_CODES.VERSION_CONFLICT,
      "任务委派版本已变化，请刷新后重试"
    );
  }
  if (assignment.state === "accepted") {
    return { assignment, idempotent: true, queuedBindings: 0 };
  }
  const now = new Date().toISOString();
  let queuedBindings = 0;
  withTransaction(db, () => {
    const result = db.prepare(`
      UPDATE task_assignment
      SET state = 'accepted', accepted_at = ?
      WHERE execution_task_key = ?
        AND assigned_user_id = ?
        AND state = 'pending'
        AND version = ?
    `).run(now, executionTaskKey, actor.userId, expectedVersion);
    if (result.changes !== 1) {
      throw teamError(
        409,
        ERROR_CODES.VERSION_CONFLICT,
        "任务委派状态已变化，请刷新后重试"
      );
    }
    queuedBindings = queueSyncCommandsInTransaction(
      db,
      actor.userId,
      assignment.projectId
    );
    appendAuditEvent(db, {
      actorUserId: actor.userId,
      projectId: assignment.projectId,
      action: "task_assignment_accepted",
      targetType: "task",
      targetId: executionTaskKey,
      detail: {
        assignmentVersion: assignment.version,
        queuedBindings
      }
    });
  });
  return {
    assignment: readAssignment(db, executionTaskKey),
    idempotent: false,
    queuedBindings
  };
}
