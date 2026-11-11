import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { openDatabase } from '../server/database.js'
import { createTaskSnapshotBackupService } from '../server/team/task-snapshot-backup.js'
import { createTaskSnapshotService } from '../server/team/task-snapshot-service.js'
import { createTaskSpaceService } from '../server/team/task-space-service.js'
import { snapshotSha256 } from '../shared/task-snapshot.js'

test('任务快照数据库每日备份保留最近七份', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-task-backup-'))
  const databaseFile = path.join(root, 'board.sqlite')
  const db = openDatabase({
    databaseFile,
    fallbackRepositories: [],
    importLegacyRepositories: false,
    legacyJsonImport: false,
  })
  try {
    let hour = 0
    const backups = createTaskSnapshotBackupService({
      db,
      databaseFile,
      logger: { warn() {} },
      now: () => new Date(Date.UTC(2026, 10, 11, hour++)),
      retention: 7,
    })
    for (let index = 0; index < 9; index += 1) {
      assert.ok(backups.backupNow({ force: true }))
    }
    const files = backups.snapshots()
    assert.equal(files.length, 7)
    assert.ok(files.every((name) => fs.existsSync(path.join(root, 'backups', name))))
  } finally {
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

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
  for (const id of ['user-a', 'user-b']) {
    db.prepare(
      `INSERT INTO user_account(
        id, username_key, username, display_name, password_hash, password_params_json,
        system_admin, status, must_change_password, password_changed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'x', '{}', 0, 'active', 0, ?, ?, ?)`,
    ).run(id, id, id, id, now, now, now)
    db.prepare(
      `INSERT INTO team_member(team_id, user_id, role, created_at, updated_at)
       VALUES ('team-1', ?, 'member', ?, ?)`,
    ).run(id, now, now)
    db.prepare(
      `INSERT INTO agent_device(
        id, user_id, device_name, platform, agent_version, protocol_version,
        credential_hash, status, last_seen_at, created_at
      ) VALUES (?, ?, ?, 'win32', '0.1.0', 3, ?, 'active', ?, ?)`,
    ).run(`agent-${id}`, id, id, `credential-${id}`, now, now)
    db.prepare(`INSERT INTO sync_active_agent(user_id, agent_id, updated_at) VALUES (?, ?, ?)`).run(
      id,
      `agent-${id}`,
      now,
    )
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
  return { db, snapshots, agentA, agentB, taskSpaceId: second.taskSpace.id }
}

function batch(taskId, title, prd = '# PRD\n') {
  return [
    {
      path: `.trellis/tasks/11-10-${taskId}/task.json`,
      content: JSON.stringify({ id: taskId, title }),
      baseSha256: null,
    },
    {
      path: `.trellis/tasks/11-10-${taskId}/prd.md`,
      content: prd,
      baseSha256: null,
    },
  ]
}

test('首次上传写入快照并推进 revision', () => {
  const { db, snapshots, agentA, taskSpaceId } = setup()
  try {
    const result = snapshots.applyChanges(agentA, taskSpaceId, {
      batchId: 'batch-0001',
      clientSequence: 1,
      files: batch('demo', '示例'),
    })
    assert.equal(result.revision, 1)
    const payload = snapshots.snapshot(agentA, taskSpaceId)
    assert.equal(payload.revision, 1)
    assert.equal(payload.files.length, 2)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sync_file_audit').get().count, 2)
  } finally {
    db.close()
  }
})

test('同一摘要重放返回原 revision，不同内容同 batchId 被拒绝', () => {
  const { db, snapshots, agentA, taskSpaceId } = setup()
  try {
    const input = {
      batchId: 'batch-0002',
      clientSequence: 1,
      files: batch('demo', '示例'),
    }
    const first = snapshots.applyChanges(agentA, taskSpaceId, input)
    const replay = snapshots.applyChanges(agentA, taskSpaceId, input)
    assert.equal(replay.replayed, true)
    assert.equal(replay.revision, first.revision)
    assert.throws(
      () =>
        snapshots.applyChanges(agentA, taskSpaceId, {
          ...input,
          files: batch('demo', '另一个标题'),
        }),
      /同一批次 ID/,
    )
  } finally {
    db.close()
  }
})

test('CAS 冲突整批拒绝并记录来源', () => {
  const { db, snapshots, agentA, agentB, taskSpaceId } = setup()
  try {
    snapshots.applyChanges(agentA, taskSpaceId, {
      batchId: 'batch-0003',
      clientSequence: 1,
      files: batch('demo', '示例'),
    })
    const current = snapshots.directorySnapshot(agentB, taskSpaceId, '.trellis/tasks/11-10-demo')
    const taskJson = current.files.find((file) => file.path.endsWith('/task.json'))
    const prd = current.files.find((file) => file.path.endsWith('/prd.md'))
    const sameBase = [
      {
        path: taskJson.path,
        content: JSON.stringify({ id: 'demo', title: 'B 修改' }),
        baseSha256: taskJson.sha256,
      },
      {
        path: prd.path,
        content: '# B\n',
        baseSha256: prd.sha256,
      },
    ]
    const first = snapshots.applyChanges(agentA, taskSpaceId, {
      batchId: 'batch-0004',
      clientSequence: 2,
      files: [
        {
          ...sameBase[0],
          content: JSON.stringify({ id: 'demo', title: 'A 修改' }),
        },
        sameBase[1],
      ],
    })
    assert.equal(first.status, 200)
    const conflict = snapshots.applyChanges(agentB, taskSpaceId, {
      batchId: 'batch-0005',
      clientSequence: 1,
      files: sameBase,
    })
    assert.equal(conflict.status, 409)
    assert.equal(conflict.code, 'TASK_FILE_CONFLICT')
    assert.equal(conflict.details.taskTitle, 'A 修改')
    assert.equal(conflict.details.files.length, 2)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sync_conflict').get().count, 1)
    const stored = snapshots.snapshot(agentA, taskSpaceId)
    const storedTask = JSON.parse(
      stored.files.find((file) => file.path.endsWith('/task.json')).content,
    )
    assert.equal(storedTask.title, 'A 修改')
  } finally {
    db.close()
  }
})

test('删除墓碑在增量快照中返回，full snapshot 不返回墓碑', () => {
  const { db, snapshots, agentA, taskSpaceId } = setup()
  try {
    const files = batch('demo', '示例')
    const first = snapshots.applyChanges(agentA, taskSpaceId, {
      batchId: 'batch-0006',
      clientSequence: 1,
      files,
    })
    const uploaded = snapshots.snapshot(agentA, taskSpaceId, { afterRevision: 0 })
    const deletes = uploaded.files.map((file) => ({
      path: file.path,
      content: '',
      sha256: snapshotSha256(''),
      baseSha256: file.sha256,
      deleted: true,
    }))
    snapshots.applyChanges(agentA, taskSpaceId, {
      batchId: 'batch-0007',
      clientSequence: 2,
      files: deletes,
    })
    const incremental = snapshots.snapshot(agentA, taskSpaceId, { afterRevision: 1 })
    assert.ok(incremental.files.every((file) => file.deleted))
    const full = snapshots.snapshot(agentA, taskSpaceId)
    assert.equal(full.files.length, 0)
  } finally {
    db.close()
  }
})

test('同一任务目录的 task.json id 变化会整批拒绝', () => {
  const { db, snapshots, agentA, taskSpaceId } = setup()
  try {
    snapshots.applyChanges(agentA, taskSpaceId, {
      batchId: 'batch-0008',
      clientSequence: 1,
      files: batch('demo', '示例'),
    })
    const current = snapshots.directorySnapshot(agentA, taskSpaceId, '.trellis/tasks/11-10-demo')
    const taskJson = current.files.find((file) => file.path.endsWith('/task.json'))
    const prd = current.files.find((file) => file.path.endsWith('/prd.md'))
    assert.throws(
      () =>
        snapshots.applyChanges(agentA, taskSpaceId, {
          batchId: 'batch-0009',
          clientSequence: 2,
          files: [
            {
              path: taskJson.path,
              content: JSON.stringify({ id: 'other', title: '示例' }),
              baseSha256: taskJson.sha256,
            },
            {
              path: prd.path,
              content: prd.content,
              baseSha256: prd.sha256,
            },
          ],
        }),
      /id 不能变化/,
    )
    assert.equal(
      db.prepare('SELECT revision FROM sync_task_space WHERE id = ?').get(taskSpaceId).revision,
      1,
    )
  } finally {
    db.close()
  }
})

test('覆盖服务端冲突时备份双方内容并与解决状态同一事务提交', () => {
  const { db, snapshots, agentA, agentB, taskSpaceId } = setup()
  try {
    snapshots.applyChanges(agentA, taskSpaceId, {
      batchId: 'batch-0010',
      clientSequence: 1,
      files: batch('demo', '初始'),
    })
    const before = snapshots.directorySnapshot(agentA, taskSpaceId, '.trellis/tasks/11-10-demo')
    const taskJsonBefore = before.files.find((file) => file.path.endsWith('/task.json'))
    const prdBefore = before.files.find((file) => file.path.endsWith('/prd.md'))
    snapshots.applyChanges(agentA, taskSpaceId, {
      batchId: 'batch-0011',
      clientSequence: 2,
      files: [
        {
          path: taskJsonBefore.path,
          content: JSON.stringify({ id: 'demo', title: '服务端版本' }),
          baseSha256: taskJsonBefore.sha256,
        },
        {
          path: prdBefore.path,
          content: '# 服务端 PRD\n',
          baseSha256: prdBefore.sha256,
        },
      ],
    })
    const conflict = snapshots.applyChanges(agentB, taskSpaceId, {
      batchId: 'batch-0012',
      clientSequence: 1,
      files: [
        {
          path: taskJsonBefore.path,
          content: JSON.stringify({ id: 'demo', title: '客户端版本' }),
          baseSha256: taskJsonBefore.sha256,
        },
        {
          path: prdBefore.path,
          content: '# 客户端 PRD\n',
          baseSha256: prdBefore.sha256,
        },
      ],
    })
    assert.equal(conflict.code, 'TASK_FILE_CONFLICT')
    const current = snapshots.directorySnapshot(agentB, taskSpaceId, '.trellis/tasks/11-10-demo')
    const taskJsonCurrent = current.files.find((file) => file.path.endsWith('/task.json'))
    const prdCurrent = current.files.find((file) => file.path.endsWith('/prd.md'))
    const result = snapshots.resolveConflict(agentB, taskSpaceId, conflict.conflictId, {
      action: 'overwrite-server',
      batchId: 'batch-0013',
      clientSequence: 2,
      files: [
        {
          path: taskJsonCurrent.path,
          content: JSON.stringify({ id: 'demo', title: '客户端版本' }),
          baseSha256: taskJsonCurrent.sha256,
        },
        {
          path: prdCurrent.path,
          content: '# 客户端 PRD\n',
          baseSha256: prdCurrent.sha256,
        },
      ],
    })
    assert.equal(result.action, 'overwrite-server')
    assert.equal(result.revision, 3)
    assert.equal(
      db.prepare('SELECT status FROM sync_conflict WHERE id = ?').get(conflict.conflictId).status,
      'resolved',
    )
    const backups = db
      .prepare(
        'SELECT relative_path, old_content, new_content FROM sync_conflict_backup ORDER BY relative_path',
      )
      .all()
    assert.equal(backups.length, 2)
    assert.ok(backups.some((row) => row.old_content === '{"id":"demo","title":"服务端版本"}'))
    assert.ok(backups.some((row) => row.new_content === '{"id":"demo","title":"客户端版本"}'))
  } finally {
    db.close()
  }
})
