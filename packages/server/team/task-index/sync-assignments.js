export function syncAssignments(db, taskSpaceId, projectId, board) {
  const users = new Map(
    db
      .prepare(`
      SELECT m.trellis_dev_id, m.user_id
      FROM sync_project_member m
      JOIN user_account u ON u.id = m.user_id
      WHERE m.project_id = ? AND m.role IN ('lead', 'member') AND u.status = 'active'
    `)
      .all(projectId)
      .map((row) => [String(row.trellis_dev_id).toLowerCase(), row.user_id]),
  )
  const tasks = new Map(
    (board.tasks || [])
      .filter(
        (task) =>
          task.executionTaskKey &&
          task.executionIdentityValid !== false &&
          task.executionIdentityConflict !== true,
      )
      .map((task) => [task.executionTaskKey, task]),
  )
  const existing = db
    .prepare('SELECT * FROM sync_task_assignment WHERE task_space_id = ?')
    .all(taskSpaceId)
  const existingKeys = new Set(existing.map((row) => row.execution_task_key))
  for (const row of existing) {
    const task = tasks.get(row.execution_task_key)
    const userId = task?.assignee ? users.get(String(task.assignee).toLowerCase()) || null : null
    if (!task || !userId) {
      db.prepare('DELETE FROM sync_task_assignment WHERE execution_task_key = ?').run(
        row.execution_task_key,
      )
      continue
    }
    if (userId === row.assigned_user_id) continue
    db.prepare(`
      UPDATE sync_task_assignment
      SET assigned_user_id = ?, state = 'pending', assigned_at = ?,
          accepted_at = NULL, base_task_version = ?, version = version + 1
      WHERE execution_task_key = ?
    `).run(
      userId,
      new Date().toISOString(),
      task.taskVersion || row.base_task_version,
      row.execution_task_key,
    )
  }
  for (const task of tasks.values()) {
    if (existingKeys.has(task.executionTaskKey) || !task.assignee) continue
    const userId = users.get(String(task.assignee).toLowerCase())
    if (!userId) continue
    const now = new Date().toISOString()
    db.prepare(`
      INSERT OR IGNORE INTO sync_task_assignment(
        execution_task_key, task_space_id, project_id, assigned_user_id,
        state, assigned_by, assigned_at, accepted_at, base_task_version, version
      ) VALUES (?, ?, ?, ?, 'pending', ?, ?, NULL, ?, 1)
    `).run(
      task.executionTaskKey,
      taskSpaceId,
      projectId,
      userId,
      userId,
      now,
      task.taskVersion || null,
    )
  }
}
