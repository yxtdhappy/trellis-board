import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { createTeamPluginHost } from '../team/plugins/host.js'
import { createTeamPluginRoutes } from '../team/plugins/http.js'
import { errorPayload } from '../team/errors.js'
import {
  actorFor,
  cleanupWorkspace,
  makePluginWorkspace,
  openPluginWorkspaceDatabase,
  seedTeamPluginFixtures,
} from '@trellis-board/test-support/team-plugin-fixtures.js'

const PLUGIN = 'witops-core'

function writePlugin(dir, id) {
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
        permissions: ['store', 'panels'],
        panels: [{ id, title: '测试面板', entry: '/panel', placement: 'view', order: 10 }],
        engines: { board: '>=0.2.0' },
      },
      null,
      2,
    ),
  )
  fs.writeFileSync(path.join(pluginDir, 'index.js'), 'export default {}\n')
}

async function withRoutes(fn) {
  const workspace = makePluginWorkspace()
  const db = openPluginWorkspaceDatabase(workspace)
  const logger = { info() {}, warn() {}, error() {} }
  try {
    const fixtures = await seedTeamPluginFixtures(db)
    writePlugin(workspace.pluginsDir, PLUGIN)
    const host = createTeamPluginHost({
      db,
      appDir: workspace.pluginsDir,
      dataDir: workspace.dataDir,
      pluginsDir: workspace.pluginsDir,
      hostVersion: '0.4.24',
      logger,
    })
    await host.load()
    const routes = createTeamPluginRoutes({ host, logger })
    const admin = actorFor(fixtures.admin, {
      systemAdmin: true,
      teams: [{ id: 'team-a', name: 'A 队', role: 'admin' }],
    })
    const lead = actorFor(fixtures.lead, {
      teams: [{ id: 'team-a', name: 'A 队', role: 'member' }],
    })
    const outsider = actorFor(fixtures.member, {
      teams: [{ id: 'team-b', name: 'B 队', role: 'member' }],
    })
    await fn({ routes, host, db, admin, lead, outsider, fixtures })
  } finally {
    cleanupWorkspace(workspace, db)
  }
}

async function invoke(routes, { method = 'GET', path: target, actor, body }) {
  const url = new URL(`http://127.0.0.1${target}`)
  const payload = body === undefined ? '' : JSON.stringify(body)
  const request = Readable.from(payload ? [payload] : [])
  request.method = method
  request.headers = { 'content-type': 'application/json' }
  const captured = { status: 0, body: '' }
  const response = {
    writeHead(status) {
      captured.status = status
    },
    end(value) {
      captured.body = value ?? ''
    },
  }
  let handled = false
  try {
    handled = await routes(request, response, url, actor)
  } catch (error) {
    const mapped = errorPayload(error)
    captured.status = mapped.status
    captured.body = JSON.stringify(mapped.body)
    handled = true
  }
  let parsed = null
  try {
    parsed = captured.body ? JSON.parse(captured.body) : null
  } catch {
    parsed = captured.body
  }
  return { handled, ...captured, json: parsed }
}

test('热重载返回 409 RELOAD_REQUIRES_RESTART', async () => {
  await withRoutes(async ({ routes, admin }) => {
    const result = await invoke(routes, {
      method: 'POST',
      path: '/api/plugins/reload',
      actor: admin,
    })
    assert.equal(result.status, 409)
    assert.equal(result.json.code, 'RELOAD_REQUIRES_RESTART')
  })
})

test('非系统管理员启动/停止插件被拒 403', async () => {
  await withRoutes(async ({ routes, lead }) => {
    const start = await invoke(routes, {
      method: 'POST',
      path: `/api/plugins/${PLUGIN}/start`,
      actor: lead,
    })
    assert.equal(start.status, 403)
    assert.equal(start.json.code, 'FORBIDDEN')
  })
})

test('系统管理员停用后仍可重新启用', async () => {
  await withRoutes(async ({ routes, admin }) => {
    const off = await invoke(routes, {
      method: 'PUT',
      path: `/api/plugins/${PLUGIN}/enabled`,
      actor: admin,
      body: { enabled: false },
    })
    assert.equal(off.status, 200)
    assert.equal(off.json.plugin.enabled, false)
    const on = await invoke(routes, {
      method: 'PUT',
      path: `/api/plugins/${PLUGIN}/enabled`,
      actor: admin,
      body: { enabled: true },
    })
    assert.equal(on.status, 200)
    assert.equal(on.json.plugin.enabled, true)
  })
})

