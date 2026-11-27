import fs from 'node:fs'
import path from 'node:path'
import {
  DATABASE_SCHEMA_VERSION,
  SCHEMA_V2_SQL,
  SCHEMA_V3_SQL,
  SCHEMA_V4_SQL,
  SCHEMA_V5_SQL,
  SCHEMA_V6_SQL,
  SCHEMA_V7_SQL,
  SCHEMA_V11_SQL,
  SCHEMA_V13_SQL,
  SCHEMA_V14_SQL,
  SCHEMA_V15_SQL,
  SCHEMA_V16_SQL,
  SCHEMA_V17_SQL,
  SCHEMA_V18_TASK_OWNERSHIP_INBOX_COLUMNS,
  SCHEMA_V19_TASK_SPACE_COLUMNS,
  hasColumn,
  rebuildTaskCommandTableForV16,
} from './database-sql/index.js'
import { EXECUTION_EVENTS_STARTED_KEY, readMeta, writeMeta } from './database-meta.js'

export function ensureV2Schema(db, now) {
  db.exec(SCHEMA_V2_SQL)
  if (readMeta(db, EXECUTION_EVENTS_STARTED_KEY) == null) {
    writeMeta(db, EXECUTION_EVENTS_STARTED_KEY, now)
  }
}

export function ensureV3Schema(db) {
  db.exec(SCHEMA_V3_SQL)
}

export function ensureV4Schema(db) {
  db.exec(SCHEMA_V4_SQL)
  if (!hasColumn(db, 'saved_view', 'owner_user_id')) {
    db.exec('ALTER TABLE saved_view ADD COLUMN owner_user_id TEXT REFERENCES user_account(id)')
  }
  if (!hasColumn(db, 'task_event', 'actor_user_id')) {
    db.exec('ALTER TABLE task_event ADD COLUMN actor_user_id TEXT REFERENCES user_account(id)')
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS saved_view_owner_order
      ON saved_view(owner_user_id, position, id);
    CREATE INDEX IF NOT EXISTS task_event_actor_timeline
      ON task_event(actor_user_id, execution_task_key, occurred_at, id);
  `)
}

export function ensureV5Schema(db) {
  db.exec(SCHEMA_V5_SQL)
}

export function ensureV6Schema(db) {
  db.exec(SCHEMA_V6_SQL)
  db.exec(`
    CREATE INDEX IF NOT EXISTS saved_view_team_owner_order
      ON saved_view(team_id, owner_user_id, position, id);
  `)
}

export function ensureV7Schema(db) {
  db.exec(SCHEMA_V7_SQL)
  if (!hasColumn(db, 'team_task_index', 'live_revision')) {
    db.exec(`
      ALTER TABLE team_task_index
      ADD COLUMN live_revision INTEGER NOT NULL DEFAULT 0
    `)
  }
  if (!hasColumn(db, 'project_live_file', 'source_client_sequence')) {
    db.exec(`
      ALTER TABLE project_live_file
      ADD COLUMN source_client_sequence INTEGER
    `)
  }
  if (!hasColumn(db, 'project_live_batch', 'client_sequence')) {
    db.exec(`
      ALTER TABLE project_live_batch
      ADD COLUMN client_sequence INTEGER
    `)
  }
  if (!hasColumn(db, 'team_project', 'git_credential_id')) {
    db.exec(`
      ALTER TABLE team_project
      ADD COLUMN git_credential_id TEXT REFERENCES git_credential(id) ON DELETE RESTRICT
    `)
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS team_project_credential
      ON team_project(git_credential_id);
  `)
}

