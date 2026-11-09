import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDatabase, withTransaction } from '../server/database.js'
import {
  appendTaskEvent,
  createExecutionStore,
  readExecutionDetail,
  readTaskDependencies,
} from '../server/execution-store.js'
import { buildTaskHistory, undoLastOperation } from '../server/execution-history.js'
import { setManualStage } from '../server/metadata.js'

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-history-'))
  const dataDir = path.join(root, 'data')
  return {
    root,
    databaseFile: path.join(dataDir, 'board.sqlite'),
    legacyFiles: {
      repositoriesFile: path.join(dataDir, 'repos.json'),
      metadataFile: path.join(dataDir, 'task-metadata.json'),
      scanCacheFile: path.join(dataDir, 'scan-cache.json'),
      stateFile: path.join(dataDir, 'board-state.json'),
    },
  }
}

function openTestDatabase(workspace) {
  return openDatabase({
    databaseFile: workspace.databaseFile,
    legacyFiles: workspace.legacyFiles,
    fallbackRepositories: [],
    logger: { warn() {} },
  })
}

function createStore(db) {
  return createExecutionStore({
    db,
    stageIds: ['prd', 'design', 'implement', 'check'],
  })
}

function closeQuietly(db) {
  try {
    db?.close()
  } catch {
    // 数据库可能已在失败路径关闭。
  }
}

function taskFor(executionTaskKey, overrides = {}) {
  return {
    executionTaskKey,
    archived: false,
    executionIdentityValid: true,
    executionIdentityConflict: false,
    ...overrides,
  }
}

test('计划撤销恢复 before、保留原始事件，并拒绝重复撤销同一组', () => {
  const workspace = makeWorkspace()
  let db
  try {
    db = openTestDatabase(workspace)
    const store = createStore(db)
    const updated = store.updatePlan(
      'demo::task',
      {
        dueDate: '2026-11-03',
        milestone: 'MVP',
        tags: ['后端', '复盘'],
      },
      'dev',
    )

    const history = buildTaskHistory({
      db,
      executionTaskKey: 'demo::task',
      archived: false,
      identityValid: true,
    })
    assert.equal(history.undo.available, true)
    assert.equal(history.undo.targetCorrelationId, updated.correlationId)
    assert.deepEqual(history.undo.targetEventIds, [history.events[0].id])

    const undone = undoLastOperation({
      db,
      executionTaskKey: 'demo::task',
      projectId: 'demo',
      taskPath: '.trellis/tasks/task',
      task: taskFor('demo::task'),
      actor: 'dev',
      now: '2099-01-01T08:00:00.000Z',
    })
    assert.equal(undone.targetCorrelationId, updated.correlationId)
    const detail = readExecutionDetail(db, 'demo::task')
    assert.equal(detail.dueDate, null)
    assert.equal(detail.milestone, '')
    assert.deepEqual(detail.tags, [])
    assert.equal(detail.eventTotal, 2)
    assert.equal(detail.events[0].type, 'operation_undone')
    assert.equal(detail.events[0].payload.targetCorrelationId, updated.correlationId)
    assert.equal(
      detail.events.some(
        (event) =>
          event.correlationId === updated.correlationId && event.type === 'task_plan_updated',
      ),
      true,
    )

    assert.throws(
      () =>
        undoLastOperation({
          db,
          executionTaskKey: 'demo::task',
          projectId: 'demo',
          taskPath: '.trellis/tasks/task',
          task: taskFor('demo::task'),
          actor: 'dev',
          now: '2099-01-01T08:01:00.000Z',
        }),
      /没有尚未撤销的可逆操作/,
    )
    assert.equal(readExecutionDetail(db, 'demo::task').eventTotal, 2)
  } finally {
    closeQuietly(db)
    fs.rmSync(workspace.root, { recursive: true, force: true })
  }
})

