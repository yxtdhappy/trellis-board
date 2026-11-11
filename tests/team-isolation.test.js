import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createUser } from '../server/team/auth.js'
import { createTeamRuntime } from '../server/team/http.js'

const PASSWORD = 'Isolation-Password-123'
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
          let parsed = null
          try {
            parsed = text ? JSON.parse(text) : null
          } catch {
            parsed = text
          }
          resolve({ status: response.statusCode, headers: response.headers, body: parsed })
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

async function login(runtime, username) {
  return request(runtime, '/api/auth/login', {
    method: 'POST',
    body: { username, password: PASSWORD },
  })
}

async function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-team-isolation-'))
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
  const now = new Date().toISOString()
  for (const [id, name] of [
    ['team-a', '团队 A'],
    ['team-b', '团队 B'],
  ]) {
    runtime.db
      .prepare(`
        INSERT INTO team(id, name, slug, status, created_at, updated_at)
        VALUES (?, ?, ?, 'active', ?, ?)
      `)
      .run(id, name, id, now, now)
  }
  const owner = await createUser(runtime.db, {
    username: 'owner-a',
    displayName: '团队 A 成员',
    password: PASSWORD,
    mustChangePassword: false,
  })
  const outsider = await createUser(runtime.db, {
    username: 'member-b',
    displayName: '团队 B 成员',
    password: PASSWORD,
    mustChangePassword: false,
  })
  runtime.db
    .prepare(`
      INSERT INTO team_member(team_id, user_id, role, created_at, updated_at)
      VALUES ('team-a', ?, 'admin', ?, ?)
    `)
    .run(owner.id, now, now)
  runtime.db
    .prepare(`
      INSERT INTO team_member(team_id, user_id, role, created_at, updated_at)
      VALUES ('team-b', ?, 'admin', ?, ?)
    `)
    .run(outsider.id, now, now)

  runtime.db
    .prepare(`
      INSERT INTO sync_project(
        id, name, remote_url, remote_identity_hash, owner_team_id, status,
        created_by_user_id, created_by_agent_id, created_at, updated_at
      ) VALUES ('project-a', '隔离项目', 'https://example.com/a/repo.git', 'hash-a',
        'team-a', 'active', ?, NULL, ?, ?)
    `)
    .run(owner.id, now, now)
  runtime.db
    .prepare(`
      INSERT INTO sync_project_team_access(
        project_id, team_id, access_role, created_by_user_id, created_at
      ) VALUES ('project-a', 'team-a', 'owner', ?, ?)
    `)
    .run(owner.id, now)
  runtime.db
    .prepare(`
      INSERT INTO sync_task_space(
        id, project_id, branch_name, status, revision, indexed_revision,
        created_by_user_id, created_by_agent_id, created_at, updated_at
      ) VALUES ('space-a', 'project-a', 'main', 'active', 0, 0, ?, NULL, ?, ?)
    `)
    .run(owner.id, now, now)
  const ownerLogin = await login(runtime, owner.username)
  const outsiderLogin = await login(runtime, outsider.username)
  assert.equal(ownerLogin.status, 200)
  assert.equal(outsiderLogin.status, 200)
  return {
    runtime,
    owner,
    outsider,
    ownerCookie: cookieOf(ownerLogin),
    outsiderCookie: cookieOf(outsiderLogin),
  }
}

test('多团队项目列表、邀请和任务读取按团队访问关系隔离', async (t) => {
  const context = await setup(t)
  const before = await request(context.runtime, '/api/team/projects', {
    cookie: context.outsiderCookie,
  })
  assert.equal(before.status, 200)
  assert.deepEqual(before.body.projects, [])
  assert.equal(
    (
      await request(context.runtime, '/api/tasks/query?taskSpaceId=space-a', {
        cookie: context.outsiderCookie,
      })
    ).status,
    404,
  )

  context.runtime.services.taskSpaces.inviteTeam(
    context.runtime.services.taskSpaces.actorContext(context.owner.id),
    'project-a',
    'team-b',
  )
  const after = await request(context.runtime, '/api/team/projects', {
    cookie: context.outsiderCookie,
  })
  assert.equal(after.status, 200)
  assert.equal(after.body.projects.length, 1)
  assert.equal(after.body.projects[0].id, 'project-a')
  assert.equal(
    (
      await request(context.runtime, '/api/tasks/query?taskSpaceId=space-a', {
        cookie: context.outsiderCookie,
      })
    ).status,
    200,
  )
})

test('Session 缺失、CSRF 失败和团队停用分别被明确拒绝', async (t) => {
  const context = await setup(t)
  const missingSession = await request(context.runtime, '/api/team/projects')
  assert.equal(missingSession.status, 401)

  const missingOrigin = await new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      username: context.owner.username,
      password: PASSWORD,
    })
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: context.runtime.address().port,
        path: '/api/auth/login',
        method: 'POST',
        headers: {
          host: HOST,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        },
      },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => {
          resolve({
            status: response.statusCode,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
          })
        })
      },
    )
    req.on('error', reject)
    req.end(payload)
  })
  assert.equal(missingOrigin.status, 403)
  assert.equal(missingOrigin.body.code, 'CSRF_REJECTED')

  context.runtime.db.prepare("UPDATE team SET status = 'disabled' WHERE id = 'team-a'").run()
  const disabled = await request(context.runtime, '/api/team/projects', {
    cookie: context.ownerCookie,
  })
  assert.equal(disabled.status, 200)
  assert.deepEqual(disabled.body.projects, [])
})
