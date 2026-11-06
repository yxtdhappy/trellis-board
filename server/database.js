import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  databaseFile as defaultDatabaseFile,
  metadataFile,
  normalizeRepositoryEntry,
  repositoriesFile,
  repositoryPathKey,
  scanCacheFile,
  stateFile
} from "./config.js";

export const DATABASE_SCHEMA_VERSION = 6;

const LEGACY_IMPORT_KEY = "legacy_json_imported_v1";
const EXECUTION_EVENTS_STARTED_KEY = "execution_events_started_at";
let defaultDatabase = null;

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function readLegacyJson(file, label, logger) {
  try {
    return {
      exists: true,
      value: JSON.parse(fs.readFileSync(file, "utf8"))
    };
  } catch (error) {
    if (error?.code !== "ENOENT") {
      logger.warn(`跳过无法读取的旧数据 ${label}: ${errorMessage(error)}`);
    }
    return { exists: error?.code !== "ENOENT", value: null };
  }
}

function readMeta(db, key) {
  return db.prepare("SELECT value FROM app_meta WHERE key = ?").get(key)?.value ?? null;
}

function writeMeta(db, key, value) {
  db.prepare(`
    INSERT INTO app_meta(key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `).run(key, String(value), new Date().toISOString());
}

const BASE_SCHEMA_V1_SQL = `
  CREATE TABLE IF NOT EXISTS app_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS repositories (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    path_key TEXT NOT NULL UNIQUE,
    position INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS task_stage (
    task_key TEXT PRIMARY KEY,
    stage TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS scan_cache (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    schema_version INTEGER NOT NULL,
    saved_at TEXT NOT NULL,
    board_json TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS board_state (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

const SCHEMA_V2_SQL = `
  CREATE TABLE IF NOT EXISTS task_execution (
    execution_task_key TEXT PRIMARY KEY,
    due_date TEXT,
    milestone TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS task_tag (
    execution_task_key TEXT NOT NULL,
    tag TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (execution_task_key, tag)
  );

  CREATE TABLE IF NOT EXISTS saved_view (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    filter_json TEXT NOT NULL,
    position INTEGER NOT NULL,
    team_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS task_event (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    execution_task_key TEXT NOT NULL,
    event_type TEXT NOT NULL,
    source TEXT NOT NULL,
    actor TEXT,
    correlation_id TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    reversible INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS task_tag_lookup
    ON task_tag(tag, execution_task_key);
  CREATE INDEX IF NOT EXISTS saved_view_order
    ON saved_view(position, id);
  CREATE INDEX IF NOT EXISTS task_event_timeline
    ON task_event(execution_task_key, occurred_at, id);
  CREATE INDEX IF NOT EXISTS task_event_correlation
    ON task_event(correlation_id);
`;

const SCHEMA_V3_SQL = `
  CREATE TABLE IF NOT EXISTS task_dependency (
    id TEXT PRIMARY KEY,
    blocker_task_key TEXT NOT NULL,
    blocked_task_key TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_by TEXT,
    created_at TEXT NOT NULL,
    resolved_at TEXT
  );

  CREATE UNIQUE INDEX IF NOT EXISTS task_dependency_active_unique
    ON task_dependency(blocker_task_key, blocked_task_key)
    WHERE resolved_at IS NULL;

  CREATE INDEX IF NOT EXISTS task_dependency_blocked
    ON task_dependency(blocked_task_key, resolved_at);

  CREATE INDEX IF NOT EXISTS task_dependency_blocker
    ON task_dependency(blocker_task_key, resolved_at);
`;

const SCHEMA_V4_SQL = `
  CREATE TABLE IF NOT EXISTS team (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS team_member (
    team_id TEXT NOT NULL REFERENCES team(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (team_id, user_id)
  );

  CREATE INDEX IF NOT EXISTS team_member_user
    ON team_member(user_id, team_id);

  CREATE TABLE IF NOT EXISTS user_account (
    id TEXT PRIMARY KEY,
    username_key TEXT NOT NULL UNIQUE,
    username TEXT NOT NULL,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    password_params_json TEXT NOT NULL,
    system_admin INTEGER NOT NULL DEFAULT 0 CHECK (system_admin IN (0, 1)),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1)),
    password_changed_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS user_session (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL REFERENCES user_account(id),
    active_team_id TEXT REFERENCES team(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    revoked_at TEXT,
    ip TEXT,
    user_agent TEXT
  );

  CREATE TABLE IF NOT EXISTS login_attempt (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username_key TEXT NOT NULL,
    ip TEXT NOT NULL,
    succeeded INTEGER NOT NULL DEFAULT 0 CHECK (succeeded IN (0, 1)),
    occurred_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS team_project (
    repository_id TEXT PRIMARY KEY REFERENCES repositories(id) ON DELETE CASCADE,
    team_id TEXT NOT NULL REFERENCES team(id),
    workspace_key TEXT NOT NULL,
    remote_url TEXT NOT NULL,
    remote_identity_hash TEXT NOT NULL,
    sync_branch TEXT NOT NULL,
    trusted_task_toolchain_sha256 TEXT,
    sync_status TEXT NOT NULL DEFAULT 'provisioning'
      CHECK (sync_status IN (
        'provisioning', 'current', 'stale', 'pending_push',
        'needs_repair', 'disabled'
      )),
    last_fetch_at TEXT,
    last_push_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (team_id, workspace_key)
  );

  CREATE INDEX IF NOT EXISTS team_project_team
    ON team_project(team_id, sync_status);

  CREATE TABLE IF NOT EXISTS project_member (
    project_id TEXT NOT NULL REFERENCES team_project(repository_id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('lead', 'member', 'read_only')),
    trellis_dev_id TEXT COLLATE NOCASE,
    created_by TEXT REFERENCES user_account(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (project_id, user_id),
    CHECK (
      role = 'read_only' OR
      (trellis_dev_id IS NOT NULL AND length(trim(trellis_dev_id)) > 0)
    )
  );

  CREATE UNIQUE INDEX IF NOT EXISTS project_member_developer_unique
    ON project_member(project_id, trellis_dev_id COLLATE NOCASE)
    WHERE trellis_dev_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS project_member_user
    ON project_member(user_id, project_id);

  CREATE TABLE IF NOT EXISTS project_scan_cache (
    project_id TEXT PRIMARY KEY REFERENCES team_project(repository_id) ON DELETE CASCADE,
    schema_version INTEGER NOT NULL,
    scanned_content_key TEXT NOT NULL,
    scanned_branch_sha TEXT,
    saved_at TEXT NOT NULL,
    board_json TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS user_board_state (
    user_id TEXT NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
    team_id TEXT NOT NULL DEFAULT '',
    key TEXT NOT NULL,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, team_id, key)
  );

  CREATE TABLE IF NOT EXISTS task_assignment (
    execution_task_key TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES team_project(repository_id) ON DELETE CASCADE,
    assigned_user_id TEXT NOT NULL REFERENCES user_account(id),
    state TEXT NOT NULL CHECK (state IN ('pending', 'accepted')),
    assigned_by TEXT NOT NULL REFERENCES user_account(id),
    assigned_at TEXT NOT NULL,
    accepted_at TEXT,
    base_task_version TEXT,
    version INTEGER NOT NULL DEFAULT 1
  );

  CREATE INDEX IF NOT EXISTS task_assignment_assignee
    ON task_assignment(assigned_user_id, state);
  CREATE INDEX IF NOT EXISTS task_assignment_project
    ON task_assignment(project_id, state);

  CREATE TABLE IF NOT EXISTS audit_event (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_user_id TEXT REFERENCES user_account(id),
    actor_agent_id TEXT,
    team_id TEXT REFERENCES team(id),
    project_id TEXT,
    action TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT,
    result TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    detail_json TEXT NOT NULL,
    occurred_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS audit_event_project_time
    ON audit_event(project_id, occurred_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS audit_event_team_time
    ON audit_event(team_id, occurred_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS audit_event_actor_time
    ON audit_event(actor_user_id, occurred_at DESC, id DESC);

  CREATE TABLE IF NOT EXISTS git_operation (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES team_project(repository_id) ON DELETE CASCADE,
    actor_user_id TEXT NOT NULL REFERENCES user_account(id),
    operation_type TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN (
      'prepared', 'committed', 'pending_push', 'pushed', 'applied', 'failed'
    )),
    base_task_version TEXT,
    result_json TEXT NOT NULL,
    error_message TEXT,
    local_commit_sha TEXT,
    remote_commit_sha TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS git_operation_idempotency
    ON git_operation(actor_user_id, project_id, operation_type, idempotency_key);
  CREATE INDEX IF NOT EXISTS git_operation_project_status
    ON git_operation(project_id, status, created_at);

  CREATE TABLE IF NOT EXISTS agent_pairing_code (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
    team_id TEXT NOT NULL REFERENCES team(id),
    code_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS agent_device (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
    device_name TEXT NOT NULL,
    platform TEXT NOT NULL,
    agent_version TEXT NOT NULL,
    protocol_version INTEGER NOT NULL,
    credential_hash TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
    last_seen_at TEXT,
    last_heartbeat_json TEXT,
    created_at TEXT NOT NULL,
    revoked_at TEXT
  );

  CREATE INDEX IF NOT EXISTS agent_device_user
    ON agent_device(user_id, status);

  CREATE TABLE IF NOT EXISTS agent_project_binding (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agent_device(id) ON DELETE CASCADE,
    team_id TEXT NOT NULL REFERENCES team(id),
    project_id TEXT NOT NULL REFERENCES team_project(repository_id) ON DELETE CASCADE,
    local_repo_key TEXT NOT NULL,
    local_display_name TEXT,
    branch_name TEXT NOT NULL,
    sync_status TEXT NOT NULL DEFAULT 'pending',
    last_synced_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(agent_id, project_id)
  );

  CREATE INDEX IF NOT EXISTS agent_binding_project
    ON agent_project_binding(project_id, sync_status);
  CREATE INDEX IF NOT EXISTS agent_binding_team
    ON agent_project_binding(team_id, sync_status);

  CREATE TABLE IF NOT EXISTS agent_command (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agent_device(id) ON DELETE CASCADE,
    binding_id TEXT NOT NULL REFERENCES agent_project_binding(id) ON DELETE CASCADE,
    command_type TEXT NOT NULL CHECK (command_type IN ('sync_branch', 'refresh_status')),
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN (
      'pending', 'delivered', 'completed', 'failed', 'cancelled'
    )),
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    delivered_at TEXT,
    lease_expires_at TEXT,
    completed_at TEXT,
    result_json TEXT
  );

  CREATE INDEX IF NOT EXISTS agent_command_pending
    ON agent_command(agent_id, status, created_at);
  CREATE UNIQUE INDEX IF NOT EXISTS agent_command_sync_pending
    ON agent_command(agent_id, binding_id, command_type)
    WHERE status IN ('pending', 'delivered') AND command_type = 'sync_branch';

  CREATE TABLE IF NOT EXISTS team_task_index (
    project_id TEXT NOT NULL,
    task_key TEXT NOT NULL,
    execution_task_key TEXT NOT NULL,
    relative_dir TEXT NOT NULL,
    title TEXT NOT NULL,
    search_text TEXT NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
    priority TEXT NOT NULL,
    derived_stage TEXT NOT NULL,
    assignee_dev_id TEXT,
    assignee_user_id TEXT,
    due_date TEXT,
    last_activity_at TEXT,
    is_blocked INTEGER NOT NULL DEFAULT 0 CHECK (is_blocked IN (0, 1)),
    is_unblocked_ready INTEGER NOT NULL DEFAULT 0 CHECK (is_unblocked_ready IN (0, 1)),
    attention_flags_json TEXT NOT NULL,
    group_key TEXT NOT NULL,
    group_role TEXT NOT NULL,
    task_version TEXT NOT NULL,
    board_version TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (project_id, task_key)
  );

  CREATE INDEX IF NOT EXISTS team_task_assignee
    ON team_task_index(assignee_user_id, archived);
  CREATE INDEX IF NOT EXISTS team_task_stage
    ON team_task_index(derived_stage, archived, last_activity_at);
  CREATE INDEX IF NOT EXISTS team_task_priority
    ON team_task_index(priority, archived, last_activity_at);
  CREATE INDEX IF NOT EXISTS team_task_due
    ON team_task_index(due_date, archived, last_activity_at);
  CREATE INDEX IF NOT EXISTS team_task_order
    ON team_task_index(last_activity_at, task_key);

  CREATE TABLE IF NOT EXISTS team_task_index_tag (
    project_id TEXT NOT NULL,
    task_key TEXT NOT NULL,
    tag_key TEXT NOT NULL,
    PRIMARY KEY (project_id, task_key, tag_key),
    FOREIGN KEY (project_id, task_key)
      REFERENCES team_task_index(project_id, task_key) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS team_task_tag_lookup
    ON team_task_index_tag(tag_key, project_id, task_key);
`;

const SCHEMA_V5_SQL = `
  CREATE TABLE IF NOT EXISTS plugin_state (
    plugin_id  TEXT NOT NULL,
    key        TEXT NOT NULL,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (plugin_id, key)
  );

  CREATE TABLE IF NOT EXISTS plugin_run (
    run_id         TEXT PRIMARY KEY,
    plugin_id      TEXT NOT NULL,
    plugin_version TEXT,
    task_key       TEXT,
    status         TEXT NOT NULL,
    request        TEXT,
    result         TEXT,
    started_at     TEXT NOT NULL,
    finished_at    TEXT
  );

  CREATE UNIQUE INDEX IF NOT EXISTS plugin_run_active_task
    ON plugin_run(plugin_id, task_key)
    WHERE status IN ('queued', 'starting', 'running');
  CREATE INDEX IF NOT EXISTS plugin_run_task
    ON plugin_run(plugin_id, task_key, started_at);
  CREATE INDEX IF NOT EXISTS plugin_run_status
    ON plugin_run(status, started_at);

  CREATE TABLE IF NOT EXISTS plugin_audit (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    plugin_id      TEXT NOT NULL,
    plugin_version TEXT,
    kind           TEXT NOT NULL,
    detail         TEXT,
    created_at     TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS plugin_audit_timeline
    ON plugin_audit(plugin_id, created_at, id);
`;

function ensureV2Schema(db, now) {
  db.exec(SCHEMA_V2_SQL);
  if (readMeta(db, EXECUTION_EVENTS_STARTED_KEY) == null) {
    writeMeta(db, EXECUTION_EVENTS_STARTED_KEY, now);
  }
}

function ensureV3Schema(db) {
  db.exec(SCHEMA_V3_SQL);
}

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all()
    .some((item) => item.name === column);
}

function ensureV4Schema(db) {
  db.exec(SCHEMA_V4_SQL);
  if (!hasColumn(db, "saved_view", "owner_user_id")) {
    db.exec("ALTER TABLE saved_view ADD COLUMN owner_user_id TEXT REFERENCES user_account(id)");
  }
  if (!hasColumn(db, "task_event", "actor_user_id")) {
    db.exec("ALTER TABLE task_event ADD COLUMN actor_user_id TEXT REFERENCES user_account(id)");
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS saved_view_owner_order
      ON saved_view(owner_user_id, position, id);
    CREATE INDEX IF NOT EXISTS task_event_actor_timeline
      ON task_event(actor_user_id, execution_task_key, occurred_at, id);
  `);
}

function ensureV5Schema(db) {
  db.exec(SCHEMA_V5_SQL);
}

const SCHEMA_V6_SQL = `
  CREATE TABLE IF NOT EXISTS agent_event_cursor (
    agent_id TEXT NOT NULL REFERENCES agent_device(id) ON DELETE CASCADE,
    team_id TEXT NOT NULL REFERENCES team(id) ON DELETE CASCADE,
    last_event_id INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (agent_id, team_id)
  );

  CREATE TABLE IF NOT EXISTS agent_event (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id TEXT NOT NULL REFERENCES team(id) ON DELETE CASCADE,
    project_id TEXT,
    type TEXT NOT NULL,
    target_agent_id TEXT REFERENCES agent_device(id) ON DELETE CASCADE,
    target_user_id TEXT REFERENCES user_account(id) ON DELETE CASCADE,
    task_id TEXT,
    task_version TEXT,
    dedupe_key TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS agent_event_dedupe
    ON agent_event(team_id, dedupe_key);
  CREATE INDEX IF NOT EXISTS agent_event_stream
    ON agent_event(team_id, target_agent_id, id);
  CREATE INDEX IF NOT EXISTS agent_event_expiry
    ON agent_event(expires_at);
`;

function ensureV6Schema(db) {
  db.exec(SCHEMA_V6_SQL);
  db.exec(`
    CREATE INDEX IF NOT EXISTS saved_view_team_owner_order
      ON saved_view(team_id, owner_user_id, position, id);
  `);
}

function ensureSchema(db) {
  withTransaction(db, () => {
    db.exec(BASE_SCHEMA_V1_SQL);
    const schemaVersion = readMeta(db, "schema_version");
    if (schemaVersion == null) {
      ensureV2Schema(db, new Date().toISOString());
      ensureV3Schema(db);
      ensureV4Schema(db);
      ensureV5Schema(db);
      ensureV6Schema(db);
      writeMeta(db, "schema_version", DATABASE_SCHEMA_VERSION);
      return;
    }
    if (Number(schemaVersion) === DATABASE_SCHEMA_VERSION) {
      ensureV2Schema(db, new Date().toISOString());
      ensureV3Schema(db);
      ensureV4Schema(db);
      ensureV5Schema(db);
      ensureV6Schema(db);
      return;
    }
    throw new Error(
      `不支持的数据库 schema 版本: ${schemaVersion}；本版本不做旧库迁移，请删除 data/board.sqlite 后重建`
    );
  });
}


function importRepositories(db, legacyFile, fallbackRepositories, logger) {
  const legacy = readLegacyJson(legacyFile, "data/repos.json", logger);
  let entries;
  if (!legacy.exists) {
    entries = fallbackRepositories.map((repoPath) => ({ path: repoPath }));
  } else if (!legacy.value) {
    return;
  } else if (!Array.isArray(legacy.value.repositories)) {
    logger.warn("跳过结构无效的旧数据 data/repos.json: 缺少 repositories 数组");
    return;
  } else {
    entries = legacy.value.repositories;
  }

  const now = new Date().toISOString();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO repositories(
      id, name, path, path_key, position, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  let position = 0;
  entries.forEach((entry, sourceIndex) => {
    try {
      const repository = normalizeRepositoryEntry(entry);
      const result = insert.run(
        repository.id,
        repository.name,
        repository.path,
        repositoryPathKey(repository.path),
        position,
        now,
        now
      );
      if (result.changes > 0) position += 1;
    } catch (error) {
      logger.warn(`跳过无效的旧项目记录 data/repos.json[${sourceIndex}]: ${errorMessage(error)}`);
    }
  });
}

function importManualStages(db, legacyFile, logger) {
  const legacy = readLegacyJson(legacyFile, "data/task-metadata.json", logger);
  if (!legacy.value || typeof legacy.value.tasks !== "object" || !legacy.value.tasks) return;

  const now = new Date().toISOString();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO task_stage(task_key, stage, updated_at)
    VALUES (?, ?, ?)
  `);
  for (const [taskKey, record] of Object.entries(legacy.value.tasks)) {
    const stage = String(record?.stage || "").trim();
    if (!taskKey || !stage) continue;
    const updatedAt = typeof record?.updatedAt === "string" ? record.updatedAt : now;
    insert.run(taskKey, stage, updatedAt);
  }
}

function importScanCache(db, legacyFile, logger) {
  const legacy = readLegacyJson(legacyFile, "data/scan-cache.json", logger);
  const board = legacy.value?.board;
  if (!board || typeof board !== "object" || Array.isArray(board)) return;
  const schemaVersion = Number(legacy.value.schemaVersion);
  if (!Number.isInteger(schemaVersion)) {
    logger.warn("跳过结构无效的旧数据 data/scan-cache.json: schemaVersion 不是整数");
    return;
  }
  const savedAt = typeof legacy.value.savedAt === "string"
    ? legacy.value.savedAt
    : new Date().toISOString();
  db.prepare(`
    INSERT INTO scan_cache(id, schema_version, saved_at, board_json)
    VALUES (1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      schema_version = excluded.schema_version,
      saved_at = excluded.saved_at,
      board_json = excluded.board_json
  `).run(schemaVersion, savedAt, JSON.stringify(board));
}

function importBoardState(db, legacyFile, logger) {
  const legacy = readLegacyJson(legacyFile, "data/board-state.json", logger);
  if (!legacy.value || Array.isArray(legacy.value) || typeof legacy.value !== "object") return;

  const now = new Date().toISOString();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO board_state(key, value_json, updated_at)
    VALUES (?, ?, ?)
  `);
  for (const [key, value] of Object.entries(legacy.value)) {
    insert.run(key, JSON.stringify(value), now);
  }
}

function importLegacyData(
  db,
  legacyFiles,
  fallbackRepositories,
  logger,
  importLegacyRepositories = true
) {
  withTransaction(db, () => {
    if (readMeta(db, LEGACY_IMPORT_KEY) === "1") return;
    if (importLegacyRepositories) {
      importRepositories(db, legacyFiles.repositoriesFile, fallbackRepositories, logger);
    }
    importManualStages(db, legacyFiles.metadataFile, logger);
    importScanCache(db, legacyFiles.scanCacheFile, logger);
    importBoardState(db, legacyFiles.stateFile, logger);
    writeMeta(db, LEGACY_IMPORT_KEY, 1);
  });
}

export function withTransaction(db, callback) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = callback();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // 保留原始失败，避免回滚错误覆盖真正原因。
    }
    throw error;
  }
}

export function openDatabase({
  databaseFile = defaultDatabaseFile,
  legacyFiles = {},
  fallbackRepositories = [],
  importLegacyRepositories = true,
  legacyJsonImport = true,
  logger = console
} = {}) {
  if (databaseFile !== ":memory:") {
    fs.mkdirSync(path.dirname(databaseFile), { recursive: true });
  }

  const db = new DatabaseSync(databaseFile);
  try {
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    ensureSchema(db);
    if (legacyJsonImport) {
      importLegacyData(db, {
        repositoriesFile,
        metadataFile,
        scanCacheFile,
        stateFile,
        ...legacyFiles
      }, fallbackRepositories, logger, importLegacyRepositories);
    }
    return db;
  } catch (error) {
    try {
      db.close();
    } catch {
      // 打开阶段失败时不再覆盖原始异常。
    }
    throw error;
  }
}

export function getDefaultDatabase() {
  if (!defaultDatabase) {
    defaultDatabase = openDatabase();
  }
  return defaultDatabase;
}
