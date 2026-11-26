import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createTeamPluginHost } from '../team/plugins/host.js'
import {
  cleanupWorkspace,
  makePluginWorkspace,
  openPluginWorkspaceDatabase,
  seedTeamPluginFixtures,
} from '@trellis-board/test-support/team-plugin-fixtures.js'

function writePlugin(dir, id, { enabled = true } = {}) {
  const pluginDir = path.join(dir, id)
  fs.mkdirSync(pluginDir, { recursive: true })
  fs.writeFileSync(
    path.join(pluginDir, 'plugin.json'),
    JSON.stringify(
      {
        id,
        name: `${id} 展示名`,
        version: '1.0.0',
        apiVersion: 1,
        permissions: ['store'],
        userConfigFields: ['defaultProjectId'],
        engines: { board: '>=0.2.0' },
      },
      null,
      2,
    ),
  )
  fs.writeFileSync(path.join(pluginDir, 'index.js'), 'export default {}\n')
  return { pluginDir, enabled }
}

async function withHost(fn, { repositoriesProvider } = {}) {
  const workspace = makePluginWorkspace()
  const db = openPluginWorkspaceDatabase(workspace)
  const bundledDir = path.join(workspace.root, 'bundled')
  fs.mkdirSync(bundledDir, { recursive: true })
  const closeables = []
  try {
    await seedTeamPluginFixtures(db)
    writePlugin(bundledDir, 'witops-core')
    writePlugin(bundledDir, 'acp-dispatch')
    // 用户目录放同名插件时应覆盖内置实现。
    writePlugin(workspace.pluginsDir, 'witops-core')
    const host = createTeamPluginHost({
      db,
      appDir: bundledDir,
      dataDir: workspace.dataDir,
      pluginsDir: workspace.pluginsDir,
      bundledPluginsDir: bundledDir,
      hostVersion: '0.4.24',
      repositoriesProvider:
        repositoriesProvider ??
        (() => [{ id: 'project-a', name: '项目 A', path: '/tmp/project-a' }]),
      logger: { info() {}, warn() {}, error() {} },
    })
    closeables.push(host)
    await fn({ host, db, workspace, bundledDir })
  } finally {
    for (const item of closeables) await item.stop().catch(() => {})
    cleanupWorkspace(workspace, db)
  }
}

test('load 从 registry 建状态，默认只启用 witops-core', async () => {
  await withHost(async ({ host, workspace }) => {
    await host.load()
    assert.equal(host.supervisor.mode, 'team')
    const list = host.list()
    assert.deepEqual(
      list.map((plugin) => [plugin.id, plugin.enabled]),
      [
        ['acp-dispatch', false],
        ['witops-core', true],
      ],
    )
    const witops = host.find('witops-core')
    assert.equal(witops.state.status, 'stopped')
    assert.equal(
      witops.state.modulePath,
      path.join(workspace.pluginsDir, 'witops-core', 'index.js'),
    )
    assert.equal(host.supervisor.repositories.length, 1)
  })
})

test('核心 capability 读取 repositoriesProvider 的最新项目快照', async () => {
  let rows = [{ id: 'project-a', name: '项目 A', path: '/tmp/project-a' }]
  await withHost(
    async ({ host }) => {
      await host.load()
      const state = { manifest: { permissions: ['projects:read', 'repositories:read'] } }

      const first = await host.supervisor.coreCapabilities.call(
        state,
        'trellis.projects',
        'list',
        {},
      )
      assert.deepEqual(
        first.projects.map((item) => item.repositoryId),
        ['project-a'],
      )

      // 模拟 team 宿主在重扫时整体替换 repositories 快照。
      rows = [...rows, { id: 'project-b', name: '项目 B', path: '/tmp/project-b' }]
      await host.load()

      const listed = await host.supervisor.coreCapabilities.call(
        state,
        'trellis.projects',
        'list',
        {},
      )
      assert.deepEqual(
        listed.projects.map((item) => item.repositoryId),
        ['project-a', 'project-b'],
      )

      const repositories = await host.supervisor.coreCapabilities.call(
        state,
        'trellis.repositories',
        'list',
        {},
      )
      assert.deepEqual(
        repositories.repositories.map((item) => item.id),
        ['project-a', 'project-b'],
      )

      const current = await host.supervisor.coreCapabilities.call(
        state,
        'trellis.projects',
        'current',
        { repositoryId: 'project-b' },
      )
      assert.equal(current.project.repositoryId, 'project-b')
    },
    { repositoriesProvider: () => rows },
  )
})

