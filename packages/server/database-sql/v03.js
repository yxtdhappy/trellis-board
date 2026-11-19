export const SCHEMA_V3_SQL = `
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
`