export function ensureV8Schema(db) {
  if (!hasColumn(db, 'team_project', 'agent_tools_json')) {
    db.exec(`
      ALTER TABLE team_project
      ADD COLUMN agent_tools_json TEXT NOT NULL DEFAULT '[]'
    `)
  }
  if (!hasColumn(db, 'team_project', 'bootstrap_lead_user_id')) {
    db.exec(`
      ALTER TABLE team_project
      ADD COLUMN bootstrap_lead_user_id TEXT
    `)
  }
  if (!hasColumn(db, 'team_project', 'bootstrap_lead_trellis_dev_id')) {
    db.exec(`
      ALTER TABLE team_project
      ADD COLUMN bootstrap_lead_trellis_dev_id TEXT
    `)
  }
}

export function ensureV9Schema(db) {
  if (!hasColumn(db, 'team_task_index', 'archived_at')) {
    db.exec(`
      ALTER TABLE team_task_index
      ADD COLUMN archived_at TEXT
    `)
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS team_task_archive_order
      ON team_task_index(archived, archived_at DESC, project_id DESC, task_key DESC);

    UPDATE team_task_index
    SET archived_at = (
      SELECT json_extract(item.value, '$.archivedAt')
      FROM project_scan_cache cache,
        json_each(
          CASE
            WHEN json_valid(cache.board_json) THEN cache.board_json
            ELSE '{"tasks":[]}'
          END,
          '$.tasks'
        ) item
      WHERE cache.project_id = team_task_index.project_id
        AND json_extract(item.value, '$.taskKey') = team_task_index.task_key
        AND json_extract(item.value, '$.archived') = 1
      LIMIT 1
    )
    WHERE archived = 1 AND archived_at IS NULL;
  `)
}

export function ensureV11Schema(db) {
  db.exec(SCHEMA_V11_SQL)
  const columns = new Set(
    db
      .prepare('PRAGMA table_info(sync_agent_binding)')
      .all()
      .map((column) => column.name),
  )
  if (!columns.has('is_listening')) {
    db.exec(
      'ALTER TABLE sync_agent_binding ADD COLUMN is_listening INTEGER NOT NULL DEFAULT 0 CHECK (is_listening IN (0, 1))',
    )
  }
  if (!columns.has('listener_reported_at')) {
    db.exec('ALTER TABLE sync_agent_binding ADD COLUMN listener_reported_at TEXT')
  }
  if (!columns.has('last_listener_at')) {
    db.exec('ALTER TABLE sync_agent_binding ADD COLUMN last_listener_at TEXT')
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS sync_agent_binding_listener
      ON sync_agent_binding(task_space_id, sync_status, is_listening);
  `)
}

