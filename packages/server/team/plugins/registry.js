import fs from 'node:fs'
import path from 'node:path'
import { HOST_API_VERSION } from '../../plugins/protocol.js'
import { validateManifest } from '../../plugins/version.js'

/**
 * team 模式的插件登记层。
 *
 * 插件代码只来自安装目录 `plugins/<id>/`，数据库里的 `plugin_registry` 记录"装了哪些、是否启用"。
 * 与 standalone 的 `plugins.json` 不同：team 不读该文件，也不允许通过配置文件覆盖启用状态。
 */

export const DEFAULT_ENABLED_PLUGINS = Object.freeze(['witops-core'])

const PLUGIN_DIR_PATTERN = /^[a-z0-9][a-z0-9-]*$/

function readManifest(file) {
  try {
    return { ok: true, manifest: JSON.parse(fs.readFileSync(file, 'utf8')) }
  } catch (error) {
    return { ok: false, reason: `invalid-manifest: ${error.message}` }
  }
}

/**
 * 扫描 `<pluginsDir>/<id>/plugin.json`。
 * 非法 manifest、目录名与 id 不一致、缺少入口时只记 warning，不阻断服务启动。
 */
export function discoverPlugins({ pluginsDir, hostVersion, hostApiVersion = HOST_API_VERSION }) {
  const plugins = []
  const warnings = []
  const dirs = (Array.isArray(pluginsDir) ? pluginsDir : [pluginsDir]).filter(Boolean)
  const seen = new Set()
  for (const dir of dirs) {
    const scanned = scanOne({ pluginsDir: dir, hostVersion, hostApiVersion })
    warnings.push(...scanned.warnings)
    for (const plugin of scanned.plugins) {
      if (seen.has(plugin.id)) continue
      seen.add(plugin.id)
      plugins.push(plugin)
    }
  }
  return { plugins, warnings }
}

/** 扫描单个目录；同 id 由调用方按目录顺序去重（先扫到的优先）。 */
function scanOne({ pluginsDir, hostVersion, hostApiVersion }) {
  const plugins = []
  const warnings = []
  if (!fs.existsSync(pluginsDir)) {
    return { plugins, warnings }
  }
  for (const entry of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (!PLUGIN_DIR_PATTERN.test(entry.name)) {
      warnings.push({ dir: entry.name, reason: 'invalid-directory-name' })
      continue
    }
    const sourcePath = path.join(pluginsDir, entry.name)
    const manifestFile = path.join(sourcePath, 'plugin.json')
    if (!fs.existsSync(manifestFile)) continue
    let manifest
    const read = readManifest(manifestFile)
    if (!read.ok) {
      warnings.push({ dir: entry.name, reason: read.reason })
      continue
    }
    manifest = read.manifest
    const validation = validateManifest(manifest, {
      configId: entry.name,
      hostVersion,
      hostApiVersion,
    })
    if (!validation.ok) {
      warnings.push({ dir: entry.name, reason: validation.reason })
      continue
    }
    const modulePath = resolveModulePath({ manifest, sourcePath })
    if (!modulePath) {
      warnings.push({ dir: entry.name, reason: 'missing-entry' })
      continue
    }
    plugins.push({
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      apiVersion: manifest.apiVersion,
      description: manifest.description ?? '',
      modulePath,
      sourcePath,
      manifest,
      config: manifest.config && typeof manifest.config === 'object' ? manifest.config : {},
      userConfigFields: Array.isArray(manifest.userConfigFields) ? manifest.userConfigFields : [],
    })
  }
  return { plugins, warnings }
}

/**
 * 与 supervisor 的入口解析保持一致：`module` 缺省时用 `<sourcePath>/index.js`。
 * 返回绝对路径，文件不存在时返回 null（由 supervisor 报 `missing-entry`）。
 */
export function resolveModulePath({ manifest, sourcePath }) {
  const raw =
    typeof manifest.module === 'string' && manifest.module.trim()
      ? manifest.module.trim()
      : './index.js'
  const candidate = path.isAbsolute(raw) ? raw : path.resolve(sourcePath, raw)
  return fs.existsSync(candidate) ? candidate : null
}

function parseManifest(value) {
  try {
    return JSON.parse(value)
  } catch {
    return {}
  }
}

