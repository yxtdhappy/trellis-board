import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { createUser, validatePassword } from '../server/team/auth.js'
import { createTeamRuntime } from '../server/team/http.js'

const PUBLIC_ORIGIN = 'http://127.0.0.1:4317'
const HOST = '127.0.0.1:4317'
const SILENT_LOGGER = { info() {}, warn() {}, error() {} }

function testConfig() {
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

async function login(runtime, username, password) {
  const response = await request(runtime, '/api/auth/login', {
    method: 'POST',
    body: { username, password },
  })
  assert.equal(response.status, 200, `登录失败: ${username}`)
  return cookieOf(response)
}

async function startRuntime(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-user-registration-'))
  const runtime = await createTeamRuntime({
    config: testConfig(),
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
    password: 'Legacy-Password-123',
    systemAdmin: true,
    mustChangePassword: false,
  })
  const adminCookie = await login(runtime, 'sysadmin', 'Legacy-Password-123')
  return { runtime, adminCookie }
}

async function createTeam(runtime, adminCookie, name) {
  const response = await request(runtime, '/api/admin/teams', {
    method: 'POST',
    cookie: adminCookie,
    body: { name },
  })
  assert.equal(response.status, 201)
  return response.body.team
}

test('密码策略为 6 到 1024 字节且无复杂度要求', () => {
  assert.throws(
    () => validatePassword('abcde'),
    (error) => error.status === 400 && /6 个字符/.test(error.message),
  )
  assert.equal(validatePassword('abcdef'), 'abcdef')
  assert.equal(validatePassword('123456'), '123456')
  assert.equal(validatePassword('a'.repeat(1024)), 'a'.repeat(1024))
  assert.throws(
    () => validatePassword('a'.repeat(1025)),
    (error) => error.status === 400 && /1024 字节/.test(error.message),
  )
  assert.throws(
    () => validatePassword('密码'),
    (error) => error.status === 400,
  )
})

test('管理员建号、团队分配、重置密码与跨团队隔离', async (t) => {
  const { runtime, adminCookie } = await startRuntime(t)

  const register = await request(runtime, '/api/auth/register', {
    method: 'POST',
    body: { username: 'self', password: 'abcdef' },
  })
  assert.equal(register.status, 404)
  assert.equal(
    runtime.db
      .prepare("SELECT COUNT(*) AS count FROM user_account WHERE username_key = 'self'")
      .get().count,
    0,
  )

  const teamA = await createTeam(runtime, adminCookie, 'Team A')
  const teamB = await createTeam(runtime, adminCookie, 'Team B')

  const missingPassword = await request(runtime, '/api/admin/users', {
    method: 'POST',
    cookie: adminCookie,
    body: { username: 'no-password', displayName: 'No Password' },
  })
  assert.equal(missingPassword.status, 400)

  const shortPassword = await request(runtime, '/api/admin/users', {
    method: 'POST',
    cookie: adminCookie,
    body: { username: 'short', displayName: 'Short', password: 'abcde' },
  })
  assert.equal(shortPassword.status, 400)

  const invalidTeam = await request(runtime, '/api/admin/users', {
    method: 'POST',
    cookie: adminCookie,
    body: {
      username: 'orphan',
      displayName: 'Orphan',
      password: 'abcdef',
      teamIds: ['missing-team'],
    },
  })
  assert.equal(invalidTeam.status, 404)
  assert.equal(
    runtime.db
      .prepare("SELECT COUNT(*) AS count FROM user_account WHERE username_key = 'orphan'")
      .get().count,
    0,
  )

  const createdA = await request(runtime, '/api/admin/users', {
    method: 'POST',
    cookie: adminCookie,
    body: {
      username: 'alice',
      displayName: 'Alice',
      password: 'abcdef',
      teamIds: [teamA.id],
    },
  })
  assert.equal(createdA.status, 201)
  assert.equal('temporaryPassword' in createdA.body, false)
  assert.equal(createdA.body.user.mustChangePassword, false)
  assert.deepEqual(
    createdA.body.user.teams.map((team) => team.id),
    [teamA.id],
  )
  const alice = createdA.body.user
  assert.ok(
    runtime.db.prepare('SELECT password_hash FROM user_account WHERE id = ?').get(alice.id)
      .password_hash,
  )

  const aliceLogin = await request(runtime, '/api/auth/login', {
    method: 'POST',
    body: { username: 'alice', password: 'abcdef' },
  })
  assert.equal(aliceLogin.status, 200)
  assert.equal(aliceLogin.body.user.mustChangePassword, false)
  assert.equal(aliceLogin.body.code, undefined)
  let aliceCookie = cookieOf(aliceLogin)
  assert.equal((await request(runtime, '/api/auth/me', { cookie: aliceCookie })).status, 200)
  assert.equal(
    (
      await request(runtime, '/api/admin/users', {
        method: 'POST',
        cookie: aliceCookie,
        body: { username: 'member-made', displayName: 'Member Made', password: 'abcdef' },
      })
    ).status,
    403,
  )

  const createdB = await request(runtime, '/api/admin/users', {
    method: 'POST',
    cookie: adminCookie,
    body: {
      username: 'bob',
      displayName: 'Bob',
      password: '123456',
      teamIds: [teamB.id],
    },
  })
  assert.equal(createdB.status, 201)
  const bob = createdB.body.user

  const noTeam = await request(runtime, '/api/admin/users', {
    method: 'POST',
    cookie: adminCookie,
    body: {
      username: 'noteam',
      displayName: 'No Team',
      password: 'abcdef',
    },
  })
  assert.equal(noTeam.status, 201)
  assert.deepEqual(noTeam.body.user.teams, [])
  assert.equal(
    (
      await request(runtime, '/api/auth/login', {
        method: 'POST',
        body: { username: 'noteam', password: 'abcdef' },
      })
    ).status,
    200,
  )

  const teamAdmin = await request(runtime, '/api/admin/users', {
    method: 'POST',
    cookie: adminCookie,
    body: {
      username: 'team-admin',
      displayName: 'Team Admin',
      password: 'abcdef',
      teams: [{ teamId: teamA.id, role: 'admin' }],
    },
  })
  assert.equal(teamAdmin.status, 201)
  const teamAdminCookie = await login(runtime, 'team-admin', 'abcdef')

  const teamAdminCreate = await request(runtime, '/api/admin/users', {
    method: 'POST',
    cookie: teamAdminCookie,
    body: { username: 'intruder', displayName: 'Intruder', password: 'abcdef' },
  })
  assert.equal(teamAdminCreate.status, 403)
  const teamAdminPatch = await request(runtime, `/api/admin/users/${bob.id}`, {
    method: 'PATCH',
    cookie: teamAdminCookie,
    body: { teamIds: [teamA.id] },
  })
  assert.equal(teamAdminPatch.status, 403)
  assert.equal(
    (
      await request(runtime, `/api/admin/users/${alice.id}/reset-password`, {
        method: 'POST',
        cookie: teamAdminCookie,
        body: { password: 'abcdef' },
      })
    ).status,
    403,
  )
  assert.equal(
    (
      await request(runtime, `/api/admin/users/${alice.id}`, {
        method: 'PATCH',
        cookie: teamAdminCookie,
        body: { status: 'disabled' },
      })
    ).status,
    403,
  )
  assert.equal(
    (
      await request(runtime, `/api/admin/users/${alice.id}/teams`, {
        method: 'PUT',
        cookie: teamAdminCookie,
        body: { teams: [{ teamId: teamB.id, role: 'member' }] },
      })
    ).status,
    403,
  )

  const teamUsers = await request(runtime, '/api/admin/users', {
    cookie: teamAdminCookie,
  })
  assert.equal(teamUsers.status, 200)
  assert.deepEqual(teamUsers.body.users.map((user) => user.username).sort(), [
    'alice',
    'team-admin',
  ])
  assert.equal(
    teamUsers.body.users.some((user) => user.username === 'bob'),
    false,
  )

  const allUsers = await request(runtime, '/api/admin/users', { cookie: adminCookie })
  assert.deepEqual(allUsers.body.users.map((user) => user.username).sort(), [
    'alice',
    'bob',
    'noteam',
    'sysadmin',
    'team-admin',
  ])

  const updated = await request(runtime, `/api/admin/users/${alice.id}`, {
    method: 'PATCH',
    cookie: adminCookie,
    body: { teamIds: [teamB.id], status: 'disabled', displayName: 'Alice B' },
  })
  assert.equal(updated.status, 200)
  assert.deepEqual(
    updated.body.user.teams.map((team) => team.id),
    [teamB.id],
  )
  assert.equal(updated.body.user.displayName, 'Alice B')
  assert.equal((await request(runtime, '/api/auth/me', { cookie: aliceCookie })).status, 401)
  assert.equal(
    (
      await request(runtime, '/api/auth/login', {
        method: 'POST',
        body: { username: 'alice', password: 'abcdef' },
      })
    ).status,
    401,
  )

  const enabled = await request(runtime, `/api/admin/users/${alice.id}`, {
    method: 'PATCH',
    cookie: adminCookie,
    body: { status: 'active' },
  })
  assert.equal(enabled.status, 200)
  aliceCookie = await login(runtime, 'alice', 'abcdef')

  const resetShort = await request(runtime, `/api/admin/users/${alice.id}/reset-password`, {
    method: 'POST',
    cookie: adminCookie,
    body: { password: '12345' },
  })
  assert.equal(resetShort.status, 400)
  assert.equal((await request(runtime, '/api/auth/me', { cookie: aliceCookie })).status, 200)

  const reset = await request(runtime, `/api/admin/users/${alice.id}/reset-password`, {
    method: 'POST',
    cookie: adminCookie,
    body: { password: 'newpass' },
  })
  assert.equal(reset.status, 200)
  assert.equal('temporaryPassword' in reset.body, false)
  assert.equal(reset.body.user.mustChangePassword, false)
  assert.equal((await request(runtime, '/api/auth/me', { cookie: aliceCookie })).status, 401)
  assert.equal(
    (
      await request(runtime, '/api/auth/login', {
        method: 'POST',
        body: { username: 'alice', password: 'abcdef' },
      })
    ).status,
    401,
  )
  assert.equal(
    (
      await request(runtime, '/api/auth/login', {
        method: 'POST',
        body: { username: 'alice', password: 'newpass' },
      })
    ).status,
    200,
  )

  const legacyLogin = await request(runtime, '/api/auth/login', {
    method: 'POST',
    body: { username: 'sysadmin', password: 'Legacy-Password-123' },
  })
  assert.equal(legacyLogin.status, 200)

  const auditRows = runtime.db
    .prepare('SELECT action, detail_json FROM audit_event ORDER BY id')
    .all()
  const actions = auditRows.map((row) => row.action)
  assert.ok(actions.includes('user_created'))
  assert.ok(actions.includes('user_updated'))
  assert.ok(actions.includes('user_password_reset'))
  assert.ok(actions.includes('team_member_added'))
  assert.ok(actions.includes('team_member_removed'))
  assert.equal(actions.filter((action) => action === 'user_created').length, 4)
  assert.equal(
    auditRows.some((row) => /abcdef|newpass|Legacy-Password-123/.test(row.detail_json)),
    false,
  )
})
