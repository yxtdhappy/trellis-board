import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { DatabaseSync } from 'node:sqlite'
import { withTransaction } from '../apps/server/database.js'

const DEFAULT_PORT = 4317

function requiredId(value, label) {
  const text = String(value || '').trim()
  if (!text) throw new Error(`${label}不能为空`)
  return text
}

function activeTaskDirectory(taskDir) {
  const parts = String(taskDir || '').split('/')
  return parts.length === 3 && parts[0] === '.trellis' && parts[1] === 'tasks' && parts[2]
}

function parseTaskId(content) {
  try {
    const value = JSON.parse(String(content || ''))
    return typeof value?.id === 'string' && value.id.trim() ? value.id.trim() : null
  } catch {
    return null
  }
}

function contentDigest(files) {
  const manifest = [...files]
    .sort((left, right) => left.relative_path.localeCompare(right.relative_path))
    .map((file) => `${file.relative_path}\0${file.sha256}`)
    .join('\n')
  return crypto.createHash('sha256').update(manifest).digest('hex')
}

function sourceLabel(row) {
  return (
    row.source_display_name ||
    row.source_username ||
    row.source_device_name ||
    row.source_user_id ||
    row.source_agent_id ||
    '未知来源'
  )
}

function taskSpaceSummary(taskSpace) {
  return {
    id: taskSpace.id,
    branchName: taskSpace.branch_name,
    projectId: taskSpace.project_id,
    projectStatus: taskSpace.project_status,
    status: taskSpace.status,
    revision: Number(taskSpace.revision),
  }
}

function optionalText(value) {
  const text = value == null ? '' : String(value).trim()
  return text || null
}

function loadConflictAudit(db, taskSpaces) {
  const sideById = new Map(taskSpaces.map(({ side, taskSpace }) => [taskSpace.id, side]))
  const placeholders = taskSpaces.map(() => '?').join(', ')
  const rows = db
    .prepare(`
      SELECT rowid AS conflict_rowid, id, task_space_id, task_id, task_dir,
             created_by_agent_id, created_at
      FROM sync_conflict
      WHERE task_space_id IN (${placeholders}) AND status = 'pending'
    `)
    .all(...taskSpaces.map(({ taskSpace }) => taskSpace.id))
  const grouped = new Map()
  for (const row of rows) {
    const agentId = optionalText(row.created_by_agent_id)
    const taskId = optionalText(row.task_id)
    const taskDir = optionalText(row.task_dir)
    const taskIdentity = taskId || taskDir || `conflict:${row.id}`
    const key = `${row.task_space_id}\0${agentId || ''}\0${taskIdentity}`
    const group = grouped.get(key) || {
      side: sideById.get(row.task_space_id),
      taskSpaceId: row.task_space_id,
      agentId,
      taskId,
      taskDir,
      rows: [],
    }
    group.rows.push(row)
    grouped.set(key, group)
  }

  const groups = [...grouped.values()].map((group) => {
    group.rows.sort(
      (left, right) =>
        String(right.created_at).localeCompare(String(left.created_at)) ||
        Number(right.conflict_rowid) - Number(left.conflict_rowid),
    )
    return {
      side: group.side,
      taskSpaceId: group.taskSpaceId,
      agentId: group.agentId,
      taskId: optionalText(group.rows[0].task_id),
      taskDir: optionalText(group.rows[0].task_dir),
      pendingRows: group.rows.length,
      duplicateRows: group.rows.length - 1,
      keepConflictId: group.rows[0].id,
      resolveConflictIds: group.rows.slice(1).map((row) => row.id),
    }
  })
  groups.sort(
    (left, right) =>
      left.taskSpaceId.localeCompare(right.taskSpaceId) ||
      String(left.agentId || '').localeCompare(String(right.agentId || '')) ||
      String(left.taskId || left.taskDir || '').localeCompare(
        String(right.taskId || right.taskDir || ''),
      ),
  )

  const byTaskSpace = {}
  for (const { side, taskSpace } of taskSpaces) {
    const scopedGroups = groups.filter((group) => group.taskSpaceId === taskSpace.id)
    const pendingConflicts = scopedGroups.reduce((total, group) => total + group.pendingRows, 0)
    byTaskSpace[side] = {
      taskSpaceId: taskSpace.id,
      pendingConflicts,
      conflictGroups: scopedGroups.length,
      duplicateConflictGroups: scopedGroups.filter((group) => group.duplicateRows > 0).length,
      duplicateConflictRows: pendingConflicts - scopedGroups.length,
    }
  }

  return {
    pendingConflicts: rows.length,
    conflictGroups: groups.length,
    duplicateConflictGroups: groups.filter((group) => group.duplicateRows > 0).length,
    duplicateConflictRows: rows.length - groups.length,
    conflictsToResolve: rows.length - groups.length,
    byTaskSpace,
    groups,
  }
}

