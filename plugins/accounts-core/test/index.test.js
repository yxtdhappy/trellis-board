import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHarness, startHttpServer } from '@trellis-board/test-support/plugin-runtime.js'

const ID = 'accounts-core'
const MODULE = fileURLToPath(new URL('../index.js', import.meta.url))
const CALLER_MODULE = fileURLToPath(new URL('./fixtures/accounts-caller/index.js', import.meta.url))

async function setup() {
  const harness = await createHarness({
    plugins: [
      { id: ID, module: MODULE, enabled: true, config: {} },
      { id: 'accounts-caller', module: CALLER_MODULE, enabled: true, config: {} },
    ],
    hostVersion: '0.4.24',
  })
  const http = await startHttpServer(harness.runtime)

  async function api(pluginPath, init) {
    const response = await fetch(`${http.baseUrl}/api/plugins/${ID}${pluginPath}`, init)
    return { status: response.status, body: await response.json().catch(() => null) }
  }
  async function json(method, pluginPath, body) {
    return api(pluginPath, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  }
  async function caller(pluginPath) {
    const response = await fetch(`${http.baseUrl}/api/plugins/accounts-caller${pluginPath}`)
    return { status: response.status, body: await response.json() }
  }

  return {
    harness,
    api,
    caller,
    json,
    async cleanup() {
      await http.close()
      await harness.cleanup()
    },
  }
}

test('账号增删改查，密码只写不读', async () => {
  const t = await setup()
  try {
    const created = await t.json('POST', '/accounts', {
      id: 'ops',
      username: 'CORP\\ops',
      displayName: '运维账号',
      note: '内网 AD',
    })
    assert.equal(created.status, 200)
    assert.equal(created.body.account.id, 'ops')
    assert.equal(created.body.account.hasPassword, false)

    const listed = await t.api('/accounts')
    assert.equal(listed.body.accounts.length, 1)
    assert.equal(listed.body.accounts[0].username, 'CORP\\ops')
    assert.equal(listed.body.accounts[0].password, undefined)

    const saved = await t.json('POST', '/accounts/password', { id: 'ops', password: 's3cret-中文' })
    assert.equal(saved.status, 200)
    const afterSave = await t.api('/accounts')
    assert.equal(afterSave.body.accounts[0].hasPassword, true)
    assert.doesNotMatch(JSON.stringify(afterSave.body), /s3cret/)

    const removed = await t.json('DELETE', '/accounts/password', { id: 'ops' })
    assert.equal(removed.status, 200)
    const afterClear = await t.api('/accounts')
    assert.equal(afterClear.body.accounts[0].hasPassword, false)
  } finally {
    await t.cleanup()
  }
})

test('系统绑定账号，调用方通过 capability 解析凭据', async () => {
  const t = await setup()
  try {
    await t.json('POST', '/accounts', { id: 'ops', username: 'CORP\\ops', displayName: '运维账号' })
    await t.json('POST', '/accounts/password', { id: 'ops', password: 'p@ss' })

    const created = await t.json('POST', '/systems', {
      id: 'jenkins',
      name: 'Jenkins',
      baseUrl: 'http://ci.corp.local',
      accountId: 'ops',
    })
    assert.equal(created.status, 200)
    assert.equal(created.body.system.hasAccount, true)

    const systems = await t.api('/systems')
    const jenkins = systems.body.systems.find((item) => item.id === 'jenkins')
    assert.ok(jenkins)
    assert.equal(jenkins.username, 'CORP\\ops')
    assert.equal(jenkins.password, undefined)

    const resolved = await t.caller('/resolve?system=jenkins')
    assert.equal(resolved.status, 200)
    assert.deepEqual(resolved.body.result, {
      systemId: 'jenkins',
      accountId: 'ops',
      username: 'CORP\\ops',
      password: 'p@ss',
      baseUrl: 'http://ci.corp.local',
    })
    assert.doesNotMatch(JSON.stringify(await t.caller('/systems')), /p@ss/)

    const unknown = await t.caller('/resolve?system=nope')
    assert.equal(unknown.status, 503)
    assert.match(unknown.body.message, /系统不存在/)

    await t.json('POST', '/systems', {
      id: 'missing-ref',
      name: '错误绑定',
      accountId: 'nobody',
    }).then((result) => {
      assert.equal(result.status, 400)
    })
  } finally {
    await t.cleanup()
  }
})

test('被系统引用的账号不允许直接删除', async () => {
  const t = await setup()
  try {
    await t.json('POST', '/accounts', { id: 'ops', username: 'CORP\\ops' })
    await t.json('POST', '/systems', { id: 'jenkins', name: 'Jenkins', accountId: 'ops' })

    const blocked = await t.json('DELETE', '/accounts', { id: 'ops' })
    assert.equal(blocked.status, 409)
    assert.deepEqual(blocked.body.systems, ['jenkins'])

    const removedSystem = await t.json('DELETE', '/systems', { id: 'jenkins' })
    assert.equal(removedSystem.status, 200)
    const removedAccount = await t.json('DELETE', '/accounts', { id: 'ops' })
    assert.equal(removedAccount.status, 200)
    const listed = await t.api('/accounts')
    assert.equal(listed.body.accounts.length, 0)
  } finally {
    await t.cleanup()
  }
})

test('凭据来源与连接状态可观测', async () => {
  const t = await setup()
  try {
    const empty = await t.api('/status')
    assert.equal(empty.status, 200)
    assert.equal(empty.body.accounts, 0)
    assert.equal(empty.body.systems, 0)

    await t.json('POST', '/accounts', { id: 'nopw', username: 'nopw-user' })
    const pending = await t.api('/status')
    assert.deepEqual(pending.body.missingPasswords, ['nopw'])

    await t.json('POST', '/accounts', { id: 'local', username: 'local-user' })
    await t.json('POST', '/accounts/password', { id: 'local', password: 'local-pass' })
    await t.json('POST', '/systems', { id: 'witops', name: 'WITOPS', accountId: 'local' })
    const resolved = await t.caller('/resolve?system=witops')
    assert.equal(resolved.status, 200)
    assert.equal(resolved.body.result.username, 'local-user')
  } finally {
    await t.cleanup()
  }
})

test('插件重启后账号与密钥仍然存在', async () => {
  const t = await setup()
  try {
    await t.json('POST', '/accounts', { id: 'ops', username: 'CORP\\ops' })
    await t.json('POST', '/accounts/password', { id: 'ops', password: 'persisted' })
    await t.json('POST', '/systems', { id: 'jenkins', name: 'Jenkins', accountId: 'ops' })

    await t.harness.supervisor.stopPlugin(ID)
    await t.harness.supervisor.startPlugin(ID)

    const listed = await t.api('/accounts')
    assert.equal(listed.body.accounts.find((item) => item.id === 'ops').hasPassword, true)
    const resolved = await t.caller('/resolve?system=jenkins')
    assert.equal(resolved.status, 200)
    assert.equal(resolved.body.result.password, 'persisted')
  } finally {
    await t.cleanup()
  }
})

test('拒绝非法系统 id', async () => {
  const t = await setup()
  try {
    const bad = await t.json('POST', '/systems', { id: 'Bad_Id!', name: 'x' })
    assert.equal(bad.status, 400)
  } finally {
    await t.cleanup()
  }
})