test('enabled 开关持久化，重扫不覆盖管理员决定', async () => {
  await withHost(async ({ host, db }) => {
    await host.load()
    await host.setEnabled('acp-dispatch', true)
    assert.equal(
      db.prepare('SELECT enabled FROM plugin_registry WHERE plugin_id = ?').get('acp-dispatch')
        .enabled,
      1,
    )
    await host.rescan()
    assert.equal(host.list().find((plugin) => plugin.id === 'acp-dispatch').enabled, true)
  })
})

test('team 模式拒绝热重载', async () => {
  await withHost(async ({ host }) => {
    await host.load()
    await assert.rejects(
      () => host.supervisor.reloadConfig({ reason: 'manual' }),
      (error) => error.httpStatus === 409,
    )
  })
})

test('team 模式下插件回调必须带有效 actorRef', async () => {
  await withHost(async ({ host }) => {
    await host.load()
    const state = host.supervisor.plugins.get('witops-core')
    assert.throws(
      () => host.supervisor.requireActor(state, {}),
      (error) => error.code === 1001,
    )
    const payload = host.actors.issue({
      actor: { userId: 'u-1', user: { displayName: '张三' }, teams: [] },
      pluginId: 'witops-core',
    })
    assert.equal(host.supervisor.requireActor(state, { actorRef: payload.ref }).userId, 'u-1')
    // 绑定的是 state.id：拿另一个插件签发的 ref 也必须被拒。
    const other = host.actors.issue({
      actor: { userId: 'u-1', user: { displayName: '张三' }, teams: [] },
      pluginId: 'acp-dispatch',
    })
    assert.throws(
      () => host.supervisor.requireActor(state, { actorRef: other.ref }),
      (error) => error.code === 1001,
    )
  })
})

test('team 模式下 store 写入带用户前缀', async () => {
  await withHost(async ({ host }) => {
    await host.load()
    const state = host.supervisor.plugins.get('witops-core')
    const payload = host.actors.issue({
      actor: { userId: 'u-1', user: { displayName: '张三' }, teams: [] },
      pluginId: 'witops-core',
    })
    const scope = host.supervisor.storeScope(state, { actorRef: payload.ref })
    assert.equal(scope.key('lastProject'), 'user:u-1:lastProject')
  })
})

test('pluginAllowlist 之外的插件不登记，并清掉残留登记', async () => {
  const workspace = makePluginWorkspace()
  const db = openPluginWorkspaceDatabase(workspace)
  const bundledDir = path.join(workspace.root, 'bundled')
  fs.mkdirSync(bundledDir, { recursive: true })
  const logger = { info() {}, warn() {}, error() {} }
  try {
    await seedTeamPluginFixtures(db)
    writePlugin(bundledDir, 'witops-core')
    writePlugin(bundledDir, 'acp-dispatch')
    const base = {
      db,
      appDir: bundledDir,
      dataDir: workspace.dataDir,
      pluginsDir: workspace.pluginsDir,
      bundledPluginsDir: bundledDir,
      hostVersion: '0.4.24',
      logger,
    }
    // 先不带白名单装一次：两个插件都进登记表。
    const wide = createTeamPluginHost(base)
    const first = await wide.load()
    assert.deepEqual(first.inserted.sort(), ['acp-dispatch', 'witops-core'])
    await wide.stop()

    // 再带白名单装：acp-dispatch 的登记行应该被清掉。
    const narrow = createTeamPluginHost({ ...base, pluginAllowlist: ['witops-core'] })
    const result = await narrow.load()
    assert.deepEqual(
      narrow.list().map((plugin) => plugin.id),
      ['witops-core'],
    )
    assert.deepEqual(result.pruned, ['acp-dispatch'])
    assert.deepEqual(result.skipped, ['acp-dispatch'])
    await narrow.stop()
  } finally {
    cleanupWorkspace(workspace, db)
  }
})
