import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { normalizeRemoteIdentity } from '../agent/git-sync.js'
import { parseTeamConfig } from '../server/config.js'
import { openDatabase } from '../server/database.js'
import { createUser } from '../server/team/auth.js'
import { syncAssignmentsFromBoardInTransaction } from '../server/team/assignments.js'
import { diagnose, initFirstAdmin } from '../server/team/cli.js'
import { normalizeGitRemote } from '../server/team/git-manager.js'
import { createTeamRuntime } from '../server/team/http.js'
import { createProjectService } from '../server/team/projects.js'

const PUBLIC_ORIGIN = 'http://127.0.0.1:4317'
const HOST = '127.0.0.1:4317'
const SILENT_LOGGER = {
  info() {},
  warn() {},
  error() {},
}

test('团队配置按公开地址默认安全 Cookie，并拒绝非回环不安全配置', () => {
  const local = parseTeamConfig({
    TRELLIS_BOARD_MODE: 'team',
    TRELLIS_TEAM_PUBLIC_URL: 'http://127.0.0.1:4317',
  })
  assert.equal(local.cookieSecure, false)
  assert.equal(local.bindHost, '0.0.0.0')

  const secure = parseTeamConfig({
    TRELLIS_BOARD_MODE: 'team',
    TRELLIS_TEAM_PUBLIC_URL: 'https://127.0.0.1:4317',
  })
  assert.equal(secure.cookieSecure, true)
  assert.equal(secure.bindHost, '0.0.0.0')
  assert.equal(parseTeamConfig({}).bindHost, '0.0.0.0')
  assert.equal(
    parseTeamConfig({
      TRELLIS_BOARD_BIND_HOST: '127.0.0.1',
    }).bindHost,
    '127.0.0.1',
  )
  assert.equal(
    parseTeamConfig({
      TRELLIS_BOARD_MODE: 'team',
      TRELLIS_TEAM_PUBLIC_URL: 'http://127.0.0.1:4317',
      TRELLIS_TEAM_BIND_HOST: '127.0.0.1',
    }).bindHost,
    '127.0.0.1',
  )
  assert.equal(
    parseTeamConfig({
      TRELLIS_BOARD_MODE: 'team',
      TRELLIS_TEAM_PUBLIC_URL: 'http://127.0.0.1:4317',
      TRELLIS_TEAM_BIND_HOST: '   ',
    }).bindHost,
    '0.0.0.0',
  )

  assert.throws(
    () =>
      parseTeamConfig({
        TRELLIS_BOARD_MODE: 'team',
        TRELLIS_TEAM_PUBLIC_URL: 'http://board.example.com',
      }),
    /非回环团队地址必须使用 HTTPS/,
  )
  assert.throws(
    () =>
      parseTeamConfig({
        TRELLIS_BOARD_MODE: 'team',
        TRELLIS_TEAM_PUBLIC_URL: 'https://board.example.com',
        TRELLIS_TEAM_COOKIE_SECURE: 'false',
      }),
    /非回环团队地址必须启用安全 Cookie/,
  )
})

test('通配监听接受局域网 Host，同时要求写请求 Origin 与当前 Host 同源', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-wildcard-host-'))
  const runtime = await createTeamRuntime({
    config: {
      ...testConfig(),
      bindHost: '0.0.0.0',
    },
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

  const networkHost = '192.168.65.27:4317'
  const networkOrigin = 'http://192.168.65.27:4317'
  const health = await request(runtime, '/api/health', {
    headers: { host: networkHost },
  })
  assert.equal(health.status, 200)
  for (const host of ['a,b:4317', 'a%2cb:4317']) {
    const invalidHost = await request(runtime, '/api/health', {
      headers: { host },
    })
    assert.equal(invalidHost.status, 400, host)
    assert.equal(invalidHost.body.code, 'INVALID_HOST', host)
  }
  const duplicateHost = await request(runtime, '/api/health', {
    rawHeaders: [
      ['Host', 'first:4317'],
      ['Host', 'second:4317'],
    ],
  })
  assert.equal(duplicateHost.status, 400)
  assert.equal(duplicateHost.body.code, 'INVALID_HOST')

  await createUser(runtime.db, {
    username: 'network-admin',
    displayName: '网络管理员',
    password: 'Network-Password-123',
    systemAdmin: true,
    mustChangePassword: false,
  })
  const login = await request(runtime, '/api/auth/login', {
    method: 'POST',
    headers: { host: networkHost },
    origin: networkOrigin,
    body: { username: 'network-admin', password: 'Network-Password-123' },
  })
  assert.equal(login.status, 200)

  const rejected = await request(runtime, '/api/auth/login', {
    method: 'POST',
    headers: { host: networkHost },
    origin: 'http://10.0.0.8:4317',
    body: { username: 'network-admin', password: 'Network-Password-123' },
  })
  assert.equal(rejected.status, 403)
  assert.equal(rejected.body.code, 'CSRF_REJECTED')

  const wrongProtocol = await request(runtime, '/api/auth/login', {
    method: 'POST',
    headers: { host: networkHost },
    origin: 'https://192.168.65.27:4317',
    body: { username: 'network-admin', password: 'Network-Password-123' },
  })
  assert.equal(wrongProtocol.status, 403)
  assert.equal(wrongProtocol.body.code, 'CSRF_REJECTED')
})

test('非通配监听仍拒绝非公开 Host', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-strict-host-'))
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

  const rejected = await request(runtime, '/api/health', {
    headers: { host: 'localhost:4317' },
  })
  assert.equal(rejected.status, 400)
  assert.equal(rejected.body.code, 'INVALID_HOST')
})

