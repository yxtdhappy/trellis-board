import path from 'node:path'
import { createPluginStore } from '../../plugins/store.js'
import { PluginSupervisor } from '../../plugins/supervisor.js'
import { HOST_API_VERSION } from '../../plugins/protocol.js'
import { createActorContext } from './actors.js'
import { createPluginPolicy } from './policy.js'
import { createSessionStore } from './session.js'
import { createPluginSettings } from './settings.js'
import { createPluginBindings } from './bindings.js'
import {
  discoverPlugins,
  listRegistry,
  pruneRegistry,
  readPlugin,
  setRegistryEnabled,
  syncRegistry,
} from './registry.js'

/**
 * team 模式的插件宿主：把「数据库里的登记与开关」翻译成 supervisor 能吃的条目。
 *
 * 与 standalone 的区别只有三处：装载来源是 `plugin_registry` 而不是 `plugins.json`；
 * 每个请求都带 actor；凭据与用户偏好都走各自的存储，不碰 secrets 文件。
 */
export function createTeamPluginHost({
  db,
  appDir,
  dataDir,
  pluginsDir = path.join(dataDir, 'plugins'),
  bundledPluginsDir = null,
  repositoriesProvider = null,
  pluginAllowlist = null,
  hostVersion,
  repositories = [],
  repositoryService = null,
  tasks = null,
  logger = console,
  env = process.env,
  spawnImpl,
  restartDelaysMs,
  healthIntervalMs,
  timeoutOverrides,
  autoDisableLimit,
  now,
}) {
  const store = createPluginStore({ db })
  const settings = createPluginSettings({ db, now })
  const bindings = createPluginBindings({ db, now })
  const sessions = createSessionStore({
    db,
    audit: (pluginId, kind, detail) => {
      try {
        db.prepare(
          'INSERT INTO plugin_audit(plugin_id, kind, detail, created_at) VALUES (?, ?, ?, ?)',
        ).run(pluginId, kind, JSON.stringify(detail), new Date().toISOString())
      } catch (error) {
        logger.warn?.('插件审计写入失败', {
          pluginId,
          kind,
          error: error.message,
        })
      }
    },
  })
  const actors = createActorContext({ db })
  const policy = createPluginPolicy({ db })

  const supervisor = new PluginSupervisor({
    db,
    appDir,
    dataDir,
    pluginsDir,
    hostVersion,
    repositories,
    repositoryService,
    tasks,
    store,
    configFile: path.join(pluginsDir, 'plugins.json'),
    spawnImpl,
    restartDelaysMs,
    healthIntervalMs,
    timeoutOverrides,
    autoDisableLimit,
    logger,
    env,
    now,
    mode: 'team',
    actorContext: actors,
    userConfigProvider: (userId, pluginId) => settings.getUserConfig(userId, pluginId).config,
    sessionResolver: (userId, pluginId) => sessions.entryOf(userId, pluginId),
  })

  /** 扫描目录并同步登记表；已登记的 enabled 由管理员控制，重扫不覆盖。 */
  function scan() {
    const dirs = [pluginsDir, bundledPluginsDir].filter(Boolean)
    const { plugins: discovered, warnings } = discoverPlugins({
      pluginsDir: dirs.length > 1 ? dirs : dirs[0],
      hostVersion,
      hostApiVersion: HOST_API_VERSION,
    })
    for (const warning of warnings) {
      logger.warn?.('跳过插件目录', warning)
    }
    // team 只装载白名单内的插件；其余即使装在 plugins/ 下也不登记、不显示。
    const allowed = pluginAllowlist ? new Set(pluginAllowlist) : null
    const plugins = allowed ? discovered.filter((plugin) => allowed.has(plugin.id)) : discovered
    const skipped = allowed
      ? discovered.filter((plugin) => !allowed.has(plugin.id)).map((plugin) => plugin.id)
      : []
    if (skipped.length) {
      logger.info?.('团队版跳过不在白名单里的插件', { skipped })
    }
    const result = syncRegistry(db, plugins)
    const pruned = allowed ? pruneRegistry(db, plugins.map((plugin) => plugin.id)) : []
    return { ...result, discovered: plugins, warnings, skipped, pruned }
  }

  /**
   * team 只有一个插件进程，所以团队级配置必须先合成一份：
   * manifest 默认值 → 各团队 enabled 设置的覆盖（后写入者优先，冲突记 warning）。
   * 真正的"每个团队一份进程"是后续任务，不在这里假装支持。
   */
  function mergedTeamConfig(plugin) {
    const merged = { ...(plugin.manifest?.config ?? {}) }
    const rows = db
      .prepare(`
      SELECT team_id, config_json
      FROM plugin_team_setting
      WHERE plugin_id = ? AND enabled = 1
      ORDER BY updated_at, team_id
    `)
      .all(plugin.id)
    for (const row of rows) {
      let parsed = {}
      try {
        parsed = JSON.parse(row.config_json) ?? {}
      } catch {
        continue
      }
      for (const [key, value] of Object.entries(parsed)) {
        if (key in merged && JSON.stringify(merged[key]) !== JSON.stringify(value)) {
          logger.warn?.('团队插件配置冲突，后写入者优先', {
            pluginId: plugin.id,
            teamId: row.team_id,
            key,
          })
        }
        merged[key] = value
      }
    }
    return merged
  }

  function entriesOf() {
    return listRegistry(db).map((plugin) => ({
      id: plugin.id,
      enabled: plugin.enabled,
      config: mergedTeamConfig(plugin),
      module: path.join(plugin.sourcePath, 'index.js'),
      allowMissingSecrets: true,
      configSource: 'registry',
    }))
  }

  async function load() {
    // 把扫描结果一起带回去：调用方（管理页/测试）需要 inserted/pruned/skipped 这些字段。
    const scanned = scan()
    if (repositoriesProvider) supervisor.repositories = repositoriesProvider()
    const loaded = await supervisor.loadFromEntries(entriesOf())
    return { ...scanned, ...loaded }
  }

  async function start() {
    await load()
    store.failInterruptedRuns()
    const started = await supervisor.start()
    return { plugins: list(), started: started.map((item) => item.id ?? item) }
  }

  async function stop() {
    await supervisor.stop()
    sessions.stop()
    actors.stop()
  }

  /**
   * 重扫目录：新插件默认停用，删除的目录保留登记行（enabled 不变）。
   * 先停掉正在跑的进程再重建状态，避免旧子进程变成孤儿。
   */
  async function rescan() {
    const running = [...supervisor.plugins.values()]
      .filter((state) => state.status === 'running')
      .map((state) => state.id)
    for (const id of running) {
      await supervisor.stopPlugin(id).catch(() => {})
    }
    const result = scan()
    if (repositoriesProvider) supervisor.repositories = repositoriesProvider()
    await supervisor.loadFromEntries(entriesOf())
    for (const plugin of listRegistry(db)) {
      if (!plugin.enabled) continue
      await supervisor.startPlugin(plugin.id).catch((error) => {
        logger.warn?.('插件重启失败', { pluginId: plugin.id, error: error.message })
      })
    }
    return { ...result, plugins: list() }
  }

  function list() {
    const runtime = new Map(supervisor.list().map((item) => [item.id, item]))
    return listRegistry(db).map((plugin) => {
      const state = runtime.get(plugin.id)
      return {
        id: plugin.id,
        name: state?.name ?? plugin.name,
        version: state?.version ?? plugin.version,
        apiVersion: state?.apiVersion ?? plugin.apiVersion,
        description: plugin.description,
        enabled: plugin.enabled,
        status: state?.status ?? 'stopped',
        compatible: state?.compatible ?? false,
        reason: state?.reason ?? null,
        lastError: state?.lastError ?? null,
        permissions: state?.permissions ?? [],
        panels: state?.panels ?? [],
        userConfigFields: plugin.userConfigFields ?? [],
        onlineCount: sessions.listOnline({ pluginId: plugin.id }).length,
        updatedAt: plugin.updatedAt,
      }
    })
  }

  function find(pluginId) {
    const plugin = readPlugin(db, pluginId)
    const state = supervisor.plugins.get(pluginId) ?? null
    return { plugin, state }
  }

  async function setEnabled(pluginId, enabled, { actorUserId = null, teamId = null } = {}) {
    const { plugin } = find(pluginId)
    if (!plugin) return null
    const updated = setRegistryEnabled(db, pluginId, enabled)
    if (enabled) {
      await supervisor.startPlugin(pluginId)
    } else {
      await supervisor.stopPlugin(pluginId, { reason: 'admin' })
    }
    audit({
      pluginId,
      kind: enabled ? 'plugin.enable' : 'plugin.disable',
      detail: { enabled },
      userId: actorUserId,
      teamId,
    })
    return updated
  }

  /**
   * 插件审计：与 standalone 的 `store.audit` 共用 plugin_audit 表，但把操作人与团队落到
   * user_id / team_id 两列（schema v13 加的列，见 design.md §2.5），团队管理员才能按团队回放。
   */
  function audit({ pluginId, kind, detail = null, userId = null, teamId = null }) {
    try {
      db.prepare(`
        INSERT INTO plugin_audit(plugin_id, kind, detail, created_at, user_id, team_id)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        pluginId,
        kind,
        detail == null ? null : JSON.stringify(detail),
        new Date().toISOString(),
        userId,
        teamId,
      )
    } catch (error) {
      logger.warn?.('插件审计写入失败', { pluginId, kind, error: error.message })
    }
  }

  /** 传给 `teamId` 时只回放该团队的动作；不传则回放所有团队（系统管理员视角）。 */
  function listAudit(pluginId, { teamId = null, limit = 100 } = {}) {
    const rows = db
      .prepare(`
      SELECT id, plugin_id, kind, detail, created_at, user_id, team_id
      FROM plugin_audit
      WHERE plugin_id = ? AND (? IS NULL OR team_id = ?)
      ORDER BY id DESC
      LIMIT ?
    `)
      .all(pluginId, teamId, teamId, Math.max(1, Math.min(500, Number(limit) || 100)))
    return rows.map((row) => {
      let detail = null
      try {
        detail = row.detail == null ? null : JSON.parse(row.detail)
      } catch {
        detail = row.detail
      }
      return {
        id: row.id,
        pluginId: row.plugin_id,
        kind: row.kind,
        detail,
        createdAt: row.created_at,
        userId: row.user_id ?? null,
        teamId: row.team_id ?? null,
      }
    })
  }

  return {
    db,
    supervisor,
    store,
    settings,
    bindings,
    sessions,
    actors,
    policy,
    load,
    start,
    stop,
    rescan,
    scan,
    list,
    find,
    setEnabled,
    audit,
    listAudit,
    forwardHttp: (...args) => supervisor.forwardHttp(...args),
  }
}
