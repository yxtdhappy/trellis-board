import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { AgentApiClient } from '../agent/api.js'
import { createUser } from '../server/team/auth.js'
import { createTeamRuntime } from '../server/team/http.js'

const PASSWORD = 'Realtime-Password-123'
const SILENT_LOGGER = { info() {}, warn() {}, error() {} }

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

async function setupRuntime(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-team-task-sync-'))
  const port = await freePort()
  const publicOrigin = `http://127.0.0.1:${port}`
  const databaseFile = path.join(root, 'data', 'board.sqlite')
  const runtime = await createTeamRuntime({
    config: {
      mode: 'team',
      bindHost: '127.0.0.1',
      port,
      publicUrl: new URL(publicOrigin),
      publicOrigin,
      sessionTtlMs: 12 * 60 * 60 * 1000,
      agentStaleMs: 60_000,
      cookieSecure: false,
      trustProxy: false,
      allowLocalGitRemotes: false,
    },
    databaseFile,
    dataDir: path.join(root, 'data'),
    logger: SILENT_LOGGER,
    requireAdmin: false,
    enablePolling: false,
  })
  await runtime.start()
  const cleanup = { runtime }
  t.after(async () => {
    await cleanup.runtime.stop()
    fs.rmSync(root, { recursive: true, force: true })
  })

  const now = new Date().toISOString()
  runtime.db
    .prepare(`
      INSERT INTO team(id, name, slug, status, created_at, updated_at)
      VALUES ('team-1', '实时团队', 'realtime-team', 'active', ?, ?)
    `)
    .run(now, now)
  const ownerUser = await createUser(runtime.db, {
    username: 'owner',
    displayName: '负责人',
    password: PASSWORD,
    mustChangePassword: false,
  })
  const memberUser = await createUser(runtime.db, {
    username: 'member',
    displayName: '成员',
    password: PASSWORD,
    mustChangePassword: false,
  })
  const addMember = runtime.db.prepare(`
    INSERT INTO team_member(team_id, user_id, role, created_at, updated_at)
    VALUES ('team-1', ?, 'member', ?, ?)
  `)
  addMember.run(ownerUser.id, now, now)
  addMember.run(memberUser.id, now, now)

  const ownerActor = runtime.services.taskSpaces.actorContext(ownerUser.id)
  const memberActor = runtime.services.taskSpaces.actorContext(memberUser.id)
  const ownerPairing = runtime.services.agentService.createPairingCode(ownerActor, {
    teamId: 'team-1',
  })
  const memberPairing = runtime.services.agentService.createPairingCode(memberActor, {
    teamId: 'team-1',
  })
  const ownerEnrollment = runtime.services.agentService.enroll(
    {
      protocolVersion: 3,
      agentVersion: '0.1.0',
      platform: 'win32',
      deviceName: '负责人设备',
      pairingCode: ownerPairing.pairingCode,
    },
    { ip: 'owner' },
  )
  const memberEnrollment = runtime.services.agentService.enroll(
    {
      protocolVersion: 3,
      agentVersion: '0.1.0',
      platform: 'win32',
      deviceName: '成员设备',
      pairingCode: memberPairing.pairingCode,
    },
    { ip: 'member' },
  )
  const ownerAttach = runtime.services.taskSpaces.attach(ownerUser.id, ownerEnrollment.agentId, {
    remoteUrl: 'https://example.com/realtime/repo.git',
    branchName: 'main',
    displayName: '实时项目',
    teamId: 'team-1',
    developerId: 'owner',
    localRepoKey: 'a'.repeat(64),
  })
  runtime.services.taskSpaces.upsertMember(ownerActor, {
    projectId: ownerAttach.project.id,
    userId: memberUser.id,
    role: 'member',
    trellisDevId: 'member',
  })
  runtime.services.taskSpaces.attach(memberUser.id, memberEnrollment.agentId, {
    remoteUrl: 'https://example.com/realtime/repo.git',
    branchName: 'main',
    displayName: '实时项目',
    teamId: 'team-1',
    developerId: 'member',
    localRepoKey: 'b'.repeat(64),
  })

  return {
    runtime,
    root,
    publicOrigin,
    ownerUser,
    memberUser,
    ownerActor,
    memberActor,
    ownerEnrollment,
    memberEnrollment,
    taskSpaceId: ownerAttach.taskSpace.id,
    ownerClient: new AgentApiClient({
      serverUrl: publicOrigin,
      credential: ownerEnrollment.credential,
    }),
    memberClient: new AgentApiClient({
      serverUrl: publicOrigin,
      credential: memberEnrollment.credential,
    }),
    databaseFile,
    cleanup,
  }
}