test('团队撤销只选择当前账号自己的历史组', () => {
  const workspace = makeWorkspace()
  let db
  try {
    db = openTestDatabase(workspace)
    const now = new Date().toISOString()
    const insertUser = db.prepare(`
      INSERT INTO user_account(
        id, username_key, username, display_name, password_hash,
        password_params_json, system_admin, status, must_change_password,
        password_changed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'test', '{}', 0, 'active', 0, ?, ?, ?)
    `)
    insertUser.run('user-a', 'user-a', 'user-a', '用户 A', now, now, now)
    insertUser.run('user-b', 'user-b', 'user-b', '用户 B', now, now, now)
    const store = createStore(db)
    const userBPlan = store.updatePlan(
      'demo::task',
      {
        dueDate: '2026-12-01',
        milestone: 'B',
        tags: ['B'],
      },
      'user-b',
      'user-b',
    )
    const userAPlan = store.updatePlan(
      'demo::task',
      {
        dueDate: '2026-11-20',
        milestone: 'A',
        tags: ['A'],
      },
      'user-a',
      'user-a',
    )

    const historyA = buildTaskHistory({
      db,
      executionTaskKey: 'demo::task',
      archived: false,
      identityValid: true,
      actorUserId: 'user-a',
    })
    assert.equal(historyA.undo.available, true)
    assert.equal(historyA.undo.targetCorrelationId, userAPlan.correlationId)
    assert.notEqual(historyA.undo.targetCorrelationId, userBPlan.correlationId)
    assert.deepEqual([...new Set(historyA.events.map((event) => event.actorUserId))].sort(), [
      'user-a',
      'user-b',
    ])

    undoLastOperation({
      db,
      executionTaskKey: 'demo::task',
      projectId: 'demo',
      taskPath: '.trellis/tasks/task',
      task: taskFor('demo::task'),
      actor: 'user-a',
      actorUserId: 'user-a',
      now: '2099-01-01T09:00:00.000Z',
    })
    const detail = readExecutionDetail(db, 'demo::task')
    assert.equal(detail.dueDate, '2026-12-01')
    assert.equal(detail.milestone, 'B')
    assert.deepEqual(detail.tags, ['B'])
    assert.equal(
      detail.events.find((event) => event.type === 'operation_undone').actorUserId,
      'user-a',
    )
  } finally {
    closeQuietly(db)
    fs.rmSync(workspace.root, { recursive: true, force: true })
  }
})

test('人工阶段撤销恢复前值，首次确认撤销会删除投影', () => {
  const workspace = makeWorkspace()
  let db
  try {
    db = openTestDatabase(workspace)
    const taskPath = '.trellis/tasks/stage-task'
    const taskKey = `demo/${taskPath}`
    const first = setManualStage('demo', taskPath, 'design', db, {
      executionTaskKey: 'demo::stage-task',
      actor: 'dev',
    })
    const second = setManualStage('demo', taskPath, 'implement', db, {
      executionTaskKey: 'demo::stage-task',
      actor: 'dev',
    })

    undoLastOperation({
      db,
      executionTaskKey: 'demo::stage-task',
      projectId: 'demo',
      taskPath,
      task: taskFor('demo::stage-task'),
      actor: 'dev',
      now: '2099-01-01T08:00:00.000Z',
    })
    let row = db.prepare('SELECT stage, updated_at FROM task_stage WHERE task_key = ?').get(taskKey)
    assert.equal(row.stage, 'design')
    assert.equal(row.updated_at, first.updatedAt)
    assert.equal(second.stage, 'implement')

    undoLastOperation({
      db,
      executionTaskKey: 'demo::stage-task',
      projectId: 'demo',
      taskPath,
      task: taskFor('demo::stage-task'),
      actor: 'dev',
      now: '2099-01-01T08:01:00.000Z',
    })
    row = db.prepare('SELECT stage, updated_at FROM task_stage WHERE task_key = ?').get(taskKey)
    assert.equal(row, undefined)
    assert.equal(readExecutionDetail(db, 'demo::stage-task').eventTotal, 4)
    assert.throws(
      () =>
        undoLastOperation({
          db,
          executionTaskKey: 'demo::stage-task',
          projectId: 'demo',
          taskPath,
          task: taskFor('demo::stage-task'),
        }),
      /没有尚未撤销的可逆操作/,
    )
  } finally {
    closeQuietly(db)
    fs.rmSync(workspace.root, { recursive: true, force: true })
  }
})