test('项目接入克隆后工具链失败会清理本次 UUID 工作副本', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-team-connect-'))
  const dataPath = path.join(root, 'data')
  const db = openDatabase({
    databaseFile: path.join(dataPath, 'board.sqlite'),
    fallbackRepositories: [],
    importLegacyRepositories: false,
    legacyJsonImport: false,
    logger: SILENT_LOGGER,
  })
  t.after(() => {
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  seedTeam({ db })
  const lead = await createUser(db, {
    username: 'connect-lead',
    displayName: '接入负责人',
    password: 'Connect-Password-123',
    systemAdmin: false,
    mustChangePassword: false,
  })
  addTeamMember({ db }, 't1', lead.id, 'member')
  let clonedTarget = null
  const projectService = createProjectService({
    db,
    config: testConfig(),
    dataDir: dataPath,
    gitManager: {
      async assertValidBranch(branch) {
        return branch
      },
      async cloneForTeam(project) {
        clonedTarget = path.join(dataPath, 'projects', project.workspaceKey)
        fs.mkdirSync(clonedTarget, { recursive: true })
        fs.writeFileSync(path.join(clonedTarget, 'README.md'), 'clone')
        return { target: clonedTarget, initialized: true, initializedPaths: [] }
      },
    },
    taskIndex: {
      incrementQueryRevision() {},
    },
  })
  await assert.rejects(
    projectService.connect(
      { userId: '11111111-1111-4111-8111-111111111111', systemAdmin: true },
      {
        teamId: 't1',
        name: '无效工具链项目',
        remoteUrl: 'https://example.com/invalid-toolchain.git',
        syncBranch: 'main',
        agentTools: ['codex'],
        leadUserId: lead.id,
        leadTrellisDevId: 'connect-lead',
      },
    ),
    (error) => error.code === 'TOOLCHAIN_MISMATCH',
  )
  assert.equal(fs.existsSync(clonedTarget), false)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM repositories').get().count, 0)
})

test('项目接入清理失败时保留工具链错误并记录清理错误', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-team-cleanup-log-'))
  const dataPath = path.join(root, 'data')
  const originalRmSync = fs.rmSync
  const warnings = []
  let cleanupTarget = null
  const db = openDatabase({
    databaseFile: path.join(dataPath, 'board.sqlite'),
    fallbackRepositories: [],
    importLegacyRepositories: false,
    legacyJsonImport: false,
    logger: SILENT_LOGGER,
  })
  t.after(() => {
    fs.rmSync = originalRmSync
    db.close()
    originalRmSync(root, { recursive: true, force: true })
  })
  seedTeam({ db })
  const lead = await createUser(db, {
    username: 'cleanup-log-lead',
    displayName: '清理日志负责人',
    password: 'Cleanup-Log-Password-123',
    systemAdmin: false,
    mustChangePassword: false,
  })
  addTeamMember({ db }, 't1', lead.id, 'member')
  const projectService = createProjectService({
    db,
    config: testConfig(),
    dataDir: dataPath,
    logger: {
      warn(message, context) {
        warnings.push({ message, context })
      },
    },
    gitManager: {
      async assertValidBranch(branch) {
        return branch
      },
      async cloneForTeam(project) {
        cleanupTarget = path.resolve(dataPath, 'projects', project.workspaceKey)
        fs.mkdirSync(cleanupTarget, { recursive: true })
        fs.writeFileSync(path.join(cleanupTarget, 'README.md'), 'clone')
        return { target: cleanupTarget, initialized: true, initializedPaths: [] }
      },
    },
    taskIndex: {
      incrementQueryRevision() {},
    },
  })
  fs.rmSync = (target, options) => {
    if (cleanupTarget && path.resolve(String(target)) === cleanupTarget) {
      const error = new Error('simulated EPERM')
      error.code = 'EPERM'
      throw error
    }
    return originalRmSync(target, options)
  }

  await assert.rejects(
    projectService.connect(
      { userId: '11111111-1111-4111-8111-111111111111', systemAdmin: true },
      {
        teamId: 't1',
        name: '清理失败项目',
        remoteUrl: 'https://example.com/cleanup-failure.git',
        syncBranch: 'main',
        agentTools: ['codex'],
        leadUserId: lead.id,
        leadTrellisDevId: 'cleanup-log-lead',
      },
    ),
    (error) => {
      assert.equal(error.code, 'TOOLCHAIN_MISMATCH')
      assert.equal(error.cleanupError.code, 'EPERM')
      return true
    },
  )
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM repositories').get().count, 0)
  assert.equal(
    warnings.some(
      (entry) =>
        entry.message === '项目接入失败后的工作副本清理失败' &&
        entry.context.cleanupError.includes('simulated EPERM'),
    ),
    true,
  )
})

