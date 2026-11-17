import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { performance } from 'node:perf_hooks'

const repoPath = process.env.TRELLIS_E2E_REPO || 'D:\\wit\\mdp-management-web'
const taskSpaceId =
  process.env.TRELLIS_E2E_TASK_SPACE_ID || '9269f774-5cd1-40e9-b3f0-4a5dc998b8b2'
const databaseFile =
  process.env.TRELLIS_E2E_DATABASE ||
  path.join(process.env.LOCALAPPDATA, 'TrellisBoard', 'server', 'board.sqlite')
const timeoutMs = Number(process.env.TRELLIS_E2E_TIMEOUT_MS || 60000)
const taskScript = path.join(repoPath, '.trellis', 'scripts', 'task.py')
const taskRoot = path.join(repoPath, '.trellis', 'tasks')
const db = new DatabaseSync(databaseFile, { readOnly: true })

function currentRevision() {
  return db
    .prepare(
      `SELECT revision, indexed_revision, status, last_error
       FROM sync_task_space
       WHERE id = ?`,
    )
    .get(taskSpaceId)
}

function createAndWait({ slug, title }) {
  const before = currentRevision()
  const startedAt = new Date()
  const started = performance.now()
  const created = spawnSync(
    'python',
    [
      taskScript,
      'create',
      title,
      '--slug',
      slug,
      '--assignee',
      'yhj',
      '--priority',
      'P3',
      '--description',
      '临时验证 Team 服务端增量索引延迟，验证结束后删除。',
      '--no-start',
    ],
    {
      cwd: repoPath,
      encoding: 'utf8',
      windowsHide: true,
    },
  )
  if (created.status !== 0) {
    throw new Error(`任务创建失败：${created.stderr || created.stdout}`)
  }

  const taskDir = fs
    .readdirSync(taskRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(slug))
    .map((entry) => `.trellis/tasks/${entry.name}`)
    .sort()
    .at(-1)
  if (!taskDir) throw new Error(`未找到刚创建的任务目录：${slug}`)

  let revisionObservedAt = null
  let revision = before.revision
  let indexedRevision = before.indexed_revision
  let indexedRow = null
  while (performance.now() - started < timeoutMs) {
    const current = currentRevision()
    revision = current.revision
    indexedRevision = current.indexed_revision
    if (!revisionObservedAt && revision > before.revision) {
      revisionObservedAt = new Date()
    }
    indexedRow = db
      .prepare(
        `SELECT task_key, relative_dir, title, archived
         FROM sync_task_index
         WHERE task_space_id = ? AND title = ?`,
      )
      .get(taskSpaceId, title)
    if (revision > before.revision && indexedRevision >= revision && indexedRow) {
      const finishedAt = new Date()
      return {
        slug,
        title,
        taskDir,
        beforeRevision: before.revision,
        revision,
        indexedRevision,
        revisionLatencyMs: revisionObservedAt
          ? revisionObservedAt.getTime() - startedAt.getTime()
          : null,
        boardVisibleLatencyMs: finishedAt.getTime() - startedAt.getTime(),
        wallClockLatencyMs: Math.round(performance.now() - started),
        startedAt: startedAt.toISOString(),
        boardVisibleAt: finishedAt.toISOString(),
        indexedRow,
      }
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
  }
  const current = currentRevision()
  throw new Error(
    `等待索引超时：slug=${slug} revision=${current.revision} indexed=${current.indexed_revision} error=${current.last_error || ''}`,
  )
}

try {
  const marker =
    process.env.TRELLIS_E2E_MARKER ||
    new Date().toISOString().replace(/\D/g, '').slice(4, 12)
  const count = Number(process.env.TRELLIS_E2E_COUNT || 2)
  const results = []
  if (count >= 2) {
    results.push(
      createAndWait({
        slug: `e2e-index-cold-${marker}`,
        title: `E2E 索引冷启动验证 ${marker}`,
      }),
    )
    results.push(
      createAndWait({
        slug: `e2e-index-warm-${marker}`,
        title: `E2E 索引 warm 验证 ${marker}`,
      }),
    )
  } else {
    results.push(
      createAndWait({
        slug: `e2e-index-${marker}`,
        title: `E2E 索引 warm 验证 ${marker}`,
      }),
    )
  }
  console.log(JSON.stringify(results, null, 2))
} finally {
  db.close()
}
