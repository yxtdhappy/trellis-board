import { withTransaction } from '../../database.js'
import { appendAuditEvent } from '../audit.js'
import { ERROR_CODES, teamError } from '../errors.js'

export function createLifecycle({
  db,
  statements,
  access,
  view,
  now,
  backupService,
  onTaskSpacePurged,
}) {
  function listTaskSpaces(
    projectId,
    actor,
    { includeRetired = false, includeTaskTitles = false } = {},
  ) {
    const project = access.readProject(projectId, actor)
    if (!project) throw teamError(404, ERROR_CODES.NOT_FOUND, '项目不存在')
    const statement = includeRetired
      ? statements.taskSpacesForProjectAll
      : statements.taskSpacesForProjectActive
    const rows = statement.all(projectId)
    const summaries = view.listenerSummariesFor(rows.map((row) => row.id))
    const stats = view.taskSpaceStatsFor(
      rows.map((row) => row.id),
      { includeTaskTitles },
    )
    return rows.map((row) =>
      view.taskSpacePublic(row, actor, project.access, summaries.get(row.id), stats.get(row.id)),
    )
  }

  function listAdminTaskSpaces(actor, projectId) {
    access.manageContext(actor, projectId)
    return listTaskSpaces(projectId, actor, {
      includeRetired: true,
      includeTaskTitles: true,
    })
  }

  function loadManagedTaskSpace(actor, projectId, taskSpaceId) {
    const context = access.manageContext(actor, projectId)
    const taskSpace = access.loadTaskSpaceRow(taskSpaceId)
    if (!taskSpace || taskSpace.project_id !== context.project.id) {
      throw teamError(404, ERROR_CODES.NOT_FOUND, '任务空间不存在')
    }
    return { ...context, taskSpace }
  }

  function taskSpaceAdminView(taskSpace, actor, accessContext) {
    const summaries = view.listenerSummariesFor([taskSpace.id])
    const stats = view.taskSpaceStatsFor([taskSpace.id], { includeTaskTitles: true })
    return view.taskSpacePublic(
      taskSpace,
      actor,
      accessContext,
      summaries.get(taskSpace.id),
      stats.get(taskSpace.id),
    )
  }

  function backupLabel(file) {
    return (
      String(file || '')
        .split(/[\\/]/)
        .pop() || null
    )
  }

  function retireTaskSpace(actor, projectId, taskSpaceId, input = {}) {
    const {
      project,
      access: accessContext,
      taskSpace,
    } = loadManagedTaskSpace(actor, projectId, taskSpaceId)
    const rawReason = String(input.reason || '').trim()
    if (rawReason.length > 500) {
      throw teamError(400, ERROR_CODES.INVALID_INPUT, '弃用原因不能超过 500 个字符')
    }
    if (taskSpace.retired_at) {
      return {
        ...taskSpaceAdminView(taskSpace, actor, accessContext),
        alreadyRetired: true,
        affectedBindingCount: 0,
      }
    }
    const timestamp = now().toISOString()
    let affectedBindingCount = 0
    withTransaction(db, () => {
      affectedBindingCount = Number(statements.approvedBindingCount.get(taskSpace.id).count || 0)
      statements.retireTaskSpace.run(
        timestamp,
        actor.userId,
        rawReason || null,
        timestamp,
        taskSpace.id,
        project.id,
      )
      statements.stopBindingsForTaskSpace.run(timestamp, taskSpace.id)
      statements.cancelCommandsForTaskSpace.run(timestamp, taskSpace.id)
      appendAuditEvent(db, {
        actorUserId: actor.userId,
        teamId: project.owner_team_id,
        projectId: project.id,
        action: 'task_space_retired',
        targetType: 'task_space',
        targetId: taskSpace.id,
        detail: {
          branchName: taskSpace.branch_name,
          previousStatus: taskSpace.status,
          reason: rawReason || null,
          affectedBindingCount,
        },
        occurredAt: timestamp,
      })
    })
    const updated = {
      ...taskSpace,
      status: 'disabled',
      retired_at: timestamp,
      retired_by_user_id: actor.userId,
      retired_reason: rawReason || null,
      updated_at: timestamp,
    }
    return {
      ...taskSpaceAdminView(updated, actor, accessContext),
      alreadyRetired: false,
      affectedBindingCount,
    }
  }

  function restoreTaskSpace(actor, projectId, taskSpaceId) {
    const {
      project,
      access: accessContext,
      taskSpace,
    } = loadManagedTaskSpace(actor, projectId, taskSpaceId)
    if (!taskSpace.retired_at) {
      throw teamError(409, ERROR_CODES.CONFLICT, '任务空间不是已弃用状态')
    }
    const timestamp = now().toISOString()
    withTransaction(db, () => {
      statements.restoreTaskSpace.run(timestamp, taskSpace.id, project.id)
      statements.stopBindingsForTaskSpace.run(timestamp, taskSpace.id)
      appendAuditEvent(db, {
        actorUserId: actor.userId,
        teamId: project.owner_team_id,
        projectId: project.id,
        action: 'task_space_restored',
        targetType: 'task_space',
        targetId: taskSpace.id,
        detail: {
          branchName: taskSpace.branch_name,
          previousRetiredAt: taskSpace.retired_at,
        },
        occurredAt: timestamp,
      })
    })
    const updated = {
      ...taskSpace,
      status: 'active',
      retired_at: null,
      retired_by_user_id: null,
      retired_reason: null,
      updated_at: timestamp,
    }
    return taskSpaceAdminView(updated, actor, accessContext)
  }

  function purgeTaskSpace(actor, projectId, taskSpaceId, input = {}) {
    const {
      project,
      access: accessContext,
      taskSpace,
    } = loadManagedTaskSpace(actor, projectId, taskSpaceId)
    const confirmation = typeof input.confirmation === 'string' ? input.confirmation : ''
    if (!confirmation || confirmation !== taskSpace.branch_name) {
      throw teamError(400, ERROR_CODES.INVALID_INPUT, '分支确认名称不匹配')
    }
    if (!backupService?.backupNowOrThrow) {
      throw teamError(503, 'DATABASE_BACKUP_UNAVAILABLE', '数据库备份服务不可用，已取消移除分支')
    }
    const summary = taskSpaceAdminView(taskSpace, actor, accessContext)
    const unarchivedTasks = statements.unarchivedTitles.all(taskSpace.id).map((row) => row.title)
    const affectedAgentIds = statements.bindingAgentIds.all(taskSpace.id).map((row) => row.agent_id)
    const pendingConflictCount = Number(statements.pendingConflicts.get(taskSpace.id).count || 0)
    const activeCommandCount = Number(
      statements.activeCommandsForTaskSpace.get(taskSpace.id).count || 0,
    )
    let backupFile
    try {
      backupFile = backupService.backupNowOrThrow({ force: true })
    } catch {
      throw teamError(503, 'DATABASE_BACKUP_FAILED', '数据库备份失败，已取消移除分支')
    }
    if (!backupFile) {
      throw teamError(503, 'DATABASE_BACKUP_FAILED', '数据库备份失败，已取消移除分支')
    }
    const detail = {
      branchName: taskSpace.branch_name,
      taskCount: summary.taskCount,
      fileCount: summary.fileCount,
      activeTaskCount: summary.activeTaskCount,
      archivedTaskCount: summary.archivedTaskCount,
      unarchivedTasks,
      approvedBindingCount: summary.approvedBindingCount,
      onlineListenerCount: summary.onlineListenerCount,
      affectedAgentIds,
      pendingConflictCount,
      activeCommandCount,
      backupName: backupLabel(backupFile),
    }
    withTransaction(db, () => {
      const current = statements.taskSpaceIdentity.get(taskSpace.id, project.id)
      if (!current) throw teamError(404, ERROR_CODES.NOT_FOUND, '任务空间不存在')
      if (current.branch_name !== confirmation) {
        throw teamError(409, ERROR_CODES.CONFLICT, '任务空间分支已变化，请刷新后重试')
      }
      appendAuditEvent(db, {
        actorUserId: actor.userId,
        teamId: project.owner_team_id,
        projectId: project.id,
        action: 'task_space_purged',
        targetType: 'task_space',
        targetId: taskSpace.id,
        detail,
        occurredAt: now().toISOString(),
      })
      const result = statements.deleteTaskSpace.run(taskSpace.id, project.id)
      if (Number(result.changes) !== 1) {
        throw teamError(409, ERROR_CODES.CONFLICT, '任务空间状态已变化，请刷新后重试')
      }
    })
    try {
      onTaskSpacePurged?.(taskSpace.id)
    } catch {
      // 文件清理失败由后续启动清理重试，不能把已提交的数据库删除报成失败。
    }
    return {
      purged: true,
      taskSpaceId: taskSpace.id,
      branchName: taskSpace.branch_name,
      backupName: backupLabel(backupFile),
      summary: detail,
    }
  }

  return {
    listTaskSpaces,
    listAdminTaskSpaces,
    retireTaskSpace,
    restoreTaskSpace,
    purgeTaskSpace,
  }
}
