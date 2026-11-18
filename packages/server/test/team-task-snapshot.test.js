import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { openDatabase } from '../database.js'
import { createTaskSnapshotBackupService } from '../team/task-snapshot-backup.js'
import { createTaskSnapshotService, purgeArchivedTaskFiles } from '../team/task-snapshot-service.js'
import { createTaskSpaceService } from '../team/task-space-service.js'
import {
  ARCHIVE_SYNC_SERVER_MANAGED,
  snapshotSha256,
  TASK_SNAPSHOT_MAX_BATCH_BYTES,
  TASK_SNAPSHOT_MAX_FILE_BYTES,
  TASK_SNAPSHOT_MAX_FILES,
} from '@trellis-board/shared/task-snapshot.js'

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
  return { db, taskSpaces, snapshots, agentA, agentB, taskSpaceId: second.taskSpace.id }
}

function batch(taskId, title, prd = '# PRD\n') {
  return batchWithBranch(taskId, title, 'main', prd)
}

function batchWithBranch(taskId, title, branch, prd = '# PRD\n') {
  return [
    {
      path: `.trellis/tasks/11-10-${taskId}/task.json`,
      content: JSON.stringify({ id: taskId, title, branch }),
      baseSha256: null,
    },
    {
      path: `.trellis/tasks/11-10-${taskId}/prd.md`,
      content: prd,
      baseSha256: null,
    },
  ]
}

function directoryBatch(taskId, fileCount) {
  const taskDir = `.trellis/tasks/11-10-${taskId}`
  return [
    {
      path: `${taskDir}/task.json`,
      content: JSON.stringify({ id: taskId, title: '大任务', branch: 'main' }),
      baseSha256: null,
    },
    ...Array.from({ length: fileCount - 1 }, (_, index) => ({
      path: `${taskDir}/evidence-${index}.md`,
      content: `# 证据 ${index}\n`,
      baseSha256: null,
    })),
  ]
}

