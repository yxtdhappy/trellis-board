import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createUser } from '../server/team/auth.js'
import {
  createTeamRuntime,
  MAX_JSON_BYTES,
  MAX_LIVE_BATCH_BYTES,
  readJsonBody,
} from '../server/team/http.js'
import { TASK_SNAPSHOT_MAX_TRANSPORT_BYTES } from '../shared/task-snapshot.js'

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

function cookie(response) {
  return String((response.headers['set-cookie'] || [])[0] || '').split(';')[0]
}

test('Agent 大批次运输体超过 96 MiB 时返回 413', async () => {
  assert.equal(MAX_LIVE_BATCH_BYTES, TASK_SNAPSHOT_MAX_TRANSPORT_BYTES)
  await assert.rejects(
    () =>
      readJsonBody(
        {
          headers: {
            'content-length': String(TASK_SNAPSHOT_MAX_TRANSPORT_BYTES + 1),
          },
        },
        MAX_LIVE_BATCH_BYTES,
      ),
    (error) => error.status === 413 && error.code === 'BODY_TOO_LARGE',
  )
  await assert.rejects(
    () =>
      readJsonBody({
        headers: {
          'content-length': String(MAX_JSON_BYTES + 1),
        },
      }),
    (error) => error.status === 413 && error.code === 'BODY_TOO_LARGE',
  )
})

