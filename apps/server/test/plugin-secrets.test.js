import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadPluginConfigFile } from '../plugins/supervisor.js'
import { loadSecretsFile } from '../plugins/secrets.js'
import { createHarness, fixtureModule, startHttpServer } from '../../../packages/test-support/plugin-runtime.js'

function makeConfig(plugins, secrets) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-secrets-'))
  const dataDir = path.join(root, 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  const configFile = path.join(dataDir, 'plugins.json')
  fs.writeFileSync(configFile, JSON.stringify({ plugins }, null, 2))
  let secretsFile = null
  if (secrets) {
    secretsFile = path.join(dataDir, 'plugins.secrets.json')
    fs.writeFileSync(secretsFile, JSON.stringify(secrets, null, 2), { mode: 0o600 })
    if (process.platform !== 'win32') fs.chmodSync(secretsFile, 0o600)
  }
  return { root, dataDir, configFile, secretsFile }
}

test('secret 引用从独立文件解析并标记来源', () => {
  const workspace = makeConfig(
    [{ id: 'echo', config: { credentials: { mode: 'token', token: 'secret:echo/token' } } }],
    { version: 1, refs: { 'echo/token': 'super-secret' } },
  )
  try {
    const result = loadPluginConfigFile(workspace.configFile, { env: {} })
    assert.equal(result.plugins[0].config.credentials.token, 'super-secret')
    assert.equal(result.plugins[0].configSource, 'secret')
    assert.deepEqual(result.missing, [{ id: 'echo', names: [] }])
    assert.equal(result.warnings.length, 0)
  } finally {
    fs.rmSync(workspace.root, { recursive: true, force: true })
  }
})

test('env 引用仍可用并标记来源', () => {
  const workspace = makeConfig([{ id: 'echo', config: { token: 'env:ECHO_TOKEN' } }])
  try {
    const result = loadPluginConfigFile(workspace.configFile, {
      env: { ECHO_TOKEN: 'from-env' },
    })
    assert.equal(result.plugins[0].config.token, 'from-env')
    assert.equal(result.plugins[0].configSource, 'env')
  } finally {
    fs.rmSync(workspace.root, { recursive: true, force: true })
  }
})

test('缺失 secret 让插件停在 missing-secret，不启动进程', async () => {
  const harness = await createHarness({
    plugins: [
      {
        id: 'echo',
        module: fixtureModule('echo'),
        enabled: true,
        config: { token: 'secret:echo/token' },
      },
    ],
    secrets: { version: 1, refs: {} },
  })
  try {
    const state = harness.supervisor.plugins.get('echo')
    assert.equal(state.status, 'missing-secret')
    assert.equal(state.pid, null)
    assert.match(state.lastError, /secret:echo\/token/)
  } finally {
    await harness.cleanup()
  }
})

test('allowMissingSecrets 让插件带空值启动并只告警', async () => {
  const harness = await createHarness({
    plugins: [
      {
        id: 'echo',
        module: fixtureModule('echo'),
        enabled: true,
        allowMissingSecrets: true,
        config: { token: 'secret:echo/token' },
      },
    ],
    secrets: { version: 1, refs: {} },
  })
  try {
    const state = harness.supervisor.plugins.get('echo')
    assert.notEqual(state.status, 'missing-secret')
    assert.equal(state.config.token, null)
    assert.match(state.lastWarning, /secret:echo\/token/)
  } finally {
    await harness.cleanup()
  }
})

test('明文敏感值允许加载但产生告警', () => {
  const workspace = makeConfig([
    {
      id: 'echo',
      config: { credentials: { mode: 'token', token: 'plain-token' } },
    },
  ])
  try {
    const result = loadPluginConfigFile(workspace.configFile, { env: {} })
    const warning = result.warnings.find((item) => item.kind === 'inline-secret')
    assert.ok(warning)
    assert.deepEqual(warning.fields, ['credentials.token'])
    assert.equal(result.plugins[0].configSource, 'inline')
  } finally {
    fs.rmSync(workspace.root, { recursive: true, force: true })
  }
})

test('secrets 文件权限过宽时拒绝加载', { skip: process.platform === 'win32' }, () => {
  const workspace = makeConfig([], null)
  try {
    const file = path.join(workspace.dataDir, 'plugins.secrets.json')
    fs.writeFileSync(file, JSON.stringify({ version: 1, refs: {} }), { mode: 0o644 })
    fs.chmodSync(file, 0o644)
    assert.throws(() => loadSecretsFile(file), /权限过宽/)
  } finally {
    fs.rmSync(workspace.root, { recursive: true, force: true })
  }
})

test('secrets 文件解析失败不把内容带进错误', () => {
  const workspace = makeConfig([], null)
  try {
    const file = path.join(workspace.dataDir, 'plugins.secrets.json')
    fs.writeFileSync(file, '{"version":1,"refs":{"echo/token":"super-secret"', { mode: 0o600 })
    if (process.platform !== 'win32') fs.chmodSync(file, 0o600)
    assert.throws(
      () => loadSecretsFile(file),
      (error) => /不是合法 JSON/.test(error.message) && !error.message.includes('super-secret'),
    )
  } finally {
    fs.rmSync(workspace.root, { recursive: true, force: true })
  }
})

test('GET /api/plugins 不返回 secret 原值', async () => {
  const harness = await createHarness({
    plugins: [
      {
        id: 'echo',
        module: fixtureModule('echo'),
        enabled: true,
        config: {
          token: 'secret:echo/token',
          credentials: { mode: 'token', token: 'secret:echo/token' },
        },
      },
    ],
    secrets: { version: 1, refs: { 'echo/token': 'super-secret' } },
  })
  const http = await startHttpServer(harness.runtime)
  try {
    const body = await fetch(`${http.baseUrl}/api/plugins`).then((response) => response.json())
    assert.equal(JSON.stringify(body).includes('super-secret'), false)
    const echo = body.plugins.find((plugin) => plugin.id === 'echo')
    assert.equal(echo.config.token, '***')
    assert.equal(echo.config.credentials.token, '***')
    assert.equal(echo.credentials.source, 'secret')
    assert.equal(echo.credentials.mode, 'token')
  } finally {
    await http.close()
    await harness.cleanup()
  }
})