function loadTaskSpace(db, taskSpaceId, projectId, label) {
  const taskSpace = db
    .prepare(`
      SELECT s.*, p.status AS project_status, p.name AS project_name
      FROM sync_task_space s
      JOIN sync_project p ON p.id = s.project_id
      WHERE s.id = ? AND s.project_id = ?
    `)
    .get(taskSpaceId, projectId)
  if (!taskSpace) throw new Error(`${label}任务空间不存在或不属于指定项目`)
  return taskSpace
}

function taskGroups(db, taskSpaceId) {
  const rows = db
    .prepare(`
      SELECT f.*, u.username AS source_username, u.display_name AS source_display_name,
             a.device_name AS source_device_name
      FROM sync_task_space_file f
      LEFT JOIN user_account u ON u.id = f.source_user_id
      LEFT JOIN agent_device a ON a.id = f.source_agent_id
      WHERE f.task_space_id = ? AND f.deleted = 0
      ORDER BY f.task_dir, f.relative_path
    `)
    .all(taskSpaceId)

  const groups = new Map()
  for (const row of rows) {
    if (!activeTaskDirectory(row.task_dir)) continue
    const files = groups.get(row.task_dir) || []
    files.push(row)
    groups.set(row.task_dir, files)
  }
  return groups
}

function describeGroup(group) {
  const taskJson = group.files.find((file) => file.relative_path === `${group.taskDir}/task.json`)
  const taskId = taskJson ? parseTaskId(taskJson.content_text) : null
  const sourceNames = [...new Set(group.files.map(sourceLabel))].sort()
  return {
    taskId,
    taskDir: group.taskDir,
    files: group.files.length,
    lastRevision: Math.max(...group.files.map((file) => Number(file.revision))),
    contentDigest: contentDigest(group.files),
    sources: sourceNames,
    rows: group.files,
  }
}