test('项目接入在 clone 前拒绝空工具、未知工具、无效负责人和 developer ID', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-team-connect-validation-'))
  const dataPath = path.join(root, 'data')
  const db = openDatabase({
    databaseFile: path.join(dataPath, 'board.sqlite'),
    fallbackRepositories: [],
    importLegacyRepositories: false,
    legacyJsonImport: false,
    logger: SILENT_LOGGER,
  })
  t.after(() => {
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  seedTeam({ db })
  const lead = await createUser(db, {
    username: 'valid-lead',
    displayName: '有效负责人',
    password: 'Valid-Lead-Password-123',
    systemAdmin: false,
    mustChangePassword: false,
  })
  addTeamMember({ db }, 't1', lead.id, 'member')
  let cloneCalls = 0
  const projectService = createProjectService({
    db,
    config: testConfig(),
    dataDir: dataPath,
    gitManager: {
      async assertValidBranch(branch) {
        return branch
      },
      async cloneForTeam() {
        cloneCalls += 1
        throw new Error('不应执行 clone')
      },
    },
    taskIndex: {
      incrementQueryRevision() {},
    },
  })
  const actor = { userId: lead.id, systemAdmin: true }
  const base = {
    teamId: 't1',
    name: '校验项目',
    remoteUrl: 'https://example.com/validation.git',
    syncBranch: 'main',
    leadUserId: lead.id,
    leadTrellisDevId: 'valid-lead',
  }

  for (const input of [
    { ...base, agentTools: [] },
    { ...base, agentTools: ['unknown'] },
    { ...base, agentTools: ['codex'], leadUserId: 'missing-user' },
    { ...base, agentTools: ['codex'], leadTrellisDevId: '../bad' },
  ]) {
    await assert.rejects(
      () => projectService.connect(actor, input),
      (error) => error.status === 400,
    )
  }
  assert.equal(cloneCalls, 0)
})

test('项目远端探测把目标分支传给 Git tree 探测', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-team-probe-branch-'))
  const dataPath = path.join(root, 'data')
  const db = openDatabase({
    databaseFile: path.join(dataPath, 'board.sqlite'),
    fallbackRepositories: [],
    importLegacyRepositories: false,
    legacyJsonImport: false,
    logger: SILENT_LOGGER,
  })
  t.after(() => {
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  seedTeam({ db })
  let probeInput = null
  const projectService = createProjectService({
    db,
    config: testConfig(),
    dataDir: dataPath,
    gitManager: {
      async probeRemote(input) {
        probeInput = input
        return { branch: input.branch }
      },
    },
    taskIndex: {
      incrementQueryRevision() {},
    },
  })

  const result = await projectService.probeRemote(
    { userId: '11111111-1111-4111-8111-111111111111', systemAdmin: true },
    {
      teamId: 't1',
      remoteUrl: 'https://example.com/probe-branch.git',
      branch: 'dev',
    },
  )

  assert.equal(probeInput.branch, 'dev')
  assert.equal(result.branch, 'dev')
})

test('项目接入持久化并审计已有与本次初始化 Agent 的并集', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-team-agent-tools-'))
  const dataPath = path.join(root, 'data')
  const db = openDatabase({
    databaseFile: path.join(dataPath, 'board.sqlite'),
    fallbackRepositories: [],
    importLegacyRepositories: false,
    legacyJsonImport: false,
    logger: SILENT_LOGGER,
  })
  t.after(() => {
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  seedTeam({ db })
  const lead = await createUser(db, {
    username: 'agent-tools-lead',
    displayName: 'Agent 工具负责人',
    password: 'Agent-Tools-Password-123',
    systemAdmin: false,
    mustChangePassword: false,
  })
  addTeamMember({ db }, 't1', lead.id, 'member')
  const projectService = createProjectService({
    db,
    config: testConfig(),
    dataDir: dataPath,
    gitManager: {
      async assertValidBranch(branch) {
        return branch
      },
      async cloneForTeam(project) {
        const target = path.join(dataPath, 'projects', project.workspaceKey)
        fs.mkdirSync(path.join(target, '.trellis', 'scripts'), { recursive: true })
        fs.writeFileSync(path.join(target, '.trellis', 'scripts', 'task.py'), '# task tool\n')
        return {
          target,
          initialized: true,
          initializedPaths: ['.opencode/plugins/trellis.js'],
          existingAgentTools: ['codex'],
          initializedAgentTools: ['opencode'],
          remoteCommitSha: 'a'.repeat(40),
        }
      },
    },
    taskIndex: {
      incrementQueryRevision() {},
    },
  })

  const connected = await projectService.connect(
    { userId: lead.id, systemAdmin: true },
    {
      teamId: 't1',
      name: 'Agent 工具项目',
      remoteUrl: 'https://example.com/agent-tools.git',
      syncBranch: 'main',
      agentTools: ['codex', 'opencode'],
      leadUserId: lead.id,
      leadTrellisDevId: 'agent-tools-lead',
    },
  )

  assert.deepEqual(connected.project.agentTools, ['codex', 'opencode'])
  const project = db.prepare('SELECT * FROM team_project').get()
  assert.deepEqual(JSON.parse(project.agent_tools_json), ['codex', 'opencode'])
  const audit = db
    .prepare(`
    SELECT detail_json
    FROM audit_event
    WHERE action = 'project_connected'
  `)
    .get()
  const detail = JSON.parse(audit.detail_json)
  assert.match(detail.toolchainSha256, /^[a-f0-9]{64}$/)
  assert.deepEqual(detail.agentTools, ['codex', 'opencode'])
  assert.deepEqual(detail.existingAgentTools, ['codex'])
  assert.deepEqual(detail.initializedAgentTools, ['opencode'])
  assert.equal(detail.initialized, true)
  assert.equal(detail.targetCommit, 'a'.repeat(40))
})

test('同一团队、远端和同步分支重复接入在 clone 前返回冲突', async (t) => {
  const harness = await createProjectConnectHarness(t, {
    username: 'repeat-connect-lead',
  })
  const input = harness.input({ name: '幂等项目' })

  const first = await harness.projectService.connect(harness.actor, input)
  await assert.rejects(
    () =>
      harness.projectService.connect(harness.actor, {
        ...input,
        name: '重复接入项目',
      }),
    (error) => {
      assert.equal(error.status, 409)
      assert.equal(error.code, 'PROJECT_ALREADY_CONNECTED')
      assert.deepEqual(error.details, {
        projectId: first.project.id,
        projectName: '幂等项目',
        syncBranch: 'main',
        syncStatus: 'provisioning',
      })
      return true
    },
  )

  assert.equal(harness.cloneCalls(), 1)
  assert.equal(harness.db.prepare('SELECT COUNT(*) AS count FROM team_project').get().count, 1)
})

test('显式升级已接入的本地仓库返回统一冲突错误', async (t) => {
  const harness = await createProjectConnectHarness(t, {
    username: 'upgrade-connect-lead',
  })
  const now = new Date().toISOString()
  harness.db
    .prepare(`
    INSERT INTO repositories(id, name, path, path_key, position, created_at, updated_at)
    VALUES ('local-upgrade', '本地升级项目', ?, ?, 0, ?, ?)
  `)
    .run(path.join(harness.projectsRoot, 'local-upgrade'), 'local-upgrade', now, now)
  const input = harness.input({
    name: '本地升级项目',
    repositoryId: 'local-upgrade',
  })

  await harness.projectService.connect(harness.actor, input)
  await assert.rejects(
    () => harness.projectService.connect(harness.actor, input),
    (error) => {
      assert.equal(error.status, 409)
      assert.equal(error.code, 'PROJECT_ALREADY_CONNECTED')
      assert.equal(error.details.projectId, 'local-upgrade')
      return true
    },
  )

  assert.equal(harness.cloneCalls(), 1)
})

test('显式升级其他团队项目不泄漏项目详情', async (t) => {
  const harness = await createProjectConnectHarness(t, {
    username: 'cross-team-upgrade-lead',
  })
  const now = new Date().toISOString()
  seedTeam({ db: harness.db }, 't2')
  harness.db
    .prepare(`
    INSERT INTO repositories(id, name, path, path_key, position, created_at, updated_at)
    VALUES ('other-team-repo', '其他团队项目', ?, ?, 0, ?, ?)
  `)
    .run(path.join(harness.projectsRoot, 'other-team-repo'), 'other-team-repo', now, now)
  harness.db
    .prepare(`
    INSERT INTO team_project(
      repository_id, team_id, workspace_key, remote_url, remote_identity_hash,
      sync_branch, trusted_task_toolchain_sha256, sync_status, created_at, updated_at
    ) VALUES ('other-team-repo', 't2', 'other-team-workspace',
      'https://example.com/other-team.git', ?, 'main', ?, 'current', ?, ?)
  `)
    .run('f'.repeat(64), 'a'.repeat(64), now, now)

  await assert.rejects(
    () =>
      harness.projectService.connect(
        harness.actor,
        harness.input({ repositoryId: 'other-team-repo' }),
      ),
    (error) => {
      assert.equal(error.status, 409)
      assert.equal(error.code, 'PROJECT_ALREADY_CONNECTED')
      assert.equal(error.details, null)
      assert.equal(error.message.includes('其他团队项目'), false)
      return true
    },
  )
  assert.equal(harness.cloneCalls(), 0)
})

test('并发升级同一本地仓库到不同团队时不泄漏失败方的项目详情', async (t) => {
  const harness = await createProjectConnectHarness(t, {
    username: 'cross-team-race-lead',
    delayClone: true,
  })
  seedTeam({ db: harness.db }, 't2')
  addTeamMember({ db: harness.db }, 't2', harness.actor.userId, 'member')
  const now = new Date().toISOString()
  harness.db
    .prepare(`
    INSERT INTO repositories(id, name, path, path_key, position, created_at, updated_at)
    VALUES ('cross-team-race-repo', '跨团队竞态项目', ?, ?, 0, ?, ?)
  `)
    .run(path.join(harness.projectsRoot, 'cross-team-race-repo'), 'cross-team-race-repo', now, now)
  const input = harness.input({
    name: '跨团队竞态项目',
    repositoryId: 'cross-team-race-repo',
  })

  const results = await Promise.allSettled([
    harness.projectService.connect(harness.actor, input),
    harness.projectService.connect(harness.actor, { ...input, teamId: 't2' }),
  ])
  const fulfilled = results.filter((result) => result.status === 'fulfilled')
  const rejected = results.filter((result) => result.status === 'rejected')

  assert.equal(fulfilled.length, 1)
  assert.equal(rejected.length, 1)
  assert.equal(rejected[0].reason.status, 409)
  assert.equal(rejected[0].reason.code, 'PROJECT_ALREADY_CONNECTED')
  assert.equal(rejected[0].reason.details, null)
  assert.equal(rejected[0].reason.message.includes('跨团队竞态项目'), false)
  assert.equal(harness.cloneCalls(), 2)
  assert.equal(harness.db.prepare('SELECT COUNT(*) AS count FROM team_project').get().count, 1)
})

test('并发重复接入最多写入一个团队项目', async (t) => {
  const harness = await createProjectConnectHarness(t, {
    username: 'concurrent-connect-lead',
    delayClone: true,
  })
  const input = harness.input({ name: '并发接入项目' })

  const results = await Promise.allSettled([
    harness.projectService.connect(harness.actor, input),
    harness.projectService.connect(harness.actor, input),
  ])
  const fulfilled = results.filter((result) => result.status === 'fulfilled')
  const rejected = results.filter((result) => result.status === 'rejected')

  assert.equal(fulfilled.length, 1)
  assert.equal(rejected.length, 1)
  assert.equal(rejected[0].reason.status, 409)
  assert.equal(rejected[0].reason.code, 'PROJECT_ALREADY_CONNECTED')
  assert.equal(harness.cloneCalls(), 2)
  assert.equal(harness.db.prepare('SELECT COUNT(*) AS count FROM team_project').get().count, 1)
  const projectDirectories = fs
    .readdirSync(harness.projectsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
  assert.equal(projectDirectories.length, 1)
})

test('同一远端仓库的不同同步分支可以分别接入', async (t) => {
  const harness = await createProjectConnectHarness(t, {
    username: 'branch-connect-lead',
  })
  const input = harness.input({ name: '多分支项目' })

  await harness.projectService.connect(harness.actor, {
    ...input,
    syncBranch: 'dev',
  })
  await harness.projectService.connect(harness.actor, {
    ...input,
    syncBranch: 'main',
  })

  assert.equal(harness.cloneCalls(), 2)
  const branches = harness.db
    .prepare('SELECT sync_branch FROM team_project ORDER BY sync_branch')
    .all()
    .map((row) => row.sync_branch)
  assert.deepEqual(branches, ['dev', 'main'])
})

test('首管理员 CLI 只初始化一次且不会导入本机默认仓库', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-team-cli-'))
  const databaseFile = path.join(root, 'data', 'board.sqlite')
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const user = await initFirstAdmin({
    config: testConfig(),
    databaseFile,
    username: 'first-admin',
    displayName: '首管理员',
    password: 'Initial-Password-123',
  })
  assert.equal(user.systemAdmin, true)
  assert.equal(user.mustChangePassword, true)

  const db = openDatabase({
    databaseFile,
    fallbackRepositories: [],
    importLegacyRepositories: false,
    legacyJsonImport: false,
    logger: SILENT_LOGGER,
  })
  try {
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM repositories').get().count, 0)
  } finally {
    db.close()
  }
  const status = diagnose({ config: testConfig(), databaseFile })
  assert.equal(status.schemaVersion, '10')
  assert.equal(status.activeAdmin, true)
  assert.equal(status.integrity, 'ok')
  await assert.rejects(
    initFirstAdmin({
      config: testConfig(),
      databaseFile,
      username: 'second-admin',
      password: 'Second-Password-123',
    }),
    /已有有效管理员/,
  )
})

test('服务端 Git 远端身份哈希与 Windows Agent 的 HTTPS/SSH/file 语义一致', () => {
  const remotes = [
    'https://GitHub.com/Org/Repo.git',
    'https://GitHub.com:443/Org/Repo',
    'https://GitHub.com:8443/Org/Repo.git',
    'ssh://git@Example.COM:22/Org/Repo.git',
    'git@Example.COM:Org/Repo.git',
  ]
  for (const remote of remotes) {
    assert.equal(
      normalizeGitRemote(remote, testConfig()).identityHash,
      normalizeRemoteIdentity(remote).identityHash,
      remote,
    )
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-remote-'))
  try {
    const localRemote = path.join(root, 'Remote.git')
    fs.mkdirSync(localRemote)
    const localConfig = {
      ...testConfig(),
      allowLocalGitRemotes: true,
    }
    const fileUrl = pathToFileURL(localRemote).href
    const expected = normalizeRemoteIdentity(fileUrl, {
      allowFileRemote: true,
    }).identityHash
    assert.equal(normalizeGitRemote(localRemote, localConfig).identityHash, expected)
    assert.equal(normalizeGitRemote(fileUrl, localConfig).identityHash, expected)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

function testConfig() {
  return {
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
  }
}

function request(
  runtime,
  pathname,
  {
    method = 'GET',
    body = null,
    cookie = null,
    agentCredential = null,
    origin = PUBLIC_ORIGIN,
    contentType = 'application/json',
    headers = {},
    rawHeaders = null,
  } = {},
) {
  const address = runtime.address()
  const payload = body == null ? null : JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const requestHeaders = rawHeaders || { host: HOST, ...headers }
    if (payload != null) {
      requestHeaders['content-type'] = contentType
      requestHeaders['content-length'] = Buffer.byteLength(payload)
    }
    if (origin != null && method !== 'GET' && method !== 'HEAD') {
      requestHeaders.origin = origin
    }
    if (cookie) requestHeaders.cookie = cookie
    if (agentCredential) {
      requestHeaders.authorization = `Bearer ${agentCredential}`
    }
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
          let json = null
          if (text) {
            try {
              json = JSON.parse(text)
            } catch {
              json = text
            }
          }
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: json,
          })
        })
      },
    )
    req.on('error', reject)
    if (payload != null) req.write(payload)
    req.end()
  })
}

