import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createUser } from '../../../packages/server/team/auth.js'
import { createTeamRuntime } from '../../../packages/server/team/http.js'
import { openDatabase } from '../../../packages/server/database.js'
import { createServerLogger, serverLogDir } from '../../../packages/server/logger.js'

const taskDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const evidenceFile = path.join(taskDir, 'api-e2e-evidence.jsonl')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-project-removal-e2e-'))
const dataDir = path.join(root, 'data')
const databaseFile = path.join(dataDir, 'board.sqlite')
const adminPassword = crypto.randomBytes(24).toString('base64url')
const teamAdminPassword = crypto.randomBytes(24).toString('base64url')
const evidence = []

fs.writeFileSync(evidenceFile, '')

function record(entry) {
  evidence.push({
    time: new Date().toISOString(),
    ...entry,
  })
  fs.appendFileSync(evidenceFile, `${JSON.stringify(evidence.at(-1))}\n`)
}

function logSnapshot() {
  const dir = serverLogDir(dataDir)
  if (!fs.existsSync(dir)) return new Map()
  return new Map(
    fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.log'))
      .map((name) => {
        const file = path.join(dir, name)
        return [name, fs.statSync(file).size]
      }),
  )
}

function logDelta(before) {
  const dir = serverLogDir(dataDir)
  if (!fs.existsSync(dir)) return ''
  const chunks = []
  for (const name of fs.readdirSync(dir).filter((item) => item.endsWith('.log'))) {
    const file = path.join(dir, name)
    const offset = before.get(name) || 0
    const size = fs.statSync(file).size
    if (size <= offset) continue
    chunks.push(fs.readFileSync(file).subarray(offset).toString('utf8'))
  }
  return chunks.join('')
}

function request({ port, method = 'GET', pathname, body = null, cookie = null }) {
  const payload = body == null ? null : JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const headers = {
      host: `127.0.0.1:${port}`,
    }
    if (payload != null) {
      headers['content-type'] = 'application/json'
      headers['content-length'] = String(Buffer.byteLength(payload))
      headers.origin = `http://127.0.0.1:${port}`
    }
    if (cookie) headers.cookie = cookie
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: pathname,
        method,
        headers,
        timeout: 15_000,
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
            parsed = { raw: text.slice(0, 500) }
          }
          resolve({
            status: response.statusCode || 0,
            headers: response.headers,
            body: parsed,
          })
        })
      },
    )
    req.on('timeout', () => req.destroy(new Error('request timeout')))
    req.on('error', reject)
    req.end(payload || undefined)
  })
}

function responseCookie(response) {
  const raw = response.headers['set-cookie']
  const first = Array.isArray(raw) ? raw[0] : raw
  assert.ok(first, '登录响应缺少 Set-Cookie')
  return first.split(';', 1)[0]
}

async function trackedRequest({
  label,
  port,
  logger,
  backendErrors,
  method,
  pathname,
  body = null,
  cookie = null,
}) {
  await logger.flush()
  const logOffset = logSnapshot()
  const errorOffset = backendErrors.length
  const response = await request({ port, method, pathname, body, cookie })
  await logger.flush()
  const rawLogDelta = logDelta(logOffset)
  const backendErrorDelta = backendErrors.slice(errorOffset)
  record({
    label,
    request: `${method} ${pathname}`,
    status: response.status,
    responseSummary:
      response.body && typeof response.body === 'object'
        ? {
            error: response.body.error || null,
            code: response.body.code || null,
            purged: response.body.purged ?? null,
            projectId: response.body.projectId || null,
            projectName: response.body.projectName || null,
            backupName: response.body.backupName || null,
            projectCount: Array.isArray(response.body.projects)
              ? response.body.projects.length
              : null,
            auditEventCount: Array.isArray(response.body.events)
              ? response.body.events.length
              : null,
          }
        : null,
    backendLog: {
      accessLog: 'unavailable',
      errorCount: backendErrorDelta.length,
      rawDeltaBytes: Buffer.byteLength(rawLogDelta),
    },
  })
  assert.equal(
    backendErrorDelta.length,
    0,
    `${label} 产生后端错误日志：${backendErrorDelta.join('\n')}`,
  )
  return response
}

