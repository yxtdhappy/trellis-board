import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { openDatabase } from '../database.js'
import { STAGE_IDS } from '../metadata.js'
import {
  ARCHIVE_SNAPSHOT_MAX_FILE_BYTES,
  createArchiveSnapshotStore,
} from '../team/archive-local-snapshot.js'
import { createGitlessBoardService } from '../team/gitless-board-service.js'
import { createTaskSnapshotBackupService } from '../team/task-snapshot-backup.js'
import { createTaskSpaceIndex } from '../team/task-space-index.js'
import { createTaskSpaceService } from '../team/task-space-service.js'

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-archive-snapshot-'))
  const dataDir = path.join(root, 'data')
  const databaseFile = path.join(dataDir, 'board.sqlite')
  const db = openDatabase({
    databaseFile,
    fallbackRepositories: [],
    importLegacyRepositories: false,
    legacyJsonImport: false,
  })
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO team(id, name, slug, status, created_at, updated_at)
     VALUES ('team-1', '团队', 'team-1', 'active', ?, ?)`,
  ).run(now, now)
  db.prepare(
    `INSERT INTO user_account(
      id, username_key, username, display_name, password_hash, password_params_json,
      system_admin, status, must_change_password, password_changed_at, created_at, updated_at
    ) VALUES ('user-1', 'user-1', 'user-1', '用户一', 'x', '{}', 0, 'active', 0, ?, ?, ?)`,
  ).run(now, now, now)
  db.prepare(
    `INSERT INTO team_member(team_id, user_id, role, created_at, updated_at)
     VALUES ('team-1', 'user-1', 'member', ?, ?)`,
  ).run(now, now)
  db.prepare(
    `INSERT INTO agent_device(
      id, user_id, device_name, platform, agent_version, protocol_version,
      credential_hash, status, last_seen_at, created_at
    ) VALUES ('agent-1', 'user-1', '设备一', 'win32', '0.1.0', 3, 'credential', 'active', ?, ?)`,
  ).run(now, now)
  db.prepare(
    `INSERT INTO sync_active_agent(user_id, agent_id, updated_at)
     VALUES ('user-1', 'agent-1', ?)`,
  ).run(now)
  const taskSpaces = createTaskSpaceService({ db })
  const attached = taskSpaces.attach('user-1', 'agent-1', {
    remoteUrl: 'https://example.com/acme/repo.git',
    branchName: 'main',
    displayName: 'Acme',
    teamId: 'team-1',
    developerId: 'alice',
    localRepoKey: 'a'.repeat(64),
  })
  const snapshots = createArchiveSnapshotStore({ db, dataDir, databaseFile })
  return {
    root,
    dataDir,
    databaseFile,
    db,
    taskSpaces,
    snapshots,
    taskSpaceId: attached.taskSpace.id,
  }
}

function publishFixture(snapshots, taskSpaceId, attemptId, head, contents) {
  const staging = snapshots.createStaging(taskSpaceId, attemptId)
  const files = contents.map(({ relativePath, content, blobOid = 'a'.repeat(40) }) => {
    const written = staging.writeBlob({ relativePath, blobOid }, Buffer.from(content))
    return {
      ...written,
      taskDir: relativePath.split('/').slice(0, 5).join('/'),
      taskId: null,
    }
  })
  return {
    files,
    published: snapshots.publish({ staging, head, files }),
  }
}

function recordPublished(
  ctx,
  snapshot,
  head,
  { published = true, writeFiles = false, publishedAt = new Date().toISOString() } = {},
) {
  const timestamp = publishedAt
  const id = crypto.randomUUID()
  try {
    if (published) {
      ctx.db
        .prepare(`
          UPDATE sync_archive_snapshot
          SET active = 0
          WHERE task_space_id = ?
        `)
        .run(ctx.taskSpaceId)
    }
    ctx.db
      .prepare(`
      INSERT INTO sync_archive_snapshot(
        id, task_space_id, source_head, status, active, storage_root,
        file_count, byte_count, manifest_sha256, published_at, retired_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        id,
        ctx.taskSpaceId,
        head,
        published ? 'published' : 'retired',
        published ? 1 : 0,
        snapshot.storageRoot,
        snapshot.fileCount,
        snapshot.byteCount,
        snapshot.manifestSha256,
        timestamp,
        published ? null : timestamp,
      )
    if (published) {
      ctx.db
        .prepare(`
          UPDATE sync_task_space
          SET archive_snapshot_id = ?, archive_candidate_snapshot_id = NULL
          WHERE id = ?
        `)
        .run(id, ctx.taskSpaceId)
    }
    if (!writeFiles) return
    const insert = ctx.db.prepare(`
      INSERT INTO sync_archive_file(
        id, task_space_id, snapshot_id, relative_path, blob_oid, sha256, content_text,
        size_bytes, mime_type, storage_key, text_excerpt, task_id, task_dir,
        source_head, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, ?, NULL, ?, ?, ?, ?)
    `)
    for (const file of snapshot.files) {
      insert.run(
        crypto.randomUUID(),
        ctx.taskSpaceId,
        id,
        file.relativePath,
        file.blobOid,
        file.sha256,
        file.sizeBytes,
        file.mimeType,
        file.storageKey,
        file.relativePath.endsWith('/task.json') ? 'old' : null,
        file.relativePath.split('/').slice(0, 5).join('/'),
        head,
        timestamp,
      )
    }
  } finally {
    snapshot.release?.()
  }
}

