import { getRepositories } from '../repositories.js'
import { projectTaskDetailExecution } from '../execution-projection.js'
import { resolveTaskLocation } from '../task-location.js'
import { readScanCache } from './refresh.js'

export function requireWritableExecution(resolved) {
  if (resolved.task.archived) {
    throw new Error('归档任务只读，不能修改执行数据')
  }
  if (resolved.identityConflict || !resolved.task.executionIdentityValid) {
    throw new Error('任务执行身份冲突，请修正 task.json id')
  }
}

export function requireDependencyIdentity(resolved, label) {
  if (resolved.identityConflict || !resolved.task.executionIdentityValid) {
    throw new Error(`${label}任务执行身份冲突，请先修正 task.json id`)
  }
}

export function findTask(state, payload) {
  const resolved = resolveCurrentTask(state, payload)
  const board = state.boardCache || readScanCache(state)
  return projectTaskDetailExecution(resolved.task, state.database, new Date(), 1000, {
    boardTasks: board?.tasks || [resolved.task],
    executionWipLimit: state.persistence.readExecutionWipLimit(),
  })
}

export function resolveCurrentTask(state, payload) {
  return resolveTaskLocation(payload, {
    repositories: getRepositories(),
    currentBoard: state.boardCache || readScanCache(state),
    db: state.database,
  })
}
