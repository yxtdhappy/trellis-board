import crypto from "node:crypto";
import { getDefaultDatabase, withTransaction } from "./database.js";

const MAX_TAGS = 10;
const MAX_TAG_LENGTH = 32;
const MAX_MILESTONE_LENGTH = 100;
const MAX_VIEW_NAME_LENGTH = 60;
const MAX_DEPENDENCY_REASON_LENGTH = 500;
const ALLOWED_PRIORITIES = new Set(["P0", "P1", "P2", "P3"]);
const ALLOWED_BLOCKED_FILTERS = new Set(["any", "blocked", "unblocked"]);
const FILTER_KEYS = new Set([
  "priorities",
  "stages",
  "tags",
  "dueWithinDays",
  "staleDays",
  "blocked"
]);

function textLength(value) {
  return Array.from(value).length;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseJson(value, fallback = null) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function chunk(values, size = 400) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function placeholders(count) {
  return Array.from({ length: count }, () => "?").join(", ");
}

function normalizeActor(actor) {
  const value = String(actor || "").trim();
  return value || null;
}

export function isValidCalendarDate(value) {
  if (typeof value !== "string") return false;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
}

export function normalizeTags(tags) {
  if (!Array.isArray(tags)) throw new Error("标签必须是数组");
  const normalized = [];
  const seen = new Set();
  for (const rawTag of tags) {
    if (typeof rawTag !== "string") throw new Error("每个标签都必须是文本");
    const tag = rawTag.trim();
    if (!tag) throw new Error("标签不能为空");
    if (textLength(tag) > MAX_TAG_LENGTH) {
      throw new Error(`单个标签不能超过 ${MAX_TAG_LENGTH} 个字符`);
    }
    const key = tag.toLocaleLowerCase("zh-CN");
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(tag);
  }
  if (normalized.length > MAX_TAGS) {
    throw new Error(`标签最多 ${MAX_TAGS} 个`);
  }
  return normalized;
}

function normalizeMilestone(value) {
  if (value == null) return "";
  if (typeof value !== "string") throw new Error("里程碑必须是文本");
  const milestone = value.trim();
  if (textLength(milestone) > MAX_MILESTONE_LENGTH) {
    throw new Error(`里程碑不能超过 ${MAX_MILESTONE_LENGTH} 个字符`);
  }
  return milestone;
}

function normalizeDueDate(value) {
  if (value == null || value === "") return null;
  if (!isValidCalendarDate(value)) {
    throw new Error("截止日期必须是有效的 YYYY-MM-DD 公历日期");
  }
  return value;
}

function normalizeStringSet(value, allowed, label) {
  if (!Array.isArray(value)) throw new Error(`${label}必须是数组`);
  const result = [];
  const seen = new Set();
  for (const item of value) {
    if (typeof item !== "string") throw new Error(`${label}只能包含文本`);
    const normalized = item.trim();
    if (!allowed.has(normalized)) throw new Error(`不支持的${label}值: ${normalized}`);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return result;
}

export function normalizeSavedViewFilter(input, stageIds) {
  if (!isPlainObject(input)) throw new Error("筛选条件必须是对象");
  const payload = input;
  for (const key of Object.keys(payload)) {
    if (!FILTER_KEYS.has(key)) throw new Error(`保存视图包含未知筛选字段: ${key}`);
  }

  const filter = {};
  if (payload.priorities != null) {
    const priorities = normalizeStringSet(payload.priorities, ALLOWED_PRIORITIES, "优先级");
    if (priorities.length) filter.priorities = priorities;
  }
  if (payload.stages != null) {
    const stages = normalizeStringSet(payload.stages, new Set(stageIds || []), "阶段");
    if (stages.length) filter.stages = stages;
  }
  if (payload.tags != null) {
    const tags = normalizeTags(payload.tags);
    if (tags.length) filter.tags = tags;
  }
  if (payload.dueWithinDays != null && payload.dueWithinDays !== "") {
    const days = payload.dueWithinDays;
    if (typeof days !== "number" || !Number.isInteger(days) || days < 0 || days > 365) {
      throw new Error("截止窗口必须是 0 到 365 的整数天");
    }
    filter.dueWithinDays = days;
  }
  if (payload.staleDays != null && payload.staleDays !== "") {
    const days = payload.staleDays;
    if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > 365) {
      throw new Error("停滞天数必须是 1 到 365 的整数天");
    }
    filter.staleDays = days;
  }
  if (payload.blocked != null && payload.blocked !== "") {
    if (
      typeof payload.blocked !== "string" ||
      !ALLOWED_BLOCKED_FILTERS.has(payload.blocked)
    ) {
      throw new Error("阻断筛选只支持 any、blocked 或 unblocked");
    }
    if (payload.blocked !== "any") filter.blocked = payload.blocked;
  }
  if (!Object.keys(filter).length) throw new Error("保存视图至少需要一个筛选条件");
  return filter;
}

function normalizeDependencyReason(value) {
  if (typeof value !== "string") throw new Error("阻断原因必须是文本");
  const reason = value.trim();
  if (!reason) throw new Error("阻断原因不能为空");
  if (textLength(reason) > MAX_DEPENDENCY_REASON_LENGTH) {
    throw new Error(`阻断原因不能超过 ${MAX_DEPENDENCY_REASON_LENGTH} 个字符`);
  }
  return reason;
}

function normalizeDependencyTaskKey(value, label) {
  const key = String(value || "").trim();
  if (!key) throw new Error(`缺少${label}任务执行身份`);
  return key;
}

function rowToDependency(row) {
  return {
    id: row.id,
    blockerTaskKey: row.blocker_task_key,
    blockedTaskKey: row.blocked_task_key,
    reason: row.reason,
    createdBy: row.created_by || null,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at || null
  };
}

export function readTaskDependencies(db) {
  return db.prepare(`
    SELECT
      id, blocker_task_key, blocked_task_key, reason, created_by,
      created_at, resolved_at
    FROM task_dependency
    ORDER BY created_at, rowid
  `).all().map(rowToDependency);
}

function createBlockedByGraph(dependencies) {
  const graph = new Map();
  dependencies
    .filter((dependency) => !dependency.resolvedAt)
    .forEach((dependency) => {
      if (!graph.has(dependency.blockedTaskKey)) {
        graph.set(dependency.blockedTaskKey, []);
      }
      graph.get(dependency.blockedTaskKey).push(dependency.blockerTaskKey);
    });
  return graph;
}

function findBlockedByPath(dependencies, start, target) {
  if (start === target) return [start];
  const graph = createBlockedByGraph(dependencies);
  const queue = [start];
  const previous = new Map([[start, null]]);
  while (queue.length) {
    const current = queue.shift();
    for (const next of graph.get(current) || []) {
      if (previous.has(next)) continue;
      previous.set(next, current);
      if (next === target) {
        const path = [target];
        let cursor = current;
        while (cursor != null) {
          path.push(cursor);
          cursor = previous.get(cursor);
        }
        return path.reverse();
      }
      queue.push(next);
    }
  }
  return null;
}

function normalizeViewName(value) {
  if (typeof value !== "string") throw new Error("视图名称必须是文本");
  const name = value.trim();
  if (!name) throw new Error("视图名称不能为空");
  if (textLength(name) > MAX_VIEW_NAME_LENGTH) {
    throw new Error(`视图名称不能超过 ${MAX_VIEW_NAME_LENGTH} 个字符`);
  }
  return name;
}

function readPlanRow(db, executionTaskKey) {
  return db.prepare(`
    SELECT due_date, milestone, created_at, updated_at
    FROM task_execution
    WHERE execution_task_key = ?
  `).get(executionTaskKey) || null;
}

function readTags(db, executionTaskKey) {
  return db.prepare(`
    SELECT tag
    FROM task_tag
    WHERE execution_task_key = ?
    ORDER BY rowid
  `).all(executionTaskKey).map((row) => row.tag);
}

function readPlan(db, executionTaskKey) {
  const row = readPlanRow(db, executionTaskKey);
  return {
    dueDate: row?.due_date ?? null,
    milestone: row?.milestone || "",
    tags: readTags(db, executionTaskKey),
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

export function appendTaskEvent(db, {
  executionTaskKey,
  eventType,
  source,
  actor = null,
  correlationId,
  occurredAt = new Date().toISOString(),
  payload = {},
  reversible = false
}) {
  const key = String(executionTaskKey || "").trim();
  const type = String(eventType || "").trim();
  const eventSource = String(source || "").trim();
  const operationId = String(correlationId || "").trim();
  const occurred = String(occurredAt || "").trim();
  if (!key || !type || !eventSource || !operationId || !occurred) {
    throw new Error("事件缺少必要字段");
  }
  const result = db.prepare(`
    INSERT INTO task_event(
      execution_task_key, event_type, source, actor, correlation_id,
      occurred_at, payload_json, reversible
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    key,
    type,
    eventSource,
    normalizeActor(actor),
    operationId,
    occurred,
    JSON.stringify(payload),
    reversible ? 1 : 0
  );
  return Number(result.lastInsertRowid);
}

function readEventSummaries(db, keys) {
  const summaries = new Map();
  for (const group of chunk(keys)) {
    if (!group.length) continue;
    const rows = db.prepare(`
      SELECT
        execution_task_key,
        COUNT(*) AS event_count,
        MAX(occurred_at) AS last_activity_at,
        MIN(CASE WHEN event_type = 'tracking_started' THEN occurred_at END) AS tracking_started_at
      FROM task_event
      WHERE execution_task_key IN (${placeholders(group.length)})
      GROUP BY execution_task_key
    `).all(...group);
    rows.forEach((row) => summaries.set(row.execution_task_key, row));
  }
  return summaries;
}

function readTagsBatch(db, keys) {
  const tagsByKey = new Map();
  for (const group of chunk(keys)) {
    if (!group.length) continue;
    const rows = db.prepare(`
      SELECT execution_task_key, tag
      FROM task_tag
      WHERE execution_task_key IN (${placeholders(group.length)})
      ORDER BY execution_task_key, rowid
    `).all(...group);
    rows.forEach((row) => {
      if (!tagsByKey.has(row.execution_task_key)) tagsByKey.set(row.execution_task_key, []);
      tagsByKey.get(row.execution_task_key).push(row.tag);
    });
  }
  return tagsByKey;
}

export function readExecutionMap(db, executionTaskKeys, limit = 200) {
  const keys = [...new Set(executionTaskKeys.map((key) => String(key || "").trim()).filter(Boolean))];
  if (!keys.length) return new Map();
  const plans = new Map();
  const tagsByKey = readTagsBatch(db, keys);
  const events = readEventSummaries(db, keys);
  for (const group of chunk(keys)) {
    if (!group.length) continue;
    const rows = db.prepare(`
      SELECT execution_task_key, due_date, milestone, created_at, updated_at
      FROM task_execution
      WHERE execution_task_key IN (${placeholders(group.length)})
    `).all(...group);
    rows.forEach((row) => plans.set(row.execution_task_key, row));
  }
  return new Map(keys.map((key) => {
    const plan = plans.get(key);
    const event = events.get(key);
    return [key, {
      dueDate: plan?.due_date ?? null,
      milestone: plan?.milestone || "",
      tags: tagsByKey.get(key) || [],
      planCreatedAt: plan?.created_at || null,
      planUpdatedAt: plan?.updated_at || null,
      lastActivityAt: event?.last_activity_at || null,
      trackingStartedAt: event?.tracking_started_at || null,
      eventCount: Number(event?.event_count || 0),
      historyStatus: event?.event_count ? "tracking" : "missing",
      eventLimit: limit
    }];
  }));
}

function readEvents(db, executionTaskKey, limit = 200) {
  const safeLimit = Math.min(1000, Math.max(1, Number(limit) || 200));
  const total = Number(db.prepare(`
    SELECT COUNT(*) AS count
    FROM task_event
    WHERE execution_task_key = ?
  `).get(executionTaskKey)?.count || 0);
  const rows = db.prepare(`
    SELECT
      id, event_type, source, actor, correlation_id, occurred_at,
      payload_json, reversible
    FROM task_event
    WHERE execution_task_key = ?
    ORDER BY occurred_at DESC, id DESC
    LIMIT ?
  `).all(executionTaskKey, safeLimit);
  return {
    events: rows.map((row) => ({
      id: row.id,
      type: row.event_type,
      source: row.source,
      actor: row.actor,
      correlationId: row.correlation_id,
      occurredAt: row.occurred_at,
      payload: parseJson(row.payload_json, {}),
      reversible: Boolean(row.reversible)
    })),
    eventTotal: total
  };
}

export function readExecutionDetail(db, executionTaskKey, limit = 200) {
  const key = String(executionTaskKey || "").trim();
  if (!key) throw new Error("缺少任务执行身份");
  const summary = readExecutionMap(db, [key], limit).get(key);
  const timeline = readEvents(db, key, limit);
  return { ...summary, ...timeline };
}

function rowToSavedView(row) {
  return {
    id: row.id,
    name: row.name,
    filter: parseJson(row.filter_json, {}),
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function purgeProjectExecutionData(db, projectId) {
  const prefix = `${String(projectId || "").trim()}::`;
  if (prefix === "::") throw new Error("缺少项目 ID");
  for (const table of ["task_event", "task_tag", "task_execution"]) {
    db.prepare(`
      DELETE FROM ${table}
      WHERE substr(execution_task_key, 1, ?) = ?
    `).run(prefix.length, prefix);
  }
  db.prepare(`
    DELETE FROM task_dependency
    WHERE substr(blocker_task_key, 1, ?) = ?
       OR substr(blocked_task_key, 1, ?) = ?
  `).run(prefix.length, prefix, prefix.length, prefix);
}

export function createExecutionStore({
  db = getDefaultDatabase(),
  stageIds = []
} = {}) {
  const allowedStages = [...new Set(stageIds)];

  function updatePlan(executionTaskKey, input = {}, actor = null) {
    const key = String(executionTaskKey || "").trim();
    if (!key) throw new Error("缺少任务执行身份");
    if (!isPlainObject(input)) throw new Error("计划字段必须是对象");
    const updatedAt = new Date().toISOString();
    return withTransaction(db, () => {
      const before = readPlan(db, key);
      const after = {
        dueDate: Object.hasOwn(input, "dueDate")
          ? normalizeDueDate(input.dueDate)
          : before.dueDate,
        milestone: Object.hasOwn(input, "milestone")
          ? normalizeMilestone(input.milestone)
          : before.milestone,
        tags: Object.hasOwn(input, "tags")
          ? normalizeTags(input.tags)
          : before.tags
      };
      if (samePlan(before, after)) {
        return {
          changed: false,
          correlationId: null,
          plan: {
            dueDate: after.dueDate,
            milestone: after.milestone,
            tags: after.tags
          }
        };
      }

      db.prepare(`
        INSERT INTO task_execution(
          execution_task_key, due_date, milestone, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(execution_task_key) DO UPDATE SET
          due_date = excluded.due_date,
          milestone = excluded.milestone,
          updated_at = excluded.updated_at
      `).run(key, after.dueDate, after.milestone, before.createdAt || updatedAt, updatedAt);
      db.prepare("DELETE FROM task_tag WHERE execution_task_key = ?").run(key);
      const insertTag = db.prepare(`
        INSERT INTO task_tag(execution_task_key, tag, created_at)
        VALUES (?, ?, ?)
      `);
      after.tags.forEach((tag) => insertTag.run(key, tag, updatedAt));

      const correlationId = crypto.randomUUID();
      appendTaskEvent(db, {
        executionTaskKey: key,
        eventType: "task_plan_updated",
        source: "user",
        actor,
        correlationId,
        occurredAt: updatedAt,
        payload: {
          before: {
            dueDate: before.dueDate,
            milestone: before.milestone,
            tags: before.tags
          },
          after: {
            dueDate: after.dueDate,
            milestone: after.milestone,
            tags: after.tags
          }
        },
        reversible: true
      });
      return {
        changed: true,
        correlationId,
        plan: {
          dueDate: after.dueDate,
          milestone: after.milestone,
          tags: after.tags
        }
      };
    });
  }

  function createDependency(input = {}, actor = null) {
    if (!isPlainObject(input)) throw new Error("依赖参数必须是对象");
    const blockerTaskKey = normalizeDependencyTaskKey(input.blockerTaskKey, "阻断方");
    const blockedTaskKey = normalizeDependencyTaskKey(input.blockedTaskKey, "被阻断");
    const reason = normalizeDependencyReason(input.reason);
    if (blockerTaskKey === blockedTaskKey) throw new Error("任务不能阻断自身");
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const labels = input.taskLabels instanceof Map
      ? new Map(input.taskLabels)
      : new Map(Object.entries(input.taskLabels || {}));
    labels.set(
      blockerTaskKey,
      String(input.blockerLabel || labels.get(blockerTaskKey) || blockerTaskKey)
    );
    labels.set(
      blockedTaskKey,
      String(input.blockedLabel || labels.get(blockedTaskKey) || blockedTaskKey)
    );

    return withTransaction(db, () => {
      const dependencies = readTaskDependencies(db);
      const duplicate = dependencies.find((dependency) =>
        !dependency.resolvedAt &&
        dependency.blockerTaskKey === blockerTaskKey &&
        dependency.blockedTaskKey === blockedTaskKey
      );
      if (duplicate) throw new Error("这条活动依赖已经存在");

      // A blocked by B 表示 A -> B；新增前从 B 搜索是否已经能回到 A。
      const path = findBlockedByPath(dependencies, blockerTaskKey, blockedTaskKey);
      if (path) {
        const cycle = [blockedTaskKey, ...path]
          .map((key) => labels.get(key) || key)
          .join(" → ");
        throw new Error(`依赖会形成循环：${cycle}`);
      }

      db.prepare(`
        INSERT INTO task_dependency(
          id, blocker_task_key, blocked_task_key, reason, created_by,
          created_at, resolved_at
        ) VALUES (?, ?, ?, ?, ?, ?, NULL)
      `).run(
        id,
        blockerTaskKey,
        blockedTaskKey,
        reason,
        normalizeActor(actor),
        createdAt
      );
      const correlationId = crypto.randomUUID();
      appendTaskEvent(db, {
        executionTaskKey: blockedTaskKey,
        eventType: "dependency_created",
        source: "user",
        actor,
        correlationId,
        occurredAt: createdAt,
        payload: {
          dependencyId: id,
          blockerTaskKey,
          blockedTaskKey,
          reason,
          before: null,
          after: { status: "active" }
        }
      });
      return {
        id,
        blockerTaskKey,
        blockedTaskKey,
        reason,
        createdBy: normalizeActor(actor),
        createdAt,
        resolvedAt: null,
        correlationId
      };
    });
  }

  function resolveDependency(id, actor = null) {
    const dependencyId = String(id || "").trim();
    if (!dependencyId) throw new Error("缺少依赖 ID");
    const resolvedAt = new Date().toISOString();
    return withTransaction(db, () => {
      const row = db.prepare(`
        SELECT
          id, blocker_task_key, blocked_task_key, reason, created_by,
          created_at, resolved_at
        FROM task_dependency
        WHERE id = ?
      `).get(dependencyId);
      if (!row) throw new Error("依赖不存在");
      if (row.resolved_at) throw new Error("这条依赖已经解除");
      const result = db.prepare(`
        UPDATE task_dependency
        SET resolved_at = ?
        WHERE id = ? AND resolved_at IS NULL
      `).run(resolvedAt, dependencyId);
      if (!result.changes) throw new Error("这条依赖已经解除");
      const correlationId = crypto.randomUUID();
      appendTaskEvent(db, {
        executionTaskKey: row.blocked_task_key,
        eventType: "dependency_resolved",
        source: "user",
        actor,
        correlationId,
        occurredAt: resolvedAt,
        payload: {
          dependencyId,
          blockerTaskKey: row.blocker_task_key,
          blockedTaskKey: row.blocked_task_key,
          reason: row.reason,
          before: { status: "active" },
          after: { status: "resolved", resolvedAt }
        }
      });
      return {
        ...rowToDependency({ ...row, resolved_at: resolvedAt }),
        correlationId
      };
    });
  }

  function recordScanObservationsInTransaction({
    tasks = [],
    previousTasks = [],
    occurredAt = new Date().toISOString(),
    actor = "system"
  } = {}) {
    const activeTasks = tasks.filter((task) =>
      !task.archived && task.executionIdentityValid !== false && task.executionTaskKey
    );
    const previousByKey = new Map(
      previousTasks
        .filter((task) =>
          task.executionTaskKey &&
          !task.archived &&
          task.executionIdentityValid !== false &&
          task.executionIdentityConflict !== true
        )
        .map((task) => [task.executionTaskKey, task])
    );
    const keys = [...new Set(activeTasks.map((task) => task.executionTaskKey))];
    if (!keys.length) return { baselines: 0, observations: 0 };

    const trackingKeys = new Set();
    for (const group of chunk(keys)) {
      const rows = db.prepare(`
        SELECT DISTINCT execution_task_key
        FROM task_event
        WHERE event_type = 'tracking_started'
          AND execution_task_key IN (${placeholders(group.length)})
      `).all(...group);
      rows.forEach((row) => trackingKeys.add(row.execution_task_key));
    }

    let baselines = 0;
    let observations = 0;
    const correlationId = crypto.randomUUID();
    for (const task of activeTasks) {
      const hadTracking = trackingKeys.has(task.executionTaskKey);
      if (!hadTracking) {
        appendTaskEvent(db, {
          executionTaskKey: task.executionTaskKey,
          eventType: "tracking_started",
          source: "system",
          actor,
          correlationId,
          occurredAt,
          payload: {
            before: null,
            after: {
              derivedStage: task.derivedStage,
              trackingStartedAt: occurredAt
            }
          }
        });
        trackingKeys.add(task.executionTaskKey);
        baselines += 1;
        continue;
      }
      const previous = previousByKey.get(task.executionTaskKey);
      if (previous?.derivedStage && previous.derivedStage !== task.derivedStage) {
        appendTaskEvent(db, {
          executionTaskKey: task.executionTaskKey,
          eventType: "stage_observed",
          source: "scan",
          actor,
          correlationId,
          occurredAt,
          payload: {
            before: { derivedStage: previous.derivedStage },
            after: { derivedStage: task.derivedStage }
          }
        });
        observations += 1;
      }
    }
    return { baselines, observations };
  }

  function recordScanObservations(options = {}) {
    return withTransaction(db, () => recordScanObservationsInTransaction(options));
  }

  function getExecutionDetail(executionTaskKey, limit = 200) {
    return readExecutionDetail(db, executionTaskKey, limit);
  }

  function listSavedViews() {
    return db.prepare(`
      SELECT id, name, filter_json, position, created_at, updated_at
      FROM saved_view
      ORDER BY position, id
    `).all().map(rowToSavedView);
  }

  function createSavedView(input = {}) {
    if (!isPlainObject(input)) throw new Error("保存视图必须是对象");
    const name = normalizeViewName(input.name);
    const filter = normalizeSavedViewFilter(input.filter, allowedStages);
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    return withTransaction(db, () => {
      const next = db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS position FROM saved_view").get();
      db.prepare(`
        INSERT INTO saved_view(id, name, filter_json, position, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(id, name, JSON.stringify(filter), Number(next.position), now, now);
      return {
        id,
        name,
        filter,
        position: Number(next.position),
        createdAt: now,
        updatedAt: now
      };
    });
  }

  function updateSavedView(input = {}) {
    if (!isPlainObject(input)) throw new Error("保存视图必须是对象");
    const id = String(input.id || "").trim();
    if (!id) throw new Error("缺少保存视图 ID");
    const name = normalizeViewName(input.name);
    const filter = normalizeSavedViewFilter(input.filter, allowedStages);
    const updatedAt = new Date().toISOString();
    const result = db.prepare(`
      UPDATE saved_view
      SET name = ?, filter_json = ?, updated_at = ?
      WHERE id = ?
    `).run(name, JSON.stringify(filter), updatedAt, id);
    if (!result.changes) throw new Error("保存视图不存在");
    return {
      ...rowToSavedView(db.prepare(`
        SELECT id, name, filter_json, position, created_at, updated_at
        FROM saved_view
        WHERE id = ?
      `).get(id))
    };
  }

  function deleteSavedView(id) {
    const viewId = String(id || "").trim();
    if (!viewId) throw new Error("缺少保存视图 ID");
    return withTransaction(db, () => {
      const row = db.prepare(`
        SELECT id, name, filter_json, position, created_at, updated_at
        FROM saved_view
        WHERE id = ?
      `).get(viewId);
      if (!row) throw new Error("保存视图不存在");
      db.prepare("DELETE FROM saved_view WHERE id = ?").run(viewId);
      db.prepare("UPDATE saved_view SET position = position - 1 WHERE position > ?")
        .run(row.position);
      return rowToSavedView(row);
    });
  }

  return {
    updatePlan,
    createDependency,
    resolveDependency,
    recordScanObservations,
    recordScanObservationsInTransaction,
    getExecutionDetail,
    listSavedViews,
    createSavedView,
    updateSavedView,
    deleteSavedView
  };
}
