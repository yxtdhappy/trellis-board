export const SCHEMA_V7_SQL = `
  CREATE TABLE IF NOT EXISTS project_live_revision (
    project_id TEXT PRIMARY KEY REFERENCES team_project(repository_id) ON DELETE CASCADE,
    revision INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS project_live_file (
    project_id TEXT NOT NULL REFERENCES team_project(repository_id) ON DELETE CASCADE,
    relative_path TEXT NOT NULL,
    revision INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    content_text TEXT,
    deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
    task_key TEXT,
    source_agent_id TEXT,
    source_user_id TEXT,
    source_client_sequence INTEGER,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (project_id, relative_path)
  );

  CREATE INDEX IF NOT EXISTS project_live_file_revision
    ON project_live_file(project_id, revision);
  CREATE INDEX IF NOT EXISTS project_live_file_task
    ON project_live_file(project_id, task_key);

  CREATE TABLE IF NOT EXISTS project_live_batch (
    batch_id TEXT NOT NULL,
    project_id TEXT NOT NULL REFERENCES team_project(repository_id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL REFERENCES agent_device(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL,
    client_sequence INTEGER,
    request_sha256 TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (agent_id, project_id, batch_id)
  );

  CREATE INDEX IF NOT EXISTS project_live_batch_project_time
    ON project_live_batch(project_id, created_at);

  CREATE TABLE IF NOT EXISTS agent_live_cursor (
    agent_id TEXT NOT NULL REFERENCES agent_device(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES team_project(repository_id) ON DELETE CASCADE,
    revision INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (agent_id, project_id)
  );

  CREATE TABLE IF NOT EXISTS git_credential (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL REFERENCES team(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    host TEXT NOT NULL,
    auth_type TEXT NOT NULL CHECK (auth_type IN ('https_token', 'ssh_key')),
    username TEXT,
    public_key_fingerprint TEXT,
    secret_version INTEGER NOT NULL DEFAULT 1,
    secret_iv TEXT NOT NULL,
    secret_tag TEXT NOT NULL,
    secret_ciphertext TEXT NOT NULL,
    created_by TEXT REFERENCES user_account(id),
    updated_by TEXT REFERENCES user_account(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS git_credential_team_name
    ON git_credential(team_id, name COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS git_credential_team_host
    ON git_credential(team_id, host);

  CREATE TABLE IF NOT EXISTS git_ssh_known_host (
    team_id TEXT NOT NULL REFERENCES team(id) ON DELETE CASCADE,
    host TEXT NOT NULL,
    port INTEGER NOT NULL,
    algorithm TEXT NOT NULL,
    key_base64 TEXT NOT NULL,
    fingerprint_sha256 TEXT NOT NULL,
    known_hosts_line TEXT NOT NULL,
    trusted_by TEXT REFERENCES user_account(id),
    trusted_at TEXT NOT NULL,
    PRIMARY KEY (team_id, host, port, algorithm, key_base64)
  );
`
