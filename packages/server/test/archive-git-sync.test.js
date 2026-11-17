import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { snapshotSha256 } from '@trellis-board/shared/task-snapshot.js'
import { openDatabase } from '../database.js'
import { STAGE_IDS } from '../metadata.js'
import { createArchiveGitSyncService } from '../team/archive-git-sync.js'
import { createArchiveSnapshotStore } from '../team/archive-local-snapshot.js'
import { createGitlessBoardService } from '../team/gitless-board-service.js'
import { createTaskSpaceIndex } from '../team/task-space-index.js'
import { createTaskSpaceService } from '../team/task-space-service.js'

const LOGGER = { info() {}, warn() {} }

async function waitFor(check, timeoutMs = 2000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const value = check()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('等待归档同步状态超时')
}

function setup() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-archive-sync-'))
  const db = openDatabase({
    databaseFile: ':memory:',
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
  return {
    dataDir,
    db,
    taskSpaces,
    taskSpaceId: attached.taskSpace.id,
  }
}

function snapshot(taskSpaceId, title = '归档任务') {
  const taskDir = '.trellis/tasks/archive/2026-11/11-16-old'
  const taskJson = JSON.stringify({
    id: 'old',
    title,
    branch: 'main',
  })
  const prd = `# ${title}\n`
  const files = [
    {
      relativePath: `${taskDir}/task.json`,
      blobOid: 'a'.repeat(40),
      sha256: snapshotSha256(taskJson),
      content: taskJson,
      taskDir,
      taskId: 'old',
    },
    {
      relativePath: `${taskDir}/prd.md`,
      blobOid: 'b'.repeat(40),
      sha256: snapshotSha256(prd),
      content: prd,
      taskDir,
      taskId: null,
    },
  ]
  return { taskSpaceId, files }
}

test('归档同步区分 fetch/import/index 失败并保留旧快照和索引时间', async () => {
  const ctx = setup()
  const calls = []
  const fakeStore = {
    async readSnapshot(input) {
      calls.push(input)
      const fixture = snapshot(ctx.taskSpaceId)
      const files = fixture.files.map((file) => ({
        ...input.snapshotWriter.writeBlob(file, Buffer.from(file.content)),
        blobOid: file.blobOid,
        taskDir: file.taskDir,
        taskId: file.taskId,
      }))
      return {
        head: 'c'.repeat(40),
        files,
        fileCount: files.length,
        byteCount: files.reduce((sum, file) => sum + file.sizeBytes, 0),
        skipped: false,
        metrics: { fetchMs: 1, readMs: 1, totalMs: 2 },
        taskSpaceId: ctx.taskSpaceId,
      }
    },
  }
  const index = {
    enqueue: async () => undefined,
  }
  const sync = createArchiveGitSyncService({
    db: ctx.db,
    dataDir: ctx.dataDir,
    config: { allowLocalGitRemotes: false },
    taskSpaceIndex: index,
    store: fakeStore,
    logger: LOGGER,
  })
  try {
    assert.deepEqual(await sync.runNow(ctx.taskSpaceId), { queued: 1 })
    await waitFor(() => {
      const state = ctx.db
        .prepare('SELECT status FROM sync_archive_sync_state WHERE task_space_id = ?')
        .get(ctx.taskSpaceId)
      return state?.status === 'indexing'
    })
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS count FROM sync_archive_file').get().count, 2)
    const storedFile = ctx.db
      .prepare(`
        SELECT content_text, size_bytes, mime_type, storage_key, id
        FROM sync_archive_file
        WHERE relative_path LIKE '%/task.json'
      `)
      .get()
    assert.equal(storedFile.content_text, '')
    assert.ok(storedFile.size_bytes > 0)
    assert.equal(storedFile.mime_type, 'application/json; charset=utf-8')
    assert.match(storedFile.storage_key, /^[^/]+\/heads\/[a-f0-9]{40}\/files\/[a-f0-9]{64}$/)
    assert.ok(storedFile.id)
    assert.equal(
      ctx.db.prepare('SELECT COUNT(*) AS count FROM sync_archive_snapshot').get().count,
      1,
    )
    assert.equal(
      ctx.db
        .prepare('SELECT archive_revision FROM sync_task_space WHERE id = ?')
        .get(ctx.taskSpaceId).archive_revision,
      1,
    )

    sync.onIndexProjected({
      taskSpaceId: ctx.taskSpaceId,
      source: 'archive',
      archiveAdvanced: true,
    })
    const indexed = ctx.db
      .prepare(`
        SELECT status, last_success_at, last_indexed_at
        FROM sync_archive_sync_state WHERE task_space_id = ?
      `)
      .get(ctx.taskSpaceId)
    assert.equal(indexed.status, 'current')
    assert.ok(indexed.last_success_at)
    assert.ok(indexed.last_indexed_at)

    fakeStore.readSnapshot = async () => {
      const error = new Error('归档文件损坏')
      error.code = 'ARCHIVE_FILE_NOT_UTF8'
      error.archivePhase = 'import'
      throw error
    }
    await sync.runNow(ctx.taskSpaceId)
    await waitFor(() => {
      const state = ctx.db
        .prepare('SELECT status FROM sync_archive_sync_state WHERE task_space_id = ?')
        .get(ctx.taskSpaceId)
      return state?.status === 'error'
    })
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS count FROM sync_archive_file').get().count, 2)
    const importLog = ctx.db
      .prepare('SELECT phase, error_code FROM sync_archive_sync_log ORDER BY id DESC LIMIT 1')
      .get()
    assert.deepEqual({ ...importLog }, { phase: 'import', error_code: 'ARCHIVE_FILE_NOT_UTF8' })
    assert.equal(
      ctx.db
        .prepare('SELECT last_indexed_at FROM sync_archive_sync_state WHERE task_space_id = ?')
        .get(ctx.taskSpaceId).last_indexed_at,
      indexed.last_indexed_at,
    )

    fakeStore.readSnapshot = async () => {
      const error = new Error('网络断开')
      error.code = 'ARCHIVE_GIT_UNREACHABLE'
      error.archivePhase = 'fetch'
      throw error
    }
    await sync.runNow(ctx.taskSpaceId)
    await waitFor(() => {
      return ctx.db
        .prepare(`
          SELECT 1
          FROM sync_archive_sync_log
          WHERE task_space_id = ? AND error_code = 'ARCHIVE_GIT_UNREACHABLE'
          ORDER BY id DESC LIMIT 1
        `)
        .get(ctx.taskSpaceId)
    })
    const fetchLog = ctx.db
      .prepare('SELECT phase, error_code FROM sync_archive_sync_log ORDER BY id DESC LIMIT 1')
      .get()
    assert.deepEqual({ ...fetchLog }, { phase: 'fetch', error_code: 'ARCHIVE_GIT_UNREACHABLE' })

    ctx.db
      .prepare('UPDATE sync_task_space SET archive_indexed_revision = 0 WHERE id = ?')
      .run(ctx.taskSpaceId)
    const beforeFailure = ctx.db
      .prepare('SELECT last_indexed_at FROM sync_archive_sync_state WHERE task_space_id = ?')
      .get(ctx.taskSpaceId).last_indexed_at
    for (let index = 0; index < 105; index += 1) {
      sync.onIndexProjectionFailed({
        taskSpaceId: ctx.taskSpaceId,
        error: new Error(`索引失败 ${index}`),
        attemptId: `attempt-${index}`,
        sources: ['archive'],
      })
    }
    const state = ctx.db
      .prepare(
        'SELECT status, last_indexed_at FROM sync_archive_sync_state WHERE task_space_id = ?',
      )
      .get(ctx.taskSpaceId)
    assert.equal(state.status, 'index_error')
    assert.equal(state.last_indexed_at, beforeFailure)
    assert.equal(
      ctx.db.prepare('SELECT COUNT(*) AS count FROM sync_archive_sync_log').get().count,
      100,
    )
    assert.equal(
      ctx.db.prepare('SELECT phase FROM sync_archive_sync_log ORDER BY id DESC LIMIT 1').get()
        .phase,
      'index',
    )
  } finally {
    ctx.db.close()
    fs.rmSync(ctx.dataDir, { recursive: true, force: true })
  }
})

test('相同内容更换 HEAD 不增加归档 revision，数据库发布失败保留旧快照和 Board', async () => {
  const ctx = setup()
  const snapshots = createArchiveSnapshotStore({ db: ctx.db, dataDir: ctx.dataDir })
  let head = 'a'.repeat(40)
  let title = '旧标题'
  const fakeStore = {
    async readSnapshot(input) {
      const fixture = snapshot(ctx.taskSpaceId, title)
      const files = fixture.files.map((file) => ({
        ...input.snapshotWriter.writeBlob(file, Buffer.from(file.content)),
        blobOid: file.blobOid,
        taskDir: file.taskDir,
        taskId: file.taskId,
      }))
      return {
        head,
        files,
        fileCount: files.length,
        byteCount: files.reduce((sum, file) => sum + file.sizeBytes, 0),
        skipped: false,
        metrics: { fetchMs: 1, readMs: 1, totalMs: 2 },
        taskSpaceId: ctx.taskSpaceId,
      }
    },
  }
  let sync
  const index = createTaskSpaceIndex({
    db: ctx.db,
    stageIds: STAGE_IDS,
    taskSpaces: ctx.taskSpaces,
    archiveSnapshots: snapshots,
    logger: LOGGER,
  })
  sync = createArchiveGitSyncService({
    db: ctx.db,
    dataDir: ctx.dataDir,
    config: { allowLocalGitRemotes: false },
    taskSpaceIndex: index,
    store: fakeStore,
    snapshots,
    logger: LOGGER,
  })
  try {
    await sync.runNow(ctx.taskSpaceId)
    await waitFor(() => {
      const state = ctx.db
        .prepare('SELECT status FROM sync_archive_sync_state WHERE task_space_id = ?')
        .get(ctx.taskSpaceId)
      return state?.status === 'indexing'
    })
    await index.materializeNow(ctx.taskSpaceId, { source: 'archive' })
    sync.onIndexProjected({
      taskSpaceId: ctx.taskSpaceId,
      source: 'archive',
      archiveAdvanced: true,
    })
    const originalTask = index.queryTasks(ctx.taskSpaces.actorContext('user-1'), {
      taskSpaceId: ctx.taskSpaceId,
      archived: true,
    }).tasks[0]
    const originalRevision = Number(
      ctx.db
        .prepare('SELECT archive_revision FROM sync_task_space WHERE id = ?')
        .get(ctx.taskSpaceId).archive_revision,
    )
    const originalId = ctx.db
      .prepare("SELECT id FROM sync_archive_file WHERE relative_path LIKE '%/task.json'")
      .get().id

    head = 'b'.repeat(40)
    await sync.runNow(ctx.taskSpaceId)
    await waitFor(() => {
      const state = ctx.db
        .prepare('SELECT status, remote_head FROM sync_archive_sync_state WHERE task_space_id = ?')
        .get(ctx.taskSpaceId)
      return state?.status === 'indexing' && state.remote_head === head
    })
    await index.materializeNow(ctx.taskSpaceId, { source: 'archive' })
    sync.onIndexProjected({
      taskSpaceId: ctx.taskSpaceId,
      source: 'archive',
      archiveAdvanced: false,
    })
    const refreshed = ctx.db
      .prepare(`
        SELECT id, source_head, storage_key
        FROM sync_archive_file
        WHERE relative_path LIKE '%/task.json'
      `)
      .get()
    assert.equal(refreshed.id, originalId)
    assert.equal(refreshed.source_head, head)
    assert.match(refreshed.storage_key, new RegExp(`/heads/${head}/`))
    assert.equal(
      ctx.db
        .prepare('SELECT archive_revision FROM sync_task_space WHERE id = ?')
        .get(ctx.taskSpaceId).archive_revision,
      originalRevision,
    )

    const cachedBoard = index.readTaskSpaceCache(ctx.taskSpaceId).board
    ctx.db.exec(`
      CREATE TRIGGER fail_archive_snapshot
      BEFORE INSERT ON sync_archive_snapshot
      WHEN NEW.source_head = '${'c'.repeat(40)}'
      BEGIN
        SELECT RAISE(ABORT, 'forced archive snapshot failure');
      END
    `)
    head = 'c'.repeat(40)
    title = '失败的新标题'
    await sync.runNow(ctx.taskSpaceId)
    await waitFor(() => {
      const state = ctx.db
        .prepare('SELECT status FROM sync_archive_sync_state WHERE task_space_id = ?')
        .get(ctx.taskSpaceId)
      return state?.status === 'error'
    })
    assert.deepEqual(index.readTaskSpaceCache(ctx.taskSpaceId).board, cachedBoard)
    assert.deepEqual(
      index
        .queryTasks(ctx.taskSpaces.actorContext('user-1'), {
          taskSpaceId: ctx.taskSpaceId,
          archived: true,
        })
        .tasks.map((task) => task.executionTaskKey),
      [originalTask.executionTaskKey],
    )
    assert.equal(
      ctx.db
        .prepare('SELECT archive_revision FROM sync_task_space WHERE id = ?')
        .get(ctx.taskSpaceId).archive_revision,
      originalRevision,
    )
    const preserved = ctx.db
      .prepare(`
        SELECT source_head, storage_key
        FROM sync_archive_file
        WHERE relative_path LIKE '%/task.json'
      `)
      .get()
    assert.equal(preserved.source_head, 'b'.repeat(40))
    assert.match(preserved.storage_key, new RegExp(`/heads/${'b'.repeat(40)}/`))
    assert.equal(
      fs.existsSync(
        path.join(ctx.dataDir, 'archive-snapshots', ctx.taskSpaceId, 'heads', 'c'.repeat(40)),
      ),
      false,
    )
    const preservedDownload = await snapshots.readDownload(
      ctx.db
        .prepare("SELECT * FROM sync_archive_file WHERE relative_path LIKE '%/task.json'")
        .get(),
    )
    assert.match(preservedDownload.toString('utf8'), /旧标题/)
  } finally {
    await index.close()
    ctx.db.close()
    fs.rmSync(ctx.dataDir, { recursive: true, force: true })
  }
})

test('legacy 元数据升级不推进 archive revision，并清空正文占位', async () => {
  const ctx = setup()
  const snapshots = createArchiveSnapshotStore({ db: ctx.db, dataDir: ctx.dataDir })
  const fixture = snapshot(ctx.taskSpaceId)
  const insertLegacy = ctx.db.prepare(`
    INSERT INTO sync_archive_file(
      id, task_space_id, relative_path, blob_oid, sha256, content_text,
      size_bytes, mime_type, storage_key, text_excerpt, task_id, task_dir,
      source_head, updated_at
    ) VALUES (?, ?, ?, 'legacy', ?, ?, ?, ?, NULL, NULL, ?, ?, NULL, ?)
  `)
  for (const [index, task] of fixture.files.entries()) {
    insertLegacy.run(
      index === 0 ? 'legacy-file' : `legacy-file-${index}`,
      ctx.taskSpaceId,
      task.relativePath,
      task.sha256,
      task.content,
      Buffer.byteLength(task.content),
      task.relativePath.endsWith('/task.json')
        ? 'application/json; charset=utf-8'
        : 'text/markdown; charset=utf-8',
      task.taskId,
      task.taskDir,
      new Date().toISOString(),
    )
  }
  const queued = []
  const indexQueue = {
    async enqueue(taskSpaceId, options) {
      queued.push({ taskSpaceId, options })
    },
  }
  const sync = createArchiveGitSyncService({
    db: ctx.db,
    dataDir: ctx.dataDir,
    config: { allowLocalGitRemotes: false },
    taskSpaceIndex: indexQueue,
    store: {
      async readSnapshot(input) {
        const files = fixture.files.map((file) => ({
          ...input.snapshotWriter.writeBlob(file, Buffer.from(file.content)),
          blobOid: file.blobOid,
          taskDir: file.taskDir,
          taskId: file.taskId,
        }))
        return {
          head: 'b'.repeat(40),
          files,
          fileCount: files.length,
          byteCount: files.reduce((sum, file) => sum + file.sizeBytes, 0),
          skipped: false,
          metrics: { fetchMs: 1, readMs: 1, totalMs: 2 },
          taskSpaceId: ctx.taskSpaceId,
        }
      },
    },
    snapshots,
    logger: LOGGER,
  })
  try {
    await sync.runNow(ctx.taskSpaceId)
    await waitFor(() => {
      const state = ctx.db
        .prepare('SELECT status FROM sync_archive_sync_state WHERE task_space_id = ?')
        .get(ctx.taskSpaceId)
      return state?.status === 'indexing'
    })
    const migrated = ctx.db
      .prepare(`
        SELECT content_text, storage_key, blob_oid, snapshot_id
        FROM sync_archive_file
        WHERE id = 'legacy-file'
      `)
      .get()
    assert.equal(
      ctx.db
        .prepare('SELECT archive_revision FROM sync_task_space WHERE id = ?')
        .get(ctx.taskSpaceId).archive_revision,
      0,
    )
    assert.equal(
      ctx.db
        .prepare('SELECT archive_candidate_snapshot_id FROM sync_task_space WHERE id = ?')
        .get(ctx.taskSpaceId).archive_candidate_snapshot_id,
      ctx.db
        .prepare('SELECT id FROM sync_archive_snapshot WHERE task_space_id = ?')
        .get(ctx.taskSpaceId).id,
    )
    assert.equal(migrated.content_text, '')
    assert.match(migrated.storage_key, /^[-A-Za-z0-9._/]+$/)
    assert.equal(migrated.blob_oid, 'a'.repeat(40))
    assert.ok(migrated.snapshot_id)
    assert.equal(queued.length, 1)
  } finally {
    ctx.db.close()
    fs.rmSync(ctx.dataDir, { recursive: true, force: true })
  }
})

test('候选指针存在时，HEAD 跳过的下一次同步仍会排队索引', async () => {
  const ctx = setup()
  const snapshots = createArchiveSnapshotStore({ db: ctx.db, dataDir: ctx.dataDir })
  const fixture = snapshot(ctx.taskSpaceId)
  const head = 'a'.repeat(40)
  const staging = snapshots.createStaging(ctx.taskSpaceId, 'attempt-skip')
  const files = fixture.files.map((file) => ({
    ...staging.writeBlob(file, Buffer.from(file.content)),
    blobOid: file.blobOid,
    taskDir: file.taskDir,
    taskId: file.taskId,
  }))
  const published = snapshots.publish({ staging, head, files })
  const snapshotId = crypto.randomUUID()
  const timestamp = new Date().toISOString()
  const queued = []
  try {
    ctx.db
      .prepare(`
        INSERT INTO sync_archive_snapshot(
          id, task_space_id, source_head, status, active, storage_root,
          file_count, byte_count, manifest_sha256, published_at
        ) VALUES (?, ?, ?, 'published', 1, ?, ?, ?, ?, ?)
      `)
      .run(
        snapshotId,
        ctx.taskSpaceId,
        head,
        published.storageRoot,
        published.fileCount,
        published.byteCount,
        published.manifestSha256,
        timestamp,
      )
    const insertFile = ctx.db.prepare(`
      INSERT INTO sync_archive_file(
        id, task_space_id, snapshot_id, relative_path, blob_oid, sha256,
        content_text, size_bytes, mime_type, storage_key, text_excerpt,
        task_id, task_dir, source_head, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const file of published.files) {
      const source = files.find((item) => item.relativePath === file.relativePath)
      insertFile.run(
        crypto.randomUUID(),
        ctx.taskSpaceId,
        snapshotId,
        file.relativePath,
        file.blobOid,
        file.sha256,
        file.sizeBytes,
        file.mimeType,
        file.storageKey,
        source.textExcerpt || null,
        source.taskId,
        source.taskDir,
        head,
        timestamp,
      )
    }
    ctx.db
      .prepare(`
        UPDATE sync_task_space
        SET archive_snapshot_id = ?, archive_candidate_snapshot_id = ?,
            archive_revision = 0, archive_indexed_revision = 0
        WHERE id = ?
      `)
      .run(snapshotId, snapshotId, ctx.taskSpaceId)
    ctx.db
      .prepare(`
        INSERT INTO sync_archive_sync_state(
          task_space_id, ref_name, remote_head, status, last_success_at,
          file_count, byte_count, updated_at
        ) VALUES (?, 'refs/heads/trellis-archive', ?, 'current', ?, ?, ?, ?)
      `)
      .run(ctx.taskSpaceId, head, timestamp, published.fileCount, published.byteCount, timestamp)
  } finally {
    published.release()
  }
  const sync = createArchiveGitSyncService({
    db: ctx.db,
    dataDir: ctx.dataDir,
    config: { allowLocalGitRemotes: false },
    taskSpaceIndex: {
      async enqueue(taskSpaceId, options) {
        queued.push({ taskSpaceId, options })
      },
    },
    store: {
      async readSnapshot() {
        return {
          skipped: true,
          head,
          metrics: { fetchMs: 1, readMs: 0, totalMs: 1 },
        }
      },
    },
    snapshots,
    logger: LOGGER,
  })
  try {
    await sync.runNow(ctx.taskSpaceId)
    await waitFor(() => queued.length === 1)
    assert.deepEqual(queued[0], {
      taskSpaceId: ctx.taskSpaceId,
      options: { source: 'archive' },
    })
  } finally {
    ctx.db.close()
    fs.rmSync(ctx.dataDir, { recursive: true, force: true })
  }
})

test('候选快照索引失败时保留旧 fileId 和下载，成功后原子切换', async () => {
  const ctx = setup()
  const snapshots = createArchiveSnapshotStore({ db: ctx.db, dataDir: ctx.dataDir })
  let head = 'a'.repeat(40)
  let title = '旧标题'
  const fakeStore = {
    async readSnapshot(input) {
      const fixture = snapshot(ctx.taskSpaceId, title)
      const files = fixture.files.map((file) => ({
        ...input.snapshotWriter.writeBlob(file, Buffer.from(file.content)),
        blobOid: file.blobOid,
        taskDir: file.taskDir,
        taskId: file.taskId,
      }))
      return {
        head,
        files,
        fileCount: files.length,
        byteCount: files.reduce((sum, file) => sum + file.sizeBytes, 0),
        skipped: false,
        metrics: { fetchMs: 1, readMs: 1, totalMs: 2 },
        taskSpaceId: ctx.taskSpaceId,
      }
    },
  }
  const queued = []
  const indexQueue = {
    async enqueue(taskSpaceId, options) {
      queued.push({ taskSpaceId, options })
    },
  }
  const index = createTaskSpaceIndex({
    db: ctx.db,
    stageIds: STAGE_IDS,
    taskSpaces: ctx.taskSpaces,
    archiveSnapshots: snapshots,
    logger: LOGGER,
  })
  const boardService = createGitlessBoardService({
    db: ctx.db,
    taskSpaces: ctx.taskSpaces,
    taskSpaceIndex: index,
    archiveSnapshots: snapshots,
  })
  const sync = createArchiveGitSyncService({
    db: ctx.db,
    dataDir: ctx.dataDir,
    config: { allowLocalGitRemotes: false },
    taskSpaceIndex: indexQueue,
    store: fakeStore,
    snapshots,
    logger: LOGGER,
  })
  const actor = ctx.taskSpaces.actorContext('user-1')
  try {
    await sync.runNow(ctx.taskSpaceId)
    await waitFor(() => queued.length === 1)
    await index.materializeNow(ctx.taskSpaceId, { source: 'archive' })
    sync.onIndexProjected({
      taskSpaceId: ctx.taskSpaceId,
      source: 'archive',
      archiveAdvanced: true,
    })
    const originalTask = index.queryTasks(actor, {
      taskSpaceId: ctx.taskSpaceId,
      archived: true,
    }).tasks[0]
    const originalDetail = await boardService.getTask(actor, {
      taskSpaceId: ctx.taskSpaceId,
      executionTaskKey: originalTask.executionTaskKey,
    })
    const originalFile = originalDetail.task.files.find((file) => file.name === 'task.json')
    const originalDownload = await boardService.getArchiveFile(
      actor,
      ctx.taskSpaceId,
      originalFile.id,
    )
    assert.match(originalDownload.buffer.toString('utf8'), /旧标题/)
    const originalSnapshot = ctx.db
      .prepare('SELECT id, status FROM sync_archive_snapshot WHERE source_head = ?')
      .get(head)
    const originalDirectory = path.join(
      ctx.dataDir,
      'archive-snapshots',
      ctx.taskSpaceId,
      'heads',
      head,
    )
    const originalBoard = index.readTaskSpaceCache(ctx.taskSpaceId).board

    head = 'b'.repeat(40)
    title = '新标题'
    await sync.runNow(ctx.taskSpaceId)
    await waitFor(() => queued.length === 2)
    sync.onIndexProjectionFailed({
      taskSpaceId: ctx.taskSpaceId,
      error: new Error('模拟索引失败'),
      attemptId: 'retry-index',
      sources: ['archive'],
    })

    assert.deepEqual(index.readTaskSpaceCache(ctx.taskSpaceId).board, originalBoard)
    assert.equal(
      ctx.db
        .prepare('SELECT status FROM sync_archive_snapshot WHERE id = ?')
        .get(originalSnapshot.id).status,
      'published',
    )
    assert.equal(fs.existsSync(originalDirectory), true)
    assert.equal(
      ctx.db
        .prepare('SELECT snapshot_id FROM sync_archive_file_history WHERE id = ?')
        .get(originalFile.id)?.snapshot_id,
      originalSnapshot.id,
    )
    assert.ok(
      ctx.db
        .prepare(
          "SELECT 1 FROM sync_archive_snapshot WHERE source_head = ? AND status = 'published'",
        )
        .get(head),
    )
    assert.equal(
      fs.existsSync(path.join(ctx.dataDir, 'archive-snapshots', ctx.taskSpaceId, 'heads', head)),
      true,
    )
    const staleDetail = index
      .readTaskSpaceCache(ctx.taskSpaceId)
      .projection.detailTasks.find(
        (task) => task.executionTaskKey === originalTask.executionTaskKey,
      )
    assert.equal(staleDetail.files.find((file) => file.name === 'task.json').id, originalFile.id)
    const preservedDownload = await boardService.getArchiveFile(
      actor,
      ctx.taskSpaceId,
      originalFile.id,
    )
    assert.match(preservedDownload.buffer.toString('utf8'), /旧标题/)

    const previousCandidateDirectory = path.join(
      ctx.dataDir,
      'archive-snapshots',
      ctx.taskSpaceId,
      'heads',
      head,
    )
    head = 'c'.repeat(40)
    title = '第二次候选标题'
    await sync.runNow(ctx.taskSpaceId)
    await waitFor(() => queued.length === 3)
    sync.onIndexProjectionFailed({
      taskSpaceId: ctx.taskSpaceId,
      error: new Error('模拟连续索引失败'),
      attemptId: 'retry-index-again',
      sources: ['archive'],
    })
    assert.equal(fs.existsSync(previousCandidateDirectory), false)
    assert.equal(
      fs.existsSync(path.join(ctx.dataDir, 'archive-snapshots', ctx.taskSpaceId, 'heads', head)),
      true,
    )
    assert.equal(
      ctx.db.prepare('SELECT COUNT(*) AS count FROM sync_archive_snapshot').get().count,
      2,
    )
    const stillPreserved = await boardService.getArchiveFile(
      actor,
      ctx.taskSpaceId,
      originalFile.id,
    )
    assert.match(stillPreserved.buffer.toString('utf8'), /旧标题/)

    const candidateSnapshotId = ctx.db
      .prepare('SELECT id FROM sync_archive_snapshot WHERE source_head = ?')
      .get(head).id
    const indexedRevisionBeforeFailure = ctx.db
      .prepare('SELECT archive_indexed_revision FROM sync_task_space WHERE id = ?')
      .get(ctx.taskSpaceId).archive_indexed_revision
    ctx.db.exec(`
      CREATE TRIGGER fail_archive_activation
      BEFORE UPDATE OF indexed_revision ON sync_task_space
      BEGIN
        SELECT RAISE(ABORT, 'forced archive activation failure');
      END;
    `)
    await assert.rejects(
      () => index.materializeNow(ctx.taskSpaceId, { source: 'archive' }),
      /forced archive activation failure/,
    )
    ctx.db.exec('DROP TRIGGER fail_archive_activation')
    const failedPointers = ctx.db
      .prepare(`
        SELECT archive_snapshot_id, archive_candidate_snapshot_id, archive_indexed_revision
        FROM sync_task_space
        WHERE id = ?
      `)
      .get(ctx.taskSpaceId)
    assert.equal(failedPointers.archive_snapshot_id, originalSnapshot.id)
    assert.equal(failedPointers.archive_candidate_snapshot_id, candidateSnapshotId)
    assert.equal(failedPointers.archive_indexed_revision, indexedRevisionBeforeFailure)
    assert.equal(
      ctx.db
        .prepare('SELECT active FROM sync_archive_snapshot WHERE id = ?')
        .get(originalSnapshot.id).active,
      1,
    )
    assert.equal(
      ctx.db
        .prepare('SELECT active FROM sync_archive_snapshot WHERE id = ?')
        .get(candidateSnapshotId).active,
      0,
    )
    assert.deepEqual(index.readTaskSpaceCache(ctx.taskSpaceId).board, originalBoard)

    await index.materializeNow(ctx.taskSpaceId, { source: 'archive' })
    sync.onIndexProjected({
      taskSpaceId: ctx.taskSpaceId,
      source: 'archive',
      archiveAdvanced: true,
    })
    const nextTask = index.queryTasks(actor, {
      taskSpaceId: ctx.taskSpaceId,
      archived: true,
    }).tasks[0]
    const nextDetail = await boardService.getTask(actor, {
      taskSpaceId: ctx.taskSpaceId,
      executionTaskKey: nextTask.executionTaskKey,
    })
    const nextFile = nextDetail.task.files.find((file) => file.name === 'task.json')
    assert.notEqual(nextFile.id, originalFile.id)
    const nextDownload = await boardService.getArchiveFile(actor, ctx.taskSpaceId, nextFile.id)
    assert.match(nextDownload.buffer.toString('utf8'), /第二次候选标题/)
    assert.equal(fs.existsSync(originalDirectory), false)
    assert.equal(
      ctx.db.prepare('SELECT COUNT(*) AS count FROM sync_archive_snapshot').get().count,
      1,
    )
  } finally {
    await index.close()
    ctx.db.close()
    fs.rmSync(ctx.dataDir, { recursive: true, force: true })
  }
})
