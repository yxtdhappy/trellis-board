import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { DATABASE_SCHEMA_VERSION, openDatabase } from '../database.js'

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
  'sync_task_merge_evidence',
]

function tableNames(db) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => row.name)
}

test('schema v12 新库只新增 sync_* 团队任务表', () => {
  const db = openDatabase({
    databaseFile: ':memory:',
    fallbackRepositories: [],
    importLegacyRepositories: false,
    legacyJsonImport: false,
  })
  try {
    assert.equal(DATABASE_SCHEMA_VERSION, 12)
    const names = tableNames(db)
    for (const table of SYNC_TABLES) assert.ok(names.includes(table), `缺少 ${table}`)
    assert.ok(names.includes('team_project'))
    assert.ok(names.includes('project_live_file'))
    assert.ok(names.includes('git_operation'))
  } finally {
    db.close()
  }
})

test('v10 升级到 v12 为 binding 补监听字段和基线并保留已有关联', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-v11-'))
  const databaseFile = path.join(root, 'board.sqlite')
  let reopened = null
  try {
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
      `INSERT INTO user_account(
        id, username_key, username, display_name, password_hash, password_params_json,
        system_admin, status, must_change_password, password_changed_at, created_at, updated_at
      ) VALUES ('user-1', 'user-1', 'user-1', '用户一', 'x', '{}', 0, 'active', 0, ?, ?, ?)`,
    ).run(now, now, now)
    db.prepare(
      `INSERT INTO agent_device(
        id, user_id, device_name, platform, agent_version, protocol_version,
        credential_hash, status, last_seen_at, created_at
      ) VALUES ('agent-1', 'user-1', '设备一', 'win32', '0.1.0', 3, 'credential', 'active', ?, ?)`,
    ).run(now, now)
    db.prepare(
      `INSERT INTO sync_project(
        id, name, remote_url, remote_identity_hash, owner_team_id, status,
        created_by_user_id, created_by_agent_id, created_at, updated_at
      ) VALUES ('project-1', '项目一', 'https://example.com/repo.git', 'hash-1', 'team-1',
        'active', 'user-1', 'agent-1', ?, ?)`,
    ).run(now, now)
    db.prepare(
      `INSERT INTO sync_task_space(
        id, project_id, branch_name, status, revision, indexed_revision,
        created_by_user_id, created_by_agent_id, created_at, updated_at
      ) VALUES ('space-1', 'project-1', 'main', 'active', 0, 0, 'user-1', 'agent-1', ?, ?)`,
    ).run(now, now)
    db.prepare(
      `INSERT INTO sync_agent_binding(
        id, agent_id, task_space_id, local_repo_key, local_display_name,
        branch_name, sync_status, created_at, updated_at
      ) VALUES ('binding-1', 'agent-1', 'space-1', ?, '项目一', 'main', 'approved', ?, ?)`,
    ).run('a'.repeat(64), now, now)
    db.exec('DROP INDEX sync_agent_binding_listener')
    db.exec('ALTER TABLE sync_agent_binding DROP COLUMN last_listener_at')
    db.exec('ALTER TABLE sync_agent_binding DROP COLUMN listener_reported_at')
    db.exec('ALTER TABLE sync_agent_binding DROP COLUMN is_listening')
    db.prepare("UPDATE app_meta SET value = '10' WHERE key = 'schema_version'").run()
    db.close()

    reopened = openDatabase({
      databaseFile,
      fallbackRepositories: [],
      importLegacyRepositories: false,
      legacyJsonImport: false,
    })
    assert.deepEqual(
      reopened
        .prepare('PRAGMA table_info(sync_agent_binding)')
        .all()
        .map((column) => column.name),
      [
        'id',
        'agent_id',
        'task_space_id',
        'local_repo_key',
        'local_display_name',
        'branch_name',
        'sync_status',
        'last_synced_at',
        'last_error',
        'created_at',
        'updated_at',
        'is_listening',
        'listener_reported_at',
        'last_listener_at',
      ],
    )
    const binding = reopened
      .prepare(`
        SELECT sync_status, is_listening, listener_reported_at, last_listener_at
        FROM sync_agent_binding WHERE id = 'binding-1'
      `)
      .get()
    assert.deepEqual(
      { ...binding },
      {
        sync_status: 'approved',
        is_listening: 0,
        listener_reported_at: null,
        last_listener_at: null,
      },
    )
    assert.equal(
      reopened.prepare("SELECT baseline_branch FROM sync_project WHERE id = 'project-1'").get()
        .baseline_branch,
      'main',
    )
    assert.equal(
      reopened
        .prepare(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'sync_task_merge_evidence'",
        )
        .get().count,
      1,
    )
    assert.equal(
      reopened.prepare("SELECT value FROM app_meta WHERE key = 'schema_version'").get().value,
      '12',
    )
    const backupName = fs
      .readdirSync(path.join(root, 'backups'))
      .find((name) => name.startsWith('board.sqlite.pre-v12.'))
    assert.ok(backupName)
    const backup = new DatabaseSync(path.join(root, 'backups', backupName))
    try {
      assert.equal(
        backup.prepare("SELECT value FROM app_meta WHERE key = 'schema_version'").get().value,
        '10',
      )
      assert.equal(
        backup
          .prepare(
            "SELECT COUNT(*) AS count FROM pragma_table_info('sync_agent_binding') WHERE name = 'is_listening'",
          )
          .get().count,
        0,
      )
    } finally {
      backup.close()
    }

    reopened
      .prepare(`
        UPDATE sync_agent_binding
        SET is_listening = 1, listener_reported_at = ?, last_listener_at = ?
        WHERE id = 'binding-1'
      `)
      .run(now, now)
    reopened.close()
    reopened = openDatabase({
      databaseFile,
      fallbackRepositories: [],
      importLegacyRepositories: false,
      legacyJsonImport: false,
    })
    assert.deepEqual(
      {
        ...reopened
          .prepare(`
            SELECT is_listening, listener_reported_at, last_listener_at
            FROM sync_agent_binding WHERE id = 'binding-1'
          `)
          .get(),
      },
      {
        is_listening: 1,
        listener_reported_at: now,
        last_listener_at: now,
      },
    )
    assert.equal(
      fs
        .readdirSync(path.join(root, 'backups'))
        .filter((name) => name.startsWith('board.sqlite.pre-v12.')).length,
      1,
    )
    reopened.close()
    reopened = null
  } finally {
    try {
      reopened?.close()
    } catch {
      // 清理失败不掩盖测试断言。
    }
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('v12 迁移失败时监听列和 schema 版本一起回滚', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-v11-rollback-'))
  const databaseFile = path.join(root, 'board.sqlite')
  try {
    const db = openDatabase({
      databaseFile,
      fallbackRepositories: [],
      importLegacyRepositories: false,
      legacyJsonImport: false,
    })
    db.exec('DROP INDEX sync_agent_binding_listener')
    db.exec('ALTER TABLE sync_agent_binding DROP COLUMN last_listener_at')
    db.exec('ALTER TABLE sync_agent_binding DROP COLUMN listener_reported_at')
    db.exec('ALTER TABLE sync_agent_binding DROP COLUMN is_listening')
    db.prepare("UPDATE app_meta SET value = '10' WHERE key = 'schema_version'").run()
    db.exec(`
      CREATE TRIGGER fail_v12_metadata
      BEFORE UPDATE ON app_meta
      WHEN NEW.key = 'schema_version' AND NEW.value = '12'
      BEGIN
        SELECT RAISE(ABORT, 'v12 metadata blocked');
      END;
    `)
    db.close()

    assert.throws(
      () =>
        openDatabase({
          databaseFile,
          fallbackRepositories: [],
          importLegacyRepositories: false,
          legacyJsonImport: false,
        }),
      /v12 metadata blocked/,
    )
    const check = new DatabaseSync(databaseFile, { readOnly: true })
    try {
      assert.equal(
        check.prepare("SELECT value FROM app_meta WHERE key = 'schema_version'").get().value,
        '10',
      )
      assert.equal(
        check
          .prepare(`
            SELECT COUNT(*) AS count
            FROM pragma_table_info('sync_agent_binding')
            WHERE name IN ('is_listening', 'listener_reported_at', 'last_listener_at')
          `)
          .get().count,
        0,
      )
    } finally {
      check.close()
    }
    assert.equal(
      fs
        .readdirSync(path.join(root, 'backups'))
        .some((name) => name.startsWith('board.sqlite.pre-v12.')),
      true,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('v9 升级到 v12 保留旧项目行并创建备份', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-v11-v9-upgrade-'))
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
        '12',
      )
      assert.equal(reopened.prepare('SELECT COUNT(*) AS count FROM team_project').get().count, 1)
      assert.ok(tableNames(reopened).includes('sync_project'))
      const backups = fs.readdirSync(path.join(root, 'backups'))
      const backupName = backups.find((name) => name.includes('pre-v12'))
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
