import assert from 'node:assert/strict'
import test from 'node:test'
import { openDatabase } from '../database.js'
import { snapshotSha256 } from '@trellis-board/shared/task-snapshot.js'
import { createSyncAgentService } from '../team/sync-agent-service.js'
import { createTaskCommandService } from '../team/task-command-service.js'
import { createTaskControlService } from '../team/task-control-service.js'
import { createTaskSnapshotService } from '../team/task-snapshot-service.js'
import { createTaskSpaceService } from '../team/task-space-service.js'

function insertUser(db, id, displayName) {
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO user_account(
      id, username_key, username, display_name, password_hash, password_params_json,
      system_admin, status, must_change_password, password_changed_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'x', '{}', 0, 'active', 0, ?, ?, ?)
  `).run(id, id, id, displayName, now, now, now)
  db.prepare(`
    INSERT INTO team_member(team_id, user_id, role, created_at, updated_at)
    VALUES ('team-1', ?, 'member', ?, ?)
  `).run(id, now, now)
}

function insertAgent(db, id, userId) {
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO agent_device(
      id, user_id, device_name, platform, agent_version, protocol_version,
      credential_hash, status, last_seen_at, created_at
    ) VALUES (?, ?, ?, 'win32', '0.1.0', 3, ?, 'active', ?, ?)
  `).run(id, userId, id, `${id}-credential`, now, now)
  db.prepare(`
    INSERT INTO sync_active_agent(user_id, agent_id, updated_at)
    VALUES (?, ?, ?)
  `).run(userId, id, now)
}

function setup(clock = () => new Date()) {
  const db = openDatabase({
    databaseFile: ':memory:',
    fallbackRepositories: [],
    importLegacyRepositories: false,
    legacyJsonImport: false,
  })
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO team(id, name, slug, status, created_at, updated_at)
    VALUES ('team-1', '团队', 'team-1', 'active', ?, ?)
  `).run(now, now)
  insertUser(db, 'user-a', '创建人')
  insertUser(db, 'user-b', '执行人')
  insertAgent(db, 'agent-a', 'user-a')
  insertAgent(db, 'agent-b', 'user-b')
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
    developerId: 'bob',
    localRepoKey: 'b'.repeat(64),
  })
  db.prepare(`
    UPDATE sync_agent_binding
    SET is_listening = 1, listener_reported_at = ?, last_listener_at = ?
    WHERE task_space_id = ?
  `).run(now, now, second.taskSpace.id)
  const agents = createSyncAgentService({
    db,
    config: { agentStaleMs: 60_000 },
    events: { publishAgentRevoked() {} },
  })
  const taskControl = createTaskControlService({ db, now: clock })
  const snapshots = createTaskSnapshotService({ db, taskSpaces, taskControl, now: clock })
  const commands = createTaskCommandService({
    db,
    taskSpaces,
    agents,
    taskControl,
  })
  return {
    db,
    taskSpaces,
    agents,
    taskControl,
    snapshots,
    commands,
    agentA: { id: 'agent-a', userId: 'user-a' },
    agentB: { id: 'agent-b', userId: 'user-b' },
    actor: taskSpaces.actorContext('user-a'),
    taskSpaceId: second.taskSpace.id,
  }
}

function taskFiles(taskId, title, assignee = 'alice') {
  return taskFilesAt(`.trellis/tasks/11-17-${taskId}`, taskId, title, assignee)
}

function taskFilesAt(taskDir, taskId, title, assignee = 'alice') {
  return [
    {
      path: `${taskDir}/task.json`,
      content: JSON.stringify({
        id: taskId,
        title,
        description: `${title} 描述`,
        priority: 'P1',
        branch: 'main',
        creator: 'forged-creator',
        assignee,
      }),
    },
    {
      path: `${taskDir}/prd.md`,
      content: `# ${title}\n`,
    },
  ].map((file) => ({ ...file, sha256: snapshotSha256(file.content) }))
}

function syncTaskRow(db, executionTaskKey) {
  return db.prepare('SELECT * FROM sync_task WHERE execution_task_key = ?').get(executionTaskKey)
}

function tickingClock(start) {
  const base = Date.parse(start)
  let offset = 0
  return () => new Date(base + offset++)
}

test('控制信息不截断超过 200 个本人任务', () => {
  const { db, taskControl, agentB, taskSpaceId } = setup()
  try {
    const projectId = db
      .prepare('SELECT project_id FROM sync_task_space WHERE id = ?')
      .get(taskSpaceId).project_id
    const timestamp = new Date().toISOString()
    const insert = db.prepare(`
      INSERT INTO sync_task(
        execution_task_key, task_key, task_space_id, project_id, task_id,
        relative_dir, title, priority, created_by_user_id, assignee_user_id,
        assignee_dev_id, stage, materialization_state, task_version, handoff_state,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'P2', 'user-a', 'user-b', 'bob',
        'planning', 'materialized', 1, 'none', ?, ?)
    `)
    for (let index = 0; index < 205; index += 1) {
      const id = `bulk-${String(index).padStart(3, '0')}`
      insert.run(
        `${taskSpaceId}::${id}`,
        `${taskSpaceId}::.trellis/tasks/${id}`,
        taskSpaceId,
        projectId,
        id,
        `.trellis/tasks/${id}`,
        `批量任务 ${index}`,
        timestamp,
        timestamp,
      )
    }

    assert.equal(taskControl.controlsForAgent(agentB, taskSpaceId).length, 205)
  } finally {
    db.close()
  }
})

test('首次上传以认证用户建立权威任务，其他用户不能读取或覆盖正文', () => {
  const { db, taskControl, snapshots, agentA, agentB, taskSpaceId } = setup()
  try {
    const files = taskFiles('task-a', '任务 A')
    const applied = snapshots.applyChanges(agentA, taskSpaceId, {
      batchId: 'batch-a-1',
      clientSequence: 1,
      files,
    })
    assert.equal(applied.revision, 1)
    assert.ok(applied.taskVersion)

    const task = db
      .prepare('SELECT * FROM sync_task WHERE execution_task_key = ?')
      .get(`${taskSpaceId}::task-a`)
    assert.equal(task.created_by_user_id, 'user-a')
    assert.equal(task.assignee_user_id, 'user-a')
    assert.equal(task.materialization_state, 'materialized')
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM sync_task_lease WHERE status = 'active'").get()
        .count,
      1,
    )

    assert.equal(snapshots.snapshot(agentA, taskSpaceId).files.length, 2)
    assert.equal(
      snapshots
        .snapshot(agentA, taskSpaceId)
        .controls.find((control) => control.executionTaskKey === `${taskSpaceId}::task-a`).state,
      'materialized',
    )
    assert.equal(snapshots.snapshot(agentB, taskSpaceId).files.length, 0)
    assert.throws(
      () => snapshots.directorySnapshot(agentB, taskSpaceId, '.trellis/tasks/11-17-task-a'),
      (error) => error.code === 'FORBIDDEN',
    )

    const base = files.map((file) => ({ ...file, baseSha256: file.sha256 }))
    assert.throws(
      () =>
        snapshots.applyChanges(agentB, taskSpaceId, {
          batchId: 'batch-b-1',
          clientSequence: 1,
          files: base,
        }),
      (error) => error.status === 409 && error.code === 'TASK_WRITE_FORBIDDEN',
    )
    assert.equal(
      db
        .prepare('SELECT task_version FROM sync_task WHERE execution_task_key = ?')
        .get(`${taskSpaceId}::task-a`).task_version,
      1,
    )
  } finally {
    db.close()
  }
})

