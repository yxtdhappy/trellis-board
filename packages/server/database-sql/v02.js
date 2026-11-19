export const SCHEMA_V2_SQL = `
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
`
