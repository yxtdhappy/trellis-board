export const SCHEMA_V5_SQL = `
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
`
