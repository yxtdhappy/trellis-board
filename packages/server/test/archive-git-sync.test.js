import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { snapshotSha256 } from '@trellis-board/shared/task-snapshot.js'
import { openDatabase } from '../database.js'
import { createArchiveGitSyncService } from '../team/archive-git-sync.js'
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
    taskSpaceId: attached.taskSpace.id,
  }
}

function snapshot(taskSpaceId) {
  const taskDir = '.trellis/tasks/archive/2026-11/11-16-old'
  const taskJson = JSON.stringify({
    id: 'old',
    title: '归档任务',
    branch: 'main',
  })
  const prd = '# 归档任务\n'
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
  return {
    head: 'c'.repeat(40),
    files,
    fileCount: files.length,
    byteCount: files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0),
    skipped: false,
    metrics: { fetchMs: 1, readMs: 1, totalMs: 2 },
    taskSpaceId,
  }
}

test('归档同步区分 fetch/import/index 失败并保留旧快照和索引时间', async () => {
  const ctx = setup()
  const calls = []
  const fakeStore = {
    async readSnapshot(input) {
      calls.push(input)
      return snapshot(ctx.taskSpaceId)
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
    assert.equal(
      ctx.db.prepare('SELECT COUNT(*) AS count FROM sync_archive_file').get().count,
      2,
    )
    assert.equal(
      ctx.db.prepare('SELECT archive_revision FROM sync_task_space WHERE id = ?').get(ctx
        .taskSpaceId).archive_revision,
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
    assert.equal(
      ctx.db.prepare('SELECT COUNT(*) AS count FROM sync_archive_file').get().count,
      2,
    )
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
      .prepare('SELECT status, last_indexed_at FROM sync_archive_sync_state WHERE task_space_id = ?')
      .get(ctx.taskSpaceId)
    assert.equal(state.status, 'index_error')
    assert.equal(state.last_indexed_at, beforeFailure)
    assert.equal(
      ctx.db.prepare('SELECT COUNT(*) AS count FROM sync_archive_sync_log').get().count,
      100,
    )
    assert.equal(
      ctx.db
        .prepare('SELECT phase FROM sync_archive_sync_log ORDER BY id DESC LIMIT 1')
        .get().phase,
      'index',
    )
  } finally {
    ctx.db.close()
    fs.rmSync(ctx.dataDir, { recursive: true, force: true })
  }
})
