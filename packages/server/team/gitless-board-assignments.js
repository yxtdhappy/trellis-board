import { publicAssignment, requiredText } from './gitless-board-shared.js'
import { ERROR_CODES, teamError } from './errors.js'

export function createAssignmentHandlers({ db, taskSpaces }) {
  function listAssignments(actor, input = {}) {
    const state = input.state == null || input.state === '' ? null : String(input.state)
    if (state != null && !new Set(['pending', 'accepted']).has(state)) {
      throw teamError(400, ERROR_CODES.INVALID_INPUT, 'assignment state 无效')
    }
    const rows = db
      .prepare(`
      SELECT a.*, t.*, s.branch_name AS task_space_branch,
             p.name AS project_name, p.owner_team_id AS team_id, team.name AS team_name
      FROM sync_task_assignment a
      JOIN sync_task_index t
        ON t.task_space_id = a.task_space_id
        AND t.execution_task_key = a.execution_task_key
      JOIN sync_task_space s ON s.id = a.task_space_id
      JOIN sync_project p ON p.id = a.project_id
      JOIN team ON team.id = p.owner_team_id
      WHERE a.assigned_user_id = ?
        AND (? IS NULL OR a.state = ?)
        AND t.archived = 0
      ORDER BY CASE a.state WHEN 'pending' THEN 0 ELSE 1 END, a.assigned_at DESC
      LIMIT 200
    `)
      .all(actor.userId, state, state)
      .filter((row) => taskSpaces.readTaskSpace(row.task_space_id, actor))
    return {
      assignments: rows.map((row) => ({
        taskKey: row.task_key,
        executionTaskKey: row.execution_task_key,
        taskVersion: row.task_version,
        projectId: row.project_id,
        projectName: row.project_name,
        taskSpaceId: row.task_space_id,
        branchName: row.task_space_branch,
        teamId: row.team_id || null,
        teamName: row.team_name,
        relativeDir: row.relative_dir,
        title: row.title,
        priority: row.priority,
        derivedStage: row.derived_stage,
        assignee: row.assignee_dev_id || null,
        assigneeUserId: row.assignee_user_id || null,
        dueDate: row.due_date || null,
        lastActivityAt: row.last_activity_at || row.updated_at,
        archived: false,
        assignment: publicAssignment(row),
        assignmentVersion: Number(row.version),
        state: row.state,
        acceptedAt: row.accepted_at || null,
      })),
    }
  }

  function accept(actor, input = {}) {
    const executionTaskKey = requiredText(input.executionTaskKey, '任务身份', 500)
    const row = db
      .prepare('SELECT * FROM sync_task_assignment WHERE execution_task_key = ?')
      .get(executionTaskKey)
    if (!row) throw teamError(404, ERROR_CODES.NOT_FOUND, '任务分派不存在')
    if (row.assigned_user_id !== actor.userId) {
      throw teamError(403, ERROR_CODES.FORBIDDEN, '只能接受分派给自己的任务')
    }
    taskSpaces.authorizeTaskSpace(actor, row.task_space_id, 'view')
    if (row.state !== 'accepted') {
      db.prepare(`
        UPDATE sync_task_assignment
        SET state = 'accepted', accepted_at = ?, version = version + 1
        WHERE execution_task_key = ?
      `).run(new Date().toISOString(), executionTaskKey)
    }
    const updated = db
      .prepare('SELECT * FROM sync_task_assignment WHERE execution_task_key = ?')
      .get(executionTaskKey)
    return {
      message: '任务已接受',
      assignment: { ...publicAssignment(updated), assignmentVersion: Number(updated.version) },
    }
  }

  return { listAssignments, accept }
}