test('本地快照完整物化归档任务并从详情下载元数据读取', async () => {
  const ctx = setup()
  const taskDir = '.trellis/tasks/archive/2026-11/11-16-old'
  const taskJson = JSON.stringify({
    id: 'old',
    title: '归档任务',
    description: '',
    status: 'completed',
    priority: 'P2',
    assignee: 'alice',
    creator: 'alice',
    branch: 'main',
  })
  const prd = '# 归档任务\n\n## Requirements\n\n- 已完成\n\n## Acceptance Criteria\n\n- [x] 完成\n'
  const fixture = publishFixture(ctx.snapshots, ctx.taskSpaceId, 'attempt-index', 'a'.repeat(40), [
    { relativePath: `${taskDir}/task.json`, content: taskJson },
    { relativePath: `${taskDir}/prd.md`, content: prd },
    {
      relativePath: `${taskDir}/evidence/screen.png`,
      content: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      blobOid: 'b'.repeat(40),
    },
  ])
  try {
    recordPublished(ctx, fixture.published, 'a'.repeat(40), { writeFiles: true })
    ctx.db
      .prepare('UPDATE sync_task_space SET archive_revision = 1 WHERE id = ?')
      .run(ctx.taskSpaceId)
    const index = createTaskSpaceIndex({
      db: ctx.db,
      stageIds: STAGE_IDS,
      taskSpaces: ctx.taskSpaces,
      archiveSnapshots: ctx.snapshots,
      logger: { warn() {}, info() {} },
    })
    const boardService = createGitlessBoardService({
      db: ctx.db,
      taskSpaces: ctx.taskSpaces,
      taskSpaceIndex: index,
      archiveSnapshots: ctx.snapshots,
    })
    try {
      await index.materializeNow(ctx.taskSpaceId, { source: 'archive' })
      const actor = ctx.taskSpaces.actorContext('user-1')
      const archived = index.queryTasks(actor, { taskSpaceId: ctx.taskSpaceId, archived: true })
      assert.equal(archived.total, 1)
      const detail = await boardService.getTask(actor, {
        taskSpaceId: ctx.taskSpaceId,
        executionTaskKey: archived.tasks[0].executionTaskKey,
      })
      assert.equal(detail.task.files.length, 3)
      const image = detail.task.files.find((file) => file.name === 'screen.png')
      assert.equal(image.mimeType, 'image/png')
      assert.equal(image.sizeBytes, 4)
      const download = await boardService.getArchiveFile(actor, ctx.taskSpaceId, image.id)
      assert.deepEqual([...download.buffer], [0x89, 0x50, 0x4e, 0x47])
      assert.equal(download.name, 'screen.png')

      const restartedSnapshots = createArchiveSnapshotStore({
        db: ctx.db,
        dataDir: ctx.dataDir,
        databaseFile: ctx.databaseFile,
      })
      const restartedDownload = await restartedSnapshots.readDownload(
        ctx.db.prepare('SELECT * FROM sync_archive_file WHERE id = ?').get(image.id),
      )
      assert.deepEqual([...restartedDownload], [0x89, 0x50, 0x4e, 0x47])
    } finally {
      await index.close()
    }
  } finally {
    ctx.db.close()
    fs.rmSync(ctx.root, { recursive: true, force: true })
  }
})

