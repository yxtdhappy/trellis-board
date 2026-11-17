import fs from 'node:fs'
import path from 'node:path'
import { getDefaultDatabase } from './database.js'
import {
  linkTaskGroups,
  mergeTaskDetail,
  readProjectMembers,
  scanRepository,
  scanTask,
  toTaskListItem,
} from './loader.js'
import { getManualRecord } from './metadata.js'

function isTaskPathInside(root, candidate) {
  const relative = path.relative(root, candidate)
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative)
}

export function resolveTaskLocation(
  payload = {},
  { repositories = [], currentBoard = null, db = getDefaultDatabase() } = {},
) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('任务参数必须是对象')
  }
  const projectId = String(payload.projectId || '').trim()
  const taskPath = String(payload.taskPath || '').trim()
  if (!projectId) throw new Error('缺少项目 ID')
  if (!taskPath) throw new Error('缺少任务路径')
  if (path.isAbsolute(taskPath) || taskPath.includes('\0')) {
    throw new Error('任务路径必须是目标仓库内的相对路径')
  }
  const project = repositories.find((repo) => repo.id === projectId)
  if (!project) throw new Error('仓库不在白名单中')
  const fullPath = path.resolve(project.path, taskPath)
  const tasksRoot = path.resolve(project.path, '.trellis', 'tasks')
  if (!isTaskPathInside(tasksRoot, fullPath)) {
    throw new Error('任务必须位于目标仓库的 .trellis/tasks 下')
  }
  if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isDirectory()) {
    throw new Error('未找到任务')
  }
  const realTasksRoot = fs.realpathSync(tasksRoot)
  const realTaskPath = fs.realpathSync(fullPath)
  if (!isTaskPathInside(realTasksRoot, realTaskPath)) {
    throw new Error('任务真实路径越出 .trellis/tasks')
  }
  const relativeDir = path.relative(project.path, fullPath).replaceAll('\\', '/')
  const archiveRoot = path.resolve(tasksRoot, 'archive')
  const relativeArchivePath = path.relative(archiveRoot, fullPath)
  const archived =
    Boolean(relativeArchivePath) &&
    !relativeArchivePath.startsWith('..') &&
    !path.isAbsolute(relativeArchivePath)
  const task = scanTask(project, fullPath, {
    archived,
    includeContent: true,
  })
  if (!task) throw new Error('未找到任务')
  const hasBoardSnapshot = currentBoard && Array.isArray(currentBoard.tasks)
  let currentProjectScan = null
  let scannedListTask = null
  if (!hasBoardSnapshot) {
    // 没有可用快照时才回退到项目扫描，避免 HTTP 主线程承担整仓扫描。
    currentProjectScan = scanRepository(project, { includeContent: false })
    scannedListTask = linkTaskGroups([currentProjectScan])
      .map(toTaskListItem)
      .find((candidate) => candidate.taskKey === task.taskKey)
    if (!scannedListTask) throw new Error('未找到任务')
  }
  const boardTasks = hasBoardSnapshot
    ? currentBoard.tasks.filter((candidate) => candidate.projectId === project.id)
    : []
  const cachedListTask = boardTasks.find((candidate) => candidate.taskKey === task.taskKey)
  const identityTask = scannedListTask || cachedListTask || null
  const executionTaskKey = task.executionTaskKey || identityTask?.executionTaskKey
  // 快照后若当前路径的身份发生变化，新身份可能已属于另一任务，必须等到刷新后再写入。
  const snapshotIdentityChanged = Boolean(
    cachedListTask && cachedListTask.executionTaskKey !== task.executionTaskKey,
  )
  const matchingIdentityTasks = boardTasks.filter(
    (candidate) => candidate.executionTaskKey === executionTaskKey,
  )
  const snapshotIdentityOwnedElsewhere = Boolean(
    hasBoardSnapshot &&
    !cachedListTask &&
    matchingIdentityTasks.some((candidate) => candidate.taskKey !== task.taskKey),
  )
  const identityConflict =
    !executionTaskKey ||
    snapshotIdentityChanged ||
    snapshotIdentityOwnedElsewhere ||
    matchingIdentityTasks.length > 1 ||
    matchingIdentityTasks.some(
      (candidate) =>
        candidate.executionIdentityValid === false || candidate.executionIdentityConflict === true,
    ) ||
    scannedListTask?.executionIdentityValid === false ||
    scannedListTask?.executionIdentityConflict === true
  const executionIdentityValid = !identityConflict && task.executionIdentityValid !== false
  const listTask = cachedListTask
    ? {
        ...cachedListTask,
        executionTaskKey,
        executionIdentityValid,
        executionIdentityConflict: identityConflict,
      }
    : scannedListTask
  const detailedTask = mergeTaskDetail(
    task,
    listTask,
    getManualRecord(project.id, task.relativeDir, db),
  )
  const projectMembers = [
    ...new Set([...readProjectMembers(project.path), task.assignee, task.creator].filter(Boolean)),
  ].sort((left, right) => left.localeCompare(right, 'zh-CN'))
  return {
    project,
    actor:
      project.developer ||
      currentBoard?.projects?.find((candidate) => candidate.id === project.id)?.developer ||
      currentProjectScan?.project?.developer ||
      task.assignee ||
      task.creator ||
      'local',
    identityConflict,
    task: {
      ...detailedTask,
      executionTaskKey,
      executionIdentityValid,
      executionIdentityConflict: identityConflict,
      projectMembers,
      artifacts: task.artifacts,
      summary: task.summary,
    },
  }
}
