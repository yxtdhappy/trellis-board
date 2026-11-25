import assert from 'node:assert/strict'
import crypto from 'node:crypto'
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
          const buffer = Buffer.concat(chunks)
          const text = buffer.toString('utf8')
          let parsed = null
          try {
            parsed = text ? JSON.parse(text) : null
          } catch {
            parsed = text
          }
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: parsed,
            buffer,
          })
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
  await createUser(runtime.db, {
    username: 'handoff-owner',
    displayName: 'Handoff 接收人',
    password: 'Handoff-Password-123',
    systemAdmin: false,
    mustChangePassword: false,
  })
  runtime.db
    .prepare(`
      INSERT INTO team_member(team_id, user_id, role, created_at, updated_at)
      SELECT 'team-1', id, 'member', ?, ? FROM user_account WHERE username = 'handoff-owner'
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
      taskType: 'simple',
      workType: 'backend',
      idempotencyKey: 'without-listener',
    },
  })
  assert.equal(withoutListener.status, 202)
  assert.equal(withoutListener.body.operation.status, 'pending')
  assert.equal(withoutListener.body.operation.targetUserId, login.body.user.id)
  assert.equal(runtime.db.prepare('SELECT COUNT(*) AS count FROM sync_task_command').get().count, 1)
  assert.equal(
    runtime.db
      .prepare("SELECT materialization_state FROM sync_task WHERE task_id = 'without-listener'")
      .get().materialization_state,
    'pending',
  )
  await runtime.services.taskSpaceIndex.ensureMaterialized(taskSpaceId)
  const pendingQuery = await request(
    runtime,
    `/api/tasks/query?taskSpaceId=${encodeURIComponent(taskSpaceId)}&limit=20`,
    { cookie: session },
  )
  assert.equal(pendingQuery.status, 200)
  assert.equal(pendingQuery.body.tasks.length, 1)
  assert.equal(pendingQuery.body.tasks[0].materializationState, 'pending')
  assert.equal(pendingQuery.body.tasks[0].controlTaskVersion, 1)
  const beforeClaimRevision = runtime.services.taskSpaceIndex.queryRevision()
  const pendingExecutionTaskKey = pendingQuery.body.tasks[0].executionTaskKey
  const offlineClaim = await request(
    runtime,
    `/api/agent/tasks/${encodeURIComponent(pendingExecutionTaskKey)}/claim`,
    {
      method: 'POST',
      agentCredential: enrolled.body.credential,
      body: {},
    },
  )
  assert.equal(offlineClaim.status, 200, JSON.stringify(offlineClaim.body))
  assert.equal(offlineClaim.body.task.materializationState, 'claimed')
  assert.ok(runtime.services.taskSpaceIndex.queryRevision() > beforeClaimRevision)
  const claimedQuery = await request(
    runtime,
    `/api/tasks/query?taskSpaceId=${encodeURIComponent(taskSpaceId)}&limit=20`,
    { cookie: session },
  )
  assert.equal(claimedQuery.body.tasks[0].materializationState, 'claimed')
  assert.equal(claimedQuery.body.tasks[0].leaseStatus, 'active')

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
  const canceledWithoutListener = await request(
    runtime,
    `/api/task-operations/${encodeURIComponent(withoutListener.body.operation.id)}/cancel`,
    { method: 'POST', cookie: session, body: {} },
  )
  assert.equal(canceledWithoutListener.status, 200)
  runtime.db
    .prepare('DELETE FROM sync_task_command WHERE id = ?')
    .run(withoutListener.body.operation.id)
  runtime.db.prepare("DELETE FROM sync_task WHERE task_id = 'without-listener'").run()
  await runtime.services.taskSpaceIndex.enqueue(taskSpaceId)

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
  assert.equal(status.body.archiveRevision, 0)
  const statusProject = status.body.projects.find((project) =>
    project.taskSpaces.some((space) => space.id === taskSpaceId),
  )
  assert.equal(statusProject.agents.approved, 1)
  assert.equal(statusProject.agents.online, 1)
  assert.equal(statusProject.ownershipInboxCount, 0)
  assert.equal('ownershipPendingCount' in statusProject, false)

  const initialStatusEtag = status.headers.etag
  const initialQueryRevision = runtime.services.taskSpaceIndex.queryRevision()
  const ownershipInboxPath = `/api/agent/task-spaces/${encodeURIComponent(
    taskSpaceId,
  )}/ownership-inbox`
  const ownershipInboxItem = {
    taskId: 'inbox-task-1',
    taskDir: '.trellis/tasks/11-18-inbox-task-1',
    title: '<script>待归属</script>',
    reason: 'TASK_OWNERSHIP_REQUIRED',
    fingerprint: 'a'.repeat(64),
    content: 'SECRET-INBOX-BODY',
    attachments: ['C:\\secret\\prd.md'],
  }
  const ownershipUpsert = await request(runtime, ownershipInboxPath, {
    method: 'PUT',
    agentCredential: enrolled.body.credential,
    body: {
      observedBranchName: 'main',
      upserts: [ownershipInboxItem],
      deletes: [],
    },
  })
  assert.equal(ownershipUpsert.status, 200)
  assert.equal(JSON.stringify(ownershipUpsert.body).includes('SECRET-INBOX-BODY'), false)
  assert.equal(
    runtime.db.prepare('SELECT COUNT(*) AS count FROM sync_task_ownership_inbox').get().count,
    1,
  )
  const repeatedUpsert = await request(runtime, ownershipInboxPath, {
    method: 'PUT',
    agentCredential: enrolled.body.credential,
    body: {
      observedBranchName: 'main',
      upserts: [ownershipInboxItem],
      deletes: [],
    },
  })
  assert.equal(repeatedUpsert.status, 200)
  assert.equal(
    runtime.db.prepare('SELECT COUNT(*) AS count FROM sync_task_ownership_inbox').get().count,
    1,
  )

  const inboxQuery = await request(
    runtime,
    `/api/ownership-inbox?teamId=team-1&projectIds=${encodeURIComponent(statusProject.id)}`,
    { cookie: session },
  )
  assert.equal(inboxQuery.status, 200)
  assert.equal(inboxQuery.body.total, 1)
  assert.equal(inboxQuery.body.items[0].taskId, 'inbox-task-1')
  assert.deepEqual(inboxQuery.body.items[0].sourceBranches, ['main'])
  assert.deepEqual(inboxQuery.body.items[0].sourceClients, [
    { displayName: '测试设备', username: 'owner' },
  ])
  assert.equal(JSON.stringify(inboxQuery.body).includes('SECRET-INBOX-BODY'), false)
  assert.equal(JSON.stringify(inboxQuery.body).includes('attachments'), false)

  const statusWithInbox = await request(runtime, '/api/team/status', { cookie: session })
  const projectWithInbox = statusWithInbox.body.projects.find(
    (project) => project.id === statusProject.id,
  )
  assert.equal(projectWithInbox.ownershipInboxCount, 1)
  assert.notEqual(statusWithInbox.headers.etag, initialStatusEtag)

  const deletedInbox = await request(runtime, ownershipInboxPath, {
    method: 'PUT',
    agentCredential: enrolled.body.credential,
    body: {
      observedBranchName: 'main',
      upserts: [],
      deletes: [
        {
          taskDir: ownershipInboxItem.taskDir,
        },
      ],
    },
  })
  assert.equal(deletedInbox.status, 200)
  const repeatedDelete = await request(runtime, ownershipInboxPath, {
    method: 'PUT',
    agentCredential: enrolled.body.credential,
    body: {
      observedBranchName: 'main',
      upserts: [],
      deletes: [
        {
          taskId: ownershipInboxItem.taskId,
          taskDir: ownershipInboxItem.taskDir,
        },
      ],
    },
  })
  assert.equal(repeatedDelete.status, 200)
  const statusWithoutInbox = await request(runtime, '/api/team/status', { cookie: session })
  const projectWithoutInbox = statusWithoutInbox.body.projects.find(
    (project) => project.id === statusProject.id,
  )
  assert.equal(projectWithoutInbox.ownershipInboxCount, 0)
  assert.equal(runtime.services.taskSpaceIndex.queryRevision(), initialQueryRevision)

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
  const executionTaskKey = changes.body.control.task.executionTaskKey
  const controlledBinding = runtime.db
    .prepare(`
      SELECT binding.id, binding.sync_status, device.status AS device_status,
             active.agent_id, space.status AS space_status, space.retired_at,
             project.status AS project_status
      FROM sync_agent_binding binding
      JOIN agent_device device ON device.id = binding.agent_id
      LEFT JOIN sync_active_agent active
        ON active.user_id = device.user_id AND active.agent_id = device.id
      JOIN sync_task_space space ON space.id = binding.task_space_id
      JOIN sync_project project ON project.id = space.project_id
      WHERE binding.agent_id = ? AND binding.task_space_id = ?
    `)
    .get(enrolled.body.agentId, taskSpaceId)
  assert.equal(controlledBinding.id, attached.body.binding.id)
  assert.equal(controlledBinding.sync_status, 'approved')
  assert.equal(controlledBinding.device_status, 'active')
  assert.equal(controlledBinding.agent_id, enrolled.body.agentId)
  assert.notEqual(controlledBinding.space_status, 'disabled')
  assert.equal(controlledBinding.retired_at, null)
  assert.equal(controlledBinding.project_status, 'active')
  const controlledPath = `/api/agent/tasks/${encodeURIComponent(executionTaskKey)}`
  const controlledTask = await request(runtime, controlledPath, {
    agentCredential: enrolled.body.credential,
  })
  assert.equal(
    controlledTask.status,
    200,
    `${controlledPath} ${JSON.stringify(controlledTask.body)}`,
  )
  assert.equal(controlledTask.body.contentAvailable, true)
  const controlledHeartbeat = await request(runtime, `${controlledPath}/heartbeat`, {
    method: 'POST',
    agentCredential: enrolled.body.credential,
    body: { leaseToken: changes.body.control.lease.token },
  })
  assert.equal(controlledHeartbeat.status, 200)
  assert.equal(controlledHeartbeat.body.lease.executionTaskKey, executionTaskKey)
  const controlledRelease = await request(runtime, `${controlledPath}/release`, {
    method: 'POST',
    agentCredential: enrolled.body.credential,
    body: { leaseToken: changes.body.control.lease.token },
  })
  assert.equal(controlledRelease.status, 200)
  assert.equal(controlledRelease.body.released, true)
  assert.equal(
    (
      await request(runtime, controlledPath, {
        agentCredential: enrolled.body.credential,
      })
    ).body.contentAvailable,
    false,
  )
  const controlledClaim = await request(runtime, `${controlledPath}/claim`, {
    method: 'POST',
    agentCredential: enrolled.body.credential,
    body: {},
  })
  assert.equal(controlledClaim.status, 200)
  assert.equal(controlledClaim.body.task.taskId, 'task-1')
  assert.equal(controlledClaim.body.lease.status, 'active')

  const handoffExecutionTaskKey = `${taskSpaceId}::handoff-route`
  const handoffTaskDir = '.trellis/tasks/01-handoff-route'
  const handoffProjectId = runtime.db
    .prepare('SELECT project_id FROM sync_task_space WHERE id = ?')
    .get(taskSpaceId).project_id
  const handoffAssigneeId = runtime.db
    .prepare("SELECT id FROM user_account WHERE username = 'handoff-owner'")
    .get().id
  runtime.db
    .prepare(`
      INSERT INTO sync_task(
        execution_task_key, task_key, task_space_id, project_id, task_id,
        relative_dir, title, description, priority, created_by_user_id,
        assignee_user_id, assignee_dev_id, stage,
        materialization_state, task_version, content_revision, previous_assignee_user_id,
        handoff_state, materialized_revision, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, 'handoff-route', ?, 'Handoff 路由任务', '', 'P2', ?,
        ?, 'handoff-owner', 'planning', 'materialized', 1, 1, ?,
        'source_cleanup_pending', 1, ?, ?
      )
    `)
    .run(
      handoffExecutionTaskKey,
      `${taskSpaceId}::${handoffTaskDir}`,
      taskSpaceId,
      handoffProjectId,
      handoffTaskDir,
      login.body.user.id,
      handoffAssigneeId,
      login.body.user.id,
      now,
      now,
    )
  const handoffSnapshot = await request(
    runtime,
    `/api/agent/task-spaces/${encodeURIComponent(taskSpaceId)}/snapshot?afterRevision=0`,
    { agentCredential: enrolled.body.credential },
  )
  assert.equal(handoffSnapshot.status, 200)
  const handoffControl = handoffSnapshot.body.controls.find(
    (control) => control.executionTaskKey === handoffExecutionTaskKey,
  )
  assert.equal(handoffControl.state, 'handoff_materialized')
  assert.equal(handoffControl.handoffState, 'source_cleanup_pending')
  assert.equal(handoffControl.leaseHeldByOtherUser, false)

  const handoffAckPath = `/api/agent/tasks/${encodeURIComponent(handoffExecutionTaskKey)}/handoff-ack`
  const missingHandoffBackup = await request(runtime, handoffAckPath, {
    method: 'POST',
    agentCredential: enrolled.body.credential,
    body: { outcome: 'cleaned', fileCount: 2, totalBytes: 128 },
  })
  assert.equal(missingHandoffBackup.status, 400)
  const handoffAck = await request(runtime, handoffAckPath, {
    method: 'POST',
    agentCredential: enrolled.body.credential,
    body: {
      outcome: 'cleaned',
      backupId: 'handoff-0123456789abcdef',
      manifestSha256: 'a'.repeat(64),
      fileCount: 2,
      totalBytes: 128,
    },
  })
  assert.equal(handoffAck.status, 200, JSON.stringify(handoffAck.body))
  assert.equal(handoffAck.body.handoffState, 'completed')
  assert.equal(handoffAck.body.idempotent, false)
  const replayedHandoffAck = await request(runtime, handoffAckPath, {
    method: 'POST',
    agentCredential: enrolled.body.credential,
    body: {
      outcome: 'cleaned',
      backupId: 'handoff-0123456789abcdef',
      manifestSha256: 'a'.repeat(64),
      fileCount: 2,
      totalBytes: 128,
    },
  })
  assert.equal(replayedHandoffAck.status, 200)
  assert.equal(replayedHandoffAck.body.idempotent, true)
  runtime.db
    .prepare("UPDATE sync_task SET handoff_state = 'none' WHERE execution_task_key = ?")
    .run(handoffExecutionTaskKey)
  const prematureHandoffConflict = await request(runtime, handoffAckPath, {
    method: 'POST',
    agentCredential: enrolled.body.credential,
    body: { outcome: 'conflict', reason: 'git_tracked' },
  })
  assert.equal(prematureHandoffConflict.status, 409)
  assert.equal(prematureHandoffConflict.body.code, 'HANDOFF_NOT_READY')

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
        taskVersion: 1,
        leaseToken: controlledClaim.body.lease.token,
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
      taskType: 'simple',
      workType: 'backend',
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

test('归档附件详情与下载只读取本地快照并执行 Session 权限和响应头', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-archive-file-http-'))
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
    archiveGitRunProcessImpl: () => {
      throw new Error('读取归档时禁止执行 Git')
    },
  })
  await runtime.start()
  runtime.db.prepare('UPDATE sync_archive_sync_config SET enabled = 0').run()
  t.after(async () => {
    await runtime.stop()
    fs.rmSync(root, { recursive: true, force: true })
  })

  const now = new Date().toISOString()
  runtime.db
    .prepare(`
      INSERT INTO team(id, name, slug, status, created_at, updated_at)
      VALUES ('team-owner', 'Owner', 'team-owner', 'active', ?, ?),
             ('team-other', 'Other', 'team-other', 'active', ?, ?)
    `)
    .run(now, now, now, now)
  const owner = await createUser(runtime.db, {
    username: 'owner-file',
    displayName: '项目成员',
    password: 'Owner-File-Password-123',
    systemAdmin: false,
    mustChangePassword: false,
  })
  const outsider = await createUser(runtime.db, {
    username: 'outsider-file',
    displayName: '其他团队',
    password: 'Outsider-File-Password-123',
    systemAdmin: false,
    mustChangePassword: false,
  })
  runtime.db
    .prepare(`
      INSERT INTO team_member(team_id, user_id, role, created_at, updated_at)
      VALUES ('team-owner', ?, 'member', ?, ?),
             ('team-other', ?, 'member', ?, ?)
    `)
    .run(owner.id, now, now, outsider.id, now, now)
  runtime.db
    .prepare(`
      INSERT INTO sync_project(
        id, name, remote_url, remote_identity_hash, baseline_branch, owner_team_id,
        status, created_by_user_id, created_at, updated_at
      ) VALUES ('project-files', '归档项目', 'https://example.com/archive.git',
        'archive-hash', 'main', 'team-owner', 'active', ?, ?, ?)
    `)
    .run(owner.id, now, now)
  runtime.db
    .prepare(`
      INSERT INTO sync_project_team_access(
        project_id, team_id, access_role, created_by_user_id, created_at
      ) VALUES ('project-files', 'team-owner', 'owner', ?, ?)
    `)
    .run(owner.id, now)
  runtime.db
    .prepare(`
      INSERT INTO sync_task_space(
        id, project_id, branch_name, status, revision, indexed_revision,
        created_by_user_id, created_at, updated_at
      ) VALUES ('space-files', 'project-files', 'main', 'active', 0, 0, ?, ?, ?),
               ('space-files-alt', 'project-files', 'feature-alt', 'active', 0, 0, ?, ?, ?)
    `)
    .run(owner.id, now, now, owner.id, now, now)

  const taskDir = '.trellis/tasks/archive/2026-11/11-16-old'
  const taskJson = JSON.stringify({
    id: 'old',
    title: '归档附件任务',
    description: '',
    status: 'completed',
    priority: 'P2',
    assignee: owner.username,
    creator: owner.username,
    branch: 'main',
  })
  const prd = '# 旧任务\n\n## Requirements\n\n- 完成\n\n## Acceptance Criteria\n\n- [x] 完成\n'
  const image = Buffer.from([0x89, 0x50, 0x4e, 0x47])
  const staging = runtime.services.archiveSnapshots.createStaging('space-files', 'attempt-http')
  const files = [
    staging.writeBlob(
      {
        relativePath: `${taskDir}/task.json`,
        blobOid: 'a'.repeat(40),
      },
      Buffer.from(taskJson),
    ),
    staging.writeBlob(
      {
        relativePath: `${taskDir}/prd.md`,
        blobOid: 'b'.repeat(40),
      },
      Buffer.from(prd),
    ),
    staging.writeBlob(
      {
        relativePath: `${taskDir}/screenshot.png`,
        blobOid: 'c'.repeat(40),
      },
      image,
    ),
  ]
  const published = runtime.services.archiveSnapshots.publish({
    staging,
    head: 'd'.repeat(40),
    files,
  })
  const snapshotId = crypto.randomUUID()
  runtime.db
    .prepare(`
      INSERT INTO sync_archive_snapshot(
        id, task_space_id, source_head, status, storage_root,
        file_count, byte_count, manifest_sha256, published_at
      ) VALUES (?, 'space-files', ?, 'published', ?, ?, ?, ?, ?)
    `)
    .run(
      snapshotId,
      published.sourceHead,
      published.storageRoot,
      published.fileCount,
      published.byteCount,
      published.manifestSha256,
      now,
    )
  const insertFile = runtime.db.prepare(`
    INSERT INTO sync_archive_file(
      id, task_space_id, snapshot_id, relative_path, blob_oid, sha256, content_text,
      size_bytes, mime_type, storage_key, text_excerpt, task_id, task_dir,
      source_head, updated_at
    ) VALUES (?, 'space-files', ?, ?, ?, ?, '', ?, ?, ?, NULL, ?, ?, ?, ?)
  `)
  const fileIds = []
  for (const file of published.files) {
    const id = crypto.randomUUID()
    fileIds.push(id)
    insertFile.run(
      id,
      snapshotId,
      file.relativePath,
      file.blobOid,
      file.sha256,
      file.sizeBytes,
      file.mimeType,
      file.storageKey,
      file.relativePath.endsWith('/task.json') ? 'old' : null,
      taskDir,
      published.sourceHead,
      now,
    )
  }
  published.release()
  runtime.db
    .prepare(`
      UPDATE sync_task_space
      SET archive_revision = 1, archive_snapshot_id = ?, archive_candidate_snapshot_id = NULL
      WHERE id = ?
    `)
    .run(snapshotId, 'space-files')
  await runtime.services.taskSpaceIndex.materializeNow('space-files', { source: 'archive' })

  const ownerLogin = await request(runtime, '/api/auth/login', {
    method: 'POST',
    body: { username: owner.username, password: 'Owner-File-Password-123' },
  })
  const outsiderLogin = await request(runtime, '/api/auth/login', {
    method: 'POST',
    body: { username: outsider.username, password: 'Outsider-File-Password-123' },
  })
  const ownerCookie = cookie(ownerLogin)
  const outsiderCookie = cookie(outsiderLogin)
  const executionTaskKey = runtime.db
    .prepare('SELECT execution_task_key FROM sync_task_index WHERE task_space_id = ?')
    .get('space-files').execution_task_key
  const detail = await request(
    runtime,
    `/api/tasks/${encodeURIComponent(executionTaskKey)}?taskSpaceId=space-files`,
    { cookie: ownerCookie },
  )
  assert.equal(detail.status, 200, JSON.stringify(detail.body))
  assert.equal(detail.body.task.files.length, 3)
  assert.equal(JSON.stringify(detail.body).includes('storageKey'), false)
  const imageMeta = detail.body.task.files.find((file) => file.name === 'screenshot.png')
  assert.equal(imageMeta.mimeType, 'image/png')
  assert.equal(imageMeta.sizeBytes, image.length)
  const archiveUrl = (taskSpaceId, fileId) =>
    `/api/archive-files/${encodeURIComponent(fileId)}?taskSpaceId=${encodeURIComponent(taskSpaceId)}`
  assert.equal(imageMeta.downloadUrl, archiveUrl('space-files', imageMeta.id))
  const imageRow = runtime.db
    .prepare('SELECT * FROM sync_archive_file WHERE id = ?')
    .get(imageMeta.id)
  const historyImageId = crypto.randomUUID()
  runtime.db
    .prepare(`
      INSERT INTO sync_archive_file_history(
        id, task_space_id, snapshot_id, relative_path, blob_oid, sha256,
        content_text, size_bytes, mime_type, storage_key, text_excerpt,
        task_id, task_dir, source_head, updated_at
      )
      SELECT ?, task_space_id, snapshot_id, relative_path, blob_oid, sha256,
             content_text, size_bytes, mime_type, storage_key, text_excerpt,
             task_id, task_dir, source_head, updated_at
      FROM sync_archive_file
      WHERE id = ?
    `)
    .run(historyImageId, imageMeta.id)

  assert.equal((await request(runtime, archiveUrl('space-files', imageMeta.id))).status, 401)
  const inaccessibleReal = await request(runtime, archiveUrl('space-files', imageMeta.id), {
    cookie: outsiderCookie,
  })
  const inaccessibleFake = await request(runtime, archiveUrl('space-files', crypto.randomUUID()), {
    cookie: outsiderCookie,
  })
  const inaccessibleInvalid = await request(runtime, archiveUrl('space-files', 'bad id'), {
    cookie: outsiderCookie,
  })
  assert.equal(inaccessibleReal.status, 403)
  assert.equal(inaccessibleFake.status, 403)
  assert.equal(inaccessibleInvalid.status, 403)
  assert.deepEqual(inaccessibleFake.body, inaccessibleReal.body)
  assert.deepEqual(inaccessibleInvalid.body, inaccessibleReal.body)
  assert.equal(
    (
      await request(runtime, archiveUrl('space-files', crypto.randomUUID()), {
        cookie: ownerCookie,
      })
    ).status,
    404,
  )
  assert.equal(
    (
      await request(runtime, archiveUrl('space-files-alt', imageMeta.id), {
        cookie: ownerCookie,
      })
    ).status,
    404,
  )
  runtime.db
    .prepare("UPDATE sync_task_space SET status = 'disabled' WHERE id = 'space-files-alt'")
    .run()
  assert.equal(
    (
      await request(runtime, archiveUrl('space-files-alt', imageMeta.id), {
        cookie: ownerCookie,
      })
    ).status,
    409,
  )
  assert.equal(
    (
      await request(runtime, `/api/archive-files/${encodeURIComponent(imageMeta.id)}`, {
        cookie: ownerCookie,
      })
    ).status,
    400,
  )
  assert.equal(
    (
      await request(runtime, archiveUrl('x'.repeat(129), imageMeta.id), {
        cookie: ownerCookie,
      })
    ).status,
    400,
  )
  assert.equal(
    (
      await request(runtime, archiveUrl('space-files', 'x'.repeat(129)), {
        cookie: ownerCookie,
      })
    ).status,
    400,
  )
  assert.equal(
    (
      await request(
        runtime,
        `/api/archive-files/%E0%A4%A?taskSpaceId=${encodeURIComponent('space-files')}`,
        { cookie: ownerCookie },
      )
    ).status,
    400,
  )
  assert.equal(
    (
      await request(
        runtime,
        `/api/archive-files/${encodeURIComponent(imageMeta.id)}?taskSpaceId=%E0%A4%A`,
        { cookie: ownerCookie },
      )
    ).status,
    400,
  )
  assert.equal(
    (
      await request(runtime, archiveUrl('space-files', 'bad id'), {
        cookie: ownerCookie,
      })
    ).status,
    400,
  )

  const downloaded = await request(runtime, archiveUrl('space-files', imageMeta.id), {
    cookie: ownerCookie,
  })
  assert.equal(downloaded.status, 200)
  assert.equal(downloaded.headers['content-type'], 'image/png')
  assert.equal(downloaded.headers['content-length'], String(image.length))
  assert.equal(downloaded.headers['cache-control'], 'private, no-store')
  assert.equal(downloaded.headers['x-content-type-options'], 'nosniff')
  assert.match(downloaded.headers['content-disposition'], /^attachment; filename="screenshot\.png"/)
  assert.match(downloaded.headers['content-disposition'], /filename\*=UTF-8''screenshot\.png/)
  assert.deepEqual([...downloaded.buffer], [...image])

  const historyDownloaded = await request(runtime, archiveUrl('space-files', historyImageId), {
    cookie: ownerCookie,
  })
  assert.equal(historyDownloaded.status, 200)
  assert.deepEqual([...historyDownloaded.buffer], [...image])

  fs.rmSync(path.join(dataDir, 'archive-snapshots', ...imageRow.storage_key.split('/')))
  const missing = await request(runtime, archiveUrl('space-files', imageMeta.id), {
    cookie: ownerCookie,
  })
  assert.equal(missing.status, 503)
  assert.equal(missing.body.code, 'ARCHIVE_LOCAL_FILE_UNAVAILABLE')
})
