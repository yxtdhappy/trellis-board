import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createHarness, startHttpServer } from '@trellis-board/test-support/plugin-runtime.js'
import { startFakeJenkins } from './fake-jenkins.js'

const JENKINS_ID = 'jenkins-ops'
const ACCOUNTS_ID = 'accounts-core'
const JENKINS_MODULE = fileURLToPath(new URL('../index.js', import.meta.url))
const ACCOUNTS_MODULE = fileURLToPath(new URL('../../accounts-core/index.js', import.meta.url))

async function setup({
  withAccounts = true,
  credentialSource = 'accounts',
  systemId = 'jenkins',
} = {}) {
  const jenkins = await startFakeJenkins({
    formLogin: { username: 'Z0328', password: 'secret' },
  })
  const plugins = []
  if (withAccounts) {
    plugins.push({ id: ACCOUNTS_ID, module: ACCOUNTS_MODULE, enabled: true, config: {} })
  }
  plugins.push({
    id: JENKINS_ID,
    module: JENKINS_MODULE,
    enabled: true,
    config: {
      baseUrl: jenkins.baseUrl,
      username: 'local-bot',
      password: 'wrong-local',
      credentialSource,
      accountSystemId: 'jenkins',
      timeoutMs: 5000,
      retries: 0,
    },
  })
  const harness = await createHarness({ plugins, hostVersion: '0.4.24' })
  const http = await startHttpServer(harness.runtime)

  async function json(pluginId, method, path, body) {
    const response = await fetch(`${http.baseUrl}/api/plugins/${pluginId}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: response.status, body: await response.json().catch(() => null) }
  }

  async function seedAccount() {
    await json(ACCOUNTS_ID, 'POST', '/accounts', { id: 'jenkins-ad', username: 'Z0328' })
    await json(ACCOUNTS_ID, 'POST', '/accounts/password', { id: 'jenkins-ad', password: 'secret' })
    await json(ACCOUNTS_ID, 'POST', '/systems', {
      id: systemId,
      name: 'Jenkins',
      baseUrl: jenkins.baseUrl,
      accountId: 'jenkins-ad',
    })
  }

  return {
    jenkins,
    harness,
    json,
    seedAccount,
    async cleanup() {
      await http.close()
      await harness.cleanup()
      await jenkins.close()
    },
  }
}

test('统一账号有绑定密码时 jenkins 使用账号凭据连接', async () => {
  const t = await setup({ credentialSource: 'accounts' })
  try {
    await t.seedAccount()
    await t.harness.supervisor.stopPlugin(JENKINS_ID)
    await t.harness.supervisor.startPlugin(JENKINS_ID)

    const status = await t.json(JENKINS_ID, 'GET', '/status')
    assert.equal(status.body.credentialSource, 'accounts')
    assert.equal(status.body.accountId, 'jenkins-ad')
    assert.equal(status.body.username, 'Z0328')
    assert.equal(status.body.hasPassword, true)
    assert.ok(status.body.connection?.ok, `连接失败: ${status.body.error}`)

    const credentials = await t.json(JENKINS_ID, 'GET', '/credentials')
    assert.deepEqual(
      { source: credentials.body.source, username: credentials.body.username },
      { source: 'accounts', username: 'Z0328' },
    )
    assert.equal(credentials.body.password, undefined)
  } finally {
    await t.cleanup()
  }
})

test('统一账号未绑定系统时 accounts 模式报错，auto 模式回退本地', async () => {
  const t = await setup({ credentialSource: 'auto' })
  try {
    const status = await t.json(JENKINS_ID, 'GET', '/status')
    assert.equal(status.body.credentialSource, 'local', '未绑定系统时应回退本地')
    assert.match(status.body.accountsError, /系统不存在/)
    assert.equal(status.body.username, 'local-bot')
  } finally {
    await t.cleanup()
  }
})

test('credentialSource=local 时即使统一账号可用也不使用', async () => {
  const t = await setup({ credentialSource: 'local' })
  try {
    await t.seedAccount()
    await t.harness.supervisor.stopPlugin(JENKINS_ID)
    await t.harness.supervisor.startPlugin(JENKINS_ID)

    const status = await t.json(JENKINS_ID, 'GET', '/status')
    assert.equal(status.body.credentialSource, 'local')
    assert.equal(status.body.username, 'local-bot')
  } finally {
    await t.cleanup()
  }
})

test('accounts 模式但账号缺密码时回退本地并暴露原因', async () => {
  const t = await setup({ credentialSource: 'accounts' })
  try {
    await t.json(ACCOUNTS_ID, 'POST', '/accounts', { id: 'nopw', username: 'Z0328' })
    await t.json(ACCOUNTS_ID, 'POST', '/systems', {
      id: 'jenkins',
      name: 'Jenkins',
      baseUrl: t.jenkins.baseUrl,
      accountId: 'nopw',
    })
    await t.harness.supervisor.stopPlugin(JENKINS_ID)
    await t.harness.supervisor.startPlugin(JENKINS_ID)

    const status = await t.json(JENKINS_ID, 'GET', '/status')
    assert.equal(status.body.credentialSource, 'local')
    assert.match(status.body.accountsError, /未设置密码/)
  } finally {
    await t.cleanup()
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

test('运行中新建账号与系统后无需重启即切换到统一账号', async () => {
  const t = await setup({ credentialSource: 'accounts' })
  try {
    const before = await t.json(JENKINS_ID, 'GET', '/credentials')
    assert.equal(before.body.source, 'local', '未绑定时应回退本地配置')
    assert.match(before.body.error, /系统不存在/)

    await t.seedAccount()
    await t.json(ACCOUNTS_ID, 'POST', '/accounts/password', {
      id: 'jenkins-ad',
      password: 'secret',
    })

    const switched = await waitFor(async () => {
      const response = await t.json(JENKINS_ID, 'GET', '/credentials')
      return { ok: response.body.source === 'accounts', body: response.body }
    })
    assert.equal(switched.body.source, 'accounts', '变更事件未触发凭据重算')
    assert.equal(switched.body.username, 'Z0328')

    const status = await t.json(JENKINS_ID, 'GET', '/status')
    assert.equal(status.body.credentialSource, 'accounts')
    assert.ok(status.body.connection?.ok, `连接失败: ${status.body.error}`)
  } finally {
    await t.cleanup()
  }
})

test('运行中解绑系统后回退本地配置', async () => {
  const t = await setup({ credentialSource: 'auto' })
  try {
    await t.seedAccount()
    const bound = await waitFor(async () => {
      const response = await t.json(JENKINS_ID, 'GET', '/credentials')
      return { ok: response.body.source === 'accounts', body: response.body }
    })
    assert.equal(bound.body.source, 'accounts')

    await t.json(ACCOUNTS_ID, 'DELETE', '/systems', { id: 'jenkins' })
    const reverted = await waitFor(async () => {
      const response = await t.json(JENKINS_ID, 'GET', '/credentials')
      return { ok: response.body.source === 'local', body: response.body }
    })
    assert.equal(reverted.body.source, 'local')
    assert.match(reverted.body.error, /系统不存在/)
  } finally {
    await t.cleanup()
  }
})
