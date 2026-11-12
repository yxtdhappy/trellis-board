import assert from 'node:assert/strict'
import test from 'node:test'
import { openDatabase } from '../database.js'
import { createSyncAgentService } from '../team/sync-agent-service.js'
import { createTaskCommandService } from '../team/task-command-service.js'
import { createTaskSpaceService } from '../team/task-space-service.js'

function insertUser(db, id, displayName) {
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO user_account(
      id, username_key, username, display_name, password_hash, password_params_json,
      system_admin, status, must_change_password, password_changed_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'x', '{}', 0, 'active', 0, ?, ?, ?)`,
  ).run(id, id, id, displayName, now, now, now)
  db.prepare(
    `INSERT INTO team_member(team_id, user_id, role, created_at, updated_at)
     VALUES ('team-1', ?, 'member', ?, ?)`,
  ).run(id, now, now)
}

function insertAgent(db, id, userId, deviceName, lastSeenAt = new Date().toISOString()) {
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO agent_device(
      id, user_id, device_name, platform, agent_version, protocol_version,
      credential_hash, status, last_seen_at, created_at
    ) VALUES (?, ?, ?, 'win32', '0.1.0', 3, ?, 'active', ?, ?)`,
  ).run(id, userId, deviceName, `${id}-credential`, lastSeenAt, now)
  db.prepare(
    `INSERT INTO sync_active_agent(user_id, agent_id, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET agent_id = excluded.agent_id, updated_at = excluded.updated_at`,
  ).run(userId, id, now)
}

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
  insertUser(db, 'user-a', '创建人')
  insertUser(db, 'user-b', '执行人')
  insertAgent(db, 'agent-a', 'user-a', '创建人设备')
  insertAgent(db, 'agent-b', 'user-b', '执行人设备')

  const taskSpaces = createTaskSpaceService({ db })
  const first = taskSpaces.attach('user-a', 'agent-a', {
    remoteUrl: 'https://example.com/acme/repo.git',
    branchName: 'main',
    displayName: 'Acme',
    teamId: 'team-1',
    developerId: 'alice',
    localRepoKey: 'a'.repeat(64),
  })
  taskSpaces.upsertMember(taskSpaces.actorContext('user-a'), {
    projectId: first.project.id,
    userId: 'user-b',
    role: 'member',
    trellisDevId: 'bob',
  })
  const second = taskSpaces.attach('user-b', 'agent-b', {
    remoteUrl: 'https://example.com/acme/repo.git',
    branchName: 'main',
    displayName: 'Acme',
    teamId: 'team-1',
    localRepoKey: 'b'.repeat(64),
  })
  const events = []
  const agents = createSyncAgentService({
    db,
    config: { agentStaleMs: 60_000 },
    events: { publishAgentRevoked() {} },
  })
  const commands = createTaskCommandService({
    db,
    taskSpaces,
    agents,
    events: {
      notifyCommandAvailable(agentId) {
        events.push(agentId)
      },
    },
  })
  return {
    db,
    taskSpaces,
    commands,
    events,
    actor: taskSpaces.actorContext('user-a'),
    taskSpaceId: second.taskSpace.id,
    targetAgentId: 'agent-b',
    targetBindingId: second.binding.id,
  }
}

function createInput(taskSpaceId, overrides = {}) {
  return {
    commandType: 'create_task',
    taskSpaceId,
    assigneeUserId: 'user-b',
    title: '客户端创建任务',
    description: '由在线 Agent 创建',
    priority: 'P2',
    slug: 'client-created',
    idempotencyKey: 'create-1',
    ...overrides,
  }
}

