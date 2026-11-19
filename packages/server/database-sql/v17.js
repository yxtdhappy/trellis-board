export const SCHEMA_V17_SQL = `
  CREATE TABLE IF NOT EXISTS sync_task_ownership_inbox (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES sync_project(id) ON DELETE CASCADE,
    source_task_space_id TEXT NOT NULL REFERENCES sync_task_space(id) ON DELETE CASCADE,
    source_agent_id TEXT NOT NULL REFERENCES agent_device(id) ON DELETE CASCADE,
    source_user_id TEXT NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
    task_id TEXT NOT NULL CHECK (
      length(task_id) BETWEEN 1 AND 128 AND task_id NOT LIKE '%/%'
    ),
    task_dir TEXT NOT NULL CHECK (
      length(task_dir) BETWEEN 1 AND 512
      AND task_dir GLOB '.trellis/tasks/*'
      AND task_dir NOT LIKE '.trellis/tasks/archive/%'
    ),
    title TEXT NOT NULL CHECK (
      length(trim(title)) BETWEEN 1 AND 300
    ),
    reason TEXT NOT NULL CHECK (
      length(reason) BETWEEN 1 AND 128
    ),
    source_branch_name TEXT NOT NULL CHECK (
      length(source_branch_name) BETWEEN 1 AND 512
    ),
    fingerprint TEXT NOT NULL CHECK (
      length(fingerprint) = 64
      AND fingerprint GLOB '[0-9a-f]*'
      AND fingerprint NOT GLOB '*[^0-9a-f]*'
    ),
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(source_task_space_id, source_agent_id, task_id)
  );

  CREATE INDEX IF NOT EXISTS sync_task_ownership_inbox_project_task
    ON sync_task_ownership_inbox(project_id, task_id, last_seen_at DESC);
  CREATE INDEX IF NOT EXISTS sync_task_ownership_inbox_source
    ON sync_task_ownership_inbox(source_task_space_id, source_agent_id);
`
