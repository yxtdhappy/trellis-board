import { withTransaction } from '../database.js'

const ACTIVE_RUN_STATUSES = ['queued', 'starting', 'running']

function encode(value) {
  return JSON.stringify(value ?? null)
}

function decode(value) {
  if (value == null) return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

/**
 * plugin_state / plugin_run / plugin_audit 的唯一访问层。
 * 所有 key 在存储时加 `<pluginId>:` 前缀，避免插件之间互相覆盖。
 */
export function createPluginStore({ db, now = () => new Date().toISOString() }) {
  const stateKey = (pluginId, key) => `${pluginId}:${key}`

  function getState(pluginId, key) {
    const row = db
      .prepare(`
      SELECT value
      FROM plugin_state
      WHERE plugin_id = ? AND key = ?
    `)
      .get(pluginId, stateKey(pluginId, key))
    return row ? decode(row.value) : null
  }

  function setState(pluginId, key, value) {
    db.prepare(`
      INSERT INTO plugin_state(plugin_id, key, value, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(plugin_id, key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `).run(pluginId, stateKey(pluginId, key), encode(value), now())
    return value
  }

  function deleteState(pluginId, key) {
    const result = db
      .prepare(`
      DELETE FROM plugin_state
      WHERE plugin_id = ? AND key = ?
    `)
      .run(pluginId, stateKey(pluginId, key))
    return result.changes > 0
  }

  function listState(pluginId, prefix = '') {
    const scopedPrefix = stateKey(pluginId, prefix)
    const rows = db
      .prepare(`
      SELECT key, value, updated_at
      FROM plugin_state
      WHERE plugin_id = ? AND key LIKE ?
      ORDER BY key
    `)
      .all(pluginId, `${scopedPrefix}%`)
    return rows.map((row) => ({
      key: row.key.slice(pluginId.length + 1),
      value: decode(row.value),
      updatedAt: row.updated_at,
    }))
  }

  function clearState(pluginId) {
    const result = db.prepare('DELETE FROM plugin_state WHERE plugin_id = ?').run(pluginId)
    return result.changes
  }

  function getManifest(pluginId) {
    return getState(pluginId, '__manifest')
  }

  function setManifest(pluginId, manifest) {
    return setState(pluginId, '__manifest', manifest)
  }

  function audit(pluginId, kind, detail = null, { version = null, at = now() } = {}) {
    db.prepare(`
      INSERT INTO plugin_audit(plugin_id, plugin_version, kind, detail, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(pluginId, version, kind, detail == null ? null : encode(detail), at)
  }

  function listAudit(pluginId, { limit = 100 } = {}) {
    const rows = db
      .prepare(`
      SELECT id, plugin_id, plugin_version, kind, detail, created_at
      FROM plugin_audit
      WHERE plugin_id = ?
      ORDER BY id DESC
      LIMIT ?
    `)
      .all(pluginId, Math.max(1, Math.min(1000, Number(limit) || 100)))
    return rows.map((row) => ({
      id: row.id,
      pluginId: row.plugin_id,
      pluginVersion: row.plugin_version,
      kind: row.kind,
      detail: decode(row.detail),
      createdAt: row.created_at,
    }))
  }

  function createRun({
    runId,
    pluginId,
    pluginVersion = null,
    taskKey = null,
    status = 'queued',
    request = null,
    startedAt = now(),
  }) {
    db.prepare(`
      INSERT INTO plugin_run(
        run_id, plugin_id, plugin_version, task_key, status, request, result, started_at, finished_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL)
    `).run(runId, pluginId, pluginVersion, taskKey, status, encode(request), startedAt)
    return getRun(runId)
  }

  function startRun({
    pluginId,
    pluginVersion = null,
    taskKey,
    request = null,
    status = 'running',
  }) {
    if (!pluginId) throw new Error('startRun 缺少 pluginId')
    if (!taskKey) throw new Error('startRun 缺少 taskKey')
    return withTransaction(db, () => {
      const active = findActiveRun(pluginId, taskKey)
      if (active) return { run: active, started: false }
      const attempt = nextAttempt(pluginId, taskKey)
      const runId = `${pluginId}:${taskKey}:${attempt}`
      const run = createRun({ runId, pluginId, pluginVersion, taskKey, status, request })
      return { run, started: true }
    })
  }

  function finishRun(runId, { status = 'succeeded', result = null, finishedAt = now() } = {}) {
    return updateRun(runId, { status, result, finishedAt })
  }

  function getRun(runId) {
    const row = db
      .prepare(`
      SELECT *
      FROM plugin_run
      WHERE run_id = ?
    `)
      .get(runId)
    return row ? toRun(row) : null
  }

  function updateRun(runId, patch) {
    const current = getRun(runId)
    if (!current) return null
    const status = patch.status ?? current.status
    const result =
      patch.result !== undefined
        ? encode(patch.result)
        : current.result == null
          ? null
          : encode(current.result)
    const finishedAt =
      patch.finishedAt !== undefined
        ? patch.finishedAt
        : ACTIVE_RUN_STATUSES.includes(status)
          ? null
          : now()
    db.prepare(`
      UPDATE plugin_run
      SET status = ?, result = ?, finished_at = ?
      WHERE run_id = ?
    `).run(status, result, finishedAt, runId)
    return getRun(runId)
  }

  function listRuns({ pluginId, taskKey = null, limit = 50 } = {}) {
    const rows = taskKey
      ? db
          .prepare(`
          SELECT *
          FROM plugin_run
          WHERE plugin_id = ? AND task_key = ?
          ORDER BY started_at DESC, run_id DESC
          LIMIT ?
        `)
          .all(pluginId, taskKey, Math.max(1, Math.min(500, Number(limit) || 50)))
      : db
          .prepare(`
          SELECT *
          FROM plugin_run
          WHERE plugin_id = ?
          ORDER BY started_at DESC, run_id DESC
          LIMIT ?
        `)
          .all(pluginId, Math.max(1, Math.min(500, Number(limit) || 50)))
    return rows.map(toRun)
  }

  function findActiveRun(pluginId, taskKey) {
    const row = db
      .prepare(`
      SELECT *
      FROM plugin_run
      WHERE plugin_id = ? AND task_key = ? AND status IN ('queued', 'starting', 'running')
      ORDER BY started_at DESC
      LIMIT 1
    `)
      .get(pluginId, taskKey)
    return row ? toRun(row) : null
  }

  function nextAttempt(pluginId, taskKey) {
    const row = db
      .prepare(`
      SELECT COUNT(*) AS count
      FROM plugin_run
      WHERE plugin_id = ? AND task_key = ?
    `)
      .get(pluginId, taskKey)
    return Number(row?.count || 0) + 1
  }

  function failActiveRuns(pluginId, reason = '插件停止，run 已中断') {
    const at = now()
    const rows = db
      .prepare(`
      SELECT run_id
      FROM plugin_run
      WHERE plugin_id = ? AND status IN ('queued', 'starting', 'running')
    `)
      .all(pluginId)
    for (const row of rows) {
      db.prepare(`
        UPDATE plugin_run
        SET status = 'failed', result = ?, finished_at = ?
        WHERE run_id = ?
      `).run(encode({ error: reason }), at, row.run_id)
    }
    return rows.length
  }

  function failInterruptedRuns(reason = '宿主重启，run 已中断') {
    const at = now()
    return withTransaction(db, () => {
      const rows = db
        .prepare(`
        SELECT run_id
        FROM plugin_run
        WHERE status IN ('queued', 'starting', 'running')
      `)
        .all()
      for (const row of rows) {
        db.prepare(`
          UPDATE plugin_run
          SET status = 'failed', result = ?, finished_at = ?
          WHERE run_id = ?
        `).run(encode({ error: reason }), at, row.run_id)
      }
      return rows.length
    })
  }

  function toRun(row) {
    return {
      runId: row.run_id,
      pluginId: row.plugin_id,
      pluginVersion: row.plugin_version,
      taskKey: row.task_key,
      status: row.status,
      request: decode(row.request),
      result: decode(row.result),
      startedAt: row.started_at,
      finishedAt: row.finished_at,
    }
  }

  return {
    getState,
    setState,
    deleteState,
    listState,
    clearState,
    getManifest,
    setManifest,
    audit,
    listAudit,
    createRun,
    startRun,
    finishRun,
    failActiveRuns,
    getRun,
    updateRun,
    listRuns,
    findActiveRun,
    nextAttempt,
    failInterruptedRuns,
  }
}
