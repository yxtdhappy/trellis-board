import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { withTransaction } from "../database.js";
import {
  linkTaskGroups,
  toTaskListItem,
  withManualStages
} from "../loader.js";
import { getManualRecords } from "../metadata.js";
import { projectBoardExecution } from "../execution-projection.js";
import { syncAssignmentsFromBoardInTransaction } from "./assignments.js";
import { ERROR_CODES, teamError } from "./errors.js";

const workerFile = fileURLToPath(new URL("./scan-worker.js", import.meta.url));
const CURSOR_KEY = crypto.randomBytes(32);
const CURSOR_TTL_MS = 10 * 60 * 1000;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;
const INDEX_SCHEMA_VERSION = 1;
const QUERY_CACHE_ENTRIES = 64;

function text(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function shanghaiDay(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function addDays(day, days) {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableValue(value[key])])
  );
}

function hashValue(value) {
  return crypto.createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex");
}

function encryptCursor(payload) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", CURSOR_KEY, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString("base64url");
}

function decryptCursor(value) {
  try {
    const data = Buffer.from(String(value), "base64url");
    if (data.length < 29) throw new Error("short");
    const iv = data.subarray(0, 12);
    const tag = data.subarray(12, 28);
    const ciphertext = data.subarray(28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", CURSOR_KEY, iv);
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([
      decipher.update(ciphertext),
      decipher.final()
    ]).toString("utf8"));
  } catch {
    throw teamError(
      409,
      ERROR_CODES.CURSOR_INVALID,
      "查询游标无效，请从第一页重新获取",
      { recoverable: true }
    );
  }
}

function normalizedLimit(value) {
  if (value == null || value === "") return DEFAULT_LIMIT;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, "limit 必须是 1 到 200 的整数");
  }
  return limit;
}

function stringList(value, label, { maxItems = 50, maxLength = 100 } = {}) {
  if (value == null || value === "") return [];
  const values = Array.isArray(value) ? value : [value];
  if (values.length > maxItems) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, `${label} 数量过多`);
  }
  return [...new Set(values.map((item) => {
    if (typeof item !== "string" || !item.trim() || item.length > maxLength) {
      throw teamError(400, ERROR_CODES.INVALID_INPUT, `${label} 格式无效`);
    }
    return item.trim();
  }))];
}

function boolFilter(value, label) {
  if (value == null || value === "") return null;
  if (value === true || value === "true" || value === "1") return true;
  if (value === false || value === "false" || value === "0") return false;
  throw teamError(400, ERROR_CODES.INVALID_INPUT, `${label} 只能是 true 或 false`);
}

function normalizeFilters(input = {}) {
  const scope = input.scope == null || input.scope === "" ? "all" : String(input.scope);
  if (!new Set(["all", "mine"]).has(scope)) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, "scope 只能是 all 或 mine");
  }
  const preset = input.preset == null || input.preset === "" ? null : String(input.preset);
  if (preset != null && !new Set(["today", "unblocked-ready"]).has(preset)) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, "preset 无效");
  }
  const q = text(input.q).trim().toLowerCase();
  if (q.length > 200) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, "搜索词不能超过 200 个字符");
  }
  const days = (name) => {
    if (input[name] == null || input[name] === "") return null;
    const value = Number(input[name]);
    if (!Number.isInteger(value) || value < 0 || value > 3650) {
      throw teamError(400, ERROR_CODES.INVALID_INPUT, `${name} 必须是 0 到 3650 的整数`);
    }
    return value;
  };
  return {
    scope,
    q,
    priorities: stringList(input.priorities, "priorities", { maxItems: 4, maxLength: 2 }),
    stages: stringList(input.stages, "stages", { maxItems: 20, maxLength: 30 }),
    tags: stringList(input.tags, "tags", { maxItems: 50, maxLength: 50 }),
    assignee: text(input.assignee).trim() || null,
    dueWithinDays: days("dueWithinDays"),
    staleDays: days("staleDays"),
    blocked: boolFilter(input.blocked, "blocked"),
    archived: boolFilter(input.archived, "archived") ?? false,
    preset,
    limit: normalizedLimit(input.limit)
  };
}

