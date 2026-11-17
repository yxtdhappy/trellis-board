import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  discoverPlugins,
  listRegistry,
  readPlugin,
  setRegistryEnabled,
  syncRegistry,
} from '../team/plugins/registry.js'
import {
  cleanupWorkspace,
  makePluginWorkspace,
  openPluginWorkspaceDatabase,
} from '@trellis-board/test-support/team-plugin-fixtures.js'

const HOST_VERSION = '0.4.24'

function writePlugin(workspace, id, { manifest = {}, entry = 'export default {}\n' } = {}) {
  const dir = path.join(workspace.pluginsDir, id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'plugin.json'),
    JSON.stringify(
      {
        id,
        name: `${id} 展示名`,
        description: '测试插件',
        version: '1.0.0',
        apiVersion: 1,
        engines: { board: '>=0.2.0' },
        permissions: [],
        ...manifest,
      },
      null,
      2,
    ),
  )
  fs.writeFileSync(path.join(dir, 'index.js'), entry)
  return dir
}

function withWorkspace(fn) {
  return async () => {
    const workspace = makePluginWorkspace()
    const db = openPluginWorkspaceDatabase(workspace)
    try {
      await fn({ workspace, db })
    } finally {
      cleanupWorkspace(workspace, db)
    }
  }
}

test(
  '首次发现只默认启用 witops-core，其余登记为 disabled',
  withWorkspace(({ workspace, db }) => {
    writePlugin(workspace, 'witops-core')
    writePlugin(workspace, 'acp-dispatch')
    const { plugins, warnings } = discoverPlugins({
      pluginsDir: workspace.pluginsDir,
      hostVersion: HOST_VERSION,
    })
    assert.equal(warnings.length, 0)
    assert.deepEqual(plugins.map((plugin) => plugin.id).sort(), ['acp-dispatch', 'witops-core'])

    const result = syncRegistry(db, plugins)
    assert.deepEqual(result.inserted.sort(), ['acp-dispatch', 'witops-core'])
    assert.deepEqual(result.updated, [])

    const registry = listRegistry(db)
    assert.equal(registry.find((plugin) => plugin.id === 'witops-core').enabled, true)
    assert.equal(registry.find((plugin) => plugin.id === 'acp-dispatch').enabled, false)
    assert.equal(registry.length, 2)
  }),
)

test(
  '重新扫描不会覆盖管理员改过的 enabled',
  withWorkspace(({ workspace, db }) => {
    writePlugin(workspace, 'witops-core')
    writePlugin(workspace, 'acp-dispatch')
    const discovered = discoverPlugins({
      pluginsDir: workspace.pluginsDir,
      hostVersion: HOST_VERSION,
    }).plugins
    syncRegistry(db, discovered)
    setRegistryEnabled(db, 'witops-core', false)
    setRegistryEnabled(db, 'acp-dispatch', true)

    const again = discoverPlugins({
      pluginsDir: workspace.pluginsDir,
      hostVersion: HOST_VERSION,
    }).plugins
    const result = syncRegistry(db, again)
    assert.deepEqual(result.updated.sort(), ['acp-dispatch', 'witops-core'])
    assert.equal(readPlugin(db, 'witops-core').enabled, false)
    assert.equal(readPlugin(db, 'acp-dispatch').enabled, true)
  }),
)

test(
  '非法 manifest 与目录名不一致只记 warning，不注册',
  withWorkspace(({ workspace, db }) => {
    writePlugin(workspace, 'good-plugin')
    writePlugin(workspace, 'bad-version', { manifest: { version: '1.0' } })
    writePlugin(workspace, 'wrong-id', { manifest: { id: 'other-id' } })
    fs.mkdirSync(path.join(workspace.pluginsDir, 'no-manifest'), {
      recursive: true,
    })

    const { plugins, warnings } = discoverPlugins({
      pluginsDir: workspace.pluginsDir,
      hostVersion: HOST_VERSION,
    })
    assert.deepEqual(
      plugins.map((plugin) => plugin.id),
      ['good-plugin'],
    )
    const reasons = Object.fromEntries(warnings.map((item) => [item.dir, item.reason]))
    assert.equal(reasons['bad-version'], 'invalid-version')
    assert.equal(reasons['wrong-id'], 'id-mismatch')
    assert.equal(reasons['no-manifest'], undefined)

    syncRegistry(db, plugins)
    assert.deepEqual(
      listRegistry(db).map((plugin) => plugin.id),
      ['good-plugin'],
    )
  }),
)

test(
  '目录被删除时保留数据库行，只在返回值里报告 removed',
  withWorkspace(({ workspace, db }) => {
    const dir = writePlugin(workspace, 'witops-core')
    writePlugin(workspace, 'acp-dispatch')
    syncRegistry(
      db,
      discoverPlugins({
        pluginsDir: workspace.pluginsDir,
        hostVersion: HOST_VERSION,
      }).plugins,
    )
    fs.rmSync(dir, { recursive: true, force: true })
    const result = syncRegistry(
      db,
      discoverPlugins({
        pluginsDir: workspace.pluginsDir,
        hostVersion: HOST_VERSION,
      }).plugins,
    )
    assert.deepEqual(result.removed, ['witops-core'])
    assert.equal(listRegistry(db).length, 2)
    assert.equal(readPlugin(db, 'witops-core').enabled, true)
  }),
)

test(
  '缺少入口文件时不注册',
  withWorkspace(({ workspace }) => {
    const dir = writePlugin(workspace, 'no-entry')
    fs.rmSync(path.join(dir, 'index.js'))
    const { plugins, warnings } = discoverPlugins({
      pluginsDir: workspace.pluginsDir,
      hostVersion: HOST_VERSION,
    })
    assert.equal(plugins.length, 0)
    assert.equal(warnings[0].reason, 'missing-entry')
  }),
)
