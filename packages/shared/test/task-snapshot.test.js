import assert from 'node:assert/strict'
import test from 'node:test'
import {
  classifyTaskSnapshots,
  groupTaskSnapshotFiles,
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
})

test('按完整任务目录分组并提取 task.json id', () => {
  const groups = groupTaskSnapshotFiles([
    file('.trellis/tasks/11-10-demo/task.json', JSON.stringify({ id: 'demo', title: '示例' })),
    file('.trellis/tasks/11-10-demo/prd.md', '# PRD\n'),
  ])
  assert.equal(groups.length, 1)
  assert.equal(groups[0].taskId, 'demo')
  assert.equal(groups[0].files.length, 2)
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
