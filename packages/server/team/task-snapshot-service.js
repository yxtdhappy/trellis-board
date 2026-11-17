import crypto from 'node:crypto'
import { withTransaction } from '../database.js'
import {
  ARCHIVE_SYNC_SERVER_MANAGED,
  classifyTaskSnapshots,
  groupTaskSnapshotFiles,
  isArchiveTaskDirectory,
  isArchiveTaskPath,
  snapshotSha256,
  TASK_SNAPSHOT_LIMIT_ERROR_CODE,
  validateSnapshotFile,
} from '@trellis-board/shared/task-snapshot.js'
import { validateGitBranchName } from '@trellis-board/shared/remote-identity.js'
import { appendAuditEvent } from './audit.js'
import { ERROR_CODES, teamError } from './errors.js'

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const MAX_RATE_BATCHES_PER_SECOND = 5

function requireSnapshotGroups(files, options) {
  try {
    return groupTaskSnapshotFiles(files, options)
  } catch (error) {
    if (error?.code === TASK_SNAPSHOT_LIMIT_ERROR_CODE) {
      throw teamError(413, ERROR_CODES.BODY_TOO_LARGE, error.message)
    }
    throw error
  }
}

function rejectArchiveGroups(groups) {
  if ((groups || []).some((group) => group.archived)) {
    throw teamError(
      409,
      ARCHIVE_SYNC_SERVER_MANAGED,
      '归档任务由服务端 Git 索引管理，Agent 批次已整批拒绝',
    )
  }
  return groups
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  )
}

function hashJson(value) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(stableValue(value)))
    .digest('hex')
}

function parseJson(value, fallback = null) {
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function requestId(value, label) {
  const text = String(value || '').trim()
  if (!SAFE_ID.test(text)) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, `${label}格式无效`)
  }
  return text
}

function observedBranchName(input, space, binding) {
  if (input.observedBranchName == null) return null
  let observed
  try {
    observed = validateGitBranchName(input.observedBranchName)
  } catch {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, 'observedBranchName 格式无效')
  }
  if (observed !== space.branch_name || observed !== binding.branch_name) {
    throw teamError(
      400,
      'BRANCH_TASK_SPACE_MISMATCH',
      `上报分支 ${observed} 与任务空间分支 ${space.branch_name} 不一致`,
    )
  }
  return observed
}

function sequence(value) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, 'clientSequence 必须是正整数')
  }
  return parsed
}

function taskIdFromJson(content) {
  const value = parseJson(content, null)
  return typeof value?.id === 'string' && value.id.trim() ? value.id.trim() : null
}

function taskBranchFromJson(content) {
  const value = parseJson(content, null)
  return typeof value?.branch === 'string' && value.branch.trim() ? value.branch.trim() : null
}

function taskTitleFromJson(content) {
  const value = parseJson(content, null)
  return typeof value?.title === 'string' && value.title.trim() ? value.title.trim() : null
}

function normalizeMergeEvidence(value) {
  if (value == null) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, 'mergeEvidence 格式无效')
  }
  if (value.version !== 1 || value.type !== 'tracked-in-head') {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, 'mergeEvidence 类型或版本无效')
  }
  const taskDir = String(value.taskDir || '').trim()
  if (!taskDir.startsWith('.trellis/tasks/')) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, 'mergeEvidence 任务目录无效')
  }
  if (isArchiveTaskDirectory(taskDir) || taskDir.startsWith('.trellis/tasks/archive/')) {
    throw teamError(
      409,
      ARCHIVE_SYNC_SERVER_MANAGED,
      '归档任务由服务端 Git 索引管理，不能提交合入证据',
    )
  }
  const trackedPath = String(value.trackedPath || '').trim()
  if (trackedPath !== `${taskDir}/task.json`) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, 'mergeEvidence 受控路径无效')
  }
  let sourceBranch
  let baselineBranch
  try {
    sourceBranch = validateGitBranchName(value.sourceBranch)
    baselineBranch = validateGitBranchName(value.baselineBranch)
  } catch {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, 'mergeEvidence 分支格式无效')
  }
  const headCommit = String(value.headCommit || '').trim()
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(headCommit)) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, 'mergeEvidence HEAD 提交格式无效')
  }
  return {
    version: 1,
    type: 'tracked-in-head',
    taskId: requestId(value.taskId, 'mergeEvidence 任务 ID'),
    taskDir,
    trackedPath,
    sourceBranch,
    baselineBranch,
    headCommit,
  }
}