test('列表按团队可见性过滤，未启用的团队看不到', async () => {
  await withRoutes(async ({ routes, db, lead, outsider }) => {
    const before = await invoke(routes, { path: '/api/plugins', actor: lead })
    assert.equal(before.status, 200)
    assert.deepEqual(before.json.plugins, [])

    db.prepare(`
      INSERT INTO plugin_team_setting(team_id, plugin_id, enabled, config_json, created_at, updated_at)
      VALUES ('team-a', ?, 1, '{}', '2026-11-16T00:00:00.000Z', '2026-11-16T00:00:00.000Z')
    `).run(PLUGIN)

    const after = await invoke(routes, { path: '/api/plugins', actor: lead })
    assert.deepEqual(
      after.json.plugins.map((plugin) => plugin.id),
      [PLUGIN],
    )
    const stillHidden = await invoke(routes, { path: '/api/plugins', actor: outsider })
    assert.deepEqual(stillHidden.json.plugins, [])
  })
})

test('面板清单只包含运行中的插件', async () => {
  await withRoutes(async ({ routes, admin }) => {
    // 本用例不启动子进程，所以面板必须为空（running 才挂载）。
    const stopped = await invoke(routes, { path: '/api/panels', actor: admin })
    assert.equal(stopped.status, 200)
    assert.deepEqual(stopped.json.panels, [])
  })
})

test('未登记插件返回 404，停用插件对普通用户 403', async () => {
  await withRoutes(async ({ routes, host, admin, lead }) => {
    const missing = await invoke(routes, { path: '/api/plugins/nope', actor: admin })
    assert.equal(missing.status, 404)
    assert.equal(missing.json.code, 'PLUGIN_NOT_FOUND')

    await host.setEnabled(PLUGIN, false)
    const denied = await invoke(routes, { path: `/api/plugins/${PLUGIN}`, actor: lead })
    assert.equal(denied.status, 403)
    assert.equal(denied.json.code, 'PLUGIN_DISABLED')
  })
})

/** 团队要启用插件，普通成员才看得见（见 policy.assertPluginVisible）。 */
function enableForTeam(host, teamId = 'team-a') {
  host.settings.setTeamSetting({ teamId, pluginId: PLUGIN, enabled: true, config: {} })
}

/** 让插件"看起来在跑"，并把 http/request 换成可编排的假实现。 */
function fakeRunningPlugin(host, handler) {
  const state = host.supervisor.plugins.get(PLUGIN)
  state.status = 'running'
  state.process = { request: async () => ({}) }
  host.forwardHttp = async (...args) => handler(...args)
  return state
}

test('面板静态资源不需要登录', async () => {
  await withRoutes(async ({ routes, host }) => {
    fakeRunningPlugin(host, async (_state, options) => {
      assert.equal(options.anonymous, true)
      assert.equal(options.path, '/panel/app.css')
      return { status: 200, headers: { 'content-type': 'text/css' }, body: 'body{}' }
    })
    const result = await invoke(routes, {
      path: `/api/plugins/${PLUGIN}/app/panel/app.css`,
      actor: null,
    })
    assert.equal(result.handled, true)
    assert.equal(result.status, 200)
    assert.equal(result.body, 'body{}')
  })
})

test('面板资源在插件未运行时返回 404', async () => {
  await withRoutes(async ({ routes, host }) => {
    const state = host.supervisor.plugins.get(PLUGIN)
    state.status = 'stopped'
    const result = await invoke(routes, {
      path: `/api/plugins/${PLUGIN}/app/panel`,
      actor: null,
    })
    assert.equal(result.status, 404)
  })
})

test('POST /session 成功后建立会话并标记用户状态', async () => {
  await withRoutes(async ({ routes, host, admin }) => {
    fakeRunningPlugin(host, async () => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'tok-1', account: 'zhangsan', userId: 'u-9' }),
    }))
    const result = await invoke(routes, {
      method: 'POST',
      path: `/api/plugins/${PLUGIN}/session`,
      actor: admin,
      body: { account: 'zhangsan', password: 'secret' },
    })
    assert.equal(result.status, 200)
    assert.equal(result.json.online, true)
    assert.equal(result.json.account, 'zh***an')
    assert.equal(host.sessions.statusOf(admin.userId, PLUGIN).account, 'zhangsan')
    assert.equal(host.settings.getUserConfig(admin.userId, PLUGIN).status, 'active')
  })
})

test('POST /session 把平台拒绝翻译成账号密码错误', async () => {
  await withRoutes(async ({ routes, host, admin }) => {
    fakeRunningPlugin(host, async () => ({
      status: 401,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        error: '账号或密码错误',
        code: 1001,
        detail: { reason: 'auth-failed' },
      }),
    }))
    const result = await invoke(routes, {
      method: 'POST',
      path: `/api/plugins/${PLUGIN}/session`,
      actor: admin,
      body: { account: 'zhangsan', password: 'bad' },
    })
    assert.equal(result.status, 401)
    assert.equal(result.json.code, 'AUTH_FAILED')
  })
})

