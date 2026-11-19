import crypto from 'node:crypto'

export const PROJECTION_STATE_SCHEMA_VERSION = 3

export function text(value, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

export function parseJson(value, fallback) {
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

export function serializeProjectionState({
  project,
  tasks,
  dirFingerprints,
  projectError,
  manualStageFingerprint,
  taskControlFingerprint,
  detailTasks,
  archiveSnapshotId,
  stats,
}) {
  try {
    return JSON.stringify(
      {
        schemaVersion: PROJECTION_STATE_SCHEMA_VERSION,
        project,
        tasks: [...tasks.entries()],
        dirFingerprints: [...dirFingerprints.entries()],
        projectError: projectError || null,
        manualStageFingerprint,
        taskControlFingerprint,
        detailTasks,
        archiveSnapshotId,
        stats,
      },
      (key, value) => (key === 'repoPath' ? 'trellis-task-space-cache' : value),
    )
  } catch {
    return null
  }
}

export function parseProjectionState(value) {
  const state = parseJson(value, null)
  if (
    !state ||
    state.schemaVersion !== PROJECTION_STATE_SCHEMA_VERSION ||
    !state.project ||
    typeof state.project !== 'object' ||
    !Array.isArray(state.tasks) ||
    !Array.isArray(state.dirFingerprints) ||
    !Array.isArray(state.detailTasks) ||
    !Object.prototype.hasOwnProperty.call(state, 'archiveSnapshotId') ||
    (state.archiveSnapshotId !== null && typeof state.archiveSnapshotId !== 'string') ||
    typeof state.manualStageFingerprint !== 'string'
  ) {
    return null
  }
  try {
    const tasks = new Map(state.tasks)
    const dirFingerprints = new Map(state.dirFingerprints)
    if (
      tasks.size !== state.tasks.length ||
      dirFingerprints.size !== state.dirFingerprints.length ||
      [...tasks.values()].some((task) => !task || typeof task !== 'object') ||
      [...dirFingerprints.values()].some((fingerprint) => typeof fingerprint !== 'string')
    ) {
      return null
    }
    return {
      project: state.project,
      rawTasksByDir: tasks,
      dirFingerprints,
      projectError: state.projectError || null,
      manualStageFingerprint: state.manualStageFingerprint,
      taskControlFingerprint:
        typeof state.taskControlFingerprint === 'string' ? state.taskControlFingerprint : null,
      detailTasks: state.detailTasks,
      archiveSnapshotId: state.archiveSnapshotId,
      stats: state.stats && typeof state.stats === 'object' ? state.stats : null,
    }
  } catch {
    return null
  }
}

export function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  )
}

export function hashValue(value) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(stableValue(value)))
    .digest('hex')
}

export function taskDirFingerprints(rows) {
  const grouped = new Map()
  for (const row of rows) {
    const taskDir = String(row.task_dir || '')
    if (!taskDir) continue
    if (!grouped.has(taskDir)) grouped.set(taskDir, [])
    grouped
      .get(taskDir)
      .push([
        String(row.relative_path || ''),
        row.deleted ? 1 : 0,
        row.deleted ? null : String(row.sha256 || ''),
      ])
  }
  return new Map(
    [...grouped.entries()].map(([taskDir, entries]) => [
      taskDir,
      hashValue(entries.sort((left, right) => left[0].localeCompare(right[0], 'en'))),
    ]),
  )
}

export function manualStageFingerprint(taskSpaceId, records) {
  return hashValue(
    Object.entries(records)
      .filter(([key]) => key.startsWith(`${taskSpaceId}/`))
      .sort(([left], [right]) => left.localeCompare(right, 'en')),
  )
}

export function taskControlFingerprint(authority) {
  return hashValue(
    [...authority.values()]
      .map((task) => [
        task.execution_task_key,
        task.task_key,
        task.relative_dir,
        task.title,
        task.priority,
        task.assignee_user_id,
        task.assignee_dev_id,
        task.archived,
        task.archived_at,
        task.materialization_state,
        task.task_version,
      ])
      .sort(([left], [right]) => left.localeCompare(right, 'en')),
  )
}

export function rawTaskMap(tasks) {
  return new Map(tasks.map((task) => [task.relativeDir, task]))
}

export class ProjectionSuperseded extends Error {
  constructor(revision) {
    super(`任务空间 revision ${revision} 已被更新`)
    this.revision = revision
  }
}
