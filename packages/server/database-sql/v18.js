// v18：待归属摘要记录任务负责人，供看板判断「谁可以执行归属」。
// SQLite 不支持 ADD COLUMN IF NOT EXISTS，迁移按列名逐项守卫执行；
// SCHEMA_V18_SQL 仅用于表达该版本新增的列定义。
export const SCHEMA_V18_TASK_OWNERSHIP_INBOX_COLUMNS = [
  ['assignee_user_id', 'TEXT REFERENCES user_account(id) ON DELETE SET NULL'],
  ['assignee_dev_id', 'TEXT'],
]

export const SCHEMA_V18_SQL = SCHEMA_V18_TASK_OWNERSHIP_INBOX_COLUMNS.map(
  ([name, definition]) => `ALTER TABLE sync_task_ownership_inbox ADD COLUMN ${name} ${definition};`,
).join('\n')
