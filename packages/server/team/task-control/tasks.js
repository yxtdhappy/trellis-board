import { ERROR_CODES, teamError } from '../errors.js'
import {
  WRITABLE_ROLES,
  activeTaskDir,
  canonicalKey,
  datePrefix,
  hashJson,
  required,
  slugify,
  taskId,
  text,
} from './shared.js'

/** 任务 CRUD：创建待投递任务、改派、命令结果收敛、负责人解析。 */
export function createTasks({ statements, views, leases, now = () => new Date() }) {
  function resolveAssignee(projectId, taskDocument, fallbackUserId) {
    const devId = text(
      taskDocument?.assignee || taskDocument?.assigneeDevId || taskDocument?.owner,
      128,
    )
    if (devId) {
      const member = statements.readMemberByDev.get(projectId, devId.toLowerCase())
      if (member && WRITABLE_ROLES.has(member.role)) {
        return {
          userId: member.user_id,
          devId: member.trellis_dev_id,
          member,
        }
      }
    }
    const member = statements.readMember.get(projectId, fallbackUserId)
    return {
      userId: fallbackUserId,
      // 未知 dev id 仍保留为看板可见性元数据；控制面负责人回退到当前用户。
      devId: devId || member?.trellis_dev_id || null,
      member,
    }
  }

  function pendingSlug(title, fallbackKey) {
    const slug = slugify(title)
    if (slug && slug !== 'archive') return slug
    return `board-${hashJson({ title, fallbackKey }).slice(0, 12)}`
  }

  function createPendingTask(actorUserId, input = {}) {
    const space = statements.readSpace.get(required(input.taskSpaceId, '任务空间 ID'))
    if (!space) throw teamError(404, ERROR_CODES.NOT_FOUND, '任务空间不存在')
    const project = statements.readProject.get(space.project_id)
    if (!project) throw teamError(404, ERROR_CODES.NOT_FOUND, '项目不存在')
    const title = required(input.title, '任务标题', 200)
    const requestedTaskId = text(input.taskId || input.slug, 200)
    const requestedRelativeDir = text(input.relativeDir, 500)
    const taskIdValue = taskId(requestedTaskId || pendingSlug(title, input.idempotencyKey || title))
    const relativeDir =
      (requestedRelativeDir && activeTaskDir(requestedRelativeDir)) ||
      `.trellis/tasks/${datePrefix(now())}-${taskIdValue}`
    const executionTaskKey = canonicalKey(space.id, taskIdValue)
    const existing = statements.readTask.get(executionTaskKey)
    if (existing) {
      if (existing.archived) {
        throw teamError(409, 'TASK_ARCHIVED', '已归档任务不能重新创建')
      }
      throw teamError(409, 'TASK_EXISTS', '同一任务 ID 已存在，不能重复创建')
    }
    const assigneeUserId = required(input.assigneeUserId || actorUserId, '负责人用户 ID', 128)
    const member = statements.readMember.get(project.id, assigneeUserId)
    if (!member || !WRITABLE_ROLES.has(member.role)) {
      throw teamError(409, 'ASSIGNEE_NOT_WRITABLE', '目标用户不是该项目的可写成员')
    }
    const timestamp = now().toISOString()
    statements.insertTask.run(
      executionTaskKey,
      `${space.id}::${relativeDir}`,
      space.id,
      project.id,
      taskIdValue,
      relativeDir,
      title,
      text(input.description, 4000),
      text(input.priority, 8) || 'P2',
      actorUserId,
      assigneeUserId,
      member.trellis_dev_id,
      actorUserId === assigneeUserId ? 'none' : 'handoff_pending',
      timestamp,
      timestamp,
    )
    return views.publicTask(statements.readTask.get(executionTaskKey))
  }

  function assignPendingTask(input = {}) {
    const row = views.taskRow(input.executionTaskKey)
    if (!row) throw teamError(404, ERROR_CODES.NOT_FOUND, '目标任务不存在')
    if (row.archived) throw teamError(409, 'TASK_ARCHIVED', '归档任务不能改派')
    const assigneeUserId = required(input.assigneeUserId, '负责人用户 ID', 128)
    const member = statements.readMember.get(row.project_id, assigneeUserId)
    if (!member || !WRITABLE_ROLES.has(member.role)) {
      throw teamError(409, 'ASSIGNEE_NOT_WRITABLE', '目标用户不是该项目的可写成员')
    }
    const changed = row.assignee_user_id !== assigneeUserId
    if (!changed) return views.publicTask(row)
    const timestamp = now().toISOString()
    statements.updateTaskAssignee.run(
      assigneeUserId,
      member.trellis_dev_id,
      row.assignee_user_id,
      assigneeUserId,
      timestamp,
      row.execution_task_key,
    )
    leases.revokeLeases(row.execution_task_key, timestamp)
    return views.publicTask(statements.readTask.get(row.execution_task_key))
  }

  function completeCommand(agent, taskSpaceId, input = {}) {
    const taskId = required(input.taskId, '任务 ID', 200)
    const row = statements.readTask.get(canonicalKey(taskSpaceId, taskId))
    if (!row) return null
    if (row.task_id !== taskId) {
      throw teamError(409, ERROR_CODES.CONFLICT, '命令结果与权威任务身份不一致')
    }
    if (row.archived) {
      throw teamError(409, 'TASK_ARCHIVED', '归档任务不能确认命令结果')
    }
    if (row.assignee_user_id !== agent.userId) {
      throw teamError(403, ERROR_CODES.FORBIDDEN, '只能确认分配给自己的任务命令')
    }
    const revision = Number(input.revision)
    if (
      row.content_revision != null &&
      Number.isSafeInteger(revision) &&
      revision !== Number(row.content_revision)
    ) {
      throw teamError(409, 'TASK_VERSION_STALE', '命令结果 revision 已过期，请先拉取最新任务')
    }
    const timestamp = now().toISOString()
    const handoffState =
      input.commandType === 'create_task'
        ? 'none'
        : input.commandType === 'assign_task' &&
            row.created_by_user_id &&
            row.created_by_user_id !== row.assignee_user_id &&
            row.assignee_user_id === agent.userId
          ? 'source_cleanup_pending'
          : row.handoff_state
    statements.updateTaskCommandComplete.run(
      agent.id,
      timestamp,
      Number(input.revision) || null,
      handoffState,
      timestamp,
      row.execution_task_key,
    )
    return views.publicTask(statements.readTask.get(row.execution_task_key))
  }

  return { resolveAssignee, createPendingTask, assignPendingTask, completeCommand }
}
