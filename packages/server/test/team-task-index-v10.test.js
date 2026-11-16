import assert from 'node:assert/strict'
import test from 'node:test'
import { openDatabase } from '../database.js'
import { STAGE_IDS } from '../metadata.js'
import { createTaskSnapshotService } from '../team/task-snapshot-service.js'
import { createTaskSpaceIndex } from '../team/task-space-index.js'
import { createTaskSpaceService } from '../team/task-space-service.js'

function setup() {
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
    `INSERT INTO sync_active_agent(user_id, agent_id, updated_at) VALUES ('user-1', 'agent-1', ?)`,
  ).run(now)
  const taskSpaces = createTaskSpaceService({ db })
  const agent = { id: 'agent-1', userId: 'user-1' }
  const attached = taskSpaces.attach('user-1', agent.id, {
    remoteUrl: 'https://example.com/acme/repo.git',
    branchName: 'main',
    displayName: 'Acme',
    teamId: 'team-1',
    developerId: 'alice',
    localRepoKey: 'a'.repeat(64),
  })
  let revision = 0
  let projected = null
  let index = null
  const snapshots = createTaskSnapshotService({
    db,
    taskSpaces,
    onRevisionCommitted: ({ taskSpaceId, revision: nextRevision }) => {
      revision = nextRevision
      void index.enqueue(taskSpaceId)
    },
  })
  index = createTaskSpaceIndex({
    db,
    stageIds: STAGE_IDS,
    taskSpaces,
    onProjected: (payload) => {
      projected = payload
    },
    logger: { warn() {} },
  })
  return {
    db,
    taskSpaces,
    snapshots,
    index,
    agent,
    taskSpaceId: attached.taskSpace.id,
    getRevision: () => revision,
    getProjected: () => projected,
  }
}

function files(taskId, branchText = '') {
  return [
    {
      path: `.trellis/tasks/11-10-${taskId}/task.json`,
      content: JSON.stringify({
        id: taskId,
        title: `任务 ${taskId}`,
        description: branchText,
        status: 'planning',
        priority: 'P2',
        assignee: 'alice',
        creator: 'alice',
        branch: 'main',
      }),
      baseSha256: null,
    },
    {
      path: `.trellis/tasks/11-10-${taskId}/prd.md`,
      content: `# 任务\n\n## Requirements\n\n- 同步\n\n## Acceptance Criteria\n\n- [ ] 完成 ${branchText}\n`,
      baseSha256: null,
    },
  ]
}

function taskFiles(taskDir, taskId, title, branch = 'main') {
  return [
    {
      path: `${taskDir}/task.json`,
      content: JSON.stringify({
        id: taskId,
        title,
        description: '',
        status: 'planning',
        priority: 'P2',
        assignee: 'alice',
        creator: 'alice',
        branch,
      }),
      baseSha256: null,
    },
    {
      path: `${taskDir}/prd.md`,
      content: '# 任务\n\n## Requirements\n\n- 同步\n\n## Acceptance Criteria\n\n- [ ] 完成\n',
      baseSha256: null,
    },
  ]
}

function trackedEvidence(taskDir, taskId, sourceBranch = 'feature/dev-sync') {
  return {
    version: 1,
    type: 'tracked-in-head',
    taskId,
    taskDir,
    trackedPath: `${taskDir}/task.json`,
    sourceBranch,
    baselineBranch: 'main',
    headCommit: 'a'.repeat(40),
  }
}

test('快照 Worker 不读取 Git/workspace 也能索引任务', async () => {
  const ctx = setup()
  try {
    const uploaded = ctx.snapshots.applyChanges(ctx.agent, ctx.taskSpaceId, {
      batchId: 'batch-0001',
      clientSequence: 1,
      files: files('demo', 'main'),
    })
    assert.equal(uploaded.revision, 1)
    await ctx.index.materializeNow(ctx.taskSpaceId)
    const cache = ctx.index.readTaskSpaceCache(ctx.taskSpaceId)
    assert.equal(cache.revision, 1)
    assert.equal(cache.board.tasks.length, 1)
    assert.equal(cache.board.tasks[0].branchName, 'main')
  } finally {
    await ctx.index.close()
    ctx.db.close()
  }
})

