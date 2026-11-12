import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createUser } from '../server/team/auth.js'
import { createTeamRuntime } from '../server/team/http.js'
import { AGENT_ERROR_CODE, AgentError } from '../agent/protocol.js'
import { ConfigStore } from '../agent/config-store.js'
import {
  enrollWithToken,
  loginDesktop,
  logoutDesktopSession,
  parseSessionCookie,
  validateEnrollToken,
} from '../desktop/sidecar/desktop-device.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PUBLIC_ORIGIN = 'http://127.0.0.1:4317'
const SILENT_LOGGER = { info() {}, warn() {}, error() {} }

function readText(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8')
}

function readJson(relativePath) {
  return JSON.parse(readText(relativePath))
}

function testConfig(origin = PUBLIC_ORIGIN, port = 0) {
  return {
    mode: 'team',
    bindHost: '127.0.0.1',
    port,
    publicUrl: new URL(origin),
    publicOrigin: origin,
    sessionTtlMs: 12 * 60 * 60 * 1000,
    agentStaleMs: 60_000,
    cookieSecure: false,
    trustProxy: false,
    allowLocalGitRemotes: false,
  }
}

function request(
  runtime,
  pathname,
  {
    method = 'GET',
    body = null,
    cookie = null,
    origin = undefined,
    contentType = 'application/json',
    authorization = null,
  } = {},
) {
  const address = runtime.address()
  const currentOrigin = runtime.testOrigin || PUBLIC_ORIGIN
  const originUrl = new URL(currentOrigin)
  const payload = body == null ? null : JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const headers = { host: originUrl.host }
    if (payload != null) {
      headers['content-type'] = contentType
      headers['content-length'] = Buffer.byteLength(payload)
    }
    const actualOrigin = origin === undefined ? currentOrigin : origin
    if (method !== 'GET' && method !== 'HEAD' && actualOrigin !== null) {
      headers.origin = actualOrigin
    }
    if (cookie) headers.cookie = cookie
    if (authorization) headers.authorization = authorization
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: address.port,
        path: pathname,
        method,
        headers,
      },
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

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