let runtime
let logger
try {
  const seedDb = openDatabase({
    databaseFile,
    fallbackRepositories: [],
    importLegacyRepositories: false,
    legacyJsonImport: false,
    logger: { info() {}, warn() {}, error() {} },
  })
  let admin
  let teamAdmin
  try {
    const now = new Date().toISOString()
    seedDb
      .prepare(`
        INSERT INTO team(id, name, slug, status, created_at, updated_at)
        VALUES ('e2e-project-removal-team', 'E2E 项目移除团队', 'e2e-project-removal', 'active', ?, ?)
      `)
      .run(now, now)
    admin = await createUser(seedDb, {
      username: 'e2e-project-removal-admin',
      displayName: 'E2E 项目移除管理员',
      password: adminPassword,
      systemAdmin: true,
      mustChangePassword: false,
    })
    teamAdmin = await createUser(seedDb, {
      username: 'e2e-project-removal-team-admin',
      displayName: 'E2E 团队管理员',
      password: teamAdminPassword,
      systemAdmin: false,
      mustChangePassword: false,
    })
    const insertMember = seedDb.prepare(`
      INSERT INTO team_member(team_id, user_id, role, created_at, updated_at)
      VALUES ('e2e-project-removal-team', ?, ?, ?, ?)
    `)
    insertMember.run(admin.id, 'admin', now, now)
    insertMember.run(teamAdmin.id, 'admin', now, now)
  } finally {
    seedDb.close()
  }

  logger = createServerLogger({
    dataDir,
    console: { log() {}, info() {}, warn() {}, error() {} },
  })
  const backendErrors = []
  const runtimeLogger = {
    log: (...args) => logger.log(...args),
    info: (...args) => logger.info(...args),
    warn: (...args) => logger.warn(...args),
    error: (...args) => {
      backendErrors.push(args.map((value) => String(value)).join(' '))
      logger.error(...args)
    },
    flush: () => logger.flush(),
    close: () => logger.close(),
  }
  runtime = await createTeamRuntime({
    config: {
      mode: 'team',
      bindHost: '127.0.0.1',
      port: 0,
      sessionTtlMs: 12 * 60 * 60 * 1000,
      agentStaleMs: 60_000,
      trustProxy: false,
      allowLocalGitRemotes: false,
      pluginAllowlist: [],
    },
    databaseFile,
    dataDir,
    logger: runtimeLogger,
    enablePolling: false,
  })
  await runtime.start()
  const port = runtime.address().port
  const startedAt = new Date().toISOString()
  record({
    label: 'server-start',
    pid: process.pid,
    port,
    startedAt,
    databaseFile: path.basename(databaseFile),
    accessLog: 'disabled: no request-level access logger',
  })

  const loginAdmin = await trackedRequest({
    label: '管理员登录',
    port,
    logger,
    backendErrors,
    method: 'POST',
    pathname: '/api/auth/login',
    body: { username: 'e2e-project-removal-admin', password: adminPassword },
  })
  assert.equal(loginAdmin.status, 200, JSON.stringify(loginAdmin.body))
  const adminCookie = responseCookie(loginAdmin)

  const loginTeamAdmin = await trackedRequest({
    label: '团队管理员登录',
    port,
    logger,
    backendErrors,
    method: 'POST',
    pathname: '/api/auth/login',
    body: {
      username: 'e2e-project-removal-team-admin',
      password: teamAdminPassword,
    },
  })
  assert.equal(loginTeamAdmin.status, 200, JSON.stringify(loginTeamAdmin.body))
  const teamAdminCookie = responseCookie(loginTeamAdmin)

  const runtimeProbe = await trackedRequest({
    label: '只读契约探测',
    port,
    logger,
    backendErrors,
    method: 'GET',
    pathname: '/api/auth/me',
    cookie: adminCookie,
  })
  assert.equal(runtimeProbe.status, 200)
  assert.equal(runtimeProbe.body.systemAdmin, true)

  const now = new Date().toISOString()
  const agentId = 'e2e-project-removal-agent'
  runtime.db
    .prepare(`
      INSERT INTO agent_device(
        id, user_id, device_name, platform, agent_version, protocol_version,
        credential_hash, status, created_at
      ) VALUES (?, ?, 'E2E Agent', 'win32', '0.0.0', 3, ?, 'active', ?)
    `)
    .run(agentId, admin.id, crypto.randomBytes(32).toString('hex'), now)

  const projectA = runtime.services.taskSpaces.attach(admin.id, agentId, {
    remoteUrl: 'https://example.com/e2e/project-removal-a.git',
    branchName: 'main',
    displayName: 'E2E 待移除项目 A',
    teamId: 'e2e-project-removal-team',
    developerId: 'e2e-project-removal-admin',
    localRepoKey: 'a'.repeat(64),
  })
  const projectB = runtime.services.taskSpaces.attach(admin.id, agentId, {
    remoteUrl: 'https://example.com/e2e/project-removal-b.git',
    branchName: 'main',
    displayName: 'E2E 保留项目 B',
    teamId: 'e2e-project-removal-team',
    developerId: 'e2e-project-removal-admin',
    localRepoKey: 'b'.repeat(64),
  })

  const executionTaskKey = `${projectA.taskSpace.id}::e2e-task-a`
  runtime.db
    .prepare(`
      INSERT INTO sync_task(
        execution_task_key, task_key, task_space_id, project_id, task_id, relative_dir,
        title, description, priority, stage, archived, materialization_state,
        task_version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'e2e-task-a', '.trellis/tasks/11-26-e2e-task-a',
        'E2E 待删除任务', '', 'P2', 'planning', 0, 'materialized', 1, ?, ?)
    `)
    .run(
      executionTaskKey,
      `${projectA.taskSpace.id}::.trellis/tasks/11-26-e2e-task-a`,
      projectA.taskSpace.id,
      projectA.project.id,
      now,
      now,
    )
  runtime.db
    .prepare(`
      INSERT INTO sync_task_lease(
        id, execution_task_key, agent_id, user_id, lease_token, status,
        expires_at, last_heartbeat_at, created_at, updated_at
      ) VALUES ('e2e-project-removal-lease', ?, ?, ?, ?, 'active', ?, ?, ?, ?)
    `)
    .run(executionTaskKey, agentId, admin.id, crypto.randomBytes(16).toString('hex'), now, now, now, now)

  const survivorCounts = () =>
    Object.fromEntries(
      [
        ['sync_project', 'id', projectB.project.id],
        ['sync_project_member', 'project_id', projectB.project.id],
        ['sync_project_team_access', 'project_id', projectB.project.id],
        ['sync_task_space', 'project_id', projectB.project.id],
        ['sync_task', 'project_id', projectB.project.id],
        ['sync_task_index', 'project_id', projectB.project.id],
      ].map(([table, column, id]) => [
        table,
        runtime.db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column} = ?`).get(id).count,
      ]),
    )
  const survivorCountsBefore = survivorCounts()

  const baselineProjects = await trackedRequest({
    label: '项目基线',
    port,
    logger,
    backendErrors,
    method: 'GET',
    pathname: '/api/admin/projects?teamId=e2e-project-removal-team',
    cookie: adminCookie,
  })
  assert.equal(baselineProjects.status, 200)
  assert.deepEqual(
    new Set(baselineProjects.body.projects.map((project) => project.id)),
    new Set([projectA.project.id, projectB.project.id]),
  )
  const backupCountBefore = runtime.services.taskSnapshotBackups.snapshots().length

  const unauthenticatedDelete = await trackedRequest({
    label: '未登录删除',
    port,
    logger,
    backendErrors,
    method: 'DELETE',
    pathname: `/api/admin/projects/${encodeURIComponent(projectA.project.id)}`,
    body: { confirmation: projectA.project.name },
  })
  assert.equal(unauthenticatedDelete.status, 401)

  const forbiddenDelete = await trackedRequest({
    label: '团队管理员删除',
    port,
    logger,
    backendErrors,
    method: 'DELETE',
    pathname: `/api/admin/projects/${encodeURIComponent(projectA.project.id)}`,
    body: { confirmation: projectA.project.name },
    cookie: teamAdminCookie,
  })
  assert.equal(forbiddenDelete.status, 403)
  assert.equal(
    runtime.db.prepare('SELECT COUNT(*) AS count FROM sync_project WHERE id = ?').get(projectA.project.id)
      .count,
    1,
  )
  assert.equal(runtime.services.taskSnapshotBackups.snapshots().length, backupCountBefore)

  const invalidDelete = await trackedRequest({
    label: '错误确认名称',
    port,
    logger,
    backendErrors,
    method: 'DELETE',
    pathname: `/api/admin/projects/${encodeURIComponent(projectA.project.id)}`,
    body: { confirmation: ` ${projectA.project.name} ` },
    cookie: adminCookie,
  })
  assert.equal(invalidDelete.status, 400)
  assert.match(invalidDelete.body.error, /项目确认名称/)
  assert.equal(runtime.services.taskSnapshotBackups.snapshots().length, backupCountBefore)

  const purge = await trackedRequest({
    label: '系统管理员删除项目 A',
    port,
    logger,
    backendErrors,
    method: 'DELETE',
    pathname: `/api/admin/projects/${encodeURIComponent(projectA.project.id)}`,
    body: { confirmation: projectA.project.name },
    cookie: adminCookie,
  })
  assert.equal(purge.status, 200, JSON.stringify(purge.body))
  assert.equal(purge.body.purged, true)
  assert.equal(purge.body.projectId, projectA.project.id)
  assert.equal(purge.body.projectName, projectA.project.name)
  assert.match(purge.body.backupName, /^board\.sqlite\.snapshot\./)
  assert.equal(JSON.stringify(purge.body).includes(root), false)
  assert.deepEqual(purge.body.summary.taskSpaceCount, 1)
  assert.deepEqual(purge.body.summary.taskCount, 1)

  const afterProjects = await trackedRequest({
    label: '删除后项目读回',
    port,
    logger,
    backendErrors,
    method: 'GET',
    pathname: '/api/admin/projects?teamId=e2e-project-removal-team',
    cookie: adminCookie,
  })
  assert.equal(afterProjects.status, 200)
  assert.equal(afterProjects.body.projects.some((project) => project.id === projectA.project.id), false)
  assert.equal(afterProjects.body.projects.some((project) => project.id === projectB.project.id), true)

  const removedTaskSpaces = await trackedRequest({
    label: '已删除项目任务空间读回',
    port,
    logger,
    backendErrors,
    method: 'GET',
    pathname: `/api/projects/${encodeURIComponent(projectA.project.id)}/task-spaces`,
    cookie: adminCookie,
  })
  assert.equal(removedTaskSpaces.status, 404)

  const survivorTaskSpaces = await trackedRequest({
    label: '保留项目任务空间读回',
    port,
    logger,
    backendErrors,
    method: 'GET',
    pathname: `/api/projects/${encodeURIComponent(projectB.project.id)}/task-spaces`,
    cookie: adminCookie,
  })
  assert.equal(survivorTaskSpaces.status, 200)
  assert.equal(survivorTaskSpaces.body.taskSpaces.length, 1)

  const removedTaskQuery = await trackedRequest({
    label: '已删除项目任务查询',
    port,
    logger,
    backendErrors,
    method: 'GET',
    pathname: `/api/tasks/query?teamId=e2e-project-removal-team&projectIds=${encodeURIComponent(projectA.project.id)}`,
    cookie: adminCookie,
  })
  assert.equal(removedTaskQuery.status, 403)

  const survivorTaskQuery = await trackedRequest({
    label: '保留项目任务查询',
    port,
    logger,
    backendErrors,
    method: 'GET',
    pathname: `/api/tasks/query?teamId=e2e-project-removal-team&projectIds=${encodeURIComponent(projectB.project.id)}`,
    cookie: adminCookie,
  })
  assert.equal(survivorTaskQuery.status, 200)
  assert.equal(survivorTaskQuery.body.total, 0)

  const auditResponse = await trackedRequest({
    label: '删除审计读回',
    port,
    logger,
    backendErrors,
    method: 'GET',
    pathname: '/api/admin/audit?teamId=e2e-project-removal-team&limit=200',
    cookie: adminCookie,
  })
  assert.equal(auditResponse.status, 200)
  const audit = auditResponse.body.events.find(
    (event) => event.action === 'project_purged' && event.projectId === projectA.project.id,
  )
  assert.ok(audit)
  assert.equal(audit.detail.projectName, projectA.project.name)
  assert.equal(audit.detail.backupName, purge.body.backupName)

  const cascadeChecks = Object.fromEntries(
    [
      ['sync_project', 'id', projectA.project.id],
      ['sync_project_member', 'project_id', projectA.project.id],
      ['sync_project_team_access', 'project_id', projectA.project.id],
      ['sync_task_space', 'project_id', projectA.project.id],
      ['sync_task', 'project_id', projectA.project.id],
      ['sync_task_lease', 'execution_task_key', executionTaskKey],
      ['sync_task_index', 'project_id', projectA.project.id],
      ['sync_task_command', 'project_id', projectA.project.id],
      ['sync_agent_binding', 'task_space_id', projectA.taskSpace.id],
      ['sync_agent_cursor', 'task_space_id', projectA.taskSpace.id],
      ['sync_task_space_file', 'task_space_id', projectA.taskSpace.id],
      ['sync_conflict', 'task_space_id', projectA.taskSpace.id],
    ].map(([table, column, id]) => [
      table,
      runtime.db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column} = ?`).get(id).count,
    ]),
  )
  assert.ok(Object.values(cascadeChecks).every((count) => count === 0), JSON.stringify(cascadeChecks))
  assert.equal(
    runtime.db.prepare('SELECT COUNT(*) AS count FROM sync_project WHERE id = ?').get(projectB.project.id)
      .count,
    1,
  )
  const survivorCountsAfter = survivorCounts()
  assert.deepEqual(survivorCountsAfter, survivorCountsBefore)
  const snapshotsAfter = runtime.services.taskSnapshotBackups.snapshots()
  assert.ok(snapshotsAfter.length <= 5)
  assert.ok(snapshotsAfter.includes(purge.body.backupName))

  record({
    label: '数据库与副作用复核',
    cascadeChecks,
    survivingProjectB: survivorCountsAfter,
    auditId: audit.id,
    backupCountBefore,
    backupCountAfter: snapshotsAfter.length,
  })
  record({
    label: 'cleanup',
    tempRoot: path.basename(root),
    result: 'will remove isolated temporary data directory after evidence is captured',
  })

  console.log(
    JSON.stringify(
      {
        ok: true,
        pid: process.pid,
        port,
        evidenceFile,
        backupName: purge.body.backupName,
        cascadeChecks,
      },
      null,
      2,
    ),
  )
} finally {
  if (runtime) await runtime.stop().catch(() => {})
  if (logger) await logger.close().catch(() => {})
  fs.rmSync(root, { recursive: true, force: true })
}
