import { ARCHIVE_SYNC_SERVER_MANAGED } from '@trellis-board/shared/task-snapshot.js'
import { withTransaction } from '../../database.js'
import { deleteTaskOwnershipInboxRows } from '../task-ownership-inbox.js'
import { ERROR_CODES, teamError } from '../errors.js'
import { archivedActiveTaskDirs } from './archive-files.js'
import { createWriteConflict } from './conflicts.js'
import {
  affectedDirectoryRows,
  currentPathRows,
  hashJson,
  normalizeMergeEvidence,
  observedBranchName,
  readTaskSpaceRevision,
  rejectArchiveGroups,
  requestId,
  requireSnapshotGroups,
  sequence,
  sourceIdentity,
  taskTitleFromJson,
} from './shared.js'

export function createApply({
  db,
  statements,
  taskSpaces,
  taskControl = null,
  now,
  onRevisionCommitted = null,
  onOwnershipInboxCleared = null,
  bindingContext,
  checkRateLimit,
  validateCompleteTaskGroups,
  validateTaskOwnership,
  persistMergeEvidence,
}) {
  const writeConflict = createWriteConflict({ statements, now })

  function applyChangesInternal(agent, taskSpaceId, input = {}, commitHook = null) {
    const { space, binding } = bindingContext(agent, taskSpaceId)
    const observedBranch = observedBranchName(input, space, binding)
    const mergeEvidence = normalizeMergeEvidence(input.mergeEvidence)
    const actor = taskSpaces.actorContext(agent.userId)
    taskSpaces.authorizeTaskSpace(actor, taskSpaceId, 'write')
    const batchId = requestId(input.batchId, '批次 ID')
    const clientSequence = sequence(input.clientSequence)
    const rawFiles = Array.isArray(input.files) ? input.files : []
    const groups = rejectArchiveGroups(requireSnapshotGroups(rawFiles))
    const files = groups.flatMap((group) => group.files)
    if (!files.length) throw teamError(400, ERROR_CODES.INVALID_INPUT, '同步批次不能为空')
    const requestPayload = {
      taskSpaceId,
      batchId,
      clientSequence,
      files,
    }
    if (mergeEvidence) requestPayload.mergeEvidence = mergeEvidence
    const requestSha256 = hashJson(requestPayload)
    const outcome = withTransaction(db, () => {
      const existingBatch = statements.batchById.get(agent.id, taskSpaceId, batchId)
      if (existingBatch) {
        if (existingBatch.request_sha256 !== requestSha256) {
          throw teamError(409, ERROR_CODES.CONFLICT, '同一批次 ID 不能提交不同内容')
        }
        return {
          kind: 'replayed',
          response: {
            status: 200,
            replayed: true,
            revision: Number(existingBatch.revision),
            taskSpaceId,
          },
        }
      }
      checkRateLimit(agent.id, taskSpaceId)
      const previousSequence = Number(
        statements.maxClientSequence.get(agent.id, taskSpaceId).sequence,
      )
      if (clientSequence <= previousSequence) {
        throw teamError(409, ERROR_CODES.CONFLICT, 'clientSequence 必须严格递增', {
          details: {
            previousSequence,
            requiredClientSequence: previousSequence + 1,
          },
        })
      }
      const complete = validateCompleteTaskGroups(taskSpaceId, files, space.branch_name)
      if (files.some((file) => !file.deleted)) {
        const archivedDirs = archivedActiveTaskDirs(statements, taskSpaceId)
        if (complete.taskDirs.some((dir) => archivedDirs.has(dir))) {
          throw teamError(
            409,
            ARCHIVE_SYNC_SERVER_MANAGED,
            '归档任务由服务端 Git 索引管理，不能推送活跃文件',
          )
        }
      }
      const ownership = validateTaskOwnership({
        space,
        complete,
        evidence: mergeEvidence,
        observedBranch,
      })
      taskControl?.assertUploadAllowed(agent, taskSpaceId, complete, input, {
        files,
        projectId: space.project_id,
      })
      const current = currentPathRows(
        statements,
        taskSpaceId,
        files.map((file) => file.path),
      )
      const conflictFiles = []
      for (const file of files) {
        const row = current.get(file.path)
        const actualBase = row && !row.deleted ? row.sha256 : null
        const expectedBase = file.baseSha256 || null
        if (actualBase !== expectedBase) {
          conflictFiles.push({
            path: file.path,
            baseSha256: expectedBase,
            currentSha256: actualBase,
            revision: Number(row?.revision || 0),
            changedBy: sourceIdentity(statements, row),
          })
        }
      }
      if (conflictFiles.length) {
        const taskTitle = affectedDirectoryRows(statements, taskSpaceId, complete.taskDirs)
          .filter((row) => row.relative_path.endsWith('/task.json'))
          .map((row) => taskTitleFromJson(row.content_text))
          .find(Boolean)
        return {
          kind: 'conflict',
          response: writeConflict({
            agent,
            taskSpaceId,
            taskId: complete.taskId,
            taskTitle,
            taskDir: complete.taskDirs.join(' -> '),
            files: conflictFiles,
            serverRevision: readTaskSpaceRevision(statements, taskSpaceId),
            clientSequence,
            batchId,
          }),
        }
      }

      const timestamp = now().toISOString()
      const currentRevision = readTaskSpaceRevision(statements, taskSpaceId)
      const revision = currentRevision + 1
      if (ownership.persistEvidence) {
        persistMergeEvidence({
          agent,
          space,
          complete,
          evidence: mergeEvidence,
          timestamp,
        })
      }
      let changed = false
      for (const file of files) {
        const before = current.get(file.path)
        if (!file.deleted && before && !before.deleted && before.sha256 === file.sha256) continue
        if (file.deleted && (!before || before.deleted)) continue
        changed = true
        const operation = file.deleted ? 'delete' : before?.deleted ? 'upsert' : 'upsert'
        statements.upsertFile.run(
          taskSpaceId,
          file.path,
          revision,
          file.sha256,
          file.deleted ? null : file.content,
          file.deleted ? 1 : 0,
          file.deleted ? before?.task_id || complete.taskId : complete.taskId,
          file.taskDir,
          agent.id,
          agent.userId,
          clientSequence,
          timestamp,
        )
        statements.insertFileAudit.run(
          taskSpaceId,
          file.path,
          complete.taskId || before?.task_id || null,
          operation,
          before && !before.deleted ? before.sha256 : null,
          file.deleted ? null : file.sha256,
          revision,
          agent.userId,
          agent.id,
          timestamp,
        )
      }
      const control = taskControl?.commitUpload({
        agent,
        space,
        complete,
        files,
        revision: changed ? revision : currentRevision,
        contentChanged: changed,
      })
      const ownershipInboxRowsCleared = deleteTaskOwnershipInboxRows(
        db,
        space.project_id,
        complete.taskId,
      )
      const hook = {
        agent,
        taskSpaceId,
        current,
        complete,
        files,
        timestamp,
        changed,
        currentRevision,
        revision: changed ? revision : currentRevision,
      }
      if (!changed) {
        return {
          kind: 'noop',
          revision: currentRevision,
          taskId: complete.taskId,
          control,
          ownershipInboxRowsCleared,
          hookResult: commitHook ? commitHook(hook) : null,
        }
      }
      statements.insertBatch.run(
        batchId,
        taskSpaceId,
        agent.id,
        agent.userId,
        revision,
        requestSha256,
        clientSequence,
        timestamp,
      )
      const taskSpaceUpdate = statements.bumpTaskSpaceRevision.run(revision, timestamp, taskSpaceId)
      if (Number(taskSpaceUpdate.changes) !== 1) {
        throw teamError(409, ERROR_CODES.PROJECT_NOT_READY, '任务空间已停用')
      }
      return {
        kind: 'changed',
        revision,
        taskId: complete.taskId,
        control,
        ownershipInboxRowsCleared,
        hookResult: commitHook ? commitHook(hook) : null,
      }
    })
    if (outcome.kind === 'replayed' || outcome.kind === 'conflict') {
      return { response: outcome.response, internal: null }
    }
    if (outcome.kind === 'changed') {
      try {
        onRevisionCommitted?.({
          taskSpaceId,
          projectId: space.project_id,
          revision: outcome.revision,
        })
      } catch {
        // 投影失败由索引服务的退避重试处理，不回滚已提交快照。
      }
    }
    if (outcome.ownershipInboxRowsCleared > 0) {
      try {
        onOwnershipInboxCleared?.({
          taskSpaceId,
          projectId: space.project_id,
          taskId: outcome.taskId,
        })
      } catch {
        // 摘要已随快照事务提交；通知失败不能反向破坏已接受的正式任务。
      }
    }
    return {
      response: {
        status: 200,
        replayed: false,
        noop: outcome.kind === 'noop',
        taskSpaceId,
        revision: outcome.revision,
        taskId: outcome.taskId,
        control: outcome.control || null,
        taskVersion: outcome.control?.task?.taskVersion || null,
        lease: outcome.control?.lease || null,
      },
      internal: outcome.hookResult,
    }
  }

  function applyChanges(agent, taskSpaceId, input = {}) {
    return applyChangesInternal(agent, taskSpaceId, input).response
  }

  return { applyChangesInternal, applyChanges }
}
