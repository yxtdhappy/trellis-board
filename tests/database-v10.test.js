import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { DATABASE_SCHEMA_VERSION, openDatabase } from '../server/database.js'

const SYNC_TABLES = [
  'sync_active_agent',
  'sync_agent_binding',
  'sync_agent_cursor',
  'sync_conflict',
  'sync_conflict_backup',
  'sync_file_audit',
  'sync_project',
  'sync_project_member',
  'sync_project_team_access',
  'sync_task_command',
  'sync_task_assignment',
  'sync_task_index',
  'sync_task_index_tag',
  'sync_task_space',
  'sync_task_space_batch',
  'sync_task_space_file',
  'sync_task_space_scan_cache',
]

function tableNames(db) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => row.name)
}

test('schema v10 新库只新增 sync_* 团队任务表', () => {
  const db = openDatabase({
    databaseFile: ':memory:',
    fallbackRepositories: [],
    importLegacyRepositories: false,
    legacyJsonImport: false,
  })
  try {
    assert.equal(DATABASE_SCHEMA_VERSION, 10)
    const names = tableNames(db)
    for (const table of SYNC_TABLES) assert.ok(names.includes(table), `缺少 ${table}`)
    assert.ok(names.includes('team_project'))
    assert.ok(names.includes('project_live_file'))
    assert.ok(names.includes('git_operation'))
  } finally {
    db.close()
  }
})

test('v9 升级到 v10 保留旧项目行并创建备份', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-v10-'))
  const databaseFile = path.join(root, 'board.sqlite')
  try {
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
    db.prepare(
      `INSERT INTO team(id, name, slug, status, created_at, updated_at)
       VALUES ('team-1', '团队一', 'team-1', 'active', ?, ?)`,
    ).run(now, now)
    db.prepare(
      `INSERT INTO repositories(id, name, path, path_key, position, created_at, updated_at)
       VALUES ('repo-1', '旧项目', 'D:/old', 'd:/old', 0, ?, ?)`,
    ).run(now, now)
    db.prepare(
      `INSERT INTO team_project(
        repository_id, team_id, workspace_key, remote_url, remote_identity_hash,
        sync_branch, sync_status, created_at, updated_at
      ) VALUES ('repo-1', 'team-1', 'old', 'https://example.com/old.git', 'old-hash',
        'main', 'current', ?, ?)`,
    ).run(now, now)
    db.exec('DROP TABLE sync_active_agent')
    db.exec('DROP TABLE sync_agent_binding')
    db.exec('DROP TABLE sync_agent_cursor')
    db.exec('DROP TABLE sync_conflict_backup')
    db.exec('DROP TABLE sync_conflict')
    db.exec('DROP TABLE sync_file_audit')
    db.exec('DROP TABLE sync_task_command')
    db.exec('DROP TABLE sync_task_assignment')
    db.exec('DROP TABLE sync_task_index_tag')
    db.exec('DROP TABLE sync_task_index')
    db.exec('DROP TABLE sync_task_space_scan_cache')
    db.exec('DROP TABLE sync_task_space_batch')
    db.exec('DROP TABLE sync_task_space_file')
    db.exec('DROP TABLE sync_task_space')
    db.exec('DROP TABLE sync_project_member')
    db.exec('DROP TABLE sync_project_team_access')
    db.exec('DROP TABLE sync_project')
    db.prepare("UPDATE app_meta SET value = '9' WHERE key = 'schema_version'").run()
    db.close()

    const upgraded = new DatabaseSync(databaseFile)
    upgraded.exec('PRAGMA foreign_keys = ON')
    upgraded.exec(`
      CREATE TABLE IF NOT EXISTS app_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `)
    upgraded.close()

    const reopened = openDatabase({
      databaseFile,
      fallbackRepositories: [],
      importLegacyRepositories: false,
      legacyJsonImport: false,
    })
    try {
      assert.equal(
        reopened.prepare("SELECT value FROM app_meta WHERE key = 'schema_version'").get().value,
        '10',
      )
      assert.equal(reopened.prepare('SELECT COUNT(*) AS count FROM team_project').get().count, 1)
      assert.ok(tableNames(reopened).includes('sync_project'))
      const backups = fs.readdirSync(path.join(root, 'backups'))
      const backupName = backups.find((name) => name.includes('pre-v10'))
      assert.ok(backupName)
      const backup = new DatabaseSync(path.join(root, 'backups', backupName))
      try {
        assert.equal(
          backup.prepare("SELECT value FROM app_meta WHERE key = 'schema_version'").get().value,
          '9',
        )
        assert.equal(backup.prepare('SELECT COUNT(*) AS count FROM team_project').get().count, 1)
      } finally {
        backup.close()
      }
      assert.equal(fs.existsSync(path.join(root, 'projects', 'keep.txt')), true)
      assert.equal(fs.existsSync(path.join(root, 'git-credentials.key')), true)
    } finally {
      reopened.close()
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
