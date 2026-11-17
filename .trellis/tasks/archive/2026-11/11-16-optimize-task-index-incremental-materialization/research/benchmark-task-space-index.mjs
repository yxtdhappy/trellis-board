import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openDatabase } from '../../../../packages/server/database.js'
import { STAGE_IDS } from '../../../../packages/server/metadata.js'
import { createTaskSpaceService } from '../../../../packages/server/team/task-space-service.js'
import { createTaskSpaceIndex } from '../../../../packages/server/team/task-space-index.js'
import { snapshotSha256 } from '../../../../packages/shared/task-snapshot.js'

const localAppData =
  process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
const sourceFile =
  process.env.TRELLIS_BENCH_SOURCE ||
  path.join(localAppData, 'TrellisBoard', 'server', 'board.sqlite')
const warmRuns = Number(process.env.TRELLIS_BENCH_RUNS || 20)
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-index-benchmark-'))
const copiedFile = path.join(tempRoot, 'board.sqlite')

function percentile(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))]
}

try {
  const source = new DatabaseSync(sourceFile)
  source.exec(`VACUUM INTO '${copiedFile.replaceAll("'", "''")}'`)
  source.close()

  const db = openDatabase({
    databaseFile: copiedFile,
    fallbackRepositories: [],
    importLegacyRepositories: false,
    legacyJsonImport: false,
  })
  const taskSpaces = createTaskSpaceService({ db })
  const taskSpace = db
    .prepare(`
      SELECT s.id, COUNT(*) AS task_count
      FROM sync_task_space s
      JOIN sync_task_index t ON t.task_space_id = s.id
      GROUP BY s.id
      ORDER BY task_count DESC, s.id
      LIMIT 1
    `)
    .get()
  if (!taskSpace) throw new Error('测试快照没有可用的 taskSpace')
  const selected = db
    .prepare(`
      SELECT task_dir, relative_path, content_text
      FROM sync_task_space_file
      WHERE task_space_id = ? AND deleted = 0
        AND relative_path = task_dir || '/task.json'
      ORDER BY relative_path
      LIMIT 1
    `)
    .get(taskSpace.id)
  if (!selected) throw new Error('测试快照没有 task.json')

  const index = createTaskSpaceIndex({
    db,
    stageIds: STAGE_IDS,
    taskSpaces,
    logger: {
      warn() {},
      info() {},
    },
  })

  try {
    const full = await index.materializeNow(taskSpace.id)
    const runs = []
    for (let tick = 1; tick <= warmRuns; tick += 1) {
      const taskJson = JSON.parse(
        db
          .prepare(
            `SELECT content_text FROM sync_task_space_file
             WHERE task_space_id = ? AND relative_path = ?`,
          )
          .get(taskSpace.id, selected.relative_path).content_text,
      )
      taskJson.benchmarkTick = tick
      const content = JSON.stringify(taskJson)
      const sha256 = snapshotSha256(content)
      const revision = Number(
        db.prepare('SELECT revision FROM sync_task_space WHERE id = ?').get(taskSpace.id)
          .revision + 1,
      )
      const timestamp = new Date().toISOString()
      db.exec('BEGIN IMMEDIATE')
      try {
        db.prepare(`
          UPDATE sync_task_space_file
          SET revision = ?, sha256 = ?, content_text = ?, updated_at = ?
          WHERE task_space_id = ? AND relative_path = ?
        `).run(
          revision,
          sha256,
          content,
          timestamp,
          taskSpace.id,
          selected.relative_path,
        )
        db.prepare(`
          UPDATE sync_task_space
          SET revision = ?, status = 'indexing', updated_at = ?
          WHERE id = ?
        `).run(revision, timestamp, taskSpace.id)
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
      const result = await index.materializeNow(taskSpace.id)
      if (result.superseded) throw new Error(`benchmark revision ${revision} superseded`)
      if (result.stats.mode !== 'incremental') {
        throw new Error(`benchmark revision ${revision} 未走增量模式`)
      }
      if (result.stats.changedTaskCount !== 1 || result.stats.scannedTaskCount !== 1) {
        throw new Error(`benchmark revision ${revision} 扫描范围不符合预期`)
      }
      runs.push(result.stats.totalMs)
    }
    process.stdout.write(
      `${JSON.stringify({
        source: path.basename(sourceFile),
        taskSpaceId: taskSpace.id,
        taskCount: taskSpace.task_count,
        full: full.stats,
        warmRuns,
        warmP50Ms: percentile(runs, 0.5),
        warmP95Ms: percentile(runs, 0.95),
        warmMinMs: Math.min(...runs),
        warmMaxMs: Math.max(...runs),
      }, null, 2)}\n`,
    )
  } finally {
    await index.close()
    db.close()
  }
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true })
}
