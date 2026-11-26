import { ERROR_CODES, teamError } from '../errors.js'

const PROJECT_ROLES = new Set(['lead', 'member', 'read_only'])
const LOCAL_REPO_KEY = /^[a-f0-9]{64}$/
export const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
export const DEFAULT_LISTENER_STALE_MS = 60 * 1000

export function nowIso() {
  return new Date().toISOString()
}

export function requiredText(value, label, max = 255) {
  const result = String(value || '').trim()
  if (!result || result.length > max) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, `${label}格式无效`)
  }
  return result
}

export function optionalText(value, max = 255) {
  const result = String(value || '').trim()
  return result ? result.slice(0, max) : null
}

export function normalizeRole(value, fallback = 'read_only') {
  const role = String(value || fallback).trim()
  if (!PROJECT_ROLES.has(role)) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, '项目成员角色无效')
  }
  return role
}

export function assertLocalRepoKey(value) {
  const key = String(value || '').trim()
  if (!LOCAL_REPO_KEY.test(key)) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, '本地仓库标识格式无效')
  }
  return key
}

export function safeId(value, label) {
  const id = requiredText(value, label, 128)
  if (!SAFE_ID.test(id)) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, `${label}格式无效`)
  }
  return id
}

export function emptyListenerSummary() {
  return {
    approvedBindingCount: 0,
    onlineListenerCount: 0,
    listenerReportedBindingCount: 0,
    lastListenerAt: null,
  }
}

export function emptyTaskSpaceStats() {
  return {
    taskCount: 0,
    fileCount: 0,
    activeTaskCount: 0,
    archivedTaskCount: 0,
    lastActivityAt: null,
    unarchivedTaskTitles: [],
  }
}

