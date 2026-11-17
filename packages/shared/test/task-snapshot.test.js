import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ARCHIVE_SYNC_SERVER_MANAGED,
  assertActiveTaskDirectory,
  assertActiveTaskPath,
  classifyTaskSnapshots,
  groupTaskSnapshotFiles,
  isArchiveTaskDirectory,
  isArchiveTaskPath,
  normalizeSnapshotPath,
  snapshotSha256,
  TASK_SNAPSHOT_MAX_BATCH_BYTES,
  TASK_SNAPSHOT_MAX_FILE_BYTES,
  TASK_SNAPSHOT_MAX_FILES,
  taskDirectoryFromPath,
} from '../task-snapshot.js'

function file(path, content, extra = {}) {
  return { path, content, sha256: snapshotSha256(content), ...extra }
}

test('只接受 tasks 下的文本任务文件', () => {
  assert.equal(
    normalizeSnapshotPath('.trellis/tasks/11-10-demo/prd.md'),
    '.trellis/tasks/11-10-demo/prd.md',
  )
  for (const value of [
    '.trellis/tasks/../secret.md',
    '.trellis/workspace/yhj/index.md',
    '.codex/config.json',
    '.trellis/tasks/11-10-demo/image.png',
  ]) {
    assert.throws(() => normalizeSnapshotPath(value))
  }
})

test('识别活动目录和归档目录', () => {
  assert.deepEqual(taskDirectoryFromPath('.trellis/tasks/11-10-demo/prd.md'), {
    taskDir: '.trellis/tasks/11-10-demo',
    filePath: 'prd.md',
    archived: false,
    archiveMonth: null,
  })
  assert.equal(
    taskDirectoryFromPath('.trellis/tasks/archive/2026-11/11-10-demo/task.json').archived,
    true,
  )
  assert.equal(isArchiveTaskDirectory('.trellis/tasks/archive/2026-11/11-10-demo'), true)
  assert.equal(isArchiveTaskDirectory('.trellis/tasks/archive/2026-13/11-10-demo'), false)
  assert.equal(isArchiveTaskDirectory('.trellis/tasks/11-10-demo'), false)
  assert.equal(isArchiveTaskPath('.trellis/tasks/archive/2026-11/11-10-demo/prd.md'), true)
  assert.equal(isArchiveTaskPath('.trellis/tasks/11-10-demo/prd.md'), false)
  assert.throws(() => taskDirectoryFromPath('.trellis/tasks/archive/2026-13/demo/prd.md'))
  assert.throws(
    () => assertActiveTaskDirectory('.trellis/tasks/archive/2026-11/11-10-demo'),
    (error) => error.code === ARCHIVE_SYNC_SERVER_MANAGED,
  )
  assert.throws(
    () => assertActiveTaskPath('.trellis/tasks/archive/2026-11/11-10-demo/prd.md'),
    (error) => error.code === ARCHIVE_SYNC_SERVER_MANAGED,
  )
  assert.equal(
    assertActiveTaskPath('.trellis/tasks/11-10-demo/prd.md'),
    '.trellis/tasks/11-10-demo/prd.md',
  )
})

test('按完整任务目录分组并提取 task.json 元数据', () => {
  const groups = groupTaskSnapshotFiles([
    file(
      '.trellis/tasks/11-10-demo/task.json',
      JSON.stringify({ id: 'demo', title: '示例', branch: ' main ' }),
    ),
    file('.trellis/tasks/11-10-demo/prd.md', '# PRD\n'),
  ])
  assert.equal(groups.length, 1)
  assert.equal(groups[0].taskId, 'demo')
  assert.equal(groups[0].taskBranch, 'main')
  assert.equal(groups[0].files.length, 2)
})

test('task.json 分支缺失、非法或非字符串时按未归属处理', () => {
  const groups = groupTaskSnapshotFiles([
    file('.trellis/tasks/11-10-empty/task.json', JSON.stringify({ id: 'empty', branch: '  ' })),
    file('.trellis/tasks/11-10-number/task.json', JSON.stringify({ id: 'number', branch: 1 })),
    file('.trellis/tasks/11-10-invalid/task.json', '{invalid'),
    file(
      '.trellis/tasks/archive/2026-11/11-10-archive/task.json',
      JSON.stringify({ id: 'archive', branch: 'feature/x' }),
    ),
  ])
  const byDir = new Map(groups.map((group) => [group.taskDir, group]))
  assert.equal(byDir.get('.trellis/tasks/11-10-empty').taskBranch, null)
  assert.equal(byDir.get('.trellis/tasks/11-10-number').taskBranch, null)
  assert.equal(byDir.get('.trellis/tasks/11-10-invalid').taskId, null)
  assert.equal(byDir.get('.trellis/tasks/archive/2026-11/11-10-archive').taskBranch, 'feature/x')
})

test('CRLF 与 LF 规范化为同一摘要', () => {
  assert.equal(snapshotSha256('a\r\nb\r\n'), snapshotSha256('a\nb\n'))
})

test('拒绝内容与摘要不一致和非标准基线摘要', () => {
  assert.throws(
    () =>
      groupTaskSnapshotFiles([
        {
          path: '.trellis/tasks/11-10-demo/task.json',
          content: '{"id":"demo"}\n',
          sha256: 'a'.repeat(64),
        },
      ]),
    /摘要与内容不一致/,
  )
  assert.throws(
    () =>
      groupTaskSnapshotFiles([
        {
          path: '.trellis/tasks/11-10-demo/prd.md',
          content: '# PRD\n',
          baseSha256: 'not-a-sha',
        },
      ]),
    /基线摘要无效/,
  )
})