test('数据库备份引用的归档快照在 TaskSpace 物理删除后仍保留', async () => {
  const ctx = setup()
  try {
    const taskDir = '.trellis/tasks/archive/2026-11/11-16-old'
    const fixture = publishFixture(
      ctx.snapshots,
      ctx.taskSpaceId,
      'attempt-backup',
      'a'.repeat(40),
      [{ relativePath: `${taskDir}/task.json`, content: '{"id":"old"}' }],
    )
    recordPublished(ctx, fixture.published, 'a'.repeat(40), { writeFiles: true })
    const backup = createTaskSnapshotBackupService({
      db: ctx.db,
      databaseFile: ctx.databaseFile,
      logger: { warn() {} },
    })
    const backupFile = backup.backupNowOrThrow({ force: true })
    assert.ok(backupFile)
    const snapshotDirectory = path.join(
      ctx.dataDir,
      'archive-snapshots',
      ...fixture.published.storageRoot.split('/'),
    )
    assert.equal(fs.existsSync(snapshotDirectory), true)

    ctx.db.prepare('DELETE FROM sync_task_space WHERE id = ?').run(ctx.taskSpaceId)
    ctx.snapshots.cleanup()
    assert.equal(fs.existsSync(snapshotDirectory), true)

    fs.rmSync(backupFile)
    const corruptBackup = path.join(
      path.dirname(ctx.databaseFile),
      'backups',
      'board.sqlite.snapshot.20261117T000000000Z',
    )
    fs.writeFileSync(corruptBackup, 'not sqlite')
    assert.throws(
      () => ctx.snapshots.cleanup(),
      (error) => error?.code === 'ARCHIVE_SNAPSHOT_BACKUP_SCAN_FAILED',
    )
    assert.equal(fs.existsSync(snapshotDirectory), true)

    fs.rmSync(corruptBackup)
    ctx.snapshots.cleanup()
    assert.equal(fs.existsSync(snapshotDirectory), false)
  } finally {
    ctx.db.close()
    fs.rmSync(ctx.root, { recursive: true, force: true })
  }
})

test('清理保留进行中的 staging 和已发布但尚未提交的快照', async () => {
  const ctx = setup()
  try {
    const taskDir = '.trellis/tasks/archive/2026-11/11-16-old'
    const staging = ctx.snapshots.createStaging(ctx.taskSpaceId, 'attempt-active')
    staging.writeBlob(
      { relativePath: `${taskDir}/active.bin`, blobOid: 'a'.repeat(40) },
      Buffer.from('active'),
    )
    ctx.snapshots.cleanup()
    assert.equal(fs.existsSync(staging.directory), true)
    staging.cancel()

    const fixture = publishFixture(
      ctx.snapshots,
      ctx.taskSpaceId,
      'attempt-pending',
      'b'.repeat(40),
      [{ relativePath: `${taskDir}/task.json`, content: '{"id":"pending"}' }],
    )
    ctx.snapshots.cleanup()
    assert.equal(
      fs.existsSync(
        path.join(ctx.dataDir, 'archive-snapshots', ...fixture.published.storageRoot.split('/')),
      ),
      true,
    )
    recordPublished(ctx, fixture.published, 'b'.repeat(40), { writeFiles: true })
    ctx.snapshots.cleanup()
    assert.equal(
      fs.existsSync(
        path.join(ctx.dataDir, 'archive-snapshots', ...fixture.published.storageRoot.split('/')),
      ),
      true,
    )
  } finally {
    ctx.db.close()
    fs.rmSync(ctx.root, { recursive: true, force: true })
  }
})