test('目标用户离线时命令和待交付任务仍持久化，上线后按本人绑定领取', () => {
  const { db, commands, snapshots, agentB, actor, taskSpaceId } = setup()
  try {
    db.prepare(`
      UPDATE sync_agent_binding
      SET is_listening = 0, listener_reported_at = NULL, last_listener_at = NULL
    `).run()
    db.prepare(`
      UPDATE agent_device SET last_seen_at = '2000-01-01T00:00:00.000Z'
      WHERE id = 'agent-b'
    `).run()

    const queued = commands.enqueue(actor, {
      commandType: 'create_task',
      taskSpaceId,
      assigneeUserId: 'user-b',
      title: '离线任务',
      description: '目标客户端稍后领取',
      priority: 'P1',
      slug: 'offline-task',
      idempotencyKey: 'offline-create-1',
    })
    assert.equal(queued.statusCode, 202)
    assert.equal(queued.operation.targetUserId, 'user-b')
    assert.equal(queued.operation.agentId, null)
    assert.equal(
      db
        .prepare('SELECT materialization_state FROM sync_task WHERE task_id = ?')
        .get('offline-task').materialization_state,
      'pending',
    )
    assert.equal(
      snapshots
        .snapshot(agentB, taskSpaceId)
        .controls.find((control) => control.taskId === 'offline-task').state,
      'pending_delivery',
    )
    assert.deepEqual(commands.available('agent-b'), [])

    const now = new Date().toISOString()
    db.prepare(`
      UPDATE sync_agent_binding
      SET is_listening = 1, listener_reported_at = ?, last_listener_at = ?
      WHERE task_space_id = ?
    `).run(now, now, taskSpaceId)
    db.prepare('UPDATE agent_device SET last_seen_at = ? WHERE id = ?').run(now, 'agent-b')
    const available = commands.available(agentB.id)
    assert.equal(available.length, 1)
    assert.equal(available[0].id, queued.operation.id)
    assert.equal(available[0].payload.assigneeDevId, 'bob')
  } finally {
    db.close()
  }
})

test('归档投影生成控制墓碑并拒绝旧的本地活动副本写回', () => {
  const { db, taskControl, snapshots, agentA, taskSpaceId } = setup()
  try {
    const files = taskFiles('task-archive', '待归档任务')
    snapshots.applyChanges(agentA, taskSpaceId, {
      batchId: 'batch-archive-1',
      clientSequence: 1,
      files,
    })
    const task = db
      .prepare('SELECT * FROM sync_task WHERE execution_task_key = ?')
      .get(`${taskSpaceId}::task-archive`)
    taskControl.reconcileProjection({
      taskSpaceId,
      projectId: task.project_id,
      tasks: [
        {
          taskKey: `${taskSpaceId}::.trellis/tasks/archive/2026-11/11-17-task-archive`,
          executionTaskKey: task.execution_task_key,
          relativeDir: '.trellis/tasks/archive/2026-11/11-17-task-archive',
          title: task.title,
          priority: task.priority,
          derivedStage: 'archive',
          archived: true,
          archivedAt: new Date().toISOString(),
        },
      ],
    })

    assert.equal(
      db
        .prepare('SELECT archived FROM sync_task WHERE execution_task_key = ?')
        .get(task.execution_task_key).archived,
      1,
    )
    assert.equal(snapshots.snapshot(agentA, taskSpaceId).files.length, 0)
    assert.equal(
      snapshots
        .snapshot(agentA, taskSpaceId)
        .controls.find((control) => control.executionTaskKey === task.execution_task_key).state,
      'archived',
    )

    assert.throws(
      () =>
        snapshots.applyChanges(agentA, taskSpaceId, {
          batchId: 'batch-archive-2',
          clientSequence: 2,
          files: files.map((file) => ({ ...file, baseSha256: file.sha256 })),
        }),
      (error) => error.status === 409 && error.code === 'TASK_ARCHIVED',
    )
  } finally {
    db.close()
  }
})

test('已有任务上传保留服务端负责人，并拒绝缺失或过期 fencing', () => {
  const { db, taskControl, snapshots, agentA, taskSpaceId } = setup()
  try {
    const taskDir = '.trellis/tasks/11-17-task-owned'
    const initial = taskFiles('task-owned', '权威任务')
    snapshots.applyChanges(agentA, taskSpaceId, {
      batchId: 'batch-owned-1',
      clientSequence: 1,
      files: initial,
    })

    const current = snapshots.directorySnapshot(agentA, taskSpaceId, taskDir)
    const changed = current.files.map((file) => {
      if (!file.path.endsWith('/task.json')) return { ...file, baseSha256: file.sha256 }
      const task = JSON.parse(file.content)
      task.assignee = 'bob'
      const content = JSON.stringify(task)
      return { ...file, content, sha256: snapshotSha256(content), baseSha256: file.sha256 }
    })
    const claimed = taskControl.claim(agentA, taskSpaceId, `${taskSpaceId}::task-owned`)
    snapshots.applyChanges(agentA, taskSpaceId, {
      batchId: 'batch-owned-2',
      clientSequence: 2,
      files: changed,
      taskVersion: 1,
      leaseToken: claimed.lease.token,
    })
    const row = db
      .prepare('SELECT * FROM sync_task WHERE execution_task_key = ?')
      .get(`${taskSpaceId}::task-owned`)
    assert.equal(row.assignee_user_id, 'user-a')
    assert.equal(row.assignee_dev_id, 'alice')

    assert.throws(
      () =>
        snapshots.applyChanges(agentA, taskSpaceId, {
          batchId: 'batch-owned-missing',
          clientSequence: 3,
          files: changed,
        }),
      (error) => error.status === 409 && error.code === 'TASK_VERSION_REQUIRED',
    )

    assert.throws(
      () =>
        snapshots.applyChanges(agentA, taskSpaceId, {
          batchId: 'batch-owned-no-lease',
          clientSequence: 4,
          files: changed,
          taskVersion: 2,
        }),
      (error) => error.status === 409 && error.code === 'TASK_LEASE_REQUIRED',
    )

    assert.throws(
      () =>
        snapshots.applyChanges(agentA, taskSpaceId, {
          batchId: 'batch-owned-stale',
          clientSequence: 5,
          files: changed,
          taskVersion: 1,
          leaseToken: claimed.lease.token,
        }),
      (error) => error.status === 409 && error.code === 'TASK_VERSION_STALE',
    )
  } finally {
    db.close()
  }
})

test('删除活动目录墓碑保留权威元数据并携带 fencing', () => {
  const { db, snapshots, agentA, taskSpaceId } = setup()
  try {
    const files = taskFiles('task-delete', '待移动归档任务')
    const initial = snapshots.applyChanges(agentA, taskSpaceId, {
      batchId: 'batch-delete-1',
      clientSequence: 1,
      files,
    })
    const taskVersion = initial.control.task.taskVersion
    const leaseToken = initial.control.lease.token
    const deletions = files.map((file) => ({
      path: file.path,
      content: '',
      sha256: snapshotSha256(''),
      baseSha256: file.sha256,
      deleted: true,
    }))

    const deleted = snapshots.applyChanges(agentA, taskSpaceId, {
      batchId: 'batch-delete-2',
      clientSequence: 2,
      files: deletions,
      taskVersion,
      leaseToken,
    })
    assert.equal(deleted.revision, 2)
    const task = db
      .prepare('SELECT * FROM sync_task WHERE execution_task_key = ?')
      .get(`${taskSpaceId}::task-delete`)
    assert.equal(task.title, '待移动归档任务')
    assert.equal(task.description, '待移动归档任务 描述')
    assert.equal(task.stage, 'planning')
  } finally {
    db.close()
  }
})