function mergeEvidence(taskId, sourceBranch = 'feature/dev1') {
  const taskDir = `.trellis/tasks/11-10-${taskId}`
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

test('Agent 快照与写入边界统一拒绝归档任务', () => {
  const { db, snapshots, agentA, taskSpaceId } = setup()
  const archiveDir = '.trellis/tasks/archive/2026-11/11-16-old'
  const archiveFiles = [
    {
      path: `${archiveDir}/task.json`,
      content: JSON.stringify({ id: 'old', title: '归档任务', branch: 'main' }),
      baseSha256: null,
    },
    {
      path: `${archiveDir}/prd.md`,
      content: '# 旧任务\n',
      baseSha256: null,
    },
  ]
  try {
    snapshots.applyChanges(agentA, taskSpaceId, {
      batchId: 'batch-archive-boundary-active',
      clientSequence: 1,
      files: batch('active', '活动任务'),
    })
    const now = new Date().toISOString()
    db.prepare(`
      INSERT INTO sync_task_space_file(
        task_space_id, relative_path, revision, sha256, content_text, deleted,
        task_id, task_dir, updated_at
      ) VALUES (?, ?, 2, ?, ?, 0, 'old', ?, ?)
    `).run(
      taskSpaceId,
      `${archiveDir}/task.json`,
      snapshotSha256(archiveFiles[0].content),
      archiveFiles[0].content,
      archiveDir,
      now,
    )
    assert.deepEqual(
      snapshots.snapshot(agentA, taskSpaceId).files.map((file) => file.taskDir),
      ['.trellis/tasks/11-10-active', '.trellis/tasks/11-10-active'],
    )
    assert.throws(
      () => snapshots.directorySnapshot(agentA, taskSpaceId, archiveDir),
      (error) => error.status === 409 && error.code === ARCHIVE_SYNC_SERVER_MANAGED,
    )
    assert.throws(
      () =>
        snapshots.applyChanges(agentA, taskSpaceId, {
          batchId: 'batch-archive-boundary-reject',
          clientSequence: 2,
          files: archiveFiles,
        }),
      (error) => error.status === 409 && error.code === ARCHIVE_SYNC_SERVER_MANAGED,
    )
    assert.throws(
      () =>
        snapshots.applyChanges(agentA, taskSpaceId, {
          batchId: 'batch-archive-boundary-mixed',
          clientSequence: 2,
          files: [...batch('mixed', '混合批次'), ...archiveFiles],
        }),
      (error) => error.status === 409 && error.code === ARCHIVE_SYNC_SERVER_MANAGED,
    )
    const preflight = snapshots.preflight(agentA, taskSpaceId, {
      files: [...batch('active', '活动任务'), ...archiveFiles],
    })
    assert.equal(preflight.tasks.length, 1)
    assert.equal(preflight.tasks[0].taskDir, '.trellis/tasks/11-10-active')
    assert.equal(
      db.prepare('SELECT revision FROM sync_task_space WHERE id = ?').get(taskSpaceId).revision,
      1,
    )
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sync_task_space_batch').get().count, 1)
  } finally {
    db.close()
  }
})

test('非递增 clientSequence 返回可恢复序号且不写入部分批次', () => {
  const { db, snapshots, agentA, taskSpaceId } = setup()
  try {
    snapshots.applyChanges(agentA, taskSpaceId, {
      batchId: 'batch-sequence-1',
      clientSequence: 1,
      files: batch('sequence', '首个批次'),
    })
    assert.throws(
      () =>
        snapshots.applyChanges(agentA, taskSpaceId, {
          batchId: 'batch-sequence-stale',
          clientSequence: 1,
          files: batch('sequence', '重复序号'),
        }),
      (error) =>
        error.status === 409 &&
        error.code === 'CONFLICT' &&
        error.details?.previousSequence === 1 &&
        error.details?.requiredClientSequence === 2,
    )
    assert.equal(
      db.prepare('SELECT revision FROM sync_task_space WHERE id = ?').get(taskSpaceId).revision,
      1,
    )
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sync_task_space_batch').get().count, 1)
  } finally {
    db.close()
  }
})

test('上报分支与任务空间不一致时拒绝写入且不推进 revision', () => {
  const { db, snapshots, agentA, taskSpaceId } = setup()
  try {
    assert.throws(
      () =>
        snapshots.applyChanges(agentA, taskSpaceId, {
          batchId: 'batch-invalid-branch',
          clientSequence: 1,
          observedBranchName: 'main..bad',
          files: batch('branch-invalid', '非法分支'),
        }),
      (error) => error.code === 'INVALID_INPUT' && error.status === 400,
    )
    assert.throws(
      () =>
        snapshots.applyChanges(agentA, taskSpaceId, {
          batchId: 'batch-branch',
          clientSequence: 1,
          observedBranchName: 'feature/x',
          files: batch('branch', '分支校验'),
        }),
      (error) => error.code === 'BRANCH_TASK_SPACE_MISMATCH' && error.status === 400,
    )
    assert.equal(
      db.prepare('SELECT revision FROM sync_task_space WHERE id = ?').get(taskSpaceId).revision,
      0,
    )
    assert.equal(
      db
        .prepare('SELECT COUNT(*) AS count FROM sync_task_space_file WHERE task_space_id = ?')
        .get(taskSpaceId).count,
      0,
    )
  } finally {
    db.close()
  }
})

test('完整任务组缺少分支或基线缺少合入证据时整批拒绝', () => {
  const { db, snapshots, agentA, taskSpaceId } = setup()
  try {
    assert.throws(
      () =>
        snapshots.applyChanges(agentA, taskSpaceId, {
          batchId: 'batch-ownership-required',
          clientSequence: 1,
          files: batchWithBranch('ownership-required', '缺少归属', null),
        }),
      (error) =>
        error.status === 409 &&
        error.code === 'TASK_OWNERSHIP_REQUIRED' &&
        error.details?.taskId === 'ownership-required' &&
        error.details?.expectedBranchName === 'main' &&
        error.details?.actualBranchName === null,
    )
    assert.throws(
      () =>
        snapshots.applyChanges(agentA, taskSpaceId, {
          batchId: 'batch-ownership-mismatch',
          clientSequence: 1,
          files: batchWithBranch('ownership-mismatch', '错误归属', 'feature/x'),
        }),
      (error) =>
        error.status === 409 &&
        error.code === 'TASK_MERGE_EVIDENCE_REQUIRED' &&
        error.details?.taskDir === '.trellis/tasks/11-10-ownership-mismatch',
    )
    assert.equal(
      db.prepare('SELECT revision FROM sync_task_space WHERE id = ?').get(taskSpaceId).revision,
      0,
    )
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sync_conflict').get().count, 0)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sync_task_space_batch').get().count, 0)
  } finally {
    db.close()
  }
})