export function createTaskSnapshotService({
  db,
  taskSpaces,
  onRevisionCommitted = null,
  now = () => new Date(),
}) {
  function bindingContext(agent, taskSpaceId) {
    const space = taskSpaces.readTaskSpace(taskSpaceId, taskSpaces.actorContext(agent.userId))
    if (!space || space.project_status !== 'active' || space.status === 'disabled') {
      throw teamError(404, ERROR_CODES.NOT_FOUND, '任务空间不存在或已停用')
    }
    const binding = db
      .prepare(`
      SELECT b.*, a.status AS agent_status, a.user_id
      FROM sync_agent_binding b
      JOIN agent_device a ON a.id = b.agent_id
      JOIN sync_active_agent aa ON aa.user_id = a.user_id AND aa.agent_id = a.id
      WHERE b.agent_id = ? AND b.task_space_id = ?
        AND b.sync_status = 'approved' AND a.status = 'active'
    `)
      .get(agent.id, taskSpaceId)
    if (!binding) {
      throw teamError(403, ERROR_CODES.FORBIDDEN, 'Agent 尚未绑定该任务空间')
    }
    return { space, binding }
  }

  function readTaskSpaceRevision(taskSpaceId) {
    return Number(
      db.prepare('SELECT revision FROM sync_task_space WHERE id = ?').get(taskSpaceId)?.revision ||
        0,
    )
  }

  function fileRows(taskSpaceId, afterRevision = 0) {
    return db
      .prepare(`
      SELECT f.*, u.username AS source_username, u.display_name AS source_display_name,
             a.device_name AS source_device_name
      FROM sync_task_space_file f
      LEFT JOIN user_account u ON u.id = f.source_user_id
      LEFT JOIN agent_device a ON a.id = f.source_agent_id
      WHERE f.task_space_id = ? AND f.revision > ?
        AND f.task_dir NOT LIKE '.trellis/tasks/archive/%'
        AND f.relative_path NOT LIKE '.trellis/tasks/archive/%'
      ORDER BY f.revision, f.relative_path
    `)
      .all(taskSpaceId, afterRevision)
  }

  function publicFile(row, includeContent = true) {
    return {
      path: row.relative_path,
      revision: Number(row.revision),
      sha256: row.sha256,
      deleted: Boolean(row.deleted),
      taskId: row.task_id || null,
      taskDir: row.task_dir,
      sourceClientSequence: row.source_client_sequence || null,
      changedBy: {
        displayName: row.source_display_name || row.source_username || null,
        deviceName: row.source_device_name || null,
        occurredAt: row.updated_at,
      },
      ...(includeContent && !row.deleted ? { content: row.content_text || '' } : {}),
    }
  }

  function snapshot(agent, taskSpaceId, input = {}) {
    const { space } = bindingContext(agent, taskSpaceId)
    const afterRevision = Number(input.afterRevision || 0)
    if (!Number.isSafeInteger(afterRevision) || afterRevision < 0) {
      throw teamError(400, ERROR_CODES.INVALID_INPUT, 'afterRevision 必须是非负整数')
    }
    const rows = fileRows(taskSpaceId, afterRevision)
    return {
      taskSpaceId,
      projectId: space.project_id,
      branchName: space.branch_name,
      revision: readTaskSpaceRevision(taskSpaceId),
      afterRevision,
      files: rows.filter((row) => afterRevision > 0 || !row.deleted).map((row) => publicFile(row)),
    }
  }

  function directorySnapshot(agent, taskSpaceId, taskDir) {
    bindingContext(agent, taskSpaceId)
    const normalized = String(taskDir || '').trim()
    if (isArchiveTaskDirectory(normalized) || normalized.startsWith('.trellis/tasks/archive/')) {
      throw teamError(
        409,
        ARCHIVE_SYNC_SERVER_MANAGED,
        '归档任务目录由服务端 Git 索引管理，Agent 不能读取归档快照',
      )
    }
    if (!normalized.startsWith('.trellis/tasks/')) {
      throw teamError(400, ERROR_CODES.INVALID_INPUT, '任务目录无效')
    }
    const rows = db
      .prepare(`
      SELECT *
      FROM sync_task_space_file
      WHERE task_space_id = ? AND task_dir = ? AND deleted = 0
      ORDER BY relative_path
    `)
      .all(taskSpaceId, normalized)
    return {
      taskSpaceId,
      taskDir: normalized,
      revision: readTaskSpaceRevision(taskSpaceId),
      files: rows.map((row) => publicFile(row)),
    }
  }

  function preflight(agent, taskSpaceId, input = {}) {
    bindingContext(agent, taskSpaceId)
    const allFileGroups = { maxFiles: Number.POSITIVE_INFINITY, maxBytes: Number.POSITIVE_INFINITY }
    const localGroups = requireSnapshotGroups(input.files || [], allFileGroups).filter(
      (group) => !group.archived,
    )
    const serverGroups = requireSnapshotGroups(
      db
        .prepare(`
        SELECT relative_path AS path, content_text AS content, sha256
        FROM sync_task_space_file
        WHERE task_space_id = ? AND deleted = 0
          AND task_dir NOT LIKE '.trellis/tasks/archive/%'
          AND relative_path NOT LIKE '.trellis/tasks/archive/%'
      `)
        .all(taskSpaceId)
        .map((row) => ({
          path: row.path,
          content: row.content,
          sha256: row.sha256,
        })),
      allFileGroups,
    )
    return {
      taskSpaceId,
      revision: readTaskSpaceRevision(taskSpaceId),
      tasks: classifyTaskSnapshots(localGroups, serverGroups),
    }
  }

  function taskOwnership(agent, taskSpaceId, input = {}) {
    const { space } = bindingContext(agent, taskSpaceId)
    if (input.taskIds != null && !Array.isArray(input.taskIds)) {
      throw teamError(400, ERROR_CODES.INVALID_INPUT, 'taskIds 必须是数组')
    }
    const rawTaskIds = Array.isArray(input.taskIds) ? input.taskIds : []
    if (rawTaskIds.length > 200) {
      throw teamError(400, ERROR_CODES.INVALID_INPUT, '单次最多查询 200 个任务 ID')
    }
    const taskIds = [...new Set(rawTaskIds.map((value) => requestId(value, '任务 ID')))].sort()
    const projectTaskSpaces = taskSpaces
      .listTaskSpaces(space.project_id, taskSpaces.actorContext(agent.userId))
      .filter((item) => item.status !== 'disabled')
      .map((item) => ({
        taskSpaceId: item.id,
        branchName: item.branchName,
        isBaseline: item.isBaseline,
      }))
    if (!taskIds.length) return { projectTaskSpaces, tasks: [] }

    const taskSpacesById = new Map(projectTaskSpaces.map((item) => [item.taskSpaceId, item]))
    const rows = db
      .prepare(`
        SELECT f.task_space_id, f.task_id, f.task_dir, f.relative_path, f.content_text
        FROM sync_task_space_file f
        JOIN sync_task_space s ON s.id = f.task_space_id
        WHERE s.project_id = ? AND s.status != 'disabled' AND f.deleted = 0
          AND f.task_id IN (${taskIds.map(() => '?').join(', ')})
        ORDER BY f.task_space_id, f.task_dir
      `)
      .all(space.project_id, ...taskIds)
    const claimsByTaskId = new Map()
    for (const row of rows) {
      const projectSpace = taskSpacesById.get(row.task_space_id)
      if (!projectSpace || row.relative_path !== `${row.task_dir}/task.json`) continue
      const claims = claimsByTaskId.get(row.task_id) || []
      claims.push({
        taskSpaceId: row.task_space_id,
        branchName: projectSpace.branchName,
        taskBranch: taskBranchFromJson(row.content_text),
      })
      claimsByTaskId.set(row.task_id, claims)
    }
    return {
      projectTaskSpaces,
      tasks: taskIds.map((taskId) => ({
        taskId,
        claims: claimsByTaskId.get(taskId) || [],
      })),
    }
  }

  function currentPathRows(taskSpaceId, paths) {
    if (!paths.length) return new Map()
    return new Map(
      db
        .prepare(`
        SELECT *
        FROM sync_task_space_file
        WHERE task_space_id = ?
          AND relative_path IN (${paths.map(() => '?').join(', ')})
      `)
        .all(taskSpaceId, ...paths)
        .map((row) => [row.relative_path, row]),
    )
  }

  function affectedDirectoryRows(taskSpaceId, taskDirs) {
    const rows = []
    for (const taskDir of taskDirs) {
      rows.push(
        ...db
          .prepare(`
          SELECT *
          FROM sync_task_space_file
          WHERE task_space_id = ? AND task_dir = ? AND deleted = 0
        `)
          .all(taskSpaceId, taskDir),
      )
    }
    return rows
  }

  function baselineOwnsTask(projectId, taskId) {
    if (!taskId) return false
    return Boolean(
      db
        .prepare(`
        SELECT 1
        FROM sync_project p
        JOIN sync_task_space s
          ON s.project_id = p.id AND s.branch_name = p.baseline_branch
        JOIN sync_task_space_file f
          ON f.task_space_id = s.id AND f.task_id = ? AND f.deleted = 0
        WHERE p.id = ? AND f.relative_path = f.task_dir || '/task.json'
        LIMIT 1
      `)
        .get(taskId, projectId),
    )
  }

  function mergeEvidenceRow(projectId, taskId) {
    if (!taskId) return null
    return (
      db
        .prepare('SELECT * FROM sync_task_merge_evidence WHERE project_id = ? AND task_id = ?')
        .get(projectId, taskId) || null
    )
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

  function filesTaskJson(complete, evidence) {
    return complete.trackedPath === evidence.trackedPath && complete.taskDir === evidence.taskDir
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
      db.prepare(`
        UPDATE sync_task_merge_evidence
        SET execution_task_key = ?, task_dir = ?, tracked_path = ?, head_commit = ?,
            source_agent_id = ?, source_user_id = ?
        WHERE id = ?
      `).run(
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
    db.prepare(`
      INSERT INTO sync_task_merge_evidence(
        id, project_id, task_id, execution_task_key, baseline_task_space_id,
        task_dir, tracked_path, source_branch_name, baseline_branch_name,
        evidence_type, head_commit, source_agent_id, source_user_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'tracked-in-head', ?, ?, ?, ?)
    `).run(
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
    const existing = affectedDirectoryRows(taskSpaceId, taskDirs)
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

  function sourceIdentity(row) {
    if (!row) return null
    const user = row.source_user_id
      ? db
          .prepare('SELECT username, display_name FROM user_account WHERE id = ?')
          .get(row.source_user_id)
      : null
    const agent = row.source_agent_id
      ? db.prepare('SELECT device_name FROM agent_device WHERE id = ?').get(row.source_agent_id)
      : null
    return {
      displayName: user?.display_name || user?.username || null,
      deviceName: agent?.device_name || null,
      occurredAt: row.updated_at,
    }
  }

  function writeConflict({
    agent,
    taskSpaceId,
    taskId,
    taskTitle,
    taskDir,
    files,
    serverRevision,
    clientSequence,
    batchId,
  }) {
    const timestamp = now().toISOString()
    const filesJson = JSON.stringify(files)
    const existing = db
      .prepare(`
        SELECT *
        FROM sync_conflict
        WHERE task_space_id = ? AND created_by_agent_id = ?
          AND (task_id = ? OR (task_id IS NULL AND task_dir = ?))
          AND status = 'pending'
        ORDER BY (task_id = ?) DESC, created_at DESC, rowid DESC
        LIMIT 1
      `)
      .get(taskSpaceId, agent.id, taskId, taskDir, taskId)
    const id = existing?.id || crypto.randomUUID()
    if (existing) {
      db.prepare(`
        UPDATE sync_conflict
        SET task_id = ?, task_dir = ?, files_json = ?, server_revision = ?,
            client_sequence = ?, batch_id = ?
        WHERE id = ?
      `).run(taskId, taskDir, filesJson, serverRevision, clientSequence, batchId, id)
    } else {
      db.prepare(`
        INSERT INTO sync_conflict(
          id, task_space_id, task_id, task_dir, files_json, server_revision,
          client_sequence, batch_id, status, created_by_user_id, created_by_agent_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
      `).run(
        id,
        taskSpaceId,
        taskId,
        taskDir,
        filesJson,
        serverRevision,
        clientSequence,
        batchId,
        agent.userId,
        agent.id,
        timestamp,
      )
    }
    return {
      status: 409,
      code: 'TASK_FILE_CONFLICT',
      conflictId: id,
      message: '任务文件已被其他成员修改，本次整批未保存',
      details: {
        taskId,
        taskTitle: taskTitle || taskId || taskDir,
        files,
        suggestion: '先查看差异，再选择使用服务端版本或用本地版本覆盖',
      },
    }
  }

  function checkRateLimit(agentId, taskSpaceId) {
    const cutoff = new Date(now().getTime() - 1000).toISOString()
    const count = Number(
      db
        .prepare(`
        SELECT COUNT(*) AS count
        FROM sync_task_space_batch
        WHERE agent_id = ? AND task_space_id = ? AND created_at >= ?
      `)
        .get(agentId, taskSpaceId, cutoff).count,
    )
    if (count >= MAX_RATE_BATCHES_PER_SECOND) {
      throw teamError(429, ERROR_CODES.RATE_LIMITED, '同步批次过于频繁，请稍后重试')
    }
  }

  function applyChangesInternal(agent, taskSpaceId, input = {}, commitHook = null) {
    const { space, binding } = bindingContext(agent, taskSpaceId)
    const observedBranch = observedBranchName(input, space, binding)
    const mergeEvidence = normalizeMergeEvidence(input.mergeEvidence)
    const actor = taskSpaces.actorContext(agent.userId)
    taskSpaces.authorizeTaskSpace(actor, taskSpaceId, 'write')
    const batchId = requestId(input.batchId, '批次 ID')
    const clientSequence = sequence(input.clientSequence)
    const rawFiles = Array.isArray(input.files) ? input.files : []
    const groups = rejectArchiveGroups(requireSnapshotGroups(rawFiles))
    const files = groups.flatMap((group) => group.files)
    if (!files.length) throw teamError(400, ERROR_CODES.INVALID_INPUT, '同步批次不能为空')
    const requestPayload = {
      taskSpaceId,
      batchId,
      clientSequence,
      files,
    }
    if (mergeEvidence) requestPayload.mergeEvidence = mergeEvidence
    const requestSha256 = hashJson(requestPayload)
    const outcome = withTransaction(db, () => {
      const existingBatch = db
        .prepare(`
        SELECT *
        FROM sync_task_space_batch
        WHERE agent_id = ? AND task_space_id = ? AND batch_id = ?
      `)
        .get(agent.id, taskSpaceId, batchId)
      if (existingBatch) {
        if (existingBatch.request_sha256 !== requestSha256) {
          throw teamError(409, ERROR_CODES.CONFLICT, '同一批次 ID 不能提交不同内容')
        }
        return {
          kind: 'replayed',
          response: {
            status: 200,
            replayed: true,
            revision: Number(existingBatch.revision),
            taskSpaceId,
          },
        }
      }
      checkRateLimit(agent.id, taskSpaceId)
      const previousSequence = Number(
        db
          .prepare(`
          SELECT COALESCE(MAX(client_sequence), 0) AS sequence
          FROM sync_task_space_batch
          WHERE agent_id = ? AND task_space_id = ?
        `)
          .get(agent.id, taskSpaceId).sequence,
      )
      if (clientSequence <= previousSequence) {
        throw teamError(409, ERROR_CODES.CONFLICT, 'clientSequence 必须严格递增', {
          details: {
            previousSequence,
            requiredClientSequence: previousSequence + 1,
          },
        })
      }
      const complete = validateCompleteTaskGroups(taskSpaceId, files, space.branch_name)
      const ownership = validateTaskOwnership({
        space,
        complete,
        evidence: mergeEvidence,
        observedBranch,
      })
      const current = currentPathRows(
        taskSpaceId,
        files.map((file) => file.path),
      )
      const conflictFiles = []
      for (const file of files) {
        const row = current.get(file.path)
        const actualBase = row && !row.deleted ? row.sha256 : null
        const expectedBase = file.baseSha256 || null
        if (actualBase !== expectedBase) {
          conflictFiles.push({
            path: file.path,
            baseSha256: expectedBase,
            currentSha256: actualBase,
            revision: Number(row?.revision || 0),
            changedBy: sourceIdentity(row),
          })
        }
      }
      if (conflictFiles.length) {
        const taskTitle = affectedDirectoryRows(taskSpaceId, complete.taskDirs)
          .filter((row) => row.relative_path.endsWith('/task.json'))
          .map((row) => taskTitleFromJson(row.content_text))
          .find(Boolean)
        return {
          kind: 'conflict',
          response: writeConflict({
            agent,
            taskSpaceId,
            taskId: complete.taskId,
            taskTitle,
            taskDir: complete.taskDirs.join(' -> '),
            files: conflictFiles,
            serverRevision: readTaskSpaceRevision(taskSpaceId),
            clientSequence,
            batchId,
          }),
        }
      }

      const timestamp = now().toISOString()
      const currentRevision = readTaskSpaceRevision(taskSpaceId)
      const revision = currentRevision + 1
      if (ownership.persistEvidence) {
        persistMergeEvidence({
          agent,
          space,
          complete,
          evidence: mergeEvidence,
          timestamp,
        })
      }
      const upsert = db.prepare(`
        INSERT INTO sync_task_space_file(
          task_space_id, relative_path, revision, sha256, content_text, deleted,
          task_id, task_dir, source_agent_id, source_user_id,
          source_client_sequence, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(task_space_id, relative_path) DO UPDATE SET
          revision = excluded.revision,
          sha256 = excluded.sha256,
          content_text = excluded.content_text,
          deleted = excluded.deleted,
          task_id = excluded.task_id,
          task_dir = excluded.task_dir,
          source_agent_id = excluded.source_agent_id,
          source_user_id = excluded.source_user_id,
          source_client_sequence = excluded.source_client_sequence,
          updated_at = excluded.updated_at
      `)
      const audit = db.prepare(`
        INSERT INTO sync_file_audit(
          task_space_id, relative_path, task_id, operation, old_sha256,
          new_sha256, revision, source_user_id, source_agent_id, occurred_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      let changed = false
      for (const file of files) {
        const before = current.get(file.path)
        if (!file.deleted && before && !before.deleted && before.sha256 === file.sha256) continue
        if (file.deleted && (!before || before.deleted)) continue
        changed = true
        const operation = file.deleted ? 'delete' : before?.deleted ? 'upsert' : 'upsert'
        upsert.run(
          taskSpaceId,
          file.path,
          revision,
          file.sha256,
          file.deleted ? null : file.content,
          file.deleted ? 1 : 0,
          file.deleted ? before?.task_id || complete.taskId : complete.taskId,
          file.taskDir,
          agent.id,
          agent.userId,
          clientSequence,
          timestamp,
        )
        audit.run(
          taskSpaceId,
          file.path,
          complete.taskId || before?.task_id || null,
          operation,
          before && !before.deleted ? before.sha256 : null,
          file.deleted ? null : file.sha256,
          revision,
          agent.userId,
          agent.id,
          timestamp,
        )
      }
      const hook = {
        agent,
        taskSpaceId,
        current,
        complete,
        files,
        timestamp,
        changed,
        currentRevision,
        revision: changed ? revision : currentRevision,
      }
      if (!changed) {
        return {
          kind: 'noop',
          revision: currentRevision,
          taskId: complete.taskId,
          hookResult: commitHook ? commitHook(hook) : null,
        }
      }
      db.prepare(`
        INSERT INTO sync_task_space_batch(
          batch_id, task_space_id, agent_id, user_id, revision,
          request_sha256, client_sequence, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        batchId,
        taskSpaceId,
        agent.id,
        agent.userId,
        revision,
        requestSha256,
        clientSequence,
        timestamp,
      )
      const taskSpaceUpdate = db
        .prepare(`
        UPDATE sync_task_space
        SET revision = ?, status = 'indexing', updated_at = ?
        WHERE id = ? AND status != 'disabled' AND retired_at IS NULL
      `)
        .run(revision, timestamp, taskSpaceId)
      if (Number(taskSpaceUpdate.changes) !== 1) {
        throw teamError(409, ERROR_CODES.PROJECT_NOT_READY, '任务空间已停用')
      }
      return {
        kind: 'changed',
        revision,
        taskId: complete.taskId,
        hookResult: commitHook ? commitHook(hook) : null,
      }
    })
    if (outcome.kind === 'replayed' || outcome.kind === 'conflict') {
      return { response: outcome.response, internal: null }
    }
    if (outcome.kind === 'changed') {
      try {
        onRevisionCommitted?.({
          taskSpaceId,
          projectId: space.project_id,
          revision: outcome.revision,
        })
      } catch {
        // 投影失败由索引服务的退避重试处理，不回滚已提交快照。
      }
    }
    return {
      response: {
        status: 200,
        replayed: false,
        noop: outcome.kind === 'noop',
        taskSpaceId,
        revision: outcome.revision,
        taskId: outcome.taskId,
      },
      internal: outcome.hookResult,
    }
  }

  function applyChanges(agent, taskSpaceId, input = {}) {
    return applyChangesInternal(agent, taskSpaceId, input).response
  }

  function writeCursor(agent, taskSpaceId, input = {}) {
    bindingContext(agent, taskSpaceId)
    const revision = Number(input.revision)
    if (!Number.isSafeInteger(revision) || revision < 0) {
      throw teamError(400, ERROR_CODES.INVALID_INPUT, 'cursor revision 必须是非负整数')
    }
    const timestamp = now().toISOString()
    db.prepare(`
      INSERT INTO sync_agent_cursor(agent_id, task_space_id, revision, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(agent_id, task_space_id) DO UPDATE SET
        revision = MAX(sync_agent_cursor.revision, excluded.revision),
        updated_at = excluded.updated_at
    `).run(agent.id, taskSpaceId, revision, timestamp)
    return {
      taskSpaceId,
      revision: Number(
        db
          .prepare(`
          SELECT revision FROM sync_agent_cursor
          WHERE agent_id = ? AND task_space_id = ?
        `)
          .get(agent.id, taskSpaceId).revision,
      ),
      updatedAt: timestamp,
    }
  }

  function listConflicts(agent, taskSpaceId) {
    bindingContext(agent, taskSpaceId)
    return db
      .prepare(`
      WITH ranked AS (
        SELECT c.*, c.rowid AS conflict_rowid,
               ROW_NUMBER() OVER (
                 PARTITION BY c.created_by_agent_id, COALESCE(c.task_id, c.task_dir)
                 ORDER BY c.created_at DESC, c.rowid DESC
               ) AS conflict_rank
        FROM sync_conflict c
        WHERE c.task_space_id = ? AND c.status = 'pending'
      )
      SELECT * FROM ranked
      WHERE conflict_rank = 1
      ORDER BY created_at DESC, conflict_rowid DESC
    `)
      .all(taskSpaceId)
      .map((row) => ({
        id: row.id,
        taskSpaceId: row.task_space_id,
        taskId: row.task_id,
        taskDir: row.task_dir,
        files: parseJson(row.files_json, []),
        serverRevision: Number(row.server_revision),
        batchId: row.batch_id,
        createdAt: row.created_at,
      }))
  }

  function resolveConflict(agent, taskSpaceId, conflictId, input = {}) {
    const conflict = db
      .prepare('SELECT * FROM sync_conflict WHERE id = ?')
      .get(String(conflictId || ''))
    if (!conflict) throw teamError(404, ERROR_CODES.NOT_FOUND, '冲突不存在')
    if (conflict.task_space_id !== String(taskSpaceId || '')) {
      throw teamError(404, ERROR_CODES.NOT_FOUND, '冲突不存在')
    }
    bindingContext(agent, conflict.task_space_id)
    const action = String(input.action || '')
    if (!['use-server', 'overwrite-server', 'save-local-copy'].includes(action)) {
      throw teamError(400, ERROR_CODES.INVALID_INPUT, '冲突处理动作无效')
    }
    if (conflict.status !== 'pending') {
      if (conflict.status === 'resolved' && action !== 'save-local-copy') {
        return { conflictId: conflict.id, action, resolved: true, idempotent: true }
      }
      throw teamError(409, ERROR_CODES.CONFLICT, '该冲突已经处理，请刷新冲突列表')
    }
    if (action === 'overwrite-server') {
      const files = Array.isArray(input.files) ? input.files : []
      const groupedFiles = rejectArchiveGroups(requireSnapshotGroups(files))
      const normalizedFiles = groupedFiles.flatMap((group) => group.files)
      const taskDirs = [...new Set(normalizedFiles.map((file) => file.taskDir))]
      const currentRows = affectedDirectoryRows(conflict.task_space_id, taskDirs)
      const current = new Map(currentRows.map((row) => [row.relative_path, row]))
      const currentDetails = parseJson(conflict.files_json, [])
      for (const detail of currentDetails) {
        const row = current.get(detail.path)
        if ((row && !row.deleted ? row.sha256 : null) !== detail.currentSha256) {
          throw teamError(409, ERROR_CODES.CONFLICT, '服务端版本又发生变化，请重新查看差异')
        }
      }
      const applied = applyChangesInternal(
        agent,
        conflict.task_space_id,
        {
          observedBranchName: input.observedBranchName,
          mergeEvidence: input.mergeEvidence,
          batchId: requestId(input.batchId, '批次 ID'),
          clientSequence: input.clientSequence,
          files: normalizedFiles.map((file) => ({
            ...file,
            baseSha256:
              current.get(file.path) && !current.get(file.path).deleted
                ? current.get(file.path).sha256
                : null,
          })),
        },
        ({ files: committedFiles, timestamp, revision }) => {
          const replacements = new Map(committedFiles.map((file) => [file.path, file]))
          const paths = new Set([
            ...current.keys(),
            ...currentDetails.map((detail) => detail.path),
            ...replacements.keys(),
          ])
          const backupPaths = []
          for (const relativePath of paths) {
            const row = current.get(relativePath)
            const replacement = replacements.get(relativePath)
            const oldContent = row && !row.deleted ? row.content_text : null
            const newContent =
              replacement == null ? oldContent : replacement.deleted ? null : replacement.content
            db.prepare(`
            INSERT INTO sync_conflict_backup(
              id, conflict_id, task_space_id, relative_path, old_content,
              new_content, revision, created_by_user_id, created_by_agent_id, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
              crypto.randomUUID(),
              conflict.id,
              conflict.task_space_id,
              relativePath,
              oldContent,
              newContent,
              revision,
              agent.userId,
              agent.id,
              timestamp,
            )
            backupPaths.push(relativePath)
          }
          db.prepare(`
            UPDATE sync_conflict SET status = 'resolved', resolved_at = ? WHERE id = ?
          `).run(timestamp, conflict.id)
          return backupPaths
        },
      )
      if (applied.response.status === 409) return applied.response
      return {
        ...applied.response,
        conflictId: conflict.id,
        action,
        backupPaths: applied.internal || [],
      }
    }
    if (action === 'save-local-copy') {
      // 本地副本由客户端保存，服务端冲突必须继续保持 pending。
      return {
        conflictId: conflict.id,
        action,
        resolved: false,
        message: '本地副本已保存，原冲突仍待处理',
      }
    }
    db.prepare(`
      UPDATE sync_conflict SET status = 'resolved', resolved_at = ? WHERE id = ?
    `).run(now().toISOString(), conflict.id)
    return { conflictId: conflict.id, action, resolved: true }
  }

  function manifestForDirectory(taskSpaceId, taskDir) {
    const normalized = String(taskDir || '').trim()
    if (!normalized.startsWith('.trellis/tasks/')) {
      throw teamError(400, ERROR_CODES.INVALID_INPUT, '任务目录无效')
    }
    const archived = isArchiveTaskPath(normalized) || isArchiveTaskDirectory(normalized)
    if (archived) {
      const revision = Number(
        db.prepare('SELECT archive_revision FROM sync_task_space WHERE id = ?').get(taskSpaceId)
          ?.archive_revision || 0,
      )
      const rows = db
        .prepare(`
          SELECT *
          FROM sync_archive_file
          WHERE task_space_id = ? AND task_dir = ?
          ORDER BY relative_path
        `)
        .all(taskSpaceId, normalized)
      return {
        taskSpaceId,
        taskDir: normalized,
        revision,
        source: 'archive',
        files: rows.map((row) =>
          publicFile({
            ...row,
            revision,
            deleted: 0,
          }),
        ),
      }
    }
    const rows = db
      .prepare(`
      SELECT *
      FROM sync_task_space_file
      WHERE task_space_id = ? AND task_dir = ? AND deleted = 0
      ORDER BY relative_path
    `)
      .all(taskSpaceId, normalized)
    return {
      taskSpaceId,
      taskDir: normalized,
      revision: readTaskSpaceRevision(taskSpaceId),
      source: 'active',
      files: rows.map((row) => publicFile(row)),
    }
  }

  return {
    snapshot,
    directorySnapshot,
    preflight,
    taskOwnership,
    applyChanges,
    writeCursor,
    listConflicts,
    resolveConflict,
    // 仅供服务端内部读取；不经过 Agent binding 校验。
    manifestForDirectory,
  }
}
