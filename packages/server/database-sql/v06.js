export const SCHEMA_V6_SQL = `
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
`
