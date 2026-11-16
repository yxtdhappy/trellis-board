import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { resolveBoardRootDir, resolvePluginsDir } from '../config.js'
import { createPluginRuntime } from '../plugins/runtime.js'
import { appDir, createHarness, fixtureModule } from '@trellis-board/test-support/plugin-runtime.js'

test('插件目录按平台默认值落在 TrellisBoard/plugins', () => {
  assert.equal(
    resolvePluginsDir({ platform: 'linux', env: {}, homeDir: '/home/alice' }),
    '/home/alice/.local/share/TrellisBoard/plugins',
  )
  assert.equal(
    resolvePluginsDir({
      platform: 'linux',
      env: { XDG_DATA_HOME: '/var/data/alice' },
      homeDir: '/home/alice',
    }),
    '/var/data/alice/TrellisBoard/plugins',
  )
  assert.equal(
    resolvePluginsDir({ platform: 'darwin', env: {}, homeDir: '/Users/alice' }),
    '/Users/alice/Library/Application Support/TrellisBoard/plugins',
  )
  assert.equal(
    resolvePluginsDir({
      platform: 'win32',
      env: { LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local' },
      homeDir: 'C:\\Users\\alice',
    }),
    'C:\\Users\\alice\\AppData\\Local\\TrellisBoard\\plugins',
  )
  assert.equal(
    resolveBoardRootDir({ platform: 'linux', env: {}, homeDir: '/home/alice' }),
    '/home/alice/.local/share/TrellisBoard',
  )
})

test('TRELLIS_BOARD_PLUGINS_DIR 优先，显式数据目录退化到 <dataDir>/plugins', () => {
  assert.equal(
    resolvePluginsDir({
      platform: 'linux',
      env: { TRELLIS_BOARD_PLUGINS_DIR: '/srv/trellis-plugins' },
      homeDir: '/home/alice',
    }),
    '/srv/trellis-plugins',
  )
  assert.equal(
    resolvePluginsDir({
      platform: 'linux',
      env: { TRELLIS_BOARD_DATA_DIR: '/srv/trellis-board' },
      homeDir: '/home/alice',
    }),
    '/srv/trellis-board/plugins',
  )
})

test('插件配置、secrets 密钥与日志默认位于插件目录', async () => {
  const harness = await createHarness({
    plugins: [{ id: 'echo', module: fixtureModule('echo'), enabled: true, config: {} }],
  })
  try {
    const runtime = createPluginRuntime({
      db: harness.db,
      appDir,
      dataDir: harness.workspace.dataDir,
      pluginsDir: harness.workspace.pluginsDir,
      hostVersion: '0.1.0',
      repositories: harness.workspace.repositories,
      boardProvider: () => null,
      store: harness.store,
      tasks: harness.tasks,
      env: {},
      logger: { error() {}, warn() {}, log() {} },
    })
    const { supervisor } = runtime
    assert.equal(supervisor.configFile, path.join(harness.workspace.pluginsDir, 'plugins.json'))
    assert.equal(
      supervisor.secretsFile,
      path.join(harness.workspace.pluginsDir, 'plugins.secrets.json'),
    )
    assert.equal(
      supervisor.secretsKeyFile,
      path.join(harness.workspace.pluginsDir, 'plugins.secrets.key'),
    )
    assert.equal(supervisor.logDir, path.join(harness.workspace.pluginsDir, 'logs'))
    assert.equal(
      harness.supervisor.plugins.get('echo').logFile,
      path.join(harness.workspace.pluginsDir, 'logs', 'echo.log'),
    )
  } finally {
    await harness.cleanup()
  }
})

test('用户插件目录优先于安装目录，绝对路径保持原样', async () => {
  const harness = await createHarness({ plugins: [], start: false })
  try {
    const entry = { id: 'echo', module: './plugins/echo/index.js' }
    assert.equal(
      harness.supervisor.resolveModule(entry),
      path.resolve(appDir, './plugins/echo/index.js'),
    )

    const userDir = path.join(harness.workspace.pluginsDir, 'echo')
    fs.mkdirSync(userDir, { recursive: true })
    fs.writeFileSync(path.join(userDir, 'index.js'), 'export default {}\n')
    // 只有入口没有 plugin.json 时仍回退安装目录。
    assert.equal(
      harness.supervisor.resolveModule(entry),
      path.resolve(appDir, './plugins/echo/index.js'),
    )
    fs.writeFileSync(path.join(userDir, 'plugin.json'), JSON.stringify({ id: 'echo' }))
    assert.equal(harness.supervisor.resolveModule(entry), path.join(userDir, 'index.js'))

    // 子路径与默认入口保持同一映射规则。
    fs.mkdirSync(path.join(userDir, 'dist'), { recursive: true })
    fs.writeFileSync(path.join(userDir, 'dist', 'main.js'), 'export default {}\n')
    fs.writeFileSync(path.join(userDir, 'dist', 'plugin.json'), JSON.stringify({ id: 'echo' }))
    assert.equal(
      harness.supervisor.resolveModule({ id: 'echo', module: './plugins/echo/dist/main.js' }),
      path.join(userDir, 'dist', 'main.js'),
    )

    const absolute = path.join(harness.workspace.root, 'abs-plugin.js')
    assert.equal(harness.supervisor.resolveModule({ id: 'echo', module: absolute }), absolute)

    // 不允许从 module 里跳出插件目录。
    assert.equal(
      harness.supervisor.resolveModule({ id: 'echo', module: './plugins/echo/../../../escape.js' }),
      path.resolve(appDir, './plugins/echo/../../../escape.js'),
    )
  } finally {
    await harness.cleanup()
  }
})