function rowToPlugin(row) {
  if (!row) return null
  return {
    id: row.plugin_id,
    name: row.name,
    version: row.version,
    apiVersion: row.api_version,
    description: row.description,
    manifest: parseManifest(row.manifest_json),
    sourcePath: row.source_path,
    enabled: Boolean(row.enabled),
    scope: row.default_scope,
    discoveredAt: row.discovered_at,
    updatedAt: row.updated_at,
  }
}

/**
 * 把扫描结果写进 registry。
 *
 * - 已有行只更新 manifest 快照与版本，**不覆盖 enabled**（管理员关掉的插件不能因为重启又打开）；
 * - 新行按 DEFAULT_ENABLED_PLUGINS 决定初始 enabled；
 * - 目录已被删除的插件保留数据库行（避免丢配置），只在返回值里报告。
 */
export function syncRegistry(db, discovered, { now = () => new Date().toISOString() } = {}) {
  const stamp = now()
  const inserted = []
  const updated = []
  const upsert = db.prepare(`
    INSERT INTO plugin_registry(
      plugin_id, name, version, api_version, description,
      manifest_json, source_path, enabled, default_scope, discovered_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'user', ?, ?)
    ON CONFLICT(plugin_id) DO UPDATE SET
      name = excluded.name,
      version = excluded.version,
      api_version = excluded.api_version,
      description = excluded.description,
      manifest_json = excluded.manifest_json,
      source_path = excluded.source_path,
      updated_at = excluded.updated_at
  `)
  const existing = new Set(
    db
      .prepare('SELECT plugin_id FROM plugin_registry')
      .all()
      .map((row) => row.plugin_id),
  )
  for (const plugin of discovered) {
    const enabled = DEFAULT_ENABLED_PLUGINS.includes(plugin.id) ? 1 : 0
    upsert.run(
      plugin.id,
      plugin.name,
      plugin.version,
      plugin.apiVersion,
      plugin.description,
      JSON.stringify(plugin.manifest),
      plugin.sourcePath,
      enabled,
      stamp,
      stamp,
    )
    if (existing.has(plugin.id)) updated.push(plugin.id)
    else inserted.push(plugin.id)
  }
  const seen = new Set(discovered.map((plugin) => plugin.id))
  const removed = [...existing].filter((id) => !seen.has(id))
  return { inserted, updated, removed }
}

export function listRegistry(db) {
  return db.prepare('SELECT * FROM plugin_registry ORDER BY plugin_id').all().map(rowToPlugin)
}

export function readPlugin(db, pluginId) {
  return rowToPlugin(
    db.prepare('SELECT * FROM plugin_registry WHERE plugin_id = ?').get(String(pluginId)),
  )
}

export function setRegistryEnabled(
  db,
  pluginId,
  enabled,
  { now = () => new Date().toISOString() } = {},
) {
  const result = db
    .prepare('UPDATE plugin_registry SET enabled = ?, updated_at = ? WHERE plugin_id = ?')
    .run(enabled ? 1 : 0, now(), String(pluginId))
  if (result.changes === 0) return null
  return readPlugin(db, pluginId)
}

/**
 * 团队版只跑白名单里的插件。不在白名单里的登记行连同团队配置、用户配置、项目绑定一起清掉，
 * 免得管理页出现"看得见但永远不能启用"的残留。
 *
 * 历史 run / audit 不删：那是审计记录，删了等于抹掉证据。
 */
export function pruneRegistry(db, keepIds) {
  const keep = new Set(keepIds)
  const rows = db.prepare('SELECT plugin_id FROM plugin_registry').all()
  const removed = []
  for (const row of rows) {
    if (keep.has(row.plugin_id)) continue
    db.prepare('DELETE FROM plugin_team_setting WHERE plugin_id = ?').run(row.plugin_id)
    db.prepare('DELETE FROM plugin_user_config WHERE plugin_id = ?').run(row.plugin_id)
    db.prepare('DELETE FROM plugin_project_binding WHERE plugin_id = ?').run(row.plugin_id)
    db.prepare('DELETE FROM plugin_registry WHERE plugin_id = ?').run(row.plugin_id)
    removed.push(row.plugin_id)
  }
  return removed
}