test('handoff ACK 仅允许创建者，重复提交幂等且审计脱敏', () => {
  const { db, taskControl, snapshots, agentA, agentB, taskSpaceId } = setup()
  try {
    const files = taskFiles('task-handoff', '已认领任务')
    snapshots.applyChanges(agentA, taskSpaceId, {
      batchId: 'batch-handoff-1',
      clientSequence: 1,
      files,
    })
    const executionTaskKey = `${taskSpaceId}::task-handoff`
    const timestamp = new Date().toISOString()
    db.prepare(`
      UPDATE sync_task
      SET assignee_user_id = 'user-b', assignee_dev_id = 'bob',
          previous_assignee_user_id = 'user-a', materialization_state = 'materialized',
          materialized_at = ?, materialized_revision = 1,
          handoff_state = 'source_cleanup_pending', updated_at = ?
      WHERE execution_task_key = ?
    `).run(timestamp, timestamp, executionTaskKey)

    const creatorControl = taskControl
      .controlsForAgent(agentA, taskSpaceId)
      .find((control) => control.executionTaskKey === executionTaskKey)
    assert.equal(creatorControl.state, 'handoff_materialized')
    assert.equal(creatorControl.handoffState, 'source_cleanup_pending')

    assert.throws(
      () =>
        taskControl.ackHandoff(agentB, taskSpaceId, executionTaskKey, {
          outcome: 'conflict',
          reason: 'git_tracked',
        }),
      (error) => error.status === 403 && error.code === 'FORBIDDEN',
    )

    const cleaned = taskControl.ackHandoff(agentA, taskSpaceId, executionTaskKey, {
      outcome: 'cleaned',
      backupId: 'handoff-0123456789abcdef',
      manifestSha256: 'b'.repeat(64),
      fileCount: 2,
      totalBytes: 256,
    })
    assert.equal(cleaned.handoffState, 'completed')
    assert.equal(cleaned.idempotent, false)
    assert.equal(
      taskControl.ackHandoff(agentA, taskSpaceId, executionTaskKey, {
        outcome: 'cleaned',
        backupId: 'handoff-0123456789abcdef',
        manifestSha256: 'b'.repeat(64),
        fileCount: 2,
        totalBytes: 256,
      }).idempotent,
      true,
    )
    assert.throws(
      () =>
        taskControl.ackHandoff(agentA, taskSpaceId, executionTaskKey, {
          outcome: 'cleaned',
          backupId: 'handoff-fedcba9876543210',
          manifestSha256: 'c'.repeat(64),
          fileCount: 2,
          totalBytes: 256,
        }),
      (error) => error.status === 409 && error.code === 'HANDOFF_ACK_MISMATCH',
    )

    db.prepare(`
      UPDATE sync_task SET handoff_state = 'source_cleanup_pending'
      WHERE execution_task_key = ?
    `).run(executionTaskKey)
    const conflict = taskControl.ackHandoff(agentA, taskSpaceId, executionTaskKey, {
      outcome: 'conflict',
      reason: 'git_tracked',
      fileCount: 2,
      totalBytes: 256,
    })
    assert.equal(conflict.handoffState, 'source_cleanup_conflict')
    assert.equal(
      taskControl.ackHandoff(agentA, taskSpaceId, executionTaskKey, {
        outcome: 'conflict',
        reason: 'git_tracked',
        fileCount: 2,
        totalBytes: 256,
      }).idempotent,
      true,
    )
    const audits = db
      .prepare("SELECT * FROM audit_event WHERE action = 'task_handoff_cleanup_ack' ORDER BY id")
      .all()
    assert.equal(audits.length, 2)
    assert.equal(JSON.parse(audits[0].detail_json).outcome, 'cleaned')
    assert.equal(JSON.parse(audits[1].detail_json).reason, 'git_tracked')
    assert.equal(JSON.stringify(audits).includes('已认领任务'), false)
  } finally {
    db.close()
  }
})

test('handoff ACK 轮次匹配才推进，完成终态重复 ACK 元数据不一致仍拒绝', () => {
  const { db, taskControl, snapshots, agentA, taskSpaceId } = setup()
  try {
    const executionTaskKey = prepareHandoffTask(
      db,
      snapshots,
      agentA,
      taskSpaceId,
      'task-handoff-cycle-match',
    )
    const row = db
      .prepare('SELECT materialized_at, materialized_revision FROM sync_task WHERE execution_task_key = ?')
      .get(executionTaskKey)
    const ack = {
      outcome: 'cleaned',
      backupId: 'handoff-0123456789abcdef',
      manifestSha256: 'e'.repeat(64),
      fileCount: 2,
      totalBytes: 256,
      materializedAt: row.materialized_at,
      materializedRevision: Number(row.materialized_revision),
    }

    const cleaned = taskControl.ackHandoff(agentA, taskSpaceId, executionTaskKey, ack)
    assert.equal(cleaned.handoffState, 'completed')
    assert.equal(cleaned.idempotent, false)
    assert.equal(
      taskControl.ackHandoff(agentA, taskSpaceId, executionTaskKey, ack).idempotent,
      true,
    )
    assert.throws(
      () =>
        taskControl.ackHandoff(agentA, taskSpaceId, executionTaskKey, {
          ...ack,
          backupId: 'handoff-fedcba9876543210',
          manifestSha256: 'f'.repeat(64),
        }),
      (error) => error.status === 409 && error.code === 'HANDOFF_ACK_MISMATCH',
    )

    // 已完成终态下轮次陈旧的重复 ACK 必须优先按 fencing 拒绝，不能进入幂等元数据比较。
    assert.throws(
      () =>
        taskControl.ackHandoff(agentA, taskSpaceId, executionTaskKey, {
          ...ack,
          materializedAt: '2099-03-03T03:03:03.033Z',
        }),
      (error) => error.status === 409 && error.code === 'HANDOFF_CYCLE_STALE',
    )

    // 服务端已进入下一轮物化并重新等待清理：上一轮终态 ACK 必须先被轮次 fencing 拒绝，
    // 不能进入 completed 幂等比较。
    const nextAt = '2099-01-01T00:00:00.000Z'
    db.prepare(`
      UPDATE sync_task
      SET materialized_at = ?, materialized_revision = 2, handoff_state = 'source_cleanup_pending'
      WHERE execution_task_key = ?
    `).run(nextAt, executionTaskKey)
    assert.throws(
      () => taskControl.ackHandoff(agentA, taskSpaceId, executionTaskKey, ack),
      (error) =>
        error.status === 409 &&
        error.code === 'HANDOFF_CYCLE_STALE' &&
        error.details.materializedAt === nextAt &&
        error.details.materializedRevision === 2,
    )
    assert.equal(
      taskControl.ackHandoff(agentA, taskSpaceId, executionTaskKey, {
        ...ack,
        materializedAt: nextAt,
        materializedRevision: 2,
        backupId: 'handoff-fedcba9876543210',
        manifestSha256: 'f'.repeat(64),
      }).handoffState,
      'completed',
    )
    assert.equal(
      db
        .prepare("SELECT COUNT(*) AS count FROM audit_event WHERE action = 'task_handoff_cleanup_ack'")
        .get().count,
      2,
    )
  } finally {
    db.close()
  }
})

