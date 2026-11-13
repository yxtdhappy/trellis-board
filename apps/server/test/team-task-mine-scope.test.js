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
const LOGGER = { info() {}, warn() {}, error() {} }

function request(
  runtime,
  pathname,
  {
    method = 'GET',
    body = null,
    cookie = null,
    agentCredential = null,
    headers = {},
    origin = PUBLIC_ORIGIN,
  } = {},
) {
  const address = runtime.address()
  const payload = body == null ? null : JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const requestHeaders = { host: HOST, ...headers }
    if (payload != null) {
      requestHeaders['content-type'] = 'application/json'
      requestHeaders['content-length'] = Buffer.byteLength(payload)
    }
    if (origin != null && method !== 'GET') requestHeaders.origin = origin
    if (cookie) requestHeaders.cookie = cookie
    if (agentCredential) requestHeaders.authorization = `Bearer ${agentCredential}`
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: address.port,
        path: pathname,
        method,
        headers: requestHeaders,
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

const cookieOf = (response) => String((response.headers['set-cookie'] || [])[0] || '').split(';')[0]

test('scope=mine 按项目当前配置的 trellis developer id 过滤', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-mine-scope-'))
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
    logger: LOGGER,
    requireAdmin: false,
  })
  await runtime.start()
  t.after(async () => {
    await runtime.stop()
    fs.rmSync(root, { recursive: true, force: true })
  })

  const now = new Date().toISOString()
  runtime.db
    .prepare(
      `INSERT INTO team(id, name, slug, status, created_at, updated_at) VALUES ('team-1','团队一','team-1','active',?,?)`,
    )
    .run(now, now)
  const alice = await createUser(runtime.db, {
    username: 'alice',
    displayName: 'Alice',
    password: 'Alice-Password-123',
    systemAdmin: false,
    mustChangePassword: false,
  })
  const bob = await createUser(runtime.db, {
    username: 'bob',
    displayName: 'Bob',
    password: 'Bob-Password-123',
    systemAdmin: false,
    mustChangePassword: false,
  })
  for (const user of [alice, bob]) {
    runtime.db
      .prepare(
        `INSERT INTO team_member(team_id,user_id,role,created_at,updated_at) VALUES ('team-1',?,'member',?,?)`,
      )
      .run(user.id, now, now)
  }

  const aliceSession = cookieOf(
    await request(runtime, '/api/auth/login', {
      method: 'POST',
      body: { username: 'alice', password: 'Alice-Password-123' },
    }),
  )
  const pairing = await request(runtime, '/api/team/pairing-codes', {
    method: 'POST',
    cookie: aliceSession,
    body: { teamId: 'team-1' },
  })
  const enrolled = await request(runtime, '/api/agent/enroll', {
    method: 'POST',
    origin: null,
    body: {
      protocolVersion: 3,
      agentVersion: '0.1.0',
      platform: 'win32',
      deviceName: '设备',
      pairingCode: pairing.body.pairingCode,
    },
  })
  assert.equal(enrolled.status, 201, JSON.stringify(enrolled.body))

  // 项目内配置的 developer id 与登录名不同，模拟“每个项目各自配置 developer id”
  const attached = await request(runtime, '/api/agent/task-spaces/attach', {
    method: 'POST',
    agentCredential: enrolled.body.credential,
    body: {
      remoteUrl: 'https://example.com/team/repo.git',
      branchName: 'main',
      teamId: 'team-1',
      developerId: 'project-dev-alice',
      displayName: '示例项目',
      localRepoKey: 'a'.repeat(64),
    },
  })
  assert.equal(attached.status, 201, JSON.stringify(attached.body))
  const taskSpaceId = attached.body.taskSpace.id
  const projectId = attached.body.taskSpace.projectId

  await request(runtime, '/api/agent/heartbeat', {
    method: 'POST',
    agentCredential: enrolled.body.credential,
    body: {
      protocolVersion: 3,
      agentId: enrolled.body.agentId,
      agentVersion: '0.1.0',
      deviceName: '设备',
      listenerReportVersion: 1,
      listeningTaskSpaceIds: [taskSpaceId],
    },
  })

  const pushTask = (batchId, clientSequence, dir, task) =>
    request(runtime, `/api/agent/task-spaces/${encodeURIComponent(taskSpaceId)}/changes`, {
      method: 'POST',
      agentCredential: enrolled.body.credential,
      body: {
        batchId,
        clientSequence,
        observedBranchName: 'main',
        files: [
          {
            path: `.trellis/tasks/${dir}/task.json`,
            content: `${JSON.stringify(task, null, 2)}\n`,
            baseSha256: null,
          },
        ],
      },
    })

  const pushed = await pushTask('batch-1', 1, '01-a', {
    id: 'a',
    title: '我负责的任务',
    status: 'planning',
    assignee: 'project-dev-alice',
    priority: 'P2',
    branch: 'main',
  })
  assert.equal(pushed.status, 200, JSON.stringify(pushed.body))
  const pushedOther = await pushTask('batch-2', 2, '01-b', {
    id: 'b',
    title: '别人的任务',
    status: 'planning',
    assignee: 'other-dev',
    priority: 'P2',
    branch: 'main',
  })
  assert.equal(pushedOther.status, 200, JSON.stringify(pushedOther.body))
  await runtime.services.taskSpaceIndex.ensureMaterialized(taskSpaceId)

  const queryPath = `/api/tasks/query?taskSpaceId=${encodeURIComponent(taskSpaceId)}&scope=mine&limit=20`
  const mineKeys = async (headers = {}) => {
    const response = await request(runtime, queryPath, { cookie: aliceSession, headers })
    assert.equal(response.status, 200, JSON.stringify(response.body))
    return {
      keys: response.body.tasks.map((task) => task.taskKey).sort(),
      etag: response.headers.etag,
    }
  }
  const setMember = (trellisDevId) =>
    request(runtime, `/api/projects/${encodeURIComponent(projectId)}/members`, {
      method: 'PUT',
      cookie: aliceSession,
      body: { userId: alice.id, role: 'lead', trellisDevId },
    })

  await t.test('成员 dev id 在索引前配置时命中', async () => {
    const { keys } = await mineKeys()
    assert.deepEqual(
      keys.map((key) => key.split('/').pop()),
      ['01-a'],
    )
  })

  await t.test('成员 dev id 变更后立即跟随，不依赖重建索引', async () => {
    const before = await mineKeys()
    assert.ok(before.etag, 'mine 查询应返回 etag')

    const updated = await setMember('other-dev')
    assert.equal(updated.status, 200, JSON.stringify(updated.body))

    const after = await mineKeys()
    const dirs = after.keys.map((key) => key.split('/').pop())
    assert.deepEqual(dirs, ['01-b'])

    const stale = await mineKeys({ 'if-none-match': before.etag })
    assert.equal(stale.keys.length, 1, '成员变更后旧 etag 不应命中 304')
    assert.notEqual(stale.etag, before.etag)
  })

  await t.test('成员 dev id 与任务 assignee 大小写不敏感', async () => {
    const updated = await setMember('PROJECT-DEV-ALICE')
    assert.equal(updated.status, 200, JSON.stringify(updated.body))
    const { keys } = await mineKeys()
    assert.deepEqual(
      keys.map((key) => key.split('/').pop()),
      ['01-a'],
    )
  })
})
