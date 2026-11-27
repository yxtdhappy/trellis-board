import { taskIdFromExecutionKey, text } from './shared.js'

/** 索引/投影写入：把索引里的任务行收敛回控制面权威表。 */
export function createProjection({ statements, leases, tasks, now = () => new Date() }) {
  function reconcileProjection({ taskSpaceId, projectId, tasks: taskList, isWorktree = false }) {
    const timestamp = now().toISOString()
    const project = statements.readProject.get(projectId)
    const taskGroups = new Map()
    for (const task of taskList) {
      const key = text(task.executionTaskKey || task.taskKey, 500)
      if (!key) continue
      const group = taskGroups.get(key) || []
      group.push(task)
      taskGroups.set(key, group)
    }
    const authoritativeTasks = [...taskGroups.values()].flatMap((group) => {
      const archived = group.filter((task) => task.archived)
      if (archived.length === 1) return archived
      return archived.length === 0 && group.length === 1 ? group : []
    })
    for (const task of authoritativeTasks) {
      const executionTaskKey = text(task.executionTaskKey || task.taskKey, 500)
      if (!executionTaskKey) continue
      const taskId = taskIdFromExecutionKey(executionTaskKey)
      const existing = statements.readTask.get(executionTaskKey)
      const assignee =
        tasks.resolveAssignee(
          projectId,
          { assignee: task.assignee },
          project?.created_by_user_id,
        ) || null
      if (!existing) {
        statements.insertProjectionTask.run(
          executionTaskKey,
          task.taskKey || `${taskSpaceId}::${task.relativeDir}`,
          taskSpaceId,
          projectId,
          taskId,
          task.relativeDir,
          text(task.title, 200) || taskId,
          text(task.priority, 8) || 'P2',
          assignee?.userId || project?.created_by_user_id || null,
          assignee?.userId || null,
          assignee?.devId || task.assignee || null,
          text(task.derivedStage, 80) || 'planning',
          task.archived ? 1 : 0,
          timestamp,
          timestamp,
          task.archived ? task.archivedAt || timestamp : null,
        )
        continue
      }
      if (task.archived && !existing.archived) {
        statements.archiveProjectionTask.run(
          task.taskKey || existing.task_key,
          task.relativeDir || existing.relative_dir,
          task.archivedAt || timestamp,
          timestamp,
          executionTaskKey,
        )
        leases.revokeLeases(executionTaskKey, timestamp)
        statements.resolveArchivedConflicts.run(
          timestamp,
          taskSpaceId,
          existing.relative_dir,
          existing.task_id,
        )
      } else if (!task.archived && !existing.archived && task.relativeDir) {
        statements.updateProjectionDir.run(
          task.taskKey || existing.task_key,
          task.relativeDir,
          timestamp,
          executionTaskKey,
        )
      }
    }
    if (isWorktree) {
      const activeExecutionKeys = new Set()
      for (const task of authoritativeTasks) {
        if (task.archived) continue
        const key = text(task.executionTaskKey || task.taskKey, 500)
        if (key) activeExecutionKeys.add(key)
      }
      for (const row of statements.readSpaceTasks.all(taskSpaceId)) {
        if (
          row.archived ||
          row.materialization_state !== 'materialized' ||
          activeExecutionKeys.has(row.execution_task_key)
        ) {
          continue
        }
        statements.archiveProjectionTask.run(
          row.task_key,
          row.relative_dir,
          timestamp,
          timestamp,
          row.execution_task_key,
        )
        leases.revokeLeases(row.execution_task_key, timestamp)
        statements.resolveArchivedConflicts.run(
          timestamp,
          taskSpaceId,
          row.relative_dir,
          row.task_id,
        )
      }
    }
  }

  return { reconcileProjection }
}
