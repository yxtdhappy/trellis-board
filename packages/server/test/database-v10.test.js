import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
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
  'sync_archive_file',
  'sync_archive_file_history',
  'sync_archive_git_credential',
  'sync_archive_snapshot',
  'sync_archive_sync_config',
  'sync_archive_sync_log',
  'sync_archive_sync_state',
  'sync_conflict',
  'sync_conflict_backup',
  'sync_file_audit',
  'sync_project',
  'sync_project_member',
  'sync_project_team_access',
  'sync_task',
  'sync_task_command',
  'sync_task_assignment',
  'sync_task_index',
  'sync_task_index_tag',
  'sync_task_lease',
  'sync_task_ownership_inbox',
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

test('schema v17 新库包含团队任务、权威任务、租约、待归属摘要和归档同步表', () => {
  const db = openDatabase({
    databaseFile: ':memory:',
    fallbackRepositories: [],
    importLegacyRepositories: false,
    legacyJsonImport: false,
  })
  try {
    assert.equal(DATABASE_SCHEMA_VERSION, 19)
    const names = tableNames(db)
    for (const table of SYNC_TABLES) assert.ok(names.includes(table), `缺少 ${table}`)
    assert.ok(names.includes('team_project'))
    assert.ok(names.includes('project_live_file'))
    assert.ok(names.includes('git_operation'))
    assert.ok(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM pragma_table_info('sync_task_space') WHERE name IN ('retired_at', 'retired_by_user_id', 'retired_reason')",
        )
        .get().count,
      3,
    )
  } finally {
    db.close()
  }
})

