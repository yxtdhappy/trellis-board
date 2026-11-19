import { snapshotSha256 } from '@trellis-board/shared/task-snapshot.js'
import { withTransaction } from '../../database.js'
import { ERROR_CODES, teamError } from '../errors.js'
import { createStatements } from './shared.js'

const ARCHIVE_TASK_DIR = /^\.trellis\/tasks\/archive\/\d{4}-(?:0[1-9]|1[0-2])\/([^/]+)$/

// 任务身份是目录名：task.json 的 id 是 slug，跨日期可重复。
export function activeTaskDirOfArchiveDir(archiveDir) {
  const match = ARCHIVE_TASK_DIR.exec(String(archiveDir || '').trim())
  return match ? `.trellis/tasks/${match[1]}` : null
}

export function archivedActiveTaskDirs(statements, taskSpaceId) {
  return new Set(
    statements.archivedTaskDirs
      .all(taskSpaceId)
      .map((row) => activeTaskDirOfArchiveDir(row.task_dir))
      .filter(Boolean),
  )
}

// 归档只写 sync_archive_file；此前的活跃行必须一并软删除，否则新绑定会把归档任务复活。
export function purgeArchivedTaskFiles(db, taskSpaceId, { now = () => new Date() } = {}) {
  const statements = createStatements(db)
  return withTransaction(db, () => {
    const space = statements.taskSpace.get(taskSpaceId)
    if (!space || space.status === 'disabled' || space.retired_at) {
      return { purged: 0, revision: Number(space?.revision || 0) }
    }
    const revision = Number(space.revision || 0)
    const archivedDirs = [...archivedActiveTaskDirs(statements, taskSpaceId)]
    if (!archivedDirs.length) return { purged: 0, revision }
    const rows = statements.activeFilesInTaskDirs(taskSpaceId, archivedDirs)
    if (!rows.length) return { purged: 0, revision }
    const nextRevision = revision + 1
    const timestamp = now().toISOString()
    const tombstoneSha256 = snapshotSha256('')
    let purged = 0
    for (const row of rows) {
      const result = statements.tombstoneFile.run(
        tombstoneSha256,
        nextRevision,
        timestamp,
        taskSpaceId,
        row.relative_path,
      )
      if (Number(result.changes) !== 1) continue
      purged += 1
      statements.deleteFileAudit.run(
        taskSpaceId,
        row.relative_path,
        row.task_id || null,
        row.sha256,
        nextRevision,
        timestamp,
      )
    }
    const updated = statements.bumpTaskSpaceRevision.run(nextRevision, timestamp, taskSpaceId)
    if (Number(updated.changes) !== 1) {
      throw teamError(409, ERROR_CODES.PROJECT_NOT_READY, '任务空间已停用')
    }
    return { purged, revision: nextRevision }
  })
}