export function analyzeDuplicateTasks(
  db,
  { projectId, removeTaskSpaceId, keepTaskSpaceId, disableRemoveTaskSpace = false },
) {
  projectId = requiredId(projectId, '项目 ID')
  removeTaskSpaceId = requiredId(removeTaskSpaceId, '待清理任务空间 ID')
  keepTaskSpaceId = requiredId(keepTaskSpaceId, '保留任务空间 ID')
  if (removeTaskSpaceId === keepTaskSpaceId) {
    throw new Error('待清理任务空间和保留任务空间不能相同')
  }

  const removeTaskSpace = loadTaskSpace(db, removeTaskSpaceId, projectId, '待清理')
  const keepTaskSpace = loadTaskSpace(db, keepTaskSpaceId, projectId, '保留')
  const unresolved = []
  const indexes = new Map()
  for (const [side, taskSpace] of [
    ['remove', removeTaskSpace],
    ['keep', keepTaskSpace],
  ]) {
    const map = new Map()
    for (const [taskDir, files] of taskGroups(db, taskSpace.id)) {
      const group = describeGroup({ taskDir, files })
      if (!group.taskId) {
        unresolved.push({
          taskSpaceId: taskSpace.id,
          side,
          taskDir,
          reason: `${taskDir}/task.json 缺失或没有稳定任务 ID`,
        })
        continue
      }
      map.set(`${group.taskId}\0${taskDir}`, group)
    }
    indexes.set(side, map)
  }

  const duplicates = []
  for (const [key, removeGroup] of indexes.get('remove')) {
    const keepGroup = indexes.get('keep').get(key)
    if (!keepGroup) continue
    const removeByPath = new Map(removeGroup.rows.map((row) => [row.relative_path, row.sha256]))
    const keepByPath = new Map(keepGroup.rows.map((row) => [row.relative_path, row.sha256]))
    const allPaths = new Set([...removeByPath.keys(), ...keepByPath.keys()])
    const differences = [...allPaths]
      .filter((relativePath) => removeByPath.get(relativePath) !== keepByPath.get(relativePath))
      .sort()
    duplicates.push({
      taskId: removeGroup.taskId,
      taskDir: removeGroup.taskDir,
      identical: differences.length === 0,
      contentDifferences: differences,
      remove: {
        files: removeGroup.files,
        lastRevision: removeGroup.lastRevision,
        contentDigest: removeGroup.contentDigest,
        sources: removeGroup.sources,
      },
      keep: {
        files: keepGroup.files,
        lastRevision: keepGroup.lastRevision,
        contentDigest: keepGroup.contentDigest,
        sources: keepGroup.sources,
      },
    })
  }
  duplicates.sort((left, right) => left.taskDir.localeCompare(right.taskDir))
  const filesToDelete = duplicates.flatMap((duplicate) =>
    indexes
      .get('remove')
      .get(`${duplicate.taskId}\0${duplicate.taskDir}`)
      .rows.map((row) => ({
        path: row.relative_path,
        taskId: duplicate.taskId,
        taskDir: duplicate.taskDir,
        revision: Number(row.revision),
        sha256: row.sha256,
      })),
  )
  const conflicts = loadConflictAudit(db, [
    { side: 'remove', taskSpace: removeTaskSpace },
    { side: 'keep', taskSpace: keepTaskSpace },
  ])
  // 未显式停用时保留旧工具将清理空间置为 indexing 的既有行为。
  const targetStatus = disableRemoveTaskSpace
    ? 'disabled'
    : duplicates.length
      ? 'indexing'
      : removeTaskSpace.status

  return {
    projectId,
    remove: {
      ...taskSpaceSummary(removeTaskSpace),
      targetStatus,
    },
    keep: taskSpaceSummary(keepTaskSpace),
    summary: {
      duplicateTasks: duplicates.length,
      filesToDelete: filesToDelete.length,
      identicalTasks: duplicates.filter((duplicate) => duplicate.identical).length,
      contentDifferences: duplicates.filter((duplicate) => !duplicate.identical).length,
      unresolvedTasks: unresolved.length,
      pendingConflicts: conflicts.pendingConflicts,
      conflictGroups: conflicts.conflictGroups,
      duplicateConflictGroups: conflicts.duplicateConflictGroups,
      duplicateConflictRows: conflicts.duplicateConflictRows,
      conflictsToResolve: conflicts.conflictsToResolve,
    },
    targetRemoveStatus: targetStatus,
    conflicts,
    duplicates,
    unresolved,
    filesToDelete,
  }
}