test('陈旧轮次的 cleaned/conflict ACK 返回 HANDOFF_CYCLE_STALE 且不推进状态或写审计', () => {
  const { db, taskControl, snapshots, agentA, taskSpaceId } = setup()
  try {
    const executionTaskKey = prepareHandoffTask(
      db,
      snapshots,
      agentA,
      taskSpaceId,
      'task-handoff-cycle-stale',
    )
    const previous = db
      .prepare('SELECT materialized_at, materialized_revision FROM sync_task WHERE execution_task_key = ?')
      .get(executionTaskKey)
    const nextAt = '2099-02-02T02:02:02.022Z'
    db.prepare(`
      UPDATE sync_task
      SET materialized_at = ?, materialized_revision = 2, handoff_state = 'source_cleanup_pending'
      WHERE execution_task_key = ?
    `).run(nextAt, executionTaskKey)

    const staleAck = {
      outcome: 'cleaned',
      backupId: 'handoff-0123456789abcdef',
      manifestSha256: 'e'.repeat(64),
      fileCount: 2,
      totalBytes: 256,
      materializedAt: previous.materialized_at,
      materializedRevision: Number(previous.materialized_revision),
    }
    assert.throws(
      () => taskControl.ackHandoff(agentA, taskSpaceId, executionTaskKey, staleAck),
      (error) => error.status === 409 && error.code === 'HANDOFF_CYCLE_STALE',
    )
    assert.throws(
      () =>
        taskControl.ackHandoff(agentA, taskSpaceId, executionTaskKey, {
          outcome: 'conflict',
          reason: 'git_tracked',
          fileCount: 2,
          totalBytes: 256,
          materializedAt: previous.materialized_at,
          materializedRevision: Number(previous.materialized_revision),
        }),
      (error) => error.status === 409 && error.code === 'HANDOFF_CYCLE_STALE',
    )
    // 只提供 revision 时也必须参与 fencing；0 是有效轮次，不能被当成缺省。
    assert.throws(
      () =>
        taskControl.ackHandoff(agentA, taskSpaceId, executionTaskKey, {
          ...staleAck,
          materializedAt: undefined,
          materializedRevision: 0,
        }),
      (error) => error.status === 409 && error.code === 'HANDOFF_CYCLE_STALE',
    )
    // 只提供 materializedAt 且陈旧时，即使 revision 匹配也必须拒绝。
    assert.throws(
      () =>
        taskControl.ackHandoff(agentA, taskSpaceId, executionTaskKey, {
          ...staleAck,
          materializedRevision: 2,
        }),
      (error) => error.status === 409 && error.code === 'HANDOFF_CYCLE_STALE',
    )
    assert.equal(
      db
        .prepare('SELECT handoff_state FROM sync_task WHERE execution_task_key = ?')
        .get(executionTaskKey).handoff_state,
      'source_cleanup_pending',
    )
    assert.equal(
      db
        .prepare("SELECT COUNT(*) AS count FROM audit_event WHERE action = 'task_handoff_cleanup_ack'")
        .get().count,
      0,
    )

    const conflict = taskControl.ackHandoff(agentA, taskSpaceId, executionTaskKey, {
      outcome: 'conflict',
      reason: 'git_tracked',
      fileCount: 2,
      totalBytes: 256,
      materializedAt: nextAt,
      materializedRevision: 2,
    })
    assert.equal(conflict.handoffState, 'source_cleanup_conflict')
    assert.equal(
      db
        .prepare("SELECT COUNT(*) AS count FROM audit_event WHERE action = 'task_handoff_cleanup_ack'")
        .get().count,
      1,
    )
  } finally {
    db.close()
  }
})

test('同一物化轮次内多次上传与命令完成保持首次物化时间，ACK 以 at 优先', () => {
  const { db, taskControl, snapshots, agentA, agentB, taskSpaceId } = setup(
    tickingClock('2026-11-20T03:56:03.000Z'),
  )
  try {
    const taskDir = '.trellis/tasks/11-17-task-epoch-stable'
    const taskId = 'task-epoch-stable'
    snapshots.applyChanges(agentA, taskSpaceId, {
      batchId: 'batch-epoch-source',
      clientSequence: 1,
      files: taskFilesAt(taskDir, taskId, '轮次稳定任务', 'alice'),
    })
    const executionTaskKey = `${taskSpaceId}::${taskId}`

    // 跨用户改派开启新轮次：上一轮物化标识全部清空。
    taskControl.assignPendingTask({ executionTaskKey, assigneeUserId: 'user-b' })
    const assigned = syncTaskRow(db, executionTaskKey)
    assert.equal(assigned.materialization_state, 'pending')
    assert.equal(assigned.materialized_at, null)
    assert.equal(assigned.materialized_revision, null)
    assert.equal(assigned.materialized_manifest_sha256, null)
    assert.equal(assigned.materialized_by_agent_id, null)

    // 目标首次上传写入本轮 epoch。
    const claimed = taskControl.claim(agentB, taskSpaceId, executionTaskKey)
    const current = snapshots.directorySnapshot(agentB, taskSpaceId, taskDir)
    const firstFiles = current.files.map((file) => {
      if (!file.path.endsWith('/task.json')) {
        return {
          path: file.path,
          content: file.content,
          sha256: file.sha256,
          baseSha256: file.sha256,
        }
      }
      const document = JSON.parse(file.content)
      document.assignee = 'bob'
      const content = JSON.stringify(document)
      return { path: file.path, content, sha256: snapshotSha256(content), baseSha256: file.sha256 }
    })
    const first = snapshots.applyChanges(agentB, taskSpaceId, {
      batchId: 'batch-epoch-target-1',
      clientSequence: 1,
      taskVersion: claimed.task.taskVersion,
      leaseToken: claimed.lease.token,
      files: firstFiles,
    })
    const afterFirst = syncTaskRow(db, executionTaskKey)
    const epoch = afterFirst.materialized_at
    assert.ok(epoch)
    assert.equal(afterFirst.materialized_by_agent_id, 'agent-b')
    assert.equal(Number(afterFirst.materialized_revision), first.revision)

    // 同轮第二次上传推进 revision，但不得改写首次物化时间。
    const latest = snapshots.directorySnapshot(agentB, taskSpaceId, taskDir)
    const prd = latest.files.find((file) => file.path.endsWith('/prd.md'))
    const changedContent = '# 轮次稳定任务\n\n第二次上传\n'
    const second = snapshots.applyChanges(agentB, taskSpaceId, {
      batchId: 'batch-epoch-target-2',
      clientSequence: 2,
      taskVersion: afterFirst.task_version,
      leaseToken: claimed.lease.token,
      files: [
        {
          path: prd.path,
          content: changedContent,
          sha256: snapshotSha256(changedContent),
          baseSha256: prd.sha256,
        },
      ],
    })
    assert.ok(second.revision > first.revision)
    const afterSecond = syncTaskRow(db, executionTaskKey)
    assert.equal(afterSecond.materialized_at, epoch)
    assert.equal(Number(afterSecond.materialized_revision), second.revision)

    // 命令完成只收敛状态，不得覆盖本轮首次物化时间。
    const completed = taskControl.completeCommand(agentB, taskSpaceId, {
      commandType: 'assign_task',
      taskId,
      revision: second.revision,
    })
    assert.equal(completed.handoffState, 'source_cleanup_pending')
    const afterComplete = syncTaskRow(db, executionTaskKey)
    assert.equal(afterComplete.materialized_at, epoch)
    assert.equal(Number(afterComplete.materialized_revision), second.revision)

    // ACK 携带的 revision 已落后于最新上传，但 at 匹配时仍必须成功。
    assert.notEqual(Number(afterComplete.materialized_revision), first.revision)
    const cleaned = taskControl.ackHandoff(agentA, taskSpaceId, executionTaskKey, {
      outcome: 'cleaned',
      backupId: 'handoff-0123456789abcdef',
      manifestSha256: 'e'.repeat(64),
      fileCount: 2,
      totalBytes: 256,
      materializedAt: epoch,
      materializedRevision: first.revision,
    })
    assert.equal(cleaned.handoffState, 'completed')
    assert.equal(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM audit_event WHERE action = 'task_handoff_cleanup_ack'",
        )
        .get().count,
      1,
    )
  } finally {
    db.close()
  }
})

