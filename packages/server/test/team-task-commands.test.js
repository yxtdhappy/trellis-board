import assert from 'node:assert/strict'
import test from 'node:test'
import { openDatabase } from '../database.js'
import { createSyncAgentService } from '../team/sync-agent-service.js'
import { createTaskCommandService } from '../team/task-command-service.js'
import { createTaskControlService } from '../team/task-control-service.js'
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
  db.prepare(`
    UPDATE sync_agent_binding
    SET is_listening = 1, listener_reported_at = ?, last_listener_at = ?
    WHERE task_space_id = ?
  `).run(now, now, first.taskSpace.id)
  const events = []
  const taskControlChanges = []
  const controlEvents = []
  const agents = createSyncAgentService({
    db,
    config: { agentStaleMs: 60_000 },
    events: { publishAgentRevoked() {} },
  })
  const taskControl = createTaskControlService({ db })
  const commands = createTaskCommandService({
    db,
    taskSpaces,
    agents,
    taskControl,
    events: {
      notifyCommandAvailable(agentId) {
        events.push(agentId)
      },
      notifyTaskControlChanged(taskSpaceId) {
        controlEvents.push(taskSpaceId)
      },
    },
    onTaskControlChanged({ taskSpaceId }) {
      taskControlChanges.push(taskSpaceId)
    },
  })
  return {
    db,
    taskSpaces,
    commands,
    taskControl,
    events,
    controlEvents,
    taskControlChanges,
    actor: taskSpaces.actorContext('user-a'),
    taskSpaceId: second.taskSpace.id,
    targetAgentId: 'agent-b',
    targetBindingId: second.binding.id,
  }
}

