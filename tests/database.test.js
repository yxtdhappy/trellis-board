import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { DATABASE_SCHEMA_VERSION, openDatabase } from '../server/database.js'
import { createPersistenceStore } from '../server/persistence.js'

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-database-'))
  const dataDir = path.join(root, 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  return {
    root,
    databaseFile: path.join(dataDir, 'board.sqlite'),
    legacyFiles: {
      repositoriesFile: path.join(dataDir, 'repos.json'),
      metadataFile: path.join(dataDir, 'task-metadata.json'),
      scanCacheFile: path.join(dataDir, 'scan-cache.json'),
      stateFile: path.join(dataDir, 'board-state.json'),
    },
    warnings: [],
  }
}

function openTestDatabase(workspace, options = {}) {
  return openDatabase({
    databaseFile: workspace.databaseFile,
    legacyFiles: workspace.legacyFiles,
    fallbackRepositories: [],
    logger: {
      warn(message) {
        workspace.warnings.push(message)
      },
    },
    ...options,
  })
}

function closeQuietly(db) {
  try {
    db?.close()
  } catch {
    // 数据库可能已在失败路径关闭。
  }
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function tableNames(db) {
  return db
    .prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `)
    .all()
    .map((row) => row.name)
}

function columnNames(db, table) {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((column) => column.name)
}

const EXPECTED_TABLES = [
  'agent_command',
  'agent_device',
  'agent_event',
  'agent_event_cursor',
  'agent_live_cursor',
  'agent_pairing_code',
  'agent_project_binding',
  'app_meta',
  'audit_event',
  'board_state',
  'git_credential',
  'git_operation',
  'git_ssh_known_host',
  'login_attempt',
  'plugin_audit',
  'plugin_run',
  'plugin_state',
  'project_live_batch',
  'project_live_file',
  'project_live_revision',
  'project_member',
  'project_scan_cache',
  'repositories',
  'saved_view',
  'scan_cache',
  'task_assignment',
  'task_dependency',
  'task_event',
  'task_execution',
  'task_stage',
  'task_tag',
  'team',
  'team_member',
  'team_project',
  'team_task_index',
  'team_task_index_tag',
  'user_account',
  'user_board_state',
  'user_session',
]

test('新库一次创建 schema v7 与实时同步、Git 凭据表', () => {
  const workspace = makeWorkspace()
  let db
  try {
    db = openTestDatabase(workspace)
    assert.equal(DATABASE_SCHEMA_VERSION, 7)
    assert.deepEqual(tableNames(db), EXPECTED_TABLES)
    const meta = Object.fromEntries(
      db
        .prepare('SELECT key, value FROM app_meta')
        .all()
        .map((row) => [row.key, row.value]),
    )
    assert.equal(meta.schema_version, '7')
    assert.equal(meta.legacy_json_imported_v1, '1')
    assert.equal(Number.isNaN(Date.parse(meta.execution_events_started_at)), false)

    assert.deepEqual(columnNames(db, 'team_project'), [
      'repository_id',
      'team_id',
      'workspace_key',
      'remote_url',
      'remote_identity_hash',
      'sync_branch',
      'trusted_task_toolchain_sha256',
      'sync_status',
      'last_fetch_at',
      'last_push_at',
      'last_error',
      'created_at',
      'updated_at',
      'git_credential_id',
    ])
    assert.ok(columnNames(db, 'user_session').includes('active_team_id'))
    assert.ok(columnNames(db, 'saved_view').includes('team_id'))
    assert.ok(columnNames(db, 'saved_view').includes('owner_user_id'))
    assert.ok(columnNames(db, 'audit_event').includes('team_id'))
    assert.ok(columnNames(db, 'agent_pairing_code').includes('team_id'))
    assert.ok(columnNames(db, 'agent_project_binding').includes('team_id'))
    assert.deepEqual(columnNames(db, 'user_board_state'), [
      'user_id',
      'team_id',
      'key',
      'value_json',
      'updated_at',
    ])

    assert.deepEqual(
      db
        .prepare(`
        SELECT name
        FROM sqlite_master
        WHERE type = 'index'
          AND tbl_name = 'task_dependency'
          AND name NOT LIKE 'sqlite_autoindex_%'
        ORDER BY name
      `)
        .all()
        .map((row) => row.name),
      ['task_dependency_active_unique', 'task_dependency_blocked', 'task_dependency_blocker'],
    )
    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal')
    assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1)
    assert.equal(db.prepare('PRAGMA busy_timeout').get().timeout, 5000)
    assert.equal(db.prepare('PRAGMA synchronous').get().synchronous, 1)
  } finally {
    closeQuietly(db)
    fs.rmSync(workspace.root, { recursive: true, force: true })
  }
})

test('schema v7 重复打开保持幂等', () => {
  const workspace = makeWorkspace()
  let db
  try {
    db = openTestDatabase(workspace)
    const firstColumns = columnNames(db, 'team_project')
    db.close()
    db = openTestDatabase(workspace)
    assert.equal(
      db.prepare("SELECT value FROM app_meta WHERE key = 'schema_version'").get().value,
      '7',
    )
    assert.deepEqual(columnNames(db, 'team_project'), firstColumns)
    assert.deepEqual(tableNames(db), EXPECTED_TABLES)
  } finally {
    closeQuietly(db)
    fs.rmSync(workspace.root, { recursive: true, force: true })
  }
})

test('schema v6 升级到 v7 前备份并补齐实时同步与凭据表', () => {
  const workspace = makeWorkspace()
  let db
  try {
    db = openTestDatabase(workspace)
    const now = new Date().toISOString()
    db.prepare(
      "INSERT INTO team(id, name, slug, status, created_at, updated_at) VALUES ('t1','团队一','t1','active',?,?)",
    ).run(now, now)
    db.prepare(`
      INSERT INTO repositories(id, name, path, path_key, position, created_at, updated_at)
      VALUES ('p1', '项目一', '/tmp/p1', '/tmp/p1', 0, ?, ?)
    `).run(now, now)
    db.prepare(`
      INSERT INTO team_project(
        repository_id, team_id, workspace_key, remote_url, remote_identity_hash,
        sync_branch, trusted_task_toolchain_sha256, sync_status, created_at, updated_at
      ) VALUES ('p1', 't1', 'p1', 'https://example.com/p1.git', 'hash',
        'main', ?, 'current', ?, ?)
    `).run('a'.repeat(64), now, now)
    db.exec('DROP INDEX IF EXISTS team_project_credential')
    db.exec('ALTER TABLE team_project DROP COLUMN git_credential_id')
    db.exec('DROP TABLE git_ssh_known_host')
    db.exec('DROP TABLE git_credential')
    db.exec(`
      DROP TABLE agent_live_cursor;
      DROP TABLE project_live_batch;
      DROP TABLE project_live_file;
      DROP TABLE project_live_revision;
    `)
    db.prepare("UPDATE app_meta SET value = '6' WHERE key = 'schema_version'").run()
    db.close()
    db = null
    db = openTestDatabase(workspace)
    assert.equal(
      db.prepare("SELECT value FROM app_meta WHERE key = 'schema_version'").get().value,
      '7',
    )
    assert.ok(tableNames(db).includes('project_live_revision'))
    assert.ok(tableNames(db).includes('project_live_file'))
    assert.ok(tableNames(db).includes('project_live_batch'))
    assert.ok(tableNames(db).includes('agent_live_cursor'))
    assert.ok(tableNames(db).includes('git_credential'))
    assert.ok(tableNames(db).includes('git_ssh_known_host'))
    assert.ok(columnNames(db, 'team_project').includes('git_credential_id'))
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM team_project WHERE repository_id = 'p1'").get()
        .count,
      1,
    )
    const backups = fs.readdirSync(path.join(path.dirname(workspace.databaseFile), 'backups'))
    assert.equal(
      backups.some((name) => name.startsWith('board.sqlite.pre-v7.')),
      true,
    )
  } finally {
    closeQuietly(db)
    fs.rmSync(workspace.root, { recursive: true, force: true })
  }
})

test('旧 v5 数据库不做迁移，要求删除后重建', () => {
  const workspace = makeWorkspace()
  let db
  try {
    db = openTestDatabase(workspace)
    db.prepare("UPDATE app_meta SET value = '5' WHERE key = 'schema_version'").run()
    db.close()
    db = null
    assert.throws(
      () => openTestDatabase(workspace),
      /不支持的数据库 schema 版本: 5.*删除 data\/board\.sqlite 后重建/,
    )
    const check = new DatabaseSync(workspace.databaseFile, { readOnly: true })
    try {
      assert.equal(
        check.prepare("SELECT value FROM app_meta WHERE key = 'schema_version'").get().value,
        '5',
      )
    } finally {
      check.close()
    }
    assert.deepEqual(
      fs
        .readdirSync(path.dirname(workspace.databaseFile))
        .filter((name) => name.includes('backup')),
      [],
    )
  } finally {
    closeQuietly(db)
    fs.rmSync(workspace.root, { recursive: true, force: true })
  }
})

test('不支持的数据库 schema 版本会拒绝启动', () => {
  const workspace = makeWorkspace()
  let db
  try {
    db = openTestDatabase(workspace)
    db.prepare("UPDATE app_meta SET value = '999' WHERE key = 'schema_version'").run()
    db.close()
    db = null
    assert.throws(() => openTestDatabase(workspace), /不支持的数据库 schema 版本: 999/)
  } finally {
    closeQuietly(db)
    fs.rmSync(workspace.root, { recursive: true, force: true })
  }
})

test('workspace_key 仅在同一团队内唯一', () => {
  const workspace = makeWorkspace()
  let db
  try {
    db = openTestDatabase(workspace)
    const now = new Date().toISOString()
    db.prepare(
      "INSERT INTO team(id, name, slug, status, created_at, updated_at) VALUES ('t1','团队一','t1','active',?,?)",
    ).run(now, now)
    db.prepare(
      "INSERT INTO team(id, name, slug, status, created_at, updated_at) VALUES ('t2','团队二','t2','active',?,?)",
    ).run(now, now)
    for (const [id, repositoryPath] of [
      ['p1', '/tmp/p1'],
      ['p2', '/tmp/p2'],
    ]) {
      db.prepare(`
        INSERT INTO repositories(id, name, path, path_key, position, created_at, updated_at)
        VALUES (?, ?, ?, ?, 0, ?, ?)
      `).run(id, id, repositoryPath, repositoryPath, now, now)
    }
    const insertProject = db.prepare(`
      INSERT INTO team_project(
        repository_id, team_id, workspace_key, remote_url, remote_identity_hash,
        sync_branch, trusted_task_toolchain_sha256, sync_status, created_at, updated_at
      ) VALUES (?, ?, ?, 'https://example.com/repo.git', 'hash', 'main', ?, 'current', ?, ?)
    `)
    insertProject.run('p1', 't1', 'shared-key', 'a'.repeat(64), now, now)
    insertProject.run('p2', 't2', 'shared-key', 'a'.repeat(64), now, now)
    db.prepare(`
      INSERT INTO repositories(id, name, path, path_key, position, created_at, updated_at)
      VALUES ('p3', 'p3', '/tmp/p3', '/tmp/p3', 0, ?, ?)
    `).run(now, now)
    assert.throws(
      () => insertProject.run('p3', 't1', 'shared-key', 'a'.repeat(64), now, now),
      /UNIQUE constraint failed: team_project.team_id, team_project.workspace_key/,
    )
  } finally {
    closeQuietly(db)
    fs.rmSync(workspace.root, { recursive: true, force: true })
  }
})

test('旧 JSON 一次性导入 SQLite 且重复打开不会重复导入', () => {
  const workspace = makeWorkspace()
  const repositoryPath = path.join(workspace.root, 'repos', 'demo')
  fs.mkdirSync(path.join(repositoryPath, '.trellis'), { recursive: true })
  writeJson(workspace.legacyFiles.repositoriesFile, {
    repositories: [{ id: 'demo', name: '演示项目', path: repositoryPath }],
  })
  writeJson(workspace.legacyFiles.metadataFile, {
    version: 1,
    tasks: {
      'demo/10-30-demo': {
        stage: 'check',
        updatedAt: '2026-10-30T01:00:00.000Z',
      },
    },
  })
  writeJson(workspace.legacyFiles.scanCacheFile, {
    schemaVersion: 8,
    savedAt: '2026-10-30T02:00:00.000Z',
    board: { generatedAt: '2026-10-30T02:00:00.000Z', tasks: [] },
  })
  writeJson(workspace.legacyFiles.stateFile, {
    refreshQueued: false,
    lastWatchEvent: { relativePath: 'tasks/demo' },
  })
  const legacyContents = Object.fromEntries(
    Object.entries(workspace.legacyFiles).map(([key, file]) => [
      key,
      fs.readFileSync(file, 'utf8'),
    ]),
  )

  let db
  try {
    db = openTestDatabase(workspace)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM repositories').get().count, 1)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM task_stage').get().count, 1)
    const persistence = createPersistenceStore({ db })
    assert.deepEqual(persistence.readScanCache(8), {
      generatedAt: '2026-10-30T02:00:00.000Z',
      tasks: [],
    })
    assert.deepEqual(persistence.readBoardState(), {
      refreshQueued: false,
      lastWatchEvent: { relativePath: 'tasks/demo' },
    })
    db.close()
    db = null

    db = openTestDatabase(workspace)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM repositories').get().count, 1)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM task_stage').get().count, 1)
    for (const [key, contents] of Object.entries(legacyContents)) {
      assert.equal(fs.readFileSync(workspace.legacyFiles[key], 'utf8'), contents)
    }
  } finally {
    closeQuietly(db)
    fs.rmSync(workspace.root, { recursive: true, force: true })
  }
})

test('损坏的旧 JSON 会被跳过并保留原文件', () => {
  const workspace = makeWorkspace()
  const broken = '{这不是合法 JSON'
  for (const file of Object.values(workspace.legacyFiles)) {
    fs.writeFileSync(file, broken, 'utf8')
  }
  let db
  try {
    db = openTestDatabase(workspace)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM repositories').get().count, 0)
    assert.equal(
      db.prepare("SELECT value FROM app_meta WHERE key = 'legacy_json_imported_v1'").get().value,
      '1',
    )
    for (const file of Object.values(workspace.legacyFiles)) {
      assert.equal(fs.readFileSync(file, 'utf8'), broken)
    }
  } finally {
    closeQuietly(db)
    fs.rmSync(workspace.root, { recursive: true, force: true })
  }
})