const STATEMENTS = {
  userAccountById: `
    SELECT id, username, display_name, system_admin, status
    FROM user_account
    WHERE id = ?
  `,
  activeTeamById: "SELECT id FROM team WHERE id = ? AND status = 'active'",
  allTeamAccess: 'SELECT * FROM sync_project_team_access',
  projectMembersWithUser: `
    SELECT m.*, u.username, u.display_name
    FROM sync_project_member m
    JOIN user_account u ON u.id = m.user_id
  `,
  workspaceDevIds: `
    SELECT project_id, trellis_dev_id
    FROM sync_project_member
    WHERE trellis_dev_id IS NOT NULL AND length(trim(trellis_dev_id)) > 0
    ORDER BY trellis_dev_id COLLATE NOCASE
  `,
  projectById: 'SELECT * FROM sync_project WHERE id = ?',
  projectPurgeIdentity: 'SELECT id, name, owner_team_id FROM sync_project WHERE id = ?',
  projectPurgeSummary: `
    SELECT p.remote_url,
           (SELECT COUNT(*) FROM sync_task_space s WHERE s.project_id = p.id) AS task_space_count,
           (SELECT COUNT(*) FROM sync_task t WHERE t.project_id = p.id) AS task_count,
           (SELECT COUNT(*) FROM sync_project_member m WHERE m.project_id = p.id) AS member_count,
           (SELECT COUNT(*) FROM sync_project_team_access a WHERE a.project_id = p.id) AS team_access_count
    FROM sync_project p
    WHERE p.id = ?
  `,
  taskSpaceDetailById: `
    SELECT s.*, p.name AS project_name, p.remote_url, p.remote_identity_hash,
           p.baseline_branch, p.owner_team_id, p.status AS project_status,
           team.name AS owner_team_name
    FROM sync_task_space s
    JOIN sync_project p ON p.id = s.project_id
    JOIN team ON team.id = p.owner_team_id
    WHERE s.id = ?
  `,
  activeProjects: `
    SELECT *
    FROM sync_project
    WHERE status = 'active'
    ORDER BY name COLLATE NOCASE, id
  `,
  allProjects: 'SELECT * FROM sync_project ORDER BY created_at DESC, id DESC',
  projectByRemoteHash: 'SELECT * FROM sync_project WHERE remote_identity_hash = ?',
  taskSpaceByProjectBranch:
    'SELECT * FROM sync_task_space WHERE project_id = ? AND branch_name = ?',
  taskSpaceBranchWithProject: `
    SELECT s.*, p.baseline_branch, p.owner_team_id AS team_id,
           p.status AS project_status
    FROM sync_task_space s
    JOIN sync_project p ON p.id = s.project_id
    WHERE s.project_id = ? AND s.branch_name = ?
  `,
  preflightFiles: `
    SELECT f.relative_path, f.sha256, f.task_id, f.task_dir,
           CASE WHEN f.relative_path = f.task_dir || '/task.json' THEN f.content_text ELSE NULL END AS task_json_text
    FROM sync_task_space_file f
    JOIN sync_task t
      ON t.task_space_id = f.task_space_id
     AND t.task_id = f.task_id
     AND t.assignee_user_id = ?
     AND t.archived = 0
    WHERE f.task_space_id = ? AND f.deleted = 0
      AND f.task_dir NOT LIKE '.trellis/tasks/archive/%'
      AND f.relative_path NOT LIKE '.trellis/tasks/archive/%'
      AND NOT EXISTS (
        SELECT 1 FROM sync_task_lease lease
        WHERE lease.execution_task_key = t.execution_task_key
          AND lease.status = 'active'
          AND lease.expires_at > ?
          AND ? IS NOT NULL
          AND lease.agent_id <> ?
      )
    ORDER BY f.task_dir, f.relative_path
  `,
  preflightHiddenTasks: `
    SELECT relative_dir, archived
    FROM sync_task
    WHERE task_space_id = ?
      AND (archived = 1 OR assignee_user_id IS NULL OR assignee_user_id <> ?)
  `,
  preflightLegacyTaskDirs: `
    SELECT DISTINCT f.task_dir
    FROM sync_task_space_file f
    WHERE f.task_space_id = ? AND f.deleted = 0
      AND f.task_dir NOT LIKE '.trellis/tasks/archive/%'
      AND NOT EXISTS (
        SELECT 1 FROM sync_task t
        WHERE t.task_space_id = f.task_space_id AND t.task_id = f.task_id
      )
  `,
  activeAgentDevice: "SELECT id, user_id FROM agent_device WHERE id = ? AND status = 'active'",
  insertProject: `
    INSERT INTO sync_project(
      id, name, remote_url, remote_identity_hash, owner_team_id, status,
      baseline_branch, created_by_user_id, created_by_agent_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)
  `,
  insertOwnerTeamAccess: `
    INSERT INTO sync_project_team_access(
      project_id, team_id, access_role, created_by_user_id, created_at
    ) VALUES (?, ?, 'owner', ?, ?)
  `,
  updateProjectBaseline: 'UPDATE sync_project SET baseline_branch = ?, updated_at = ? WHERE id = ?',
  projectMemberByUser: 'SELECT * FROM sync_project_member WHERE project_id = ? AND user_id = ?',
  insertProjectMember: `
    INSERT INTO sync_project_member(
      project_id, user_id, role, trellis_dev_id, created_by_user_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
  updateMemberDevId: `
    UPDATE sync_project_member
    SET trellis_dev_id = ?, updated_at = ?
    WHERE project_id = ? AND user_id = ?
  `,
  insertTaskSpace: `
    INSERT INTO sync_task_space(
      id, project_id, branch_name, status, revision, indexed_revision,
      created_by_user_id, created_by_agent_id, created_at, updated_at
    ) VALUES (?, ?, ?, 'active', 0, 0, ?, ?, ?, ?)
  `,
  replacedBindings: `
    SELECT id, task_space_id, branch_name
    FROM sync_agent_binding
    WHERE agent_id = ? AND local_repo_key = ? AND task_space_id <> ?
      AND sync_status <> 'revoked'
  `,
  bindingByAgentSpace: 'SELECT * FROM sync_agent_binding WHERE agent_id = ? AND task_space_id = ?',
  insertBinding: `
    INSERT INTO sync_agent_binding(
      id, agent_id, task_space_id, local_repo_key, local_display_name,
      branch_name, sync_status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'approved', ?, ?)
  `,
  updateBindingApproved: `
    UPDATE sync_agent_binding
    SET local_repo_key = ?, local_display_name = ?, branch_name = ?,
        sync_status = 'approved', is_listening = ?, listener_reported_at = ?,
        last_error = NULL, updated_at = ?
    WHERE id = ?
  `,
  bindingById: 'SELECT * FROM sync_agent_binding WHERE id = ?',
  taskSpacesForProjectActive: `
    SELECT s.*, p.baseline_branch, p.owner_team_id AS team_id,
           p.status AS project_status
    FROM sync_task_space s
    JOIN sync_project p ON p.id = s.project_id
    WHERE s.project_id = ?
      AND s.retired_at IS NULL
    ORDER BY s.branch_name COLLATE NOCASE
  `,
  taskSpacesForProjectAll: `
    SELECT s.*, p.baseline_branch, p.owner_team_id AS team_id,
           p.status AS project_status
    FROM sync_task_space s
    JOIN sync_project p ON p.id = s.project_id
    WHERE s.project_id = ?
    ORDER BY s.branch_name COLLATE NOCASE
  `,
  approvedBindingCount: `
    SELECT COUNT(*) AS count
    FROM sync_agent_binding
    WHERE task_space_id = ? AND sync_status = 'approved'
  `,
  retireTaskSpace: `
    UPDATE sync_task_space
    SET status = 'disabled', retired_at = ?, retired_by_user_id = ?,
        retired_reason = ?, updated_at = ?
    WHERE id = ? AND project_id = ?
  `,
  stopBindingsForTaskSpace: `
    UPDATE sync_agent_binding
    SET is_listening = 0, updated_at = ?
    WHERE task_space_id = ? AND sync_status = 'approved'
  `,
  cancelCommandsForTaskSpace: `
    UPDATE sync_task_command
    SET status = 'cancelled',
        error_text = '任务空间已弃用，操作已取消',
        updated_at = ?
    WHERE task_space_id = ? AND status IN ('pending', 'delivered', 'running')
  `,
  restoreTaskSpace: `
    UPDATE sync_task_space
    SET status = 'active', retired_at = NULL, retired_by_user_id = NULL,
        retired_reason = NULL, updated_at = ?
    WHERE id = ? AND project_id = ?
  `,
  unarchivedTitles: `
    SELECT title
    FROM sync_task_index
    WHERE task_space_id = ? AND archived = 0
    ORDER BY updated_at DESC, task_key
    LIMIT 100
  `,
  bindingAgentIds: 'SELECT DISTINCT agent_id FROM sync_agent_binding WHERE task_space_id = ?',
  pendingConflicts: `
    SELECT COUNT(*) AS count FROM sync_conflict
    WHERE task_space_id = ? AND status = 'pending'
  `,
  activeCommandsForTaskSpace: `
    SELECT COUNT(*) AS count FROM sync_task_command
    WHERE task_space_id = ? AND status IN ('pending', 'delivered', 'running')
  `,
  taskSpaceIdentity: 'SELECT id, branch_name FROM sync_task_space WHERE id = ? AND project_id = ?',
  deleteTaskSpace: 'DELETE FROM sync_task_space WHERE id = ? AND project_id = ?',
  taskSpaceWithProject: `
    SELECT s.*, p.baseline_branch, p.owner_team_id, p.status AS project_status
    FROM sync_task_space s
    JOIN sync_project p ON p.id = s.project_id
    WHERE s.id = ?
  `,
  listenerDetails: `
    SELECT
      b.id AS binding_id,
      b.agent_id,
      a.user_id,
      u.username,
      u.display_name,
      m.trellis_dev_id,
      a.device_name,
      b.sync_status,
      b.listener_reported_at,
      b.last_listener_at,
      b.created_at,
      CASE
        WHEN b.is_listening = 1
          AND b.listener_reported_at >= ?
          AND a.status = 'active'
          AND a.last_seen_at >= ?
          AND active.agent_id = a.id
          AND s.status = 'active'
          AND p.status = 'active'
        THEN 1 ELSE 0
      END AS online
    FROM sync_agent_binding b
    JOIN agent_device a ON a.id = b.agent_id
    JOIN user_account u ON u.id = a.user_id
    JOIN sync_task_space s ON s.id = b.task_space_id
    JOIN sync_project p ON p.id = s.project_id
    LEFT JOIN sync_project_member m ON m.project_id = s.project_id AND m.user_id = a.user_id
    LEFT JOIN sync_active_agent active ON active.user_id = a.user_id
    WHERE b.task_space_id = ? AND b.sync_status = 'approved'
    ORDER BY online DESC, b.created_at, b.id
  `,
  activeAgentForUser: `
    SELECT 1
    FROM agent_device a
    JOIN sync_active_agent active ON active.user_id = a.user_id AND active.agent_id = a.id
    WHERE a.id = ? AND a.user_id = ? AND a.status = 'active'
  `,
  revokeBinding: `
    UPDATE sync_agent_binding
    SET sync_status = 'revoked', is_listening = 0, updated_at = ?
    WHERE id = ? AND sync_status <> 'revoked'
  `,
  cancelCommandsForBinding: `
    UPDATE sync_task_command
    SET status = 'cancelled',
        error_text = '客户端主动解除任务空间关联',
        updated_at = ?
    WHERE binding_id = ? AND status IN ('pending', 'delivered', 'running')
  `,
  deleteCursor: 'DELETE FROM sync_agent_cursor WHERE agent_id = ? AND task_space_id = ?',
  upsertTeamAccess: `
    INSERT INTO sync_project_team_access(
      project_id, team_id, access_role, created_by_user_id, created_at
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(project_id, team_id) DO UPDATE SET
      access_role = excluded.access_role,
      created_by_user_id = excluded.created_by_user_id,
      created_at = excluded.created_at
  `,
  teamAccessList: `
    SELECT a.project_id, a.team_id, a.access_role, a.created_at,
           t.name AS team_name, t.status AS team_status
    FROM sync_project_team_access a
    JOIN team t ON t.id = a.team_id
    WHERE a.project_id = ?
    ORDER BY CASE a.access_role WHEN 'owner' THEN 0 ELSE 1 END,
             t.name COLLATE NOCASE
  `,
  deleteTeamAccess: 'DELETE FROM sync_project_team_access WHERE project_id = ? AND team_id = ?',
  activeUserById: "SELECT id FROM user_account WHERE id = ? AND status = 'active'",
  upsertProjectMember: `
    INSERT INTO sync_project_member(
      project_id, user_id, role, trellis_dev_id, created_by_user_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id, user_id) DO UPDATE SET
      role = excluded.role,
      trellis_dev_id = excluded.trellis_dev_id,
      updated_at = excluded.updated_at
  `,
  usernameById: 'SELECT username FROM user_account WHERE id = ?',
  deleteProjectMember: 'DELETE FROM sync_project_member WHERE project_id = ? AND user_id = ?',
  disableProjectRow: "UPDATE sync_project SET status = 'disabled', updated_at = ? WHERE id = ?",
  stopProjectBindings: `
    UPDATE sync_agent_binding
    SET is_listening = 0, updated_at = ?
    WHERE task_space_id IN (SELECT id FROM sync_task_space WHERE project_id = ?)
  `,
  cancelProjectCommands: `
    UPDATE sync_task_command
    SET status = 'cancelled', updated_at = ?
    WHERE project_id = ? AND status IN ('pending', 'delivered', 'running')
  `,
  deleteProject: 'DELETE FROM sync_project WHERE id = ?',
}

export function createStatements(db) {
  const prepared = new Map()
  const statement = (sql) => {
    let entry = prepared.get(sql)
    if (!entry) {
      entry = db.prepare(sql)
      prepared.set(sql, entry)
    }
    return entry
  }
  const marks = (count) => Array.from({ length: count }, () => '?').join(', ')
  const statements = {}
  for (const [name, sql] of Object.entries(STATEMENTS)) {
    Object.defineProperty(statements, name, {
      enumerable: true,
      get: () => statement(sql),
    })
  }
  return Object.assign(statements, {
    taskSpaceStatsFiles: (count) =>
      statement(`
        SELECT task_space_id, COUNT(DISTINCT task_dir) AS task_count,
               COUNT(*) AS file_count, MAX(updated_at) AS last_activity_at
        FROM sync_task_space_file
        WHERE task_space_id IN (${marks(count)}) AND deleted = 0
        GROUP BY task_space_id
      `),
    taskSpaceStatsIndexes: (count) =>
      statement(`
        SELECT task_space_id,
               SUM(CASE WHEN archived = 0 THEN 1 ELSE 0 END) AS active_task_count,
               SUM(CASE WHEN archived = 1 THEN 1 ELSE 0 END) AS archived_task_count,
               MAX(updated_at) AS last_activity_at
        FROM sync_task_index
        WHERE task_space_id IN (${marks(count)})
        GROUP BY task_space_id
      `),
    taskSpaceStatsTitles: (count) =>
      statement(`
        SELECT task_space_id, title
        FROM (
          SELECT task_space_id, title,
                 ROW_NUMBER() OVER (
                   PARTITION BY task_space_id
                   ORDER BY updated_at DESC, task_key
                 ) AS row_number
          FROM sync_task_index
          WHERE task_space_id IN (${marks(count)}) AND archived = 0
        )
        WHERE row_number <= 5
        ORDER BY task_space_id, row_number
      `),
    listenerSummaries: (count) =>
      statement(`
        SELECT
          b.task_space_id,
          SUM(CASE WHEN b.sync_status = 'approved' THEN 1 ELSE 0 END) AS approved_count,
          SUM(CASE
            WHEN b.sync_status = 'approved' AND b.listener_reported_at IS NOT NULL
            THEN 1 ELSE 0
          END) AS reported_count,
          SUM(CASE
            WHEN b.sync_status = 'approved'
              AND b.is_listening = 1
              AND b.listener_reported_at >= ?
              AND a.status = 'active'
              AND a.last_seen_at >= ?
              AND active.agent_id = a.id
              AND s.status = 'active'
              AND s.retired_at IS NULL
              AND p.status = 'active'
            THEN 1 ELSE 0
          END) AS online_count,
          MAX(CASE WHEN b.sync_status = 'approved' THEN b.last_listener_at END) AS last_listener_at
        FROM sync_agent_binding b
        JOIN sync_task_space s ON s.id = b.task_space_id
        JOIN sync_project p ON p.id = s.project_id
        JOIN agent_device a ON a.id = b.agent_id
        LEFT JOIN sync_active_agent active ON active.user_id = a.user_id
        WHERE b.task_space_id IN (${marks(count)})
        GROUP BY b.task_space_id
      `),
    taskSpacesForProjects: (count, includeDisabled = false) =>
      statement(`
        SELECT s.*, p.baseline_branch, p.owner_team_id AS team_id,
               p.status AS project_status
        FROM sync_task_space s
        JOIN sync_project p ON p.id = s.project_id
        WHERE s.project_id IN (${marks(count)})
          AND s.status IN (${
            includeDisabled
              ? "'active', 'indexing', 'error', 'disabled'"
              : "'active', 'indexing', 'error'"
          })
          AND s.retired_at IS NULL
        ORDER BY s.project_id, s.branch_name COLLATE NOCASE
      `),
    taskSpacesForAllProjects: (count) =>
      statement(`
        SELECT s.*, p.owner_team_id AS team_id, p.status AS project_status
        FROM sync_task_space s
        JOIN sync_project p ON p.id = s.project_id
        WHERE s.project_id IN (${marks(count)})
        ORDER BY s.project_id, s.branch_name COLLATE NOCASE
      `),
    revokeBindingsByIds: (count) =>
      statement(`
        UPDATE sync_agent_binding
        SET sync_status = 'revoked', is_listening = 0,
            last_error = '任务空间绑定已被本机新分支替换', updated_at = ?
        WHERE id IN (${marks(count)})
      `),
    cancelCommandsByBindingIds: (count) =>
      statement(`
        UPDATE sync_task_command
        SET status = 'cancelled',
            error_text = '任务空间绑定已被本机新分支替换',
            updated_at = ?
        WHERE binding_id IN (${marks(count)})
          AND status IN ('pending', 'delivered', 'running')
      `),
  })
}

export function taskSpaceStats(statements, taskSpaceIds, { includeTaskTitles = false } = {}) {
  if (!taskSpaceIds.length) return new Map()
  const files = statements.taskSpaceStatsFiles(taskSpaceIds.length).all(...taskSpaceIds)
  const indexes = statements.taskSpaceStatsIndexes(taskSpaceIds.length).all(...taskSpaceIds)
  const result = new Map()
  for (const row of files) {
    result.set(row.task_space_id, {
      ...emptyTaskSpaceStats(),
      taskCount: Number(row.task_count || 0),
      fileCount: Number(row.file_count || 0),
      lastActivityAt: row.last_activity_at || null,
    })
  }
  for (const row of indexes) {
    const current = result.get(row.task_space_id) || emptyTaskSpaceStats()
    result.set(row.task_space_id, {
      ...current,
      activeTaskCount: Number(row.active_task_count || 0),
      archivedTaskCount: Number(row.archived_task_count || 0),
      lastActivityAt: current.lastActivityAt || row.last_activity_at || null,
    })
  }
  if (includeTaskTitles) {
    const titles = statements.taskSpaceStatsTitles(taskSpaceIds.length).all(...taskSpaceIds)
    for (const row of titles) {
      const current = result.get(row.task_space_id) || emptyTaskSpaceStats()
      current.unarchivedTaskTitles.push(row.title)
      result.set(row.task_space_id, current)
    }
  }
  return result
}

export function listenerSummaries(statements, taskSpaceIds, staleCutoff) {
  if (!taskSpaceIds.length) return new Map()
  const rows = statements
    .listenerSummaries(taskSpaceIds.length)
    .all(staleCutoff, staleCutoff, ...taskSpaceIds)
  return new Map(
    rows.map((row) => [
      row.task_space_id,
      {
        approvedBindingCount: Number(row.approved_count || 0),
        onlineListenerCount: Number(row.online_count || 0),
        listenerReportedBindingCount: Number(row.reported_count || 0),
        lastListenerAt: row.last_listener_at || null,
      },
    ]),
  )
}