test('进行中的 staging 不因 TTL 过期被并发清理', () => {
  const ctx = setup()
  const store = createArchiveSnapshotStore({
    db: ctx.db,
    dataDir: ctx.dataDir,
    databaseFile: ctx.databaseFile,
    stagingTtlMs: 0,
  })
  const staging = store.createStaging(ctx.taskSpaceId, 'attempt-long')
  try {
    staging.writeBlob(
      {
        relativePath: '.trellis/tasks/archive/2026-11/11-16-old/active.bin',
        blobOid: 'a'.repeat(40),
      },
      Buffer.from('active'),
    )
    fs.utimesSync(staging.directory, new Date(0), new Date(0))
    store.cleanup()
    assert.equal(fs.existsSync(staging.directory), true)
  } finally {
    staging.cancel()
    ctx.db.close()
    fs.rmSync(ctx.root, { recursive: true, force: true })
  }
})

test('当前文件映射失去 active/candidate 指针时清理失败关闭', () => {
  const ctx = setup()
  try {
    const fixture = publishFixture(
      ctx.snapshots,
      ctx.taskSpaceId,
      'attempt-orphan-current',
      'a'.repeat(40),
      [
        {
          relativePath: '.trellis/tasks/archive/2026-11/11-16-old/task.json',
          content: '{"id":"orphan"}',
        },
      ],
    )
    recordPublished(ctx, fixture.published, 'a'.repeat(40), { writeFiles: true })
    ctx.db
      .prepare(`
        UPDATE sync_task_space
        SET archive_snapshot_id = NULL, archive_candidate_snapshot_id = NULL
        WHERE id = ?
      `)
      .run(ctx.taskSpaceId)
    assert.throws(
      () => ctx.snapshots.cleanup(),
      (error) => error?.code === 'ARCHIVE_SNAPSHOT_REFERENCE_INVALID',
    )
  } finally {
    ctx.db.close()
    fs.rmSync(ctx.root, { recursive: true, force: true })
  }
})

test('首次候选失败保留 legacy 历史 fileId，激活后才清理', () => {
  const ctx = setup()
  try {
    const taskDir = '.trellis/tasks/archive/2026-11/11-16-old'
    const fixture = publishFixture(
      ctx.snapshots,
      ctx.taskSpaceId,
      'attempt-legacy-candidate',
      'b'.repeat(40),
      [{ relativePath: `${taskDir}/task.json`, content: '{"id":"pending"}' }],
    )
    const snapshotId = crypto.randomUUID()
    const timestamp = new Date().toISOString()
    ctx.db
      .prepare(`
        INSERT INTO sync_archive_snapshot(
          id, task_space_id, source_head, status, active, storage_root,
          file_count, byte_count, manifest_sha256, published_at
        ) VALUES (?, ?, ?, 'published', 0, ?, ?, ?, ?, ?)
      `)
      .run(
        snapshotId,
        ctx.taskSpaceId,
        fixture.published.sourceHead,
        fixture.published.storageRoot,
        fixture.published.fileCount,
        fixture.published.byteCount,
        fixture.published.manifestSha256,
        timestamp,
      )
    ctx.db
      .prepare(`
        UPDATE sync_task_space
        SET archive_candidate_snapshot_id = ?
        WHERE id = ?
      `)
      .run(snapshotId, ctx.taskSpaceId)
    ctx.db
      .prepare(`
        INSERT INTO sync_archive_file_history(
          id, task_space_id, snapshot_id, relative_path, blob_oid, sha256,
          content_text, size_bytes, mime_type, task_id, task_dir, updated_at
        ) VALUES ('legacy-file', ?, NULL, ?, 'legacy', ?, '{"id":"old"}',
          12, 'application/json; charset=utf-8', 'old', ?, ?)
      `)
      .run(ctx.taskSpaceId, `${taskDir}/task.json`, 'a'.repeat(64), taskDir, timestamp)
    fixture.published.release()

    ctx.snapshots.cleanup()
    assert.ok(
      ctx.db.prepare("SELECT 1 FROM sync_archive_file_history WHERE id = 'legacy-file'").get(),
    )

    ctx.db
      .prepare(`
        UPDATE sync_archive_snapshot
        SET active = 1
        WHERE id = ?
      `)
      .run(snapshotId)
    ctx.db
      .prepare(`
        UPDATE sync_task_space
        SET archive_snapshot_id = ?, archive_candidate_snapshot_id = NULL
        WHERE id = ?
      `)
      .run(snapshotId, ctx.taskSpaceId)
    ctx.snapshots.cleanup()
    assert.equal(
      ctx.db.prepare("SELECT 1 FROM sync_archive_file_history WHERE id = 'legacy-file'").get(),
      undefined,
    )
  } finally {
    ctx.db.close()
    fs.rmSync(ctx.root, { recursive: true, force: true })
  }
})

