import assert from 'node:assert/strict'
import test from 'node:test'
import { openDatabase } from '../database.js'
import { STAGE_IDS, setManualStage } from '../metadata.js'
import { createTaskSnapshotService } from '../team/task-snapshot-service.js'
import { createTaskSpaceIndex } from '../team/task-space-index.js'
import { createTaskSpaceService } from '../team/task-space-service.js'

function setup({ autoIndex = true } = {}) {
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
    onRevisionCommitted: autoIndex
      ? ({ taskSpaceId, revision: nextRevision }) => {
          revision = nextRevision
          void index.enqueue(taskSpaceId)
        }
      : null,
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

function withTaskFields(taskFilesToChange, fields) {
  const taskJson = JSON.parse(taskFilesToChange[0].content)
  taskFilesToChange[0].content = JSON.stringify({ ...taskJson, ...fields })
  return taskFilesToChange
}

function withServerBase(ctx, taskFilesToChange) {
  return taskFilesToChange.map((file) => ({
    ...file,
    baseSha256:
      ctx.db
        .prepare(
          'SELECT sha256 FROM sync_task_space_file WHERE task_space_id = ? AND relative_path = ?',
        )
        .get(ctx.taskSpaceId, file.path)?.sha256 || null,
  }))
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

test('warm revision 只扫描变化任务并复用未变化任务', async () => {
  const ctx = setup()
  try {
    ctx.snapshots.applyChanges(ctx.agent, ctx.taskSpaceId, {
      batchId: 'batch-warm-a',
      clientSequence: 1,
      files: files('a'),
    })
    ctx.snapshots.applyChanges(ctx.agent, ctx.taskSpaceId, {
      batchId: 'batch-warm-b',
      clientSequence: 2,
      files: files('b'),
    })
    await ctx.index.materializeNow(ctx.taskSpaceId)

    const unchangedUpdatedAt = ctx.db
      .prepare(
        `SELECT updated_at FROM sync_task_index
         WHERE task_space_id = ? AND title = '任务 b'`,
      )
      .get(ctx.taskSpaceId).updated_at
    const changed = withServerBase(ctx, files('a', 'changed'))
    ctx.snapshots.applyChanges(ctx.agent, ctx.taskSpaceId, {
      batchId: 'batch-warm-a-change',
      clientSequence: 3,
      files: changed,
    })
    const result = await ctx.index.materializeNow(ctx.taskSpaceId)
    assert.equal(result.superseded, false)
    assert.equal(result.stats.mode, 'incremental')
    assert.equal(result.stats.changedTaskCount, 1)
    assert.equal(result.stats.scannedTaskCount, 1)
    assert.equal(result.stats.reusedTaskCount, 1)
    assert.equal(result.stats.contentRowsRead, 2)

    const tasks = ctx.index.readTaskSpaceCache(ctx.taskSpaceId).board.tasks
    assert.equal(tasks.length, 2)
    assert.equal(tasks.find((task) => task.title === '任务 a').description, 'changed')
    assert.equal(tasks.find((task) => task.title === '任务 b').title, '任务 b')
    assert.equal(
      ctx.db
        .prepare(
          `SELECT updated_at FROM sync_task_index
           WHERE task_space_id = ? AND title = '任务 b'`,
        )
        .get(ctx.taskSpaceId).updated_at,
      unchangedUpdatedAt,
    )
  } finally {
    await ctx.index.close()
    ctx.db.close()
  }
})

test('索引提交失败时索引、缓存和 indexed_revision 整体回滚', async () => {
  const ctx = setup({ autoIndex: false })
  const firstDir = '.trellis/tasks/11-10-rollback-a'
  const secondDir = '.trellis/tasks/11-10-rollback-b'
  try {
    ctx.snapshots.applyChanges(ctx.agent, ctx.taskSpaceId, {
      batchId: 'batch-rollback-1',
      clientSequence: 1,
      files: taskFiles(firstDir, 'rollback-a', '回滚任务 A'),
    })
    await ctx.index.materializeNow(ctx.taskSpaceId)
    const before = {
      revision: Number(
        ctx.db.prepare('SELECT revision FROM sync_task_space WHERE id = ?').get(ctx.taskSpaceId)
          .revision,
      ),
      indexedRevision: Number(
        ctx.db
          .prepare('SELECT indexed_revision FROM sync_task_space WHERE id = ?')
          .get(ctx.taskSpaceId).indexed_revision,
      ),
      indexCount: Number(
        ctx.db
          .prepare('SELECT COUNT(*) AS count FROM sync_task_index WHERE task_space_id = ?')
          .get(ctx.taskSpaceId).count,
      ),
      cacheRevision: Number(
        ctx.db
          .prepare('SELECT indexed_revision FROM sync_task_space_scan_cache WHERE task_space_id = ?')
          .get(ctx.taskSpaceId).indexed_revision,
      ),
    }

    ctx.snapshots.applyChanges(ctx.agent, ctx.taskSpaceId, {
      batchId: 'batch-rollback-2',
      clientSequence: 2,
      files: taskFiles(secondDir, 'rollback-b', '回滚任务 B'),
    })
    ctx.db.exec(`
      CREATE TRIGGER fail_task_space_index_update
      BEFORE UPDATE OF indexed_revision ON sync_task_space
      BEGIN
        SELECT RAISE(ABORT, 'forced projection rollback');
      END;
    `)
    await assert.rejects(
      () => ctx.index.materializeNow(ctx.taskSpaceId),
      /forced projection rollback/,
    )
    assert.equal(
      Number(
        ctx.db.prepare('SELECT revision FROM sync_task_space WHERE id = ?').get(ctx.taskSpaceId)
          .revision,
      ),
      before.revision + 1,
    )
    assert.equal(
      Number(
        ctx.db
          .prepare('SELECT indexed_revision FROM sync_task_space WHERE id = ?')
          .get(ctx.taskSpaceId).indexed_revision,
      ),
      before.indexedRevision,
    )
    assert.equal(
      Number(
        ctx.db
          .prepare('SELECT COUNT(*) AS count FROM sync_task_index WHERE task_space_id = ?')
          .get(ctx.taskSpaceId).count,
      ),
      before.indexCount,
    )
    assert.equal(
      Number(
        ctx.db
          .prepare('SELECT indexed_revision FROM sync_task_space_scan_cache WHERE task_space_id = ?')
          .get(ctx.taskSpaceId).indexed_revision,
      ),
      before.cacheRevision,
    )

    ctx.db.exec('DROP TRIGGER fail_task_space_index_update')
    const recovered = await ctx.index.materializeNow(ctx.taskSpaceId)
    assert.equal(recovered.superseded, false)
    assert.equal(recovered.stats.mode, 'incremental')
    assert.equal(
      Number(
        ctx.db
          .prepare('SELECT COUNT(*) AS count FROM sync_task_index WHERE task_space_id = ?')
          .get(ctx.taskSpaceId).count,
      ),
      2,
    )
  } finally {
    ctx.db.exec('DROP TRIGGER IF EXISTS fail_task_space_index_update')
    await ctx.index.close()
    ctx.db.close()
  }
})

test('物化期间提交新 revision 时等待收敛且不写旧 revision', async () => {
  const ctx = setup({ autoIndex: false })
  const firstDir = '.trellis/tasks/11-10-race-a'
  const secondDir = '.trellis/tasks/11-10-race-b'
  try {
    ctx.snapshots.applyChanges(ctx.agent, ctx.taskSpaceId, {
      batchId: 'batch-race-1',
      clientSequence: 1,
      files: taskFiles(firstDir, 'race-a', '并发任务 A'),
    })
    await ctx.index.materializeNow(ctx.taskSpaceId)

    const pending = ctx.index.materializeNow(ctx.taskSpaceId)
    ctx.snapshots.applyChanges(ctx.agent, ctx.taskSpaceId, {
      batchId: 'batch-race-2',
      clientSequence: 2,
      files: taskFiles(secondDir, 'race-b', '并发任务 B'),
    })
    const result = await pending
    assert.equal(result.superseded, false)
    assert.equal(result.stats.targetRevision, 2)
    assert.equal(result.stats.mode, 'incremental')
    const space = ctx.db
      .prepare('SELECT revision, indexed_revision FROM sync_task_space WHERE id = ?')
      .get(ctx.taskSpaceId)
    assert.equal(Number(space.revision), 2)
    assert.equal(Number(space.indexed_revision), 2)
    assert.deepEqual(
      ctx.index
        .readTaskSpaceCache(ctx.taskSpaceId)
        .board.tasks.map((task) => task.title)
        .sort(),
      ['并发任务 A', '并发任务 B'],
    )
  } finally {
    await ctx.index.close()
    ctx.db.close()
  }
})

test('增量扫描后仍对全部任务重算父子关系', async () => {
  const ctx = setup()
  const parentDir = '.trellis/tasks/11-10-parent'
  const childDir = '.trellis/tasks/11-10-child'
  const thirdDir = '.trellis/tasks/11-10-third'
  try {
    const parent = withTaskFields(taskFiles(parentDir, 'parent', '父任务'), {
      children: ['child'],
    })
    ctx.snapshots.applyChanges(ctx.agent, ctx.taskSpaceId, {
      batchId: 'batch-relation-1',
      clientSequence: 1,
      files: parent,
    })
    ctx.snapshots.applyChanges(ctx.agent, ctx.taskSpaceId, {
      batchId: 'batch-relation-2',
      clientSequence: 2,
      files: taskFiles(childDir, 'child', '子任务'),
    })
    ctx.snapshots.applyChanges(ctx.agent, ctx.taskSpaceId, {
      batchId: 'batch-relation-3',
      clientSequence: 3,
      files: taskFiles(thirdDir, 'third', '第三任务'),
    })
    await ctx.index.materializeNow(ctx.taskSpaceId)

    const changedParent = withServerBase(
      ctx,
      withTaskFields(taskFiles(parentDir, 'parent', '父任务'), {
        children: ['child', 'third'],
      }),
    )
    ctx.snapshots.applyChanges(ctx.agent, ctx.taskSpaceId, {
      batchId: 'batch-relation-change',
      clientSequence: 4,
      files: changedParent,
    })
    const result = await ctx.index.materializeNow(ctx.taskSpaceId)
    assert.equal(result.stats.mode, 'incremental')
    assert.equal(result.stats.changedTaskCount, 1)
    assert.equal(result.stats.scannedTaskCount, 1)

    const tasks = ctx.index.readTaskSpaceCache(ctx.taskSpaceId).board.tasks
    const parentTask = tasks.find((task) => task.title === '父任务')
    assert.equal(parentTask.childTaskKeys.length, 2)
    assert.ok(
      tasks
        .filter((task) => ['子任务', '第三任务'].includes(task.title))
        .every((task) => task.parentTaskKey === parentTask.taskKey),
    )
  } finally {
    await ctx.index.close()
    ctx.db.close()
  }
})

test('增量删除任务不会留下旧索引', async () => {
  const ctx = setup({ autoIndex: false })
  const keepDir = '.trellis/tasks/11-10-keep'
  const removeDir = '.trellis/tasks/11-10-remove'
  try {
    ctx.snapshots.applyChanges(ctx.agent, ctx.taskSpaceId, {
      batchId: 'batch-delete-1',
      clientSequence: 1,
      files: taskFiles(keepDir, 'keep', '保留任务'),
    })
    ctx.snapshots.applyChanges(ctx.agent, ctx.taskSpaceId, {
      batchId: 'batch-delete-2',
      clientSequence: 2,
      files: taskFiles(removeDir, 'remove', '删除任务'),
    })
    await ctx.index.materializeNow(ctx.taskSpaceId)

    const current = ctx.snapshots.directorySnapshot(ctx.agent, ctx.taskSpaceId, removeDir)
    ctx.snapshots.applyChanges(ctx.agent, ctx.taskSpaceId, {
      batchId: 'batch-delete-3',
      clientSequence: 3,
      files: current.files.map((file) => ({
        path: file.path,
        content: '',
        baseSha256: file.sha256,
        deleted: true,
      })),
    })
    const result = await ctx.index.materializeNow(ctx.taskSpaceId)
    assert.equal(result.stats.mode, 'incremental')
    assert.equal(result.stats.changedTaskCount, 1)
    assert.equal(result.stats.scannedTaskCount, 0)
    const tasks = ctx.index.readTaskSpaceCache(ctx.taskSpaceId).board.tasks
    assert.deepEqual(tasks.map((task) => task.title), ['保留任务'])
    assert.equal(
      Number(
        ctx.db
          .prepare('SELECT COUNT(*) AS count FROM sync_task_index WHERE task_space_id = ?')
          .get(ctx.taskSpaceId).count,
      ),
      1,
    )
  } finally {
    await ctx.index.close()
    ctx.db.close()
  }
})

test('活动任务移动到归档目录后由增量投影替换旧路径', async () => {
  const ctx = setup({ autoIndex: false })
  const activeDir = '.trellis/tasks/11-10-move'
  const archivedDir = '.trellis/tasks/archive/2026-11/11-10-move'
  let restarted = null
  try {
    ctx.snapshots.applyChanges(ctx.agent, ctx.taskSpaceId, {
      batchId: 'batch-move-1',
      clientSequence: 1,
      files: taskFiles(activeDir, 'move', '移动任务'),
    })
    await ctx.index.materializeNow(ctx.taskSpaceId)
    const current = ctx.snapshots.directorySnapshot(ctx.agent, ctx.taskSpaceId, activeDir)
    ctx.snapshots.applyChanges(ctx.agent, ctx.taskSpaceId, {
      batchId: 'batch-move-2',
      clientSequence: 2,
      files: [
        ...current.files.map((file) => ({
          path: file.path,
          content: '',
          baseSha256: file.sha256,
          deleted: true,
        })),
        ...taskFiles(archivedDir, 'move', '移动任务'),
      ],
    })
    const result = await ctx.index.materializeNow(ctx.taskSpaceId)
    assert.equal(result.stats.mode, 'incremental')
    assert.equal(result.stats.changedTaskCount, 2)
    assert.equal(result.stats.scannedTaskCount, 1)
    const tasks = ctx.index.readTaskSpaceCache(ctx.taskSpaceId).board.tasks
    assert.equal(tasks.length, 1)
    assert.equal(tasks[0].relativeDir, archivedDir)
    assert.equal(tasks[0].archived, true)

    await ctx.index.close()
    restarted = createTaskSpaceIndex({
      db: ctx.db,
      stageIds: STAGE_IDS,
      taskSpaces: ctx.taskSpaces,
      logger: { warn() {}, info() {} },
    })
    await restarted.materializeNow(ctx.taskSpaceId)
    const rebuilt = restarted.readTaskSpaceCache(ctx.taskSpaceId).board.tasks
    assert.equal(rebuilt[0].archivedAt, tasks[0].archivedAt)
  } finally {
    await restarted?.close()
    await ctx.index.close()
    ctx.db.close()
  }
})

test('同一 revision 下人工阶段变化会重投影而不重新扫描任务', async () => {
  const ctx = setup()
  const taskDir = '.trellis/tasks/11-10-stage'
  try {
    ctx.snapshots.applyChanges(ctx.agent, ctx.taskSpaceId, {
      batchId: 'batch-stage',
      clientSequence: 1,
      files: taskFiles(taskDir, 'stage', '阶段任务'),
    })
    await ctx.index.materializeNow(ctx.taskSpaceId)
    setManualStage(ctx.taskSpaceId, taskDir, 'check', ctx.db)

    const result = await ctx.index.materializeNow(ctx.taskSpaceId)
    assert.equal(result.stats.mode, 'manual-reproject')
    assert.equal(result.stats.scannedTaskCount, 0)
    assert.equal(result.stats.contentRowsRead, 0)
    const task = ctx.index
      .readTaskSpaceCache(ctx.taskSpaceId)
      .board.tasks.find((item) => item.title === '阶段任务')
    assert.equal(task.manualStage, 'check')
  } finally {
    await ctx.index.close()
    ctx.db.close()
  }
})

test('新 index 实例模拟服务重启时安全回退全量重建', async () => {
  const ctx = setup()
  let restarted = null
  try {
    ctx.snapshots.applyChanges(ctx.agent, ctx.taskSpaceId, {
      batchId: 'batch-restart',
      clientSequence: 1,
      files: files('restart'),
    })
    await ctx.index.materializeNow(ctx.taskSpaceId)
    await ctx.index.close()
    restarted = createTaskSpaceIndex({
      db: ctx.db,
      stageIds: STAGE_IDS,
      taskSpaces: ctx.taskSpaces,
      logger: { warn() {}, info() {} },
    })
    const result = await restarted.materializeNow(ctx.taskSpaceId)
    assert.equal(result.stats.mode, 'full')
    assert.equal(result.stats.scannedTaskCount, 1)
    assert.equal(
      ctx.db
        .prepare('SELECT COUNT(*) AS count FROM sync_task_index WHERE task_space_id = ?')
        .get(ctx.taskSpaceId).count,
      1,
    )
  } finally {
    await restarted?.close()
    await ctx.index.close()
    ctx.db.close()
  }
})

test('增量任务参与者变化后的项目成员与全量重建一致', async () => {
  const ctx = setup({ autoIndex: false })
  const firstDir = '.trellis/tasks/11-10-member-a'
  const secondDir = '.trellis/tasks/11-10-member-b'
  let rebuilt = null
  try {
    ctx.snapshots.applyChanges(ctx.agent, ctx.taskSpaceId, {
      batchId: 'batch-member-1',
      clientSequence: 1,
      files: taskFiles(firstDir, 'member-a', '成员任务 A'),
    })
    await ctx.index.materializeNow(ctx.taskSpaceId)
    assert.deepEqual(
      ctx.index.readTaskSpaceCache(ctx.taskSpaceId).board.projects[0].members,
      ['alice'],
    )

    ctx.snapshots.applyChanges(ctx.agent, ctx.taskSpaceId, {
      batchId: 'batch-member-2',
      clientSequence: 2,
      files: withTaskFields(taskFiles(secondDir, 'member-b', '成员任务 B'), {
        assignee: 'bob',
        creator: 'bob',
      }),
    })
    const incremental = await ctx.index.materializeNow(ctx.taskSpaceId)
    assert.equal(incremental.stats.mode, 'incremental')
    const incrementalMembers =
      ctx.index.readTaskSpaceCache(ctx.taskSpaceId).board.projects[0].members
    assert.deepEqual(incrementalMembers, ['alice', 'bob'])

    rebuilt = createTaskSpaceIndex({
      db: ctx.db,
      stageIds: STAGE_IDS,
      taskSpaces: ctx.taskSpaces,
      logger: { warn() {}, info() {} },
    })
    const full = await rebuilt.materializeNow(ctx.taskSpaceId)
    assert.equal(full.stats.mode, 'full')
    assert.deepEqual(
      rebuilt.readTaskSpaceCache(ctx.taskSpaceId).board.projects[0].members,
      incrementalMembers,
    )
    await rebuilt.close()
    rebuilt = null

    const current = ctx.snapshots.directorySnapshot(ctx.agent, ctx.taskSpaceId, secondDir)
    ctx.snapshots.applyChanges(ctx.agent, ctx.taskSpaceId, {
      batchId: 'batch-member-3',
      clientSequence: 3,
      files: current.files.map((file) => ({
        path: file.path,
        content: '',
        baseSha256: file.sha256,
        deleted: true,
      })),
    })
    const removed = await ctx.index.materializeNow(ctx.taskSpaceId)
    assert.equal(removed.stats.mode, 'incremental')
    const membersAfterDelete =
      ctx.index.readTaskSpaceCache(ctx.taskSpaceId).board.projects[0].members
    assert.deepEqual(membersAfterDelete, ['alice'])

    rebuilt = createTaskSpaceIndex({
      db: ctx.db,
      stageIds: STAGE_IDS,
      taskSpaces: ctx.taskSpaces,
      logger: { warn() {}, info() {} },
    })
    await rebuilt.materializeNow(ctx.taskSpaceId)
    assert.deepEqual(
      rebuilt.readTaskSpaceCache(ctx.taskSpaceId).board.projects[0].members,
      membersAfterDelete,
    )
  } finally {
    await rebuilt?.close()
    await ctx.index.close()
    ctx.db.close()
  }
})

test('增量新增重复 task.json.id 仍在全任务范围标记身份冲突', async () => {
  const ctx = setup({ autoIndex: false })
  try {
    ctx.snapshots.applyChanges(ctx.agent, ctx.taskSpaceId, {
      batchId: 'batch-dup-1',
      clientSequence: 1,
      files: taskFiles('.trellis/tasks/11-10-dup-a', 'duplicate-id', '任务 A'),
    })
    await ctx.index.materializeNow(ctx.taskSpaceId)
    ctx.snapshots.applyChanges(ctx.agent, ctx.taskSpaceId, {
      batchId: 'batch-dup-2',
      clientSequence: 2,
      files: taskFiles('.trellis/tasks/11-10-dup-b', 'duplicate-id', '任务 B'),
    })
    const materialized = await ctx.index.materializeNow(ctx.taskSpaceId)
    assert.equal(materialized.stats.mode, 'incremental')
    assert.equal(materialized.stats.scannedTaskCount, 1)
    const queryResult = ctx.index.queryTasks(ctx.taskSpaces.actorContext('user-1'), {
      taskSpaceId: ctx.taskSpaceId,
    })
    assert.equal(queryResult.tasks.length, 2)
    assert.ok(queryResult.tasks.every((task) => task.executionIdentityConflict === true))
    assert.ok(
      queryResult.tasks.every((task) => task.attentionReasons.includes('identity_conflict')),
    )
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