test('依赖创建与解除撤销恢复活动性且保留历史行', () => {
  const workspace = makeWorkspace()
  let db
  try {
    db = openTestDatabase(workspace)
    const store = createStore(db)
    const created = store.createDependency(
      {
        blockerTaskKey: 'demo::blocker',
        blockedTaskKey: 'demo::blocked',
        reason: '等待接口冻结',
      },
      'dev',
    )
    const createdEvent = readExecutionDetail(db, 'demo::blocked').events[0]
    assert.equal(createdEvent.type, 'dependency_created')
    assert.equal(createdEvent.reversible, true)

    undoLastOperation({
      db,
      executionTaskKey: 'demo::blocked',
      projectId: 'demo',
      taskPath: '.trellis/tasks/blocked',
      task: taskFor('demo::blocked'),
      actor: 'dev',
      now: '2099-01-01T08:00:00.000Z',
    })
    let dependency = readTaskDependencies(db).find((item) => item.id === created.id)
    assert.equal(dependency.resolvedAt, '2099-01-01T08:00:00.000Z')

    const recreated = store.createDependency(
      {
        blockerTaskKey: 'demo::blocker',
        blockedTaskKey: 'demo::blocked',
        reason: '再次等待接口冻结',
      },
      'dev',
    )
    store.resolveDependency(recreated.id, 'dev')
    undoLastOperation({
      db,
      executionTaskKey: 'demo::blocked',
      projectId: 'demo',
      taskPath: '.trellis/tasks/blocked',
      task: taskFor('demo::blocked'),
      actor: 'dev',
      now: '2099-01-01T08:02:00.000Z',
    })
    dependency = readTaskDependencies(db).find((item) => item.id === recreated.id)
    assert.equal(dependency.resolvedAt, null)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM task_dependency').get().count, 2)
  } finally {
    closeQuietly(db)
    fs.rmSync(workspace.root, { recursive: true, force: true })
  }
})

test('after-state 已被后续修改时拒绝撤销且不写补偿事件', () => {
  const workspace = makeWorkspace()
  let db
  try {
    db = openTestDatabase(workspace)
    const taskPath = '.trellis/tasks/changed'
    const taskKey = `demo/${taskPath}`
    setManualStage('demo', taskPath, 'implement', db, {
      executionTaskKey: 'demo::changed',
      actor: 'dev',
    })
    db.prepare(`
      UPDATE task_stage
      SET stage = 'check', updated_at = '2026-10-30T07:59:00.000Z'
      WHERE task_key = ?
    `).run(taskKey)
    const before = readExecutionDetail(db, 'demo::changed')

    assert.throws(
      () =>
        undoLastOperation({
          db,
          executionTaskKey: 'demo::changed',
          projectId: 'demo',
          taskPath,
          task: taskFor('demo::changed'),
          actor: 'dev',
          now: '2099-01-01T08:00:00.000Z',
        }),
      /后续操作已改变当前值/,
    )
    const after = readExecutionDetail(db, 'demo::changed')
    assert.equal(after.eventTotal, before.eventTotal)
    assert.equal(
      db.prepare('SELECT stage FROM task_stage WHERE task_key = ?').get(taskKey).stage,
      'check',
    )
  } finally {
    closeQuietly(db)
    fs.rmSync(workspace.root, { recursive: true, force: true })
  }
})

test('补偿事件写入失败时计划和原事件整体回滚', () => {
  const workspace = makeWorkspace()
  let db
  try {
    db = openTestDatabase(workspace)
    const store = createStore(db)
    store.updatePlan(
      'demo::rollback',
      {
        dueDate: '2026-12-01',
        milestone: 'Rollback',
        tags: ['事务'],
      },
      'dev',
    )
    db.exec(`
      CREATE TRIGGER reject_operation_undone
      BEFORE INSERT ON task_event
      WHEN NEW.event_type = 'operation_undone'
      BEGIN
        SELECT RAISE(ABORT, 'forced undo failure');
      END;
    `)
    assert.throws(
      () =>
        undoLastOperation({
          db,
          executionTaskKey: 'demo::rollback',
          projectId: 'demo',
          taskPath: '.trellis/tasks/rollback',
          task: taskFor('demo::rollback'),
          actor: 'dev',
          now: '2099-01-01T08:00:00.000Z',
        }),
      /forced undo failure/,
    )
    const detail = readExecutionDetail(db, 'demo::rollback')
    assert.equal(detail.dueDate, '2026-12-01')
    assert.equal(detail.milestone, 'Rollback')
    assert.deepEqual(detail.tags, ['事务'])
    assert.equal(detail.eventTotal, 1)
    assert.equal(detail.events[0].type, 'task_plan_updated')
  } finally {
    closeQuietly(db)
    fs.rmSync(workspace.root, { recursive: true, force: true })
  }
})