function sessionCookie(response) {
  const values = response.headers['set-cookie'] || []
  return String(values[0] || '').split(';')[0]
}

async function login(runtime, password, username = 'admin') {
  return request(runtime, '/api/auth/login', {
    method: 'POST',
    body: { username, password },
  })
}

function seedTeam(runtime, teamId = 't1') {
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

async function createProjectConnectHarness(t, { username, delayClone = false }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-team-connect-idempotency-'))
  const dataPath = path.join(root, 'data')
  const projectsRoot = path.join(dataPath, 'projects')
  const db = openDatabase({
    databaseFile: path.join(dataPath, 'board.sqlite'),
    fallbackRepositories: [],
    importLegacyRepositories: false,
    legacyJsonImport: false,
    logger: SILENT_LOGGER,
  })
  t.after(() => {
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  seedTeam({ db })
  const lead = await createUser(db, {
    username,
    displayName: '接入测试负责人',
    password: 'Connect-Harness-Password-123',
    systemAdmin: false,
    mustChangePassword: false,
  })
  addTeamMember({ db }, 't1', lead.id, 'member')

  let cloneCount = 0
  const projectService = createProjectService({
    db,
    config: testConfig(),
    dataDir: dataPath,
    gitManager: {
      async assertValidBranch(branch) {
        return branch
      },
      async cloneForTeam(project) {
        cloneCount += 1
        if (delayClone) {
          await new Promise((resolve) => setImmediate(resolve))
        }
        const target = path.join(projectsRoot, project.workspaceKey)
        fs.mkdirSync(path.join(target, '.trellis', 'scripts'), { recursive: true })
        fs.writeFileSync(path.join(target, '.trellis', 'scripts', 'task.py'), '# task tool\n')
        return {
          target,
          initialized: true,
          initializedPaths: [],
          existingAgentTools: [],
          initializedAgentTools: ['codex'],
        }
      },
    },
    taskIndex: {
      incrementQueryRevision() {},
    },
  })

  return {
    db,
    projectsRoot,
    projectService,
    actor: { userId: lead.id, systemAdmin: true },
    cloneCalls: () => cloneCount,
    input(overrides = {}) {
      return {
        teamId: 't1',
        name: '接入测试项目',
        remoteUrl: 'https://example.com/connect-idempotency.git',
        syncBranch: 'main',
        agentTools: ['codex'],
        leadUserId: lead.id,
        leadTrellisDevId: username,
        ...overrides,
      }
    },
  }
}

function seedProject(runtime, user, root, teamId = 't1') {
  const now = new Date().toISOString()
  seedTeam(runtime, teamId)
  addTeamMember(runtime, teamId, user.id, 'admin')
  const repositoryPath = path.join(root, 'projects', 'p1')
  fs.mkdirSync(repositoryPath, { recursive: true })
  runtime.db
    .prepare(`
    INSERT INTO repositories(id, name, path, path_key, position, created_at, updated_at)
    VALUES ('p1', '项目一', ?, ?, 0, ?, ?)
  `)
    .run(repositoryPath, repositoryPath.toLowerCase(), now, now)
  runtime.db
    .prepare(`
    INSERT INTO team_project(
      repository_id, team_id, workspace_key, remote_url, remote_identity_hash,
      sync_branch, trusted_task_toolchain_sha256, sync_status, created_at, updated_at
    ) VALUES ('p1', ?, 'p1-workspace', 'https://example.com/p1.git', ?,
      'main', ?, 'current', ?, ?)
  `)
    .run(teamId, 'f'.repeat(64), 'a'.repeat(64), now, now)
  runtime.db
    .prepare(`
    INSERT INTO project_member(
      project_id, user_id, role, trellis_dev_id, created_by, created_at, updated_at
    ) VALUES ('p1', ?, 'lead', 'alice', ?, ?, ?)
  `)
    .run(user.id, user.id, now, now)
}

function seedIndexedTasks(runtime) {
  const repository = runtime.db
    .prepare(`
    SELECT path FROM repositories WHERE id = 'p1'
  `)
    .get()
  const insert = runtime.db.prepare(`
    INSERT INTO team_task_index(
      project_id, task_key, execution_task_key, relative_dir, title,
      search_text, archived, priority, derived_stage, assignee_dev_id,
      assignee_user_id, due_date, last_activity_at, is_blocked,
      is_unblocked_ready, attention_flags_json, group_key, group_role,
      task_version, board_version, updated_at
    ) VALUES (
      'p1', ?, ?, ?, ?, ?, 0, 'P2', 'implement', 'alice',
      NULL, NULL, ?, 0, 1, '[]', ?, 'parent', ?, 'board-1', ?
    )
  `)
  for (let index = 1; index <= 3; index += 1) {
    const taskKey = `p1::.trellis/tasks/task-${index}`
    const activity = new Date(Date.UTC(2026, 10, 3, 0, index, 0)).toISOString()
    const taskDir = path.join(repository.path, '.trellis', 'tasks', `task-${index}`)
    fs.mkdirSync(taskDir, { recursive: true })
    fs.writeFileSync(
      path.join(taskDir, 'task.json'),
      JSON.stringify({
        id: `task-${index}`,
        title: `任务 ${index}`,
        description: `团队任务 ${index}`,
        status: 'in_progress',
        priority: 'P2',
        assignee: index === 1 ? 'alice' : 'bob',
        creator: 'alice',
        created_at: activity,
      }),
    )
    insert.run(
      taskKey,
      `p1::task-${index}`,
      `.trellis/tasks/task-${index}`,
      `任务 ${index}`,
      `任务 ${index}`,
      activity,
      taskKey,
      `version-${index}`,
      activity,
    )
  }
  runtime.services.taskIndex.incrementQueryRevision()
}

function seedArchivedTasks(runtime) {
  const insert = runtime.db.prepare(`
    INSERT INTO team_task_index(
      project_id, task_key, execution_task_key, relative_dir, title,
      search_text, archived, archived_at, priority, derived_stage, assignee_dev_id,
      assignee_user_id, due_date, last_activity_at, is_blocked,
      is_unblocked_ready, attention_flags_json, group_key, group_role,
      task_version, board_version, updated_at
    ) VALUES (
      'p1', ?, ?, ?, ?, ?, 1, ?, 'P2', 'archive', ?,
      NULL, NULL, ?, 0, 0, '[]', ?, 'parent', ?, 'board-1', ?
    )
  `)
  const rows = [
    ['old', '2026-11-01T08:00:00.000Z', 'alice', '2026-11-09T08:00:00.000Z'],
    ['new', '2026-11-08T08:00:00.000Z', 'bob', '2026-11-02T08:00:00.000Z'],
    ['middle', '2026-11-05T08:00:00.000Z', 'alice', '2026-11-06T08:00:00.000Z'],
  ]
  rows.forEach(([name, archivedAt, assignee, activity]) => {
    const taskKey = `p1::.trellis/tasks/archive/2026-11/${name}`
    insert.run(
      taskKey,
      `p1::${name}`,
      `.trellis/tasks/archive/2026-11/${name}`,
      `归档任务 ${name}`,
      `归档任务 ${name}`,
      archivedAt,
      assignee,
      activity,
      name,
      `version-${name}`,
      activity,
    )
  })
  runtime.services.taskIndex.incrementQueryRevision()
}

test('team 模式不加载插件：启动告警，/api/plugins 为空，插件管理端点 404', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-team-plugins-'))
  const warnings = []
  const runtime = await createTeamRuntime({
    config: testConfig(),
    databaseFile: path.join(root, 'data', 'board.sqlite'),
    dataDir: path.join(root, 'data'),
    logger: {
      info() {},
      warn(message) {
        warnings.push(message)
      },
      error() {},
    },
    requireAdmin: false,
    enablePolling: false,
  })
  await runtime.start()
  t.after(async () => {
    await runtime.stop()
    fs.rmSync(root, { recursive: true, force: true })
  })

  await createUser(runtime.db, {
    username: 'admin',
    displayName: '管理员',
    password: 'Admin-Password-123',
    systemAdmin: true,
    mustChangePassword: false,
  })
  const signedIn = await login(runtime, 'Admin-Password-123')
  assert.equal(signedIn.status, 200)
  const cookie = sessionCookie(signedIn)

  const list = await request(runtime, '/api/plugins', { cookie })
  assert.equal(list.status, 200)
  assert.equal(list.body.disabled, true)
  assert.deepEqual(list.body.plugins, [])

  const admin = await request(runtime, '/api/plugins/acp-dispatch/runs', { cookie })
  assert.equal(admin.status, 404)
  assert.match(String(admin.body.error), /team 模式不加载插件/)
  assert.ok(warnings.some((message) => message.includes('team 模式不加载插件')))
})