function insertIndexedTask(db, taskSpaceId, payload, revision = 1) {
  const timestamp = new Date().toISOString()
  db.prepare(`
    UPDATE sync_task_space
    SET revision = ?, indexed_revision = ?
    WHERE id = ?
  `).run(revision, revision, taskSpaceId)
  db.prepare(`
    INSERT INTO sync_task_index(
      task_space_id, project_id, task_key, execution_task_key, relative_dir,
      branch_name, title, search_text, archived, priority, derived_stage,
      assignee_dev_id, assignee_user_id, attention_flags_json, group_key,
      group_role, task_version, board_version, updated_at
    ) VALUES (?, (SELECT project_id FROM sync_task_space WHERE id = ?), ?, ?, ?,
      'main', ?, ?, 0, 'P2', 'planning',
      'bob', 'user-b', '[]', ?, 'single', ?, 'v1', ?)
  `).run(
    taskSpaceId,
    taskSpaceId,
    payload.taskKey,
    payload.executionTaskKey,
    payload.relativeDir,
    `任务 ${payload.taskId}`,
    `任务 ${payload.taskId}`,
    payload.taskKey,
    String(payload.taskVersion || 1),
    timestamp,
  )
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

test('目标 Agent 离线时仍生成命令和待交付任务', () => {
  const { db, commands, actor, taskSpaceId } = setup()
  try {
    db.prepare(
      "UPDATE agent_device SET last_seen_at = '2000-01-01T00:00:00.000Z' WHERE id = 'agent-b'",
    ).run()
    const queued = commands.enqueue(actor, createInput(taskSpaceId))
    assert.equal(queued.statusCode, 202)
    assert.equal(queued.operation.status, 'pending')
    assert.equal(queued.operation.targetUserId, 'user-b')
    assert.equal(queued.operation.agentId, null)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sync_task_command').get().count, 1)
    assert.equal(
      db
        .prepare('SELECT materialization_state FROM sync_task WHERE task_id = ?')
        .get('client-created').materialization_state,
      'pending',
    )
  } finally {
    db.close()
  }
})

test('任务空间没有在线监听时仍排队，恢复监听后绑定目标 Agent', () => {
  const { db, commands, actor, taskSpaceId } = setup()
  try {
    db.prepare(`
      UPDATE sync_agent_binding
      SET is_listening = 0, listener_reported_at = NULL, last_listener_at = NULL
    `).run()
    const queued = commands.enqueue(actor, createInput(taskSpaceId))
    assert.equal(queued.statusCode, 202)
    assert.equal(queued.operation.agentId, null)
    assert.deepEqual(commands.available('agent-b'), [])
    const now = new Date().toISOString()
    db.prepare(`
      UPDATE sync_agent_binding
      SET is_listening = 1, listener_reported_at = ?, last_listener_at = ?
      WHERE task_space_id = ?
    `).run(now, now, taskSpaceId)
    assert.equal(commands.available('agent-b')[0].id, queued.operation.id)
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
    assert.throws(
      () =>
        commands.enqueue(
          actor,
          createInput(taskSpaceId, {
            title: '重复任务',
            idempotencyKey: 'create-other',
          }),
        ),
      (error) => error.status === 409 && error.code === 'TASK_EXISTS',
    )
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sync_task_command').get().count, 1)

    const available = commands.available(targetAgentId)
    assert.equal(available.length, 1)
    assert.equal(available[0].bindingId, targetBindingId)
    assert.equal(available[0].type, 'create_task')
    assert.equal(available[0].payload.taskSpaceId, taskSpaceId)
    assert.equal(available[0].payload.assigneeDevId, 'bob')
    assert.equal(available[0].payload.executionTaskKey, first.operation.payload.executionTaskKey)
    assert.equal(available[0].payload.taskVersion, 1)

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

test('命令已入队后监听归零，相同请求仍返回幂等结果', () => {
  const { db, commands, actor, taskSpaceId } = setup()
  try {
    const first = commands.enqueue(actor, createInput(taskSpaceId))
    db.prepare(`
      UPDATE sync_agent_binding
      SET is_listening = 0, listener_reported_at = NULL
      WHERE task_space_id = ?
    `).run(taskSpaceId)
    const replay = commands.enqueue(actor, createInput(taskSpaceId))
    assert.equal(replay.idempotent, true)
    assert.equal(replay.operation.id, first.operation.id)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sync_task_command').get().count, 1)
  } finally {
    db.close()
  }
})

test('分支停止监听后 pending 命令不再投递，恢复监听后重新可见', () => {
  const { db, commands, actor, taskSpaceId, targetAgentId } = setup()
  try {
    const queued = commands.enqueue(actor, createInput(taskSpaceId))
    assert.equal(commands.available(targetAgentId).length, 1)
    db.prepare('UPDATE sync_agent_binding SET is_listening = 0 WHERE agent_id = ?').run(
      targetAgentId,
    )
    assert.deepEqual(commands.available(targetAgentId), [])
    const now = new Date().toISOString()
    db.prepare(`
      UPDATE sync_agent_binding
      SET is_listening = 1, listener_reported_at = ?, last_listener_at = ?
      WHERE agent_id = ?
    `).run(now, now, targetAgentId)
    assert.equal(commands.available(targetAgentId)[0].id, queued.operation.id)
  } finally {
    db.close()
  }
})

test('监听报告已过期时 pending 命令不会误投递', () => {
  const { db, commands, actor, taskSpaceId, targetAgentId } = setup()
  try {
    commands.enqueue(actor, createInput(taskSpaceId))
    db.prepare(`
      UPDATE sync_agent_binding
      SET is_listening = 1, listener_reported_at = '2000-01-01T00:00:00.000Z'
      WHERE agent_id = ?
    `).run(targetAgentId)
    assert.deepEqual(commands.available(targetAgentId), [])
    const now = new Date().toISOString()
    db.prepare(`
      UPDATE sync_agent_binding
      SET listener_reported_at = ?
      WHERE agent_id = ?
    `).run(now, targetAgentId)
    assert.equal(commands.available(targetAgentId).length, 1)
  } finally {
    db.close()
  }
})

test('创建命令拒绝路径穿越和归档目录', () => {
  const { db, commands, actor, taskSpaceId } = setup()
  try {
    for (const input of [
      createInput(taskSpaceId, { slug: '../escape', idempotencyKey: 'invalid-slug' }),
      createInput(taskSpaceId, {
        relativeDir: '.trellis/tasks/archive/2026-11/escape',
        idempotencyKey: 'invalid-archive',
      }),
      createInput(taskSpaceId, {
        relativeDir: '.trellis/tasks/..\\escape',
        idempotencyKey: 'invalid-backslash',
      }),
    ]) {
      assert.throws(
        () => commands.enqueue(actor, input),
        (error) => error.status === 400 && error.code === 'INVALID_INPUT',
      )
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sync_task_command').get().count, 0)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sync_task').get().count, 0)
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

    assert.equal(commands.available(targetAgentId).length, 1)
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
  const { db, taskSpaces, commands, actor, taskSpaceId, controlEvents, taskControlChanges } = setup()
  try {
    const queued = commands.enqueue(actor, createInput(taskSpaceId))
    const payload = queued.operation.payload
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
            taskId: payload.taskId,
            taskKey: payload.taskKey,
            executionTaskKey: payload.executionTaskKey,
            relativeDir: payload.relativeDir,
            revision: 1,
          },
        }),
      /尚未完成索引/,
    )
    insertIndexedTask(db, taskSpaceId, payload)
    assert.throws(
      () =>
        commands.complete({ id: 'agent-b', userId: 'user-b' }, queued.operation.id, {
          status: 'succeeded',
          result: {
            taskId: 'other-task',
            taskKey: payload.taskKey,
            executionTaskKey: payload.executionTaskKey,
            relativeDir: payload.relativeDir,
            revision: 1,
          },
        }),
      (error) => error.status === 409 && error.code === 'CONFLICT',
    )

    const completed = commands.complete({ id: 'agent-b', userId: 'user-b' }, queued.operation.id, {
      status: 'succeeded',
      result: {
        taskId: payload.taskId,
        taskKey: payload.taskKey,
        executionTaskKey: payload.executionTaskKey,
        relativeDir: payload.relativeDir,
        revision: 1,
      },
    })
    assert.equal(completed.operation.status, 'succeeded')
    assert.deepEqual(controlEvents, [taskSpaceId])
    assert.equal(taskControlChanges.at(-1), taskSpaceId)
    assert.equal(completed.task.materializationState, 'materialized')
    assert.equal(
      db
        .prepare('SELECT materialization_state FROM sync_task WHERE execution_task_key = ?')
        .get(payload.executionTaskKey).materialization_state,
      'materialized',
    )
    assert.notEqual(
      db
        .prepare('SELECT handoff_state FROM sync_task WHERE execution_task_key = ?')
        .get(payload.executionTaskKey).handoff_state,
      'source_cleanup_pending',
    )

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
    const listenerAt = new Date().toISOString()
    db.prepare(`
      UPDATE sync_agent_binding
      SET is_listening = 1, listener_reported_at = ?, last_listener_at = ?
      WHERE id = ?
    `).run(listenerAt, listenerAt, rebound.binding.id)
    const retried = commands.retry(actor, failed.operation.id)
    assert.equal(retried.operation.status, 'pending')
    assert.equal(retried.operation.agentId, 'agent-b2')
    assert.equal(retried.operation.bindingId, rebound.binding.id)
  } finally {
    db.close()
  }
})