function projectIdsHash(projectIds) {
  return hashValue([...projectIds].sort());
}

function filterHash(filters, projectIds, revision, day) {
  return hashValue({ filters, projectIds, revision, day });
}

function cursorBinding(filters, projectIds, userId, revision, day, teamId = null) {
  return {
    u: userId,
    g: teamId,
    p: projectIdsHash(projectIds),
    f: filterHash(filters, projectIds, revision, day),
    r: revision,
    d: day
  };
}

function bindList(values) {
  return values.map(() => "?").join(", ");
}

function rowFromIndex(row) {
  let attentionReasons = [];
  try {
    const parsed = JSON.parse(row.attention_flags_json);
    if (Array.isArray(parsed)) attentionReasons = parsed.map(String);
  } catch {
    // 损坏索引只影响关注标记。
  }
  return {
    taskKey: row.task_key,
    executionTaskKey: row.execution_task_key,
    taskVersion: row.task_version,
    projectId: row.project_id,
    projectName: row.project_name,
    relativeDir: row.relative_dir,
    title: row.title,
    priority: row.priority,
    derivedStage: row.derived_stage,
    archived: Boolean(row.archived),
    assigneeDevId: row.assignee_dev_id || null,
    assigneeUserId: row.assignee_user_id || null,
    dueDate: row.due_date || null,
    lastActivityAt: row.last_activity_at || row.updated_at,
    isBlocked: Boolean(row.is_blocked),
    isUnblockedReady: Boolean(row.is_unblocked_ready),
    attentionReasons,
    groupKey: row.group_key,
    groupRole: row.group_role,
    projectSyncStatus: row.sync_status,
    stale: row.sync_status !== "current",
    syncError: row.last_error || null
  };
}

export function taskIndexInsertArgs(task, {
  projectId,
  searchText,
  assigneeDevId,
  assigneeUserId,
  boardVersion,
  now
}) {
  const text = (value) => (value === null || value === undefined ? "" : String(value));
  return [
    projectId,
    text(task.taskKey),
    text(task.executionTaskKey ?? task.taskKey),
    text(task.relativeDir),
    text(task.title),
    text(searchText),
    task.archived ? 1 : 0,
    text(task.priority).trim(),
    text(task.derivedStage).trim(),
    assigneeDevId ?? null,
    assigneeUserId ?? null,
    task.execution?.dueDate || null,
    task.execution?.lastActivityAt || null,
    task.execution?.isBlocked ? 1 : 0,
    task.execution?.isUnblockedReady ? 1 : 0,
    JSON.stringify(task.execution?.attentionReasons || []),
    text(task.groupKey || task.taskKey),
    text(task.groupRole || "parent"),
    text(task.taskVersion),
    boardVersion,
    now
  ];
}

