import { ERROR_CODES, teamError } from '../errors.js'

/**
 * team 插件配置存取层。
 *
 * 只存**非敏感偏好**（默认项目、上次选中、筛选、视图）。第三方账号密码与 token 一律不落库，
 * 见 `.trellis/tasks/11-16-team-plugin-core/design.md` §11 D2。
 */

const MAX_CONFIG_BYTES = 8 * 1024

function parseJson(value, fallback) {
  if (typeof value !== 'string' || !value) return fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function assertPlainObject(value, label) {
  if (value == null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, `${label}必须是对象`)
  }
  return value
}

function assertAllowedFields(config, fields, label) {
  const allowed = new Set(fields ?? [])
  for (const key of Object.keys(config)) {
    if (!allowed.has(key)) {
      throw teamError(400, ERROR_CODES.INVALID_INPUT, `${label}不支持字段: ${key}`)
    }
  }
}

function assertSerializableSize(value, label) {
  let text
  try {
    text = JSON.stringify(value)
  } catch {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, `${label}无法序列化`)
  }
  if (text === undefined) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, `${label}无法序列化`)
  }
  if (text.length > MAX_CONFIG_BYTES) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, `${label}超过 ${MAX_CONFIG_BYTES} 字节`)
  }
  return text
}

function teamRowToSetting(row) {
  if (!row) return null
  return {
    teamId: row.team_id,
    pluginId: row.plugin_id,
    enabled: Boolean(row.enabled),
    config: parseJson(row.config_json, {}),
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  }
}

function userRowToConfig(row) {
  if (!row)
    return {
      config: {},
      status: 'unconfigured',
      lastError: null,
      updatedAt: null,
    }
  return {
    config: parseJson(row.config_json, {}),
    status: row.status,
    lastError: row.last_error,
    updatedAt: row.updated_at,
  }
}

export function createPluginSettings({ db, now = () => new Date().toISOString() }) {
  function getTeamSetting(teamId, pluginId) {
    return teamRowToSetting(
      db
        .prepare('SELECT * FROM plugin_team_setting WHERE team_id = ? AND plugin_id = ?')
        .get(String(teamId), String(pluginId)),
    )
  }

  function setTeamSetting({
    teamId,
    pluginId,
    enabled,
    config,
    actorUserId = null,
    fields = null,
  }) {
    const nextConfig = assertPlainObject(config, '团队插件配置')
    if (fields) assertAllowedFields(nextConfig, fields, '团队插件配置')
    const configJson = assertSerializableSize(nextConfig, '团队插件配置')
    const stamp = now()
    db.prepare(
      `
      INSERT INTO plugin_team_setting(
        team_id, plugin_id, enabled, config_json, updated_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(team_id, plugin_id) DO UPDATE SET
        enabled = excluded.enabled,
        config_json = excluded.config_json,
        updated_by = excluded.updated_by,
        updated_at = excluded.updated_at
    `,
    ).run(String(teamId), String(pluginId), enabled ? 1 : 0, configJson, actorUserId, stamp, stamp)
    return getTeamSetting(teamId, pluginId)
  }

  function getUserConfig(userId, pluginId) {
    return userRowToConfig(
      db
        .prepare('SELECT * FROM plugin_user_config WHERE user_id = ? AND plugin_id = ?')
        .get(String(userId), String(pluginId)),
    )
  }

  /**
   * 只允许写 manifest `userConfigFields` 声明的字段；未声明的插件只接受空对象。
   * `status` 由调用方（插件会话状态）决定，这里只在显式传入时更新。
   */
  function setUserConfig({
    userId,
    pluginId,
    config,
    fields = [],
    status = null,
    lastError = null,
  }) {
    const nextConfig = assertPlainObject(config, '插件配置')
    assertAllowedFields(nextConfig, fields, '插件配置')
    const configJson = assertSerializableSize(nextConfig, '插件配置')
    const current = getUserConfig(userId, pluginId)
    const nextStatus = status ?? current.status
    if (!['unconfigured', 'active', 'invalid'].includes(nextStatus)) {
      throw teamError(400, ERROR_CODES.INVALID_INPUT, '插件配置状态不合法')
    }
    db.prepare(
      `
      INSERT INTO plugin_user_config(user_id, plugin_id, config_json, status, last_error, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, plugin_id) DO UPDATE SET
        config_json = excluded.config_json,
        status = excluded.status,
        last_error = excluded.last_error,
        updated_at = excluded.updated_at
    `,
    ).run(String(userId), String(pluginId), configJson, nextStatus, lastError, now())
    return getUserConfig(userId, pluginId)
  }

  function setUserStatus({ userId, pluginId, status, lastError = null }) {
    if (!['unconfigured', 'active', 'invalid'].includes(status)) {
      throw teamError(400, ERROR_CODES.INVALID_INPUT, '插件配置状态不合法')
    }
    db.prepare(
      `
      INSERT INTO plugin_user_config(user_id, plugin_id, config_json, status, last_error, updated_at)
      VALUES (?, ?, '{}', ?, ?, ?)
      ON CONFLICT(user_id, plugin_id) DO UPDATE SET
        status = excluded.status,
        last_error = excluded.last_error,
        updated_at = excluded.updated_at
    `,
    ).run(String(userId), String(pluginId), status, lastError, now())
    return getUserConfig(userId, pluginId)
  }

  /**
   * 面板/管理页用：永远不返回 token、密码等敏感值。
   * `session` 由调用方从内存会话表合并进来（在线状态、最后登录时间、账号掩码）。
   */
  function describeUserPlugin(userId, pluginId, { session = null } = {}) {
    const row = getUserConfig(userId, pluginId)
    return {
      pluginId: String(pluginId),
      userId: String(userId),
      configured: row.status === 'active',
      status: row.status,
      lastError: row.lastError,
      updatedAt: row.updatedAt,
      config: row.config,
      online: Boolean(session),
      lastLoginAt: session?.createdAt ?? null,
      account: session?.account ?? null,
    }
  }

  function listTeamSettings(teamId) {
    return db
      .prepare('SELECT * FROM plugin_team_setting WHERE team_id = ? ORDER BY plugin_id')
      .all(String(teamId))
      .map(teamRowToSetting)
  }

  return {
    getTeamSetting,
    setTeamSetting,
    listTeamSettings,
    getUserConfig,
    setUserConfig,
    setUserStatus,
    describeUserPlugin,
  }
}
