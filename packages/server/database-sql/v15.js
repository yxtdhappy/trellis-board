export const SCHEMA_V15_SQL = `
  CREATE TABLE IF NOT EXISTS sync_archive_snapshot (
    id TEXT PRIMARY KEY,
    task_space_id TEXT NOT NULL REFERENCES sync_task_space(id) ON DELETE CASCADE,
    source_head TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'published'
      CHECK (status IN ('published', 'retired')),
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    storage_root TEXT NOT NULL,
    file_count INTEGER NOT NULL DEFAULT 0,
    byte_count INTEGER NOT NULL DEFAULT 0,
    manifest_sha256 TEXT NOT NULL,
    published_at TEXT NOT NULL,
    retired_at TEXT,
    UNIQUE(task_space_id, source_head)
  );

  CREATE INDEX IF NOT EXISTS sync_archive_snapshot_task_space
    ON sync_archive_snapshot(task_space_id, status, published_at DESC);

  CREATE TABLE IF NOT EXISTS sync_archive_file_history (
    id            TEXT PRIMARY KEY,
    task_space_id TEXT NOT NULL REFERENCES sync_task_space(id) ON DELETE CASCADE,
    snapshot_id   TEXT REFERENCES sync_archive_snapshot(id) ON DELETE CASCADE,
    relative_path TEXT NOT NULL,
    blob_oid      TEXT NOT NULL,
    sha256        TEXT NOT NULL,
    content_text  TEXT NOT NULL DEFAULT '',
    size_bytes    INTEGER NOT NULL DEFAULT 0,
    mime_type     TEXT NOT NULL DEFAULT 'application/octet-stream',
    storage_key   TEXT,
    text_excerpt  TEXT,
    task_id       TEXT,
    task_dir      TEXT NOT NULL,
    source_head   TEXT,
    updated_at    TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS sync_archive_file_history_task_space
    ON sync_archive_file_history(task_space_id, snapshot_id, relative_path);
  CREATE INDEX IF NOT EXISTS sync_archive_file_history_storage
    ON sync_archive_file_history(task_space_id, storage_key);
`
