import crypto from 'node:crypto'
import { ERROR_CODES, teamError } from '../errors.js'
import {
  affectedDirectoryRows,
  parseJson,
  rejectArchiveGroups,
  requestId,
  requireSnapshotGroups,
} from './shared.js'

export function createWriteConflict({ statements, now }) {
  return function writeConflict({
    agent,
    taskSpaceId,
    taskId,
    taskTitle,
    taskDir,
    files,
    serverRevision,
    clientSequence,
    batchId,
  }) {
    const timestamp = now().toISOString()
    const filesJson = JSON.stringify(files)
    const existing = statements.pendingConflictForAgent.get(
      taskSpaceId,
      agent.id,
      taskId,
      taskDir,
      taskId,
    )
    const id = existing?.id || crypto.randomUUID()
    if (existing) {
      statements.updatePendingConflict.run(
        taskId,
        taskDir,
        filesJson,
        serverRevision,
        clientSequence,
        batchId,
        id,
      )
    } else {
      statements.insertConflict.run(
        id,
        taskSpaceId,
        taskId,
        taskDir,
        filesJson,
        serverRevision,
        clientSequence,
        batchId,
        agent.userId,
        agent.id,
        timestamp,
      )
    }
    return {
      status: 409,
      code: 'TASK_FILE_CONFLICT',
      conflictId: id,
      message: '任务文件已被其他成员修改，本次整批未保存',
      details: {
        taskId,
        taskTitle: taskTitle || taskId || taskDir,
        files,
        suggestion: '先查看差异，再选择使用服务端版本或用本地版本覆盖',
      },
    }
  }
}

export function createConflicts({ statements, now, bindingContext, applyChangesInternal }) {
  function listConflicts(agent, taskSpaceId) {
    bindingContext(agent, taskSpaceId)
    return statements.pendingConflicts.all(taskSpaceId).map((row) => ({
      id: row.id,
      taskSpaceId: row.task_space_id,
      taskId: row.task_id,
      taskDir: row.task_dir,
      files: parseJson(row.files_json, []),
      serverRevision: Number(row.server_revision),
      batchId: row.batch_id,
      createdAt: row.created_at,
    }))
  }

  function resolveConflict(agent, taskSpaceId, conflictId, input = {}) {
    const conflict = statements.conflictById.get(String(conflictId || ''))
    if (!conflict) throw teamError(404, ERROR_CODES.NOT_FOUND, '冲突不存在')
    if (conflict.task_space_id !== String(taskSpaceId || '')) {
      throw teamError(404, ERROR_CODES.NOT_FOUND, '冲突不存在')
    }
    bindingContext(agent, conflict.task_space_id)
    const action = String(input.action || '')
    if (!['use-server', 'overwrite-server', 'save-local-copy'].includes(action)) {
      throw teamError(400, ERROR_CODES.INVALID_INPUT, '冲突处理动作无效')
    }
    if (conflict.status !== 'pending') {
      if (conflict.status === 'resolved' && action !== 'save-local-copy') {
        return { conflictId: conflict.id, action, resolved: true, idempotent: true }
      }
      throw teamError(409, ERROR_CODES.CONFLICT, '该冲突已经处理，请刷新冲突列表')
    }
    if (action === 'overwrite-server') {
      const files = Array.isArray(input.files) ? input.files : []
      const groupedFiles = rejectArchiveGroups(requireSnapshotGroups(files))
      const normalizedFiles = groupedFiles.flatMap((group) => group.files)
      const taskDirs = [...new Set(normalizedFiles.map((file) => file.taskDir))]
      const currentRows = affectedDirectoryRows(statements, conflict.task_space_id, taskDirs)
      const current = new Map(currentRows.map((row) => [row.relative_path, row]))
      const currentDetails = parseJson(conflict.files_json, [])
      for (const detail of currentDetails) {
        const row = current.get(detail.path)
        if ((row && !row.deleted ? row.sha256 : null) !== detail.currentSha256) {
          throw teamError(409, ERROR_CODES.CONFLICT, '服务端版本又发生变化，请重新查看差异')
        }
      }
      const applied = applyChangesInternal(
        agent,
        conflict.task_space_id,
        {
          observedBranchName: input.observedBranchName,
          mergeEvidence: input.mergeEvidence,
          batchId: requestId(input.batchId, '批次 ID'),
          clientSequence: input.clientSequence,
          files: normalizedFiles.map((file) => ({
            ...file,
            baseSha256:
              current.get(file.path) && !current.get(file.path).deleted
                ? current.get(file.path).sha256
                : null,
          })),
        },
        ({ files: committedFiles, timestamp, revision }) => {
          const replacements = new Map(committedFiles.map((file) => [file.path, file]))
          const paths = new Set([
            ...current.keys(),
            ...currentDetails.map((detail) => detail.path),
            ...replacements.keys(),
          ])
          const backupPaths = []
          for (const relativePath of paths) {
            const row = current.get(relativePath)
            const replacement = replacements.get(relativePath)
            const oldContent = row && !row.deleted ? row.content_text : null
            const newContent =
              replacement == null ? oldContent : replacement.deleted ? null : replacement.content
            statements.insertConflictBackup.run(
              crypto.randomUUID(),
              conflict.id,
              conflict.task_space_id,
              relativePath,
              oldContent,
              newContent,
              revision,
              agent.userId,
              agent.id,
              timestamp,
            )
            backupPaths.push(relativePath)
          }
          statements.resolveConflictRow.run(timestamp, conflict.id)
          return backupPaths
        },
      )
      if (applied.response.status === 409) return applied.response
      return {
        ...applied.response,
        conflictId: conflict.id,
        action,
        backupPaths: applied.internal || [],
      }
    }
    if (action === 'save-local-copy') {
      // 本地副本由客户端保存，服务端冲突必须继续保持 pending。
      return {
        conflictId: conflict.id,
        action,
        resolved: false,
        message: '本地副本已保存，原冲突仍待处理',
      }
    }
    statements.resolveConflictRow.run(now().toISOString(), conflict.id)
    return { conflictId: conflict.id, action, resolved: true }
  }

  return { listConflicts, resolveConflict }
}