test('再次改派清空并重建物化轮次，旧轮次 ACK 返回 HANDOFF_CYCLE_STALE', () => {
  const { db, taskControl, snapshots, agentA, agentB, taskSpaceId } = setup(
    tickingClock('2026-11-20T04:10:00.000Z'),
  )
  try {
    const taskDir = '.trellis/tasks/11-17-task-epoch-cycles'
    const taskId = 'task-epoch-cycles'
    snapshots.applyChanges(agentA, taskSpaceId, {
      batchId: 'batch-cycles-source',
      clientSequence: 1,
      files: taskFilesAt(taskDir, taskId, '跨轮任务', 'alice'),
    })
    const executionTaskKey = `${taskSpaceId}::${taskId}`

    // 第一轮：目标上传（内容未变也可）并完成命令，建立本轮 epoch。
    taskControl.assignPendingTask({ executionTaskKey, assigneeUserId: 'user-b' })
    const firstClaim = taskControl.claim(agentB, taskSpaceId, executionTaskKey)
    const firstSnapshot = snapshots.directorySnapshot(agentB, taskSpaceId, taskDir)
    const firstUpload = snapshots.applyChanges(agentB, taskSpaceId, {
      batchId: 'batch-cycles-target-1',
      clientSequence: 1,
      taskVersion: firstClaim.task.taskVersion,
      leaseToken: firstClaim.lease.token,
      files: firstSnapshot.files.map((file) => ({
        path: file.path,
        content: file.content,
        sha256: file.sha256,
        baseSha256: file.sha256,
      })),
    })
    taskControl.completeCommand(agentB, taskSpaceId, {
      commandType: 'assign_task',
      taskId,
      revision: firstUpload.revision,
    })
    const firstEpoch = syncTaskRow(db, executionTaskKey).materialized_at
    assert.ok(firstEpoch)

    // 第二轮：改派回创建者再改派给目标，轮次字段被清空。
    taskControl.assignPendingTask({ executionTaskKey, assigneeUserId: 'user-a' })
    const cleared = syncTaskRow(db, executionTaskKey)
    assert.equal(cleared.materialized_at, null)
    assert.equal(cleared.materialized_revision, null)
    assert.equal(cleared.materialized_manifest_sha256, null)
    assert.equal(cleared.materialized_by_agent_id, null)
    assert.equal(cleared.handoff_state, 'none')

    taskControl.assignPendingTask({ executionTaskKey, assigneeUserId: 'user-b' })
    const secondClaim = taskControl.claim(agentB, taskSpaceId, executionTaskKey)
    const secondSnapshot = snapshots.directorySnapshot(agentB, taskSpaceId, taskDir)
    const prd = secondSnapshot.files.find((file) => file.path.endsWith('/prd.md'))
    const changedContent = '# 跨轮任务\n\n第二轮物化\n'
    const secondUpload = snapshots.applyChanges(agentB, taskSpaceId, {
      batchId: 'batch-cycles-target-2',
      clientSequence: 2,
      taskVersion: secondClaim.task.taskVersion,
      leaseToken: secondClaim.lease.token,
      files: [
        {
          path: prd.path,
          content: changedContent,
          sha256: snapshotSha256(changedContent),
          baseSha256: prd.sha256,
        },
      ],
    })
    taskControl.completeCommand(agentB, taskSpaceId, {
      commandType: 'assign_task',
      taskId,
      revision: secondUpload.revision,
    })
    const row = syncTaskRow(db, executionTaskKey)
    assert.ok(row.materialized_at)
    assert.notEqual(row.materialized_at, firstEpoch)
    assert.equal(row.handoff_state, 'source_cleanup_pending')

    // 上一轮 epoch 必须被拒绝，且不写审计、不改状态。
    assert.throws(
      () =>
        taskControl.ackHandoff(agentA, taskSpaceId, executionTaskKey, {
          outcome: 'cleaned',
          backupId: 'handoff-0123456789abcdef',
          manifestSha256: 'e'.repeat(64),
          fileCount: 2,
          totalBytes: 256,
          materializedAt: firstEpoch,
          materializedRevision: firstUpload.revision,
        }),
      (error) =>
        error.status === 409 &&
        error.code === 'HANDOFF_CYCLE_STALE' &&
        error.details.materializedAt === row.materialized_at,
    )
    const afterStale = syncTaskRow(db, executionTaskKey)
    assert.equal(afterStale.handoff_state, 'source_cleanup_pending')
    assert.equal(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM audit_event WHERE action = 'task_handoff_cleanup_ack'",
        )
        .get().count,
      0,
    )

    // 新轮次 epoch 可完成；revision 差异被 at 优先规则忽略。
    const cleaned = taskControl.ackHandoff(agentA, taskSpaceId, executionTaskKey, {
      outcome: 'cleaned',
      backupId: 'handoff-0123456789abcdef',
      manifestSha256: 'e'.repeat(64),
      fileCount: 2,
      totalBytes: 256,
      materializedAt: row.materialized_at,
      materializedRevision: firstUpload.revision,
    })
    assert.equal(cleaned.handoffState, 'completed')
  } finally {
    db.close()
  }
})

test('assign_task 无内容上传时由命令完成补写本轮首次物化时间', () => {
  const { db, taskControl, snapshots, agentA, agentB, taskSpaceId } = setup(
    tickingClock('2026-11-20T04:20:00.000Z'),
  )
  try {
    const taskDir = '.trellis/tasks/11-17-task-epoch-command'
    const taskId = 'task-epoch-command'
    snapshots.applyChanges(agentA, taskSpaceId, {
      batchId: 'batch-command-source',
      clientSequence: 1,
      files: taskFilesAt(taskDir, taskId, '命令补写任务', 'alice'),
    })
    const executionTaskKey = `${taskSpaceId}::${taskId}`

    taskControl.assignPendingTask({ executionTaskKey, assigneeUserId: 'user-b' })
    const assigned = syncTaskRow(db, executionTaskKey)
    assert.equal(assigned.materialized_at, null)
    assert.equal(assigned.materialized_revision, null)

    const completed = taskControl.completeCommand(agentB, taskSpaceId, {
      commandType: 'assign_task',
      taskId,
      revision: Number(assigned.content_revision),
    })
    assert.equal(completed.materializationState, 'materialized')
    assert.equal(completed.handoffState, 'source_cleanup_pending')

    const row = syncTaskRow(db, executionTaskKey)
    assert.ok(row.materialized_at)
    assert.equal(row.materialized_by_agent_id, 'agent-b')
    assert.equal(Number(row.materialized_revision), Number(assigned.content_revision))

    const cleaned = taskControl.ackHandoff(agentA, taskSpaceId, executionTaskKey, {
      outcome: 'cleaned',
      backupId: 'handoff-0123456789abcdef',
      manifestSha256: 'e'.repeat(64),
      fileCount: 1,
      totalBytes: 32,
      materializedAt: row.materialized_at,
      materializedRevision: Number(row.materialized_revision),
    })
    assert.equal(cleaned.handoffState, 'completed')
  } finally {
    db.close()
  }
})

test('handoff ACK 缺少轮次字段保持旧客户端兼容，当前轮次为空时拒绝提供的轮次', () => {
  const { db, taskControl, snapshots, agentA, taskSpaceId } = setup()
  try {
    const executionTaskKey = prepareHandoffTask(
      db,
      snapshots,
      agentA,
      taskSpaceId,
      'task-handoff-cycle-compat',
    )
    const legacyAck = {
      outcome: 'cleaned',
      backupId: 'handoff-0123456789abcdef',
      manifestSha256: 'e'.repeat(64),
      fileCount: 2,
      totalBytes: 256,
    }
    const cleaned = taskControl.ackHandoff(agentA, taskSpaceId, executionTaskKey, legacyAck)
    assert.equal(cleaned.handoffState, 'completed')
    assert.equal(cleaned.idempotent, false)

    db.prepare(`
      UPDATE sync_task
      SET materialized_at = NULL, materialized_revision = NULL,
          handoff_state = 'source_cleanup_pending'
      WHERE execution_task_key = ?
    `).run(executionTaskKey)
    assert.throws(
      () =>
        taskControl.ackHandoff(agentA, taskSpaceId, executionTaskKey, {
          ...legacyAck,
          materializedAt: '2026-11-19T08:00:00.000Z',
        }),
      (error) => error.status === 409 && error.code === 'HANDOFF_CYCLE_STALE',
    )
    // 服务端轮次为空且请求不携带轮次时仍走兼容路径。
    assert.equal(
      taskControl.ackHandoff(agentA, taskSpaceId, executionTaskKey, {
        ...legacyAck,
        backupId: 'handoff-fedcba9876543210',
        manifestSha256: 'f'.repeat(64),
      }).handoffState,
      'completed',
    )
  } finally {
    db.close()
  }
})

