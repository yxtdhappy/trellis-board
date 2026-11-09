import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { createUser } from '../server/team/auth.js'
import { createTeamRuntime } from '../server/team/http.js'
import { AGENT_EVENT_TYPES, MAX_EVENT_PAYLOAD_BYTES } from '../server/team/agent-events.js'

const SILENT_LOGGER = {
  info() {},
  warn() {},
  error() {},
}

function testConfig() {
  return {
    mode: 'team',
    bindHost: '127.0.0.1',
    port: 0,
    publicUrl: new URL('http://127.0.0.1:4317'),
    publicOrigin: 'http://127.0.0.1:4317',
    sessionTtlMs: 12 * 60 * 60 * 1000,
    agentStaleMs: 60_000,
    gitPollMs: 60_000,
    cookieSecure: false,
    trustProxy: false,
    allowLocalGitRemotes: false,
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex')
}

function seedTeam(runtime, teamId) {
  const now = new Date().toISOString()
  runtime.db
    .prepare(`
    INSERT OR IGNORE INTO team(id, name, slug, status, created_at, updated_at)
    VALUES (?, ?, ?, 'active', ?, ?)
  `)
    .run(teamId, `团队 ${teamId}`, teamId, now, now)
}

function addTeamMember(runtime, teamId, userId, role = 'member') {
  const now = new Date().toISOString()
  runtime.db
    .prepare(`
    INSERT OR IGNORE INTO team_member(team_id, user_id, role, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `)
    .run(teamId, userId, role, now, now)
}

function seedProject(runtime, { teamId, projectId, root }) {
  const now = new Date().toISOString()
  const repositoryPath = path.join(root, 'projects', projectId)
  fs.mkdirSync(repositoryPath, { recursive: true })
  runtime.db
    .prepare(`
    INSERT INTO repositories(id, name, path, path_key, position, created_at, updated_at)
    VALUES (?, ?, ?, ?, 0, ?, ?)
  `)
    .run(projectId, projectId, repositoryPath, repositoryPath.toLowerCase(), now, now)
  runtime.db
    .prepare(`
    INSERT INTO team_project(
      repository_id, team_id, workspace_key, remote_url, remote_identity_hash,
      sync_branch, trusted_task_toolchain_sha256, sync_status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'main', ?, 'current', ?, ?)
  `)
    .run(
      projectId,
      teamId,
      `${projectId}-workspace`,
      `https://example.com/${projectId}.git`,
      'f'.repeat(64),
      'a'.repeat(64),
      now,
      now,
    )
  return repositoryPath
}

function addProjectMember(
  runtime,
  projectId,
  userId,
  { role = 'member', trellisDevId = null } = {},
) {
  const now = new Date().toISOString()
  runtime.db
    .prepare(`
    INSERT INTO project_member(
      project_id, user_id, role, trellis_dev_id, created_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
    .run(projectId, userId, role, trellisDevId, userId, now, now)
}

function createAgent(runtime, { userId, teamId, projectId, credential, status = 'approved' }) {
  const agentId = crypto.randomUUID()
  const bindingId = crypto.randomUUID()
  const now = new Date().toISOString()
  runtime.db
    .prepare(`
    INSERT INTO agent_device(
      id, user_id, device_name, platform, agent_version, protocol_version,
      credential_hash, status, last_seen_at, created_at
    ) VALUES (?, ?, '测试设备', 'win32', '1.0.0', 1, ?, 'active', ?, ?)
  `)
    .run(agentId, userId, sha256(credential), now, now)
  runtime.db
    .prepare(`
    INSERT INTO agent_project_binding(
      id, agent_id, team_id, project_id, local_repo_key, local_display_name,
      branch_name, sync_status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'repo', 'main', ?, ?, ?)
  `)
    .run(
      bindingId,
      agentId,
      teamId,
      projectId,
      crypto.createHash('sha256').update(`${agentId}:${projectId}`).digest('hex'),
      status,
      now,
      now,
    )
  return { agentId, bindingId, credential, userId }
}

async function setupRuntime(t, { teamId = 't1', projectId = 'p1' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-team-events-'))
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
  const user = await createUser(runtime.db, {
    username: `user-${crypto.randomBytes(4).toString('hex')}`,
    displayName: '测试用户',
    password: 'User-Password-123',
    systemAdmin: false,
    mustChangePassword: false,
  })
  seedTeam(runtime, teamId)
  addTeamMember(runtime, teamId, user.id, 'admin')
  const repositoryPath = seedProject(runtime, { teamId, projectId, root })
  addProjectMember(runtime, projectId, user.id, { role: 'lead', trellisDevId: 'alice' })
  return { runtime, root, user, repositoryPath, teamId, projectId }
}

function writeTask(
  repositoryPath,
  { dir = '11-05-demo', taskVersion = 'v1', prd = '# PRD\n' } = {},
) {
  const taskDir = path.join(repositoryPath, '.trellis', 'tasks', dir)
  fs.mkdirSync(taskDir, { recursive: true })
  fs.writeFileSync(
    path.join(taskDir, 'task.json'),
    `${JSON.stringify(
      {
        title: '演示任务',
        status: 'in_progress',
        assignee: 'alice',
        priority: 'P1',
      },
      null,
      2,
    )}\n`,
  )
  fs.writeFileSync(path.join(taskDir, 'prd.md'), prd)
  fs.writeFileSync(path.join(taskDir, 'design.md'), '# Design\n')
  fs.writeFileSync(path.join(taskDir, 'implement.md'), '# Implement\n')
  const plan = path.join(repositoryPath, '.trellis', 'tasks', '11-05-demo-plan.json')
  fs.writeFileSync(plan, `${JSON.stringify({ taskVersion })}\n`)
  return { relativeDir: `.trellis/tasks/${dir}`, taskKey: dir, executionTaskKey: dir, taskVersion }
}

function openEventStream(runtime, { credential, teamId, lastEventId = null }) {
  const address = runtime.address()
  const events = []
  const emitter = new EventEmitter()
  let index = 0
  let buffer = ''
  let responseStatus = null
  let responseHeaders = null
  let ended = false
  const ready = new Promise((resolve, reject) => {
    const headers = {
      host: '127.0.0.1:4317',
      accept: 'text/event-stream',
      authorization: `Bearer ${credential}`,
    }
    if (lastEventId != null) headers['last-event-id'] = String(lastEventId)
    const request = http.request(
      {
        hostname: '127.0.0.1',
        port: address.port,
        path: `/api/agent/events?teamId=${encodeURIComponent(teamId)}`,
        method: 'GET',
        headers,
      },
      (response) => {
        responseStatus = response.statusCode
        responseHeaders = response.headers
        response.setEncoding('utf8')
        response.on('data', (chunk) => {
          buffer += chunk.replaceAll('\r\n', '\n')
          let boundary = buffer.indexOf('\n\n')
          while (boundary !== -1) {
            const block = buffer.slice(0, boundary)
            buffer = buffer.slice(boundary + 2)
            boundary = buffer.indexOf('\n\n')
            let id = null
            let type = 'message'
            const dataLines = []
            for (const line of block.split('\n')) {
              if (!line || line.startsWith(':')) continue
              const colon = line.indexOf(':')
              const field = colon === -1 ? line : line.slice(0, colon)
              const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '')
              if (field === 'id') id = value
              else if (field === 'event') type = value
              else if (field === 'data') dataLines.push(value)
            }
            if (!dataLines.length) continue
            const raw = dataLines.join('\n')
            let data = raw
            try {
              data = JSON.parse(raw)
            } catch {
              // Keep raw data for diagnostics.
            }
            events.push({ id, type, data })
            emitter.emit('event')
          }
        })
        response.on('end', () => {
          ended = true
          emitter.emit('event')
        })
        resolve({ status: responseStatus, headers: responseHeaders })
      },
    )
    request.on('error', (error) => {
      if (responseStatus == null) reject(error)
      ended = true
      emitter.emit('event')
    })
    request.end()
    emitter.on('close-request', () => request.destroy())
  })
  return {
    ready,
    events,
    get status() {
      return responseStatus
    },
    get headers() {
      return responseHeaders
    },
    get ended() {
      return ended
    },
    close() {
      emitter.emit('close-request')
    },
    next(timeoutMs = 3_000) {
      if (events.length > index) return Promise.resolve(events[index++])
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup()
          reject(new Error('等待事件超时'))
        }, timeoutMs)
        const handler = () => {
          if (events.length > index) {
            cleanup()
            resolve(events[index++])
          } else if (ended) {
            cleanup()
            reject(new Error('事件流已结束'))
          }
        }
        const cleanup = () => {
          clearTimeout(timer)
          emitter.removeListener('event', handler)
        }
        emitter.on('event', handler)
      })
    },
  }
}

async function publishCreated(runtime, projectId, task, overrides = {}) {
  return runtime.services.agentEvents.publishTaskEvent({
    eventType: AGENT_EVENT_TYPES.TASK_CREATED,
    projectId,
    relativeDir: task.relativeDir,
    taskKey: task.taskKey,
    executionTaskKey: task.executionTaskKey,
    taskVersion: task.taskVersion,
    ...overrides,
  })
}

test('事件流按团队鉴权、完整快照并支持 Last-Event-ID 断线补发', async (t) => {
  const { runtime, user, repositoryPath, teamId, projectId } = await setupRuntime(t)
  const agent = createAgent(runtime, {
    userId: user.id,
    teamId,
    projectId,
    credential: `c${'a'.repeat(40)}`,
  })
  const task = writeTask(repositoryPath, { taskVersion: 'v1' })
  const created = await publishCreated(runtime, projectId, task)
  assert.equal(created.length, 1)
  const createdId = created[0].id
  writeTask(repositoryPath, { taskVersion: 'v2' })
  await runtime.services.agentEvents.publishTaskEvent({
    eventType: AGENT_EVENT_TYPES.TASK_UPDATED,
    projectId,
    relativeDir: task.relativeDir,
    taskKey: task.taskKey,
    executionTaskKey: task.executionTaskKey,
    taskVersion: 'v2',
  })

  const stream = openEventStream(runtime, {
    credential: agent.credential,
    teamId,
  })
  const opened = await stream.ready
  assert.equal(opened.status, 200)
  assert.match(String(opened.headers['content-type']), /text\/event-stream/)
  const first = await stream.next()
  assert.equal(first.type, 'task.created')
  assert.equal(first.data.payload.executionTaskKey, '11-05-demo')
  assert.equal(first.data.payload.title, '演示任务')
  assert.equal(first.data.payload.artifacts.prd, '# PRD\n')
  assert.equal(first.data.payload.assigneeDevId, 'alice')
  stream.close()

  const replay = openEventStream(runtime, {
    credential: agent.credential,
    teamId,
    lastEventId: createdId,
  })
  assert.equal((await replay.ready).status, 200)
  const second = await replay.next()
  assert.equal(second.type, 'task.updated')
  assert.equal(second.data.payload.taskVersion, 'v2')
  replay.close()
})

test('实时 revision 向同项目其他设备广播且不回发来源设备', async (t) => {
  const { runtime, user, teamId, projectId } = await setupRuntime(t)
  const source = createAgent(runtime, {
    userId: user.id,
    teamId,
    projectId,
    credential: `c${'r'.repeat(40)}`,
  })
  const target = createAgent(runtime, {
    userId: user.id,
    teamId,
    projectId,
    credential: `c${'s'.repeat(40)}`,
  })
  const sourceStream = openEventStream(runtime, {
    credential: source.credential,
    teamId,
  })
  const targetStream = openEventStream(runtime, {
    credential: target.credential,
    teamId,
  })
  assert.equal((await sourceStream.ready).status, 200)
  assert.equal((await targetStream.ready).status, 200)
  runtime.services.agentEvents.publishLiveChanged({
    projectId,
    revision: 9,
    taskKeys: ['p1::.trellis/tasks/live'],
    sourceAgentId: source.agentId,
  })
  const event = await targetStream.next()
  assert.equal(event.type, 'live.changed')
  assert.equal(event.data.payload.revision, 9)
  assert.equal(event.data.payload.sourceAgentId, source.agentId)
  await assert.rejects(sourceStream.next(120), /超时/)
  sourceStream.close()
  targetStream.close()
})

test('游标不可识别时发送 resync.required 并保留明确语义', async (t) => {
  const { runtime, user, repositoryPath, teamId, projectId } = await setupRuntime(t)
  const agent = createAgent(runtime, {
    userId: user.id,
    teamId,
    projectId,
    credential: `c${'b'.repeat(40)}`,
  })
  await publishCreated(runtime, projectId, writeTask(repositoryPath))
  const stream = openEventStream(runtime, {
    credential: agent.credential,
    teamId,
    lastEventId: 999_999,
  })
  assert.equal((await stream.ready).status, 200)
  const event = await stream.next()
  assert.equal(event.type, 'resync.required')
  assert.equal(event.data.payload.reason, 'unknown_cursor')
  assert.equal(event.data.payload.requestedLastEventId, 999_999)
  stream.close()
})

test('游标落后于保留窗口时返回 cursor_expired', async (t) => {
  const { runtime, root, user, repositoryPath, teamId, projectId } = await setupRuntime(t)
  const agent = createAgent(runtime, {
    userId: user.id,
    teamId,
    projectId,
    credential: `c${'m'.repeat(40)}`,
  })
  const task = writeTask(repositoryPath, { taskVersion: 'v1' })
  const first = await publishCreated(runtime, projectId, task)
  const staleId = first[0].id
  runtime.db.prepare('DELETE FROM agent_event WHERE id = ?').run(staleId)
  seedTeam(runtime, 't2')
  addTeamMember(runtime, 't2', user.id, 'admin')
  const p2Path = seedProject(runtime, { teamId: 't2', projectId: 'p2', root })
  createAgent(runtime, {
    userId: user.id,
    teamId: 't2',
    projectId: 'p2',
    credential: `c${'o'.repeat(40)}`,
  })
  await publishCreated(runtime, 'p2', writeTask(p2Path, { dir: '22-02-gap' }))
  writeTask(repositoryPath, { taskVersion: 'v2' })
  await runtime.services.agentEvents.publishTaskEvent({
    eventType: AGENT_EVENT_TYPES.TASK_UPDATED,
    projectId,
    relativeDir: task.relativeDir,
    taskKey: task.taskKey,
    executionTaskKey: task.executionTaskKey,
    taskVersion: 'v2',
  })
  const rows = runtime.db
    .prepare('SELECT id, team_id, target_agent_id, type FROM agent_event ORDER BY id')
    .all()
  assert.deepEqual(
    rows.map((row) => row.id),
    [2, 3],
    JSON.stringify({ staleId, rows }),
  )
  const stream = openEventStream(runtime, {
    credential: agent.credential,
    teamId,
    lastEventId: staleId,
  })
  assert.equal((await stream.ready).status, 200)
  // 保留窗口内的事件先补发，最后才发 resync.required。
  const replayed = await stream.next()
  assert.equal(replayed.type, 'task.updated', JSON.stringify({ staleId, rows, replayed }))
  assert.equal(replayed.data.payload.taskVersion, 'v2')
  const event = await stream.next()
  assert.equal(event.type, 'resync.required', JSON.stringify({ staleId, rows, event }))
  assert.equal(event.data.payload.reason, 'cursor_expired')
  stream.close()
})

test('任务索引差异会发布 created/updated/cancelled 事件', async (t) => {
  const { runtime, user, teamId, projectId } = await setupRuntime(t)
  createAgent(runtime, {
    userId: user.id,
    teamId,
    projectId,
    credential: `c${'n'.repeat(40)}`,
  })
  const task = (version) => ({
    taskKey: '11-05-indexed',
    executionTaskKey: '11-05-indexed',
    relativeDir: '.trellis/tasks/11-05-indexed',
    title: '索引任务',
    taskVersion: version,
    archived: false,
    priority: 'P1',
    derivedStage: 'implement',
    execution: { tags: [], attentionReasons: [] },
  })
  runtime.services.taskIndex.replaceProjectIndex({
    projectId,
    board: { tasks: [task('v1')] },
    boardVersion: 'b1',
  })
  assert.equal(
    runtime.db
      .prepare("SELECT type FROM agent_event WHERE task_id = '11-05-indexed' ORDER BY id")
      .all()
      .map((row) => row.type)
      .join(','),
    'task.created',
  )
  runtime.services.taskIndex.replaceProjectIndex({
    projectId,
    board: { tasks: [task('v2')] },
    boardVersion: 'b2',
  })
  assert.equal(
    runtime.db
      .prepare("SELECT type FROM agent_event WHERE task_id = '11-05-indexed' ORDER BY id")
      .all()
      .map((row) => row.type)
      .join(','),
    'task.created,task.updated',
  )
  runtime.services.taskIndex.replaceProjectIndex({
    projectId,
    board: { tasks: [] },
    boardVersion: 'b3',
  })
  assert.equal(
    runtime.db
      .prepare("SELECT type FROM agent_event WHERE task_id = '11-05-indexed' ORDER BY id")
      .all()
      .map((row) => row.type)
      .join(','),
    'task.created,task.updated,task.cancelled',
  )
})

test('超过 256KB 的任务快照降级为 task.snapshot_required', async (t) => {
  const { runtime, user, repositoryPath, teamId, projectId } = await setupRuntime(t)
  createAgent(runtime, {
    userId: user.id,
    teamId,
    projectId,
    credential: `c${'c'.repeat(40)}`,
  })
  const task = writeTask(repositoryPath, {
    prd: 'x'.repeat(MAX_EVENT_PAYLOAD_BYTES + 1024),
  })
  const rows = await publishCreated(runtime, projectId, task)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].type, 'task.snapshot_required')
  const payload = JSON.parse(rows[0].payload_json)
  assert.equal(payload.reason, 'artifact_too_large')
  assert.equal(payload.artifacts, undefined)
  assert.ok(Buffer.byteLength(rows[0].payload_json) <= MAX_EVENT_PAYLOAD_BYTES)
})

test('task.assigned 只投递给负责人和项目负责人绑定的 Agent', async (t) => {
  const { runtime, root, teamId, projectId } = await setupRuntime(t)
  const assignee = await createUser(runtime.db, {
    username: `assignee-${crypto.randomBytes(4).toString('hex')}`,
    displayName: '负责人',
    password: 'User-Password-123',
    systemAdmin: false,
    mustChangePassword: false,
  })
  const lead = await createUser(runtime.db, {
    username: `lead-${crypto.randomBytes(4).toString('hex')}`,
    displayName: '负责人二',
    password: 'User-Password-123',
    systemAdmin: false,
    mustChangePassword: false,
  })
  const other = await createUser(runtime.db, {
    username: `other-${crypto.randomBytes(4).toString('hex')}`,
    displayName: '其他成员',
    password: 'User-Password-123',
    systemAdmin: false,
    mustChangePassword: false,
  })
  for (const member of [assignee, lead, other]) {
    addTeamMember(runtime, teamId, member.id, 'member')
    addProjectMember(runtime, projectId, member.id, {
      role: member === lead ? 'lead' : 'member',
      trellisDevId: member === assignee ? 'bob' : member === lead ? 'carol' : 'dave',
    })
  }
  const agents = {
    assignee: createAgent(runtime, {
      userId: assignee.id,
      teamId,
      projectId,
      credential: `c${'d'.repeat(40)}`,
    }),
    lead: createAgent(runtime, {
      userId: lead.id,
      teamId,
      projectId,
      credential: `c${'e'.repeat(40)}`,
    }),
    other: createAgent(runtime, {
      userId: other.id,
      teamId,
      projectId,
      credential: `c${'f'.repeat(40)}`,
    }),
  }
  const task = writeTask(root + '/projects/' + projectId)
  const rows = await runtime.services.agentEvents.publishTaskEvent({
    eventType: AGENT_EVENT_TYPES.TASK_ASSIGNED,
    projectId,
    relativeDir: task.relativeDir,
    taskKey: task.taskKey,
    executionTaskKey: task.executionTaskKey,
    taskVersion: task.taskVersion,
    assignedUserIds: [assignee.id],
  })
  const targets = rows.map((row) => row.target_agent_id).sort()
  assert.deepEqual(targets, [agents.assignee.agentId, agents.lead.agentId].sort())
  assert.equal(targets.includes(agents.other.agentId), false)
})

test('相同任务版本的事件按去重键只写入一次', async (t) => {
  const { runtime, user, repositoryPath, teamId, projectId } = await setupRuntime(t)
  createAgent(runtime, {
    userId: user.id,
    teamId,
    projectId,
    credential: `c${'g'.repeat(40)}`,
  })
  const task = writeTask(repositoryPath)
  const first = await publishCreated(runtime, projectId, task)
  const second = await publishCreated(runtime, projectId, task)
  assert.equal(first.length, 1)
  assert.equal(second[0].id, first[0].id)
  const count = runtime.db
    .prepare(`
    SELECT COUNT(*) AS count FROM agent_event
    WHERE team_id = ? AND type = 'task.created'
  `)
    .get(teamId).count
  assert.equal(count, 1)
})

test('事件按团队隔离，不同团队游标互不影响', async (t) => {
  const { runtime, root, user, repositoryPath, projectId } = await setupRuntime(t)
  seedTeam(runtime, 't2')
  addTeamMember(runtime, 't2', user.id, 'admin')
  const p2Path = seedProject(runtime, { teamId: 't2', projectId: 'p2', root })
  addProjectMember(runtime, 'p2', user.id, { role: 'lead', trellisDevId: 'alice' })
  const t1Agent = createAgent(runtime, {
    userId: user.id,
    teamId: 't1',
    projectId: 'p1',
    credential: `c${'h'.repeat(40)}`,
  })
  const t2Agent = createAgent(runtime, {
    userId: user.id,
    teamId: 't2',
    projectId: 'p2',
    credential: `c${'i'.repeat(40)}`,
  })
  await publishCreated(runtime, projectId, writeTask(repositoryPath))
  const t2Task = writeTask(p2Path, { dir: '22-01-other' })
  const t2Rows = await publishCreated(runtime, 'p2', t2Task)
  assert.equal(t2Rows.length, 1)
  assert.equal(t2Rows[0].team_id, 't2')

  const t1Stream = openEventStream(runtime, {
    credential: t1Agent.credential,
    teamId: 't1',
  })
  assert.equal((await t1Stream.ready).status, 200)
  const t1Event = await t1Stream.next()
  assert.equal(t1Event.data.payload.projectId, 'p1')
  assert.equal(t1Event.data.payload.teamId, 't1')

  const t2Stream = openEventStream(runtime, {
    credential: t2Agent.credential,
    teamId: 't2',
  })
  assert.equal((await t2Stream.ready).status, 200)
  const t2Event = await t2Stream.next()
  assert.equal(t2Event.data.payload.projectId, 'p2', JSON.stringify(t2Event))
  assert.equal(t2Event.data.payload.teamId, 't2')

  const forbidden = openEventStream(runtime, {
    credential: t1Agent.credential,
    teamId: 't2',
  })
  const forbiddenResponse = await forbidden.ready
  assert.equal(forbiddenResponse.status, 403)
  forbidden.close()
  t1Stream.close()
  t2Stream.close()
})

test('慢消费者不会阻塞同一团队的其他事件流', async (t) => {
  const { runtime, root, user, teamId, projectId } = await setupRuntime(t)
  const slow = createAgent(runtime, {
    userId: user.id,
    teamId,
    projectId,
    credential: `c${'j'.repeat(40)}`,
  })
  const fast = createAgent(runtime, {
    userId: user.id,
    teamId,
    projectId,
    credential: `c${'k'.repeat(40)}`,
  })
  const events = runtime.services.agentEvents
  const fakeSlow = {
    destroyed: false,
    writeHead() {},
    flushHeaders() {},
    write() {
      return false
    },
    end() {},
    once() {},
    on() {},
  }
  const slowStream = events.openStream({
    agent: { id: slow.agentId, userId: user.id },
    teamId,
    response: fakeSlow,
  })
  assert.ok(slowStream)
  const fastStream = openEventStream(runtime, {
    credential: fast.credential,
    teamId,
  })
  assert.equal((await fastStream.ready).status, 200)
  const task = writeTask(path.join(root, 'projects', projectId))
  await publishCreated(runtime, projectId, task)
  const event = await fastStream.next()
  assert.equal(event.type, 'task.created')
  fastStream.close()
})

test('撤销 Agent 会关闭团队事件流并发送 agent.revoked', async (t) => {
  const { runtime, user, teamId, projectId } = await setupRuntime(t)
  const agent = createAgent(runtime, {
    userId: user.id,
    teamId,
    projectId,
    credential: `c${'l'.repeat(40)}`,
  })
  const stream = openEventStream(runtime, {
    credential: agent.credential,
    teamId,
  })
  assert.equal((await stream.ready).status, 200)
  runtime.services.agentEvents.publishAgentRevoked(agent.agentId, teamId)
  const event = await stream.next()
  assert.equal(event.type, 'agent.revoked')
  assert.equal(event.data.payload.agentId, agent.agentId)
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(stream.ended, true)
})

test('按 task-writes 的真实参数形状发布任务事件', async (t) => {
  const { runtime, user, repositoryPath, teamId, projectId } = await setupRuntime(t)
  createAgent(runtime, {
    userId: user.id,
    teamId,
    projectId,
    credential: `c${'q'.repeat(40)}`,
  })
  const task = writeTask(repositoryPath, { taskVersion: 'v3' })
  // task-writes 传入的是 board task 对象，而不是展开字段。
  const rows = await runtime.services.agentEvents.publishTaskEvent({
    eventType: AGENT_EVENT_TYPES.TASK_ASSIGNED,
    projectId,
    task,
    assignedUserIds: [user.id],
    dedupeKey: `task.assigned:${task.executionTaskKey}:v3`,
  })
  assert.equal(rows.length, 1)
  const payload = JSON.parse(rows[0].payload_json)
  assert.equal(rows[0].type, 'task.assigned')
  assert.equal(payload.executionTaskKey, task.executionTaskKey)
  assert.equal(payload.relativeDir, task.relativeDir)
  assert.equal(payload.taskVersion, 'v3')
})

test('已建立的事件流在用户被禁用后停止投递', async (t) => {
  const { runtime, user, teamId, projectId } = await setupRuntime(t)
  const agent = createAgent(runtime, {
    userId: user.id,
    teamId,
    projectId,
    credential: `c${'r'.repeat(40)}`,
  })
  const stream = openEventStream(runtime, { credential: agent.credential, teamId })
  assert.equal((await stream.ready).status, 200)
  runtime.db.prepare("UPDATE user_account SET status = 'disabled' WHERE id = ?").run(user.id)
  const task = writeTask(
    runtime.db.prepare('SELECT path FROM repositories WHERE id = ?').get(projectId).path,
    { dir: '11-05-after-disable' },
  )
  await publishCreated(runtime, projectId, task)
  const deadline = Date.now() + 3_000
  while (!stream.ended && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.equal(stream.ended, true)
  assert.equal(
    stream.events.some((event) => event.type === 'task.created'),
    false,
  )
})

test('团队被停用后已建立的事件流停止投递', async (t) => {
  const { runtime, user, teamId, projectId } = await setupRuntime(t)
  const agent = createAgent(runtime, {
    userId: user.id,
    teamId,
    projectId,
    credential: `c${'s'.repeat(40)}`,
  })
  const stream = openEventStream(runtime, { credential: agent.credential, teamId })
  assert.equal((await stream.ready).status, 200)
  runtime.db.prepare("UPDATE team SET status = 'disabled' WHERE id = ?").run(teamId)
  const task = writeTask(
    runtime.db.prepare('SELECT path FROM repositories WHERE id = ?').get(projectId).path,
    { dir: '11-05-after-team-disable' },
  )
  await publishCreated(runtime, projectId, task)
  const deadline = Date.now() + 3_000
  while (!stream.ended && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.equal(stream.ended, true)
})