test('v10 升级到 v17 补监听、弃用、权威任务和基线字段并保留已有关联', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-v12-'))
  const databaseFile = path.join(root, 'board.sqlite')
  let reopened = null
  try {
    let db = openDatabase({
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
    assert.deepEqual(
      reopened
        .prepare('PRAGMA table_info(sync_task_space)')
        .all()
        .map((column) => column.name)
        .filter((name) => name.startsWith('retired_')),
      ['retired_at', 'retired_by_user_id', 'retired_reason'],
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
      '19',
    )
    const backupName = fs
      .readdirSync(path.join(root, 'backups'))
      .find((name) => name.startsWith('board.sqlite.pre-v19.'))
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
        .filter((name) => name.startsWith('board.sqlite.pre-v19.')).length,
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

test('v11 升级到 v17 只补弃用字段，历史 disabled 不自动变成 retired', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-v12-v11-upgrade-'))
  const databaseFile = path.join(root, 'board.sqlite')
  let reopened = null
  try {
    let db = openDatabase({
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
      ) VALUES ('space-disabled', 'project-1', 'old-branch', 'disabled', 7, 6,
        'user-1', 'agent-1', ?, ?)`,
    ).run(now, now)
    db.exec('DROP INDEX sync_task_space_retired')
    db.exec('ALTER TABLE sync_task_space DROP COLUMN retired_reason')
    db.exec('ALTER TABLE sync_task_space DROP COLUMN retired_by_user_id')
    db.exec('ALTER TABLE sync_task_space DROP COLUMN retired_at')
    db.prepare("UPDATE app_meta SET value = '11' WHERE key = 'schema_version'").run()
    db.close()

    reopened = openDatabase({
      databaseFile,
      fallbackRepositories: [],
      importLegacyRepositories: false,
      legacyJsonImport: false,
    })
    assert.equal(
      reopened.prepare("SELECT value FROM app_meta WHERE key = 'schema_version'").get().value,
      '19',
    )
    const row = reopened
      .prepare(`
        SELECT status, retired_at, retired_by_user_id, retired_reason
        FROM sync_task_space WHERE id = 'space-disabled'
      `)
      .get()
    assert.deepEqual(
      { ...row },
      {
        status: 'disabled',
        retired_at: null,
        retired_by_user_id: null,
        retired_reason: null,
      },
    )
    const backupName = fs
      .readdirSync(path.join(root, 'backups'))
      .find((name) => name.startsWith('board.sqlite.pre-v19.'))
    assert.ok(backupName)
    const backup = new DatabaseSync(path.join(root, 'backups', backupName))
    try {
      assert.equal(
        backup.prepare("SELECT value FROM app_meta WHERE key = 'schema_version'").get().value,
        '11',
      )
      assert.equal(
        backup
          .prepare(`
            SELECT COUNT(*) AS count
            FROM pragma_table_info('sync_task_space')
            WHERE name IN ('retired_at', 'retired_by_user_id', 'retired_reason')
          `)
          .get().count,
        0,
      )
    } finally {
      backup.close()
    }
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

test('v12 迁移失败时监听、弃用列和 schema 版本一起回滚', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-v12-rollback-'))
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
    db.exec('DROP INDEX sync_task_space_retired')
    db.exec('ALTER TABLE sync_task_space DROP COLUMN retired_reason')
    db.exec('ALTER TABLE sync_task_space DROP COLUMN retired_by_user_id')
    db.exec('ALTER TABLE sync_task_space DROP COLUMN retired_at')
    db.prepare("UPDATE app_meta SET value = '10' WHERE key = 'schema_version'").run()
    db.exec(`
      CREATE TRIGGER fail_v12_metadata
      BEFORE UPDATE ON app_meta
      WHEN NEW.key = 'schema_version' AND NEW.value = '19'
      BEGIN
        SELECT RAISE(ABORT, 'v19 metadata blocked');
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
      /v19 metadata blocked/,
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
      assert.equal(
        check
          .prepare(`
            SELECT COUNT(*) AS count
            FROM pragma_table_info('sync_task_space')
            WHERE name IN ('retired_at', 'retired_by_user_id', 'retired_reason')
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
        .some((name) => name.startsWith('board.sqlite.pre-v19.')),
      true,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('v9 升级到 v17 保留旧项目行并创建备份', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-v12-v9-upgrade-'))
  try {
    const child = spawnSync(
      process.execPath,
      [path.join(import.meta.dirname, 'fixtures', 'database-v9-upgrade.js'), root],
      { encoding: 'utf8' },
    )
    assert.equal(child.status, 0, child.stderr || child.stdout)
    const result = JSON.parse(child.stdout)
    assert.equal(result.schemaVersion, '19')
    assert.equal(result.projectCount, 1)
    assert.equal(result.hasSyncProject, true)
    assert.ok(result.backupName)
    assert.deepEqual(result.backup, { schemaVersion: '9', projectCount: 1 })
    assert.equal(result.projectFileExists, true)
    assert.equal(result.credentialFileExists, true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('v15 升级到 v17 回填活动/归档权威任务并选择归档最终状态', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-v17-backfill-'))
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
    db.prepare(`
      INSERT INTO team(id, name, slug, status, created_at, updated_at)
      VALUES ('team-1', '团队一', 'team-1', 'active', ?, ?)
    `).run(now, now)
    db.prepare(`
      INSERT INTO user_account(
        id, username_key, username, display_name, password_hash, password_params_json,
        system_admin, status, must_change_password, password_changed_at, created_at, updated_at
      ) VALUES ('user-1', 'user-1', 'user-1', '用户一', 'x', '{}', 0, 'active', 0, ?, ?, ?)
    `).run(now, now, now)
    db.prepare(`
      INSERT INTO agent_device(
        id, user_id, device_name, platform, agent_version, protocol_version,
        credential_hash, status, last_seen_at, created_at
      ) VALUES ('agent-1', 'user-1', '设备一', 'win32', '0.1.0', 3, 'credential', 'active', ?, ?)
    `).run(now, now)
    db.prepare(`
      INSERT INTO sync_project(
        id, name, remote_url, remote_identity_hash, owner_team_id, status,
        created_by_user_id, created_by_agent_id, created_at, updated_at
      ) VALUES ('project-1', '项目一', 'https://example.com/repo.git', 'hash-1', 'team-1',
        'active', 'user-1', 'agent-1', ?, ?)
    `).run(now, now)
    db.prepare(`
      INSERT INTO sync_task_space(
        id, project_id, branch_name, status, revision, indexed_revision, archive_revision,
        archive_indexed_revision, created_by_user_id, created_by_agent_id, created_at, updated_at
      ) VALUES ('space-1', 'project-1', 'main', 'active', 2, 2, 1, 1,
        'user-1', 'agent-1', ?, ?)
    `).run(now, now)
    const insertIndex = db.prepare(`
      INSERT INTO sync_task_index(
        task_space_id, project_id, task_key, execution_task_key, relative_dir,
        branch_name, title, search_text, archived, archived_at, priority, derived_stage,
        assignee_dev_id, assignee_user_id, last_activity_at, attention_flags_json,
        group_key, group_role, task_version, board_version, updated_at
      ) VALUES ('space-1', 'project-1', ?, ?, ?, 'main', ?, ?, ?, ?, 'P2', 'planning',
        'alice', 'user-1', ?, '[]', ?, 'single', 'v1', 'v1', ?)
    `)
    insertIndex.run(
      'space-1::.trellis/tasks/11-17-task-a',
      'space-1::task-a',
      '.trellis/tasks/11-17-task-a',
      '活动副本',
      '活动副本',
      0,
      null,
      now,
      'space-1::.trellis/tasks/11-17-task-a',
      now,
    )
    insertIndex.run(
      'space-1::.trellis/tasks/archive/2026-11/11-17-task-a',
      'space-1::task-a',
      '.trellis/tasks/archive/2026-11/11-17-task-a',
      '归档副本',
      '归档副本',
      1,
      now,
      now,
      'space-1::.trellis/tasks/archive/2026-11/11-17-task-a',
      now,
    )
    insertIndex.run(
      'space-1::.trellis/tasks/11-17-task-b',
      'space-1::task-b',
      '.trellis/tasks/11-17-task-b',
      '活动任务',
      '活动任务',
      0,
      null,
      now,
      'space-1::.trellis/tasks/11-17-task-b',
      now,
    )
    db.exec('DROP TABLE sync_task_lease')
    db.exec('DROP TABLE sync_task')
    db.prepare("UPDATE app_meta SET value = '15' WHERE key = 'schema_version'").run()
    db.close()

    reopened = openDatabase({
      databaseFile,
      fallbackRepositories: [],
      importLegacyRepositories: false,
      legacyJsonImport: false,
    })
    const tasks = reopened
      .prepare(`
        SELECT execution_task_key, relative_dir, archived, archived_at,
               created_by_user_id, assignee_user_id, materialization_state
        FROM sync_task
        ORDER BY execution_task_key
      `)
      .all()
    assert.equal(tasks.length, 2)
    assert.deepEqual(
      {
        ...tasks.find((task) => task.execution_task_key === 'space-1::task-a'),
      },
      {
        execution_task_key: 'space-1::task-a',
        relative_dir: '.trellis/tasks/archive/2026-11/11-17-task-a',
        archived: 1,
        archived_at: now,
        created_by_user_id: 'user-1',
        assignee_user_id: 'user-1',
        materialization_state: 'materialized',
      },
    )
    assert.equal(tasks.find((task) => task.execution_task_key === 'space-1::task-b').archived, 0)
    assert.ok(
      fs
        .readdirSync(path.join(root, 'backups'))
        .some((name) => name.startsWith('board.sqlite.pre-v19.')),
    )
  } finally {
    reopened?.close()
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