test('非法 handoff 轮次字段返回 400 且不改状态', () => {
  const { db, taskControl, snapshots, agentA, taskSpaceId } = setup()
  try {
    const executionTaskKey = prepareHandoffTask(
      db,
      snapshots,
      agentA,
      taskSpaceId,
      'task-handoff-cycle-invalid',
    )
    const baseAck = {
      outcome: 'cleaned',
      backupId: 'handoff-0123456789abcdef',
      manifestSha256: 'e'.repeat(64),
      fileCount: 2,
      totalBytes: 256,
    }
    for (const materializedAt of [
      '2026-11-19',
      '2026-11-19T08:00:00Z',
      '2026-11-19T08:00:00.000+08:00',
    ]) {
      assert.throws(
        () =>
          taskControl.ackHandoff(agentA, taskSpaceId, executionTaskKey, {
            ...baseAck,
            materializedAt,
          }),
        (error) => error.status === 400 && error.code === 'INVALID_INPUT',
      )
    }
    for (const materializedRevision of [-1, 1.5, 'abc']) {
      assert.throws(
        () =>
          taskControl.ackHandoff(agentA, taskSpaceId, executionTaskKey, {
            ...baseAck,
            materializedRevision,
          }),
        (error) => error.status === 400 && error.code === 'INVALID_INPUT',
      )
    }
    assert.equal(
      db
        .prepare('SELECT handoff_state FROM sync_task WHERE execution_task_key = ?')
        .get(executionTaskKey).handoff_state,
      'source_cleanup_pending',
    )
    assert.equal(
      db
        .prepare("SELECT COUNT(*) AS count FROM audit_event WHERE action = 'task_handoff_cleanup_ack'")
        .get().count,
      0,
    )
  } finally {
    db.close()
  }
})

test('多个活动副本身份冲突时不改写已有权威任务路径', () => {
  const { db, taskControl, snapshots, agentA, taskSpaceId } = setup()
  try {
    const firstDir = '.trellis/tasks/11-17-duplicate'
    snapshots.applyChanges(agentA, taskSpaceId, {
      batchId: 'batch-duplicate-1',
      clientSequence: 1,
      files: [
        {
          path: `${firstDir}/task.json`,
          content: JSON.stringify({
            id: 'duplicate',
            title: '任务一',
            branch: 'main',
            assignee: 'alice',
          }),
        },
        { path: `${firstDir}/prd.md`, content: '# 任务一\n' },
      ].map((file) => ({ ...file, sha256: snapshotSha256(file.content) })),
    })
    const task = db
      .prepare('SELECT * FROM sync_task WHERE execution_task_key = ?')
      .get(`${taskSpaceId}::duplicate`)
    taskControl.reconcileProjection({
      taskSpaceId,
      projectId: task.project_id,
      tasks: [
        {
          taskKey: `${taskSpaceId}::${firstDir}`,
          executionTaskKey: task.execution_task_key,
          relativeDir: firstDir,
          title: task.title,
          priority: task.priority,
          derivedStage: 'planning',
        },
        {
          taskKey: `${taskSpaceId}::.trellis/tasks/11-17-duplicate-copy`,
          executionTaskKey: task.execution_task_key,
          relativeDir: '.trellis/tasks/11-17-duplicate-copy',
          title: task.title,
          priority: task.priority,
          derivedStage: 'planning',
        },
      ],
    })
    assert.equal(
      db
        .prepare('SELECT relative_dir FROM sync_task WHERE execution_task_key = ?')
        .get(task.execution_task_key).relative_dir,
      firstDir,
    )
  } finally {
    db.close()
  }
})

function prepareHandoffTask(db, snapshots, agentA, taskSpaceId, taskId) {
  const files = taskFiles(taskId, '租约保护任务')
  snapshots.applyChanges(agentA, taskSpaceId, {
    batchId: `batch-${taskId}-1`,
    clientSequence: 1,
    files,
  })
  const executionTaskKey = `${taskSpaceId}::${taskId}`
  const timestamp = new Date().toISOString()
  db.prepare(`
    UPDATE sync_task
    SET assignee_user_id = 'user-b', assignee_dev_id = 'bob',
        previous_assignee_user_id = 'user-a', materialization_state = 'materialized',
        materialized_at = ?, materialized_revision = 1,
        handoff_state = 'source_cleanup_pending', updated_at = ?
    WHERE execution_task_key = ?
  `).run(timestamp, timestamp, executionTaskKey)
  db.prepare(`
    UPDATE sync_task_lease SET status = 'revoked'
    WHERE execution_task_key = ? AND status = 'active'
  `).run(executionTaskKey)
  db.prepare('UPDATE sync_task SET lease_id = NULL WHERE execution_task_key = ?').run(
    executionTaskKey,
  )
  return executionTaskKey
}

test('handoff 清理允许当前负责人的租约', () => {
  const { db, taskControl, snapshots, agentA, agentB, taskSpaceId } = setup()
  try {
    const executionTaskKey = prepareHandoffTask(
      db,
      snapshots,
      agentA,
      taskSpaceId,
      'task-handoff-target-lease',
    )
    taskControl.claim(agentB, taskSpaceId, executionTaskKey)
    const control = taskControl
      .controlsForAgent(agentA, taskSpaceId)
      .find((item) => item.executionTaskKey === executionTaskKey)
    assert.equal(control.state, 'handoff_materialized')
    assert.equal(control.leaseHeldByOtherUser, false)

    const cleaned = taskControl.ackHandoff(agentA, taskSpaceId, executionTaskKey, {
      outcome: 'cleaned',
      backupId: 'handoff-0123456789abcdef',
      manifestSha256: 'd'.repeat(64),
      fileCount: 2,
      totalBytes: 256,
    })
    assert.equal(cleaned.handoffState, 'completed')
  } finally {
    db.close()
  }
})

test('handoff 清理仍拒绝第三方租约', () => {
  const { db, taskControl, snapshots, agentA, taskSpaceId } = setup()
  try {
    const executionTaskKey = prepareHandoffTask(
      db,
      snapshots,
      agentA,
      taskSpaceId,
      'task-handoff-third-party-lease',
    )
    insertUser(db, 'user-c', '第三方')
    insertAgent(db, 'agent-c', 'user-c')
    const timestamp = new Date().toISOString()
    const expiresAt = new Date(Date.now() + 60_000).toISOString()
    db.prepare(`
      INSERT INTO sync_task_lease(
        id, execution_task_key, agent_id, user_id, lease_token, status,
        expires_at, last_heartbeat_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
    `).run(
      'lease-third-party',
      executionTaskKey,
      'agent-c',
      'user-c',
      'third-party-token',
      expiresAt,
      timestamp,
      timestamp,
      timestamp,
    )

    const control = taskControl
      .controlsForAgent(agentA, taskSpaceId)
      .find((item) => item.executionTaskKey === executionTaskKey)
    assert.equal(control.state, 'handoff_materialized')
    assert.equal(control.leaseHeldByOtherUser, true)

    assert.throws(
      () =>
        taskControl.ackHandoff(agentA, taskSpaceId, executionTaskKey, {
          outcome: 'cleaned',
          backupId: 'handoff-0123456789abcdef',
          manifestSha256: 'd'.repeat(64),
          fileCount: 2,
          totalBytes: 256,
        }),
      (error) => error.status === 409 && error.code === 'HANDOFF_LEASE_HELD',
    )
    const conflict = taskControl.ackHandoff(agentA, taskSpaceId, executionTaskKey, {
      outcome: 'conflict',
      reason: 'lease_active',
      fileCount: 2,
      totalBytes: 256,
    })
    assert.equal(conflict.handoffState, 'source_cleanup_conflict')
  } finally {
    db.close()
  }
})