function openAgentEvents(runtime, credential) {
  const address = runtime.address()
  const queue = []
  const waiters = []
  let buffer = ''
  let closed = false
  const host = new URL(runtime.config.publicOrigin).host
  const request = http.get(
    {
      hostname: '127.0.0.1',
      port: address.port,
      path: '/api/agent/events',
      headers: {
        host,
        authorization: `Bearer ${credential}`,
        accept: 'text/event-stream',
      },
    },
    (response) => {
      assert.equal(response.statusCode, 200)
      response.setEncoding('utf8')
      response.on('data', (chunk) => {
        buffer += chunk.replace(/\r\n?/g, '\n')
        let boundary = buffer.indexOf('\n\n')
        while (boundary >= 0) {
          const block = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          let type = 'message'
          const data = []
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) type = line.slice(6).trim()
            if (line.startsWith('data:')) data.push(line.slice(5).trim())
          }
          if (data.length) {
            const event = { type, data: JSON.parse(data.join('\n')) }
            const waiter = waiters.shift()
            if (waiter) waiter.resolve(event)
            else queue.push(event)
          }
          boundary = buffer.indexOf('\n\n')
        }
      })
      response.on('end', () => {
        closed = true
        for (const waiter of waiters.splice(0)) waiter.reject(new Error('SSE 已关闭'))
      })
    },
  )
  request.on('error', (error) => {
    closed = true
    for (const waiter of waiters.splice(0)) waiter.reject(error)
  })
  return {
    async next(type, timeoutMs = 5_000) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const index = queue.findIndex((event) => event.type === type)
        if (index >= 0) return queue.splice(index, 1)[0]
        if (closed) throw new Error('SSE 已关闭')
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      throw new Error(`等待 ${type} 事件超时`)
    },
    close() {
      request.destroy()
    },
  }
}

function taskFiles(title) {
  const taskJson = `${JSON.stringify(
    {
      id: 'task-1',
      title,
      status: 'planning',
      assignee: 'owner',
      priority: 'P2',
      created_at: new Date().toISOString(),
    },
    null,
    2,
  )}\n`
  return [
    {
      path: '.trellis/tasks/01-live/task.json',
      content: taskJson,
      baseSha256: null,
    },
    {
      path: '.trellis/tasks/01-live/prd.md',
      content: `# ${title}\n\n## Requirements\n- 同步\n\n## Acceptance Criteria\n- [ ] 完成\n`,
      baseSha256: null,
    },
  ]
}

test('两个 Agent 通过 tasks 快照和 SSE 在同一任务空间实时对齐', async (t) => {
  const context = await setupRuntime(t)
  const events = openAgentEvents(context.runtime, context.memberEnrollment.credential)
  t.after(() => events.close())
  await context.ownerClient.uploadTaskSpaceChanges(context.taskSpaceId, {
    batchId: 'batch-live-1',
    clientSequence: 1,
    files: taskFiles('实时任务'),
  })
  await events.next('task.changed')
  const board = await context.runtime.services.boardService.getBoard(context.memberActor, {
    taskSpaceId: context.taskSpaceId,
    limit: 20,
  })
  assert.equal(board.tasks.length, 1)
  assert.equal(board.tasks[0].title, '实时任务')
  assert.equal(board.tasks[0].branchName, 'main')
  assert.equal(fs.existsSync(path.join(context.root, 'data', 'projects')), false)
})

