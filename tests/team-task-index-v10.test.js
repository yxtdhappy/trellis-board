import assert from 'node:assert/strict'
import test from 'node:test'
import { openDatabase } from '../server/database.js'
import { STAGE_IDS } from '../server/metadata.js'
import { createTaskSnapshotService } from '../server/team/task-snapshot-service.js'
import { createTaskSpaceIndex } from '../server/team/task-space-index.js'
import { createTaskSpaceService } from '../server/team/task-space-service.js'

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

function taskFiles(taskDir, taskId, title) {
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
