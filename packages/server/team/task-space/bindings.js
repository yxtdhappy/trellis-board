import { withTransaction } from '../../database.js'
import { appendAuditEvent } from '../audit.js'
import { ERROR_CODES, teamError } from '../errors.js'
import { assertLocalRepoKey, emptyListenerSummary, requiredText, safeId } from './shared.js'

export function createBindings({ db, statements, access, view, now }) {
  function authorizeTaskSpace(
    actor,
    taskSpaceId,
    capability = 'view',
    { allowDisabled = false } = {},
  ) {
    const taskSpace = statements.taskSpaceWithProject.get(String(taskSpaceId || ''))
    if (!taskSpace) throw teamError(404, ERROR_CODES.NOT_FOUND, '任务空间不存在')
    const project = access.loadProjectRow(taskSpace.project_id)
    const accessContext = access.accessContext(actor)
    if (!access.projectAccessible(project, actor, accessContext)) {
      throw teamError(404, ERROR_CODES.NOT_FOUND, '任务空间不存在')
    }
    if (
      !allowDisabled &&
      (taskSpace.status === 'disabled' || taskSpace.retired_at || project.status !== 'active')
    ) {
      throw teamError(409, ERROR_CODES.PROJECT_NOT_READY, '任务空间已停用')
    }
    const member = accessContext.projectMembers.get(project.id)?.get(actor.userId) || null
    const teamAdmin = (actor.teams || []).some(
      (team) =>
        accessContext.teamAccessByProject.has(`${project.id}\0${team.id}`) && team.role === 'admin',
    )
    if (capability === 'write') {
      if (actor.systemAdmin || member?.role === 'lead' || member?.role === 'member') {
        return { taskSpace, project, member, access: accessContext }
      }
      if (teamAdmin) {
        throw teamError(
          403,
          ERROR_CODES.FORBIDDEN,
          '团队管理员可以管理项目，但必须先映射 Trellis developer ID 才能写任务',
        )
      }
      throw teamError(403, ERROR_CODES.FORBIDDEN, '只读成员不能修改任务')
    }
    return {
      taskSpace,
      project,
      member,
      access: accessContext,
      canManage: Boolean(actor.systemAdmin || teamAdmin || member?.role === 'lead'),
    }
  }

  function listenerDetails(actor, taskSpaceId) {
    const authorized = authorizeTaskSpace(actor, taskSpaceId, 'view', { allowDisabled: true })
    if (!authorized.canManage) {
      throw teamError(403, ERROR_CODES.FORBIDDEN, '只有项目负责人或团队管理员可以查看监听详情')
    }
    const summaries = view.listenerSummariesFor([authorized.taskSpace.id])
    const summary = summaries.get(authorized.taskSpace.id) || emptyListenerSummary()
    const taskSpace = view.taskSpacePublic(authorized.taskSpace, actor, authorized.access, summary)
    const staleCutoff = view.staleCutoff()
    const listeners = statements.listenerDetails
      .all(staleCutoff, staleCutoff, authorized.taskSpace.id)
      .map((row) => ({
        bindingId: row.binding_id,
        userId: row.user_id,
        username: row.username,
        displayName: row.display_name,
        trellisDevId: row.trellis_dev_id || null,
        deviceName: row.device_name,
        bindingStatus: row.sync_status,
        online: Boolean(row.online),
        listenerReportedAt: row.listener_reported_at || null,
        lastListenerAt: row.last_listener_at || null,
        boundAt: row.created_at,
      }))
    return {
      taskSpaceId: taskSpace.id,
      branchName: taskSpace.branchName,
      listenerState: taskSpace.listenerState,
      approvedBindingCount: taskSpace.approvedBindingCount,
      onlineListenerCount: taskSpace.onlineListenerCount,
      lastListenerAt: taskSpace.lastListenerAt,
      listeners,
    }
  }

  function detachAgent(agent, taskSpaceId, input = {}) {
    const agentId = safeId(agent?.id, 'Agent ID')
    const userId = requiredText(agent?.userId, '用户 ID', 128)
    const spaceId = safeId(taskSpaceId, '任务空间 ID')
    const localRepoKey = assertLocalRepoKey(input.localRepoKey)
    const activeAgent = statements.activeAgentForUser.get(agentId, userId)
    if (!activeAgent) {
      throw teamError(403, ERROR_CODES.FORBIDDEN, 'Agent 设备不是当前账号的有效设备')
    }
    const taskSpace = access.loadTaskSpaceRow(spaceId)
    if (!taskSpace) throw teamError(404, ERROR_CODES.NOT_FOUND, '任务空间不存在')
    const actor = access.actorContext(userId)
    const accessContext = access.accessContext(actor)
    const project = access.loadProjectRow(taskSpace.project_id)
    if (!project || !access.projectAccessible(project, actor, accessContext)) {
      throw teamError(404, ERROR_CODES.NOT_FOUND, '任务空间不存在')
    }

    return withTransaction(db, () => {
      const binding = statements.bindingByAgentSpace.get(agentId, spaceId)
      if (!binding) {
        return {
          detached: true,
          alreadyDetached: true,
          taskSpaceId: spaceId,
          bindingId: null,
        }
      }
      if (binding.local_repo_key !== localRepoKey) {
        throw teamError(
          409,
          'TASK_SPACE_BINDING_MISMATCH',
          '本地仓库与当前任务空间关联不一致，请刷新本地关联后重试',
          { details: { taskSpaceId: spaceId, bindingId: binding.id } },
        )
      }
      if (binding.sync_status === 'revoked') {
        return {
          detached: true,
          alreadyDetached: true,
          taskSpaceId: spaceId,
          bindingId: binding.id,
        }
      }
      const timestamp = now().toISOString()
      statements.revokeBinding.run(timestamp, binding.id)
      statements.cancelCommandsForBinding.run(timestamp, binding.id)
      statements.deleteCursor.run(agentId, spaceId)
      appendAuditEvent(db, {
        actorUserId: userId,
        actorAgentId: agentId,
        teamId: project.owner_team_id,
        projectId: project.id,
        action: 'task_space_binding_detached',
        targetType: 'agent_binding',
        targetId: binding.id,
        detail: {
          previousStatus: binding.sync_status,
          branchName: binding.branch_name,
          taskSpaceId: spaceId,
          detachedAt: timestamp,
        },
        occurredAt: timestamp,
      })
      let taskSpaceRetired = false
      const isWorktreeSpace = Number(taskSpace.is_worktree) === 1
      const isBaselineBranch = Boolean(
        project.baseline_branch && taskSpace.branch_name === project.baseline_branch,
      )
      if (
        isWorktreeSpace &&
        !isBaselineBranch &&
        !taskSpace.retired_at &&
        taskSpace.status === 'active' &&
        Number(statements.approvedBindingCount.get(spaceId)?.count || 0) === 0
      ) {
        statements.retireTaskSpace.run(
          timestamp,
          userId,
          'worktree_deleted',
          timestamp,
          spaceId,
          project.id,
        )
        statements.cancelCommandsForTaskSpace.run(timestamp, spaceId)
        appendAuditEvent(db, {
          actorUserId: userId,
          actorAgentId: agentId,
          teamId: project.owner_team_id,
          projectId: project.id,
          action: 'task_space_retired',
          targetType: 'task_space',
          targetId: spaceId,
          detail: {
            branchName: taskSpace.branch_name,
            reason: 'worktree_deleted',
            autoRetiredWorktree: true,
          },
          occurredAt: timestamp,
        })
        taskSpaceRetired = true
      }
      return {
        detached: true,
        alreadyDetached: false,
        taskSpaceId: spaceId,
        bindingId: binding.id,
        ...(taskSpaceRetired ? { taskSpaceRetired: true } : {}),
      }
    })
  }

  return { authorizeTaskSpace, listenerDetails, detachAgent }
}
