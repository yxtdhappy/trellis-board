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
  const taskControl = createTaskControlService({ db })
  const snapshots = createTaskSnapshotService({ db, taskSpaces, taskControl })
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
  return [
    {
      path: `.trellis/tasks/11-17-${taskId}/task.json`,
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
      path: `.trellis/tasks/11-17-${taskId}/prd.md`,
      content: `# ${title}\n`,
    },
  ].map((file) => ({ ...file, sha256: snapshotSha256(file.content) }))
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

test('handoff 控制面暴露他人租约并拒绝清理 ACK', () => {
  const { db, taskControl, snapshots, agentA, agentB, taskSpaceId } = setup()
  try {
    const files = taskFiles('task-handoff-lease', '租约保护任务')
    snapshots.applyChanges(agentA, taskSpaceId, {
      batchId: 'batch-handoff-lease-1',
      clientSequence: 1,
      files,
    })
    const executionTaskKey = `${taskSpaceId}::task-handoff-lease`
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
    taskControl.claim(agentB, taskSpaceId, executionTaskKey)
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