test('基线可凭 tracked-in-head 证据接纳来源分支并拒绝来源副本再写', () => {
  const { db, taskSpaces, snapshots, agentA, agentB, taskSpaceId } = setup()
  try {
    const source = taskSpaces.attach('user-b', agentB.id, {
      remoteUrl: 'https://example.com/acme/repo.git',
      branchName: 'feature/dev1',
      displayName: 'Acme',
      teamId: 'team-1',
      developerId: 'bob',
      localRepoKey: 'c'.repeat(64),
    })
    const sourceFiles = batchWithBranch('merged', '已合并', 'feature/dev1')
    snapshots.applyChanges(agentB, source.taskSpace.id, {
      batchId: 'source-before-merge',
      clientSequence: 1,
      observedBranchName: 'feature/dev1',
      files: sourceFiles,
    })

    assert.throws(
      () =>
        snapshots.applyChanges(agentA, taskSpaceId, {
          batchId: 'baseline-missing-evidence',
          clientSequence: 1,
          observedBranchName: 'main',
          files: batchWithBranch('merged', '已合并', 'feature/dev1'),
        }),
      (error) => error.code === 'TASK_MERGE_EVIDENCE_REQUIRED',
    )

    const accepted = snapshots.applyChanges(agentA, taskSpaceId, {
      batchId: 'baseline-with-evidence',
      clientSequence: 1,
      observedBranchName: 'main',
      mergeEvidence: mergeEvidence('merged'),
      files: batchWithBranch('merged', '已合并', 'feature/dev1'),
    })
    assert.equal(accepted.status, 200)
    assert.equal(
      db
        .prepare("SELECT source_branch_name FROM sync_task_merge_evidence WHERE task_id = 'merged'")
        .get().source_branch_name,
      'feature/dev1',
    )
    const noopEvidence = {
      ...mergeEvidence('merged'),
      headCommit: 'b'.repeat(40),
    }
    const currentHashes = new Map(
      db
        .prepare(`
          SELECT relative_path, sha256
          FROM sync_task_space_file
          WHERE task_space_id = ? AND task_dir = ? AND deleted = 0
        `)
        .all(taskSpaceId, '.trellis/tasks/11-10-merged')
        .map((row) => [row.relative_path, row.sha256]),
    )
    const unchangedFiles = sourceFiles.map((file) => ({
      ...file,
      baseSha256: currentHashes.get(file.path) || null,
    }))
    const noop = snapshots.applyChanges(agentA, taskSpaceId, {
      batchId: 'baseline-evidence-noop',
      clientSequence: 2,
      observedBranchName: 'main',
      mergeEvidence: noopEvidence,
      files: unchangedFiles,
    })
    assert.equal(noop.noop, true)
    assert.equal(noop.revision, accepted.revision)
    assert.equal(
      db.prepare("SELECT head_commit FROM sync_task_merge_evidence WHERE task_id = 'merged'").get()
        .head_commit,
      'b'.repeat(40),
    )

    assert.throws(
      () =>
        snapshots.applyChanges(agentB, source.taskSpace.id, {
          batchId: 'source-after-merge',
          clientSequence: 2,
          observedBranchName: 'feature/dev1',
          files: batchWithBranch('merged', '来源副本修改', 'feature/dev1'),
        }),
      (error) =>
        error.code === 'TASK_OWNED_BY_BASELINE' && error.details?.baselineBranch === 'main',
    )
  } finally {
    db.close()
  }
})

