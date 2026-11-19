import { withTransaction } from '../../database.js'
import { getManualRecords } from '../../metadata.js'
import { ProjectionSuperseded, manualStageFingerprint } from './projection-state.js'
import { searchText } from './query-helpers.js'
import { syncAssignments } from './sync-assignments.js'

export function replaceIndexInTransaction(
  deps,
  {
    taskSpace,
    board,
    boardVersion,
    targetRevision,
    targetArchiveRevision,
    targetArchiveSnapshotId,
    projectionStateJson,
    expectedManualFingerprint,
  },
) {
  const {
    INDEX_FIELDS,
    archiveQueryRevision,
    archiveSnapshotIdForTaskSpace,
    assigneeUserMap,
    db,
    incrementArchiveQueryRevision,
    incrementQueryRevision,
    indexRowForTask,
    pending,
    queryRevision,
    sameIndexValues,
    sameTags,
    taskControl,
    taskSpaceRow,
  } = deps
  return withTransaction(db, () => {
    const latest = taskSpaceRow(taskSpace.id)
    if (
      !latest ||
      Number(latest.revision) !== Number(targetRevision) ||
      Number(latest.archive_revision) !== Number(targetArchiveRevision) ||
      archiveSnapshotIdForTaskSpace(latest) !== targetArchiveSnapshotId ||
      latest.retired_at ||
      latest.status === 'disabled'
    ) {
      throw new ProjectionSuperseded(targetRevision)
    }
    const manualRecords = getManualRecords(db)
    if (manualStageFingerprint(taskSpace.id, manualRecords) !== expectedManualFingerprint) {
      throw new ProjectionSuperseded(targetRevision)
    }

    const users = assigneeUserMap(latest.project_id)
    const timestamp = new Date().toISOString()
    const candidateSnapshotId = latest.archive_candidate_snapshot_id || null
    let archiveChanged = Boolean(candidateSnapshotId)
    if (candidateSnapshotId) {
      const candidate = db
        .prepare(`
          SELECT id
          FROM sync_archive_snapshot
          WHERE id = ? AND task_space_id = ? AND status = 'published'
        `)
        .get(candidateSnapshotId, latest.id)
      if (!candidate) throw new Error('归档候选快照不存在，拒绝提交索引')
      db.prepare(`
        UPDATE sync_archive_snapshot
        SET status = 'retired', active = 0, retired_at = ?
        WHERE task_space_id = ? AND id <> ? AND active = 1
      `).run(timestamp, latest.id, candidateSnapshotId)
      db.prepare(`
        UPDATE sync_archive_snapshot
        SET status = 'published', active = 1, published_at = ?, retired_at = NULL
        WHERE id = ?
      `).run(timestamp, candidateSnapshotId)
    }
    const existingRows = db
      .prepare('SELECT * FROM sync_task_index WHERE task_space_id = ?')
      .all(taskSpace.id)
    const existingByKey = new Map(existingRows.map((row) => [row.task_key, row]))
    const existingTags = new Map()
    for (const row of db
      .prepare(
        `SELECT task_key, tag_key FROM sync_task_index_tag
         WHERE task_space_id = ? ORDER BY task_key, tag_key`,
      )
      .all(taskSpace.id)) {
      if (!existingTags.has(row.task_key)) existingTags.set(row.task_key, [])
      existingTags.get(row.task_key).push(row.tag_key)
    }

    const tasksByExecutionKey = new Map()
    for (const task of board.tasks || []) {
      if (!task.taskVersion) continue
      const executionTaskKey = task.executionTaskKey || task.taskKey
      const group = tasksByExecutionKey.get(executionTaskKey) || []
      group.push(task)
      tasksByExecutionKey.set(executionTaskKey, group)
    }
    const projectedTasks = [...tasksByExecutionKey.values()].flatMap((group) => {
      const archived = group.filter((task) => task.archived)
      return archived.length > 0 ? archived : group
    })
    const authority = taskControl?.authoritativeTasks(taskSpace.id) || new Map()
    const desired = new Map()
    const desiredTags = new Map()
    for (const task of projectedTasks) {
      const row = indexRowForTask(task, latest, users, boardVersion, timestamp)
      const controlled = authority.get(row.execution_task_key)
      if (controlled) {
        if (controlled.archived && controlled.task_key) row.task_key = controlled.task_key
        row.relative_dir = controlled.relative_dir || row.relative_dir
        row.title = controlled.title || row.title
        row.assignee_user_id = controlled.assignee_user_id || row.assignee_user_id
        row.assignee_dev_id = controlled.assignee_dev_id || row.assignee_dev_id
        row.archived = controlled.archived ? 1 : row.archived
        row.archived_at = controlled.archived_at || row.archived_at
      }
      desired.set(row.task_key, row)
      desiredTags.set(
        row.task_key,
        [...new Set((task.execution?.tags || []).map((tag) => String(tag).toLowerCase()))].sort(),
      )
    }
    for (const pending of taskControl?.pendingTasks(taskSpace.id) || []) {
      const taskKey = pending.task_key
      if (desired.has(taskKey)) continue
      desired.set(taskKey, {
        task_space_id: taskSpace.id,
        project_id: taskSpace.project_id,
        task_key: taskKey,
        execution_task_key: pending.execution_task_key,
        relative_dir: pending.relative_dir,
        branch_name: taskSpace.branch_name,
        title: pending.title,
        search_text: searchText({
          title: pending.title,
          taskKey,
          relativeDir: pending.relative_dir,
          projectName: taskSpace.project_name,
          branchName: taskSpace.branch_name,
        }),
        archived: 0,
        archived_at: null,
        priority: pending.priority,
        derived_stage: 'planning',
        assignee_dev_id: pending.assignee_dev_id,
        assignee_user_id: pending.assignee_user_id,
        due_date: null,
        last_activity_at: pending.updated_at,
        is_blocked: 0,
        is_unblocked_ready: 0,
        attention_flags_json: '[]',
        group_key: taskKey,
        group_role: 'parent',
        task_version: String(pending.task_version),
        board_version: boardVersion,
        updated_at: timestamp,
      })
      desiredTags.set(taskKey, [])
    }
    taskControl?.reconcileProjection({
      taskSpaceId: taskSpace.id,
      projectId: taskSpace.project_id,
      tasks: projectedTasks,
    })

    const upsert = db.prepare(`
      INSERT INTO sync_task_index(
        task_space_id, project_id, task_key, execution_task_key, relative_dir,
        branch_name, title, search_text, archived, archived_at, priority,
        derived_stage, assignee_dev_id, assignee_user_id, due_date,
        last_activity_at, is_blocked, is_unblocked_ready, attention_flags_json,
        group_key, group_role, task_version, board_version, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_space_id, task_key) DO UPDATE SET
        project_id = excluded.project_id,
        execution_task_key = excluded.execution_task_key,
        relative_dir = excluded.relative_dir,
        branch_name = excluded.branch_name,
        title = excluded.title,
        search_text = excluded.search_text,
        archived = excluded.archived,
        archived_at = excluded.archived_at,
        priority = excluded.priority,
        derived_stage = excluded.derived_stage,
        assignee_dev_id = excluded.assignee_dev_id,
        assignee_user_id = excluded.assignee_user_id,
        due_date = excluded.due_date,
        last_activity_at = excluded.last_activity_at,
        is_blocked = excluded.is_blocked,
        is_unblocked_ready = excluded.is_unblocked_ready,
        attention_flags_json = excluded.attention_flags_json,
        group_key = excluded.group_key,
        group_role = excluded.group_role,
        task_version = excluded.task_version,
        board_version = excluded.board_version,
        updated_at = excluded.updated_at
    `)
    const insertTag = db.prepare(`
      INSERT OR IGNORE INTO sync_task_index_tag(task_space_id, task_key, tag_key)
      VALUES (?, ?, ?)
    `)
    const deleteTag = db.prepare(
      'DELETE FROM sync_task_index_tag WHERE task_space_id = ? AND task_key = ?',
    )
    const deleteIndex = db.prepare(
      'DELETE FROM sync_task_index WHERE task_space_id = ? AND task_key = ?',
    )
    const changedKeys = new Set()

    for (const [taskKey, row] of desired) {
      const previous = existingByKey.get(taskKey)
      const tagsChanged = !sameTags(existingTags.get(taskKey) || [], desiredTags.get(taskKey))
      if (!previous || !sameIndexValues(previous, row) || tagsChanged) {
        upsert.run(...INDEX_FIELDS.map((field) => row[field]), row.board_version, row.updated_at)
        if (tagsChanged || !previous) {
          deleteTag.run(taskSpace.id, taskKey)
          for (const tag of desiredTags.get(taskKey)) insertTag.run(taskSpace.id, taskKey, tag)
        }
        changedKeys.add(taskKey)
        if (row.archived || previous?.archived) archiveChanged = true
      }
    }
    for (const taskKey of existingByKey.keys()) {
      if (desired.has(taskKey)) continue
      deleteIndex.run(taskSpace.id, taskKey)
      changedKeys.add(taskKey)
      if (existingByKey.get(taskKey)?.archived) archiveChanged = true
    }

    // ponytail: 归档版本只看归档行；baseline 空间的身份增删会改变归档去重可见性，
    // 若该极端场景成真，把 baseline 空间插入/删除的执行身份纳入 archiveChanged 判定。

    db.prepare(`
      INSERT INTO sync_task_space_scan_cache(
        task_space_id, indexed_revision, indexed_archive_revision,
        projection_state_json, board_json, saved_at
      )
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_space_id) DO UPDATE SET
        indexed_revision = excluded.indexed_revision,
        indexed_archive_revision = excluded.indexed_archive_revision,
        projection_state_json = excluded.projection_state_json,
        board_json = excluded.board_json,
        saved_at = excluded.saved_at
    `).run(
      taskSpace.id,
      targetRevision,
      targetArchiveRevision,
      projectionStateJson,
      JSON.stringify(board),
      timestamp,
    )
    syncAssignments(db, taskSpace.id, latest.project_id, board)
    const updated = db
      .prepare(`
      UPDATE sync_task_space
      SET status = 'active', indexed_revision = ?, archive_indexed_revision = ?,
          archive_snapshot_id = ?, archive_candidate_snapshot_id = NULL,
          last_error = NULL, updated_at = ?
      WHERE id = ? AND revision = ? AND archive_revision = ?
        AND archive_snapshot_id IS ? AND archive_candidate_snapshot_id IS ?
        AND retired_at IS NULL AND status != 'disabled'
    `)
      .run(
        targetRevision,
        targetArchiveRevision,
        targetArchiveSnapshotId,
        timestamp,
        taskSpace.id,
        targetRevision,
        targetArchiveRevision,
        latest.archive_snapshot_id || null,
        candidateSnapshotId,
      )
    if (Number(updated.changes) !== 1) throw new ProjectionSuperseded(targetRevision)
    return {
      queryRevision: incrementQueryRevision({ publish: false }),
      archiveQueryRevision: archiveChanged
        ? incrementArchiveQueryRevision()
        : archiveQueryRevision(),
      changedIndexCount: changedKeys.size,
    }
  })
}