async function startRuntime(t, { desktopAuth, users = [], allowLocalGitRemotes = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-desktop-auth-'))
  const port = await freePort()
  const serverUrl = `http://127.0.0.1:${port}`
  const runtime = await createTeamRuntime({
    config: { ...testConfig(serverUrl, port), allowLocalGitRemotes },
    databaseFile: path.join(root, 'data', 'board.sqlite'),
    dataDir: path.join(root, 'data'),
    logger: SILENT_LOGGER,
    requireAdmin: false,
    enablePolling: false,
    ...(desktopAuth ? { desktopAuth } : {}),
  })
  await runtime.start()
  runtime.testOrigin = serverUrl
  t.after(async () => {
    await runtime.stop()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const sysadmin = await createUser(runtime.db, {
    username: 'sysadmin',
    displayName: '系统管理员',
    password: 'Legacy-Password-123',
    systemAdmin: true,
    mustChangePassword: false,
  })
  const teamId = 'team-desktop-system-admin'
  const now = new Date().toISOString()
  runtime.db
    .prepare(`
    INSERT INTO team(id, name, slug, status, created_at, updated_at)
    VALUES (?, ?, ?, 'active', ?, ?)
  `)
    .run(teamId, '桌面系统管理团队', teamId, now, now)
  const created = new Map()
  for (const user of users) {
    const row = await createUser(runtime.db, {
      password: 'Legacy-Password-123',
      mustChangePassword: false,
      ...user,
    })
    created.set(user.username, row)
  }
  const login = await request(runtime, '/api/auth/login', {
    method: 'POST',
    body: { username: 'sysadmin', password: 'Legacy-Password-123' },
  })
  assert.equal(login.status, 200)
  return {
    runtime,
    adminCookie: cookieOf(login),
    sysadminId: sysadmin.id,
    users: created,
    serverUrl,
    teamId,
  }
}

async function login(runtime, username, password = 'Legacy-Password-123') {
  const response = await request(runtime, '/api/auth/login', {
    method: 'POST',
    body: { username, password },
  })
  assert.equal(response.status, 200)
  return cookieOf(response)
}

async function issueToken(runtime, cookie, body = {}) {
  return request(runtime, '/api/desktop/enroll-tokens', {
    method: 'POST',
    cookie,
    body,
  })
}

function redeem(runtime, token, overrides = {}) {
  return request(runtime, '/api/agent/enroll-desktop', {
    method: 'POST',
    body: {
      token,
      deviceName: 'Windows 桌面',
      platform: 'win32',
      agentVersion: '0.1.0',
      protocolVersion: 3,
      ...overrides,
    },
  })
}

async function withTempRoot(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

test('签发设备令牌要求登录会话、JSON 与同源 Origin', async (t) => {
  const { runtime, adminCookie } = await startRuntime(t)

  const anonymous = await request(runtime, '/api/desktop/enroll-tokens', {
    method: 'POST',
    body: {},
  })
  assert.equal(anonymous.status, 401)
  assert.equal(anonymous.body.code, 'AUTH_REQUIRED')

  const noOrigin = await request(runtime, '/api/desktop/enroll-tokens', {
    method: 'POST',
    cookie: adminCookie,
    body: {},
    origin: null,
  })
  assert.equal(noOrigin.status, 403)
  assert.equal(noOrigin.body.code, 'CSRF_REJECTED')

  const wrongOrigin = await request(runtime, '/api/desktop/enroll-tokens', {
    method: 'POST',
    cookie: adminCookie,
    body: {},
    origin: 'https://evil.example.com',
  })
  assert.equal(wrongOrigin.status, 403)
  assert.equal(wrongOrigin.body.code, 'CSRF_REJECTED')

  const signedIn = await issueToken(runtime, adminCookie, { deviceName: ' 开发机 ' })
  assert.equal(signedIn.status, 201)
  assert.match(signedIn.body.token, /^[A-Za-z0-9_-]{43}$/)
  assert.ok(Date.parse(signedIn.body.expiresAt) > Date.now())
  assert.deepEqual(Object.keys(signedIn.body).sort(), ['expiresAt', 'token'])
})

test('设备令牌只能兑换一次并签发可用凭证', async (t) => {
  const { runtime, adminCookie, sysadminId, teamId } = await startRuntime(t)
  const issued = await issueToken(runtime, adminCookie, { deviceName: '开发机' })
  assert.equal(issued.status, 201)

  const enrolled = await redeem(runtime, issued.body.token)
  assert.equal(enrolled.status, 201)
  assert.match(enrolled.body.agentId, /^[A-Za-z0-9-]{8,64}$/)
  assert.match(enrolled.body.credential, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(enrolled.body.protocolVersion, 3)
  assert.deepEqual(
    enrolled.body.teams.map((team) => team.id),
    [teamId],
  )

  const device = runtime.db
    .prepare('SELECT * FROM agent_device WHERE id = ?')
    .get(enrolled.body.agentId)
  assert.equal(device.status, 'active')
  assert.equal(device.user_id, sysadminId)
  assert.equal(device.device_name, '开发机')
  assert.notEqual(device.credential_hash, enrolled.body.credential)

  const audit = runtime.db
    .prepare(`
    SELECT action, detail_json FROM audit_event
    WHERE action = 'desktop_device_enrolled'
  `)
    .get()
  assert.ok(audit, '缺少 desktop_device_enrolled 审计')
  const detail = JSON.parse(audit.detail_json)
  assert.equal(detail.deviceId, enrolled.body.agentId)
  assert.equal(detail.userId, sysadminId)
  assert.equal(detail.source, 'desktop_enroll_token')

  const heartbeat = await request(runtime, '/api/agent/heartbeat', {
    method: 'POST',
    body: {
      agentId: enrolled.body.agentId,
      protocolVersion: 3,
      agentVersion: '0.1.0',
      platform: 'win32',
      deviceName: '开发机',
    },
    cookie: null,
    authorization: `Bearer ${enrolled.body.credential}`,
  })
  assert.equal(heartbeat.status, 200)
  assert.equal(heartbeat.body.protocolVersion, 3)
  assert.equal(heartbeat.body.compatible, true)

  const devices = await request(runtime, '/api/admin/agents', { cookie: adminCookie })
  assert.equal(devices.status, 200)
  assert.ok(devices.body.agents.some((item) => item.id === enrolled.body.agentId))

  const replay = await redeem(runtime, issued.body.token)
  assert.equal(replay.status, 401)
  assert.equal(replay.body.code, 'DESKTOP_TOKEN_INVALID')
  assert.match(replay.body.error, /已使用/)
})

test('过期令牌返回 401 且不创建设备', async (t) => {
  let clock = Date.now()
  const ttlMs = 60_000
  const { runtime, adminCookie } = await startRuntime(t, {
    desktopAuth: { now: () => clock, ttlMs },
  })
  const issued = await issueToken(runtime, adminCookie)
  assert.equal(issued.status, 201)
  clock += ttlMs + 1

  const expired = await redeem(runtime, issued.body.token)
  assert.equal(expired.status, 401)
  assert.equal(expired.body.code, 'DESKTOP_TOKEN_INVALID')
  assert.match(expired.body.error, /已过期/)

  const count = runtime.db.prepare('SELECT COUNT(*) AS total FROM agent_device').get()
  assert.equal(count.total, 0)
})

test('无效、已撤销会话与禁用用户分别被拒绝', async (t) => {
  const { runtime, adminCookie, users } = await startRuntime(t, {
    users: [
      { username: 'disabled-user', displayName: '禁用用户' },
      { username: 'pending-user', displayName: '待改密用户', mustChangePassword: true },
    ],
  })

  const invalid = await redeem(runtime, 'x'.repeat(43))
  assert.equal(invalid.status, 401)
  assert.equal(invalid.body.code, 'DESKTOP_TOKEN_INVALID')

  // 会话 Cookie 不能被当作令牌使用：兑换端点完全不读取 Cookie。
  const cookieOnly = await request(runtime, '/api/agent/enroll-desktop', {
    method: 'POST',
    cookie: adminCookie,
    body: { protocolVersion: 3 },
  })
  assert.equal(cookieOnly.status, 401)
  assert.equal(cookieOnly.body.code, 'DESKTOP_TOKEN_INVALID')

  const disabledCookie = await login(runtime, 'disabled-user')
  const disabledIssued = await issueToken(runtime, disabledCookie)
  assert.equal(disabledIssued.status, 201)
  runtime.db
    .prepare("UPDATE user_account SET status = 'disabled' WHERE id = ?")
    .run(users.get('disabled-user').id)
  const disabled = await redeem(runtime, disabledIssued.body.token)
  assert.equal(disabled.status, 403)
  assert.equal(disabled.body.code, 'FORBIDDEN')
  assert.match(disabled.body.error, /禁用/)

  const pendingCookie = await login(runtime, 'pending-user')
  const pending = await issueToken(runtime, pendingCookie)
  assert.equal(pending.status, 403)
  assert.equal(pending.body.code, 'PASSWORD_CHANGE_REQUIRED')

  const stillUsable = await issueToken(runtime, adminCookie)
  assert.equal(stillUsable.status, 201)
})

test('同一用户未使用的设备令牌上限为 5，已使用令牌不占额度', async (t) => {
  const { runtime, adminCookie } = await startRuntime(t)
  const tokens = []
  for (let index = 0; index < 5; index += 1) {
    const response = await issueToken(runtime, adminCookie)
    assert.equal(response.status, 201)
    tokens.push(response.body.token)
  }
  const limited = await issueToken(runtime, adminCookie)
  assert.equal(limited.status, 429)
  assert.equal(limited.body.code, 'RATE_LIMITED')

  const enrolled = await redeem(runtime, tokens[0])
  assert.equal(enrolled.status, 201)
  const afterUse = await issueToken(runtime, adminCookie)
  assert.equal(afterUse.status, 201)

  const issuedEvents = runtime.db
    .prepare(`
    SELECT detail_json FROM audit_event WHERE action = 'desktop_enroll_token_issued'
  `)
    .all()
  assert.equal(issuedEvents.length, 6)
  for (const event of issuedEvents) {
    assert.ok(!event.detail_json.includes(tokens[0]), '审计不得包含令牌明文')
    assert.doesNotMatch(event.detail_json, /[A-Za-z0-9_-]{43}/)
  }
  const deviceAudit = runtime.db
    .prepare(`
    SELECT detail_json FROM audit_event WHERE action = 'desktop_device_enrolled'
  `)
    .get()
  assert.ok(!deviceAudit.detail_json.includes(enrolled.body.credential))
})

test('桌面端底层设备兑换走一次性令牌端点', async (t) => {
  const { runtime, adminCookie, serverUrl, teamId } = await startRuntime(t)
  const issued = await issueToken(runtime, adminCookie, { deviceName: '开发机' })
  assert.equal(issued.status, 201)

  const root = await withTempRoot(t, 'trellis-enroll-token-')
  const saved = []
  const credentialStore = {
    async saveCredential(credential) {
      saved.push(credential)
    },
  }
  const result = await enrollWithToken(issued.body.token, {
    serverUrl,
    deviceName: '开发机',
    root,
    credentialStore,
  })
  assert.equal(result.protocolVersion, 3)
  assert.equal(result.serverUrl, serverUrl)
  assert.equal(saved.length, 1)
  const configText = fs.readFileSync(path.join(root, 'config.json'), 'utf8')
  const config = JSON.parse(configText)
  assert.equal(config.agentId, result.agentId)
  // 设备绑定用户与设备；workspace init 从注册返回的团队列表显式选择目标团队。
  assert.equal(config.username, 'sysadmin')
  assert.equal(config.teamId, null)
  assert.deepEqual(
    config.teams.map((team) => team.id),
    [teamId],
  )
  assert.equal(config.credential, undefined)
  assert.ok(!configText.includes(saved[0]), '凭证不得写入 config.json')
  assert.ok(!configText.includes(issued.body.token), '令牌不得写入 config.json')

  const replayRoot = await withTempRoot(t, 'trellis-enroll-replay-')
  await assert.rejects(
    enrollWithToken(issued.body.token, {
      serverUrl,
      deviceName: '重放设备',
      root: replayRoot,
      credentialStore,
    }),
    (error) => error.code === 'DESKTOP_TOKEN_INVALID' && /已使用|已过期|无效/.test(error.message),
  )

  const offlinePort = await freePort()
  const offlineRoot = await withTempRoot(t, 'trellis-enroll-offline-')
  await assert.rejects(
    enrollWithToken('a'.repeat(43), {
      serverUrl: `http://127.0.0.1:${offlinePort}`,
      deviceName: '离线设备',
      root: offlineRoot,
      credentialStore,
    }),
    (error) => error.code === 'NETWORK_ERROR' && /无法连接 Board 服务端/.test(error.message),
  )

  assert.equal(validateEnrollToken(issued.body.token), issued.body.token)
  assert.throws(() => validateEnrollToken('short'), /设备令牌格式无效/)
})

test('桌面设备注册要求显式注入凭证存储', async (t) => {
  const root = await withTempRoot(t, 'trellis-enroll-no-store-')
  await assert.rejects(
    enrollWithToken('a'.repeat(43), {
      serverUrl: 'http://127.0.0.1:4317',
      deviceName: '无凭证存储',
      root,
    }),
    /凭证存储/,
  )
})

test('账号密码登录建立 Board 会话与设备凭据并可复用同一设备', async (t) => {
  const { runtime, serverUrl } = await startRuntime(t, { allowLocalGitRemotes: true })
  const root = await withTempRoot(t, 'trellis-desktop-login-')
  let credential = null
  const credentialStore = {
    async saveCredential(value) {
      credential = value
    },
    async loadCredential() {
      if (!credential) throw new Error('credential missing')
      return credential
    },
  }

  const first = await loginDesktop({
    serverUrl,
    username: 'sysadmin',
    password: 'Legacy-Password-123',
    deviceName: 'Windows 桌面',
    root,
    secureDirectory: false,
    credentialStore,
  })
  assert.equal(first.deviceReady, true)
  assert.equal(first.allowLocalGitRemotes, true)
  assert.match(first.sessionToken, /^[A-Za-z0-9_-]{16,}$/)
  assert.ok(credential)
  assert.equal(
    (await new ConfigStore(root, { secureDirectory: false }).readConfig({ allowMissing: false }))
      .allowLocalGitRemotes,
    true,
  )
  const configText = fs.readFileSync(path.join(root, 'config.json'), 'utf8')
  assert.ok(!configText.includes('Legacy-Password-123'))
  assert.ok(!configText.includes(first.sessionToken))
  assert.ok(!configText.includes(credential))

  const second = await loginDesktop({
    serverUrl,
    username: 'sysadmin',
    password: 'Legacy-Password-123',
    deviceName: 'Windows 桌面',
    root,
    secureDirectory: false,
    credentialStore,
  })
  assert.equal(second.deviceReady, true)
  assert.equal(runtime.db.prepare('SELECT COUNT(*) AS count FROM agent_device').get().count, 1)

  const logout = await logoutDesktopSession({
    serverUrl,
    sessionToken: second.sessionToken,
  })
  assert.equal(logout.loggedOut, true)
  const loggedOutRuntime = await request(runtime, '/api/runtime', {
    cookie: `trellis_team_session=${second.sessionToken}`,
  })
  assert.equal(loggedOutRuntime.status, 200)
  assert.equal(loggedOutRuntime.body.authenticated, false)
})

test('错误密码不创建配置、会话或设备', async (t) => {
  const { runtime, serverUrl } = await startRuntime(t)
  const root = await withTempRoot(t, 'trellis-desktop-login-password-')
  await assert.rejects(
    loginDesktop({
      serverUrl,
      username: 'sysadmin',
      password: 'wrong-password',
      deviceName: 'Windows 桌面',
      root,
      secureDirectory: false,
      credentialStore: {
        async loadCredential() {
          throw new Error('credential missing')
        },
        async saveCredential() {},
      },
    }),
    (error) =>
      error instanceof AgentError &&
      error.code === AGENT_ERROR_CODE.HTTP_ERROR &&
      /用户名或密码错误/.test(error.message),
  )
  assert.equal(runtime.db.prepare('SELECT COUNT(*) AS count FROM agent_device').get().count, 0)
  assert.equal(fs.existsSync(path.join(root, 'config.json')), false)
})

test('首次登录需要改密时只建立会话，并清除旧客户端设备', async (t) => {
  const { runtime, serverUrl, teamId } = await startRuntime(t, {
    users: [
      {
        username: 'pending-user',
        displayName: '待改密用户',
        mustChangePassword: true,
      },
    ],
  })
  const root = await withTempRoot(t, 'trellis-desktop-login-pending-')
  const store = new ConfigStore(root, { secureDirectory: false })
  await store.saveConfig({
    schemaVersion: 2,
    revision: 'd'.repeat(32),
    serverUrl,
    caFile: null,
    agentId: 'legacy-pending-agent',
    deviceName: '旧客户端设备',
    username: 'pending-user',
    teamId: null,
    teams: [{ id: teamId, name: '旧团队', role: 'member' }],
    protocolVersion: 3,
    agentVersion: '0.1.0',
    pairedAt: new Date().toISOString(),
    bindings: [],
  })
  const result = await loginDesktop({
    serverUrl,
    username: 'pending-user',
    password: 'Legacy-Password-123',
    deviceName: 'Windows 桌面',
    root,
    secureDirectory: false,
    credentialStore: {
      async loadCredential() {
        throw new Error('credential missing')
      },
      async saveCredential() {},
    },
    forceNew: true,
  })
  assert.equal(result.mustChangePassword, true)
  assert.equal(result.deviceReady, false)
  assert.match(result.sessionToken, /^[A-Za-z0-9_-]{16,}$/)
  assert.equal(runtime.db.prepare('SELECT COUNT(*) AS count FROM agent_device').get().count, 0)
  assert.equal(fs.existsSync(path.join(root, 'config.json')), false)
  assert.equal(fs.existsSync(path.join(root, 'credential.dpapi')), false)
})

test('设备 heartbeat 网络失败不会被误判为凭证失效并重复注册', async (t) => {
  const { runtime, serverUrl } = await startRuntime(t)
  const root = await withTempRoot(t, 'trellis-desktop-login-network-')
  let savedCredential = null
  const credentialStore = {
    async saveCredential(value) {
      savedCredential = value
    },
    async loadCredential() {
      if (!savedCredential) throw new Error('credential missing')
      return savedCredential
    },
  }
  await loginDesktop({
    serverUrl,
    username: 'sysadmin',
    password: 'Legacy-Password-123',
    deviceName: 'Windows 桌面',
    root,
    secureDirectory: false,
    credentialStore,
  })
  assert.equal(runtime.db.prepare('SELECT COUNT(*) AS count FROM agent_device').get().count, 1)

  await assert.rejects(
    loginDesktop({
      serverUrl,
      username: 'sysadmin',
      password: 'Legacy-Password-123',
      deviceName: 'Windows 桌面',
      root,
      secureDirectory: false,
      credentialStore,
      apiClientFactory: () => ({
        async heartbeat() {
          throw new AgentError(AGENT_ERROR_CODE.NETWORK_ERROR, '模拟网络中断')
        },
      }),
    }),
    (error) => error instanceof AgentError && error.code === AGENT_ERROR_CODE.NETWORK_ERROR,
  )
  assert.equal(runtime.db.prepare('SELECT COUNT(*) AS count FROM agent_device').get().count, 1)
  assert.equal(fs.existsSync(path.join(root, 'config.json')), true)
})

test('--force-new 替换旧设备时不继承旧账号本地关联', async (t) => {
  const { runtime, serverUrl, teamId } = await startRuntime(t)
  const root = await withTempRoot(t, 'trellis-desktop-login-force-new-')
  const store = new ConfigStore(root, { secureDirectory: false })
  await store.saveConfig({
    schemaVersion: 2,
    revision: 'a'.repeat(32),
    serverUrl,
    caFile: null,
    agentId: 'legacy-agent',
    deviceName: '旧设备',
    username: 'sysadmin',
    teamId: null,
    teams: [{ id: teamId, name: '旧团队', role: 'member' }],
    protocolVersion: 3,
    agentVersion: '0.1.0',
    pairedAt: new Date().toISOString(),
    bindings: [
      {
        localId: 'legacy-binding',
        serverBindingId: 'legacy-server-binding',
        taskSpaceId: 'legacy-task-space',
        projectId: 'legacy-project',
        repoPath: path.join(root, 'legacy-repo'),
        branchName: 'main',
        teamId,
        remoteIdentityKey: 'b'.repeat(64),
        localRepoKey: 'c'.repeat(64),
        displayName: '旧仓库',
        createdAt: new Date().toISOString(),
        allowFileRemote: false,
        readOnly: false,
        syncStatus: 'approved',
        liveSyncStatus: 'ready',
        liveSyncError: null,
        lastSyncedAt: null,
        lastHead: null,
        lastError: null,
        lastErrorCode: null,
      },
    ],
  })
  let savedCredential = null
  const result = await loginDesktop({
    serverUrl,
    username: 'sysadmin',
    password: 'Legacy-Password-123',
    deviceName: '新设备',
    root,
    secureDirectory: false,
    forceNew: true,
    credentialStore: {
      async loadCredential() {
        throw new Error('旧凭证不应被读取')
      },
      async saveCredential(value) {
        savedCredential = value
      },
    },
  })
  assert.equal(result.deviceReady, true)
  assert.ok(savedCredential)
  const config = await store.readConfig({ allowMissing: false })
  assert.notEqual(config.agentId, 'legacy-agent')
  assert.deepEqual(config.bindings, [])
  assert.equal(runtime.db.prepare('SELECT COUNT(*) AS count FROM agent_device').get().count, 1)
})

test('登录 Cookie 与会话错误严格校验', async () => {
  assert.equal(
    parseSessionCookie({
      'set-cookie': ['trellis_team_session=abcdefghijklmnop; Path=/; HttpOnly'],
    }),
    'abcdefghijklmnop',
  )
  assert.throws(() => parseSessionCookie({ 'set-cookie': [] }), /缺少会话 Cookie/)
  assert.throws(
    () =>
      parseSessionCookie({
        'set-cookie': [
          'trellis_team_session=abcdefghijklmnop; Path=/',
          'trellis_team_session=ponmlkjihgfedcba; Path=/',
        ],
      }),
    /重复会话 Cookie/,
  )
})

test('桌面 capability 配置拆分本地登录与远程项目关联权限', () => {
  const capability = readJson('desktop/src-tauri/capabilities/main.json')
  assert.deepEqual(capability.windows, ['main'])
  assert.equal(capability.remote, undefined)
  assert.deepEqual(capability.permissions.slice().sort(), [
    'allow-app-status',
    'allow-desktop-login',
    'core:default',
  ])
  const remote = readJson('desktop/src-tauri/capabilities/board-local-association.json')
  assert.deepEqual(remote.permissions.slice().sort(), [
    'allow-associate-pending-project',
    'allow-cancel-pending-project',
    'allow-check-pending-project-push',
    'allow-desktop-sidecar-status',
    'allow-initialize-associated-project-agents',
    'allow-initialize-pending-project',
    'allow-inspect-associated-project-agents',
    'allow-inspect-local-project',
    'allow-list-local-associations',
    'allow-preflight-pending-project',
    'allow-sync-deferred-tasks',
  ])
  assert.deepEqual(remote.remote.urls, ['https://*:*', 'http://*:*'])

  const tauri = readJson('desktop/src-tauri/tauri.conf.json')
  assert.deepEqual(tauri.app.security.capabilities, [
    'main',
    'board-local-association',
    'live-control',
  ])
  assert.doesNotMatch(tauri.app.security.csp, /unsafe-eval|https:/)
})