test('合入证据必须与任务基线、目录和来源分支一致', () => {
  const { db, taskSpaces, snapshots, agentA, agentB, taskSpaceId } = setup()
  try {
    const source = taskSpaces.attach('user-b', agentB.id, {
      remoteUrl: 'https://example.com/acme/repo.git',
      branchName: 'feature/dev1',
      displayName: 'Acme',
      teamId: 'team-1',
      developerId: 'bob',
      localRepoKey: 'c'.repeat(64),
    })
    const files = batchWithBranch('evidence-check', '证据校验', 'feature/dev1')
    const invalidCases = [
      { ...mergeEvidence('evidence-check'), taskId: 'other-task' },
      { ...mergeEvidence('evidence-check'), taskDir: '.trellis/tasks/other-task' },
      { ...mergeEvidence('evidence-check'), trackedPath: '.trellis/tasks/other-task/task.json' },
      { ...mergeEvidence('evidence-check'), sourceBranch: 'feature/other' },
      { ...mergeEvidence('evidence-check'), baselineBranch: 'release' },
      { ...mergeEvidence('evidence-check'), headCommit: 'A'.repeat(40) },
    ]
    for (const [index, mergeEvidenceValue] of invalidCases.entries()) {
      assert.throws(
        () =>
          snapshots.applyChanges(agentA, taskSpaceId, {
            batchId: `invalid-evidence-${index}`,
            clientSequence: 1,
            observedBranchName: 'main',
            mergeEvidence: mergeEvidenceValue,
            files,
          }),
        (error) => error.status === 409 || (error.status === 400 && error.code === 'INVALID_INPUT'),
      )
    }
    assert.throws(
      () =>
        snapshots.applyChanges(agentB, source.taskSpace.id, {
          batchId: 'source-declares-merge',
          clientSequence: 1,
          observedBranchName: 'feature/dev1',
          mergeEvidence: mergeEvidence('evidence-check'),
          files,
        }),
      (error) => error.code === 'TASK_MERGE_EVIDENCE_INVALID',
    )
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM sync_task_merge_evidence').get().count,
      0,
    )
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sync_task_space_batch').get().count, 0)
    assert.equal(
      db.prepare('SELECT revision FROM sync_task_space WHERE id = ?').get(taskSpaceId).revision,
      0,
    )
  } finally {
    db.close()
  }
})

test('覆盖服务端冲突时沿用 tracked-in-head 合入证据', () => {
  const { db, snapshots, agentA, taskSpaceId } = setup()
  try {
    const evidence = mergeEvidence('merged-conflict')
    const files = batchWithBranch('merged-conflict', '冲突合入', 'feature/dev1').map((file) => ({
      ...file,
      baseSha256: 'f'.repeat(64),
    }))
    const conflict = snapshots.applyChanges(agentA, taskSpaceId, {
      batchId: 'merge-conflict-stale-base',
      clientSequence: 1,
      observedBranchName: 'main',
      mergeEvidence: evidence,
      files,
    })
    assert.equal(conflict.code, 'TASK_FILE_CONFLICT')
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM sync_task_merge_evidence').get().count,
      0,
    )

    const resolved = snapshots.resolveConflict(agentA, taskSpaceId, conflict.conflictId, {
      action: 'overwrite-server',
      batchId: 'merge-conflict-overwrite',
      clientSequence: 2,
      observedBranchName: 'main',
      mergeEvidence: evidence,
      files,
    })
    assert.equal(resolved.action, 'overwrite-server')
    assert.equal(
      db
        .prepare(
          "SELECT source_branch_name FROM sync_task_merge_evidence WHERE task_id = 'merged-conflict'",
        )
        .get().source_branch_name,
      'feature/dev1',
    )
  } finally {
    db.close()
  }
})

test('任务归属查询返回同项目有效任务空间和只读分支主张', () => {
  const { db, taskSpaces, snapshots, agentA, taskSpaceId } = setup()
  try {
    snapshots.applyChanges(agentA, taskSpaceId, {
      batchId: 'batch-ownership-main',
      clientSequence: 1,
      files: batch('ownership-main', '主分支任务'),
    })
    const feature = taskSpaces.attach('user-a', agentA.id, {
      remoteUrl: 'https://example.com/acme/repo.git',
      branchName: 'feature/x',
      displayName: 'Acme feature',
      teamId: 'team-1',
      developerId: 'alice',
      localRepoKey: 'd'.repeat(64),
    })
    snapshots.applyChanges(agentA, feature.taskSpace.id, {
      batchId: 'batch-ownership-feature',
      clientSequence: 1,
      files: batchWithBranch('feature-task', '功能分支任务', 'feature/x'),
    })
    const result = snapshots.taskOwnership(agentA, taskSpaceId, {
      taskIds: ['ownership-main', 'feature-task', 'missing'],
    })
    assert.deepEqual(
      new Set(result.projectTaskSpaces.map((item) => item.branchName)),
      new Set(['main', 'feature/x']),
    )
    const byTask = new Map(result.tasks.map((item) => [item.taskId, item.claims]))
    assert.deepEqual(byTask.get('ownership-main'), [
      { taskSpaceId, branchName: 'main', taskBranch: 'main' },
    ])
    assert.deepEqual(byTask.get('feature-task'), [
      {
        taskSpaceId: feature.taskSpace.id,
        branchName: 'feature/x',
        taskBranch: 'feature/x',
      },
    ])
    assert.deepEqual(byTask.get('missing'), [])
    assert.throws(
      () => snapshots.taskOwnership(agentA, taskSpaceId, { taskIds: 'task-1' }),
      (error) => error.status === 400 && error.code === 'INVALID_INPUT',
    )
    assert.throws(
      () =>
        snapshots.taskOwnership(agentA, taskSpaceId, {
          taskIds: Array.from({ length: 201 }, (_, index) => `task-${index}`),
        }),
      (error) => error.status === 400 && error.code === 'INVALID_INPUT',
    )
  } finally {
    db.close()
  }
})

