import {
  readExecutionDetail,
  readExecutionMap
} from "./execution-store.js";

const DEFAULT_DUE_SOON_DAYS = 3;
const DEFAULT_STALE_DAYS = 5;

function localDateParts(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate()
  };
}

function dateKey(parts) {
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function dateSerial(parts) {
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  return Math.floor(date.getTime() / 86_400_000);
}

export function dueDateDistance(dueDate, now = new Date()) {
  if (typeof dueDate !== "string") return null;
  const match = dueDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const today = localDateParts(now);
  if (!match || !today) return null;
  return dateSerial({
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3])
  }) - dateSerial(today);
}

function daysSince(value, now) {
  const timestamp = Date.parse(value || "");
  const nowTimestamp = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(timestamp) || !Number.isFinite(nowTimestamp)) return null;
  return Math.max(0, Math.floor((nowTimestamp - timestamp) / 86_400_000));
}

function executionSnapshot(task, snapshot) {
  return {
    dueDate: snapshot?.dueDate ?? null,
    milestone: snapshot?.milestone || "",
    tags: Array.isArray(snapshot?.tags) ? snapshot.tags : [],
    lastActivityAt: snapshot?.lastActivityAt || null,
    trackingStartedAt: snapshot?.trackingStartedAt || null,
    eventCount: Number(snapshot?.eventCount || 0),
    historyStatus: snapshot?.historyStatus === "tracking" ? "tracking" : "missing"
  };
}

export function computeAttentionReasons(task, execution, now = new Date()) {
  if (task.archived) return [];
  const reasons = [];
  if (task.executionIdentityValid === false || task.executionIdentityConflict) {
    reasons.push("identity_conflict");
  }
  const distance = dueDateDistance(execution?.dueDate, now);
  if (distance != null && distance < 0) reasons.push("overdue");
  if (distance != null && distance >= 0 && distance <= DEFAULT_DUE_SOON_DAYS) {
    reasons.push("due_soon");
  }
  if (task.priority === "P0" || task.priority === "P1") reasons.push("priority");
  if (
    execution?.historyStatus === "tracking" &&
    daysSince(execution.lastActivityAt, now) >= DEFAULT_STALE_DAYS
  ) {
    reasons.push("stale");
  }
  if (task.derivedStage === "implement") reasons.push("implementing");
  if (task.derivedStage === "check") reasons.push("checking");
  return reasons;
}

export function projectTaskExecution(task, snapshot = null, now = new Date()) {
  const base = task.executionIdentityValid === false || task.executionIdentityConflict
    ? {
        dueDate: null,
        milestone: "",
        tags: [],
        lastActivityAt: null,
        trackingStartedAt: null,
        eventCount: 0,
        historyStatus: "missing"
      }
    : executionSnapshot(task, snapshot);
  return {
    ...base,
    attentionReasons: computeAttentionReasons(task, base, now)
  };
}

export function projectBoardExecution(board, savedViews = [], db, now = new Date()) {
  const tasks = Array.isArray(board?.tasks) ? board.tasks : [];
  const validKeys = tasks
    .filter((task) => task.executionIdentityValid !== false && task.executionTaskKey)
    .map((task) => task.executionTaskKey);
  const snapshots = readExecutionMap(db, validKeys);
  return {
    ...board,
    tasks: tasks.map((task) => ({
      ...task,
      execution: projectTaskExecution(
        task,
        snapshots.get(task.executionTaskKey) || null,
        now
      )
    })),
    savedViews
  };
}

export function projectTaskDetailExecution(task, db, now = new Date(), limit = 200) {
  if (task.executionIdentityValid === false || task.executionIdentityConflict) {
    return {
      ...task,
      execution: {
        ...projectTaskExecution(task, null, now),
        events: [],
        eventTotal: 0
      }
    };
  }
  const detail = readExecutionDetail(db, task.executionTaskKey, limit);
  return {
    ...task,
    execution: {
      ...projectTaskExecution(task, detail, now),
      events: detail.events,
      eventTotal: detail.eventTotal
    }
  };
}

export function todayLabel(now = new Date()) {
  const parts = localDateParts(now);
  return parts ? dateKey(parts) : null;
}

export { DEFAULT_DUE_SOON_DAYS, DEFAULT_STALE_DAYS };