test('同一文件旧基线并发写入只有一个成功，另一个得到明确冲突', async (t) => {
  const context = await setupRuntime(t)
  await context.ownerClient.uploadTaskSpaceChanges(context.taskSpaceId, {
    batchId: 'batch-base',
    clientSequence: 1,
    files: taskFiles('基线任务'),
  })
  await assert.rejects(
    () =>
      context.memberClient.uploadTaskSpaceChanges(context.taskSpaceId, {
        batchId: 'batch-stale',
        clientSequence: 1,
        files: taskFiles('过期写入'),
      }),
    (error) => {
      assert.equal(error.serverCode, 'TASK_FILE_CONFLICT')
      assert.equal(error.status, 409)
      assert.deepEqual(error.details.files.map((file) => file.path).sort(), [
        '.trellis/tasks/01-live/prd.md',
        '.trellis/tasks/01-live/task.json',
      ])
      return true
    },
  )
  const snapshot = await context.ownerClient.fetchTaskSpaceSnapshot(context.taskSpaceId)
  assert.equal(snapshot.revision, 1)
  assert.equal(snapshot.files.length, 2)
})

test('在线 Agent 通过 SSE 收到独立任务命令，离线时服务端拒绝入队', async (t) => {
  const context = await setupRuntime(t)
  const events = openAgentEvents(context.runtime, context.memberEnrollment.credential)
  t.after(() => events.close())
  const operation = context.runtime.services.taskCommands.enqueue(context.ownerActor, {
    commandType: 'create_task',
    taskSpaceId: context.taskSpaceId,
    assigneeUserId: context.memberUser.id,
    title: '由客户端创建',
    description: '命令事件验证',
    priority: 'P2',
    slug: 'client-created',
    idempotencyKey: 'command-live-1',
  })
  const event = await events.next('command')
  assert.equal(event.data.payload.command.id, operation.operation.id)
  assert.equal(event.data.payload.command.type, 'create_task')
  assert.equal(event.data.payload.command.payload.taskSpaceId, context.taskSpaceId)

  context.runtime.db
    .prepare("UPDATE agent_device SET last_seen_at = '2000-01-01T00:00:00.000Z' WHERE user_id = ?")
    .run(context.memberUser.id)
  assert.throws(
    () =>
      context.runtime.services.taskCommands.enqueue(context.ownerActor, {
        commandType: 'create_task',
        taskSpaceId: context.taskSpaceId,
        assigneeUserId: context.memberUser.id,
        title: '离线任务',
        priority: 'P2',
        slug: 'offline-task',
        idempotencyKey: 'command-live-2',
      }),
    (error) => error.code === 'AGENT_OFFLINE',
  )
})

test('数据库损坏后可恢复最近快照并继续通过原客户端读取任务', async (t) => {
  const context = await setupRuntime(t)
  await context.ownerClient.uploadTaskSpaceChanges(context.taskSpaceId, {
    batchId: 'batch-backup',
    clientSequence: 1,
    files: taskFiles('备份恢复任务'),
  })
  const backup = context.runtime.services.taskSnapshotBackups.backupNow({ force: true })
  assert.equal(typeof backup, 'string')
  assert.equal(fs.existsSync(backup), true)

  await context.runtime.stop()
  fs.writeFileSync(context.databaseFile, 'not a sqlite database')
  await assert.rejects(
    () =>
      createTeamRuntime({
        config: context.runtime.config,
        databaseFile: context.databaseFile,
        dataDir: path.dirname(context.databaseFile),
        logger: SILENT_LOGGER,
        requireAdmin: false,
        enablePolling: false,
      }),
    /file is not a database/,
  )

  fs.copyFileSync(backup, context.databaseFile)
  const restored = await createTeamRuntime({
    config: context.runtime.config,
    databaseFile: context.databaseFile,
    dataDir: path.dirname(context.databaseFile),
    logger: SILENT_LOGGER,
    requireAdmin: false,
    enablePolling: false,
  })
  await restored.start()
  context.cleanup.runtime = restored
  assert.equal(restored.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
  const snapshot = await context.ownerClient.fetchTaskSpaceSnapshot(context.taskSpaceId)
  assert.equal(snapshot.revision, 1)
  assert.equal(
    snapshot.files
      .find((file) => file.path.endsWith('task.json'))
      ?.content.includes('备份恢复任务'),
    true,
  )
})
