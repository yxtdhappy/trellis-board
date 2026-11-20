/**
 * Team 服务端插件门禁：默认屏蔽、显式白名单放行与 /api/runtime 开关下发。
 *
 * 生产 Team 服务器不配置任何环境变量时必须零插件子进程、零插件静态资源；
 * 只有运维显式设置 TRELLIS_TEAM_PLUGINS_ALLOWLIST 才装载白名单内的插件。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { parsePluginAllowlist, parseTeamConfig } from '../config.js'
import { createUser } from '../team/auth.js'
import { createTeamRuntime } from '../team/http.js'

const PUBLIC_ORIGIN = 'http://127.0.0.1:4317'
const HOST = '127.0.0.1:4317'
const SILENT_LOGGER = { info() {}, warn() {}, error() {} }

function testConfig(overrides = {}) {
  return {
    mode: 'team',
    bindHost: '127.0.0.1',
    port: 0,
    publicUrl: new URL(PUBLIC_ORIGIN),
    publicOrigin: PUBLIC_ORIGIN,
    sessionTtlMs: 12 * 60 * 60 * 1000,
    agentStaleMs: 60_000,
    cookieSecure: false,
    trustProxy: false,
    allowLocalGitRemotes: false,
    pluginsDisabled: false,
    pluginAllowlist: [],
    ...overrides,
  }
}

function request(runtime, pathname, { method = 'GET', body = null, cookie = null } = {}) {
  const address = runtime.address()
  const payload = body == null ? null : JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const headers = { host: HOST }
    if (payload != null) {
      headers['content-type'] = 'application/json'
      headers['content-length'] = Buffer.byteLength(payload)
    }
    if (method !== 'GET' && method !== 'HEAD') headers.origin = PUBLIC_ORIGIN
    if (cookie) headers.cookie = cookie
    const req = http.request(
      { hostname: '127.0.0.1', port: address.port, path: pathname, method, headers },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json = null
          if (text) {
            try {
              json = JSON.parse(text)
            } catch {
              json = text
            }
          }
          resolve({ status: response.statusCode, headers: response.headers, body: json })
        })
      },
    )
    req.on('error', reject)
    if (payload != null) req.write(payload)
    req.end()
  })
}

function cookieOf(response) {
  return String((response.headers['set-cookie'] || [])[0] || '').split(';')[0]
}

async function startRuntime(t, overrides) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-team-plugin-gating-'))
  const runtime = await createTeamRuntime({
    config: testConfig(overrides),
    databaseFile: path.join(root, 'data', 'board.sqlite'),
    dataDir: path.join(root, 'data'),
    logger: SILENT_LOGGER,
    requireAdmin: false,
    enablePolling: false,
  })
  await runtime.start()
  t.after(async () => {
    await runtime.stop()
    fs.rmSync(root, { recursive: true, force: true })
  })
  await createUser(runtime.db, {
    username: 'sysadmin',
    displayName: '系统管理员',
    password: 'Admin-Password-123',
    systemAdmin: true,
    mustChangePassword: false,
  })
  const login = await request(runtime, '/api/auth/login', {
    method: 'POST',
    body: { username: 'sysadmin', password: 'Admin-Password-123' },
  })
  assert.equal(login.status, 200)
  return { runtime, cookie: cookieOf(login) }
}

test('parsePluginAllowlist 未配置时为空集合，显式配置才放行', () => {
  assert.deepEqual(parsePluginAllowlist(undefined), [])
  assert.deepEqual(parsePluginAllowlist(''), [])
  assert.deepEqual(parsePluginAllowlist('none'), [])
  assert.deepEqual(parsePluginAllowlist('false'), [])
  assert.deepEqual(parsePluginAllowlist(' witops-core '), ['witops-core'])
  assert.deepEqual(parsePluginAllowlist('witops-core,jenkins-ops,witops-core'), [
    'witops-core',
    'jenkins-ops',
  ])
})

test('parseTeamConfig 的 Team 插件门禁默认全屏蔽', () => {
  const config = parseTeamConfig({ TRELLIS_BOARD_MODE: 'team' })
  assert.equal(config.pluginsDisabled, false)
  assert.deepEqual(config.pluginAllowlist, [])

  const disabled = parseTeamConfig({
    TRELLIS_BOARD_MODE: 'team',
    TRELLIS_PLUGINS_DISABLED: '1',
  })
  assert.equal(disabled.pluginsDisabled, true)

  const allowed = parseTeamConfig({
    TRELLIS_BOARD_MODE: 'team',
    TRELLIS_TEAM_PLUGINS_ALLOWLIST: 'witops-core',
  })
  assert.deepEqual(allowed.pluginAllowlist, ['witops-core'])
})

test('默认配置的 Team 服务零插件暴露面', async (t) => {
  const { runtime, cookie } = await startRuntime(t)
  assert.equal(
    runtime.db.prepare('SELECT COUNT(*) AS count FROM plugin_registry').get().count,
    0,
    '默认屏蔽时不应扫描并登记任何插件',
  )

  const anonymousRuntime = await request(runtime, '/api/runtime')
  assert.equal(anonymousRuntime.status, 200)
  assert.deepEqual(anonymousRuntime.body.features, { pluginsEnabled: false })

  const panels = await request(runtime, '/api/panels', { cookie })
  assert.equal(panels.status, 200)
  assert.deepEqual(panels.body, { panels: [] })

  const plugins = await request(runtime, '/api/plugins', { cookie })
  assert.equal(plugins.status, 200)
  assert.deepEqual(plugins.body, { disabled: true, mode: 'team', plugins: [] })

  const panelAsset = await request(runtime, '/api/plugins/witops-core/app/panel')
  assert.equal(panelAsset.status, 404)
  assert.equal(panelAsset.body.code, 'PLUGIN_DISABLED')

  const subAsset = await request(runtime, '/api/plugins/witops-core/app/panel/app.js')
  assert.equal(subAsset.status, 404)

  const events = await request(runtime, '/api/events', { cookie })
  assert.equal(events.status, 404)
})

test('TRELLIS_PLUGINS_DISABLED=1 压过白名单强关插件', async (t) => {
  const { runtime, cookie } = await startRuntime(t, {
    pluginsDisabled: true,
    pluginAllowlist: ['witops-core'],
  })
  assert.equal(
    runtime.db.prepare('SELECT COUNT(*) AS count FROM plugin_registry').get().count,
    0,
  )
  const runtimeInfo = await request(runtime, '/api/runtime', { cookie })
  assert.equal(runtimeInfo.body.features.pluginsEnabled, false)
  const plugins = await request(runtime, '/api/plugins', { cookie })
  assert.equal(plugins.body.disabled, true)
})

test('显式白名单时 runtime 下发 pluginsEnabled=true 并按白名单登记', async (t) => {
  const { runtime, cookie } = await startRuntime(t, {
    pluginAllowlist: ['witops-core'],
  })
  const runtimeInfo = await request(runtime, '/api/runtime', { cookie })
  assert.equal(runtimeInfo.body.features.pluginsEnabled, true)

  const plugins = await request(runtime, '/api/plugins', { cookie })
  assert.equal(plugins.status, 200)
  assert.equal(plugins.body.disabled, false)
  assert.deepEqual(
    plugins.body.plugins.map((plugin) => plugin.id),
    ['witops-core'],
  )
  const registered = runtime.db
    .prepare('SELECT plugin_id FROM plugin_registry ORDER BY plugin_id')
    .all()
    .map((row) => row.plugin_id)
  assert.deepEqual(registered, ['witops-core'])
})