test('Team HTTP 使用任务空间快照和在线 Agent 命令，不暴露旧 Git 路由', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-gitless-http-'))
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
    .prepare(`
      INSERT INTO team(id, name, slug, status, created_at, updated_at)
      VALUES ('team-1', '团队一', 'team-1', 'active', ?, ?)
    `)
    .run(now, now)
  await createUser(runtime.db, {
    username: 'owner',
    displayName: '项目负责人',
    password: 'Owner-Password-123',
    systemAdmin: true,
    mustChangePassword: false,
  })
  runtime.db
    .prepare(`
      INSERT INTO team_member(team_id, user_id, role, created_at, updated_at)
      SELECT 'team-1', id, 'member', ?, ? FROM user_account WHERE username = 'owner'
    `)
    .run(now, now)

  const login = await request(runtime, '/api/auth/login', {
    method: 'POST',
    body: { username: 'owner', password: 'Owner-Password-123' },
  })
  assert.equal(login.status, 200)
  const session = cookie(login)

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
      deviceName: '测试设备',
      pairingCode: pairing.body.pairingCode,
    },
  })
  assert.equal(enrolled.status, 201)

  const syncTables = [
    'sync_project',
    'sync_project_team_access',
    'sync_project_member',
    'sync_task_space',
    'sync_agent_binding',
    'sync_agent_cursor',
  ]
  const syncCounts = () =>
    Object.fromEntries(
      syncTables.map((table) => [
        table,
        Number(runtime.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count),
      ]),
    )
  const emptyCounts = syncCounts()
  const emptyPreflight = await request(runtime, '/api/agent/task-spaces/preflight', {
    method: 'POST',
    agentCredential: enrolled.body.credential,
    body: {
      remoteUrl: 'https://example.com/team/repo.git',
      branchName: 'main',
      teamId: 'team-1',
    },
  })
  assert.equal(emptyPreflight.status, 200)
  assert.equal(emptyPreflight.body.status, 'new')
  assert.deepEqual(emptyPreflight.body.tasks, [])
  assert.deepEqual(syncCounts(), emptyCounts)

  const resolve = await request(runtime, '/api/agent/task-spaces/resolve', {
    method: 'POST',
    agentCredential: enrolled.body.credential,
    body: {
      remoteUrl: 'https://example.com/team/repo.git',
      branchName: 'main',
      teamId: 'team-1',
    },
  })
  assert.equal(resolve.status, 200)
  assert.equal(resolve.body.status, 'new')

  const attached = await request(runtime, '/api/agent/task-spaces/attach', {
    method: 'POST',
    agentCredential: enrolled.body.credential,
    body: {
      remoteUrl: 'https://example.com/team/repo.git',
      branchName: 'main',
      teamId: 'team-1',
      developerId: 'owner',
      displayName: '示例项目',
      localRepoKey: 'a'.repeat(64),
    },
  })
  assert.equal(attached.status, 201)
  const taskSpaceId = attached.body.taskSpace.id

  const missingObservedBranch = await request(
    runtime,
    `/api/agent/task-spaces/${encodeURIComponent(taskSpaceId)}/changes`,
    {
      method: 'POST',
      agentCredential: enrolled.body.credential,
      body: {
        batchId: 'batch-missing-branch',
        clientSequence: 1,
        files: [
          {
            path: '.trellis/tasks/01-snapshot/task.json',
            content: '{"id":"task-1"}\n',
            baseSha256: null,
          },
        ],
      },
    },
  )
  assert.equal(missingObservedBranch.status, 400)
  assert.equal(missingObservedBranch.body.code, 'BRANCH_OBSERVATION_REQUIRED')

  const taskJson = `${JSON.stringify(
    {
      id: 'task-1',
      title: '快照任务',
      status: 'planning',
      assignee: 'owner',
      priority: 'P1',
    },
    null,
    2,
  )}\n`
  const changes = await request(
    runtime,
    `/api/agent/task-spaces/${encodeURIComponent(taskSpaceId)}/changes`,
    {
      method: 'POST',
      agentCredential: enrolled.body.credential,
      body: {
        batchId: 'batch-1',
        clientSequence: 1,
        observedBranchName: 'main',
        files: [
          {
            path: '.trellis/tasks/01-snapshot/task.json',
            content: taskJson,
            baseSha256: null,
          },
          {
            path: '.trellis/tasks/01-snapshot/prd.md',
            content:
              '# 快照任务\n\n## Requirements\n- 验证\n\n## Acceptance Criteria\n- [ ] 完成\n',
            baseSha256: null,
          },
        ],
      },
    },
  )
  assert.equal(changes.status, 200)
  assert.equal(changes.body.revision, 1)

  const staleSequence = await request(
    runtime,
    `/api/agent/task-spaces/${encodeURIComponent(taskSpaceId)}/changes`,
    {
      method: 'POST',
      agentCredential: enrolled.body.credential,
      body: {
        batchId: 'batch-stale-sequence',
        clientSequence: 1,
        observedBranchName: 'main',
        files: [
          {
            path: '.trellis/tasks/01-stale-sequence/task.json',
            content: `${JSON.stringify({
              id: 'stale-sequence',
              title: '重复序号',
              status: 'planning',
              assignee: 'owner',
              priority: 'P2',
            })}\n`,
            baseSha256: null,
          },
          {
            path: '.trellis/tasks/01-stale-sequence/prd.md',
            content:
              '# 重复序号\n\n## Requirements\n- 拒绝\n\n## Acceptance Criteria\n- [ ] 校验\n',
            baseSha256: null,
          },
        ],
      },
    },
  )
  assert.equal(staleSequence.status, 409)
  assert.equal(staleSequence.body.code, 'CONFLICT')
  assert.deepEqual(staleSequence.body.details, {
    previousSequence: 1,
    requiredClientSequence: 2,
  })

  const beforeExistingPreflight = syncCounts()
  const existingPreflight = await request(runtime, '/api/agent/task-spaces/preflight', {
    method: 'POST',
    agentCredential: enrolled.body.credential,
    body: {
      remoteUrl: 'https://example.com/team/repo.git',
      branchName: 'main',
      teamId: 'team-1',
    },
  })
  assert.equal(existingPreflight.status, 200)
  assert.equal(existingPreflight.body.status, 'existing')
  assert.equal(existingPreflight.body.revision, 1)
  assert.equal(existingPreflight.body.tasks[0].taskId, 'task-1')
  assert.equal(JSON.stringify(existingPreflight.body).includes('"content"'), false)
  assert.equal(JSON.stringify(existingPreflight.body).includes(enrolled.body.credential), false)
  assert.equal(fs.existsSync(path.join(dataDir, 'projects')), false)
  assert.deepEqual(syncCounts(), beforeExistingPreflight)

  const largeContent = 'a'.repeat(1024 * 1024)
  const largeChanges = await request(
    runtime,
    `/api/agent/task-spaces/${encodeURIComponent(taskSpaceId)}/changes`,
    {
      method: 'POST',
      agentCredential: enrolled.body.credential,
      body: {
        batchId: 'batch-large-http',
        clientSequence: 2,
        observedBranchName: 'main',
        files: Array.from({ length: 10 }, (_, index) => ({
          path: `.trellis/tasks/01-snapshot/evidence-${index}.md`,
          content: largeContent,
          baseSha256: null,
        })),
      },
    },
  )
  assert.equal(largeChanges.status, 200, JSON.stringify(largeChanges.body))
  assert.equal(largeChanges.body.revision, 2)

  await runtime.services.taskSpaceIndex.ensureMaterialized(taskSpaceId)
  const query = await request(
    runtime,
    `/api/tasks/query?taskSpaceId=${encodeURIComponent(taskSpaceId)}&limit=20`,
    { cookie: session },
  )
  assert.equal(query.status, 200)
  assert.equal(query.body.tasks.length, 1)
  assert.equal(query.body.tasks[0].taskSpaceId, taskSpaceId)
  assert.equal(query.body.tasks[0].branchName, 'main')

  const devAttached = await request(runtime, '/api/agent/task-spaces/attach', {
    method: 'POST',
    agentCredential: enrolled.body.credential,
    body: {
      remoteUrl: 'https://example.com/team/repo.git',
      branchName: 'dev',
      teamId: 'team-1',
      developerId: 'owner',
      displayName: '示例项目',
      localRepoKey: 'b'.repeat(64),
    },
  })
  assert.equal(devAttached.status, 201)
  const devTaskSpaceId = devAttached.body.taskSpace.id
  const devChanges = await request(
    runtime,
    `/api/agent/task-spaces/${encodeURIComponent(devTaskSpaceId)}/changes`,
    {
      method: 'POST',
      agentCredential: enrolled.body.credential,
      body: {
        batchId: 'batch-dev',
        clientSequence: 1,
        observedBranchName: 'dev',
        files: [
          {
            path: '.trellis/tasks/02-dev/task.json',
            content: `${JSON.stringify({
              id: 'task-dev',
              title: '分支任务',
              status: 'planning',
              assignee: 'owner',
              priority: 'P2',
            })}\n`,
            baseSha256: null,
          },
          {
            path: '.trellis/tasks/02-dev/prd.md',
            content:
              '# 分支任务\n\n## Requirements\n- 验证\n\n## Acceptance Criteria\n- [ ] 完成\n',
            baseSha256: null,
          },
        ],
      },
    },
  )
  assert.equal(devChanges.status, 200, JSON.stringify(devChanges.body))
  await runtime.services.taskSpaceIndex.ensureMaterialized(devTaskSpaceId)

  const allProjectsQuery = await request(runtime, '/api/tasks/query?limit=20', { cookie: session })
  assert.equal(allProjectsQuery.status, 200, JSON.stringify(allProjectsQuery.body))
  assert.equal(allProjectsQuery.body.tasks.length, 2)
  assert.deepEqual(
    new Set(allProjectsQuery.body.tasks.map((task) => task.taskSpaceId)),
    new Set([taskSpaceId, devTaskSpaceId]),
  )

  const devBranchQuery = await request(runtime, '/api/tasks/query?branch=DEV&limit=20', {
    cookie: session,
  })
  assert.equal(devBranchQuery.status, 200, JSON.stringify(devBranchQuery.body))
  assert.equal(devBranchQuery.body.tasks.length, 1)
  assert.equal(devBranchQuery.body.tasks[0].branchName, 'dev')

  const operation = await request(runtime, '/api/tasks', {
    method: 'POST',
    cookie: session,
    body: {
      taskSpaceId,
      assigneeUserId: enrolled.body.userId || login.body.user.id,
      title: '客户端创建任务',
      description: '由在线 Agent 创建',
      priority: 'P2',
      slug: 'client-created',
      idempotencyKey: 'create-1',
    },
  })
  assert.equal(operation.status, 202, JSON.stringify(operation.body))
  assert.equal(operation.body.operation.status, 'pending')
  assert.equal(runtime.services.taskCommands.available(enrolled.body.agentId).length, 1)

  for (const [legacyPath, method] of [
    ['/api/admin/git-credentials', 'GET'],
    ['/api/admin/projects/probe', 'POST'],
    ['/api/team/live-revision', 'GET'],
    ['/api/agent/live-changes', 'POST'],
  ]) {
    const legacy = await request(runtime, legacyPath, {
      method,
      cookie: session,
      agentCredential: legacyPath.startsWith('/api/agent/') ? enrolled.body.credential : null,
      body: method === 'POST' ? {} : null,
    })
    assert.equal(legacy.status, 404, legacyPath)
  }
})
