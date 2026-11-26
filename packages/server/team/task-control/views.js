import { ERROR_CODES, teamError } from '../errors.js'
import { required } from './shared.js'

/** 只读视图与访问守卫：任务行读取、DTO 转换、按 agent 可见性查询。 */
export function createViews({ statements, now = () => new Date() }) {
  function taskRow(executionTaskKey) {
    return statements.readTask.get(required(executionTaskKey, '任务身份')) || null
  }

  function assertAgentAccess(agent, taskSpaceId) {
    const binding = statements.readAgentBinding.get(
      agent.userId,
      agent.id,
      required(taskSpaceId, '任务空间 ID'),
    )
    if (!binding) {
      throw teamError(403, ERROR_CODES.FORBIDDEN, 'Agent 尚未绑定该任务空间')
    }
  }

  function activeLease(executionTaskKey) {
    return statements.readActiveLease.get(executionTaskKey, now().toISOString()) || null
  }

  function publicTask(row) {
    if (!row) return null
    return {
      executionTaskKey: row.execution_task_key,
      taskKey: row.task_key,
      taskSpaceId: row.task_space_id,
      projectId: row.project_id,
      taskId: row.task_id,
      relativeDir: row.relative_dir,
      title: row.title,
      description: row.description,
      priority: row.priority,
      createdByUserId: row.created_by_user_id,
      assigneeUserId: row.assignee_user_id,
      assigneeDevId: row.assignee_dev_id,
      stage: row.stage,
      archived: Boolean(row.archived),
      materializationState: row.materialization_state,
      taskVersion: Number(row.task_version),
      contentRevision: row.content_revision == null ? null : Number(row.content_revision),
      leaseId: row.lease_id || null,
      previousAssigneeUserId: row.previous_assignee_user_id || null,
      handoffState: row.handoff_state,
      materializedRevision:
        row.materialized_revision == null ? null : Number(row.materialized_revision),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      archivedAt: row.archived_at || null,
    }
  }

  function publicLease(row) {
    if (!row) return null
    return {
      id: row.id,
      executionTaskKey: row.execution_task_key,
      agentId: row.agent_id,
      userId: row.user_id,
      token: row.lease_token,
      status: row.status,
      expiresAt: row.expires_at,
      lastHeartbeatAt: row.last_heartbeat_at,
    }
  }

  function visibleTaskIds(agent, taskSpaceId) {
    assertAgentAccess(agent, taskSpaceId)
    return new Set(
      statements.readVisibleTaskIds.all(taskSpaceId, agent.userId).map((row) => row.task_id),
    )
  }

  function isArchivedTaskDir(taskSpaceId, taskDir) {
    const basename =
      String(taskDir || '')
        .split('/')
        .filter(Boolean)
        .pop() || ''
    if (!basename) return false
    const pattern = `.trellis/tasks/archive/%/${basename.replace(/[\\%_]/g, (ch) => `\\${ch}`)}`
    return Boolean(
      statements.readArchivedTaskByBasename.get(taskSpaceId, pattern) ||
      statements.readArchivedFileByBasename.get(taskSpaceId, pattern),
    )
  }

  function assertReadable(agent, taskSpaceId, taskDir) {
    assertAgentAccess(agent, taskSpaceId)
    const row = statements.readTaskByDir.get(taskSpaceId, taskDir)
    if (!row) {
      if (isArchivedTaskDir(taskSpaceId, taskDir)) {
        throw teamError(409, 'TASK_ARCHIVED', '任务已归档')
      }
      const legacy = statements.readLegacyTaskFile.get(taskSpaceId, taskDir)
      if (legacy) throw teamError(403, ERROR_CODES.FORBIDDEN, '只能读取本人任务内容')
      throw teamError(404, ERROR_CODES.NOT_FOUND, '任务不存在')
    }
    if (row.archived) throw teamError(409, 'TASK_ARCHIVED', '任务已归档')
    if (row.assignee_user_id !== agent.userId) {
      throw teamError(403, ERROR_CODES.FORBIDDEN, '只能读取本人任务内容')
    }
    return publicTask(row)
  }

  function controlsForAgent(agent, taskSpaceId) {
    return statements.readAgentControls
      .all(taskSpaceId, agent.userId, agent.userId, agent.userId)
      .map((row) => {
        let state = null
        if (row.archived) state = 'archived'
        else if (
          row.created_by_user_id === agent.userId &&
          row.assignee_user_id !== agent.userId &&
          row.materialization_state === 'materialized'
        ) {
          state = 'handoff_materialized'
        } else if (
          row.previous_assignee_user_id === agent.userId &&
          row.assignee_user_id !== agent.userId
        ) {
          state = 'reassigned'
        } else if (row.assignee_user_id === agent.userId) {
          if (row.materialization_state === 'pending') state = 'pending_delivery'
          else if (row.materialization_state === 'materialized') state = 'materialized'
          else state = 'claimed'
        }
        if (!state) return null
        const lease = state === 'handoff_materialized' ? activeLease(row.execution_task_key) : null
        return {
          executionTaskKey: row.execution_task_key,
          taskId: row.task_id,
          relativeDir: row.relative_dir,
          title: row.title,
          state,
          taskVersion: Number(row.task_version),
          assigneeUserId: row.assignee_user_id,
          handoffState: row.handoff_state,
          materializedRevision:
            row.materialized_revision == null ? null : Number(row.materialized_revision),
          materializedAt: row.materialized_at,
          // 目标负责人自己的租约说明任务正在由新的负责人正常使用，不应阻止
          // 创建者清理自己的来源副本；只有第三方租约才意味着真正的并发写入。
          leaseHeldByOtherUser: Boolean(
            lease && lease.user_id !== agent.userId && lease.user_id !== row.assignee_user_id,
          ),
          updatedAt: row.updated_at,
        }
      })
      .filter(Boolean)
  }

  function pendingTasks(taskSpaceId) {
    return statements.readPendingTasks.all(taskSpaceId)
  }

  function authoritativeTasks(taskSpaceId) {
    return new Map(
      statements.readSpaceTasks.all(taskSpaceId).map((row) => [row.execution_task_key, row]),
    )
  }

  function getTask(agent, taskSpaceId, executionTaskKey) {
    assertAgentAccess(agent, taskSpaceId)
    const row = taskRow(executionTaskKey)
    if (!row || row.task_space_id !== taskSpaceId) {
      throw teamError(404, ERROR_CODES.NOT_FOUND, '任务不存在')
    }
    if (row.assignee_user_id !== agent.userId) {
      return { task: publicTask(row), contentAvailable: false }
    }
    const lease = activeLease(row.execution_task_key)
    return {
      task: publicTask(row),
      contentAvailable: !row.archived && Boolean(lease && lease.agent_id === agent.id),
    }
  }

  return {
    taskRow,
    assertAgentAccess,
    activeLease,
    publicTask,
    publicLease,
    visibleTaskIds,
    isArchivedTaskDir,
    assertReadable,
    controlsForAgent,
    pendingTasks,
    authoritativeTasks,
    getTask,
  }
}
