import assert from 'node:assert/strict'
import test from 'node:test'
import { openDatabase } from '../database.js'
import { createTaskOwnershipInboxService } from '../team/task-ownership-inbox.js'
import { createTaskSnapshotService } from '../team/task-snapshot-service.js'
import { createTaskSpaceService } from '../team/task-space-service.js'

function setup() {
  const db = openDatabase({
    databaseFile: ':memory:',
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
    INSERT INTO team(id, name, slug, status, created_at, updated_at)
    VALUES ('team-2', '团队二', 'team-2', 'active', ?, ?)
  `).run(now, now)
  for (const [id, displayName, teamId, role] of [
    ['user-a', '用户 A', 'team-1', 'member'],
    ['user-b', '用户 B', 'team-1', 'member'],
    ['user-c', '用户 C', 'team-2', 'member'],
  ]) {
    db.prepare(`
      INSERT INTO user_account(
        id, username_key, username, display_name, password_hash, password_params_json,
        system_admin, status, must_change_password, password_changed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'x', '{}', 0, 'active', 0, ?, ?, ?)
    `).run(id, id, id, displayName, now, now, now)
    db.prepare(`
      INSERT INTO team_member(team_id, user_id, role, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(teamId, id, role, now, now)
  }
  for (const [id, userId, deviceName] of [
    ['agent-user-a', 'user-a', '设备 A'],
    ['agent-user-b', 'user-b', '设备 B'],
  ]) {
    db.prepare(`
      INSERT INTO agent_device(
        id, user_id, device_name, platform, agent_version, protocol_version,
        credential_hash, status, last_seen_at, created_at
      ) VALUES (?, ?, ?, 'win32', '0.1.0', 3, ?, 'active', ?, ?)
    `).run(id, userId, deviceName, `credential-${id}`, now, now)
    db.prepare(`
      INSERT INTO sync_active_agent(user_id, agent_id, updated_at)
      VALUES (?, ?, ?)
    `).run(userId, id, now)
  }

  const taskSpaces = createTaskSpaceService({ db })
  const agentA = { id: 'agent-user-a', userId: 'user-a' }
  const agentB = { id: 'agent-user-b', userId: 'user-b' }
  const attached = taskSpaces.attach('user-a', agentA.id, {
    remoteUrl: 'https://example.com/acme/repo.git',
    branchName: 'main',
    displayName: 'Acme',
    teamId: 'team-1',
    developerId: 'alice',
    localRepoKey: 'a'.repeat(64),
  })
  taskSpaces.upsertMember(taskSpaces.actorContext('user-a'), {
    projectId: attached.project.id,
    userId: 'user-b',
    role: 'member',
    trellisDevId: 'bob',
  })
  const second = taskSpaces.attach('user-b', agentB.id, {
    remoteUrl: 'https://example.com/acme/repo.git',
    branchName: 'main',
    displayName: 'Acme',
    teamId: 'team-1',
    developerId: 'bob',
    localRepoKey: 'b'.repeat(64),
  })

  const snapshots = createTaskSnapshotService({ db, taskSpaces })
  let clock = Date.parse('2026-11-18T01:00:00.000Z')
  const inbox = createTaskOwnershipInboxService({
    db,
    taskSpaces,
    taskSnapshots: snapshots,
    now: () => new Date(clock++),
  })
  return {
    db,
    taskSpaces,
    snapshots,
    inbox,
    agentA,
    agentB,
    projectId: second.project.id,
    taskSpaceId: second.taskSpace.id,
  }
}

function upsert(taskId, title = `任务 ${taskId}`, fingerprint = 'a'.repeat(64)) {
  return {
    taskId,
    taskDir: `.trellis/tasks/11-18-${taskId}`,
    title,
    reason: 'TASK_OWNERSHIP_REQUIRED',
    fingerprint,
  }
}

function write(observedBranchName, upserts = [], deletes = []) {
  return {
    observedBranchName,
    upserts,
    deletes,
  }
}

function snapshotBatch(taskId, sequence) {
  return {
    observedBranchName: 'main',
    batchId: `batch-${taskId}-${sequence}`,
    clientSequence: sequence,
    files: [
      {
        path: `.trellis/tasks/11-18-${taskId}/task.json`,
        content: JSON.stringify({ id: taskId, title: `任务 ${taskId}`, branch: 'main' }),
        baseSha256: null,
      },
      {
        path: `.trellis/tasks/11-18-${taskId}/prd.md`,
        content: '# PRD\n',
        baseSha256: null,
      },
    ],
  }
}

test('待归属摘要幂等、多来源聚合、删除和稳定分页', () => {
  const { db, taskSpaces, inbox, agentA, agentB, projectId, taskSpaceId } = setup()
  try {
    inbox.apply(agentA, taskSpaceId, write('main', [upsert('task-a', '版本一')]))
    const first = db
      .prepare(`
        SELECT first_seen_at FROM sync_task_ownership_inbox
        WHERE source_agent_id = ? AND task_id = 'task-a'
      `)
      .get(agentA.id)
    inbox.apply(agentA, taskSpaceId, write('main', [upsert('task-a', '版本二')]))
    assert.equal(
      db
        .prepare(`
          SELECT first_seen_at FROM sync_task_ownership_inbox
          WHERE source_agent_id = ? AND task_id = 'task-a'
        `)
        .get(agentA.id).first_seen_at,
      first.first_seen_at,
    )
    inbox.apply(agentB, taskSpaceId, write('main', [upsert('task-a', '版本三')]))
    assert.equal(
      db
        .prepare("SELECT COUNT(*) AS count FROM sync_task_ownership_inbox WHERE task_id = 'task-a'")
        .get().count,
      2,
    )

    const actor = taskSpaces.actorContext('user-a')
    const listed = inbox.list(actor, { teamId: 'team-1', projectIds: [projectId], limit: 50 })
    assert.equal(listed.total, 1)
    assert.equal(listed.items.length, 1)
    assert.equal(listed.items[0].title, '版本三')
    assert.deepEqual(listed.items[0].sourceBranches, ['main'])
    assert.deepEqual(listed.items[0].sourceClients.map((client) => client.displayName).sort(), [
      '设备 A',
      '设备 B',
    ])
    assert.equal(inbox.countByProject([projectId]).get(projectId), 1)

    inbox.apply(
      agentA,
      taskSpaceId,
      write('main', [], [{ taskId: 'task-a', taskDir: '.trellis/tasks/11-18-task-a' }]),
    )
    const repeatedDelete = inbox.apply(
      agentA,
      taskSpaceId,
      write('main', [], [{ taskId: 'task-a', taskDir: '.trellis/tasks/11-18-task-a' }]),
    )
    assert.equal(repeatedDelete.changed, false)
    assert.equal(inbox.list(actor, { teamId: 'team-1', projectIds: [projectId] }).total, 1)
    inbox.apply(
      agentB,
      taskSpaceId,
      write('main', [], [{ taskId: 'task-a', taskDir: '.trellis/tasks/11-18-task-a' }]),
    )
    assert.equal(inbox.list(actor, { teamId: 'team-1', projectIds: [projectId] }).total, 0)

    for (const taskId of ['task-1', 'task-2', 'task-3']) {
      inbox.apply(agentA, taskSpaceId, write('main', [upsert(taskId)]))
    }
    const firstPage = inbox.list(actor, {
      teamId: 'team-1',
      projectIds: [projectId],
      limit: 2,
    })
    assert.deepEqual(
      firstPage.items.map((item) => item.taskId),
      ['task-3', 'task-2'],
    )
    assert.equal(firstPage.total, 3)
    assert.ok(firstPage.nextCursor)
    const secondPage = inbox.list(actor, {
      teamId: 'team-1',
      projectIds: [projectId],
      limit: 2,
      cursor: firstPage.nextCursor,
    })
    assert.deepEqual(
      secondPage.items.map((item) => item.taskId),
      ['task-1'],
    )
    assert.equal(secondPage.nextCursor, null)
  } finally {
    db.close()
  }
})

test('待归属摘要超过 200 项或字段非法时整批拒绝', () => {
  const { db, inbox, agentA, taskSpaceId } = setup()
  try {
    const overLimit = Array.from({ length: 201 }, (_, index) =>
      upsert(`task-${index}`, `任务 ${index}`),
    )
    assert.throws(
      () => inbox.apply(agentA, taskSpaceId, write('main', overLimit)),
      /最多提交 200 个待归属变更/,
    )
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM sync_task_ownership_inbox').get().count,
      0,
    )

    assert.throws(
      () =>
        inbox.apply(
          agentA,
          taskSpaceId,
          write('main', [upsert('valid'), upsert('invalid', '标题', 'abc')]),
        ),
      /64 位小写 SHA-256/,
    )
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM sync_task_ownership_inbox').get().count,
      0,
    )
  } finally {
    db.close()
  }
})