test('同一 taskSpace 重复 task.json.id 会标记身份冲突而不是静默执行', async () => {
  const ctx = setup()
  try {
    ctx.snapshots.applyChanges(ctx.agent, ctx.taskSpaceId, {
      batchId: 'batch-dup-1',
      clientSequence: 1,
      files: taskFiles('.trellis/tasks/11-10-dup-a', 'duplicate-id', '任务 A'),
    })
    ctx.snapshots.applyChanges(ctx.agent, ctx.taskSpaceId, {
      batchId: 'batch-dup-2',
      clientSequence: 2,
      files: taskFiles('.trellis/tasks/11-10-dup-b', 'duplicate-id', '任务 B'),
    })
    await ctx.index.materializeNow(ctx.taskSpaceId)
    const result = ctx.index.queryTasks(ctx.taskSpaces.actorContext('user-1'), {
      taskSpaceId: ctx.taskSpaceId,
    })
    assert.equal(result.tasks.length, 2)
    assert.ok(result.tasks.every((task) => task.executionIdentityConflict === true))
    assert.ok(result.tasks.every((task) => task.attentionReasons.includes('identity_conflict')))
  } finally {
    await ctx.index.close()
    ctx.db.close()
  }
})

test('全部项目查询覆盖多个项目与分支，并保持权限、筛选和游标隔离', async () => {
  const ctx = setup()
  try {
    const dev = ctx.taskSpaces.attach('user-1', ctx.agent.id, {
      remoteUrl: 'https://example.com/acme/repo.git',
      branchName: 'feature/dev-sync',
      displayName: 'Acme',
      teamId: 'team-1',
      developerId: 'alice',
      localRepoKey: 'd'.repeat(64),
    })
    const other = ctx.taskSpaces.attach('user-1', ctx.agent.id, {
      remoteUrl: 'https://example.com/acme/other.git',
      branchName: 'main',
      displayName: 'Other',
      teamId: 'team-1',
      developerId: 'alice',
      localRepoKey: 'c'.repeat(64),
    })

    ctx.snapshots.applyChanges(ctx.agent, dev.taskSpace.id, {
      batchId: 'batch-all-dev-shared',
      clientSequence: 1,
      files: taskFiles('.trellis/tasks/11-10-shared', 'shared', '共享任务 dev', 'feature/dev-sync'),
    })
    ctx.snapshots.applyChanges(ctx.agent, dev.taskSpace.id, {
      batchId: 'batch-all-dev-only',
      clientSequence: 2,
      files: taskFiles('.trellis/tasks/11-10-dev-only', 'dev-only', 'dev 任务', 'feature/dev-sync'),
    })
    ctx.snapshots.applyChanges(ctx.agent, ctx.taskSpaceId, {
      batchId: 'batch-all-main-shared',
      clientSequence: 1,
      observedBranchName: 'main',
      mergeEvidence: trackedEvidence('.trellis/tasks/11-10-shared', 'shared'),
      files: taskFiles(
        '.trellis/tasks/11-10-shared',
        'shared',
        '共享任务 main',
        'feature/dev-sync',
      ),
    })
    ctx.snapshots.applyChanges(ctx.agent, ctx.taskSpaceId, {
      batchId: 'batch-all-main-only',
      clientSequence: 2,
      files: taskFiles('.trellis/tasks/11-10-main-only', 'main-only', 'main 任务'),
    })
    ctx.snapshots.applyChanges(ctx.agent, other.taskSpace.id, {
      batchId: 'batch-all-other',
      clientSequence: 1,
      files: taskFiles('.trellis/tasks/11-10-other', 'other', '其他项目任务'),
    })

    await Promise.all([
      ctx.index.materializeNow(ctx.taskSpaceId),
      ctx.index.materializeNow(dev.taskSpace.id),
      ctx.index.materializeNow(other.taskSpace.id),
    ])
    const now = new Date().toISOString()
    ctx.db
      .prepare(
        `INSERT INTO team(id, name, slug, status, created_at, updated_at)
         VALUES ('team-2', '团队二', 'team-2', 'active', ?, ?)`,
      )
      .run(now, now)
    ctx.db
      .prepare(
        `INSERT INTO team_member(team_id, user_id, role, created_at, updated_at)
         VALUES ('team-2', 'user-1', 'member', ?, ?)`,
      )
      .run(now, now)
    const actor = ctx.taskSpaces.actorContext('user-1')
    const first = ctx.index.queryTasks(actor, { limit: 2 })
    assert.equal(first.total, 4)
    assert.equal(first.tasks.length, 2)
    assert.ok(first.tasks.every((task) => task.taskSpaceId && task.branchName))
    const baselineShared = ctx.index
      .queryTasks(actor, { q: '共享任务 main' })
      .tasks.find((task) => task.taskSpaceId === ctx.taskSpaceId)
    assert.equal(baselineShared?.sourceBranchName, 'feature/dev-sync')

    const seen = new Set(first.tasks.map((task) => `${task.taskSpaceId}:${task.taskKey}`))
    let cursor = first.nextCursor
    while (cursor) {
      const page = ctx.index.queryTasks(actor, { limit: 2, cursor })
      page.tasks.forEach((task) => seen.add(`${task.taskSpaceId}:${task.taskKey}`))
      cursor = page.nextCursor
    }
    assert.equal(seen.size, 4)

    const branchFiltered = ctx.index.queryTasks(actor, { branch: ' DEV ' })
    assert.equal(branchFiltered.total, 1)
    assert.ok(branchFiltered.tasks.every((task) => task.taskSpaceId === dev.taskSpace.id))
    assert.equal(ctx.index.queryTasks(actor, { branch: '%' }).total, 0)
    assert.equal(ctx.index.queryTasks(actor, { branch: '_' }).total, 0)
    assert.throws(
      () => ctx.index.queryTasks(actor, { branch: 'x'.repeat(201) }),
      (error) => error.status === 400 && error.code === 'INVALID_INPUT',
    )

    const oneProject = ctx.index.queryTasks(actor, { projectIds: [dev.project.id] })
    assert.equal(oneProject.total, 3)
    assert.ok(oneProject.tasks.every((task) => task.projectId === dev.project.id))
    assert.throws(
      () => ctx.index.queryTasks(actor, { projectIds: ['missing-project'] }),
      (error) => error.status === 403 && error.code === 'FORBIDDEN',
    )

    const single = ctx.index.queryTasks(actor, { taskSpaceId: ctx.taskSpaceId })
    assert.equal(single.total, 2)
    assert.ok(single.tasks.every((task) => task.taskSpaceId === ctx.taskSpaceId))
    assert.equal(ctx.index.queryTasks(actor, { taskSpaceId: 'all' }).total, 4)
    assert.throws(
      () =>
        ctx.index.queryTasks(actor, {
          taskSpaceId: ctx.taskSpaceId,
          projectIds: [other.project.id],
        }),
      (error) => error.status === 403 && error.code === 'FORBIDDEN',
    )
    const mainProjectId = ctx.db
      .prepare('SELECT project_id FROM sync_task_space WHERE id = ?')
      .get(ctx.taskSpaceId).project_id
    assert.throws(
      () =>
        ctx.index.queryTasks(actor, {
          taskSpaceId: ctx.taskSpaceId,
          projectIds: [mainProjectId, other.project.id],
        }),
      (error) => error.status === 403 && error.code === 'FORBIDDEN',
    )

    assert.throws(
      () =>
        ctx.index.queryTasks(actor, {
          taskSpaceId: ctx.taskSpaceId,
          teamId: 'team-2',
        }),
      (error) => error.status === 404 && error.code === 'NOT_FOUND',
    )

    const staleCursor = ctx.index.queryTasks(actor, { limit: 1 }).nextCursor
    assert.throws(
      () => ctx.index.queryTasks(actor, { branch: 'dev', cursor: staleCursor }),
      (error) => error.status === 409 && error.code === 'CURSOR_INVALID',
    )

    const beforeRevision = ctx.index.queryTasks(actor).etag
    ctx.snapshots.applyChanges(ctx.agent, other.taskSpace.id, {
      batchId: 'batch-all-other-change',
      clientSequence: 2,
      files: taskFiles('.trellis/tasks/11-10-other-2', 'other-2', '其他项目新任务'),
    })
    await ctx.index.materializeNow(other.taskSpace.id)
    assert.notEqual(ctx.index.queryTasks(actor).etag, beforeRevision)
  } finally {
    await ctx.index.close()
    ctx.db.close()
  }
})

test('分支筛选使用 Unicode 大小写不敏感匹配', async () => {
  const ctx = setup()
  try {
    const unicode = ctx.taskSpaces.attach('user-1', ctx.agent.id, {
      remoteUrl: 'https://example.com/acme/repo.git',
      branchName: 'feature/ÄBC-sync',
      displayName: 'Acme',
      teamId: 'team-1',
      developerId: 'alice',
      localRepoKey: 'd'.repeat(64),
    })
    ctx.snapshots.applyChanges(ctx.agent, unicode.taskSpace.id, {
      batchId: 'batch-unicode-branch',
      clientSequence: 1,
      files: taskFiles(
        '.trellis/tasks/11-10-unicode',
        'unicode',
        'Unicode 分支任务',
        'feature/ÄBC-sync',
      ),
    })
    await ctx.index.materializeNow(unicode.taskSpace.id)

    const actor = ctx.taskSpaces.actorContext('user-1')
    const result = ctx.index.queryTasks(actor, { branch: 'äbc' })
    assert.equal(result.total, 1)
    assert.equal(result.tasks[0].taskSpaceId, unicode.taskSpace.id)
  } finally {
    await ctx.index.close()
    ctx.db.close()
  }
})
