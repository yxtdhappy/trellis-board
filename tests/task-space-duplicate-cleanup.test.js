import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { openDatabase } from '../server/database.js'
import { snapshotSha256 } from '../shared/task-snapshot.js'
import { cleanupDuplicateTasks } from '../scripts/task-space-duplicate-cleanup.js'

const PROJECT_ID = 'project-cleanup'
const REMOVE_TASK_SPACE = 'space-remove'
const KEEP_TASK_SPACE = 'space-keep'
const TIMESTAMP = '2026-11-12T10:00:00.000Z'

function insertFile(db, taskSpaceId, relativePath, content, revision) {
  const parts = relativePath.split('/')
  const taskDir = parts.slice(0, 5).includes('archive')
    ? parts.slice(0, 5).join('/')
    : parts.slice(0, 3).join('/')
  db.prepare(`
    INSERT INTO sync_task_space_file(
      task_space_id, relative_path, revision, sha256, content_text, deleted,
      task_id, task_dir, source_agent_id, source_user_id,
      source_client_sequence, updated_at
    ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, NULL, NULL, NULL, ?)
  `).run(
    taskSpaceId,
    relativePath,
    revision,
    snapshotSha256(content),
    content,
    parts[2] === 'archive' ? 'archived-task' : 'duplicate-task',
    taskDir,
    TIMESTAMP,
  )
}

