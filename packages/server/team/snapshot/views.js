import {
  ARCHIVE_SYNC_SERVER_MANAGED,
  classifyTaskSnapshots,
  isArchiveTaskDirectory,
  isArchiveTaskPath,
} from '@trellis-board/shared/task-snapshot.js'
import { ERROR_CODES, teamError } from '../errors.js'
import {
  publicFile,
  readTaskSpaceRevision,
  requestId,
  requireSnapshotGroups,
  taskBranchFromJson,
} from './shared.js'

export function createViews({ statements, taskSpaces, taskControl, bindingContext }) {
  function fileRows(agent, taskSpaceId, afterRevision = 0) {
    const visibleTaskIds = taskControl?.visibleTaskIds(agent, taskSpaceId) || null
    return statements.fileRows
      .all(taskSpaceId, afterRevision)
      .filter((row) => !visibleTaskIds || visibleTaskIds.has(row.task_id))
  }

  function snapshot(agent, taskSpaceId, input = {}) {
    const { space } = bindingContext(agent, taskSpaceId)
    const afterRevision = Number(input.afterRevision || 0)
    if (!Number.isSafeInteger(afterRevision) || afterRevision < 0) {
      throw teamError(400, ERROR_CODES.INVALID_INPUT, 'afterRevision 必须是非负整数')
    }
    const rows = fileRows(agent, taskSpaceId, afterRevision)
    return {
      taskSpaceId,
      projectId: space.project_id,
      branchName: space.branch_name,
      revision: readTaskSpaceRevision(statements, taskSpaceId),
      afterRevision,
      files: rows.filter((row) => afterRevision > 0 || !row.deleted).map((row) => publicFile(row)),
      controls: taskControl?.controlsForAgent(agent, taskSpaceId) || [],
    }
  }

  function directorySnapshot(agent, taskSpaceId, taskDir) {
    bindingContext(agent, taskSpaceId)
    const normalized = String(taskDir || '').trim()
    if (isArchiveTaskDirectory(normalized) || normalized.startsWith('.trellis/tasks/archive/')) {
      throw teamError(
        409,
        ARCHIVE_SYNC_SERVER_MANAGED,
        '归档任务目录由服务端 Git 索引管理，Agent 不能读取归档快照',
      )
    }
    if (!normalized.startsWith('.trellis/tasks/')) {
      throw teamError(400, ERROR_CODES.INVALID_INPUT, '任务目录无效')
    }
    taskControl?.assertReadable(agent, taskSpaceId, normalized)
    const rows = statements.directoryFiles.all(taskSpaceId, normalized)
    return {
      taskSpaceId,
      taskDir: normalized,
      revision: readTaskSpaceRevision(statements, taskSpaceId),
      files: rows.map((row) => publicFile(row)),
    }
  }

  function listTaskSummaries(agent, taskSpaceId) {
    bindingContext(agent, taskSpaceId)
    taskControl?.assertAgentAccess(agent, taskSpaceId)
    return statements.taskSummaries.all(taskSpaceId).map((row) => ({
      taskId: row.task_id,
      taskDir: row.relative_dir,
      title: row.title,
      stage: row.stage,
      assigneeUserId: row.assignee_user_id,
      createdByUserId: row.created_by_user_id,
      updatedAt: row.updated_at,
    }))
  }

  function taskFilesById(agent, taskSpaceId, taskId) {
    bindingContext(agent, taskSpaceId)
    taskControl?.assertAgentAccess(agent, taskSpaceId)
    const row = statements.taskRowById.get(taskSpaceId, String(taskId || ''))
    if (!row) throw teamError(404, ERROR_CODES.NOT_FOUND, '任务不存在')
    const files = statements.taskFilesByDir.all(taskSpaceId, row.relative_dir).map((file) => ({
      path: file.relative_path,
      sha256: file.sha256,
      content: file.content_text || '',
    }))
    return { taskId: row.task_id, taskDir: row.relative_dir, files }
  }

  function preflight(agent, taskSpaceId, input = {}) {
    bindingContext(agent, taskSpaceId)
    const allFileGroups = { maxFiles: Number.POSITIVE_INFINITY, maxBytes: Number.POSITIVE_INFINITY }
    const localGroups = requireSnapshotGroups(input.files || [], allFileGroups).filter(
      (group) => !group.archived,
    )
    const visibleTaskIds = taskControl?.visibleTaskIds(agent, taskSpaceId) || null
    const serverGroups = requireSnapshotGroups(
      statements.serverSnapshotFiles
        .all(taskSpaceId)
        .filter((row) => !visibleTaskIds || visibleTaskIds.has(row.task_id))
        .map((row) => ({
          path: row.path,
          content: row.content,
          sha256: row.sha256,
        })),
      allFileGroups,
    )
    return {
      taskSpaceId,
      revision: readTaskSpaceRevision(statements, taskSpaceId),
      tasks: classifyTaskSnapshots(localGroups, serverGroups),
    }
  }

  function taskOwnership(agent, taskSpaceId, input = {}) {
    const { space } = bindingContext(agent, taskSpaceId)
    if (input.taskIds != null && !Array.isArray(input.taskIds)) {
      throw teamError(400, ERROR_CODES.INVALID_INPUT, 'taskIds 必须是数组')
    }
    const rawTaskIds = Array.isArray(input.taskIds) ? input.taskIds : []
    if (rawTaskIds.length > 200) {
      throw teamError(400, ERROR_CODES.INVALID_INPUT, '单次最多查询 200 个任务 ID')
    }
    const taskIds = [...new Set(rawTaskIds.map((value) => requestId(value, '任务 ID')))].sort()
    const projectTaskSpaces = taskSpaces
      .listTaskSpaces(space.project_id, taskSpaces.actorContext(agent.userId))
      .filter((item) => item.status !== 'disabled')
      .map((item) => ({
        taskSpaceId: item.id,
        branchName: item.branchName,
        isBaseline: item.isBaseline,
      }))
    if (!taskIds.length) return { projectTaskSpaces, tasks: [] }

    const taskSpacesById = new Map(projectTaskSpaces.map((item) => [item.taskSpaceId, item]))
    const rows = statements.projectFilesByTaskIds(space.project_id, taskIds)
    const claimsByTaskId = new Map()
    for (const row of rows) {
      const projectSpace = taskSpacesById.get(row.task_space_id)
      if (!projectSpace || row.relative_path !== `${row.task_dir}/task.json`) continue
      const claims = claimsByTaskId.get(row.task_id) || []
      claims.push({
        taskSpaceId: row.task_space_id,
        branchName: projectSpace.branchName,
        taskBranch: taskBranchFromJson(row.content_text),
      })
      claimsByTaskId.set(row.task_id, claims)
    }
    return {
      projectTaskSpaces,
      tasks: taskIds.map((taskId) => ({
        taskId,
        claims: claimsByTaskId.get(taskId) || [],
      })),
    }
  }

  function manifestForDirectory(taskSpaceId, taskDir) {
    const normalized = String(taskDir || '').trim()
    if (!normalized.startsWith('.trellis/tasks/')) {
      throw teamError(400, ERROR_CODES.INVALID_INPUT, '任务目录无效')
    }
    const archived = isArchiveTaskPath(normalized) || isArchiveTaskDirectory(normalized)
    if (archived) {
      const revision = Number(statements.archiveRevision.get(taskSpaceId)?.archive_revision || 0)
      const rows = statements.archiveFiles.all(taskSpaceId, normalized)
      return {
        taskSpaceId,
        taskDir: normalized,
        revision,
        source: 'archive',
        files: rows.map((row) =>
          publicFile({
            ...row,
            revision,
            deleted: 0,
          }),
        ),
      }
    }
    const rows = statements.directoryFiles.all(taskSpaceId, normalized)
    return {
      taskSpaceId,
      taskDir: normalized,
      revision: readTaskSpaceRevision(statements, taskSpaceId),
      source: 'active',
      files: rows.map((row) => publicFile(row)),
    }
  }

  return {
    snapshot,
    directorySnapshot,
    listTaskSummaries,
    taskFilesById,
    preflight,
    taskOwnership,
    manifestForDirectory,
  }
}