test('命令成功状态与权威任务 materialization 在同一事务提交', () => {
  const { db, commands, taskControl, actor, taskSpaceId } = setup()
  try {
    const queued = commands.enqueue(actor, createInput(taskSpaceId))
    const payload = queued.operation.payload
    commands.markDelivered('agent-b', queued.operation.id)
    assert.equal(commands.start('agent-b', queued.operation.id).execute, true)
    insertIndexedTask(db, taskSpaceId, payload)

    const originalCompleteCommand = taskControl.completeCommand
    taskControl.completeCommand = () => {
      throw new Error('authoritative task update failed')
    }
    assert.throws(
      () =>
        commands.complete({ id: 'agent-b', userId: 'user-b' }, queued.operation.id, {
          status: 'succeeded',
          result: {
            taskId: payload.taskId,
            taskKey: payload.taskKey,
            executionTaskKey: payload.executionTaskKey,
            relativeDir: payload.relativeDir,
            revision: 1,
          },
        }),
      /authoritative task update failed/,
    )
    taskControl.completeCommand = originalCompleteCommand

    assert.equal(
      db.prepare('SELECT status FROM sync_task_command WHERE id = ?').get(queued.operation.id)
        .status,
      'running',
    )
    assert.equal(
      db
        .prepare('SELECT materialization_state FROM sync_task WHERE execution_task_key = ?')
        .get(payload.executionTaskKey).materialization_state,
      'pending',
    )
  } finally {
    db.close()
  }
})
