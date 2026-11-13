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

function request(runtime, pathname, { method = 'GET', body = null, cookie = null, agentCredential = null, origin = PUBLIC_ORIGIN } = {}) {
  const address = runtime.address()
  const payload = body == null ? null : JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const headers = { host: HOST }
    if (payload != null) {
      headers['content-type'] = 'application/json'
      headers['content-length'] = Buffer.byteLength(payload)
    }
    if (origin != null && method !== 'GET') headers.origin = origin
    if (cookie) headers.cookie = cookie
    if (agentCredential) headers.authorization = `Bearer ${agentCredential}`
    const req = http.request({ hostname: '127.0.0.1', port: address.port, path: pathname, method, headers }, (response) => {
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
    })
    req.on('error', reject)
    if (payload != null) req.write(payload)
    req.end()
  })
}

const cookieOf = (response) => String((response.headers['set-cookie'] || [])[0] || '').split(';')[0]

test('repro: scope=mine 使用项目配置的 trellis developer id', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-mine-repro-'))
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
  runtime.db.prepare(`INSERT INTO team(id, name, slug, status, created_at, updated_at) VALUES ('team-1','团队一','team-1','active',?,?)`).run(now, now)
  const alice = await createUser(runtime.db, { username: 'alice', displayName: 'Alice', password: 'Alice-Password-123', systemAdmin: false, mustChangePassword: false })
  const bob = await createUser(runtime.db, { username: 'bob', displayName: 'Bob', password: 'Bob-Password-123', systemAdmin: false, mustChangePassword: false })
  for (const user of [alice, bob]) {
    runtime.db.prepare(`INSERT INTO team_member(team_id,user_id,role,created_at,updated_at) VALUES ('team-1',?,'member',?,?)`).run(user.id, now, now)
  }

  const aliceLogin = await request(runtime, '/api/auth/login', { method: 'POST', body: { username: 'alice', password: 'Alice-Password-123' } })
  const aliceSession = cookieOf(aliceLogin)
  const pairing = await request(runtime, '/api/team/pairing-codes', { method: 'POST', cookie: aliceSession, body: { teamId: 'team-1' } })
  const enrolled = await request(runtime, '/api/agent/enroll', {
    method: 'POST',
    origin: null,
    body: { protocolVersion: 3, agentVersion: '0.1.0', platform: 'win32', deviceName: '设备', pairingCode: pairing.body.pairingCode },
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

  const push = await request(runtime, `/api/agent/task-spaces/${encodeURIComponent(taskSpaceId)}/changes`, {
    method: 'POST',
    agentCredential: enrolled.body.credential,
    body: {
      batchId: 'batch-1',
      clientSequence: 1,
      observedBranchName: 'main',
      files: [
        {
          path: '.trellis/tasks/01-a/task.json',
          content: `${JSON.stringify({ id: 'a', title: '我负责的任务', status: 'planning', assignee: 'project-dev-alice', priority: 'P2', branch: 'main' }, null, 2)}\n`,
          baseSha256: null,
        },
      ],
    },
  })
  assert.equal(push.status, 200, JSON.stringify(push.body))
  const push2 = await request(runtime, `/api/agent/task-spaces/${encodeURIComponent(taskSpaceId)}/changes`, {
    method: 'POST',
    agentCredential: enrolled.body.credential,
    body: {
      batchId: 'batch-2',
      clientSequence: 2,
      observedBranchName: 'main',
      files: [
        {
          path: '.trellis/tasks/01-b/task.json',
          content: `${JSON.stringify({ id: 'b', title: '别人的任务', status: 'planning', assignee: 'other-dev', priority: 'P2', branch: 'main' }, null, 2)}\n`,
          baseSha256: null,
        },
      ],
    },
  })
  assert.equal(push2.status, 200, JSON.stringify(push2.body))
  await runtime.services.taskSpaceIndex.ensureMaterialized(taskSpaceId)

  const rows = runtime.db.prepare('SELECT task_key, assignee_dev_id, assignee_user_id FROM sync_task_index WHERE task_space_id = ?').all(taskSpaceId)
  console.log('INDEX ROWS', rows)
  console.log('MEMBERS', runtime.db.prepare('SELECT user_id, role, trellis_dev_id FROM sync_project_member').all())

  const all = await request(runtime, `/api/tasks/query?taskSpaceId=${encodeURIComponent(taskSpaceId)}&limit=20`, { cookie: aliceSession })
  console.log('ALL', all.body.tasks.map((task) => [task.taskKey, task.assignee, task.assigneeUserId]))
  const mine = await request(runtime, `/api/tasks/query?taskSpaceId=${encodeURIComponent(taskSpaceId)}&scope=mine&limit=20`, { cookie: aliceSession })
  console.log('MINE', mine.status, mine.body.tasks?.map((task) => task.taskKey), mine.body.error || '')

  // 场景二：项目内 developer id 后配置（索引早于成员映射）
  const projectId = attached.body.taskSpace.projectId
  const updated = await request(runtime, `/api/projects/${encodeURIComponent(projectId)}/members`, {
    method: 'PUT',
    cookie: aliceSession,
    body: { userId: alice.id, role: 'lead', trellisDevId: 'other-dev' },
  })
  console.log('MEMBER UPDATE', updated.status, JSON.stringify(updated.body))
  const mineAfter = await request(runtime, `/api/tasks/query?taskSpaceId=${encodeURIComponent(taskSpaceId)}&scope=mine&limit=20`, { cookie: aliceSession })
  console.log('MINE AFTER MEMBER CHANGE', mineAfter.status, mineAfter.body.tasks?.map((task) => task.taskKey))
  console.log('INDEX ROWS AFTER', runtime.db.prepare('SELECT assignee_dev_id, assignee_user_id FROM sync_task_index').all())
})