export function createTaskIndex({
  db,
  stageIds,
  executionWipLimit = 2,
  agentEvents = null
}) {
  let worker = null;
  let requestId = 0;
  const pending = new Map();
  const queryCache = new Map();

  function rejectPending(error) {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  }

  function ensureWorker() {
    if (worker) return worker;
    const current = new Worker(workerFile);
    worker = current;
    worker.on("message", (message) => {
      const request = pending.get(message?.id);
      if (!request) return;
      clearTimeout(request.timer);
      pending.delete(message.id);
      if (message.type === "scan-error") request.reject(new Error(message.error));
      else request.resolve(message);
    });
    current.on("error", (error) => {
      if (worker === current) worker = null;
      rejectPending(error);
    });
    current.on("exit", (code) => {
      if (worker === current) worker = null;
      if (pending.size) rejectPending(new Error(`团队扫描 worker 退出：${code}`));
    });
    return worker;
  }

  function scanProject(project) {
    const runtime = ensureWorker();
    const id = ++requestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("项目扫描超过 180 秒"));
      }, 180_000);
      pending.set(id, { resolve, reject, timer });
      runtime.postMessage({
        type: "scan",
        id,
        project
      });
    });
  }

  function buildBoard(scan) {
    const manualRecords = getManualRecords(db);
    const versionByDir = new Map(
      scan.tasks
        .filter((task) => task.taskVersion)
        .map((task) => [task.relativeDir, task.taskVersion])
    );
    const tasks = linkTaskGroups([{
      tasks: scan.tasks.map((task) => {
        const clean = { ...task, artifacts: undefined };
        return withManualStages(
          clean,
          manualRecords[`${task.projectId}/${task.relativeDir}`] || null
        );
      })
    }]).map((task) => ({
      ...toTaskListItem(task),
      taskVersion: versionByDir.get(task.relativeDir) || null
    }));
    const base = {
      generatedAt: new Date().toISOString(),
      projects: [{
        ...scan.project,
        taskCount: tasks.length,
        activeCount: tasks.filter((task) => !task.archived).length,
        archivedCount: tasks.filter((task) => task.archived).length,
        error: scan.error
      }],
      tasks,
      stages: stageIds.map((id) => ({ id }))
    };
    return projectBoardExecution(
      base,
      [],
      db,
      new Date(),
      { executionWipLimit }
    );
  }

  function incrementQueryRevision() {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO app_meta(key, value, updated_at)
      VALUES ('queryRevision', '1', ?)
      ON CONFLICT(key) DO UPDATE SET
        value = CAST(CAST(value AS INTEGER) + 1 AS TEXT),
        updated_at = excluded.updated_at
    `).run(now);
  }

  function queryRevision() {
    return Number(
      db.prepare("SELECT value FROM app_meta WHERE key = 'queryRevision'").get()?.value || 0
    );
  }

  function assigneeUserMap(projectId) {
    const rows = db.prepare(`
      SELECT m.trellis_dev_id, m.user_id
      FROM project_member m
      JOIN user_account u ON u.id = m.user_id
      WHERE m.project_id = ? AND u.status = 'active'
    `).all(projectId);
    return new Map(rows.map((row) => [String(row.trellis_dev_id).toLowerCase(), row.user_id]));
  }

  function readProjectScanCache(projectId) {
    const row = db.prepare(`
      SELECT *
      FROM project_scan_cache
      WHERE project_id = ? AND schema_version = ?
    `).get(projectId, INDEX_SCHEMA_VERSION);
    if (!row) return null;
    return {
      board: parseJson(row.board_json, null),
      contentKey: row.scanned_content_key,
      branchSha: row.scanned_branch_sha,
      savedAt: row.saved_at
    };
  }

  function writeProjectScanCacheInTransaction({
    projectId,
    board,
    contentKey,
    branchSha
  }) {
    db.prepare(`
      INSERT INTO project_scan_cache(
        project_id, schema_version, scanned_content_key,
        scanned_branch_sha, saved_at, board_json
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET
        schema_version = excluded.schema_version,
        scanned_content_key = excluded.scanned_content_key,
        scanned_branch_sha = excluded.scanned_branch_sha,
        saved_at = excluded.saved_at,
        board_json = excluded.board_json
    `).run(
      projectId,
      INDEX_SCHEMA_VERSION,
      contentKey,
      branchSha,
      new Date().toISOString(),
      JSON.stringify(board)
    );
  }

  function replaceProjectIndexInTransaction({
    projectId,
    board,
    boardVersion,
    contentKey = null,
    branchSha = null,
    persistCache = true
  }) {
    db.prepare("DELETE FROM team_task_index_tag WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM team_task_index WHERE project_id = ?").run(projectId);
    const users = assigneeUserMap(projectId);
    const insert = db.prepare(`
      INSERT INTO team_task_index(
        project_id, task_key, execution_task_key, relative_dir, title,
        search_text, archived, priority, derived_stage, assignee_dev_id,
        assignee_user_id, due_date, last_activity_at, is_blocked,
        is_unblocked_ready, attention_flags_json, group_key, group_role,
        task_version, board_version, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertTag = db.prepare(`
      INSERT OR IGNORE INTO team_task_index_tag(project_id, task_key, tag_key)
      VALUES (?, ?, ?)
    `);
    const now = new Date().toISOString();
    for (const task of board.tasks || []) {
      if (!task.taskVersion) continue;
      const assigneeDevId = task.assignee || null;
      const assigneeUserId = assigneeDevId
        ? users.get(String(assigneeDevId).toLowerCase()) || null
        : null;
      const tags = (task.execution?.tags || []).map((tag) => String(tag).toLowerCase());
      const searchText = [
        task.title,
        task.description,
        task.taskKey,
        task.executionTaskKey,
        task.assignee,
        task.priority,
        task.derivedStage,
        ...(task.execution?.tags || [])
      ].filter(Boolean).join("\n").toLowerCase();
      insert.run(...taskIndexInsertArgs(task, {
        projectId,
        searchText,
        assigneeDevId,
        assigneeUserId,
        boardVersion,
        now
      }));
      tags.forEach((tag) => insertTag.run(projectId, task.taskKey, tag));
    }
    if (persistCache) {
      writeProjectScanCacheInTransaction({
        projectId,
        board,
        contentKey: contentKey || boardVersion,
        branchSha
      });
    }
    syncAssignmentsFromBoardInTransaction(db, projectId, board);
    return {
      changed: true,
      queryRevision: queryRevision() + 1
    };
  }

  function indexTaskRow(task) {
    return {
      task_key: task.taskKey,
      execution_task_key: task.executionTaskKey || task.taskKey,
      relative_dir: task.relativeDir,
      task_version: task.taskVersion,
      title: task.title,
      priority: task.priority,
      assignee_dev_id: task.assignee || null,
      assignee_user_id: null,
      archived: task.archived ? 1 : 0
    };
  }

  function publishIndexEvents(projectId, previousRows, board) {
    if (!agentEvents) return;
    const teamId = db.prepare(`
      SELECT team_id FROM team_project WHERE repository_id = ?
    `).get(projectId)?.team_id;
    if (!teamId) return;
    const previous = new Map(previousRows.map((row) => [
      row.execution_task_key || row.task_key,
      row
    ]));
    const current = new Map();
    for (const task of board.tasks || []) {
      if (!task.taskVersion) continue;
      current.set(task.executionTaskKey || task.taskKey, task);
    }
    const publish = (eventType, taskIndexRow) => {
      const executionTaskKey = taskIndexRow.execution_task_key || taskIndexRow.task_key;
      try {
        agentEvents.publishTaskEvent({
          eventType,
          projectId,
          relativeDir: taskIndexRow.relative_dir,
          taskKey: taskIndexRow.task_key,
          executionTaskKey,
          taskVersion: taskIndexRow.task_version,
          taskIndexRow,
          dedupeKey: `${eventType}:${executionTaskKey}:${taskIndexRow.task_version}`
        });
      } catch (error) {
        process.emitWarning(`任务索引事件发布失败: ${error.message}`);
      }
    };
    for (const [key, task] of current) {
      const row = previous.get(key);
      const indexRow = indexTaskRow(task);
      if (!row) {
        publish("task.created", indexRow);
      } else if (Boolean(row.archived) !== Boolean(task.archived)) {
        if (task.archived) publish("task.cancelled", indexRow);
        else publish("task.updated", indexRow);
      } else if (String(row.task_version) !== String(task.taskVersion)) {
        publish("task.updated", indexRow);
      }
    }
    for (const [key, row] of previous) {
      if (current.has(key) || row.archived) continue;
      publish("task.cancelled", row);
    }
  }

  function replaceProjectIndex(options) {
    const previousRows = db.prepare(`
      SELECT execution_task_key, task_key, relative_dir, task_version,
             archived, title, priority, assignee_dev_id, assignee_user_id
      FROM team_task_index
      WHERE project_id = ?
    `).all(options.projectId);
    const result = withTransaction(db, () => {
      const applied = replaceProjectIndexInTransaction(options);
      incrementQueryRevision();
      return {
        ...applied,
        queryRevision: queryRevision()
      };
    });
    publishIndexEvents(options.projectId, previousRows, options.board);
    return result;
  }

  function refreshProjectIndexFromDatabase({
    projectId,
    board,
    boardVersion,
    persistCache = false
  }) {
    return replaceProjectIndex({
      projectId,
      board,
      boardVersion,
      persistCache
    });
  }

  async function scanAndIndexProject(project, {
    branchSha = null,
    force = false
  } = {}) {
    const cached = readProjectScanCache(project.id);
    const scan = await scanProject(project);
    if (!force && cached?.contentKey === scan.contentKey) {
      return { board: cached.board, contentKey: scan.contentKey, unchanged: true };
    }
    const board = buildBoard(scan);
    const boardVersion = hashValue({
      contentKey: scan.contentKey,
      projectId: project.id,
      schema: INDEX_SCHEMA_VERSION
    });
    const result = replaceProjectIndex({
      projectId: project.id,
      board,
      boardVersion,
      contentKey: scan.contentKey,
      branchSha
    });
    return {
      board,
      contentKey: scan.contentKey,
      boardVersion,
      unchanged: false,
      queryRevision: result.queryRevision
    };
  }

  function queryTasks(actor, readableIds, input = {}) {
    const filters = normalizeFilters(input);
    const requested = stringList(input.projectIds, "projectIds", {
      maxItems: 200,
      maxLength: 200
    });
    const readable = [...new Set(readableIds)];
    const readableSet = new Set(readable);
    if (requested.some((projectId) => !readableSet.has(projectId))) {
      throw teamError(403, ERROR_CODES.FORBIDDEN, "查询包含无权访问的项目");
    }
    const projectIds = requested.length ? requested : readable;
    const revision = queryRevision();
    const day = shanghaiDay();
    const etag = `"${hashValue({
      user: actor.userId,
      team: actor.activeTeamId || null,
      projects: [...projectIds].sort(),
      filters,
      revision,
      day
    })}"`;
    if (input.ifNoneMatch && input.ifNoneMatch === etag) {
      return {
        notModified: true,
        etag,
        queryRevision: revision,
        queryDay: day
      };
    }
    const cacheKey = hashValue({
      user: filters.scope === "mine" || input.cursor ? actor.userId : null,
      team: actor.activeTeamId || null,
      cursor: input.cursor || null,
      projects: [...projectIds].sort(),
      filters,
      revision,
      day
    });
    const cached = queryCache.get(cacheKey);
    if (cached) {
      queryCache.delete(cacheKey);
      queryCache.set(cacheKey, cached);
      const binding = cursorBinding(filters, projectIds, actor.userId, revision, day, actor.activeTeamId || null);
      return {
        tasks: cached.tasks,
        total: cached.total,
        nextCursor: cached.last
          ? encryptCursor({
              ...binding,
              ...cached.last,
              exp: Date.now() + CURSOR_TTL_MS
            })
          : null,
        etag,
        queryRevision: revision,
        queryDay: day
      };
    }
    if (!projectIds.length) {
      return {
        tasks: [],
        total: 0,
        nextCursor: null,
        etag,
        queryRevision: revision,
        queryDay: day
      };
    }

    const where = [
      `t.project_id IN (${bindList(projectIds)})`,
      "t.archived = ?"
    ];
    const params = [...projectIds, filters.archived ? 1 : 0];
    if (filters.scope === "mine") {
      where.push("t.assignee_user_id = ?");
      params.push(actor.userId);
    }
    if (filters.q) {
      where.push("t.search_text LIKE ? ESCAPE '\\'");
      params.push(`%${filters.q.replace(/[\\%_]/g, "\\$&")}%`);
    }
    if (filters.priorities.length) {
      where.push(`t.priority IN (${bindList(filters.priorities)})`);
      params.push(...filters.priorities);
    }
    if (filters.stages.length) {
      where.push(`t.derived_stage IN (${bindList(filters.stages)})`);
      params.push(...filters.stages);
    }
    if (filters.tags.length) {
      where.push(`EXISTS (
        SELECT 1 FROM team_task_index_tag tag
        WHERE tag.project_id = t.project_id
          AND tag.task_key = t.task_key
          AND tag.tag_key IN (${bindList(filters.tags)})
      )`);
      params.push(...filters.tags.map((tag) => tag.toLowerCase()));
    }
    if (filters.assignee) {
      where.push("(t.assignee_user_id = ? OR t.assignee_dev_id = ? COLLATE NOCASE)");
      params.push(filters.assignee, filters.assignee);
    }
    if (filters.dueWithinDays != null) {
      where.push("t.due_date IS NOT NULL AND t.due_date <= ?");
      params.push(addDays(day, filters.dueWithinDays));
    }
    if (filters.staleDays != null) {
      where.push("COALESCE(t.last_activity_at, t.updated_at) <= ?");
      const cutoff = new Date(Date.now() - filters.staleDays * 86_400_000).toISOString();
      params.push(cutoff);
    }
    if (filters.blocked != null) {
      where.push("t.is_blocked = ?");
      params.push(filters.blocked ? 1 : 0);
    }
    if (filters.preset === "today") {
      where.push("t.due_date IS NOT NULL AND t.due_date <= ?");
      params.push(day);
    }
    if (filters.preset === "unblocked-ready") {
      where.push("t.is_unblocked_ready = 1");
    }

    const baseWhere = where.join(" AND ");
    const total = Number(db.prepare(`
      SELECT COUNT(*) AS count
      FROM team_task_index t
      WHERE ${baseWhere}
    `).get(...params).count);

    const pageWhere = [...where];
    const pageParams = [...params];
    if (input.cursor) {
      const cursor = decryptCursor(input.cursor);
      const binding = cursorBinding(filters, projectIds, actor.userId, revision, day, actor.activeTeamId || null);
      if (
        Date.now() > cursor.exp ||
        Object.entries(binding).some(([key, value]) => cursor[key] !== value)
      ) {
        throw teamError(
          409,
          ERROR_CODES.CURSOR_INVALID,
          "查询游标已过期或与当前筛选不匹配，请从第一页重试",
          { recoverable: true }
        );
      }
      pageWhere.push(`(
        COALESCE(t.last_activity_at, t.updated_at) < ?
        OR (
          COALESCE(t.last_activity_at, t.updated_at) = ?
          AND (
            t.project_id < ?
            OR (t.project_id = ? AND t.task_key < ?)
          )
        )
      )`);
      pageParams.push(
        cursor.sa,
        cursor.sa,
        cursor.pid,
        cursor.pid,
        cursor.tk
      );
    }

    const rows = db.prepare(`
      SELECT
        t.*, p.sync_status, p.last_error, r.name AS project_name
      FROM team_task_index t
      JOIN team_project p ON p.repository_id = t.project_id
      JOIN repositories r ON r.id = t.project_id
      WHERE ${pageWhere.join(" AND ")}
      ORDER BY
        COALESCE(t.last_activity_at, t.updated_at) DESC,
        t.project_id DESC,
        t.task_key DESC
      LIMIT ?
    `).all(...pageParams, filters.limit + 1);
    const pageRows = rows.slice(0, filters.limit);
    let nextCursor = null;
    if (rows.length > filters.limit) {
      const last = pageRows.at(-1);
      nextCursor = encryptCursor({
        ...cursorBinding(filters, projectIds, actor.userId, revision, day, actor.activeTeamId || null),
        sa: last.last_activity_at || last.updated_at,
        pid: last.project_id,
        tk: last.task_key,
        exp: Date.now() + CURSOR_TTL_MS
      });
    }
    const tasks = pageRows.map(rowFromIndex);
    const last = rows.length > filters.limit ? pageRows.at(-1) : null;
    const cachedPage = {
      tasks,
      total,
      last: last ? {
        sa: last.last_activity_at || last.updated_at,
        pid: last.project_id,
        tk: last.task_key
      } : null
    };
    queryCache.set(cacheKey, cachedPage);
    if (queryCache.size > QUERY_CACHE_ENTRIES) {
      queryCache.delete(queryCache.keys().next().value);
    }
    return {
      tasks,
      total,
      nextCursor,
      etag,
      queryRevision: revision,
      queryDay: day
    };
  }

  function close() {
    if (!worker) return Promise.resolve();
    const current = worker;
    worker = null;
    rejectPending(new Error("团队扫描 worker 正在关闭"));
    return current.terminate();
  }

  return {
    scanAndIndexProject,
    buildBoard,
    replaceProjectIndexInTransaction,
    replaceProjectIndex,
    refreshProjectIndexFromDatabase,
    incrementQueryRevision,
    queryTasks,
    queryRevision,
    readProjectScanCache,
    close,
    INDEX_SCHEMA_VERSION,
    DEFAULT_LIMIT,
    MAX_LIMIT
  };
}
