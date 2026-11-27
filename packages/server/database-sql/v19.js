export const SCHEMA_V19_TASK_SPACE_COLUMNS = [['is_worktree', 'INTEGER NOT NULL DEFAULT 0']]

export const SCHEMA_V19_SQL = SCHEMA_V19_TASK_SPACE_COLUMNS.map(
  ([name, definition]) => `ALTER TABLE sync_task_space ADD COLUMN ${name} ${definition};`,
).join('\n')