test('快照拒绝超限文件，清理 staging、旧版本并检测本地文件损坏', async () => {
  const ctx = setup()
  try {
    const staging = ctx.snapshots.createStaging(ctx.taskSpaceId, 'attempt-too-large')
    assert.throws(
      () =>
        staging.writeBlob(
          {
            relativePath: '.trellis/tasks/archive/2026-11/11-16-old/evidence/huge.bin',
          },
          Buffer.alloc(ARCHIVE_SNAPSHOT_MAX_FILE_BYTES + 1),
        ),
      (error) => error?.code === 'ARCHIVE_FILE_TOO_LARGE',
    )
    staging.cancel()

    const root = '.trellis/tasks/archive/2026-11/11-16-old'
    const first = publishFixture(ctx.snapshots, ctx.taskSpaceId, 'attempt-1', 'a'.repeat(40), [
      { relativePath: `${root}/task.json`, content: '{"id":"old"}' },
    ])
    recordPublished(ctx, first.published, 'a'.repeat(40), {
      published: false,
      publishedAt: '2026-11-01T00:00:00.000Z',
    })
    const second = publishFixture(ctx.snapshots, ctx.taskSpaceId, 'attempt-2', 'b'.repeat(40), [
      { relativePath: `${root}/task.json`, content: '{"id":"old"}' },
    ])
    recordPublished(ctx, second.published, 'b'.repeat(40), {
      publishedAt: '2026-11-02T00:00:00.000Z',
    })
    const third = publishFixture(ctx.snapshots, ctx.taskSpaceId, 'attempt-3', 'c'.repeat(40), [
      { relativePath: `${root}/task.json`, content: '{"id":"old"}' },
    ])
    recordPublished(ctx, third.published, 'c'.repeat(40), {
      writeFiles: true,
      publishedAt: '2026-11-03T00:00:00.000Z',
    })
    ctx.db
      .prepare(
        "UPDATE sync_archive_snapshot SET status = 'retired' WHERE task_space_id = ? AND source_head = ?",
      )
      .run(ctx.taskSpaceId, 'b'.repeat(40))

    const result = ctx.snapshots.cleanup()
    assert.ok(result.removedSnapshotRows >= 1)
    assert.equal(
      fs.existsSync(
        path.join(ctx.dataDir, 'archive-snapshots', ...first.published.storageRoot.split('/')),
      ),
      false,
    )
    assert.equal(
      fs.existsSync(
        path.join(ctx.dataDir, 'archive-snapshots', ...third.published.storageRoot.split('/')),
      ),
      true,
    )

    const row = ctx.db
      .prepare(
        'SELECT * FROM sync_archive_file WHERE task_space_id = ? AND storage_key IS NOT NULL ORDER BY source_head DESC LIMIT 1',
      )
      .get(ctx.taskSpaceId)
    const localFile = path.join(ctx.dataDir, 'archive-snapshots', ...row.storage_key.split('/'))
    fs.writeFileSync(localFile, Buffer.alloc(row.size_bytes, 0x58))
    await assert.rejects(
      () => ctx.snapshots.readDownload(row),
      (error) => error?.code === 'ARCHIVE_LOCAL_FILE_UNAVAILABLE',
    )
    fs.rmSync(localFile)
    await assert.rejects(
      () => ctx.snapshots.readDownload(row),
      (error) => error?.code === 'ARCHIVE_LOCAL_FILE_UNAVAILABLE',
    )
    assert.throws(
      () => ctx.snapshots.readText(`${ctx.taskSpaceId}/../outside.txt`),
      (error) => error?.code === 'ARCHIVE_LOCAL_FILE_UNAVAILABLE',
    )

    ctx.db.prepare('DELETE FROM sync_task_space WHERE id = ?').run(ctx.taskSpaceId)
    ctx.snapshots.cleanup()
    assert.equal(fs.existsSync(path.join(ctx.dataDir, 'archive-snapshots', ctx.taskSpaceId)), false)
  } finally {
    ctx.db.close()
    fs.rmSync(ctx.root, { recursive: true, force: true })
  }
})
