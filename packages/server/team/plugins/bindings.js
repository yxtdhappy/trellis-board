import { ERROR_CODES, teamError } from '../errors.js'

/**
 * 项目绑定：把 Board 的 team_project 和插件侧的项目对上。
 *
 * team_project 的主键是 repository_id，插件侧（例如 WitOps）有自己的一套项目 id，
 * 这里只保存映射关系，不复制远端项目内容。
 */
export function createPluginBindings({ db, now = () => Date.now() }) {
  function rowToBinding(row) {
    return {
      id: row.id,
      teamId: row.team_id,
      pluginId: row.plugin_id,
      projectId: row.project_id,
      projectName: row.project_name ?? null,
      externalProjectId: row.external_project_id,
      externalProjectName: row.external_project_name,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  function list({ teamId, pluginId }) {
    const rows = db
      .prepare(`
      SELECT b.*, p.name AS project_name
      FROM plugin_project_binding b
      LEFT JOIN team_project tp ON tp.repository_id = b.project_id
      LEFT JOIN repositories p ON p.id = tp.repository_id
      WHERE b.team_id = ? AND b.plugin_id = ?
      ORDER BY b.created_at, b.id
    `)
      .all(teamId, pluginId)
    return rows.map(rowToBinding)
  }

  function read(id) {
    const row = db.prepare('SELECT * FROM plugin_project_binding WHERE id = ?').get(id)
    return row ? rowToBinding(row) : null
  }

  function create({ teamId, pluginId, projectId, externalProjectId, externalProjectName, actorUserId }) {
    const project = db
      .prepare('SELECT repository_id FROM team_project WHERE team_id = ? AND repository_id = ?')
      .get(teamId, projectId)
    if (!project) {
      throw teamError(404, ERROR_CODES.NOT_FOUND, '这个项目不在当前团队里')
    }
    const externalId = String(externalProjectId ?? '').trim()
    if (!externalId) {
      throw teamError(400, ERROR_CODES.INVALID_INPUT, '请选择插件侧的项目')
    }
    const existing = db
      .prepare(`
      SELECT id FROM plugin_project_binding
      WHERE team_id = ? AND plugin_id = ? AND external_project_id = ?
    `)
      .get(teamId, pluginId, externalId)
    if (existing) {
      throw teamError(409, 'ALREADY_BOUND', '这个插件项目已经绑定过了')
    }
    const stamp = new Date(now()).toISOString()
    const id = `bind_${crypto.randomUUID()}`
    db.prepare(`
      INSERT INTO plugin_project_binding
        (id, team_id, plugin_id, project_id, external_project_id, external_project_name,
         created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      teamId,
      pluginId,
      projectId,
      externalId,
      String(externalProjectName ?? '').trim() || null,
      actorUserId ?? null,
      stamp,
      stamp,
    )
    return read(id)
  }

  function remove({ teamId, pluginId, bindingId }) {
    const result = db
      .prepare('DELETE FROM plugin_project_binding WHERE id = ? AND team_id = ? AND plugin_id = ?')
      .run(bindingId, teamId, pluginId)
    if (result.changes === 0) {
      throw teamError(404, ERROR_CODES.NOT_FOUND, '绑定不存在')
    }
    return true
  }

  return { list, read, create, remove }
}
