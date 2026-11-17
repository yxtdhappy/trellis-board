import fs from 'node:fs'
import path from 'node:path'

const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_RETENTION = 7
const SNAPSHOT_PATTERN = /^board\.sqlite\.snapshot\.\d{8}T\d{9}Z$/

function timestamp(now) {
  return now.toISOString().replaceAll('-', '').replaceAll(':', '').replace('.', '')
}

export function createTaskSnapshotBackupService({
  db,
  databaseFile,
  logger = console,
  now = () => new Date(),
  retention = DEFAULT_RETENTION,
  intervalMs = DAY_MS,
}) {
  const backupDir = databaseFile ? path.join(path.dirname(databaseFile), 'backups') : null
  let timer = null

  function snapshots() {
    if (!backupDir || !fs.existsSync(backupDir)) return []
    return fs
      .readdirSync(backupDir)
      .filter((name) => SNAPSHOT_PATTERN.test(name))
      .sort()
  }

  function prune() {
    const files = snapshots()
    for (const name of files.slice(0, Math.max(0, files.length - retention))) {
      fs.rmSync(path.join(backupDir, name), { force: true })
    }
  }

  function latestAge() {
    const latest = snapshots().at(-1)
    if (!latest) return Number.POSITIVE_INFINITY
    return now().getTime() - fs.statSync(path.join(backupDir, latest)).mtimeMs
  }

  function createBackup({ force = false } = {}) {
    if (!databaseFile || databaseFile === ':memory:' || databaseFile.startsWith('file:')) {
      return null
    }
    if (!force && latestAge() < DAY_MS) return null
    fs.mkdirSync(backupDir, { recursive: true })
    const target = path.join(backupDir, `board.sqlite.snapshot.${timestamp(now())}`)
    const quoted = target.replaceAll("'", "''")
    db.exec(`VACUUM INTO '${quoted}'`)
    prune()
    return target
  }

  function safeBackup(options = {}) {
    try {
      return createBackup(options)
    } catch (error) {
      logger.warn('任务快照数据库备份失败', {
        error: error instanceof Error ? error.message : String(error),
      })
      return null
    }
  }

  function start() {
    if (timer || !databaseFile || retention < 1) return
    safeBackup()
    timer = setInterval(safeBackup, intervalMs)
    timer.unref?.()
  }

  function stop() {
    if (!timer) return
    clearInterval(timer)
    timer = null
  }

  return {
    start,
    stop,
    backupNow: safeBackup,
    backupNowOrThrow: createBackup,
    snapshots,
  }
}
