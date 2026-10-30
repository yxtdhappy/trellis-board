import crypto from "node:crypto";
import { withTransaction } from "./database.js";
import {
  appendTaskEvent,
  readExecutionEvents
} from "./execution-store.js";

const SUPPORTED_REVERSIBLE_TYPES = new Set([
  "task_plan_updated",
  "stage_manual_confirmed",
  "dependency_created",
  "dependency_resolved"
]);

function timestamp(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeEvents(events) {
  return [...events].sort((left, right) =>
    timestamp(left.occurredAt) - timestamp(right.occurredAt) ||
    Number(left.id || 0) - Number(right.id || 0)
  );
}

function planFromPayload(value) {
  return {
    dueDate: value?.dueDate ?? null,
    milestone: value?.milestone || "",
    tags: Array.isArray(value?.tags) ? value.tags : []
  };
}

function readPlanState(db, executionTaskKey) {
  const row = db.prepare(`
    SELECT due_date, milestone, created_at, updated_at
    FROM task_execution
    WHERE execution_task_key = ?
  `).get(executionTaskKey) || null;
  const tags = db.prepare(`
    SELECT tag
    FROM task_tag
    WHERE execution_task_key = ?
    ORDER BY rowid
  `).all(executionTaskKey).map((item) => item.tag);
  return {
    dueDate: row?.due_date ?? null,
    milestone: row?.milestone || "",
    tags,
    createdAt: row?.created_at || null,
    updatedAt: row?.updated_at || null
  };
}

function samePlan(left, right) {
  return left.dueDate === right.dueDate &&
    left.milestone === right.milestone &&
    left.tags.length === right.tags.length &&
    left.tags.every((tag, index) => tag === right.tags[index]);
}

function groupEvents(events) {
  const undone = new Set();
  events.forEach((event) => {
    if (event.type !== "operation_undone") return;
    const target = String(event.payload?.targetCorrelationId || "").trim();
    if (target) undone.add(target);
  });

  const groups = new Map();
  events
    .filter((event) => event.reversible)
    .forEach((event) => {
      const correlationId = String(event.correlationId || "").trim();
      if (!correlationId) return;
      if (!groups.has(correlationId)) {
        groups.set(correlationId, {
          correlationId,
          events: []
        });
      }
      groups.get(correlationId).events.push(event);
    });

  return [...groups.values()]
    .map((group) => {
      const ordered = normalizeEvents(group.events);
      const latest = ordered.at(-1);
      return {
        ...group,
        events: ordered,
        eventType: ordered.every((event) => event.type === ordered[0].type)
          ? ordered[0].type
          : "mixed",
        occurredAt: latest?.occurredAt || null,
        latestEventId: Number(latest?.id || 0),
        undone: undone.has(group.correlationId)
      };
    })
    .sort((left, right) =>
      timestamp(right.occurredAt) - timestamp(left.occurredAt) ||
      right.latestEventId - left.latestEventId
    );
}

function undoLabel(group) {
  if (!group) return null;
  const target = group.events.at(-1);
  const payload = target?.payload || {};
  if (group.eventType === "task_plan_updated") return "撤销最近一次计划字段修改";
  if (group.eventType === "stage_manual_confirmed") {
    return `撤销人工阶段确认${payload.after?.stage ? `（${payload.after.stage}）` : ""}`;
  }
  if (group.eventType === "dependency_created") return "撤销最近一次新增阻断依赖";
  if (group.eventType === "dependency_resolved") return "撤销最近一次解除阻断依赖";
  return "撤销最近一次可逆操作";
}

function undoMetadata({
  events,
  eventTotal = events.length,
  eventTruncated = false,
  archived = false,
  identityValid = true
}) {
  const availableGroups = groupEvents(events).filter((group) => !group.undone);
  const latest = availableGroups[0] || null;
  let disabledReason = null;
  if (!identityValid) {
    disabledReason = "任务执行身份冲突，无法安全撤销";
  } else if (archived) {
    disabledReason = "归档任务只读，不能撤销";
  } else if (eventTruncated && !latest) {
    // 最近窗口里没有候选组时，无法确认更早的可逆操作是否仍是最新未撤销组。
    disabledReason = "事件窗口已截断，无法确认更早的可逆操作是否可撤销";
  } else if (!latest) {
    disabledReason = events.length
      ? "没有尚未撤销的可逆操作"
      : "尚无事件，没有可撤销操作";
  } else if (!SUPPORTED_REVERSIBLE_TYPES.has(latest.eventType)) {
    disabledReason = "最近一次可逆操作暂不支持撤销";
  }
  return {
    available: !disabledReason,
    targetCorrelationId: latest?.correlationId || null,
    targetEventIds: latest?.events.map((event) => Number(event.id)) || [],
    eventType: latest?.eventType || null,
    occurredAt: latest?.occurredAt || null,
    label: undoLabel(latest),
    disabledReason,
    eventWindow: {
      total: eventTotal,
      truncated: Boolean(eventTruncated)
    }
  };
}

export function buildTaskHistory({
  db,
  executionTaskKey,
  events = null,
  eventTotal = null,
  eventLimit = null,
  eventTruncated = false,
  eventWindowStartAt = null,
  archived = false,
  identityValid = true,
  limit = 1000
}) {
  const timeline = events
    ? {
        events,
        eventTotal: eventTotal ?? events.length,
        eventLimit: eventLimit ?? Math.min(1000, Math.max(1, Number(limit) || 1000)),
        eventTruncated,
        eventWindowStartAt: eventWindowStartAt ?? events.at(-1)?.occurredAt ?? null
      }
    : readExecutionEvents(db, executionTaskKey, limit);
  return {
    events: timeline.events,
    eventTotal: timeline.eventTotal,
    eventLimit: timeline.eventLimit,
    truncated: Boolean(timeline.eventTruncated),
    windowStartAt: timeline.eventWindowStartAt,
    undo: undoMetadata({
      events: timeline.events,
      eventTotal: timeline.eventTotal,
      eventTruncated: timeline.eventTruncated || Boolean(timeline.truncated),
      archived,
      identityValid
    })
  };
}

function readDependency(db, dependencyId) {
  return db.prepare(`
    SELECT
      id, blocker_task_key, blocked_task_key, reason, created_by,
      created_at, resolved_at
    FROM task_dependency
    WHERE id = ?
  `).get(dependencyId) || null;
}

function changedStateError(label) {
  return new Error(`后续操作已改变当前值，不能${label}`);
}

function restorePlan(db, event, now) {
  const current = readPlanState(db, event.executionTaskKey);
  const expected = planFromPayload(event.payload?.after);
  if (!samePlan(current, expected)) throw changedStateError("撤销计划字段修改");
  const before = planFromPayload(event.payload?.before);
  db.prepare(`
    INSERT INTO task_execution(
      execution_task_key, due_date, milestone, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(execution_task_key) DO UPDATE SET
      due_date = excluded.due_date,
      milestone = excluded.milestone,
      updated_at = excluded.updated_at
  `).run(
    event.executionTaskKey,
    before.dueDate,
    before.milestone,
    current.createdAt || now,
    now
  );
  db.prepare("DELETE FROM task_tag WHERE execution_task_key = ?")
    .run(event.executionTaskKey);
  const insert = db.prepare(`
    INSERT INTO task_tag(execution_task_key, tag, created_at)
    VALUES (?, ?, ?)
  `);
  before.tags.forEach((tag) => insert.run(event.executionTaskKey, tag, now));
  return before;
}

function restoreManualStage(db, event, { projectId, taskPath, now }) {
  const taskKey = `${projectId}/${taskPath}`;
  const current = db.prepare(`
    SELECT stage, updated_at
    FROM task_stage
    WHERE task_key = ?
  `).get(taskKey) || null;
  const expected = event.payload?.after || null;
  if (
    !current ||
    !expected ||
    current.stage !== expected.stage ||
    current.updated_at !== expected.updatedAt
  ) {
    throw changedStateError("撤销人工阶段确认");
  }
  const before = event.payload?.before || null;
  if (!before) {
    db.prepare("DELETE FROM task_stage WHERE task_key = ?").run(taskKey);
  } else {
    db.prepare(`
      INSERT INTO task_stage(task_key, stage, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(task_key) DO UPDATE SET
        stage = excluded.stage,
        updated_at = excluded.updated_at
    `).run(taskKey, before.stage, before.updatedAt || now);
  }
  return before;
}

function restoreDependency(db, event, now) {
  const dependencyId = String(event.payload?.dependencyId || "").trim();
  const row = dependencyId ? readDependency(db, dependencyId) : null;
  if (!row) throw changedStateError("撤销依赖操作");
  if (event.type === "dependency_created") {
    if (row.resolved_at || row.created_at !== event.occurredAt) {
      throw changedStateError("撤销新增阻断依赖");
    }
    db.prepare(`
      UPDATE task_dependency
      SET resolved_at = ?
      WHERE id = ? AND resolved_at IS NULL
    `).run(now, dependencyId);
    return { id: dependencyId, status: "resolved", resolvedAt: now };
  }

  const expectedResolvedAt = event.payload?.after?.resolvedAt || null;
  if (row.resolved_at !== expectedResolvedAt) {
    throw changedStateError("撤销解除阻断依赖");
  }
  const duplicate = db.prepare(`
    SELECT 1
    FROM task_dependency
    WHERE blocker_task_key = ?
      AND blocked_task_key = ?
      AND resolved_at IS NULL
      AND id <> ?
    LIMIT 1
  `).get(row.blocker_task_key, row.blocked_task_key, row.id);
  if (duplicate) {
    throw changedStateError("撤销解除阻断依赖");
  }
  db.prepare("UPDATE task_dependency SET resolved_at = NULL WHERE id = ?")
    .run(dependencyId);
  return { id: dependencyId, status: "active", resolvedAt: null };
}

function applyGroupEvent(db, event, context) {
  if (event.type === "task_plan_updated") {
    return { type: event.type, restored: restorePlan(db, event, context.now) };
  }
  if (event.type === "stage_manual_confirmed") {
    return {
      type: event.type,
      restored: restoreManualStage(db, event, context)
    };
  }
  if (["dependency_created", "dependency_resolved"].includes(event.type)) {
    return {
      type: event.type,
      restored: restoreDependency(db, event, context.now)
    };
  }
  throw new Error("最近一次可逆操作暂不支持撤销");
}

export function undoLastOperation({
  db,
  executionTaskKey,
  projectId,
  taskPath,
  task = {},
  actor = null,
  now = new Date().toISOString()
}) {
  if (task.archived) throw new Error("归档任务只读，不能撤销");
  if (task.executionIdentityValid === false || task.executionIdentityConflict) {
    throw new Error("任务执行身份冲突，无法安全撤销");
  }
  const occurredAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  return withTransaction(db, () => {
    const timeline = readExecutionEvents(db, executionTaskKey, 1000);
    const metadata = undoMetadata({
      events: timeline.events,
      eventTotal: timeline.eventTotal,
      eventTruncated: timeline.eventTruncated,
      archived: false,
      identityValid: true
    });
    if (!metadata.available) throw new Error(metadata.disabledReason || "没有可撤销操作");
    const group = groupEvents(timeline.events)
      .find((candidate) => candidate.correlationId === metadata.targetCorrelationId);
    if (!group) throw new Error("没有可撤销操作");

    const restored = group.events.map((event) => applyGroupEvent(db, event, {
      projectId,
      taskPath,
      now: occurredAt
    }));
    const correlationId = crypto.randomUUID();
    const eventId = appendTaskEvent(db, {
      executionTaskKey,
      eventType: "operation_undone",
      source: "user",
      actor,
      correlationId,
      occurredAt,
      payload: {
        targetCorrelationId: group.correlationId,
        targetEventIds: group.events.map((event) => Number(event.id)),
        targetEventType: group.eventType,
        targetLabel: undoLabel(group),
        reason: "撤销最近操作",
        restored
      }
    });
    return {
      correlationId,
      eventId,
      targetCorrelationId: group.correlationId,
      targetEventIds: group.events.map((event) => Number(event.id)),
      label: undoLabel(group),
      restored,
      undoneAt: occurredAt
    };
  });
}
