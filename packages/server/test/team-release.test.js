import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createUser } from '../team/auth.js'
import { createTeamRuntime } from '../team/http.js'

const PUBLIC_ORIGIN = 'http://127.0.0.1:4317'
const HOST = '127.0.0.1:4317'
const PASSWORD = 'Release-Password-123'
const SILENT_LOGGER = { info() {}, warn() {}, error() {} }

function request(runtime, pathname, { method = 'GET', body = null, cookie = null } = {}) {
  const payload = body == null ? null : JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const headers = { host: HOST }
    if (payload != null) {
      headers['content-type'] = 'application/json'
      headers['content-length'] = Buffer.byteLength(payload)
    }
    if (method !== 'GET') headers.origin = PUBLIC_ORIGIN
    if (cookie) headers.cookie = cookie
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: runtime.address().port,
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

test('Team 发布边界不再依赖服务端 Git，命令成功前不生成正式任务', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-team-release-'))
  const dataDir = path.join(root, 'data')
  const runtime = await createTeamRuntime({
    config: {
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
    },
    databaseFile: path.join(dataDir, 'board.sqlite'),
    dataDir,
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
  runtime.db
    .prepare(`
      INSERT INTO team(id, name, slug, status, created_at, updated_at)
      VALUES ('team-1', '发布团队', 'release-team', 'active', ?, ?)
    `)
    .run(now, now)
  const user = await createUser(runtime.db, {
    username: 'release-user',
    displayName: '发布用户',
    password: PASSWORD,
    systemAdmin: true,
    mustChangePassword: false,
  })
  runtime.db
    .prepare(`
      INSERT INTO team_member(team_id, user_id, role, created_at, updated_at)
      VALUES ('team-1', ?, 'admin', ?, ?)
    `)
    .run(user.id, now, now)
  const actor = runtime.services.taskSpaces.actorContext(user.id)
  const pairing = runtime.services.agentService.createPairingCode(actor, { teamId: 'team-1' })
  const enrolled = runtime.services.agentService.enroll(
    {
      protocolVersion: 3,
      agentVersion: '0.1.0',
      platform: 'win32',
      deviceName: '发布设备',
      pairingCode: pairing.pairingCode,
    },
    { ip: 'release' },
  )
  const attached = runtime.services.taskSpaces.attach(user.id, enrolled.agentId, {
    remoteUrl: 'https://example.com/release/repo.git',
    branchName: 'main',
    displayName: '发布项目',
    teamId: 'team-1',
    developerId: 'release-user',
    localRepoKey: 'a'.repeat(64),
  })
  const authenticated = runtime.services.agentService.authenticate({
    headers: { authorization: `Bearer ${enrolled.credential}` },
  })
  runtime.services.agentService.heartbeat(authenticated, {
    protocolVersion: 3,
    agentId: enrolled.agentId,
    agentVersion: '0.1.0',
    deviceName: '发布设备',
    listenerReportVersion: 1,
    listeningTaskSpaceIds: [attached.taskSpace.id],
  })
  const operation = runtime.services.taskCommands.enqueue(actor, {
    commandType: 'create_task',
    taskSpaceId: attached.taskSpace.id,
    assigneeUserId: user.id,
    title: '发布后创建',
    priority: 'P2',
    slug: 'release-created',
    idempotencyKey: 'release-command-1',
  })
  assert.equal(operation.statusCode, 202)
  assert.equal(operation.operation.status, 'pending')
  assert.equal(runtime.db.prepare('SELECT COUNT(*) AS count FROM sync_task_index').get().count, 0)
  assert.equal(fs.existsSync(path.join(dataDir, 'projects')), false)

  const login = await request(runtime, '/api/auth/login', {
    method: 'POST',
    body: { username: user.username, password: PASSWORD },
  })
  assert.equal(login.status, 200)
  const cookie = String((login.headers['set-cookie'] || [])[0] || '').split(';')[0]
  for (const [pathname, method] of [
    ['/api/git-operations/missing/retry', 'POST'],
    ['/api/admin/git-credentials', 'GET'],
    ['/api/admin/projects/probe', 'POST'],
    ['/api/team/live-revision', 'GET'],
  ]) {
    const response = await request(runtime, pathname, {
      method,
      cookie,
      body: method === 'POST' ? {} : null,
    })
    assert.equal(response.status, 404, pathname)
  }
})
