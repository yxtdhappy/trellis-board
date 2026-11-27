export const DATABASE_SCHEMA_VERSION = 19

export { BASE_SCHEMA_V1_SQL } from './v01-base.js'
export { SCHEMA_V2_SQL } from './v02.js'
export { SCHEMA_V3_SQL } from './v03.js'
export { SCHEMA_V4_SQL } from './v04.js'
export { SCHEMA_V5_SQL } from './v05.js'
export { SCHEMA_V6_SQL } from './v06.js'
export { SCHEMA_V7_SQL } from './v07.js'
export { SCHEMA_V11_SQL } from './v11.js'
export { SCHEMA_V13_SQL } from './v13.js'
export { SCHEMA_V14_SQL } from './v14.js'
export { SCHEMA_V15_SQL } from './v15.js'
export { SCHEMA_V16_SQL } from './v16.js'
export { SCHEMA_V17_SQL } from './v17.js'
export { SCHEMA_V18_SQL, SCHEMA_V18_TASK_OWNERSHIP_INBOX_COLUMNS } from './v18.js'
export { SCHEMA_V19_SQL, SCHEMA_V19_TASK_SPACE_COLUMNS } from './v19.js'

export function hasColumn(db, table, column) {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((item) => item.name === column)
}

export function tableExists(db, table) {
  return Boolean(
    db
      .prepare(`
    SELECT 1
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
  `)
      .get(table),
  )
}

export function rebuildTaskCommandTableForV16(db) {
  const columns = db.prepare('PRAGMA table_info(sync_task_command)').all()
  const byName = new Map(columns.map((column) => [column.name, column]))
  if (
    byName.has('target_user_id') &&
    Number(byName.get('agent_id')?.notnull || 0) === 0 &&
    Number(byName.get('binding_id')?.notnull || 0) === 0
  ) {
    return
  }

  db.exec(`
    DROP INDEX IF EXISTS sync_task_command_agent_pending;
    DROP INDEX IF EXISTS sync_task_command_task_space_time;
    ALTER TABLE sync_task_command RENAME TO sync_task_command_v15;
  `)
  db.exec(`
    CREATE TABLE sync_task_command (
      id TEXT PRIMARY KEY,
      task_space_id TEXT NOT NULL REFERENCES sync_task_space(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES sync_project(id) ON DELETE CASCADE,
      target_user_id TEXT NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
      agent_id TEXT REFERENCES agent_device(id) ON DELETE SET NULL,
      binding_id TEXT REFERENCES sync_agent_binding(id) ON DELETE SET NULL,
      command_type TEXT NOT NULL CHECK (
        command_type IN ('create_task', 'assign_task', 'sync_branch', 'refresh_status')
      ),
      idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (
        status IN ('pending', 'delivered', 'running', 'succeeded', 'failed', 'cancelled')
      ),
      attempts INTEGER NOT NULL DEFAULT 0,
      lease_expires_at TEXT,
      result_json TEXT,
      error_text TEXT,
      created_by_user_id TEXT NOT NULL REFERENCES user_account(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(created_by_user_id, command_type, idempotency_key)
    );

    INSERT INTO sync_task_command(
      id, task_space_id, project_id, target_user_id, agent_id, binding_id,
      command_type, idempotency_key, request_hash, payload_json, status,
      attempts, lease_expires_at, result_json, error_text,
      created_by_user_id, created_at, updated_at
    )
    SELECT
      command.id,
      command.task_space_id,
      command.project_id,
      COALESCE(
        (SELECT agent.user_id FROM agent_device agent WHERE agent.id = command.agent_id),
        command.created_by_user_id
      ),
      command.agent_id,
      command.binding_id,
      command.command_type,
      command.idempotency_key,
      command.request_hash,
      command.payload_json,
      command.status,
      command.attempts,
      command.lease_expires_at,
      command.result_json,
      command.error_text,
      command.created_by_user_id,
      command.created_at,
      command.updated_at
    FROM sync_task_command_v15 command;

    DROP TABLE sync_task_command_v15;

    CREATE INDEX sync_task_command_agent_pending
      ON sync_task_command(agent_id, status, created_at);
    CREATE INDEX sync_task_command_target_pending
      ON sync_task_command(target_user_id, status, created_at);
    CREATE INDEX sync_task_command_task_space_time
      ON sync_task_command(task_space_id, created_at DESC);
  `)
}