test('POST /session 连接断开时返回 CONNECTION_LOST', async () => {
  await withRoutes(async ({ routes, host, admin }) => {
    fakeRunningPlugin(host, async () => ({
      status: 401,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: '断开', code: 1001, detail: { reason: 'connection-lost' } }),
    }))
    const result = await invoke(routes, {
      method: 'POST',
      path: `/api/plugins/${PLUGIN}/session`,
      actor: admin,
      body: { account: 'zhangsan', password: 'x' },
    })
    assert.equal(result.status, 401)
    assert.equal(result.json.code, 'CONNECTION_LOST')
  })
})

test('/app 请求遇到平台 401 时翻译成 CONNECTION_LOST 并标记需要重新登录', async () => {
  await withRoutes(async ({ routes, host, admin }) => {
    enableForTeam(host)
    fakeRunningPlugin(host, async () => ({
      status: 401,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: '断开', code: 1001, detail: { reason: 'connection-lost' } }),
    }))
    const result = await invoke(routes, {
      path: `/api/plugins/${PLUGIN}/app/project-space`,
      actor: admin,
    })
    assert.equal(result.status, 401)
    assert.equal(result.json.code, 'CONNECTION_LOST')
    assert.equal(host.settings.getUserConfig(admin.userId, PLUGIN).status, 'invalid')
  })
})

test('/app 请求缺少登录态时返回 CREDENTIALS_MISSING', async () => {
  await withRoutes(async ({ routes, host, admin }) => {
    enableForTeam(host)
    fakeRunningPlugin(host, async () => ({
      status: 401,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        error: '先登录',
        code: 1001,
        detail: { reason: 'missing-credentials' },
      }),
    }))
    const result = await invoke(routes, {
      path: `/api/plugins/${PLUGIN}/app/project-space`,
      actor: admin,
    })
    assert.equal(result.status, 401)
    assert.equal(result.json.code, 'CREDENTIALS_MISSING')
  })
})

test('同一平台账号被他人占用时返回 409 ACCOUNT_IN_USE', async () => {
  await withRoutes(async ({ routes, host, admin, lead }) => {
    enableForTeam(host)
    fakeRunningPlugin(host, async () => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'tok-1', account: 'zhangsan' }),
    }))
    const first = await invoke(routes, {
      method: 'POST',
      path: `/api/plugins/${PLUGIN}/session`,
      actor: lead,
      body: { account: 'zhangsan', password: 'secret' },
    })
    assert.equal(first.status, 200)
    const second = await invoke(routes, {
      method: 'POST',
      path: `/api/plugins/${PLUGIN}/session`,
      actor: admin,
      body: { account: 'zhangsan', password: 'secret' },
    })
    assert.equal(second.status, 409)
    assert.equal(second.json.code, 'ACCOUNT_IN_USE')
    assert.equal(second.json.details.displayName, lead.user.displayName)
  })
})

test('项目绑定：lead 能绑定自己的项目，成员不能', async () => {
  await withRoutes(async ({ routes, host, admin, lead, outsider }) => {
    enableForTeam(host)
    fakeRunningPlugin(host, async () => ({ status: 200, headers: {}, body: '{}' }))
    const bound = await invoke(routes, {
      method: 'POST',
      path: `/api/plugins/${PLUGIN}/bindings?teamId=team-a`,
      actor: lead,
      body: {
        projectId: 'project-a',
        externalProjectId: 'witops-p1',
        externalProjectName: '项目一',
      },
    })
    assert.equal(bound.status, 200)
    assert.equal(bound.json.binding.externalProjectId, 'witops-p1')

    const duplicate = await invoke(routes, {
      method: 'POST',
      path: `/api/plugins/${PLUGIN}/bindings?teamId=team-a`,
      actor: lead,
      body: { projectId: 'project-a', externalProjectId: 'witops-p1' },
    })
    assert.equal(duplicate.status, 409)
    assert.equal(duplicate.json.code, 'ALREADY_BOUND')

    const listed = await invoke(routes, {
      path: `/api/plugins/${PLUGIN}/bindings?teamId=team-a`,
      actor: lead,
    })
    assert.equal(listed.json.bindings.length, 1)

    const denied = await invoke(routes, {
      path: `/api/plugins/${PLUGIN}/bindings?teamId=team-a`,
      actor: outsider,
    })
    assert.equal(denied.status, 403)

    const removed = await invoke(routes, {
      method: 'DELETE',
      path: `/api/plugins/${PLUGIN}/bindings?teamId=team-a&bindingId=${bound.json.binding.id}`,
      actor: lead,
    })
    assert.equal(removed.status, 200)
    assert.equal(admin.systemAdmin, true)
  })
})