test('截断仅在无法确认候选时禁用撤销，归档和身份冲突始终禁用', () => {
  const workspace = makeWorkspace()
  let db
  try {
    db = openTestDatabase(workspace)
    const start = Date.parse('2026-10-30T00:00:00.000Z')
    withTransaction(db, () => {
      appendTaskEvent(db, {
        executionTaskKey: 'demo::window',
        eventType: 'task_plan_updated',
        source: 'user',
        actor: 'dev',
        correlationId: 'older-plan',
        occurredAt: '2026-10-29T23:00:00.000Z',
        payload: {
          before: { dueDate: null, milestone: '', tags: [] },
          after: { dueDate: '2026-11-01', milestone: 'Older', tags: [] },
        },
        reversible: true,
      })
      for (let index = 0; index < 1000; index += 1) {
        appendTaskEvent(db, {
          executionTaskKey: 'demo::window',
          eventType: 'stage_observed',
          source: 'scan',
          actor: 'system',
          correlationId: `window-${index}`,
          occurredAt: new Date(start + index * 1000).toISOString(),
          payload: {
            after: { derivedStage: index % 2 ? 'check' : 'implement' },
          },
        })
      }
    })
    const before = readExecutionDetail(db, 'demo::window', 1000)
    assert.equal(before.eventTotal, 1001)
    assert.equal(before.eventTruncated, true)
    const history = buildTaskHistory({
      db,
      executionTaskKey: 'demo::window',
      archived: false,
      identityValid: true,
    })
    assert.equal(history.undo.available, false)
    assert.match(history.undo.disabledReason, /无法确认更早的可逆操作/)
    assert.throws(
      () =>
        undoLastOperation({
          db,
          executionTaskKey: 'demo::window',
          projectId: 'demo',
          taskPath: '.trellis/tasks/window',
          task: taskFor('demo::window'),
          actor: 'dev',
          now: '2099-01-01T08:00:00.000Z',
        }),
      /无法确认更早的可逆操作/,
    )
    assert.equal(readExecutionDetail(db, 'demo::window', 1000).eventTotal, 1001)

    withTransaction(db, () => {
      db.prepare(`
        INSERT INTO task_execution(
          execution_task_key, due_date, milestone, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        'demo::window',
        '2026-12-02',
        'Window',
        '2026-10-30T03:00:00.000Z',
        '2026-10-30T03:00:00.000Z',
      )
      appendTaskEvent(db, {
        executionTaskKey: 'demo::window',
        eventType: 'task_plan_updated',
        source: 'user',
        actor: 'dev',
        correlationId: 'latest-plan',
        occurredAt: '2026-10-30T03:00:00.000Z',
        payload: {
          before: { dueDate: '2026-11-01', milestone: 'Older', tags: [] },
          after: { dueDate: '2026-12-02', milestone: 'Window', tags: [] },
        },
        reversible: true,
      })
    })
    const confirmable = buildTaskHistory({
      db,
      executionTaskKey: 'demo::window',
      archived: false,
      identityValid: true,
    })
    assert.equal(confirmable.truncated, true)
    assert.equal(confirmable.undo.available, true)
    assert.equal(confirmable.undo.targetCorrelationId, 'latest-plan')
    undoLastOperation({
      db,
      executionTaskKey: 'demo::window',
      projectId: 'demo',
      taskPath: '.trellis/tasks/window',
      task: taskFor('demo::window'),
      actor: 'dev',
      now: '2099-01-01T08:00:00.000Z',
    })
    assert.equal(
      db
        .prepare(`
        SELECT due_date FROM task_execution WHERE execution_task_key = ?
      `)
        .get('demo::window').due_date,
      '2026-11-01',
    )
    assert.equal(readExecutionDetail(db, 'demo::window', 1000).eventTotal, 1003)

    assert.throws(
      () =>
        undoLastOperation({
          db,
          executionTaskKey: 'demo::window',
          projectId: 'demo',
          taskPath: '.trellis/tasks/window',
          task: taskFor('demo::window', { archived: true }),
        }),
      /归档任务只读/,
    )
    assert.throws(
      () =>
        undoLastOperation({
          db,
          executionTaskKey: 'demo::window',
          projectId: 'demo',
          taskPath: '.trellis/tasks/window',
          task: taskFor('demo::window', {
            executionIdentityValid: false,
            executionIdentityConflict: true,
          }),
        }),
      /身份冲突/,
    )
  } finally {
    closeQuietly(db)
    fs.rmSync(workspace.root, { recursive: true, force: true })
  }
})