test('待归属查询拒绝不可读项目', () => {
  const { db, taskSpaces, inbox, agentA, projectId, taskSpaceId } = setup()
  try {
    inbox.apply(agentA, taskSpaceId, write('main', [upsert('task-a')]))
    assert.throws(
      () =>
        inbox.list(taskSpaces.actorContext('user-c'), {
          teamId: 'all',
          projectIds: [projectId],
        }),
      (error) => error.status === 403 && error.code === 'FORBIDDEN',
    )
  } finally {
    db.close()
  }
})

test('正常任务接纳与摘要清理处于同一事务', () => {
  const { db, inbox, snapshots, agentA, agentB, taskSpaceId } = setup()
  try {
    inbox.apply(agentA, taskSpaceId, write('main', [upsert('task-clear')]))
    inbox.apply(agentB, taskSpaceId, write('main', [upsert('task-clear')]))
    snapshots.applyChanges(agentA, taskSpaceId, snapshotBatch('task-clear', 1))
    assert.equal(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM sync_task_ownership_inbox WHERE task_id = 'task-clear'",
        )
        .get().count,
      0,
    )
    assert.equal(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM sync_task_space_file WHERE task_id = 'task-clear' AND deleted = 0",
        )
        .get().count,
      2,
    )

    inbox.apply(agentA, taskSpaceId, write('main', [upsert('task-rollback')]))
    db.exec(`
      CREATE TRIGGER block_inbox_delete
      BEFORE DELETE ON sync_task_ownership_inbox
      BEGIN
        SELECT RAISE(ABORT, 'blocked inbox cleanup');
      END;
    `)
    assert.throws(
      () => snapshots.applyChanges(agentA, taskSpaceId, snapshotBatch('task-rollback', 2)),
      /blocked inbox cleanup/,
    )
    assert.equal(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM sync_task_space_file WHERE task_id = 'task-rollback'",
        )
        .get().count,
      0,
    )
    assert.equal(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM sync_task_ownership_inbox WHERE task_id = 'task-rollback'",
        )
        .get().count,
      1,
    )
  } finally {
    db.close()
  }
})
