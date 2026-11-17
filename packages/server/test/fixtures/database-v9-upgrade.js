import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openDatabase } from '../../database.js'

const root = process.argv[2]
if (!root) throw new Error('缺少临时目录参数')
const databaseFile = path.join(root, 'board.sqlite')
fs.mkdirSync(path.join(root, 'projects'), { recursive: true })
fs.writeFileSync(path.join(root, 'projects', 'keep.txt'), 'old project\n')
fs.writeFileSync(path.join(root, 'git-credentials.key'), 'old key material\n')

const db = openDatabase({
  databaseFile,
  fallbackRepositories: [],
  importLegacyRepositories: false,
  legacyJsonImport: false,
})
const now = new Date().toISOString()
db.prepare(`
  INSERT INTO team(id, name, slug, status, created_at, updated_at)
  VALUES ('team-1', '团队一', 'team-1', 'active', ?, ?)
`).run(now, now)
db.prepare(`
  INSERT INTO repositories(id, name, path, path_key, position, created_at, updated_at)
  VALUES ('repo-1', '旧项目', 'D:/old', 'd:/old', 0, ?, ?)
`).run(now, now)
db.prepare(`
  INSERT INTO team_project(
    repository_id, team_id, workspace_key, remote_url, remote_identity_hash,
    sync_branch, sync_status, created_at, updated_at
  ) VALUES ('repo-1', 'team-1', 'old', 'https://example.com/old.git', 'old-hash',
    'main', 'current', ?, ?)
`).run(now, now)
const existingTables = new Set(
  db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => row.name),
)
db.exec('PRAGMA foreign_keys = OFF')
for (const table of [
  'sync_active_agent',
  'sync_agent_binding',
  'sync_agent_cursor',
  'sync_conflict_backup',
  'sync_conflict',
  'sync_file_audit',
  'sync_task_lease',
  'sync_task',
  'sync_task_command',
  'sync_task_assignment',
  'sync_task_index_tag',
  'sync_task_index',
  'sync_task_space_scan_cache',
  'sync_task_space_batch',
  'sync_task_merge_evidence',
  'sync_task_space_file',
  'sync_task_space',
  'sync_project_member',
  'sync_project_team_access',
  'sync_project',
]) {
  if (existingTables.has(table)) db.exec(`DROP TABLE IF EXISTS ${table}`)
}
db.prepare("UPDATE app_meta SET value = '9' WHERE key = 'schema_version'").run()
db.close()

const legacy = new DatabaseSync(databaseFile)
legacy.exec(`
  CREATE TABLE IF NOT EXISTS app_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`)
legacy.close()

const reopened = openDatabase({
  databaseFile,
  fallbackRepositories: [],
  importLegacyRepositories: false,
  legacyJsonImport: false,
})
const tables = reopened
  .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
  .all()
  .map((row) => row.name)
const backupName = fs
  .readdirSync(path.join(root, 'backups'))
  .find((name) => name.includes('pre-v17'))
let backupResult = null
if (backupName) {
  const backup = new DatabaseSync(path.join(root, 'backups', backupName))
  try {
    backupResult = {
      schemaVersion: backup.prepare("SELECT value FROM app_meta WHERE key = 'schema_version'").get()
        .value,
      projectCount: Number(
        backup.prepare('SELECT COUNT(*) AS count FROM team_project').get().count,
      ),
    }
  } finally {
    backup.close()
  }
}
const result = {
  schemaVersion: reopened.prepare("SELECT value FROM app_meta WHERE key = 'schema_version'").get()
    .value,
  projectCount: Number(reopened.prepare('SELECT COUNT(*) AS count FROM team_project').get().count),
  hasSyncProject: tables.includes('sync_project'),
  backupName,
  backup: backupResult,
  projectFileExists: fs.existsSync(path.join(root, 'projects', 'keep.txt')),
  credentialFileExists: fs.existsSync(path.join(root, 'git-credentials.key')),
}
reopened.close()
process.stdout.write(`${JSON.stringify(result)}\n`)
