import crypto from 'node:crypto'
import {
  formatGitRemote,
  gitRemoteIdentityKey,
  normalizeGitRemote,
  validateGitBranchName,
} from '@trellis-board/shared/remote-identity.js'
import { withTransaction } from '../../database.js'
import { appendAuditEvent } from '../audit.js'
import { ERROR_CODES, teamError } from '../errors.js'
import { assertLocalRepoKey, nowIso, optionalText, requiredText, SAFE_ID } from './shared.js'

export function createAttach({
  db,
  statements,
  access,
  view,
  allowFileRemote,
  onTaskSpaceWorktreeMarked = null,
}) {
  function attach(userId, agentId, input = {}) {
    const actor = access.actorContext(userId, input.teamId)
    const teamId = requiredText(input.teamId, '归属团队', 128)
    if (!actor.systemAdmin && !actor.teams.some((team) => team.id === teamId)) {
      throw teamError(403, ERROR_CODES.FORBIDDEN, '不能把项目归属到无权访问的团队')
    }
    const branchName = validateGitBranchName(input.branchName)
    const identity = normalizeGitRemote(input.remoteUrl, { allowFileRemote })
    const identityHash = gitRemoteIdentityKey(input.remoteUrl, { allowFileRemote })
    const displayName = requiredText(input.displayName || actor.user.displayName, '项目名称', 120)
    const developerId = optionalText(input.developerId || input.trellisDevId, 120)
    const localRepoKey = assertLocalRepoKey(input.localRepoKey)
    const requestedWorktree = input.isWorktree === true
    const safeAgentId = requiredText(agentId, 'Agent ID', 128)
    if (!SAFE_ID.test(safeAgentId)) {
      throw teamError(400, ERROR_CODES.INVALID_INPUT, 'Agent ID 格式无效')
    }

    let worktreeMarkedSpaceId = null
    const result = withTransaction(db, () => {
      const agent = statements.activeAgentDevice.get(safeAgentId)
      if (!agent || agent.user_id !== userId) {
        throw teamError(403, ERROR_CODES.FORBIDDEN, 'Agent 设备与当前账号不匹配')
      }
      let project = statements.projectByRemoteHash.get(identityHash)
      const now = nowIso()
      if (!project) {
        project = {
          id: crypto.randomUUID(),
          name: displayName,
          remote_url: formatGitRemote(identity),
          remote_identity_hash: identityHash,
          baseline_branch: branchName,
          owner_team_id: teamId,
          status: 'active',
          created_by_user_id: userId,
          created_by_agent_id: safeAgentId,
          created_at: now,
          updated_at: now,
        }
        statements.insertProject.run(
          project.id,
          project.name,
          project.remote_url,
          project.remote_identity_hash,
          project.owner_team_id,
          project.baseline_branch,
          userId,
          safeAgentId,
          now,
          now,
        )
        statements.insertOwnerTeamAccess.run(project.id, teamId, userId, now)
      } else if (!project.baseline_branch) {
        statements.updateProjectBaseline.run(branchName, now, project.id)
        project.baseline_branch = branchName
      }

      const accessContext = access.accessContext(actor)
      if (!access.projectAccessible(project, actor, accessContext, teamId)) {
        throw teamError(
          409,
          'TASK_SPACE_ACCESS_REQUIRED',
          '项目已存在但当前团队没有访问权限，请联系项目负责人邀请后再接入',
          { details: { projectId: project.id, projectName: project.name } },
        )
      }
      let member = statements.projectMemberByUser.get(project.id, userId)
      if (!member) {
        const ownerTeam = project.owner_team_id === teamId
        const role = ownerTeam ? 'lead' : 'read_only'
        if (role !== 'read_only' && !developerId) {
          throw teamError(
            400,
            ERROR_CODES.INVALID_INPUT,
            '项目首次接入必须填写 Trellis developer ID',
          )
        }
        statements.insertProjectMember.run(project.id, userId, role, developerId, userId, now, now)
        member = statements.projectMemberByUser.get(project.id, userId)
      } else if (developerId && developerId !== member.trellis_dev_id) {
        statements.updateMemberDevId.run(developerId, now, project.id, userId)
        member = { ...member, trellis_dev_id: developerId, updated_at: now }
      }

      const isBaseline = Boolean(project.baseline_branch && branchName === project.baseline_branch)
      const desiredWorktree = requestedWorktree && !isBaseline ? 1 : 0
      let taskSpace = statements.taskSpaceByProjectBranch.get(project.id, branchName)
      if (!taskSpace) {
        taskSpace = {
          id: crypto.randomUUID(),
          project_id: project.id,
          branch_name: branchName,
          is_worktree: desiredWorktree,
          status: 'active',
          revision: 0,
          indexed_revision: 0,
          last_error: null,
          created_by_user_id: userId,
          created_by_agent_id: safeAgentId,
          created_at: now,
          updated_at: now,
        }
        statements.insertTaskSpace.run(
          taskSpace.id,
          project.id,
          branchName,
          desiredWorktree,
          userId,
          safeAgentId,
          now,
          now,
        )
      } else {
        if (
          taskSpace.retired_at &&
          Number(taskSpace.is_worktree) === 1 &&
          project.status === 'active'
        ) {
          statements.restoreTaskSpace.run(now, taskSpace.id, project.id)
          taskSpace = {
            ...taskSpace,
            status: 'active',
            retired_at: null,
            retired_by_user_id: null,
            retired_reason: null,
            updated_at: now,
          }
          appendAuditEvent(db, {
            actorUserId: userId,
            actorAgentId: safeAgentId,
            teamId: project.owner_team_id,
            projectId: project.id,
            action: 'task_space_restored',
            targetType: 'task_space',
            targetId: taskSpace.id,
            detail: {
              branchName,
              autoRestoredWorktree: true,
              isWorktree: desiredWorktree === 1,
            },
            occurredAt: now,
          })
        }
      }
      if (taskSpace.status === 'disabled' || taskSpace.retired_at || project.status !== 'active') {
        throw teamError(409, ERROR_CODES.PROJECT_NOT_READY, '项目或任务空间已停用')
      }
      if (desiredWorktree === 0 && Number(taskSpace.is_worktree) === 1) {
        statements.updateTaskSpaceWorktree.run(0, now, taskSpace.id)
        taskSpace = { ...taskSpace, is_worktree: 0, updated_at: now }
      } else if (desiredWorktree === 1 && Number(taskSpace.is_worktree) === 0) {
        const archiveState = statements.archiveSyncStateByTaskSpace.get(taskSpace.id)
        if (!archiveState?.last_success_at) {
          statements.updateTaskSpaceWorktree.run(1, now, taskSpace.id)
          statements.resetArchiveSyncStateForWorktree.run(now, taskSpace.id)
          taskSpace = { ...taskSpace, is_worktree: 1, updated_at: now }
          worktreeMarkedSpaceId = taskSpace.id
        }
      }
      const replacedBindings = statements.replacedBindings.all(
        safeAgentId,
        localRepoKey,
        taskSpace.id,
      )
      if (replacedBindings.length) {
        const bindingIds = replacedBindings.map((item) => item.id)
        statements.revokeBindingsByIds(bindingIds.length).run(now, ...bindingIds)
        statements.cancelCommandsByBindingIds(bindingIds.length).run(now, ...bindingIds)
      }
      let binding = statements.bindingByAgentSpace.get(safeAgentId, taskSpace.id)
      if (!binding) {
        binding = { id: crypto.randomUUID() }
        statements.insertBinding.run(
          binding.id,
          safeAgentId,
          taskSpace.id,
          localRepoKey,
          displayName,
          branchName,
          now,
          now,
        )
      } else {
        const resetListener =
          binding.sync_status !== 'approved' || binding.local_repo_key !== localRepoKey
        statements.updateBindingApproved.run(
          localRepoKey,
          displayName,
          branchName,
          resetListener ? 0 : binding.is_listening,
          resetListener ? null : binding.listener_reported_at,
          now,
          binding.id,
        )
      }
      binding = statements.bindingById.get(binding.id)
      if (replacedBindings.length) {
        appendAuditEvent(db, {
          actorUserId: userId,
          actorAgentId: safeAgentId,
          teamId: project.owner_team_id,
          projectId: project.id,
          action: 'task_space_binding_replaced',
          targetType: 'agent_binding',
          targetId: binding.id,
          detail: {
            localRepoKey,
            newBranchName: branchName,
            newTaskSpaceId: taskSpace.id,
            replaced: replacedBindings.map((item) => ({
              bindingId: item.id,
              taskSpaceId: item.task_space_id,
              branchName: item.branch_name,
            })),
          },
          occurredAt: now,
        })
      }
      const refreshedAccess = access.accessContext(actor)
      const summaries = view.listenerSummariesFor([taskSpace.id])
      return {
        project: view.projectPublic(statements.projectById.get(project.id), refreshedAccess),
        taskSpace: view.taskSpacePublic(
          {
            ...taskSpace,
            baseline_branch: project.baseline_branch,
            team_id: project.owner_team_id,
            project_status: project.status,
          },
          actor,
          refreshedAccess,
          summaries.get(taskSpace.id),
        ),
        binding: {
          id: binding.id,
          agentId: binding.agent_id,
          taskSpaceId: binding.task_space_id,
          projectId: project.id,
          branchName: binding.branch_name,
          status: binding.sync_status,
          readOnly: !['lead', 'member'].includes(member.role),
        },
        replacedBindings: replacedBindings.map((item) => ({
          id: item.id,
          taskSpaceId: item.task_space_id,
          branchName: item.branch_name,
          status: 'revoked',
        })),
      }
    })
    if (worktreeMarkedSpaceId) {
      onTaskSpaceWorktreeMarked?.(worktreeMarkedSpaceId)
    }
    return result
  }

  return { attach }
}
