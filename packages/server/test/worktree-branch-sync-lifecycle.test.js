import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { snapshotSha256 } from '@trellis-board/shared/task-snapshot.js'
import { openDatabase } from '../database.js'
import { STAGE_IDS } from '../metadata.js'
import { createArchiveGitSyncService } from '../team/archive-git-sync.js'
import { createArchiveSnapshotStore } from '../team/archive-local-snapshot.js'
import { createTaskControlService } from '../team/task-control-service.js'
import { createTaskSnapshotService } from '../team/task-snapshot-service.js'
import { createTaskSpaceIndex } from '../team/task-space-index.js'
import { createTaskSpaceService } from '../team/task-space-service.js'
import { createTeamRuntime } from '../team/http.js'
import { createUser } from '../team/auth.js'

const LOGGER = { info() {}, warn() {} }

function setup({ onTaskSpaceWorktreeMarked = null } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-wt-lifecycle-'))
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
  for (const [id, name] of [
    ['user-a', '用户 A'],
    ['user-b', '用户 B'],
  ]) {
    db.prepare(
      `INSERT INTO user_account(
        id, username_key, username, display_name, password_hash, password_params_json,
        system_admin, status, must_change_password, password_changed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'x', '{}', 0, 'active', 0, ?, ?, ?)`,
    ).run(id, id, id, name, now, now, now)
    db.prepare(
      `INSERT INTO team_member(team_id, user_id, role, created_at, updated_at)
       VALUES ('team-1', ?, 'member', ?, ?)`,
    ).run(id, now, now)
  }
  for (const [agentId, userId] of [
    ['agent-a', 'user-a'],
    ['agent-b', 'user-b'],
  ]) {
    db.prepare(
      `INSERT INTO agent_device(
        id, user_id, device_name, platform, agent_version, protocol_version,
        credential_hash, status, last_seen_at, created_at
      ) VALUES (?, ?, ?, 'win32', '0.1.0', 3, ?, 'active', ?, ?)`,
    ).run(agentId, userId, agentId, `${agentId}-cred`, now, now)
    db.prepare(
      `INSERT INTO sync_active_agent(user_id, agent_id, updated_at)
       VALUES (?, ?, ?)`,
    ).run(userId, agentId, now)
  }

  let archiveGitSync = null
  let taskSpaceIndex = null
  const taskSpaces = createTaskSpaceService({
    db,
    onTaskSpaceWorktreeMarked: (taskSpaceId) => {
      onTaskSpaceWorktreeMarked?.(taskSpaceId)
      archiveGitSync?.clearBackoff(taskSpaceId)
      void taskSpaceIndex?.enqueue(taskSpaceId)
    },
  })
  const taskControl = createTaskControlService({ db, logger: LOGGER })
  const archiveSnapshots = createArchiveSnapshotStore({ db, dataDir, logger: LOGGER })
  taskSpaceIndex = createTaskSpaceIndex({
    db,
    stageIds: STAGE_IDS,
    taskSpaces,
    archiveSnapshots,
    taskControl,
    logger: LOGGER,
  })
  const snapshots = createTaskSnapshotService({
    db,
    taskSpaces,
    taskControl,
    onRevisionCommitted: ({ taskSpaceId }) => void taskSpaceIndex.enqueue(taskSpaceId),
  })

  return {
    dataDir,
    db,
    taskSpaces,
    taskControl,
    taskSpaceIndex,
    snapshots,
    archiveSnapshots,
    setArchiveGitSync(service) {
      archiveGitSync = service
    },
    async cleanup() {
      await taskSpaceIndex.close()
      db.close()
      fs.rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

test('AC1 & AC2: attach 区分 worktree 与普通分支，基线分支始终为非 worktree，支持普通仓库升级与存量补标', async () => {
  const markedSpaces = []
  const ctx = setup({ onTaskSpaceWorktreeMarked: (id) => markedSpaces.push(id) })
  try {
    const baseline = ctx.taskSpaces.attach('user-a', 'agent-a', {
      remoteUrl: 'https://example.com/acme/repo.git',
      branchName: 'main',
      displayName: 'Acme',
      teamId: 'team-1',
      developerId: 'alice',
      localRepoKey: '1'.repeat(64),
      isWorktree: true,
    })
    assert.equal(baseline.taskSpace.isBaseline, true)
    assert.equal(baseline.taskSpace.isWorktree, false)

    const wt = ctx.taskSpaces.attach('user-a', 'agent-a', {
      remoteUrl: 'https://example.com/acme/repo.git',
      branchName: 'feat/wt-new',
      displayName: 'Acme',
      teamId: 'team-1',
      developerId: 'alice',
      localRepoKey: '2'.repeat(64),
      isWorktree: true,
    })
    assert.equal(wt.taskSpace.isWorktree, true)

    // 普通仓库接入同一分支时升级回非 worktree
    const upgraded = ctx.taskSpaces.attach('user-a', 'agent-a', {
      remoteUrl: 'https://example.com/acme/repo.git',
      branchName: 'feat/wt-new',
      displayName: 'Acme',
      teamId: 'team-1',
      developerId: 'alice',
      localRepoKey: '3'.repeat(64),
      isWorktree: false,
    })
    assert.equal(upgraded.taskSpace.id, wt.taskSpace.id)
    assert.equal(upgraded.taskSpace.isWorktree, false)

    // 存量未打标且归档报错（last_success_at IS NULL）的分支补标为 worktree，清除错误并触发回调
    const now = new Date().toISOString()
    ctx.db
      .prepare(
        `INSERT INTO sync_archive_sync_state(
          task_space_id, status, last_attempt_at, last_success_at, last_error, updated_at
        ) VALUES (?, 'error', ?, NULL, 'ARCHIVE_BRANCH_MISSING', ?)`,
      )
      .run(wt.taskSpace.id, now, now)

    const backfilled = ctx.taskSpaces.attach('user-a', 'agent-a', {
      remoteUrl: 'https://example.com/acme/repo.git',
      branchName: 'feat/wt-new',
      displayName: 'Acme',
      teamId: 'team-1',
      developerId: 'alice',
      localRepoKey: '2'.repeat(64),
      isWorktree: true,
    })
    assert.equal(backfilled.taskSpace.isWorktree, true)
    assert.deepEqual(markedSpaces, [wt.taskSpace.id])
    await ctx.taskSpaceIndex.enqueue(wt.taskSpace.id)
    const state = ctx.db
      .prepare('SELECT status, last_error FROM sync_archive_sync_state WHERE task_space_id = ?')
      .get(wt.taskSpace.id)
    assert.equal(state.status, 'idle')
    assert.equal(state.last_error, null)
  } finally {
    await ctx.cleanup()
  }
})

test('AC3: archive-git-sync 跳过 worktree 定时与全量同步，单空间同步返回 409，overview 返回 worktree_skipped', async () => {
  const ctx = setup()
  try {
    const mainSpace = ctx.taskSpaces.attach('user-a', 'agent-a', {
      remoteUrl: 'https://example.com/acme/repo.git',
      branchName: 'main',
      displayName: 'Acme',
      teamId: 'team-1',
      developerId: 'alice',
      localRepoKey: '1'.repeat(64),
    })
    const wtSpace = ctx.taskSpaces.attach('user-a', 'agent-a', {
      remoteUrl: 'https://example.com/acme/repo.git',
      branchName: 'feat/local-wt',
      displayName: 'Acme',
      teamId: 'team-1',
      developerId: 'alice',
      localRepoKey: '2'.repeat(64),
      isWorktree: true,
    })

    const readCalls = []
    const archiveGitSync = createArchiveGitSyncService({
      db: ctx.db,
      dataDir: ctx.dataDir,
      taskSpaceIndex: ctx.taskSpaceIndex,
      logger: LOGGER,
      snapshots: ctx.archiveSnapshots,
      store: {
        async readSnapshot({ taskSpaceId }) {
          readCalls.push(taskSpaceId)
          return { skipped: true, head: 'a'.repeat(40), files: [], fileCount: 0, byteCount: 0 }
        },
      },
    })
    ctx.setArchiveGitSync(archiveGitSync)

    const runAll = await archiveGitSync.runNow(null)
    assert.equal(runAll.queued, 1)
    await archiveGitSync.stop()
    assert.deepEqual(readCalls, [mainSpace.taskSpace.id])

    await assert.rejects(
      () => archiveGitSync.runNow(wtSpace.taskSpace.id),
      (error) => error.status === 409 && error.code === 'WORKTREE_ARCHIVE_SYNC_SKIPPED',
    )

    const overview = archiveGitSync.overview()
    const wtRow = overview.taskSpaces.find((item) => item.taskSpaceId === wtSpace.taskSpace.id)
    assert.ok(wtRow)
    assert.equal(wtRow.isWorktree, true)
    assert.equal(wtRow.status, 'worktree_skipped')
    assert.equal(wtRow.lastError, null)
    assert.equal(wtRow.nextAttemptAt, null)
  } finally {
    await ctx.cleanup()
  }
})

test('AC4 & AC5: worktree 删除活跃任务后 sync_task 自动归档收敛，pending 任务受保护，普通分支不受影响', async () => {
  const ctx = setup()
  try {
    const mainSpace = ctx.taskSpaces.attach('user-a', 'agent-a', {
      remoteUrl: 'https://example.com/acme/repo.git',
      branchName: 'main',
      displayName: 'Acme',
      teamId: 'team-1',
      developerId: 'alice',
      localRepoKey: '1'.repeat(64),
    })
    const wtSpace = ctx.taskSpaces.attach('user-a', 'agent-a', {
      remoteUrl: 'https://example.com/acme/repo.git',
      branchName: 'feat/wt-task',
      displayName: 'Acme',
      teamId: 'team-1',
      developerId: 'alice',
      localRepoKey: '2'.repeat(64),
      isWorktree: true,
    })

    const agent = { id: 'agent-a', userId: 'user-a' }
    const taskDir = '.trellis/tasks/11-27-demo'
    const taskJson = JSON.stringify({
      id: 'demo',
      title: '演示任务',
      status: 'in_progress',
      assignee: 'alice',
      branch: 'feat/wt-task',
    })
    const taskJsonSha = snapshotSha256(taskJson)

    // 1. worktree 上传活跃任务并索引
    const upload = ctx.snapshots.applyChanges(agent, wtSpace.taskSpace.id, {
      batchId: 'wt-upload-1',
      clientSequence: 1,
      observedBranchName: 'feat/wt-task',
      baseRevision: 0,
      files: [
        {
          path: `${taskDir}/task.json`,
          content: taskJson,
          sha256: taskJsonSha,
          deleted: false,
        },
      ],
    })
    assert.equal(upload.status, 200)
    await ctx.taskSpaceIndex.enqueue(wtSpace.taskSpace.id)
    assert.equal(ctx.snapshots.listTaskSummaries(agent, wtSpace.taskSpace.id).length, 1)

    // 同时在 worktree 上插入一条 pending 任务，验证不被误收敛
    const now = new Date().toISOString()
    ctx.db
      .prepare(
        `INSERT INTO sync_task(
          execution_task_key, task_key, task_space_id, project_id, task_id,
          relative_dir, title, description, priority, created_by_user_id,
          assignee_user_id, assignee_dev_id, stage, archived,
          materialization_state, task_version, handoff_state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'pending-one', '.trellis/tasks/11-27-pending-one',
          '待物化任务', '', 'P2', 'user-a', 'user-a', 'alice', 'planning', 0,
          'pending', 1, 'none', ?, ?)`,
      )
      .run(
        `${wtSpace.taskSpace.id}::pending-one`,
        `${wtSpace.taskSpace.id}::.trellis/tasks/11-27-pending-one`,
        wtSpace.taskSpace.id,
        wtSpace.project.id,
        now,
        now,
      )

    // 2. worktree 本地归档后上报删除活跃目录
    const wtClaim = ctx.taskControl.claim(
      agent,
      wtSpace.taskSpace.id,
      `${wtSpace.taskSpace.id}::demo`,
    )
    const del = ctx.snapshots.applyChanges(agent, wtSpace.taskSpace.id, {
      batchId: 'wt-delete-1',
      clientSequence: 2,
      observedBranchName: 'feat/wt-task',
      baseRevision: upload.revision,
      taskVersion: wtClaim.task.taskVersion,
      leaseToken: wtClaim.lease?.token || wtClaim.lease?.leaseToken || wtClaim.leaseToken,
      files: [
        {
          path: `${taskDir}/task.json`,
          baseSha256: taskJsonSha,
          deleted: true,
        },
      ],
    })
    assert.equal(del.status, 200)
    await ctx.taskSpaceIndex.enqueue(wtSpace.taskSpace.id)

    const demoRow = ctx.db
      .prepare('SELECT archived FROM sync_task WHERE execution_task_key = ?')
      .get(`${wtSpace.taskSpace.id}::demo`)
    assert.equal(demoRow.archived, 1)

    const pendingRow = ctx.db
      .prepare('SELECT archived, materialization_state FROM sync_task WHERE execution_task_key = ?')
      .get(`${wtSpace.taskSpace.id}::pending-one`)
    assert.equal(pendingRow.archived, 0)
    assert.equal(pendingRow.materialization_state, 'pending')

    // 3. 普通分支上传后删除活跃目录，sync_task 保持 archived = 0（等待远端归档同步）
    const mainTaskJson = JSON.stringify({
      id: 'main-task',
      title: '主分支任务',
      status: 'in_progress',
      assignee: 'alice',
      branch: 'main',
    })
    const mainSha = snapshotSha256(mainTaskJson)
    const mainUpload = ctx.snapshots.applyChanges(agent, mainSpace.taskSpace.id, {
      batchId: 'main-upload-1',
      clientSequence: 1,
      observedBranchName: 'main',
      baseRevision: 0,
      files: [
        {
          path: '.trellis/tasks/11-27-main-task/task.json',
          content: mainTaskJson,
          sha256: mainSha,
          deleted: false,
        },
      ],
    })
    await ctx.taskSpaceIndex.enqueue(mainSpace.taskSpace.id)
    const mainClaim = ctx.taskControl.claim(
      agent,
      mainSpace.taskSpace.id,
      `${mainSpace.taskSpace.id}::main-task`,
    )
    ctx.snapshots.applyChanges(agent, mainSpace.taskSpace.id, {
      batchId: 'main-delete-1',
      clientSequence: 2,
      observedBranchName: 'main',
      baseRevision: mainUpload.revision,
      taskVersion: mainClaim.task.taskVersion,
      leaseToken: mainClaim.lease?.token || mainClaim.lease?.leaseToken || mainClaim.leaseToken,
      files: [
        {
          path: '.trellis/tasks/11-27-main-task/task.json',
          baseSha256: mainSha,
          deleted: true,
        },
      ],
    })
    await ctx.taskSpaceIndex.enqueue(mainSpace.taskSpace.id)
    const mainRow = ctx.db
      .prepare('SELECT archived FROM sync_task WHERE execution_task_key = ?')
      .get(`${mainSpace.taskSpace.id}::main-task`)
    assert.equal(mainRow.archived, 0)
  } finally {
    await ctx.cleanup()
  }
})

test('AC9: worktree 最后一个绑定 detach 后自动弃用，同名重建自动恢复，普通分支解绑不自动弃用', async () => {
  const ctx = setup()
  try {
    const mainSpace = ctx.taskSpaces.attach('user-a', 'agent-a', {
      remoteUrl: 'https://example.com/acme/repo.git',
      branchName: 'main',
      displayName: 'Acme',
      teamId: 'team-1',
      developerId: 'alice',
      localRepoKey: '1'.repeat(64),
    })
    const normalBranch = ctx.taskSpaces.attach('user-a', 'agent-a', {
      remoteUrl: 'https://example.com/acme/repo.git',
      branchName: 'release/v1',
      displayName: 'Acme',
      teamId: 'team-1',
      developerId: 'alice',
      localRepoKey: '2'.repeat(64),
      isWorktree: false,
    })
    const wtBranch = ctx.taskSpaces.attach('user-a', 'agent-a', {
      remoteUrl: 'https://example.com/acme/repo.git',
      branchName: 'feat/disposable-wt',
      displayName: 'Acme',
      teamId: 'team-1',
      developerId: 'alice',
      localRepoKey: '3'.repeat(64),
      isWorktree: true,
    })

    // 普通分支解绑 -> 不自动弃用
    const normalDetach = ctx.taskSpaces.detachAgent(
      { id: 'agent-a', userId: 'user-a' },
      normalBranch.taskSpace.id,
      { localRepoKey: '2'.repeat(64) },
    )
    assert.equal(Boolean(normalDetach.taskSpaceRetired), false)
    const normalRow = ctx.db
      .prepare('SELECT status, retired_at FROM sync_task_space WHERE id = ?')
      .get(normalBranch.taskSpace.id)
    assert.equal(normalRow.status, 'active')
    assert.equal(normalRow.retired_at, null)

    // worktree 最后一个绑定解绑 -> 自动弃用
    const wtDetach = ctx.taskSpaces.detachAgent(
      { id: 'agent-a', userId: 'user-a' },
      wtBranch.taskSpace.id,
      { localRepoKey: '3'.repeat(64) },
    )
    assert.equal(wtDetach.taskSpaceRetired, true)
    const retiredRow = ctx.db
      .prepare('SELECT status, retired_at, retired_reason FROM sync_task_space WHERE id = ?')
      .get(wtBranch.taskSpace.id)
    assert.equal(retiredRow.status, 'disabled')
    assert.ok(retiredRow.retired_at)
    assert.equal(retiredRow.retired_reason, 'worktree_deleted')

    // 活跃侧边栏列表中不再包含已自动弃用的 worktree
    const readable = ctx.taskSpaces.listReadable(ctx.taskSpaces.actorContext('user-a'))
    const project = readable.find((item) => item.id === mainSpace.project.id)
    assert.ok(!project.taskSpaces.some((space) => space.id === wtBranch.taskSpace.id))

    // 同名分支重新 attach -> 自动恢复为 active，不报 409
    const restored = ctx.taskSpaces.attach('user-a', 'agent-a', {
      remoteUrl: 'https://example.com/acme/repo.git',
      branchName: 'feat/disposable-wt',
      displayName: 'Acme',
      teamId: 'team-1',
      developerId: 'alice',
      localRepoKey: '4'.repeat(64),
      isWorktree: true,
    })
    assert.equal(restored.taskSpace.id, wtBranch.taskSpace.id)
    assert.equal(restored.taskSpace.status, 'active')
    assert.equal(restored.taskSpace.retiredAt, null)
    assert.equal(restored.taskSpace.isWorktree, true)
  } finally {
    await ctx.cleanup()
  }
})

test('API E2E: 真实 HTTP 后端完整闭环（attach worktree -> archive-sync -> 任务删除收敛 -> detach 自动弃用 -> 同名重建恢复）', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-wt-e2e-'))
  const logs = []
  const logger = {
    info(msg, meta) {
      logs.push({ level: 'info', msg, meta })
    },
    warn(msg, meta) {
      logs.push({ level: 'warn', msg, meta })
    },
    error(msg, meta) {
      logs.push({ level: 'error', msg, meta })
    },
  }
  const runtime = await createTeamRuntime({
    config: { mode: 'team', port: 0, bindHost: '127.0.0.1', allowLocalGitRemotes: false },
    databaseFile: path.join(tmpDir, 'board.sqlite'),
    dataDir: tmpDir,
    requireAdmin: false,
    logger,
    archiveGitRunProcessImpl: async () => ({ exitCode: 128, stdout: '', stderr: 'stubbed' }),
  })
  await runtime.start()
  await runtime.services.archiveGitSync.stop()
  try {
    const { port } = runtime.address()
    const base = `http://127.0.0.1:${port}`
    const admin = await createUser(runtime.db, {
      username: 'e2e_admin',
      displayName: 'E2E Admin',
      password: 'Password123!',
      systemAdmin: true,
      mustChangePassword: false,
    })
    const now = new Date().toISOString()
    runtime.db
      .prepare(
        `INSERT INTO team(id, name, slug, status, created_at, updated_at)
         VALUES ('team-e2e', 'E2E', 'team-e2e', 'active', ?, ?)`,
      )
      .run(now, now)
    runtime.db
      .prepare(
        `INSERT INTO team_member(team_id, user_id, role, created_at, updated_at)
         VALUES ('team-e2e', ?, 'admin', ?, ?)`,
      )
      .run(admin.id, now, now)

    const loginRes = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, connection: 'close' },
      body: JSON.stringify({ username: 'e2e_admin', password: 'Password123!' }),
    })
    assert.equal(loginRes.status, 200)
    const cookie = loginRes.headers.get('set-cookie').split(';')[0]

    const pairData = runtime.services.agentService.createPairingCode(
      runtime.services.taskSpaces.actorContext(admin.id),
      { teamId: 'team-e2e' },
    )
    const enrollRes = await fetch(`${base}/api/agent/enroll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify({
        pairingCode: pairData.pairingCode,
        deviceName: 'e2e-pc',
        platform: 'win32',
        agentVersion: '0.5.18',
        protocolVersion: 3,
      }),
    })
    assert.equal(enrollRes.status, 201)
    const enrollData = await enrollRes.json()
    const agentHeaders = {
      'content-type': 'application/json',
      authorization: `Bearer ${enrollData.credential}`,
      connection: 'close',
    }

    const attachMain = await fetch(`${base}/api/agent/task-spaces/attach`, {
      method: 'POST',
      headers: agentHeaders,
      body: JSON.stringify({
        remoteUrl: 'https://example.com/e2e/repo.git',
        branchName: 'main',
        teamId: 'team-e2e',
        developerId: 'e2e',
        displayName: 'E2E Repo',
        localRepoKey: 'a'.repeat(64),
        isWorktree: false,
      }),
    })
    assert.equal(attachMain.status, 201)

    const attachWt = await fetch(`${base}/api/agent/task-spaces/attach`, {
      method: 'POST',
      headers: agentHeaders,
      body: JSON.stringify({
        remoteUrl: 'https://example.com/e2e/repo.git',
        branchName: 'feat/wt-e2e',
        teamId: 'team-e2e',
        developerId: 'e2e',
        displayName: 'E2E Repo',
        localRepoKey: 'b'.repeat(64),
        isWorktree: true,
      }),
    })
    assert.equal(attachWt.status, 201)
    const wtData = await attachWt.json()
    assert.equal(wtData.taskSpace.isWorktree, true)

    const overviewRes = await fetch(`${base}/api/admin/archive-sync`, {
      headers: { cookie, connection: 'close' },
    })
    assert.equal(overviewRes.status, 200)
    const overviewData = await overviewRes.json()
    const wtOverview = overviewData.taskSpaces.find((s) => s.taskSpaceId === wtData.taskSpace.id)
    assert.equal(wtOverview.isWorktree, true)
    assert.equal(wtOverview.status, 'worktree_skipped')
    assert.equal(wtOverview.lastError, null)

    const runWtRes = await fetch(`${base}/api/admin/archive-sync/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, cookie, connection: 'close' },
      body: JSON.stringify({ taskSpaceId: wtData.taskSpace.id }),
    })
    assert.equal(runWtRes.status, 409)
    const runWtBody = await runWtRes.json()
    assert.equal(runWtBody.error?.code || runWtBody.code, 'WORKTREE_ARCHIVE_SYNC_SKIPPED')

    const taskJson = JSON.stringify({
      id: 'wt-demo',
      title: 'WT Demo',
      status: 'in_progress',
      assignee: 'e2e',
      branch: 'feat/wt-e2e',
    })
    const sha = snapshotSha256(taskJson)
    const upRes = await fetch(`${base}/api/agent/task-spaces/${wtData.taskSpace.id}/changes`, {
      method: 'POST',
      headers: agentHeaders,
      body: JSON.stringify({
        batchId: 'e2e-b1',
        clientSequence: 1,
        observedBranchName: 'feat/wt-e2e',
        baseRevision: 0,
        files: [
          {
            path: '.trellis/tasks/11-27-wt-demo/task.json',
            content: taskJson,
            sha256: sha,
            deleted: false,
          },
        ],
      }),
    })
    assert.equal(upRes.status, 200)
    const upData = await upRes.json()
    await runtime.services.taskSpaceIndex.enqueue(wtData.taskSpace.id)
    const tasksBefore = await (
      await fetch(`${base}/api/agent/task-spaces/${wtData.taskSpace.id}/tasks`, {
        headers: agentHeaders,
      })
    ).json()
    assert.equal(tasksBefore.tasks.length, 1)

    const claimRes = await fetch(
      `${base}/api/agent/tasks/${encodeURIComponent(`${wtData.taskSpace.id}::wt-demo`)}/claim`,
      {
        method: 'POST',
        headers: agentHeaders,
        body: '{}',
      },
    )
    assert.equal(claimRes.status, 200)
    const claimData = await claimRes.json()
    const delRes = await fetch(`${base}/api/agent/task-spaces/${wtData.taskSpace.id}/changes`, {
      method: 'POST',
      headers: agentHeaders,
      body: JSON.stringify({
        batchId: 'e2e-b2',
        clientSequence: 2,
        observedBranchName: 'feat/wt-e2e',
        baseRevision: upData.revision,
        taskVersion: claimData.task.taskVersion,
        leaseToken: claimData.lease.token,
        files: [
          {
            path: '.trellis/tasks/11-27-wt-demo/task.json',
            baseSha256: sha,
            deleted: true,
          },
        ],
      }),
    })
    assert.equal(delRes.status, 200)
    await runtime.services.taskSpaceIndex.enqueue(wtData.taskSpace.id)
    const tasksAfter = await (
      await fetch(`${base}/api/agent/task-spaces/${wtData.taskSpace.id}/tasks`, {
        headers: agentHeaders,
      })
    ).json()
    assert.equal(tasksAfter.tasks.length, 0)

    const detachRes = await fetch(`${base}/api/agent/task-spaces/${wtData.taskSpace.id}/detach`, {
      method: 'POST',
      headers: agentHeaders,
      body: JSON.stringify({ localRepoKey: 'b'.repeat(64) }),
    })
    assert.equal(detachRes.status, 200)
    const detachData = await detachRes.json()
    assert.equal(detachData.taskSpaceRetired, true)
    const dbRetired = runtime.db
      .prepare('SELECT status, retired_reason, is_worktree FROM sync_task_space WHERE id = ?')
      .get(wtData.taskSpace.id)
    assert.equal(dbRetired.status, 'disabled')
    assert.equal(dbRetired.retired_reason, 'worktree_deleted')

    const reattachRes = await fetch(`${base}/api/agent/task-spaces/attach`, {
      method: 'POST',
      headers: agentHeaders,
      body: JSON.stringify({
        remoteUrl: 'https://example.com/e2e/repo.git',
        branchName: 'feat/wt-e2e',
        teamId: 'team-e2e',
        developerId: 'e2e',
        displayName: 'E2E Repo',
        localRepoKey: 'c'.repeat(64),
        isWorktree: true,
      }),
    })
    assert.equal(reattachRes.status, 201)
    const reattachData = await reattachRes.json()
    assert.equal(reattachData.taskSpace.status, 'active')
    assert.equal(reattachData.taskSpace.retiredAt, null)
    assert.equal(logs.filter((entry) => entry.level === 'error').length, 0)
  } finally {
    await runtime.stop()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})
