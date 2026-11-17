import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createUser } from '../team/auth.js'
import {
  createTeamRuntime,
  MAX_JSON_BYTES,
  MAX_LIVE_BATCH_BYTES,
  readJsonBody,
} from '../team/http.js'
import { TASK_SNAPSHOT_MAX_TRANSPORT_BYTES } from '@trellis-board/shared/task-snapshot.js'

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

async function waitFor(check, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.fail('等待条件超时')
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

  const withoutListener = await request(runtime, '/api/tasks', {
    method: 'POST',
    cookie: session,
    body: {
      taskSpaceId,
      assigneeUserId: login.body.user.id,
      title: '零监听任务',
      priority: 'P2',
      slug: 'without-listener',
      idempotencyKey: 'without-listener',
    },
  })
  assert.equal(withoutListener.status, 409)
  assert.equal(withoutListener.body.code, 'TASK_SPACE_NO_ONLINE_LISTENER')
  assert.equal(runtime.db.prepare('SELECT COUNT(*) AS count FROM sync_task_command').get().count, 0)

  const heartbeat = await request(runtime, '/api/agent/heartbeat', {
    method: 'POST',
    agentCredential: enrolled.body.credential,
    body: {
      protocolVersion: 3,
      agentId: enrolled.body.agentId,
      agentVersion: '0.1.0',
      deviceName: '测试设备',
      listenerReportVersion: 1,
      listeningTaskSpaceIds: [taskSpaceId],
    },
  })
  assert.equal(heartbeat.status, 200, JSON.stringify(heartbeat.body))

  const projects = await request(runtime, '/api/team/projects?teamId=team-1', {
    cookie: session,
  })
  const liveSpace = projects.body.projects
    .flatMap((project) => project.taskSpaces)
    .find((space) => space.id === taskSpaceId)
  assert.equal(liveSpace.listenerState, 'online')
  assert.equal(liveSpace.approvedBindingCount, 1)
  assert.equal(liveSpace.onlineListenerCount, 1)

  const status = await request(runtime, '/api/team/status', { cookie: session })
  assert.equal(status.status, 200)
  const statusProject = status.body.projects.find((project) =>
    project.taskSpaces.some((space) => space.id === taskSpaceId),
  )
  assert.equal(statusProject.agents.approved, 1)
  assert.equal(statusProject.agents.online, 1)

  const listeners = await request(
    runtime,
    `/api/task-spaces/${encodeURIComponent(taskSpaceId)}/listeners`,
    { cookie: session },
  )
  assert.equal(listeners.status, 200)
  assert.equal(listeners.body.onlineListenerCount, 1)
  assert.equal(listeners.body.listeners[0].bindingId, attached.body.binding.id)
  assert.equal(listeners.body.listeners[0].trellisDevId, 'owner')
  assert.equal(JSON.stringify(listeners.body).includes('localRepoKey'), false)

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
      branch: 'main',
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
              branch: 'main',
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
              branch: 'dev',
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

  const ownership = await request(
    runtime,
    `/api/agent/task-spaces/${encodeURIComponent(taskSpaceId)}/task-ownership`,
    {
      method: 'POST',
      agentCredential: enrolled.body.credential,
      body: { taskIds: ['task-1', 'task-dev', 'missing'] },
    },
  )
  assert.equal(ownership.status, 200, JSON.stringify(ownership.body))
  assert.deepEqual(
    new Set(ownership.body.projectTaskSpaces.map((item) => item.branchName)),
    new Set(['main', 'dev']),
  )
  const ownershipByTask = new Map(ownership.body.tasks.map((item) => [item.taskId, item.claims]))
  assert.deepEqual(ownershipByTask.get('task-1'), [
    { taskSpaceId, branchName: 'main', taskBranch: 'main' },
  ])
  assert.deepEqual(ownershipByTask.get('task-dev'), [
    { taskSpaceId: devTaskSpaceId, branchName: 'dev', taskBranch: 'dev' },
  ])
  assert.deepEqual(ownershipByTask.get('missing'), [])

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

  const mergedTaskDir = '.trellis/tasks/03-merged'
  const mergedTaskFiles = [
    {
      path: `${mergedTaskDir}/task.json`,
      content: `${JSON.stringify({
        id: 'task-merged',
        title: '合入任务',
        status: 'planning',
        assignee: 'owner',
        priority: 'P2',
        branch: 'feature/dev1',
      })}\n`,
      baseSha256: null,
    },
    {
      path: `${mergedTaskDir}/prd.md`,
      content: '# 合入任务\n',
      baseSha256: null,
    },
  ]
  const mergedChanges = await request(
    runtime,
    `/api/agent/task-spaces/${encodeURIComponent(taskSpaceId)}/changes`,
    {
      method: 'POST',
      agentCredential: enrolled.body.credential,
      body: {
        batchId: 'batch-merged-source',
        clientSequence: 3,
        observedBranchName: 'main',
        mergeEvidence: {
          version: 1,
          type: 'tracked-in-head',
          taskId: 'task-merged',
          taskDir: mergedTaskDir,
          trackedPath: `${mergedTaskDir}/task.json`,
          sourceBranch: 'feature/dev1',
          baselineBranch: 'main',
          headCommit: 'a'.repeat(40),
        },
        files: mergedTaskFiles,
      },
    },
  )
  assert.equal(mergedChanges.status, 200, JSON.stringify(mergedChanges.body))
  await runtime.services.taskSpaceIndex.ensureMaterialized(taskSpaceId)

  const board = await request(
    runtime,
    `/api/board?taskSpaceId=${encodeURIComponent(taskSpaceId)}`,
    {
      cookie: session,
    },
  )
  assert.equal(board.status, 200, JSON.stringify(board.body))
  const mergedBoardTask = board.body.tasks.find((task) => task.title === '合入任务')
  assert.equal(mergedBoardTask?.branchName, 'main')
  assert.equal(mergedBoardTask?.sourceBranchName, 'feature/dev1')
  const mergedDetail = await request(
    runtime,
    `/api/tasks/${encodeURIComponent(mergedBoardTask.executionTaskKey)}?taskSpaceId=${encodeURIComponent(taskSpaceId)}`,
    { cookie: session },
  )
  assert.equal(mergedDetail.status, 200, JSON.stringify(mergedDetail.body))
  assert.equal(mergedDetail.body.task.sourceBranchName, 'feature/dev1')

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

  const projectId = attached.body.project.id
  const taskSpacesResponse = await request(
    runtime,
    `/api/projects/${encodeURIComponent(projectId)}/task-spaces`,
    { cookie: session },
  )
  assert.equal(taskSpacesResponse.status, 200)
  assert.deepEqual(
    new Set(taskSpacesResponse.body.taskSpaces.map((taskSpace) => taskSpace.branchName)),
    new Set(['main', 'dev']),
  )

  const invalidPurge = await request(
    runtime,
    `/api/projects/${encodeURIComponent(projectId)}/task-spaces/${encodeURIComponent(devTaskSpaceId)}`,
    {
      method: 'DELETE',
      cookie: session,
      body: { confirmation: 'wrong-branch' },
    },
  )
  assert.equal(invalidPurge.status, 400)
  assert.match(invalidPurge.body.error, /确认名称/)

  const retiredMain = await request(
    runtime,
    `/api/projects/${encodeURIComponent(projectId)}/task-spaces/${encodeURIComponent(taskSpaceId)}/retire`,
    {
      method: 'POST',
      cookie: session,
      body: { reason: '测试弃用' },
    },
  )
  assert.equal(retiredMain.status, 200)
  assert.equal(retiredMain.body.taskSpace.lifecycleStatus, 'retired')
  const afterRetire = await request(runtime, '/api/team/projects?teamId=team-1', {
    cookie: session,
  })
  assert.equal(
    afterRetire.body.projects
      .flatMap((project) => project.taskSpaces)
      .some((space) => space.id === taskSpaceId),
    false,
  )

  const retiredAdmin = await request(
    runtime,
    `/api/projects/${encodeURIComponent(projectId)}/task-spaces`,
    { cookie: session },
  )
  const retiredSpace = retiredAdmin.body.taskSpaces.find((space) => space.id === taskSpaceId)
  assert.equal(retiredSpace.lifecycleStatus, 'retired')
  assert.equal(retiredSpace.retiredReason, '测试弃用')

  runtime.db
    .prepare('UPDATE sync_task_space SET revision = revision + 1 WHERE id = ?')
    .run(taskSpaceId)
  const restoredMain = await request(
    runtime,
    `/api/projects/${encodeURIComponent(projectId)}/task-spaces/${encodeURIComponent(taskSpaceId)}/restore`,
    { method: 'POST', cookie: session, body: {} },
  )
  assert.equal(restoredMain.status, 200)
  assert.equal(restoredMain.body.taskSpace.lifecycleStatus, 'active')
  await waitFor(() => {
    const space = runtime.db
      .prepare('SELECT revision, indexed_revision FROM sync_task_space WHERE id = ?')
      .get(taskSpaceId)
    return Number(space.indexed_revision) === Number(space.revision)
  })

  const viewer = await createUser(runtime.db, {
    username: 'viewer',
    displayName: '普通成员',
    password: 'Viewer-Password-123',
    systemAdmin: false,
    mustChangePassword: false,
  })
  runtime.db
    .prepare(`
      INSERT INTO team_member(team_id, user_id, role, created_at, updated_at)
      VALUES ('team-1', ?, 'member', ?, ?)
    `)
    .run(viewer.id, now, now)
  const viewerLogin = await request(runtime, '/api/auth/login', {
    method: 'POST',
    body: { username: 'viewer', password: 'Viewer-Password-123' },
  })
  assert.equal(viewerLogin.status, 200)
  const viewerTaskSpaces = await request(
    runtime,
    `/api/projects/${encodeURIComponent(projectId)}/task-spaces`,
    { cookie: cookie(viewerLogin) },
  )
  assert.equal(viewerTaskSpaces.status, 403)

  const detached = await request(
    runtime,
    `/api/agent/task-spaces/${encodeURIComponent(devTaskSpaceId)}/detach`,
    {
      method: 'POST',
      agentCredential: enrolled.body.credential,
      body: { localRepoKey: 'b'.repeat(64) },
    },
  )
  assert.equal(detached.status, 200, JSON.stringify(detached.body))
  assert.equal(detached.body.alreadyDetached, false)
  const detachedAgain = await request(
    runtime,
    `/api/agent/task-spaces/${encodeURIComponent(devTaskSpaceId)}/detach`,
    {
      method: 'POST',
      agentCredential: enrolled.body.credential,
      body: { localRepoKey: 'b'.repeat(64) },
    },
  )
  assert.equal(detachedAgain.status, 200)
  assert.equal(detachedAgain.body.alreadyDetached, true)

  const purgedDev = await request(
    runtime,
    `/api/projects/${encodeURIComponent(projectId)}/task-spaces/${encodeURIComponent(devTaskSpaceId)}`,
    {
      method: 'DELETE',
      cookie: session,
      body: { confirmation: 'dev' },
    },
  )
  assert.equal(purgedDev.status, 200, JSON.stringify(purgedDev.body))
  assert.equal(purgedDev.body.purged, true)
  assert.equal(
    (
      await request(runtime, `/api/projects/${encodeURIComponent(projectId)}/task-spaces`, {
        cookie: session,
      })
    ).body.taskSpaces.some((space) => space.id === devTaskSpaceId),
    false,
  )
  const removedHeartbeat = await request(runtime, '/api/agent/heartbeat', {
    method: 'POST',
    agentCredential: enrolled.body.credential,
    body: {
      protocolVersion: 3,
      agentId: enrolled.body.agentId,
      agentVersion: '0.1.0',
      deviceName: '测试设备',
      listenerReportVersion: 1,
      listeningTaskSpaceIds: [devTaskSpaceId],
      bindings: [{ taskSpaceId: devTaskSpaceId, localRepoKey: 'b'.repeat(64) }],
    },
  })
  assert.equal(removedHeartbeat.status, 200, JSON.stringify(removedHeartbeat.body))
  assert.equal(removedHeartbeat.body.bindings[0].errorCode, 'BINDING_UNKNOWN')

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

test('归档同步管理 API 仅允许系统管理员且不回显凭据', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-archive-sync-http-'))
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
  for (const user of [
    { username: 'root', displayName: '系统管理员', systemAdmin: true },
    { username: 'member', displayName: '普通成员', systemAdmin: false },
  ]) {
    await createUser(runtime.db, {
      ...user,
      password: 'Archive-Password-123',
      mustChangePassword: false,
    })
    runtime.db
      .prepare(`
        INSERT INTO team_member(team_id, user_id, role, created_at, updated_at)
        SELECT 'team-1', id, 'member', ?, ? FROM user_account WHERE username = ?
      `)
      .run(now, now, user.username)
  }
  const login = async (username) => {
    const response = await request(runtime, '/api/auth/login', {
      method: 'POST',
      body: { username, password: 'Archive-Password-123' },
    })
    assert.equal(response.status, 200)
    return cookie(response)
  }
  const adminCookie = await login('root')
  const memberCookie = await login('member')

  const overview = await request(runtime, '/api/admin/archive-sync', { cookie: adminCookie })
  assert.equal(overview.status, 200)
  assert.equal(overview.body.config.intervalSeconds, 300)
  assert.deepEqual(overview.body.credentials, [])
  assert.equal(
    (await request(runtime, '/api/admin/archive-sync', { cookie: memberCookie })).status,
    403,
  )

  const configured = await request(runtime, '/api/admin/archive-sync/config', {
    method: 'PATCH',
    cookie: adminCookie,
    body: { enabled: false, intervalSeconds: 600 },
  })
  assert.equal(configured.status, 200)
  assert.deepEqual(
    {
      enabled: configured.body.config.enabled,
      intervalSeconds: configured.body.config.intervalSeconds,
    },
    { enabled: false, intervalSeconds: 600 },
  )

  const credential = await request(runtime, '/api/admin/archive-sync/credentials', {
    method: 'POST',
    cookie: adminCookie,
    body: {
      name: 'GitHub 只读',
      scheme: 'https',
      host: 'github.com',
      port: 443,
      username: 'x-access-token',
      token: 'ghp_archiveHttpTestToken123456789',
    },
  })
  assert.equal(credential.status, 201, JSON.stringify(credential.body))
  assert.equal(credential.body.credential.origin, 'https://github.com:443')
  assert.equal(Object.hasOwn(credential.body.credential, 'token'), false)
  assert.equal(Object.hasOwn(credential.body.credential, 'secretCiphertext'), false)
  assert.equal(
    (
      await request(runtime, '/api/admin/archive-sync/credentials', {
        method: 'POST',
        cookie: memberCookie,
        body: {
          scheme: 'https',
          host: 'example.com',
          port: 443,
          token: 'not-allowed',
        },
      })
    ).status,
    403,
  )
})