function setup({ removePrd = '# PRD\n', keepPrd = '# PRD\n', unresolved = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-duplicate-cleanup-'))
  const databaseFile = path.join(root, 'board.sqlite')
  const db = openDatabase({
    databaseFile,
    fallbackRepositories: [],
    importLegacyRepositories: false,
    legacyJsonImport: false,
  })
  db.prepare(`
    INSERT INTO team(id, name, slug, status, created_at, updated_at)
    VALUES ('team-cleanup', '清理测试', 'cleanup', 'active', ?, ?)
  `).run(TIMESTAMP, TIMESTAMP)
  db.prepare(`
    INSERT INTO sync_project(
      id, name, remote_url, remote_identity_hash, owner_team_id, status,
      created_by_user_id, created_by_agent_id, created_at, updated_at
    ) VALUES (?, '清理项目', 'https://example.com/acme/repo.git', ?, 'team-cleanup',
      'active', NULL, NULL, ?, ?)
  `).run(PROJECT_ID, 'd'.repeat(64), TIMESTAMP, TIMESTAMP)
  const insertTaskSpace = db.prepare(`
    INSERT INTO sync_task_space(
      id, project_id, branch_name, status, revision, indexed_revision,
      last_error, created_by_user_id, created_by_agent_id, created_at, updated_at
    ) VALUES (?, ?, ?, 'active', ?, ?, NULL, NULL, NULL, ?, ?)
  `)
  insertTaskSpace.run(REMOVE_TASK_SPACE, PROJECT_ID, 'codex/old', 7, 7, TIMESTAMP, TIMESTAMP)
  insertTaskSpace.run(KEEP_TASK_SPACE, PROJECT_ID, 'main', 4, 4, TIMESTAMP, TIMESTAMP)

  const duplicateTask = '.trellis/tasks/11-12-duplicate'
  const taskJson = `${JSON.stringify({ id: 'duplicate-task', title: '重复任务' })}\n`
  insertFile(db, REMOVE_TASK_SPACE, `${duplicateTask}/task.json`, taskJson, 7)
  insertFile(db, REMOVE_TASK_SPACE, `${duplicateTask}/prd.md`, removePrd, 7)
  insertFile(db, KEEP_TASK_SPACE, `${duplicateTask}/task.json`, taskJson, 4)
  insertFile(db, KEEP_TASK_SPACE, `${duplicateTask}/prd.md`, keepPrd, 4)

  insertFile(db, REMOVE_TASK_SPACE, '.trellis/tasks/11-12-only-old/task.json', taskJson, 7)
  insertFile(
    db,
    REMOVE_TASK_SPACE,
    '.trellis/tasks/archive/2026-11/archived/task.json',
    taskJson,
    7,
  )
  insertFile(db, KEEP_TASK_SPACE, '.trellis/tasks/archive/2026-11/archived/task.json', taskJson, 4)
  if (unresolved) {
    insertFile(db, REMOVE_TASK_SPACE, '.trellis/tasks/11-12-broken/prd.md', '# BROKEN\n', 7)
  }

  db.prepare(`
    INSERT INTO sync_task_index(
      task_space_id, project_id, task_key, execution_task_key, relative_dir,
      branch_name, title, search_text, archived, priority, derived_stage,
      is_blocked, is_unblocked_ready, attention_flags_json, group_key,
      group_role, task_version, board_version, updated_at
    ) VALUES (?, ?, 'old-key', 'old-exec', ?, 'codex/old', '重复任务', '重复任务',
      0, 'P1', 'implement', 0, 0, '[]', 'old-key', 'parent', 'v1', 'b1', ?)
  `).run(REMOVE_TASK_SPACE, PROJECT_ID, duplicateTask, TIMESTAMP)
  db.prepare(`
    INSERT INTO sync_task_index_tag(task_space_id, task_key, tag_key)
    VALUES (?, 'old-key', 'tag')
  `).run(REMOVE_TASK_SPACE)
  db.prepare(`
    INSERT INTO sync_task_space_scan_cache(task_space_id, indexed_revision, board_json, saved_at)
    VALUES (?, 7, '{}', ?)
  `).run(REMOVE_TASK_SPACE, TIMESTAMP)
  db.close()
  return { root, databaseFile }
}

function fileState(databaseFile, taskSpaceId, relativePath) {
  const db = new DatabaseSync(databaseFile, { readOnly: true })
  try {
    return db
      .prepare(`
        SELECT deleted, content_text FROM sync_task_space_file
        WHERE task_space_id = ? AND relative_path = ?
      `)
      .get(taskSpaceId, relativePath)
  } finally {
    db.close()
  }
}

test('重复任务清理默认只读并排除归档任务', async () => {
  const fixture = setup()
  try {
    const result = await cleanupDuplicateTasks({
      databaseFile: fixture.databaseFile,
      projectId: PROJECT_ID,
      removeTaskSpaceId: REMOVE_TASK_SPACE,
      keepTaskSpaceId: KEEP_TASK_SPACE,
    })
    assert.equal(result.mode, 'dry-run')
    assert.equal(result.applied, false)
    assert.equal(result.summary.duplicateTasks, 1)
    assert.equal(result.summary.filesToDelete, 2)
    assert.equal(result.unresolved.length, 0)
    assert.deepEqual(
      result.filesToDelete.map((file) => file.path),
      ['.trellis/tasks/11-12-duplicate/prd.md', '.trellis/tasks/11-12-duplicate/task.json'],
    )
    assert.equal(
      fileState(fixture.databaseFile, REMOVE_TASK_SPACE, '.trellis/tasks/11-12-duplicate/task.json')
        .deleted,
      0,
    )
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('apply 只墓碑旧任务空间重复目录并备份数据库', async () => {
  const fixture = setup()
  try {
    let serviceChecks = 0
    const result = await cleanupDuplicateTasks({
      databaseFile: fixture.databaseFile,
      projectId: PROJECT_ID,
      removeTaskSpaceId: REMOVE_TASK_SPACE,
      keepTaskSpaceId: KEEP_TASK_SPACE,
      apply: true,
      now: new Date(TIMESTAMP),
      checkServiceStopped: async () => {
        serviceChecks += 1
      },
    })
    assert.equal(result.applied, true)
    assert.equal(serviceChecks, 1)
    assert.equal(result.revision, 8)
    assert.ok(result.backupFile && fs.existsSync(result.backupFile))
    assert.equal(
      fileState(fixture.databaseFile, REMOVE_TASK_SPACE, '.trellis/tasks/11-12-duplicate/prd.md')
        .deleted,
      1,
    )
    assert.equal(
      fileState(fixture.databaseFile, KEEP_TASK_SPACE, '.trellis/tasks/11-12-duplicate/prd.md')
        .deleted,
      0,
    )
    assert.equal(
      fileState(fixture.databaseFile, REMOVE_TASK_SPACE, '.trellis/tasks/11-12-only-old/task.json')
        .deleted,
      0,
    )
    assert.equal(
      fileState(
        fixture.databaseFile,
        REMOVE_TASK_SPACE,
        '.trellis/tasks/archive/2026-11/archived/task.json',
      ).deleted,
      0,
    )

    const db = new DatabaseSync(fixture.databaseFile, { readOnly: true })
    try {
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sync_file_audit').get().count, 2)
      assert.equal(
        db
          .prepare('SELECT COUNT(*) AS count FROM sync_task_index WHERE task_space_id = ?')
          .get(REMOVE_TASK_SPACE).count,
        0,
      )
      assert.equal(
        db
          .prepare(
            'SELECT COUNT(*) AS count FROM sync_task_space_scan_cache WHERE task_space_id = ?',
          )
          .get(REMOVE_TASK_SPACE).count,
        0,
      )
      assert.equal(
        db
          .prepare('SELECT status, revision FROM sync_task_space WHERE id = ?')
          .get(REMOVE_TASK_SPACE).status,
        'indexing',
      )
    } finally {
      db.close()
    }
    const backup = new DatabaseSync(result.backupFile, { readOnly: true })
    try {
      assert.equal(
        backup
          .prepare(`
            SELECT deleted FROM sync_task_space_file
            WHERE task_space_id = ? AND relative_path = ?
          `)
          .get(REMOVE_TASK_SPACE, '.trellis/tasks/11-12-duplicate/task.json').deleted,
        0,
      )
    } finally {
      backup.close()
    }
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('内容差异和缺少稳定任务 ID 会阻止自动清理', async () => {
  const contentFixture = setup({ removePrd: '# 本地旧版\n', keepPrd: '# main 新版\n' })
  try {
    await assert.rejects(
      cleanupDuplicateTasks({
        databaseFile: contentFixture.databaseFile,
        projectId: PROJECT_ID,
        removeTaskSpaceId: REMOVE_TASK_SPACE,
        keepTaskSpaceId: KEEP_TASK_SPACE,
        apply: true,
        checkServiceStopped: async () => {},
      }),
      /内容差异/,
    )
    const applied = await cleanupDuplicateTasks({
      databaseFile: contentFixture.databaseFile,
      projectId: PROJECT_ID,
      removeTaskSpaceId: REMOVE_TASK_SPACE,
      keepTaskSpaceId: KEEP_TASK_SPACE,
      apply: true,
      allowContentDifferences: true,
      checkServiceStopped: async () => {},
    })
    assert.equal(applied.applied, true)
  } finally {
    fs.rmSync(contentFixture.root, { recursive: true, force: true })
  }

  const unresolvedFixture = setup({ unresolved: true })
  try {
    await assert.rejects(
      cleanupDuplicateTasks({
        databaseFile: unresolvedFixture.databaseFile,
        projectId: PROJECT_ID,
        removeTaskSpaceId: REMOVE_TASK_SPACE,
        keepTaskSpaceId: KEEP_TASK_SPACE,
        apply: true,
        checkServiceStopped: async () => {},
      }),
      /缺少稳定任务 ID/,
    )
  } finally {
    fs.rmSync(unresolvedFixture.root, { recursive: true, force: true })
  }
})