test('升级前 pending batch 重试时新增 observedBranchName 不改变幂等摘要', () => {
  const { db, snapshots, agentA, taskSpaceId } = setup()
  try {
    const input = {
      batchId: 'batch-upgrade-replay',
      clientSequence: 1,
      files: batch('upgrade-replay', '升级重放'),
    }
    const first = snapshots.applyChanges(agentA, taskSpaceId, input)
    const replay = snapshots.applyChanges(agentA, taskSpaceId, {
      ...input,
      observedBranchName: 'main',
    })
    assert.equal(first.revision, 1)
    assert.equal(replay.replayed, true)
    assert.equal(replay.revision, 1)
  } finally {
    db.close()
  }
})

test('250 个文件的单任务批次可以一次写入', () => {
  const { db, snapshots, agentA, taskSpaceId } = setup()
  try {
    const files = directoryBatch('large', 250)
    const result = snapshots.applyChanges(agentA, taskSpaceId, {
      batchId: 'batch-0250',
      clientSequence: 1,
      files,
    })
    assert.equal(result.revision, 1)
    assert.equal(snapshots.snapshot(agentA, taskSpaceId).files.length, files.length)
    const preflight = snapshots.preflight(agentA, taskSpaceId, { files })
    assert.equal(preflight.tasks.length, 1)
    assert.equal(preflight.tasks[0].type, 'same')
  } finally {
    db.close()
  }
})

