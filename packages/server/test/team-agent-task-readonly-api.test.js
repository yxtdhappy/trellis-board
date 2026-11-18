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
    origin = PUBLIC_ORIGIN,
  } = {},
) {
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
    const req = http.request(
      { hostname: '127.0.0.1', port: address.port, path: pathname, method, headers },
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

async function loginAndEnroll(runtime, username, password, deviceName) {
  const session = cookieOf(
    await request(runtime, '/api/auth/login', { method: 'POST', body: { username, password } }),
  )
  assert.ok(session)
  const pairing = await request(runtime, '/api/team/pairing-codes', {
    method: 'POST',
    cookie: session,
    body: { teamId: 'team-1' },
  })
  assert.equal(pairing.status, 201)
  const enrolled = await request(runtime, '/api/agent/enroll', {
    method: 'POST',
    origin: null,
    body: {
      protocolVersion: 3,
      agentVersion: '0.1.0',
      platform: 'win32',
      deviceName,
      pairingCode: pairing.body.pairingCode,
    },
  })
  assert.equal(enrolled.status, 201)
  return enrolled.body.credential
}

test('Agent 只读任务接口按任务空间返回未归档任务与文件内容', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-agent-readonly-'))
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

  const aliceCredential = await loginAndEnroll(runtime, 'alice', 'Alice-Password-123', 'Alice 设备')
  const bobCredential = await loginAndEnroll(runtime, 'bob', 'Bob-Password-123', 'Bob 设备')

  const attached = await request(runtime, '/api/agent/task-spaces/attach', {
    method: 'POST',
    agentCredential: aliceCredential,
    body: {
      remoteUrl: 'https://example.com/team/repo.git',
      branchName: 'main',
      teamId: 'team-1',
      developerId: 'alice',
      displayName: '示例项目',
      localRepoKey: 'a'.repeat(64),
    },
  })
  assert.equal(attached.status, 201)
  const taskSpaceId = attached.body.taskSpace.id
  runtime.services.taskSpaces.upsertMember(runtime.services.taskSpaces.actorContext(alice.id), {
    projectId: attached.body.project.id,
    userId: bob.id,
    role: 'member',
    trellisDevId: 'bob',
  })
  const bobBinding = await request(runtime, '/api/agent/task-spaces/attach', {
    method: 'POST',
    agentCredential: bobCredential,
    body: {
      remoteUrl: 'https://example.com/team/repo.git',
      branchName: 'main',
      teamId: 'team-1',
      developerId: 'bob',
      displayName: '示例项目',
      localRepoKey: 'b'.repeat(64),
    },
  })
  assert.equal(bobBinding.status, 201)
  assert.equal(bobBinding.body.taskSpace.id, taskSpaceId)

  const uploaded = await request(
    runtime,
    `/api/agent/task-spaces/${encodeURIComponent(taskSpaceId)}/changes`,
    {
      method: 'POST',
      agentCredential: aliceCredential,
      body: {
        batchId: 'batch-readonly-1',
        clientSequence: 1,
        observedBranchName: 'main',
        files: [
          {
            path: '.trellis/tasks/11-17-shared/task.json',
            content: JSON.stringify({ id: 'shared', title: '共享任务', branch: 'main' }),
          },
          { path: '.trellis/tasks/11-17-shared/prd.md', content: '# 共享任务\n' },
        ],
      },
    },
  )
  assert.equal(uploaded.status, 200, JSON.stringify(uploaded.body))
  const uploadedSecond = await request(
    runtime,
    `/api/agent/task-spaces/${encodeURIComponent(taskSpaceId)}/changes`,
    {
      method: 'POST',
      agentCredential: aliceCredential,
      body: {
        batchId: 'batch-readonly-2',
        clientSequence: 2,
        observedBranchName: 'main',
        files: [
          {
            path: '.trellis/tasks/11-17-gone/task.json',
            content: JSON.stringify({ id: 'gone', title: '归档任务', branch: 'main' }),
          },
        ],
      },
    },
  )
  assert.equal(uploadedSecond.status, 200, JSON.stringify(uploadedSecond.body))

  runtime.db
    .prepare(
      `UPDATE sync_task SET archived = 1, relative_dir = ?
       WHERE task_space_id = ? AND task_id = 'gone'`,
    )
    .run('.trellis/tasks/archive/2026-11/11-17-gone', taskSpaceId)

  await runtime.services.taskSpaceIndex.materializeNow(taskSpaceId)

  const list = await request(
    runtime,
    `/api/agent/task-spaces/${encodeURIComponent(taskSpaceId)}/tasks`,
    { agentCredential: bobCredential },
  )
  assert.equal(list.status, 200, JSON.stringify(list.body))
  assert.deepEqual(
    list.body.tasks.map((task) => task.taskId),
    ['shared'],
  )
  assert.deepEqual(list.body.tasks[0], {
    taskId: 'shared',
    taskDir: '.trellis/tasks/11-17-shared',
    title: '共享任务',
    stage: 'planning',
    assigneeUserId: alice.id,
    createdByUserId: alice.id,
    updatedAt: list.body.tasks[0].updatedAt,
  })

  const files = await request(
    runtime,
    `/api/agent/task-spaces/${encodeURIComponent(taskSpaceId)}/tasks/shared/files`,
    { agentCredential: bobCredential },
  )
  assert.equal(files.status, 200)
  assert.equal(files.body.taskId, 'shared')
  assert.equal(files.body.taskDir, '.trellis/tasks/11-17-shared')
  assert.deepEqual(
    files.body.files.map((file) => file.path),
    ['.trellis/tasks/11-17-shared/prd.md', '.trellis/tasks/11-17-shared/task.json'],
  )
  assert.equal(files.body.files[0].content, '# 共享任务\n')

  const archivedFiles = await request(
    runtime,
    `/api/agent/task-spaces/${encodeURIComponent(taskSpaceId)}/tasks/gone/files`,
    { agentCredential: bobCredential },
  )
  assert.equal(archivedFiles.status, 404)
})
