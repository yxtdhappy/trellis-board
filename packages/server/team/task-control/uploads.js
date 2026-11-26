import crypto from 'node:crypto'
import { ERROR_CODES, teamError } from '../errors.js'
import { canonicalKey, hashJson, parseTask, text } from './shared.js'

/** 上传通道：写入前守卫、任务目录文档解析、内容落库、改派命令入队。 */
export function createUploads({ statements, views, leases, tasks, now = () => new Date() }) {
  function documentForUpload(taskSpaceId, taskDir, files) {
    const rows = new Map(
      statements.readTaskDirFiles.all(taskSpaceId, taskDir).map((row) => [row.relative_path, row]),
    )
    for (const file of files) {
      if (file.deleted) rows.delete(file.path)
      else {
        rows.set(file.path, {
          relative_path: file.path,
          content_text: file.content,
          deleted: 0,
          task_dir: file.taskDir,
        })
      }
    }
    const taskJson = [...rows.values()].find(
      (row) => !row.deleted && row.relative_path.endsWith('/task.json'),
    )
    return {
      document: parseTask(taskJson?.content_text),
      taskJsonSha256: taskJson
        ? crypto
            .createHash('sha256')
            .update(taskJson.content_text || '')
            .digest('hex')
        : null,
    }
  }

  /** 服务端尚无任务行时，上传者必须是该任务解析出的负责人，否则任何人都能替别人建行。 */
  function assertNewTaskOwnedByUploader({ agent, taskSpaceId, complete, context }) {
    const files = Array.isArray(context.files) ? context.files : []
    if (!context.projectId || !complete.taskDir || !files.some((file) => !file.deleted)) return
    const { document } = documentForUpload(taskSpaceId, complete.taskDir, files)
    const assignee = tasks.resolveAssignee(context.projectId, document, agent.userId)
    if (assignee.userId !== agent.userId) {
      throw teamError(403, 'TASK_WRITE_FORBIDDEN', '任务负责人不是本机用户，不能新建任务', {
        details: {
          taskId: complete.taskId,
          taskDir: complete.taskDir,
          assigneeUserId: assignee.userId,
        },
      })
    }
  }

  function assertUploadAllowed(agent, taskSpaceId, complete, input = {}, context = {}) {
    views.assertAgentAccess(agent, taskSpaceId)
    const executionTaskKey =
      complete.taskId == null ? null : canonicalKey(taskSpaceId, complete.taskId)
    const row = executionTaskKey ? statements.readTask.get(executionTaskKey) : null
    if (!row) {
      if (complete.taskDir && views.isArchivedTaskDir(taskSpaceId, complete.taskDir)) {
        throw teamError(409, 'TASK_ARCHIVED', '任务已归档，拒绝旧客户端重新写回', {
          details: {
            executionTaskKey,
            taskId: complete.taskId,
            taskDir: complete.taskDir,
          },
        })
      }
      assertNewTaskOwnedByUploader({ agent, taskSpaceId, complete, context })
      return { task: null, lease: null }
    }
    if (row.archived) {
      throw teamError(409, 'TASK_ARCHIVED', '任务已归档，拒绝旧客户端重新写回', {
        details: {
          executionTaskKey,
          taskId: row.task_id,
          archivedAt: row.archived_at,
        },
      })
    }
    if (row.assignee_user_id && row.assignee_user_id !== agent.userId) {
      throw teamError(409, 'TASK_WRITE_FORBIDDEN', '任务已改派给其他负责人，本客户端只读', {
        details: {
          executionTaskKey,
          taskId: row.task_id,
          assigneeUserId: row.assignee_user_id,
        },
      })
    }
    const incomingVersion = Number(input.taskVersion)
    if (!Number.isSafeInteger(incomingVersion)) {
      throw teamError(409, 'TASK_VERSION_REQUIRED', '客户端必须先获取任务版本再写入', {
        details: {
          executionTaskKey,
          expectedTaskVersion: Number(row.task_version),
        },
      })
    }
    if (incomingVersion !== Number(row.task_version)) {
      throw teamError(409, 'TASK_VERSION_STALE', '本地任务版本已落后，请先拉取最新控制状态', {
        details: {
          executionTaskKey,
          expectedTaskVersion: Number(row.task_version),
          receivedTaskVersion: incomingVersion,
        },
      })
    }
    const lease = views.activeLease(executionTaskKey)
    if (lease && lease.agent_id !== agent.id) {
      throw teamError(409, 'TASK_LEASE_HELD', '任务正由其他客户端修改', {
        details: { executionTaskKey, leaseExpiresAt: lease.expires_at },
      })
    }
    const token = text(input.leaseToken, 200)
    if (!token) {
      throw teamError(409, 'TASK_LEASE_REQUIRED', '客户端必须先认领任务写租约再上传')
    }
    if (!lease || lease.lease_token !== token) {
      throw teamError(409, 'TASK_LEASE_INVALID', '任务写租约无效或已过期')
    }
    return { task: row, lease }
  }

  function enqueueAssignmentCommand({
    actorUserId,
    taskSpaceId,
    task,
    assigneeUserId,
    assigneeDevId,
  }) {
    const payload = {
      executionTaskKey: task.execution_task_key,
      taskKey: task.task_key,
      relativeDir: task.relative_dir,
      assigneeUserId,
      assigneeDevId,
      baseTaskVersion: Number(task.task_version),
    }
    const requestHash = hashJson({ commandType: 'assign_task', taskSpaceId, payload })
    const idempotencyKey = `local-assign-${task.execution_task_key}-${task.task_version}`
    const existing = statements.readCommandByIdempotency.get(actorUserId, idempotencyKey)
    if (existing) {
      if (existing.request_hash !== requestHash) {
        throw teamError(409, ERROR_CODES.CONFLICT, '本任务改派命令发生内容冲突')
      }
      return existing
    }
    const id = crypto.randomUUID()
    const timestamp = now().toISOString()
    statements.insertCommand.run(
      id,
      taskSpaceId,
      task.project_id,
      assigneeUserId,
      idempotencyKey,
      requestHash,
      JSON.stringify(payload),
      actorUserId,
      timestamp,
      timestamp,
    )
    return statements.readCommandById.get(id)
  }

  function commitUpload({ agent, space, complete, files, revision, contentChanged = false }) {
    const taskDir = complete.taskDir
    if (!taskDir || !complete.taskId) return { task: null, lease: null }
    const { document } = documentForUpload(space.id, taskDir, files)
    const existing = statements.readTask.get(canonicalKey(space.id, complete.taskId))
    if (existing?.archived) {
      throw teamError(409, 'TASK_ARCHIVED', '任务已归档，拒绝旧客户端重新写回')
    }
    const assignee = existing?.assignee_user_id
      ? {
          userId: existing.assignee_user_id,
          devId: existing.assignee_dev_id || null,
        }
      : tasks.resolveAssignee(space.project_id, document, agent.userId)
    const timestamp = now().toISOString()
    const title = text(document?.title, 200) || existing?.title || complete.taskId
    const description = document ? text(document.description, 4000) : existing?.description || ''
    const priority = text(document?.priority, 8) || existing?.priority || 'P2'
    const stage =
      text(document?.execution?.stage || document?.stage, 80) || existing?.stage || 'planning'
    const taskKey = `${space.id}::${taskDir}`
    const metadataChanged =
      !existing ||
      existing.relative_dir !== taskDir ||
      existing.title !== title ||
      existing.description !== description ||
      existing.priority !== priority ||
      existing.stage !== stage ||
      existing.assignee_user_id !== assignee.userId ||
      existing.assignee_dev_id !== assignee.devId
    const taskVersion = existing
      ? Number(existing.task_version) + (contentChanged || metadataChanged ? 1 : 0)
      : 1
    const isTargetWriter = assignee.userId === agent.userId
    // 内容上传只推进 materialization；来源清理必须等命令结果和索引校验完成后由
    // completeCommand() 按命令类型收敛，避免 create_task 在命令确认前误触发清理。
    const handoffState = existing?.handoff_state || 'none'
    if (!existing) {
      statements.insertTaskFromUpload.run(
        canonicalKey(space.id, complete.taskId),
        taskKey,
        space.id,
        space.project_id,
        complete.taskId,
        taskDir,
        title,
        description,
        priority,
        agent.userId,
        assignee.userId,
        assignee.devId,
        stage,
        isTargetWriter ? 'materialized' : 'pending',
        taskVersion,
        revision,
        handoffState,
        isTargetWriter ? agent.id : null,
        isTargetWriter ? timestamp : null,
        isTargetWriter ? revision : null,
        document ? hashJson(document) : null,
        timestamp,
        timestamp,
      )
    } else {
      statements.updateTaskFromUpload.run(
        taskKey,
        taskDir,
        title,
        description,
        priority,
        assignee.userId,
        assignee.devId,
        existing.assignee_user_id !== assignee.userId
          ? existing.assignee_user_id
          : existing.previous_assignee_user_id,
        stage,
        isTargetWriter ? 'materialized' : 'pending',
        taskVersion,
        revision,
        handoffState,
        isTargetWriter ? 1 : 0,
        agent.id,
        isTargetWriter ? 1 : 0,
        timestamp,
        isTargetWriter ? 1 : 0,
        revision,
        isTargetWriter ? 1 : 0,
        document ? hashJson(document) : null,
        timestamp,
        existing.execution_task_key,
      )
      if (existing.assignee_user_id !== assignee.userId) {
        leases.revokeLeases(existing.execution_task_key, timestamp)
      }
    }
    const task = statements.readTask.get(canonicalKey(space.id, complete.taskId))
    let lease = null
    if (isTargetWriter) {
      lease = leases.ensureLease(task.execution_task_key, agent)
    } else if (existing?.assignee_user_id !== assignee.userId) {
      enqueueAssignmentCommand({
        actorUserId: agent.userId,
        taskSpaceId: space.id,
        task,
        assigneeUserId: assignee.userId,
        assigneeDevId: assignee.devId,
      })
    }
    return { task: views.publicTask(task), lease: views.publicLease(lease) }
  }

  return { assertUploadAllowed, commitUpload }
}