export function ensureV12Schema(db) {
  const taskSpaceColumns = new Set(
    db
      .prepare('PRAGMA table_info(sync_task_space)')
      .all()
      .map((column) => column.name),
  )
  for (const [name, definition] of [
    ['retired_at', 'TEXT'],
    ['retired_by_user_id', 'TEXT REFERENCES user_account(id)'],
    ['retired_reason', 'TEXT'],
  ]) {
    if (!taskSpaceColumns.has(name)) {
      db.exec(`ALTER TABLE sync_task_space ADD COLUMN ${name} ${definition}`)
    }
  }
  const projectColumns = new Set(
    db
      .prepare('PRAGMA table_info(sync_project)')
      .all()
      .map((column) => column.name),
  )
  if (!projectColumns.has('baseline_branch')) {
    db.exec("ALTER TABLE sync_project ADD COLUMN baseline_branch TEXT NOT NULL DEFAULT ''")
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS sync_task_space_retired
      ON sync_task_space(project_id, retired_at, status);

    CREATE INDEX IF NOT EXISTS sync_task_space_file_task_id
      ON sync_task_space_file(task_space_id, task_id, deleted);

    CREATE TABLE IF NOT EXISTS sync_task_merge_evidence (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES sync_project(id) ON DELETE CASCADE,
      task_id TEXT NOT NULL,
      execution_task_key TEXT NOT NULL,
      baseline_task_space_id TEXT NOT NULL REFERENCES sync_task_space(id) ON DELETE CASCADE,
      task_dir TEXT NOT NULL,
      tracked_path TEXT NOT NULL,
      source_branch_name TEXT NOT NULL,
      baseline_branch_name TEXT NOT NULL,
      evidence_type TEXT NOT NULL CHECK (evidence_type = 'tracked-in-head'),
      head_commit TEXT NOT NULL,
      source_agent_id TEXT REFERENCES agent_device(id) ON DELETE SET NULL,
      source_user_id TEXT REFERENCES user_account(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      UNIQUE(project_id, task_id)
    );

    CREATE INDEX IF NOT EXISTS sync_task_merge_evidence_space
      ON sync_task_merge_evidence(baseline_task_space_id, task_id);
    CREATE INDEX IF NOT EXISTS sync_task_merge_evidence_execution
      ON sync_task_merge_evidence(project_id, execution_task_key);

    UPDATE sync_project
    SET baseline_branch = COALESCE((
      SELECT s.branch_name
      FROM sync_task_space s
      WHERE s.project_id = sync_project.id
      ORDER BY
        CASE WHEN s.status = 'active' THEN 0 ELSE 1 END,
        s.created_at,
        s.id
      LIMIT 1
    ), '')
    WHERE baseline_branch = '';
  `)
}

export function ensureV13Schema(db) {
  db.exec(SCHEMA_V13_SQL)
  const runColumns = new Set(
    db
      .prepare('PRAGMA table_info(plugin_run)')
      .all()
      .map((column) => column.name),
  )
  if (!runColumns.has('user_id')) db.exec('ALTER TABLE plugin_run ADD COLUMN user_id TEXT')
  if (!runColumns.has('team_id')) db.exec('ALTER TABLE plugin_run ADD COLUMN team_id TEXT')
  const auditColumns = new Set(
    db
      .prepare('PRAGMA table_info(plugin_audit)')
      .all()
      .map((column) => column.name),
  )
  if (!auditColumns.has('user_id')) db.exec('ALTER TABLE plugin_audit ADD COLUMN user_id TEXT')
  if (!auditColumns.has('team_id')) db.exec('ALTER TABLE plugin_audit ADD COLUMN team_id TEXT')
  db.exec(`
    CREATE INDEX IF NOT EXISTS plugin_run_user
      ON plugin_run(user_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS plugin_audit_user
      ON plugin_audit(user_id, created_at DESC);
  `)
}

export function ensureV14Schema(db) {
  db.exec(SCHEMA_V14_SQL)
  for (const [name, definition] of [
    ['archive_revision', 'INTEGER NOT NULL DEFAULT 0'],
    ['archive_indexed_revision', 'INTEGER NOT NULL DEFAULT 0'],
  ]) {
    if (!hasColumn(db, 'sync_task_space', name)) {
      db.exec(`ALTER TABLE sync_task_space ADD COLUMN ${name} ${definition}`)
    }
  }
  if (!hasColumn(db, 'sync_task_space_scan_cache', 'indexed_archive_revision')) {
    db.exec(`
      ALTER TABLE sync_task_space_scan_cache
      ADD COLUMN indexed_archive_revision INTEGER NOT NULL DEFAULT 0
    `)
  }
  if (!hasColumn(db, 'sync_task_space_scan_cache', 'projection_state_json')) {
    db.exec(`
      ALTER TABLE sync_task_space_scan_cache
      ADD COLUMN projection_state_json TEXT
    `)
  }

  const now = new Date().toISOString()
  db.prepare(`
    INSERT OR IGNORE INTO sync_archive_sync_config(
      id, enabled, interval_seconds, updated_by_user_id, updated_at
    ) VALUES (1, 1, 300, NULL, ?)
  `).run(now)

  db.prepare(`
    INSERT OR IGNORE INTO sync_archive_file(
      task_space_id, relative_path, blob_oid, sha256, content_text,
      task_id, task_dir, source_head, updated_at
    )
    SELECT
      task_space_id, relative_path, 'legacy', sha256, COALESCE(content_text, ''),
      task_id, task_dir, NULL, updated_at
    FROM sync_task_space_file
    WHERE deleted = 0 AND task_dir LIKE '.trellis/tasks/archive/%'
  `).run()

  db.exec(`
    DELETE FROM sync_task_space_file
    WHERE task_dir LIKE '.trellis/tasks/archive/%'
      OR relative_path LIKE '.trellis/tasks/archive/%';

    UPDATE sync_conflict
    SET status = 'resolved', resolved_at = COALESCE(resolved_at, '${now}')
    WHERE status = 'pending'
      AND (
        task_dir LIKE '.trellis/tasks/archive/%'
        OR files_json LIKE '%.trellis/tasks/archive/%'
      );
  `)
}

export function ensureV15Schema(db) {
  db.exec(SCHEMA_V15_SQL)
  for (const [name, definition] of [
    ['id', 'TEXT'],
    ['size_bytes', 'INTEGER NOT NULL DEFAULT 0'],
    ['mime_type', "TEXT NOT NULL DEFAULT 'application/octet-stream'"],
    ['storage_key', 'TEXT'],
    ['text_excerpt', 'TEXT'],
    ['snapshot_id', 'TEXT REFERENCES sync_archive_snapshot(id) ON DELETE CASCADE'],
  ]) {
    if (!hasColumn(db, 'sync_archive_file', name)) {
      db.exec(`ALTER TABLE sync_archive_file ADD COLUMN ${name} ${definition}`)
    }
  }
  if (!hasColumn(db, 'sync_archive_snapshot', 'active')) {
    db.exec(`
      ALTER TABLE sync_archive_snapshot
      ADD COLUMN active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
    `)
  }
  for (const name of ['archive_snapshot_id', 'archive_candidate_snapshot_id']) {
    if (!hasColumn(db, 'sync_task_space', name)) {
      db.exec(`
        ALTER TABLE sync_task_space
        ADD COLUMN ${name} TEXT REFERENCES sync_archive_snapshot(id) ON DELETE RESTRICT
      `)
    }
  }
  db.exec(`
    UPDATE sync_archive_file
    SET id = 'legacy-' || lower(hex(randomblob(16)))
    WHERE id IS NULL OR id = '';

    UPDATE sync_archive_file
    SET size_bytes = length(CAST(content_text AS BLOB))
    WHERE size_bytes = 0 AND length(content_text) > 0;

    CREATE UNIQUE INDEX IF NOT EXISTS sync_archive_file_id_unique
      ON sync_archive_file(id);

    CREATE INDEX IF NOT EXISTS sync_archive_file_id
      ON sync_archive_file(id);

    CREATE INDEX IF NOT EXISTS sync_archive_file_storage
      ON sync_archive_file(task_space_id, storage_key);

    CREATE INDEX IF NOT EXISTS sync_archive_snapshot_active
      ON sync_archive_snapshot(task_space_id, active, published_at DESC);

    CREATE UNIQUE INDEX IF NOT EXISTS sync_archive_snapshot_one_active
      ON sync_archive_snapshot(task_space_id)
      WHERE active = 1;

    CREATE INDEX IF NOT EXISTS sync_archive_file_snapshot
      ON sync_archive_file(task_space_id, snapshot_id);

    UPDATE sync_task_space
    SET archive_snapshot_id = (
      SELECT snapshot.id
      FROM sync_archive_snapshot snapshot
      WHERE snapshot.task_space_id = sync_task_space.id
        AND snapshot.status = 'published'
        AND snapshot.active = 1
      ORDER BY snapshot.published_at DESC, snapshot.id DESC
      LIMIT 1
    )
    WHERE archive_snapshot_id IS NULL
      AND EXISTS (
        SELECT 1
        FROM sync_archive_snapshot snapshot
        WHERE snapshot.task_space_id = sync_task_space.id
          AND snapshot.status = 'published'
          AND snapshot.active = 1
      );

    UPDATE sync_archive_snapshot
    SET active = CASE
      WHEN id = (
        SELECT task_space.archive_snapshot_id
        FROM sync_task_space task_space
        WHERE task_space.id = sync_archive_snapshot.task_space_id
      ) THEN 1
      ELSE 0
    END;

    UPDATE sync_archive_file
    SET snapshot_id = (
      SELECT task_space.archive_snapshot_id
      FROM sync_task_space task_space
      WHERE task_space.id = sync_archive_file.task_space_id
    )
    WHERE snapshot_id IS NULL
      AND storage_key IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM sync_task_space task_space
        WHERE task_space.id = sync_archive_file.task_space_id
          AND task_space.archive_snapshot_id IS NOT NULL
      );
  `)
}

export function ensureV16Schema(db) {
  db.exec(SCHEMA_V16_SQL)
  rebuildTaskCommandTableForV16(db)
  db.exec(`
    INSERT OR IGNORE INTO sync_task(
      execution_task_key, task_key, task_space_id, project_id, task_id,
      relative_dir, title, description, priority, created_by_user_id,
      assignee_user_id, assignee_dev_id, stage, archived,
      materialization_state, task_version, content_revision, created_at,
      updated_at, archived_at
    )
    SELECT
      task_index.execution_task_key,
      task_index.task_key,
      task_index.task_space_id,
      task_index.project_id,
      substr(task_index.execution_task_key, instr(task_index.execution_task_key, '::') + 2),
      task_index.relative_dir,
      task_index.title,
      '',
      task_index.priority,
      COALESCE(
        task_index.assignee_user_id,
        project.created_by_user_id,
        (SELECT member.user_id FROM sync_project_member member
         WHERE member.project_id = task_index.project_id
         ORDER BY CASE member.role WHEN 'lead' THEN 0 ELSE 1 END, member.created_at
         LIMIT 1)
      ),
      task_index.assignee_user_id,
      task_index.assignee_dev_id,
      task_index.derived_stage,
      task_index.archived,
      'materialized',
      1,
      NULL,
      task_index.updated_at,
      task_index.updated_at,
      CASE WHEN task_index.archived = 1
        THEN COALESCE(task_index.archived_at, task_index.updated_at) END
    FROM sync_task_index task_index
    JOIN sync_project project ON project.id = task_index.project_id
    WHERE task_index.rowid = (
      SELECT chosen.rowid
      FROM sync_task_index chosen
      WHERE chosen.task_space_id = task_index.task_space_id
        AND chosen.execution_task_key = task_index.execution_task_key
      ORDER BY chosen.archived DESC,
        COALESCE(chosen.archived_at, chosen.updated_at) DESC,
        chosen.task_key DESC
      LIMIT 1
    );
  `)
}

export function ensureV17Schema(db) {
  db.exec(SCHEMA_V17_SQL)
}

export function ensureV18Schema(db) {
  for (const [name, definition] of SCHEMA_V18_TASK_OWNERSHIP_INBOX_COLUMNS) {
    if (!hasColumn(db, 'sync_task_ownership_inbox', name)) {
      db.exec(`ALTER TABLE sync_task_ownership_inbox ADD COLUMN ${name} ${definition}`)
    }
  }
}

export function ensureV19Schema(db) {
  for (const [name, definition] of SCHEMA_V19_TASK_SPACE_COLUMNS) {
    if (!hasColumn(db, 'sync_task_space', name)) {
      db.exec(`ALTER TABLE sync_task_space ADD COLUMN ${name} ${definition}`)
    }
  }
}

export function backupBeforeUpgrade(db, databaseFile) {
  if (!databaseFile || databaseFile === ':memory:') return null
  const backupDir = path.join(path.dirname(databaseFile), 'backups')
  fs.mkdirSync(backupDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupFile = path.join(backupDir, `board.sqlite.pre-v${DATABASE_SCHEMA_VERSION}.${stamp}`)
  const quoted = backupFile.replaceAll("'", "''")
  db.exec(`VACUUM INTO '${quoted}'`)
  return backupFile
}