test('create_task 完成不触发来源清理，assign_task 完成后才触发', () => {
  const { db, taskControl, snapshots, agentA, agentB, taskSpaceId } = setup()
  try {
    const created = taskControl.createPendingTask('user-a', {
      taskSpaceId,
      assigneeUserId: 'user-b',
      title: '直接创建给执行人',
      slug: 'create-for-executor',
      idempotencyKey: 'create-for-executor',
    })
    const createdClaim = taskControl.claim(agentB, taskSpaceId, created.executionTaskKey)
    const createdUpload = snapshots.applyChanges(agentB, taskSpaceId, {
      batchId: 'batch-create-for-executor',
      clientSequence: 1,
      taskVersion: createdClaim.task.taskVersion,
      leaseToken: createdClaim.lease.token,
      files: taskFilesAt(created.relativeDir, created.taskId, '直接创建给执行人', 'bob'),
    })
    assert.notEqual(
      db
        .prepare('SELECT handoff_state FROM sync_task WHERE execution_task_key = ?')
        .get(created.executionTaskKey).handoff_state,
      'source_cleanup_pending',
    )
    const createCompleted = taskControl.completeCommand(agentB, taskSpaceId, {
      commandType: 'create_task',
      taskId: created.taskId,
      revision: createdUpload.revision,
    })
    assert.equal(createCompleted.handoffState, 'none')

    const source = taskControl.createPendingTask('user-a', {
      taskSpaceId,
      assigneeUserId: 'user-a',
      title: '创建后改派',
      slug: 'assign-after-create',
      idempotencyKey: 'assign-after-create',
    })
    const sourceClaim = taskControl.claim(agentA, taskSpaceId, source.executionTaskKey)
    const sourceUpload = snapshots.applyChanges(agentA, taskSpaceId, {
      batchId: 'batch-assign-after-create-source',
      clientSequence: 1,
      taskVersion: sourceClaim.task.taskVersion,
      leaseToken: sourceClaim.lease.token,
      files: taskFilesAt(source.relativeDir, source.taskId, '创建后改派'),
    })
    taskControl.completeCommand(agentA, taskSpaceId, {
      commandType: 'create_task',
      taskId: source.taskId,
      revision: sourceUpload.revision,
    })
    taskControl.assignPendingTask({
      executionTaskKey: source.executionTaskKey,
      assigneeUserId: 'user-b',
    })
    const assignedClaim = taskControl.claim(agentB, taskSpaceId, source.executionTaskKey)
    const assignedUpload = snapshots.applyChanges(agentB, taskSpaceId, {
      batchId: 'batch-assign-after-create-target',
      clientSequence: 2,
      taskVersion: assignedClaim.task.taskVersion,
      leaseToken: assignedClaim.lease.token,
      files: taskFilesAt(source.relativeDir, source.taskId, '创建后改派', 'bob'),
    })
    assert.notEqual(
      db
        .prepare('SELECT handoff_state FROM sync_task WHERE execution_task_key = ?')
        .get(source.executionTaskKey).handoff_state,
      'source_cleanup_pending',
    )
    const assignCompleted = taskControl.completeCommand(agentB, taskSpaceId, {
      commandType: 'assign_task',
      taskId: source.taskId,
      revision: assignedUpload.revision,
    })
    assert.equal(assignCompleted.handoffState, 'source_cleanup_pending')
  } finally {
    db.close()
  }
})

test('停用任务空间后 Agent 不能继续读取或申请任务租约', () => {
  const { db, taskControl, snapshots, agentA, taskSpaceId } = setup()
  try {
    const files = taskFiles('task-disabled', '停用任务')
    snapshots.applyChanges(agentA, taskSpaceId, {
      batchId: 'batch-disabled-1',
      clientSequence: 1,
      files,
    })
    const executionTaskKey = `${taskSpaceId}::task-disabled`
    db.prepare("UPDATE sync_task_space SET status = 'disabled' WHERE id = ?").run(taskSpaceId)
    assert.throws(
      () => taskControl.claim(agentA, taskSpaceId, executionTaskKey),
      (error) => error.status === 403 && error.code === 'FORBIDDEN',
    )
    assert.throws(
      () => taskControl.getTask(agentA, taskSpaceId, executionTaskKey),
      (error) => error.status === 403 && error.code === 'FORBIDDEN',
    )
  } finally {
    db.close()
  }
})

test('项目成员降为只读后 Agent 不能继续读取正文或上传', () => {
  const { db, taskControl, snapshots, agentA, taskSpaceId } = setup()
  try {
    const files = taskFiles('task-viewer', '只读降级任务')
    snapshots.applyChanges(agentA, taskSpaceId, {
      batchId: 'batch-viewer-1',
      clientSequence: 1,
      files,
    })
    db.prepare(`
      UPDATE sync_project_member
      SET role = 'read_only'
      WHERE user_id = 'user-a'
        AND project_id = (SELECT project_id FROM sync_task_space WHERE id = ?)
    `).run(taskSpaceId)
    assert.throws(
      () => snapshots.snapshot(agentA, taskSpaceId),
      (error) => error.status === 403 && error.code === 'FORBIDDEN',
    )
    assert.throws(
      () => snapshots.directorySnapshot(agentA, taskSpaceId, '.trellis/tasks/11-17-task-viewer'),
      (error) => error.status === 403 && error.code === 'FORBIDDEN',
    )
    assert.throws(
      () =>
        snapshots.applyChanges(agentA, taskSpaceId, {
          batchId: 'batch-viewer-2',
          clientSequence: 2,
          files,
        }),
      (error) => error.status === 403 && error.code === 'FORBIDDEN',
    )
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sync_task_space_batch').get().count, 1)
  } finally {
    db.close()
  }
})

function archiveTask(taskControl, db, taskSpaceId, executionTaskKey, archiveName) {
  const task = db
    .prepare('SELECT * FROM sync_task WHERE execution_task_key = ?')
    .get(executionTaskKey)
  taskControl.reconcileProjection({
    taskSpaceId,
    projectId: task.project_id,
    tasks: [
      {
        taskKey: `${taskSpaceId}::.trellis/tasks/archive/2026-11/${archiveName}`,
        executionTaskKey,
        relativeDir: `.trellis/tasks/archive/2026-11/${archiveName}`,
        title: task.title,
        priority: task.priority,
        derivedStage: 'archive',
        archived: true,
        archivedAt: new Date().toISOString(),
      },
    ],
  })
  return task
}