test('超过文件数或正文上限返回 413 且不推进 revision', () => {
  const { db, snapshots, agentA, taskSpaceId } = setup()
  try {
    const tooMany = Array.from({ length: TASK_SNAPSHOT_MAX_FILES + 1 }, (_, index) => ({
      path: `.trellis/tasks/11-10-too-many/file-${index}.md`,
      content: '',
      baseSha256: null,
    }))
    assert.throws(
      () =>
        snapshots.applyChanges(agentA, taskSpaceId, {
          batchId: 'batch-too-many',
          clientSequence: 1,
          files: tooMany,
        }),
      (error) => error.status === 413 && error.code === 'BODY_TOO_LARGE',
    )

    const oneMiB = 'a'.repeat(TASK_SNAPSHOT_MAX_FILE_BYTES)
    const tooLarge = directoryBatch('too-large', 1)
    tooLarge.push(
      ...Array.from(
        { length: TASK_SNAPSHOT_MAX_BATCH_BYTES / TASK_SNAPSHOT_MAX_FILE_BYTES },
        (_, index) => ({
          path: `.trellis/tasks/11-10-too-large/bulk-${index}.md`,
          content: oneMiB,
          baseSha256: null,
        }),
      ),
    )
    assert.throws(
      () =>
        snapshots.applyChanges(agentA, taskSpaceId, {
          batchId: 'batch-too-large',
          clientSequence: 1,
          files: tooLarge,
        }),
      (error) =>
        error.status === 413 && error.code === 'BODY_TOO_LARGE' && /64 MiB/.test(error.message),
    )
    assert.equal(
      db.prepare('SELECT revision FROM sync_task_space WHERE id = ?').get(taskSpaceId).revision,
      0,
    )
    for (const table of [
      'sync_task_space_batch',
      'sync_task_space_file',
      'sync_task_index',
      'sync_file_audit',
    ]) {
      assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0)
    }
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
        content: JSON.stringify({ id: 'demo', title: 'B 修改', branch: 'main' }),
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
          content: JSON.stringify({ id: 'demo', title: 'A 修改', branch: 'main' }),
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

test('同一 Agent 对同一任务的重复冲突复用稳定 ID，列表折叠历史重复项', () => {
  const { db, snapshots, agentA, agentB, taskSpaceId } = setup()
  const taskDir = '.trellis/tasks/11-10-demo'
  try {
    snapshots.applyChanges(agentA, taskSpaceId, {
      batchId: 'batch-stable-conflict-initial',
      clientSequence: 1,
      files: batch('demo', '初始'),
    })
    const original = snapshots.directorySnapshot(agentB, taskSpaceId, taskDir)
    const originalTask = original.files.find((file) => file.path.endsWith('/task.json'))
    const originalPrd = original.files.find((file) => file.path.endsWith('/prd.md'))
    snapshots.applyChanges(agentA, taskSpaceId, {
      batchId: 'batch-stable-conflict-server',
      clientSequence: 2,
      files: [
        {
          path: originalTask.path,
          content: JSON.stringify({ id: 'demo', title: '服务端版本', branch: 'main' }),
          baseSha256: originalTask.sha256,
        },
        { path: originalPrd.path, content: '# 服务端\n', baseSha256: originalPrd.sha256 },
      ],
    })
    const conflictIds = []
    for (let index = 0; index < 10; index += 1) {
      const conflict = snapshots.applyChanges(agentB, taskSpaceId, {
        batchId: `batch-stable-conflict-${index}`,
        clientSequence: index + 1,
        files: [
          {
            path: originalTask.path,
            content: JSON.stringify({ id: 'demo', title: `客户端版本 ${index}`, branch: 'main' }),
            baseSha256: originalTask.sha256,
          },
          { path: originalPrd.path, content: '# 客户端\n', baseSha256: originalPrd.sha256 },
        ],
      })
      conflictIds.push(conflict.conflictId)
    }
    assert.equal(new Set(conflictIds).size, 1)
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM sync_conflict WHERE status = 'pending'").get()
        .count,
      1,
    )

    const stored = db.prepare('SELECT * FROM sync_conflict').get()
    for (let index = 0; index < 50; index += 1) {
      db.prepare(`
        INSERT INTO sync_conflict(
          id, task_space_id, task_id, task_dir, files_json, server_revision,
          client_sequence, batch_id, status, created_by_user_id, created_by_agent_id,
          created_at, resolved_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, NULL)
      `).run(
        `historical-${index}`,
        stored.task_space_id,
        stored.task_id,
        stored.task_dir,
        stored.files_json,
        stored.server_revision,
        stored.client_sequence,
        stored.batch_id,
        stored.created_by_user_id,
        stored.created_by_agent_id,
        new Date(Date.now() + index + 1).toISOString(),
      )
    }
    const listed = snapshots.listConflicts(agentB, taskSpaceId)
    assert.equal(listed.length, 1)
    assert.equal(listed[0].id, 'historical-49')

    db.prepare(
      "UPDATE sync_conflict SET status = 'resolved', resolved_at = ? WHERE task_space_id = ?",
    ).run(new Date().toISOString(), taskSpaceId)
    const next = snapshots.applyChanges(agentB, taskSpaceId, {
      batchId: 'batch-stable-conflict-next',
      clientSequence: 20,
      files: [
        {
          path: originalTask.path,
          content: JSON.stringify({ id: 'demo', title: '新冲突', branch: 'main' }),
          baseSha256: originalTask.sha256,
        },
        { path: originalPrd.path, content: '# 新冲突\n', baseSha256: originalPrd.sha256 },
      ],
    })
    assert.equal(next.code, 'TASK_FILE_CONFLICT')
    assert.notEqual(next.conflictId, listed[0].id)
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
              content: JSON.stringify({ id: 'other', title: '示例', branch: 'main' }),
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
          content: JSON.stringify({ id: 'demo', title: '服务端版本', branch: 'main' }),
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
          content: JSON.stringify({ id: 'demo', title: '客户端版本', branch: 'main' }),
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
          content: JSON.stringify({ id: 'demo', title: '客户端版本', branch: 'main' }),
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
    assert.ok(
      backups.some(
        (row) => row.old_content === '{"id":"demo","title":"服务端版本","branch":"main"}',
      ),
    )
    assert.ok(
      backups.some(
        (row) => row.new_content === '{"id":"demo","title":"客户端版本","branch":"main"}',
      ),
    )
  } finally {
    db.close()
  }
})

test('250 个文件的单任务目录可通过 preflight 和覆盖冲突处理', () => {
  const { db, snapshots, agentA, agentB, taskSpaceId } = setup()
  const taskDir = '.trellis/tasks/11-10-large-conflict'
  try {
    const initialFiles = directoryBatch('large-conflict', 250)
    snapshots.applyChanges(agentA, taskSpaceId, {
      batchId: 'batch-large-conflict-1',
      clientSequence: 1,
      files: initialFiles,
    })
    const initialDirectory = snapshots.directorySnapshot(agentB, taskSpaceId, taskDir)
    const clientFiles = initialDirectory.files.map(({ path, content, sha256 }) => ({
      path,
      content,
      sha256,
      baseSha256: sha256,
    }))
    const preflight = snapshots.preflight(agentB, taskSpaceId, { files: clientFiles })
    assert.equal(preflight.tasks.length, 1)
    assert.equal(preflight.tasks[0].type, 'same')

    const taskJson = clientFiles.find((file) => file.path.endsWith('/task.json'))
    snapshots.applyChanges(agentA, taskSpaceId, {
      batchId: 'batch-large-conflict-2',
      clientSequence: 2,
      files: [
        {
          path: taskJson.path,
          content: JSON.stringify({ id: 'large-conflict', title: '服务端版本', branch: 'main' }),
          baseSha256: taskJson.sha256,
        },
      ],
    })
    const conflict = snapshots.applyChanges(agentB, taskSpaceId, {
      batchId: 'batch-large-conflict-3',
      clientSequence: 1,
      files: clientFiles,
    })
    assert.equal(conflict.code, 'TASK_FILE_CONFLICT')

    const current = snapshots.directorySnapshot(agentB, taskSpaceId, taskDir)
    const overwriteFiles = current.files.map(({ path, content, sha256 }) => ({
      path,
      content: path.endsWith('/task.json')
        ? JSON.stringify({ id: 'large-conflict', title: '客户端版本', branch: 'main' })
        : content,
      baseSha256: sha256,
    }))
    const resolved = snapshots.resolveConflict(agentB, taskSpaceId, conflict.conflictId, {
      action: 'overwrite-server',
      batchId: 'batch-large-conflict-4',
      clientSequence: 2,
      files: overwriteFiles,
    })
    assert.equal(resolved.action, 'overwrite-server')
    assert.equal(resolved.revision, 3)
    assert.equal(resolved.backupPaths.length, 250)
    assert.equal(snapshots.directorySnapshot(agentB, taskSpaceId, taskDir).files.length, 250)
    assert.equal(
      db.prepare('SELECT status FROM sync_conflict WHERE id = ?').get(conflict.conflictId).status,
      'resolved',
    )
  } finally {
    db.close()
  }
})

function insertArchiveRow(db, taskSpaceId, archiveDir, content, taskId = 'unrelated-slug') {
  db.prepare(`
    INSERT INTO sync_archive_file(
      id, task_space_id, relative_path, blob_oid, sha256, content_text,
      task_id, task_dir, source_head, updated_at
    ) VALUES (?, ?, ?, 'blob', ?, ?, ?, ?, 'head', ?)
  `).run(
    `archive-${archiveDir.replaceAll('/', '-')}`,
    taskSpaceId,
    `${archiveDir}/task.json`,
    snapshotSha256(content),
    content,
    taskId,
    archiveDir,
    new Date().toISOString(),
  )
}

test('归档同步按目录名清理残留活跃行并下发墓碑', () => {
  const { db, snapshots, agentA, taskSpaceId } = setup()
  const archiveDir = '.trellis/tasks/archive/2026-11/11-10-demo'
  try {
    snapshots.applyChanges(agentA, taskSpaceId, {
      batchId: 'batch-purge-1',
      clientSequence: 1,
      files: batch('demo', '示例'),
    })
    // task_id 故意与活跃行不同：匹配必须走目录名。
    insertArchiveRow(
      db,
      taskSpaceId,
      archiveDir,
      JSON.stringify({ id: 'demo', title: '示例', branch: 'main' }),
    )

    const purged = purgeArchivedTaskFiles(db, taskSpaceId)
    assert.deepEqual(purged, { purged: 2, revision: 2 })
    assert.equal(
      db.prepare('SELECT revision FROM sync_task_space WHERE id = ?').get(taskSpaceId).revision,
      2,
    )
    const rows = db
      .prepare(
        'SELECT deleted, content_text, sha256 FROM sync_task_space_file WHERE task_space_id = ? ORDER BY relative_path',
      )
      .all(taskSpaceId)
    assert.deepEqual(
      rows.map((row) => [row.deleted, row.content_text, row.sha256]),
      [
        [1, null, snapshotSha256('')],
        [1, null, snapshotSha256('')],
      ],
    )
    const audits = db
      .prepare(
        "SELECT relative_path, operation, new_sha256 FROM sync_file_audit WHERE operation = 'delete' ORDER BY relative_path",
      )
      .all()
    assert.deepEqual(
      audits.map((row) => [row.relative_path, row.new_sha256]),
      [
        ['.trellis/tasks/11-10-demo/prd.md', null],
        ['.trellis/tasks/11-10-demo/task.json', null],
      ],
    )
    assert.deepEqual(snapshots.snapshot(agentA, taskSpaceId).files, [])
    // 客户端本地没有副本时也不再被判为「仅服务端」，避免又被写回本地。
    assert.deepEqual(snapshots.preflight(agentA, taskSpaceId, { files: [] }).tasks, [])
    const incremental = snapshots.snapshot(agentA, taskSpaceId, { afterRevision: 1 })
    assert.deepEqual(
      incremental.files.map((file) => [file.path, file.deleted]),
      [
        ['.trellis/tasks/11-10-demo/prd.md', true],
        ['.trellis/tasks/11-10-demo/task.json', true],
      ],
    )
    assert.equal(purgeArchivedTaskFiles(db, taskSpaceId).purged, 0)
    assert.equal(
      db.prepare('SELECT revision FROM sync_task_space WHERE id = ?').get(taskSpaceId).revision,
      2,
    )
    // 归档行目录名与活跃行不同时不得误清。
    insertArchiveRow(db, taskSpaceId, '.trellis/tasks/archive/2026-11/11-11-other', '{}')
    assert.deepEqual(purgeArchivedTaskFiles(db, taskSpaceId), { purged: 0, revision: 2 })
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM sync_file_audit WHERE operation = 'delete'").get()
        .count,
      2,
    )
  } finally {
    db.close()
  }
})

