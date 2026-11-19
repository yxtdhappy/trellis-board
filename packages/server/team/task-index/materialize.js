import { getManualRecords } from '../../metadata.js'
import {
  ProjectionSuperseded,
  hashValue,
  manualStageFingerprint,
  rawTaskMap,
  serializeProjectionState,
  taskControlFingerprint,
  taskDirFingerprints,
} from './projection-state.js'
import { replaceIndexInTransaction } from './index-write.js'

export async function materializeOnce(deps, taskSpaceId, options = {}) {
  const {
    archiveSnapshotIdForTaskSpace,
    buildBoard,
    canUseProjectionState,
    changedTaskDirs,
    db,
    logger,
    materialized,
    onProjected,
    onQueryRevisionChanged,
    projectForTaskSpace,
    queryRevision,
    readContentRows,
    readFileMetadata,
    readTaskSpaceCache,
    replaceIndexInTransaction,
    requestWorker,
    taskControl,
    taskSpaceRow,
    withSnapshotFileMetadata,
  } = deps
  const startedAt = Date.now()
  const taskSpace = taskSpaceRow(taskSpaceId)
  if (!taskSpace) throw new Error('任务空间不存在')
  const targetRevision = Number(taskSpace.revision)
  const targetArchiveRevision = Number(taskSpace.archive_revision)
  const targetArchiveSnapshotId = archiveSnapshotIdForTaskSpace(taskSpace)
  let state = materialized.get(taskSpaceId)
  if (!state) {
    const cached = readTaskSpaceCache(taskSpaceId)
    if (cached?.board && cached.projection) {
      state = {
        ...cached.projection,
        revision: cached.revision,
        archiveRevision: cached.archiveRevision,
        board: cached.board,
        savedAt: cached.savedAt,
      }
      materialized.set(taskSpaceId, state)
    }
  }
  const currentManualRecords = getManualRecords(db)
  const currentManualFingerprint = manualStageFingerprint(taskSpace.id, currentManualRecords)
  const authority = taskControl?.authoritativeTasks(taskSpace.id) || new Map()
  const currentTaskControlFingerprint = taskControlFingerprint(authority)
  const canIncremental = canUseProjectionState(state, taskSpace)
  const stats = {
    mode: canIncremental ? 'incremental' : 'full',
    baseRevision: canIncremental ? Number(state.revision) : null,
    baseArchiveRevision: canIncremental ? Number(state.archiveRevision) : null,
    targetRevision,
    targetArchiveRevision,
    queueWaitMs: Number(options.queueWaitMs || 0),
    changedTaskCount: 0,
    scannedTaskCount: 0,
    reusedTaskCount: 0,
    contentRowsRead: 0,
    workerMs: 0,
    relationshipMs: 0,
    databaseMs: 0,
    totalMs: 0,
    result: 'committed',
  }

  if (
    canIncremental &&
    targetRevision === Number(state.revision) &&
    targetArchiveRevision === Number(state.archiveRevision) &&
    targetArchiveSnapshotId === state.archiveSnapshotId &&
    !taskSpace.archive_candidate_snapshot_id &&
    currentManualFingerprint === state.manualStageFingerprint &&
    currentTaskControlFingerprint === state.taskControlFingerprint
  ) {
    const lastStats = state.stats || stats
    return {
      superseded: false,
      noop: true,
      revision: targetRevision,
      archiveRevision: targetArchiveRevision,
      archiveSnapshotId: targetArchiveSnapshotId,
      board: state.board,
      stats: {
        ...lastStats,
        result: 'noop',
        totalMs: Date.now() - startedAt,
      },
    }
  }

  const metadata = readFileMetadata(taskSpaceId, targetArchiveSnapshotId)
  const changeState = canIncremental
    ? changedTaskDirs(state, metadata)
    : { currentFingerprints: taskDirFingerprints(metadata), changed: [] }
  const changedSet = new Set(changeState.changed)
  const changedRows = canIncremental
    ? readContentRows(taskSpaceId, changeState.changed, targetArchiveSnapshotId)
    : []
  const manualOnly =
    canIncremental &&
    !changeState.changed.length &&
    currentManualFingerprint !== state.manualStageFingerprint
  if (manualOnly) stats.mode = 'manual-reproject'
  stats.changedTaskCount = changeState.changed.length
  stats.contentRowsRead = canIncremental
    ? changedRows.length
    : metadata.filter((row) => !row.deleted).length

  let scan = null
  let project = canIncremental ? state.project : null
  let projectError = canIncremental ? state.projectError || null : null
  if (!canIncremental) {
    const rows = readContentRows(taskSpaceId, null, targetArchiveSnapshotId)
    stats.contentRowsRead = rows.length
    const workerStartedAt = Date.now()
    const rawScan = (
      await requestWorker(
        'snapshot-materialize',
        {
          project: {
            id: taskSpace.id,
            projectId: taskSpace.project_id,
            name: taskSpace.project_name,
            teamId: taskSpace.owner_team_id,
            teamName: taskSpace.team_name,
            branchName: taskSpace.branch_name,
            members: db
              .prepare(`
              SELECT trellis_dev_id
              FROM sync_project_member
              WHERE project_id = ? AND trellis_dev_id IS NOT NULL
              ORDER BY trellis_dev_id
            `)
              .all(taskSpace.project_id)
              .map((row) => row.trellis_dev_id),
          },
          rows,
          revision: targetRevision,
        },
        'snapshot-materialize-result',
      )
    ).scan
    scan = {
      ...rawScan,
      tasks: withSnapshotFileMetadata(rawScan.tasks, rows),
    }
    stats.workerMs = Date.now() - workerStartedAt
    project = projectForTaskSpace(taskSpace, scan.project)
    projectError = scan.error || null
    stats.scannedTaskCount = scan.tasks.length
  } else if (changedRows.length) {
    const workerStartedAt = Date.now()
    const rawScan = (
      await requestWorker(
        'snapshot-materialize',
        {
          project: {
            ...state.project,
            id: taskSpace.id,
            projectId: taskSpace.project_id,
            name: taskSpace.project_name,
            teamId: taskSpace.owner_team_id,
            teamName: taskSpace.team_name,
            branchName: taskSpace.branch_name,
          },
          rows: changedRows,
          revision: targetRevision,
        },
        'snapshot-materialize-result',
      )
    ).scan
    scan = {
      ...rawScan,
      tasks: withSnapshotFileMetadata(rawScan.tasks, changedRows),
    }
    stats.workerMs = Date.now() - workerStartedAt
    if (scan.error) throw new Error(`增量任务扫描失败：${scan.error}`)
    projectError = metadata.some((row) => !row.deleted) ? null : state.projectError || null
    stats.scannedTaskCount = scan.tasks.length
  }

  const latest = taskSpaceRow(taskSpaceId)
  if (
    !latest ||
    Number(latest.revision) !== targetRevision ||
    Number(latest.archive_revision) !== targetArchiveRevision
  ) {
    stats.totalMs = Date.now() - startedAt
    stats.result = 'superseded'
    return { superseded: true, revision: targetRevision, stats }
  }
  if (latest.retired_at || latest.status === 'disabled') {
    stats.totalMs = Date.now() - startedAt
    stats.result = 'superseded'
    return { superseded: true, revision: targetRevision, stats }
  }

  const nextRawTasks = canIncremental ? new Map(state.rawTasksByDir) : rawTaskMap(scan?.tasks || [])
  if (canIncremental) {
    for (const taskDir of changeState.changed) nextRawTasks.delete(taskDir)
    for (const task of scan?.tasks || []) {
      if (!changedSet.has(task.relativeDir)) {
        throw new Error('增量扫描返回了未请求的任务目录')
      }
      nextRawTasks.set(task.relativeDir, task)
    }
  }
  stats.reusedTaskCount = canIncremental
    ? [...nextRawTasks.keys()].filter((taskDir) => !changedSet.has(taskDir)).length
    : 0

  const relationshipStartedAt = Date.now()
  const materializedBoard = buildBoard(
    {
      project,
      tasks: [...nextRawTasks.values()],
      error: projectError,
    },
    latest,
  )
  stats.relationshipMs = Date.now() - relationshipStartedAt
  const board = materializedBoard.board
  const boardVersion = hashValue({
    taskSpaceId,
    revision: targetRevision,
    archiveRevision: targetArchiveRevision,
    manualStageFingerprint: materializedBoard.manualStageFingerprint,
    taskControlFingerprint: currentTaskControlFingerprint,
    tasks: [...nextRawTasks.entries()]
      .sort(([left], [right]) => left.localeCompare(right, 'en'))
      .map(([taskDir, task]) => [taskDir, task.taskVersion || null]),
  })
  const projectionStateJson = serializeProjectionState({
    project,
    tasks: nextRawTasks,
    dirFingerprints: changeState.currentFingerprints,
    projectError,
    manualStageFingerprint: materializedBoard.manualStageFingerprint,
    taskControlFingerprint: currentTaskControlFingerprint,
    detailTasks: materializedBoard.detailTasks,
    archiveSnapshotId: targetArchiveSnapshotId,
    stats,
  })

  let result
  const databaseStartedAt = Date.now()
  try {
    result = replaceIndexInTransaction(deps, {
      taskSpace: latest,
      board,
      boardVersion,
      targetRevision,
      targetArchiveRevision,
      targetArchiveSnapshotId,
      projectionStateJson,
      expectedManualFingerprint: materializedBoard.manualStageFingerprint,
    })
  } catch (error) {
    if (error instanceof ProjectionSuperseded) {
      stats.totalMs = Date.now() - startedAt
      stats.result = 'superseded'
      return { superseded: true, revision: targetRevision, stats }
    }
    throw error
  }
  stats.databaseMs = Date.now() - databaseStartedAt
  stats.totalMs = Date.now() - startedAt
  onQueryRevisionChanged?.(result.queryRevision)
  onProjected?.({
    taskSpaceId,
    projectId: latest.project_id,
    revision: targetRevision,
    archiveRevision: targetArchiveRevision,
    archiveSnapshotId: targetArchiveSnapshotId,
    source: options.source || 'agent',
    activeAdvanced:
      (options.source || 'agent') === 'agent' ||
      Boolean(state && targetRevision > Number(state.revision)),
    archiveAdvanced: state
      ? targetArchiveRevision > Number(state.archiveRevision)
      : targetArchiveRevision > 0 || targetArchiveSnapshotId !== null,
    board,
  })
  const nextState = {
    revision: targetRevision,
    archiveRevision: targetArchiveRevision,
    archiveSnapshotId: targetArchiveSnapshotId,
    board,
    detailTasks: materializedBoard.detailTasks,
    rawTasksByDir: nextRawTasks,
    dirFingerprints: changeState.currentFingerprints,
    project,
    projectError,
    manualStageFingerprint: materializedBoard.manualStageFingerprint,
    taskControlFingerprint: currentTaskControlFingerprint,
    stats: { ...stats },
  }
  materialized.set(taskSpaceId, nextState)
  logger.info?.('任务空间投影完成', {
    ...stats,
    taskCount: nextRawTasks.size,
    changedIndexCount: result.changedIndexCount,
  })
  return {
    superseded: false,
    revision: targetRevision,
    archiveRevision: targetArchiveRevision,
    archiveSnapshotId: targetArchiveSnapshotId,
    boardVersion,
    board,
    queryRevision: result.queryRevision,
    stats,
  }
}