test('同一批次拒绝重复文件路径', () => {
  assert.throws(
    () =>
      groupTaskSnapshotFiles([
        file('.trellis/tasks/11-10-demo/task.json', JSON.stringify({ id: 'demo' })),
        file('.trellis/tasks/11-10-demo/task.json', JSON.stringify({ id: 'demo-2' })),
      ]),
    /路径不能重复/,
  )
})

test('单批允许 1024 个文件并拒绝第 1025 个', () => {
  const files = Array.from({ length: TASK_SNAPSHOT_MAX_FILES }, (_, index) => ({
    path: `.trellis/tasks/11-10-demo/file-${index}.md`,
    content: '',
  }))
  const groups = groupTaskSnapshotFiles(files)
  assert.equal(groups[0].files.length, TASK_SNAPSHOT_MAX_FILES)
  assert.throws(
    () =>
      groupTaskSnapshotFiles([
        ...files,
        { path: '.trellis/tasks/11-10-demo/file-overflow.md', content: '' },
      ]),
    /不能超过 1024 个/,
  )
  const unlimited = groupTaskSnapshotFiles(files, {
    maxFiles: Number.POSITIVE_INFINITY,
    maxBytes: Number.POSITIVE_INFINITY,
  })
  assert.equal(unlimited[0].files.length, TASK_SNAPSHOT_MAX_FILES)
})

test('单批正文允许 64 MiB 并拒绝多 1 字节', () => {
  const content = 'a'.repeat(TASK_SNAPSHOT_MAX_FILE_BYTES)
  const files = Array.from(
    { length: TASK_SNAPSHOT_MAX_BATCH_BYTES / TASK_SNAPSHOT_MAX_FILE_BYTES },
    (_, index) => ({
      path: `.trellis/tasks/11-10-demo/bulk-${index}.md`,
      content,
    }),
  )
  const groups = groupTaskSnapshotFiles(files)
  assert.equal(groups[0].files.length, 64)
  assert.equal(
    groups[0].files.reduce((total, file) => total + Buffer.byteLength(file.content), 0),
    TASK_SNAPSHOT_MAX_BATCH_BYTES,
  )
  assert.throws(
    () =>
      groupTaskSnapshotFiles([
        ...files,
        { path: '.trellis/tasks/11-10-demo/one-more-byte.md', content: 'a' },
      ]),
    /超过 64 MiB/,
  )
  assert.throws(
    () =>
      groupTaskSnapshotFiles([
        {
          path: '.trellis/tasks/11-10-demo/too-large.md',
          content: 'a'.repeat(TASK_SNAPSHOT_MAX_FILE_BYTES + 1),
        },
      ]),
    /单个任务文件超过 1 MiB/,
  )
})

test('首次接入差异按任务分类', () => {
  const local = groupTaskSnapshotFiles([
    file('.trellis/tasks/11-10-a/task.json', JSON.stringify({ id: 'a' })),
    file('.trellis/tasks/11-10-a/prd.md', 'local'),
  ])
  const server = groupTaskSnapshotFiles([
    file('.trellis/tasks/11-10-a/task.json', JSON.stringify({ id: 'a' })),
    file('.trellis/tasks/11-10-a/prd.md', 'server'),
    file('.trellis/tasks/archive/2026-11/11-10-b/task.json', JSON.stringify({ id: 'b' })),
  ])
  const result = classifyTaskSnapshots(local, server)
  assert.deepEqual(result.map((item) => item.type).sort(), ['content-conflict', 'server-only'])
})

test('重复 task ID 和同目录不同 task ID 均标记为 invalid，不能自动同步', () => {
  const duplicateLocal = groupTaskSnapshotFiles([
    file('.trellis/tasks/11-10-a/task.json', JSON.stringify({ id: 'duplicate' })),
    file('.trellis/tasks/11-10-b/task.json', JSON.stringify({ id: 'duplicate' })),
  ])
  const duplicateResult = classifyTaskSnapshots(duplicateLocal, [])
  assert.equal(duplicateResult.length, 2)
  assert.ok(duplicateResult.every((item) => item.type === 'invalid'))
  assert.deepEqual(duplicateResult.map((item) => item.taskDir).sort(), [
    '.trellis/tasks/11-10-a',
    '.trellis/tasks/11-10-b',
  ])

  const sameDirectoryLocal = groupTaskSnapshotFiles([
    file('.trellis/tasks/11-10-a/task.json', JSON.stringify({ id: 'local-id' })),
  ])
  const sameDirectoryServer = groupTaskSnapshotFiles([
    file('.trellis/tasks/11-10-a/task.json', JSON.stringify({ id: 'server-id' })),
  ])
  const collisionResult = classifyTaskSnapshots(sameDirectoryLocal, sameDirectoryServer)
  assert.equal(collisionResult.length, 1)
  assert.equal(collisionResult[0].type, 'invalid')
  assert.equal(collisionResult[0].local.taskId, 'local-id')
  assert.equal(collisionResult[0].server.taskId, 'server-id')
})
