import crypto from 'node:crypto'
import { appendAuditEvent } from '../audit.js'
import { ERROR_CODES, teamError } from '../errors.js'
import { affectedDirectoryRows, taskBranchFromJson, taskIdFromJson } from './shared.js'

export function createOwnership({ db, statements }) {
  function baselineOwnsTask(projectId, taskId) {
    if (!taskId) return false
    return Boolean(statements.baselineOwnsTask.get(taskId, projectId))
  }

  function mergeEvidenceRow(projectId, taskId) {
    if (!taskId) return null
    return statements.mergeEvidence.get(projectId, taskId) || null
  }

  function filesTaskJson(complete, evidence) {
    return complete.trackedPath === evidence.trackedPath && complete.taskDir === evidence.taskDir
  }

  function validateTaskOwnership({ space, complete, evidence, observedBranch }) {
    if (!complete.taskId) {
      throw teamError(409, ERROR_CODES.CONFLICT, '任务目录缺少稳定任务 ID，整批拒绝')
    }
    const baselineBranch = space.project?.baseline_branch || ''
    if (!baselineBranch) {
      if (complete.taskBranch && complete.taskBranch !== space.branch_name) {
        throw teamError(
          409,
          'TASK_OWNERSHIP_MISMATCH',
          'task.json 分支与任务空间不一致，整批拒绝',
          {
            details: {
              taskId: complete.taskId,
              taskDir: complete.taskDir,
              expectedBranchName: space.branch_name,
              actualBranchName: complete.taskBranch,
            },
          },
        )
      }
      if (evidence) {
        throw teamError(409, 'TASK_MERGE_EVIDENCE_INVALID', '项目尚未配置基线分支')
      }
      return { persistEvidence: false }
    }
    const isBaseline = space.branch_name === baselineBranch
    const ownsTask = baselineOwnsTask(space.project_id, complete.taskId)
    const priorEvidence = mergeEvidenceRow(space.project_id, complete.taskId)
    const sameBranch = complete.taskBranch === space.branch_name
    if (evidence) {
      if (!isBaseline || observedBranch !== space.branch_name) {
        throw teamError(409, 'TASK_MERGE_EVIDENCE_INVALID', '只有基线任务空间可以提交合入证据')
      }
      const taskJson = filesTaskJson(complete, evidence)
      if (
        evidence.taskId !== complete.taskId ||
        evidence.taskDir !== complete.taskDir ||
        evidence.sourceBranch !== complete.taskBranch ||
        evidence.baselineBranch !== baselineBranch ||
        !taskJson
      ) {
        throw teamError(
          409,
          'TASK_MERGE_EVIDENCE_INVALID',
          '合入证据与任务内容或分支不一致，整批拒绝',
        )
      }
    }
    if (isBaseline) {
      if (!sameBranch && !ownsTask && !priorEvidence && !evidence) {
        throw teamError(
          409,
          'TASK_MERGE_EVIDENCE_REQUIRED',
          '任务来源分支与基线不同，缺少合入证据',
          {
            details: {
              taskId: complete.taskId,
              taskDir: complete.taskDir,
              sourceBranch: complete.taskBranch,
              baselineBranch,
            },
          },
        )
      }
      return { persistEvidence: Boolean(evidence) }
    }
    if (complete.taskBranch && complete.taskBranch !== space.branch_name) {
      throw teamError(409, 'TASK_OWNERSHIP_MISMATCH', 'task.json 分支与任务空间不一致，整批拒绝', {
        details: {
          taskId: complete.taskId,
          taskDir: complete.taskDir,
          expectedBranchName: space.branch_name,
          actualBranchName: complete.taskBranch,
        },
      })
    }
    if (ownsTask || priorEvidence) {
      throw teamError(
        409,
        'TASK_OWNED_BY_BASELINE',
        '任务已由基线任务空间接管，来源副本只保留只读快照',
        {
          details: {
            taskId: complete.taskId,
            taskDir: complete.taskDir,
            baselineBranch,
          },
        },
      )
    }
    return { persistEvidence: false }
  }

  function persistMergeEvidence({ agent, space, complete, evidence, timestamp }) {
    if (!evidence) return false
    const existing = mergeEvidenceRow(space.project_id, complete.taskId)
    if (existing) {
      if (
        existing.baseline_task_space_id !== space.id ||
        existing.source_branch_name !== evidence.sourceBranch ||
        existing.baseline_branch_name !== evidence.baselineBranch
      ) {
        throw teamError(409, 'TASK_MERGE_EVIDENCE_INVALID', '同一任务已有不同的合入证据')
      }
      statements.updateMergeEvidence.run(
        `${space.project_id}::${complete.taskId}`,
        evidence.taskDir,
        evidence.trackedPath,
        evidence.headCommit,
        agent.id,
        agent.userId,
        existing.id,
      )
      return false
    }
    const evidenceId = crypto.randomUUID()
    statements.insertMergeEvidence.run(
      evidenceId,
      space.project_id,
      complete.taskId,
      `${space.project_id}::${complete.taskId}`,
      space.id,
      evidence.taskDir,
      evidence.trackedPath,
      evidence.sourceBranch,
      evidence.baselineBranch,
      evidence.headCommit,
      agent.id,
      agent.userId,
      timestamp,
    )
    appendAuditEvent(db, {
      actorUserId: agent.userId,
      actorAgentId: agent.id,
      teamId: space.project?.owner_team_id || null,
      projectId: space.project_id,
      action: 'task_merge_evidence_accepted',
      targetType: 'task',
      targetId: complete.taskId,
      detail: {
        taskId: complete.taskId,
        taskDir: evidence.taskDir,
        headCommit: evidence.headCommit,
        sourceBranch: evidence.sourceBranch,
        baselineTaskSpaceId: space.id,
      },
      occurredAt: timestamp,
    })
    return true
  }

  function validateCompleteTaskGroups(taskSpaceId, files, expectedBranchName) {
    const taskDirs = [...new Set(files.map((file) => file.taskDir))]
    if (taskDirs.length > 2) {
      throw teamError(400, ERROR_CODES.INVALID_INPUT, '单批最多只能涉及一个任务目录或一次归档移动')
    }
    const existing = affectedDirectoryRows(statements, taskSpaceId, taskDirs)
    const merged = new Map(existing.map((row) => [row.relative_path, row]))
    for (const file of files) {
      if (file.deleted) merged.delete(file.path)
      else {
        merged.set(file.path, {
          relative_path: file.path,
          content_text: file.content,
          sha256: file.sha256,
          task_dir: file.taskDir,
        })
      }
    }
    const previousIds = new Map()
    const previousMetadata = new Map()
    for (const taskDir of taskDirs) {
      const taskJson = existing.find(
        (row) => row.task_dir === taskDir && row.relative_path.endsWith('/task.json'),
      )
      const taskId = taskIdFromJson(taskJson?.content_text)
      if (taskId) previousIds.set(taskDir, taskId)
      if (taskId) {
        previousMetadata.set(taskDir, {
          taskId,
          taskBranch: taskBranchFromJson(taskJson.content_text),
          trackedPath: taskJson.relative_path,
        })
      }
    }
    const groups = new Map()
    for (const row of merged.values()) {
      if (!groups.has(row.task_dir)) groups.set(row.task_dir, [])
      groups.get(row.task_dir).push(row)
    }
    const currentIds = new Map()
    const currentMetadata = new Map()
    for (const taskDir of taskDirs) {
      const rows = groups.get(taskDir) || []
      if (!rows.length) continue
      const taskJson = rows.find((row) => row.relative_path.endsWith('/task.json'))
      if (!taskJson) {
        throw teamError(409, ERROR_CODES.CONFLICT, '任务目录缺少 task.json，整批拒绝')
      }
      const taskId = taskIdFromJson(taskJson.content_text)
      if (!taskId) {
        throw teamError(409, ERROR_CODES.CONFLICT, 'task.json 缺少稳定任务 ID，整批拒绝')
      }
      const taskBranch = taskBranchFromJson(taskJson.content_text)
      if (!taskBranch) {
        throw teamError(409, 'TASK_OWNERSHIP_REQUIRED', 'task.json 缺少分支归属，整批拒绝', {
          details: { taskId, taskDir, expectedBranchName, actualBranchName: taskBranch },
        })
      }
      const previousId = previousIds.get(taskDir)
      if (previousId && previousId !== taskId) {
        throw teamError(409, ERROR_CODES.CONFLICT, '同一任务目录的 task.json id 不能变化，整批拒绝')
      }
      currentIds.set(taskDir, taskId)
      currentMetadata.set(taskDir, {
        taskId,
        taskBranch,
        trackedPath: taskJson.relative_path,
      })
    }
    if (taskDirs.length === 2 && !files.some((file) => !file.deleted)) {
      throw teamError(400, ERROR_CODES.INVALID_INPUT, '任务移动必须同时包含新目录文件')
    }
    const removed = [...previousIds].filter(([taskDir]) => !currentIds.has(taskDir))
    const added = [...currentIds].filter(([taskDir]) => !previousIds.has(taskDir))
    if (
      taskDirs.length === 2 &&
      (removed.length !== 1 || added.length !== 1 || removed[0][1] !== added[0][1])
    ) {
      throw teamError(409, ERROR_CODES.CONFLICT, '任务移动前后的 task.json id 不一致')
    }
    const taskId = [...currentIds.values()][0] || [...previousIds.values()][0] || null
    const selected =
      [...currentMetadata].find(([, metadata]) => metadata.taskId === taskId) ||
      [...previousMetadata].find(([, metadata]) => metadata.taskId === taskId) ||
      null
    return {
      taskDirs,
      taskId,
      taskDir: selected?.[0] || taskDirs[0] || null,
      taskBranch: selected?.[1].taskBranch || null,
      trackedPath: selected?.[1].trackedPath || null,
    }
  }

  return { validateTaskOwnership, persistMergeEvidence, validateCompleteTaskGroups }
}