function portIsOpen(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port })
    const done = (value) => {
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(1000)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

async function assertServiceStopped(port = DEFAULT_PORT) {
  if (await portIsOpen(port)) {
    throw new Error(
      `检测到 ${port} 端口有 Board 服务运行。请先停止服务再执行 --apply，避免同步中的 Agent 并发写回。`,
    )
  }
}

function backupDatabase(db, databaseFile, now) {
  const backupDir = path.join(path.dirname(databaseFile), 'backups')
  fs.mkdirSync(backupDir, { recursive: true })
  const stamp = now.toISOString().replaceAll(/[-:.]/g, '')
  const target = path.join(backupDir, `board.sqlite.task-space-cleanup.${stamp}`)
  db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`)
  return target
}

function assertAuditedStateUnchanged(db, audit) {
  const readTaskSpace = db.prepare(`
    SELECT s.status, s.revision, p.status AS project_status
    FROM sync_task_space s
    JOIN sync_project p ON p.id = s.project_id
    WHERE s.id = ?
  `)
  for (const [label, expected] of [
    ['待清理任务空间', audit.remove],
    ['保留任务空间', audit.keep],
  ]) {
    const current = readTaskSpace.get(expected.id)
    if (
      !current ||
      current.status !== expected.status ||
      Number(current.revision) !== expected.revision ||
      current.project_status !== expected.projectStatus
    ) {
      throw new Error(`${label}状态或 revision 已变化，请重新执行 dry-run`)
    }
  }
}

function applyCleanup(
  db,
  audit,
  { now = new Date(), backupFile, cleanupConflicts = false, disableRemoveTaskSpace = false },
) {
  const timestamp = now.toISOString()
  const removeMutated =
    audit.filesToDelete.length > 0 ||
    (disableRemoveTaskSpace && audit.remove.status === 'active')
  const revision = removeMutated ? audit.remove.revision + 1 : audit.remove.revision
  const finalStatus = disableRemoveTaskSpace
    ? 'disabled'
    : audit.filesToDelete.length
      ? 'indexing'
      : audit.remove.status
  const deleteFile = db.prepare(`
    UPDATE sync_task_space_file
    SET revision = ?, content_text = NULL, deleted = 1,
        source_agent_id = NULL, source_user_id = NULL,
        source_client_sequence = NULL, updated_at = ?
    WHERE task_space_id = ? AND relative_path = ? AND deleted = 0
  `)
  const writeAudit = db.prepare(`
    INSERT INTO sync_file_audit(
      task_space_id, relative_path, task_id, operation, old_sha256,
      new_sha256, revision, source_user_id, source_agent_id, occurred_at
    ) VALUES (?, ?, ?, 'delete', ?, NULL, ?, NULL, NULL, ?)
  `)
  const updateTaskSpace = db.prepare(`
    UPDATE sync_task_space
    SET revision = ?, status = ?, last_error = NULL, updated_at = ?
    WHERE id = ? AND revision = ? AND status = 'active'
  `)
  const resolveConflict = db.prepare(`
    UPDATE sync_conflict
    SET status = 'resolved', resolved_at = ?
    WHERE id = ? AND status = 'pending'
  `)

  let resolvedConflicts = 0
  withTransaction(db, () => {
    assertAuditedStateUnchanged(db, audit)
    for (const file of audit.filesToDelete) {
      const result = deleteFile.run(revision, timestamp, audit.remove.id, file.path)
      if (Number(result.changes) !== 1) {
        throw new Error(`任务文件状态已变化，停止清理：${file.path}`)
      }
      writeAudit.run(audit.remove.id, file.path, file.taskId, file.sha256, revision, timestamp)
    }
    if (removeMutated) {
      db.prepare('DELETE FROM sync_task_index_tag WHERE task_space_id = ?').run(audit.remove.id)
      db.prepare('DELETE FROM sync_task_index WHERE task_space_id = ?').run(audit.remove.id)
      db.prepare('DELETE FROM sync_task_space_scan_cache WHERE task_space_id = ?').run(
        audit.remove.id,
      )
      const result = updateTaskSpace.run(
        revision,
        finalStatus,
        timestamp,
        audit.remove.id,
        audit.remove.revision,
      )
      if (Number(result.changes) !== 1) {
        throw new Error('任务空间 revision 已变化，请重新执行 dry-run')
      }
    }
    if (cleanupConflicts) {
      for (const group of audit.conflicts.groups) {
        for (const conflictId of group.resolveConflictIds) {
          const result = resolveConflict.run(timestamp, conflictId)
          if (Number(result.changes) !== 1) {
            throw new Error(`冲突状态已变化，停止清理：${conflictId}`)
          }
          resolvedConflicts += 1
        }
      }
    }
  })
  return { backupFile, revision, appliedAt: timestamp, finalStatus, resolvedConflicts }
}

export async function cleanupDuplicateTasks({
  databaseFile,
  projectId,
  removeTaskSpaceId,
  keepTaskSpaceId,
  apply = false,
  allowContentDifferences = false,
  cleanupConflicts = false,
  disableRemoveTaskSpace = false,
  now = new Date(),
  checkServiceStopped = assertServiceStopped,
}) {
  const resolvedDatabase = path.resolve(requiredId(databaseFile, '数据库路径'))
  if (!fs.existsSync(resolvedDatabase) || !fs.statSync(resolvedDatabase).isFile()) {
    throw new Error(`数据库文件不存在：${resolvedDatabase}`)
  }
  const db = new DatabaseSync(resolvedDatabase, { readOnly: !apply })
  try {
    db.exec('PRAGMA foreign_keys = ON')
    let audit = analyzeDuplicateTasks(db, {
      projectId,
      removeTaskSpaceId,
      keepTaskSpaceId,
      disableRemoveTaskSpace,
    })
    if (!apply) {
      return {
        ...audit,
        mode: 'dry-run',
        applied: false,
      }
    }
    const conflictOnlyCleanup =
      audit.remove.status === 'disabled' &&
      disableRemoveTaskSpace &&
      cleanupConflicts &&
      audit.filesToDelete.length === 0
    if (
      (audit.remove.status !== 'active' && !conflictOnlyCleanup) ||
      audit.keep.status !== 'active' ||
      audit.remove.projectStatus !== 'active'
    ) {
      throw new Error('指定项目或任务空间不是 active 状态，请先确认目标后再清理')
    }
    if (audit.unresolved.length) {
      throw new Error(`发现 ${audit.unresolved.length} 个缺少稳定任务 ID 的任务目录，拒绝自动清理`)
    }
    if (!audit.duplicates.length) {
      if (!disableRemoveTaskSpace && (!cleanupConflicts || !audit.conflicts.conflictsToResolve)) {
        return {
          ...audit,
          mode: 'apply',
          applied: true,
          backupFile: null,
          revision: audit.remove.revision,
          targetRemoveStatus: audit.remove.targetStatus,
          resolvedConflicts: 0,
        }
      }
    }
    if (audit.duplicates.some((duplicate) => !duplicate.identical) && !allowContentDifferences) {
      throw new Error(
        '重复任务目录存在内容差异；复核 dry-run 后如仍要清理，请显式加 --allow-content-differences',
      )
    }
    await checkServiceStopped()
    assertAuditedStateUnchanged(db, audit)
    audit = analyzeDuplicateTasks(db, {
      projectId,
      removeTaskSpaceId,
      keepTaskSpaceId,
      disableRemoveTaskSpace,
    })
    const backupFile = backupDatabase(db, resolvedDatabase, now)
    const result = applyCleanup(db, audit, {
      now,
      backupFile,
      cleanupConflicts,
      disableRemoveTaskSpace,
    })
    return {
      ...audit,
      remove: {
        ...audit.remove,
        targetStatus: result.finalStatus,
      },
      targetRemoveStatus: result.finalStatus,
      mode: 'apply',
      applied: true,
      ...result,
    }
  } finally {
    db.close()
  }
}

function usage() {
  return `用法：
  node scripts/task-space-duplicate-cleanup.js \\
    --database <board.sqlite> \\
    --project <projectId> \\
    --remove-task-space <oldTaskSpaceId> \\
    --keep-task-space <keepTaskSpaceId> \\
    [--apply] [--allow-content-differences] \\
    [--cleanup-conflicts] [--disable-remove-task-space]

默认只读审计。--apply 会先要求 4317 服务已停止，并写入数据库备份。
--cleanup-conflicts 和 --disable-remove-task-space 仅在显式传入时执行。`
}

async function main() {
  const { values } = parseArgs({
    options: {
      database: { type: 'string' },
      project: { type: 'string' },
      'remove-task-space': { type: 'string' },
      'keep-task-space': { type: 'string' },
      apply: { type: 'boolean', default: false },
      'allow-content-differences': { type: 'boolean', default: false },
      'cleanup-conflicts': { type: 'boolean', default: false },
      'disable-remove-task-space': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
  })
  if (values.help) {
    process.stdout.write(`${usage()}\n`)
    return
  }
  const result = await cleanupDuplicateTasks({
    databaseFile: values.database,
    projectId: values.project,
    removeTaskSpaceId: values['remove-task-space'],
    keepTaskSpaceId: values['keep-task-space'],
    apply: values.apply,
    allowContentDifferences: values['allow-content-differences'],
    cleanupConflicts: values['cleanup-conflicts'],
    disableRemoveTaskSpace: values['disable-remove-task-space'],
  })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

const entryFile = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (entryFile === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
