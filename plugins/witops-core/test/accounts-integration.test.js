import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createHarness, startHttpServer } from '@trellis-board/test-support/plugin-runtime.js'
import {
  createTaskRepository,
  createWitopsFixture,
  pluginConfig,
} from './fixtures/witops-fixture.js'

const PLUGIN_ID = 'witops-core'
const PLUGIN_MODULE = fileURLToPath(new URL('../index.js', import.meta.url))
const ACCOUNTS_MODULE = fileURLToPath(new URL('../../accounts-core/index.js', import.meta.url))

async function setup({
  withAccounts = true,
  credentialSource = 'accounts',
  systemId = 'witops',
} = {}) {
  const fixture = await createWitopsFixture()
  const repo = createTaskRepository()
  const plugins = []
  if (withAccounts) {
    plugins.push({ id: 'accounts-core', module: ACCOUNTS_MODULE, enabled: true, config: {} })
  }
  plugins.push({
    id: PLUGIN_ID,
    module: PLUGIN_MODULE,
    enabled: true,
    config: pluginConfig({
      baseUrl: fixture.baseUrl,
      repositoryId: 'tb-dev',
      credentialSource,
      accountSystemId: 'witops',
      credentials: { mode: 'password', account: '', password: '', token: '' },
    }),
  })
  const harness = await createHarness({
    plugins,
    repositories: repo.repositories,
    hostVersion: '0.4.24',
  })
  const http = await startHttpServer(harness.runtime)

  async function json(pluginId, method, pathname, body) {
    const response = await fetch(`${http.baseUrl}/api/plugins/${pluginId}${pathname}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: response.status, body: await response.json().catch(() => null) }
  }

  async function seedAccount() {
    await json('accounts-core', 'POST', '/accounts', { id: 'witops-ad', username: 'alice' })
    await json('accounts-core', 'POST', '/accounts/password', {
      id: 'witops-ad',
      password: 'secret',
    })
    await json('accounts-core', 'POST', '/systems', {
      id: systemId,
      name: 'WitOps',
      baseUrl: fixture.baseUrl,
      accountId: 'witops-ad',
    })
  }

  return {
    fixture,
    harness,
    json,
    seedAccount,
    async cleanup() {
      await http.close()
      await harness.cleanup()
      fs.rmSync(repo.root, { recursive: true, force: true })
      await fixture.close()
    },
  }
}

test('统一账号有绑定时 witops 免登录并标注来源', async () => {
  const context = await setup()
  try {
    await context.seedAccount()
    await context.harness.supervisor.stopPlugin(PLUGIN_ID)
    await context.harness.supervisor.startPlugin(PLUGIN_ID)

    const mine = await context.json(PLUGIN_ID, 'GET', '/mine')
    assert.equal(mine.status, 200)

    const auth = await context.json(PLUGIN_ID, 'GET', '/auth')
    assert.equal(auth.body.credentialSource, 'accounts')
    assert.equal(auth.body.status, 'authenticated')
    assert.equal(auth.body.account, 'a***e')

    const credentials = await context.json(PLUGIN_ID, 'GET', '/credentials')
    assert.equal(credentials.body.source, 'accounts')
    assert.equal(credentials.body.username, 'alice')
    assert.equal(credentials.body.hasPassword, true)
    assert.equal(credentials.body.password, undefined)
    assert.equal(context.fixture.state.logins, 1)
  } finally {
    await context.cleanup()
  }
})

test('未绑定系统时回退本地，登录提示仍然可用', async () => {
  const context = await setup({ credentialSource: 'auto' })
  try {
    const mine = await context.json(PLUGIN_ID, 'GET', '/mine')
    assert.equal(mine.status, 401)
    assert.match(mine.body.error, /未登录/)

    const auth = await context.json(PLUGIN_ID, 'GET', '/auth')
    assert.equal(auth.body.credentialSource, 'local')
    assert.match(auth.body.accountsError, /系统不存在/)

    const login = await context.json(PLUGIN_ID, 'POST', '/login', {
      account: 'alice',
      password: 'secret',
    })
    assert.equal(login.status, 200)
    assert.equal(login.body.auth.status, 'authenticated')
  } finally {
    await context.cleanup()
  }
})

async function waitFor(check, { timeoutMs = 3000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await check()
    if (last?.ok) return last
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  return last
}

test('运行中新建账号与系统后无需重启即免登录', async () => {
  const context = await setup()
  try {
    const before = await context.json(PLUGIN_ID, 'GET', '/credentials')
    assert.equal(before.body.available, false)
    assert.equal(before.body.source, 'local')
    assert.equal(before.body.error, '')

    await context.seedAccount()
    const switched = await waitFor(async () => {
      const response = await context.json(PLUGIN_ID, 'GET', '/credentials')
      return { ok: response.body.source === 'accounts', body: response.body }
    })
    assert.equal(switched.body.source, 'accounts', '变更事件未触发凭据重算')
    assert.equal(switched.body.username, 'alice')

    const mine = await context.json(PLUGIN_ID, 'GET', '/mine')
    assert.equal(mine.status, 200)
    assert.equal(context.fixture.state.logins, 1)
  } finally {
    await context.cleanup()
  }
})

test('credentialSource=local 时忽略统一账号', async () => {
  const context = await setup({ credentialSource: 'local' })
  try {
    await context.seedAccount()
    await context.harness.supervisor.stopPlugin(PLUGIN_ID)
    await context.harness.supervisor.startPlugin(PLUGIN_ID)

    const auth = await context.json(PLUGIN_ID, 'GET', '/auth')
    assert.equal(auth.body.credentialSource, 'local')
    const mine = await context.json(PLUGIN_ID, 'GET', '/mine')
    assert.equal(mine.status, 401)
  } finally {
    await context.cleanup()
  }
})