test('目标 Agent 离线时不生成命令，并返回可操作原因', () => {
  const { db, commands, actor, taskSpaceId } = setup()
  try {
    db.prepare(
      "UPDATE agent_device SET last_seen_at = '2000-01-01T00:00:00.000Z' WHERE id = 'agent-b'",
    ).run()
    assert.throws(
      () => commands.enqueue(actor, createInput(taskSpaceId)),
      (error) => {
        assert.equal(error.status, 409)
        assert.equal(error.code, 'AGENT_OFFLINE')
        assert.match(error.message, /执行人|user-b/)
        assert.match(error.message, /打开客户端/)
        assert.equal(error.details.taskSpaceId, taskSpaceId)
        assert.equal(error.details.branchName, 'main')
        return true
      },
    )
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sync_task_command').get().count, 0)
  } finally {
    db.close()
  }
})

test('在线 Agent 收到唯一命令，幂等重放不重复入队', () => {
  const { db, commands, events, actor, taskSpaceId, targetAgentId, targetBindingId } = setup()
  try {
    const first = commands.enqueue(actor, createInput(taskSpaceId))
    assert.equal(first.statusCode, 202)
    assert.equal(first.operation.status, 'pending')
    assert.deepEqual(events, [targetAgentId])

    const replay = commands.enqueue(actor, createInput(taskSpaceId))
    assert.equal(replay.idempotent, true)
    assert.equal(replay.operation.id, first.operation.id)
    assert.deepEqual(events, [targetAgentId])

    const available = commands.available(targetAgentId)
    assert.equal(available.length, 1)
    assert.equal(available[0].bindingId, targetBindingId)
    assert.equal(available[0].type, 'create_task')
    assert.equal(available[0].payload.taskSpaceId, taskSpaceId)
    assert.equal(available[0].payload.assigneeDevId, 'bob')

    commands.markDelivered(targetAgentId, first.operation.id)
    assert.equal(commands.get(actor, first.operation.id).operation.status, 'delivered')
    const started = commands.start(targetAgentId, first.operation.id)
    assert.equal(started.execute, true)
    assert.equal(started.operation.status, 'running')
    assert.equal(commands.start(targetAgentId, first.operation.id).execute, false)
  } finally {
    db.close()
  }
})

test('投递和执行租约过期后回到待投递，运行中的命令不会并发重复执行', () => {
  const { db, commands, actor, taskSpaceId, targetAgentId } = setup()
  try {
    const queued = commands.enqueue(actor, createInput(taskSpaceId))
    commands.markDelivered(targetAgentId, queued.operation.id)
    db.prepare(`
      UPDATE sync_task_command
      SET lease_expires_at = '2000-01-01T00:00:00.000Z'
      WHERE id = ?
    `).run(queued.operation.id)
    commands.staleLeases(targetAgentId)
    assert.equal(commands.get(actor, queued.operation.id).operation.status, 'pending')

    commands.markDelivered(targetAgentId, queued.operation.id)
    assert.equal(commands.start(targetAgentId, queued.operation.id).execute, true)
    db.prepare(`
      UPDATE sync_task_command
      SET lease_expires_at = '2000-01-01T00:00:00.000Z'
      WHERE id = ?
    `).run(queued.operation.id)
    commands.staleLeases(targetAgentId)
    assert.equal(commands.get(actor, queued.operation.id).operation.status, 'pending')
  } finally {
    db.close()
  }
})

test('未进入 running 的命令不能提交执行结果', () => {
  const { db, commands, actor, taskSpaceId } = setup()
  try {
    const queued = commands.enqueue(actor, createInput(taskSpaceId))
    commands.markDelivered('agent-b', queued.operation.id)
    assert.throws(
      () =>
        commands.complete({ id: 'agent-b', userId: 'user-b' }, queued.operation.id, {
          status: 'succeeded',
          result: {
            taskId: 'task-1',
            executionTaskKey: `${taskSpaceId}::task-1`,
            relativeDir: '.trellis/tasks/11-10-task-1',
            revision: 1,
          },
        }),
      /尚未进入运行状态/,
    )
  } finally {
    db.close()
  }
})