test('归档任务的活跃路径按 basename 反解返回 409，未知目录仍为 404，legacy 文件仍为 403', () => {
  const { db, taskControl, snapshots, agentA, taskSpaceId } = setup()
  try {
    const files = taskFiles('task-dir-lookup', '归档反解任务')
    snapshots.applyChanges(agentA, taskSpaceId, {
      batchId: 'batch-dir-lookup-1',
      clientSequence: 1,
      files,
    })
    archiveTask(
      taskControl,
      db,
      taskSpaceId,
      `${taskSpaceId}::task-dir-lookup`,
      '11-17-task-dir-lookup',
    )
    assert.throws(
      () =>
        snapshots.directorySnapshot(agentA, taskSpaceId, '.trellis/tasks/11-17-task-dir-lookup'),
      (error) => error.status === 409 && error.code === 'TASK_ARCHIVED',
    )
    assert.throws(
      () => snapshots.directorySnapshot(agentA, taskSpaceId, '.trellis/tasks/11-17-unknown'),
      (error) => error.status === 404 && error.code === 'NOT_FOUND',
    )
    db.prepare(`
      INSERT INTO sync_task_space_file(
        task_space_id, relative_path, revision, sha256, content_text, task_id, task_dir,
        source_agent_id, source_user_id, source_client_sequence, updated_at
      ) VALUES (?, ?, 1, ?, ?, 'legacy-task', '.trellis/tasks/11-17-legacy', 'agent-a', 'user-a', 1, ?)
    `).run(
      taskSpaceId,
      '.trellis/tasks/11-17-legacy/prd.md',
      'a'.repeat(64),
      '# legacy\n',
      new Date().toISOString(),
    )
    assert.throws(
      () => snapshots.directorySnapshot(agentA, taskSpaceId, '.trellis/tasks/11-17-legacy'),
      (error) => error.status === 403 && error.message === '只能读取本人任务内容',
    )
  } finally {
    db.close()
  }
})

test('任务归档收敛 pending 冲突且冲突列表排除已归档任务', () => {
  const { db, taskControl, snapshots, agentA, taskSpaceId } = setup()
  try {
    const archivedFiles = taskFiles('task-conflict-archive', '待归档冲突任务')
    snapshots.applyChanges(agentA, taskSpaceId, {
      batchId: 'batch-conflict-archive-1',
      clientSequence: 1,
      files: archivedFiles,
    })
    const inserted = db.prepare(`
      INSERT INTO sync_conflict(
        id, task_space_id, task_id, task_dir, files_json, server_revision, client_sequence,
        batch_id, status, created_by_user_id, created_by_agent_id, created_at
      ) VALUES (?, ?, 'task-conflict-archive', '.trellis/tasks/11-17-task-conflict-archive',
        '[]', 1, 2, 'batch-conflict-1', 'pending', 'user-a', 'agent-a', ?)
    `)
    const createdAt = new Date().toISOString()
    inserted.run('conflict-archive', taskSpaceId, createdAt)
    inserted.run('conflict-defensive', taskSpaceId, createdAt)

    archiveTask(
      taskControl,
      db,
      taskSpaceId,
      `${taskSpaceId}::task-conflict-archive`,
      '11-17-task-conflict-archive',
    )
    const resolved = db
      .prepare('SELECT status, resolved_at FROM sync_conflict WHERE id = ?')
      .get('conflict-archive')
    assert.equal(resolved.status, 'resolved')
    assert.ok(resolved.resolved_at)

    // defensive case: sync_task 已归档但冲突仍为 pending，列表也不应下发
    db.prepare(
      "UPDATE sync_conflict SET status = 'pending', resolved_at = NULL WHERE id = 'conflict-defensive'",
    ).run()
    assert.deepEqual(snapshots.listConflicts(agentA, taskSpaceId), [])
  } finally {
    db.close()
  }
})

test('服务端无任务行时上传者必须是任务负责人', () => {
  const { db, snapshots, agentA, agentB, taskSpaceId } = setup()
  try {
    assert.throws(
      () =>
        snapshots.applyChanges(agentA, taskSpaceId, {
          batchId: 'batch-forged-assignee',
          clientSequence: 1,
          files: taskFiles('task-forged', '替别人建行', 'bob'),
        }),
      (error) => error.status === 403 && error.code === 'TASK_WRITE_FORBIDDEN',
    )
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM sync_task WHERE task_space_id = ?').get(taskSpaceId)
        .count,
      0,
    )
    assert.equal(
      db
        .prepare('SELECT COUNT(*) AS count FROM sync_task_space_file WHERE task_space_id = ?')
        .get(taskSpaceId).count,
      0,
    )

    const files = taskFiles('task-anonymous', '无负责人任务')
    for (const file of files) {
      if (!file.path.endsWith('/task.json')) continue
      const parsed = JSON.parse(file.content)
      delete parsed.assignee
      delete parsed.creator
      file.content = JSON.stringify(parsed)
      file.sha256 = snapshotSha256(file.content)
    }
    const applied = snapshots.applyChanges(agentA, taskSpaceId, {
      batchId: 'batch-anonymous-owner',
      clientSequence: 1,
      files,
    })
    assert.equal(applied.revision, 1)
    assert.equal(
      db
        .prepare('SELECT assignee_user_id FROM sync_task WHERE execution_task_key = ?')
        .get(`${taskSpaceId}::task-anonymous`).assignee_user_id,
      'user-a',
    )

    // 已有他人在服务端持有时，仍是既有的 409 语义
    assert.throws(
      () =>
        snapshots.applyChanges(agentB, taskSpaceId, {
          batchId: 'batch-other-owner',
          clientSequence: 1,
          files: files.map((file) => ({ ...file, baseSha256: null })),
        }),
      (error) => error.status === 409,
    )
  } finally {
    db.close()
  }
})

test('改派只允许当前负责人、项目负责人或自取', () => {
  const { db, commands, snapshots, agentA, taskControl, taskSpaces, taskSpaceId } = setup()
  try {
    insertUser(db, 'user-c', '第三人')
    insertAgent(db, 'agent-c', 'user-c')
    const projectId = db
      .prepare('SELECT project_id FROM sync_task_space WHERE id = ?')
      .get(taskSpaceId).project_id
    taskSpaces.upsertMember(taskSpaces.actorContext('user-a'), {
      projectId,
      userId: 'user-c',
      role: 'member',
      trellisDevId: 'carol',
    })

    const files = taskFiles('task-assign', '改派目标', 'alice')
    snapshots.applyChanges(agentA, taskSpaceId, {
      batchId: 'batch-assign-source',
      clientSequence: 1,
      files,
    })
    const executionTaskKey = `${taskSpaceId}::task-assign`
    const member = taskSpaces.actorContext('user-b')

    assert.throws(
      () =>
        commands.enqueue(member, {
          commandType: 'assign_task',
          taskSpaceId,
          assigneeUserId: 'user-c',
          executionTaskKey,
          idempotencyKey: 'assign-other-to-third',
        }),
      (error) => error.status === 403 && error.code === 'FORBIDDEN',
    )
    assert.equal(
      db
        .prepare('SELECT COUNT(*) AS count FROM sync_task_command WHERE idempotency_key = ?')
        .get('assign-other-to-third').count,
      0,
    )

    const selfClaim = commands.enqueue(member, {
      commandType: 'assign_task',
      taskSpaceId,
      assigneeUserId: 'user-b',
      executionTaskKey,
      idempotencyKey: 'assign-self-claim',
    })
    assert.equal(selfClaim.statusCode, 202)
    assert.equal(selfClaim.operation.targetUserId, 'user-b')

    const byLead = commands.enqueue(taskSpaces.actorContext('user-a'), {
      commandType: 'assign_task',
      taskSpaceId,
      assigneeUserId: 'user-c',
      executionTaskKey,
      idempotencyKey: 'assign-by-lead',
    })
    assert.equal(byLead.statusCode, 202)
    assert.equal(byLead.operation.targetUserId, 'user-c')

    taskControl.assignPendingTask({ executionTaskKey, assigneeUserId: 'user-b' })
    const byOwner = commands.enqueue(member, {
      commandType: 'assign_task',
      taskSpaceId,
      assigneeUserId: 'user-c',
      executionTaskKey,
      idempotencyKey: 'assign-by-current-owner',
    })
    assert.equal(byOwner.statusCode, 202)
    assert.equal(byOwner.operation.targetUserId, 'user-c')
  } finally {
    db.close()
  }
})
