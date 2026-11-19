export const SCHEMA_V14_SQL = `
  CREATE TABLE IF NOT EXISTS sync_archive_file (
    task_space_id TEXT NOT NULL REFERENCES sync_task_space(id) ON DELETE CASCADE,
    relative_path TEXT NOT NULL,
    blob_oid TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    content_text TEXT NOT NULL,
    task_id TEXT,
    task_dir TEXT NOT NULL,
    source_head TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (task_space_id, relative_path)
  );

  CREATE INDEX IF NOT EXISTS sync_archive_file_task
    ON sync_archive_file(task_space_id, task_dir);
  CREATE INDEX IF NOT EXISTS sync_archive_file_task_id
    ON sync_archive_file(task_space_id, task_id);

  CREATE TABLE IF NOT EXISTS sync_archive_git_credential (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    scheme TEXT NOT NULL CHECK (scheme IN ('ssh', 'https')),
    host TEXT NOT NULL,
    port INTEGER NOT NULL CHECK (port >= 1 AND port <= 65535),
    auth_type TEXT NOT NULL CHECK (auth_type IN ('ssh_key', 'https_token')),
    username TEXT,
    secret_version INTEGER NOT NULL,
    secret_iv TEXT NOT NULL,
    secret_tag TEXT NOT NULL,
    secret_ciphertext TEXT NOT NULL,
    public_key_fingerprint TEXT,
    known_hosts_text TEXT,
    created_by_user_id TEXT REFERENCES user_account(id) ON DELETE SET NULL,
    updated_by_user_id TEXT REFERENCES user_account(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(scheme, host, port),
    CHECK (
      (scheme = 'ssh' AND auth_type = 'ssh_key') OR
      (scheme = 'https' AND auth_type = 'https_token')
    )
  );

  CREATE TABLE IF NOT EXISTS sync_archive_sync_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    interval_seconds INTEGER NOT NULL DEFAULT 300
      CHECK (interval_seconds >= 60 AND interval_seconds <= 86400),
    updated_by_user_id TEXT REFERENCES user_account(id) ON DELETE SET NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sync_archive_sync_state (
    task_space_id TEXT PRIMARY KEY REFERENCES sync_task_space(id) ON DELETE CASCADE,
    ref_name TEXT,
    remote_head TEXT,
    status TEXT NOT NULL DEFAULT 'idle' CHECK (
      status IN ('idle', 'syncing', 'importing', 'indexing', 'current', 'stale', 'error', 'index_error')
    ),
    last_attempt_at TEXT,
    last_success_at TEXT,
    last_indexed_at TEXT,
    last_error TEXT,
    file_count INTEGER NOT NULL DEFAULT 0,
    byte_count INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sync_archive_sync_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_space_id TEXT NOT NULL REFERENCES sync_task_space(id) ON DELETE CASCADE,
    attempt_id TEXT NOT NULL,
    phase TEXT NOT NULL CHECK (phase IN ('fetch', 'import', 'index')),
    level TEXT NOT NULL DEFAULT 'error' CHECK (level = 'error'),
    error_code TEXT NOT NULL,
    message TEXT NOT NULL,
    detail_json TEXT,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS sync_archive_sync_log_task_space
    ON sync_archive_sync_log(task_space_id, created_at DESC, id DESC);
`