test('成功结果必须等待索引命中；失败后可重试并重新绑定当前有效 Agent', () => {
  const { db, taskSpaces, commands, actor, taskSpaceId } = setup()
  try {
    const queued = commands.enqueue(actor, createInput(taskSpaceId))
    commands.markDelivered('agent-b', queued.operation.id)
    assert.equal(commands.start('agent-b', queued.operation.id).execute, true)

    db.prepare(`
      UPDATE sync_task_space
      SET revision = 1, indexed_revision = 0
      WHERE id = ?
    `).run(taskSpaceId)
    assert.throws(
      () =>
        commands.complete({ id: 'agent-b', userId: 'user-b' }, queued.operation.id, {
          status: 'succeeded',
          result: {
            taskId: 'task-1',
            taskKey: `${taskSpaceId}::.trellis/tasks/11-10-task-1`,
            executionTaskKey: `${taskSpaceId}::task-1`,
            relativeDir: '.trellis/tasks/11-10-task-1',
            revision: 1,
          },
        }),
      /尚未完成索引/,
    )

    const timestamp = new Date().toISOString()
    db.prepare(`
      INSERT INTO sync_task_index(
        task_space_id, project_id, task_key, execution_task_key, relative_dir,
        branch_name, title, search_text, archived, priority, derived_stage,
        assignee_dev_id, assignee_user_id, attention_flags_json, group_key,
        group_role, task_version, board_version, updated_at
      ) VALUES (?, (SELECT project_id FROM sync_task_space WHERE id = ?), ?, ?, ?,
        'main', '客户端创建任务', '客户端创建任务', 0, 'P2', 'planning',
        'bob', 'user-b', '[]', ?, 'single', 'v1', 'v1', ?)
    `).run(
      taskSpaceId,
      taskSpaceId,
      `${taskSpaceId}::.trellis/tasks/11-10-task-1`,
      `${taskSpaceId}::task-1`,
      '.trellis/tasks/11-10-task-1',
      `${taskSpaceId}::.trellis/tasks/11-10-task-1`,
      timestamp,
    )
    db.prepare('UPDATE sync_task_space SET indexed_revision = 1 WHERE id = ?').run(taskSpaceId)

    const completed = commands.complete({ id: 'agent-b', userId: 'user-b' }, queued.operation.id, {
      status: 'succeeded',
      result: {
        taskId: 'task-1',
        taskKey: `${taskSpaceId}::.trellis/tasks/11-10-task-1`,
        executionTaskKey: `${taskSpaceId}::task-1`,
        relativeDir: '.trellis/tasks/11-10-task-1',
        revision: 1,
      },
    })
    assert.equal(completed.operation.status, 'succeeded')

    const failed = commands.enqueue(
      actor,
      createInput(taskSpaceId, {
        title: '会失败的任务',
        slug: 'will-fail',
        idempotencyKey: 'create-2',
      }),
    )
    commands.markDelivered('agent-b', failed.operation.id)
    assert.equal(commands.start('agent-b', failed.operation.id).execute, true)
    commands.complete({ id: 'agent-b', userId: 'user-b' }, failed.operation.id, {
      status: 'failed',
      error: 'task.py 执行失败',
    })

    db.prepare(
      "UPDATE sync_agent_binding SET sync_status = 'revoked' WHERE agent_id = 'agent-b'",
    ).run()
    insertAgent(db, 'agent-b2', 'user-b', '执行人新设备')
    const rebound = taskSpaces.attach('user-b', 'agent-b2', {
      remoteUrl: 'https://example.com/acme/repo.git',
      branchName: 'main',
      displayName: 'Acme',
      teamId: 'team-1',
      localRepoKey: 'c'.repeat(64),
    })
    const retried = commands.retry(actor, failed.operation.id)
    assert.equal(retried.operation.status, 'pending')
    assert.equal(retried.operation.agentId, 'agent-b2')
    assert.equal(retried.operation.bindingId, rebound.binding.id)
  } finally {
    db.close()
  }
})
