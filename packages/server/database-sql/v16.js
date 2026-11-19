export const SCHEMA_V16_SQL = `
  CREATE TABLE IF NOT EXISTS sync_task (
    execution_task_key TEXT PRIMARY KEY,
    task_key TEXT NOT NULL,
    task_space_id TEXT NOT NULL REFERENCES sync_task_space(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES sync_project(id) ON DELETE CASCADE,
    task_id TEXT NOT NULL,
    relative_dir TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    priority TEXT NOT NULL,
    created_by_user_id TEXT REFERENCES user_account(id) ON DELETE SET NULL,
    assignee_user_id TEXT REFERENCES user_account(id) ON DELETE SET NULL,
    assignee_dev_id TEXT,
    stage TEXT NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
    materialization_state TEXT NOT NULL DEFAULT 'pending' CHECK (
      materialization_state IN ('none', 'pending', 'claimed', 'materialized', 'failed')
    ),
    task_version INTEGER NOT NULL DEFAULT 1,
    content_revision INTEGER,
    lease_id TEXT,
    previous_assignee_user_id TEXT REFERENCES user_account(id) ON DELETE SET NULL,
    handoff_state TEXT NOT NULL DEFAULT 'none' CHECK (
      handoff_state IN (
        'none', 'handoff_pending', 'target_materializing',
        'source_cleanup_pending', 'source_cleanup_conflict', 'completed'
      )
    ),
    materialized_by_agent_id TEXT REFERENCES agent_device(id) ON DELETE SET NULL,
    materialized_at TEXT,
    materialized_revision INTEGER,
    materialized_manifest_sha256 TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT,
    UNIQUE(task_space_id, task_id)
  );

  CREATE INDEX IF NOT EXISTS sync_task_project_assignee
    ON sync_task(project_id, assignee_user_id, archived);
  CREATE INDEX IF NOT EXISTS sync_task_space_assignee
    ON sync_task(task_space_id, assignee_user_id, archived);
  CREATE INDEX IF NOT EXISTS sync_task_creator
    ON sync_task(created_by_user_id, archived);
  CREATE INDEX IF NOT EXISTS sync_task_materialization
    ON sync_task(task_space_id, materialization_state, archived);

  CREATE TABLE IF NOT EXISTS sync_task_lease (
    id TEXT PRIMARY KEY,
    execution_task_key TEXT NOT NULL REFERENCES sync_task(execution_task_key) ON DELETE CASCADE,
    agent_id TEXT NOT NULL REFERENCES agent_device(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
    lease_token TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'released', 'expired', 'revoked')),
    expires_at TEXT NOT NULL,
    last_heartbeat_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS sync_task_lease_one_active
    ON sync_task_lease(execution_task_key)
    WHERE status = 'active';
  CREATE INDEX IF NOT EXISTS sync_task_lease_agent
    ON sync_task_lease(agent_id, status, expires_at);
  CREATE INDEX IF NOT EXISTS sync_task_lease_user
    ON sync_task_lease(user_id, status, expires_at);
  CREATE INDEX IF NOT EXISTS sync_task_lease_task
    ON sync_task_lease(execution_task_key, created_at DESC);
`