test('归档任务拒绝活跃上传但允许删除', () => {
  const { db, snapshots, agentA, taskSpaceId } = setup()
  const taskDir = '.trellis/tasks/11-10-demo'
  try {
    snapshots.applyChanges(agentA, taskSpaceId, {
      batchId: 'batch-guard-1',
      clientSequence: 1,
      files: batch('demo', '示例'),
    })
    insertArchiveRow(
      db,
      taskSpaceId,
      '.trellis/tasks/archive/2026-11/11-10-demo',
      JSON.stringify({ id: 'demo', title: '示例', branch: 'main' }),
    )
    assert.throws(
      () =>
        snapshots.applyChanges(agentA, taskSpaceId, {
          batchId: 'batch-guard-reject',
          clientSequence: 2,
          files: batch('demo', '示例'),
        }),
      (error) => error.status === 409 && error.code === ARCHIVE_SYNC_SERVER_MANAGED,
    )
    const uploaded = snapshots.snapshot(agentA, taskSpaceId).files
    const removed = snapshots.applyChanges(agentA, taskSpaceId, {
      batchId: 'batch-guard-delete',
      clientSequence: 2,
      files: uploaded.map((file) => ({
        path: file.path,
        content: '',
        sha256: snapshotSha256(''),
        baseSha256: file.sha256,
        deleted: true,
      })),
    })
    assert.equal(removed.revision, 2)
    assert.equal(snapshots.directorySnapshot(agentA, taskSpaceId, taskDir).files.length, 0)
  } finally {
    db.close()
  }
})
