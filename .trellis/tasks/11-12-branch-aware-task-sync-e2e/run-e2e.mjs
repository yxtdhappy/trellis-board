import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { AgentApiClient } from '../../../agent/api.js'
import { runCli } from '../../../agent/cli.js'
import { ConfigStore } from '../../../agent/config-store.js'
import { DpapiCredentialStore } from '../../../agent/credential-store.js'
import { attachProject } from '../../../agent/project-onboarding.js'
import { createUser } from '../../../server/team/auth.js'
import { createTeamRuntime } from '../../../server/team/http.js'

const TASK_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(TASK_DIR, '../../..')
const EVIDENCE_DIR = path.join(TASK_DIR, 'evidence')
const SERVER_PORT = 4318
const PROXY_PORT = 4319
const SERVER_URL = `http://127.0.0.1:${SERVER_PORT}`
const PROXY_URL = `http://127.0.0.1:${PROXY_PORT}`
const PROXY_SCRIPT = path.join(
  os.homedir(),
  '.agents',
  'skills',
  'wit-e2e-testing',
  'scripts',
  'local-gateway-proxy.mjs',
)

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-branch-e2e-'))
const dataDir = path.join(tempRoot, 'server-data')
const agentRoot = path.join(tempRoot, 'agent')
const repositoriesRoot = path.join(tempRoot, 'repositories')
const remoteRoot = path.join(repositoriesRoot, 'origin.git')
const workingRoot = path.join(repositoriesRoot, 'working')
const serverLog = path.join(EVIDENCE_DIR, 'server.log')
const proxyLog = path.join(EVIDENCE_DIR, 'proxy.log')
const agentProcessLog = path.join(EVIDENCE_DIR, 'agent-process.log')
const resultFile = path.join(EVIDENCE_DIR, 'e2e-result.json')
const reportJsonFile = path.join(EVIDENCE_DIR, 'e2e-evidence.json')

const evidence = {
  startedAt: new Date().toISOString(),
  topology: {
    serverUrl: SERVER_URL,
    proxyUrl: PROXY_URL,
    tempRoot,
    workingRepo: workingRoot,
  },
  operations: [],
  checks: [],
}

let runtime = null
let proxy = null
let agent = null
let proxyLogStream = null
let agentLogStream = null

function appendJsonLines(file, level, values) {
  const text = values
    .map((value) => {
      if (value instanceof Error) return `${value.name}: ${value.message}`
      if (typeof value === 'string') return value
      try {
        return JSON.stringify(value)
      } catch {
        return String(value)
      }
    })
    .join(' ')
  fs.appendFileSync(file, `${new Date().toISOString()} ${level} ${text}\n`)
}

const logger = {
  info: (...values) => appendJsonLines(serverLog, 'INFO', values),
  warn: (...values) => appendJsonLines(serverLog, 'WARN', values),
  error: (...values) => appendJsonLines(serverLog, 'ERROR', values),
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(description, predicate, timeoutMs = 20_000, intervalMs = 150) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const value = await predicate()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await delay(intervalMs)
  }
  throw new Error(
    `等待超时：${description}${lastError ? `；最后错误：${lastError.message}` : ''}`,
  )
}

function runGit(args, cwd = workingRoot) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} 失败：${result.stderr || result.stdout}`)
  }
  return result.stdout.trim()
}

function writeTask(repoPath, relativeDir, id, title, includePrd = true) {
  const taskDir = path.join(repoPath, relativeDir)
  fs.mkdirSync(taskDir, { recursive: true })
  const task = {
    id,
    title,
    status: 'planning',
    assignee: 'yhj',
    priority: 'P2',
    createdAt: '2026-11-12',
    completedAt: null,
  }
  fs.writeFileSync(path.join(taskDir, 'task.json'), `${JSON.stringify(task, null, 2)}\n`)
  if (includePrd) {
    fs.writeFileSync(
      path.join(taskDir, 'prd.md'),
      `# ${title}\n\n## Requirements\n\n- E2E 探针\n\n## Acceptance Criteria\n\n- [ ] 同步隔离\n`,
    )
  }
}

function removeTestPath(target, expectedParent) {
  const resolvedTarget = path.resolve(target)
  const resolvedParent = path.resolve(expectedParent)
  if (!resolvedTarget.startsWith(`${resolvedParent}${path.sep}`)) {
    throw new Error(`拒绝删除测试目录外路径：${resolvedTarget}`)
  }
  fs.rmSync(resolvedTarget, { recursive: true, force: true })
}

function cookieFrom(response) {
  const values = response.headers.getSetCookie?.() || []
  return String(values[0] || response.headers.get('set-cookie') || '').split(';')[0]
}

async function request(pathname, options = {}) {
  const method = options.method || 'GET'
  const headers = { accept: 'application/json' }
  if (options.body != null) headers['content-type'] = 'application/json'
  if (method !== 'GET') headers.origin = SERVER_URL
  if (options.cookie) headers.cookie = options.cookie
  if (options.agentCredential) {
    headers.authorization = `Bearer ${options.agentCredential}`
  }
  const response = await fetch(new URL(pathname, SERVER_URL), {
    method,
    headers,
    body: options.body == null ? undefined : JSON.stringify(options.body),
  })
  const text = await response.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return {
    status: response.status,
    body,
    cookie: cookieFrom(response),
    requestId: response.headers.get('x-request-id'),
  }
}

function bindingsForAgent() {
  return runtime.db
    .prepare(
      `SELECT b.id, b.task_space_id, b.branch_name, b.sync_status, s.branch_name AS space_branch
         FROM sync_agent_binding b
         JOIN sync_task_space s ON s.id = b.task_space_id
        WHERE b.agent_id = ?
        ORDER BY b.created_at`,
    )
    .all(evidence.agentId)
}

function taskSpaceRevision(taskSpaceId) {
  return Number(
    runtime.db.prepare('SELECT revision FROM sync_task_space WHERE id = ?').get(taskSpaceId)
      ?.revision || 0,
  )
}

function taskSpaceFileCount(taskSpaceId) {
  return Number(
    runtime.db
      .prepare(
        'SELECT COUNT(*) AS count FROM sync_task_space_file WHERE task_space_id = ? AND deleted = 0',
      )
      .get(taskSpaceId).count,
  )
}

function readLiveCursor(taskSpaceId) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(agentRoot, 'live-cursors.json'), 'utf8'))
    return parsed?.taskSpaces?.[taskSpaceId] || {}
  } catch {
    return {}
  }
}

async function readConfig() {
  return new ConfigStore(agentRoot).readConfig({ allowMissing: false })
}

async function stopChild(child, expectedLabel) {
  if (!child || child.exitCode != null) return
  child.kill()
  try {
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      delay(8_000).then(() => {
        throw new Error(`${expectedLabel} 未在 8 秒内退出`)
      }),
    ])
  } catch (error) {
    child.kill('SIGKILL')
    throw error
  }
}

async function startProxy() {
  proxyLogStream = fs.createWriteStream(proxyLog, { flags: 'w' })
  proxy = spawn(
    process.execPath,
    [
      PROXY_SCRIPT,
      '--listen-port',
      String(PROXY_PORT),
      '--route',
      `/api=${SERVER_URL}/api`,
      '--health-path',
      '/__local_gateway/health',
    ],
    {
      cwd: REPO_ROOT,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  proxy.stdout.pipe(proxyLogStream, { end: false })
  proxy.stderr.pipe(proxyLogStream, { end: false })
  await waitFor('本地代理健康检查', async () => {
    const response = await fetch(`${PROXY_URL}/__local_gateway/health`)
    return response.ok
  })
}

async function startAgent() {
  agentLogStream = fs.createWriteStream(agentProcessLog, { flags: 'a' })
  agent = spawn(process.execPath, [path.join(REPO_ROOT, 'agent', 'cli.js'), 'run'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      TRELLIS_AGENT_ROOT: agentRoot,
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  agent.stdout.pipe(agentLogStream, { end: false })
  agent.stderr.pipe(agentLogStream, { end: false })
  await waitFor(
    'Agent 事件流连接',
    () => {
      const logFile = path.join(agentRoot, 'logs', 'agent.log')
      return fs.existsSync(logFile) && fs.readFileSync(logFile, 'utf8').includes('Agent 事件流已连接')
    },
    30_000,
  )
}

async function run() {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true })
  fs.writeFileSync(serverLog, '')
  fs.writeFileSync(proxyLog, '')
  fs.writeFileSync(agentProcessLog, '')

  runtime = await createTeamRuntime({
    config: {
      mode: 'team',
      bindHost: '127.0.0.1',
      port: SERVER_PORT,
      publicUrl: new URL(SERVER_URL),
      publicOrigin: SERVER_URL,
      sessionTtlMs: 12 * 60 * 60 * 1000,
      agentStaleMs: 60_000,
      cookieSecure: false,
      trustProxy: false,
      allowLocalGitRemotes: true,
    },
    databaseFile: path.join(dataDir, 'board.sqlite'),
    dataDir,
    logger,
    requireAdmin: false,
  })
  await runtime.start()
  evidence.serverAddress = runtime.address()

  const now = new Date().toISOString()
  const teamId = 'team-branch-e2e'
  runtime.db
    .prepare(
      `INSERT INTO team(id, name, slug, status, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?)`,
    )
    .run(teamId, '跨分支 E2E 团队', 'branch-e2e', now, now)

  const adminUsername = `e2e-admin-${crypto.randomUUID().slice(0, 8)}`
  const adminPassword = `E2E-${crypto.randomUUID()}`
  await createUser(runtime.db, {
    username: adminUsername,
    displayName: '跨分支 E2E 管理员',
    password: adminPassword,
    systemAdmin: true,
    mustChangePassword: false,
  })
  runtime.db
    .prepare(
      `INSERT INTO team_member(team_id, user_id, role, created_at, updated_at)
       SELECT ?, id, 'admin', ?, ? FROM user_account WHERE username = ?`,
    )
    .run(teamId, now, now, adminUsername)

  const login = await request('/api/auth/login', {
    method: 'POST',
    body: { username: adminUsername, password: adminPassword },
  })
  assert.equal(login.status, 200)
  const adminCookie = login.cookie
  assert.ok(adminCookie)

  fs.mkdirSync(remoteRoot, { recursive: true })
  runGit(['init', '--bare', '--initial-branch=main', remoteRoot], repositoriesRoot)
  runGit(['clone', remoteRoot, workingRoot], repositoriesRoot)
  runGit(['config', 'user.name', 'Trellis E2E'])
  runGit(['config', 'user.email', 'trellis-e2e@example.invalid'])
  writeTask(
    workingRoot,
    '.trellis/tasks/00-e2e-main',
    'e2e-main',
    '跨分支同步 E2E 主分支探针',
  )
  runGit(['add', '.trellis/tasks/00-e2e-main'])
  runGit(['commit', '-m', 'test: seed main task'])
  runGit(['push', '-u', 'origin', 'main'])
  runGit(['checkout', '-b', 'feature/e2e-branch'])
  writeTask(
    workingRoot,
    '.trellis/tasks/01-e2e-feature',
    'e2e-feature',
    '跨分支同步 E2E Feature 探针',
  )
  runGit(['add', '.trellis/tasks/01-e2e-feature'])
  runGit(['commit', '-m', 'test: seed feature task'])
  runGit(['push', '-u', 'origin', 'feature/e2e-branch'])
  runGit(['checkout', 'main'])

  await startProxy()
  evidence.proxyPid = proxy.pid

  const pairing = await request('/api/team/pairing-codes', {
    method: 'POST',
    cookie: adminCookie,
    body: { teamId },
  })
  assert.equal(pairing.status, 201)
  assert.ok(pairing.body?.pairingCode)

  const cliOutput = []
  const cliIo = {
    stdout: { write: (value) => cliOutput.push(String(value)) },
    stderr: { write: (value) => cliOutput.push(String(value)) },
  }
  const pairCode = await runCli(
    ['pair', '--server', PROXY_URL, '--name', 'E2E Branch Agent', '--json'],
    {
      root: agentRoot,
      io: cliIo,
      readSecret: async () => pairing.body.pairingCode,
    },
  )
  assert.equal(pairCode, 0, cliOutput.join(''))
  const pairedConfig = await readConfig()
  evidence.agentId = pairedConfig.agentId

  const store = new ConfigStore(agentRoot)
  const credentialStore = new DpapiCredentialStore(store, {
    scriptFile: path.join(REPO_ROOT, 'agent', 'windows', 'dpapi.ps1'),
  })
  const credential = await credentialStore.loadCredential()
  const api = new AgentApiClient({ serverUrl: PROXY_URL, credential })
  const mainHooks = path.join(store.paths.hooksBaseDir, 'main-association')
  fs.mkdirSync(mainHooks, { recursive: true })

  const mainAttach = await attachProject({
    api,
    store,
    repoPath: workingRoot,
    hooksDir: mainHooks,
    expectedBranchName: 'main',
    teamId,
    developerId: 'yhj',
    displayName: 'Branch Sync E2E',
    allowFileRemote: true,
    initialSyncMode: 'bootstrap',
  })
  const mainTaskSpaceId = mainAttach.taskSpace.id
  const projectId = mainAttach.project.id
  evidence.mainTaskSpaceId = mainTaskSpaceId
  evidence.projectId = projectId
  evidence.mainBindingId = mainAttach.binding.id
  assert.equal(mainAttach.binding.branchName, 'main')
  assert.equal((await readConfig()).bindings.length, 1)

  await startAgent()
  evidence.agentPid = agent.pid
  await waitFor('main 初始任务上传', () => taskSpaceRevision(mainTaskSpaceId) >= 1, 30_000)
  await waitFor('main 首次同步完成', async () => {
    const binding = (await readConfig()).bindings[0]
    return (
      binding.initialSyncCompleted === true &&
      binding.liveSyncStatus === 'ready' &&
      !binding.lastErrorCode
    )
  })
  await delay(500)
  const proxyAfterMain = fs.readFileSync(proxyLog, 'utf8')
  assert.match(proxyAfterMain, /200 POST \/api\/agent\/task-spaces\/[^ ]+\/changes/)
  evidence.operations.push({
    name: 'main-upload',
    branch: 'main',
    serverRevision: taskSpaceRevision(mainTaskSpaceId),
    serverFiles: taskSpaceFileCount(mainTaskSpaceId),
    proxyEvidence: proxyAfterMain
      .split(/\r?\n/)
      .filter((line) => line.includes('/changes'))
      .slice(-3),
  })

  const proxyLinesBeforeMismatch = proxyAfterMain.split(/\r?\n/).length
  const revisionBeforeMismatch = taskSpaceRevision(mainTaskSpaceId)
  const cursorBeforeMismatch = readLiveCursor(mainTaskSpaceId)
  runGit(['checkout', 'feature/e2e-branch'])
  writeTask(
    workingRoot,
    '.trellis/tasks/02-e2e-feature-dirty',
    'e2e-feature-dirty',
    '跨分支同步 E2E 错分支写入探针',
    false,
  )
  await waitFor('Agent 识别分支不一致', async () => {
    const binding = (await readConfig()).bindings[0]
    return binding.lastErrorCode === 'BRANCH_MISMATCH'
  })
  await delay(1_000)
  assert.equal(taskSpaceRevision(mainTaskSpaceId), revisionBeforeMismatch)
  assert.deepEqual(readLiveCursor(mainTaskSpaceId), cursorBeforeMismatch)
  const serverFilesAfterMismatch = runtime.db
    .prepare(
      `SELECT task_dir FROM sync_task_space_file
        WHERE task_space_id = ? AND deleted = 0 AND task_dir LIKE '%02-e2e-feature-dirty%'`,
    )
    .all(mainTaskSpaceId)
  assert.equal(serverFilesAfterMismatch.length, 0)
  const proxyAfterMismatch = fs.readFileSync(proxyLog, 'utf8').split(/\r?\n/)
  const mismatchProxyLines = proxyAfterMismatch.slice(proxyLinesBeforeMismatch)
  assert.equal(
    mismatchProxyLines.some(
      (line) => line.includes('/changes') && /^200 POST /.test(line.replace('[proxy] ', '')),
    ),
    false,
  )
  const agentLogAfterMismatch = fs.readFileSync(
    path.join(agentRoot, 'logs', 'agent.log'),
    'utf8',
  )
  assert.equal((await readConfig()).bindings[0].lastErrorCode, 'BRANCH_MISMATCH')
  assert.match(
    agentLogAfterMismatch,
    /本地当前分支为 feature\/e2e-branch，绑定分支为 main/,
  )
  evidence.operations.push({
    name: 'feature-upload-rejected',
    branch: 'feature/e2e-branch',
    configErrorCode: 'BRANCH_MISMATCH',
    serverRevision: revisionBeforeMismatch,
    cursor: cursorBeforeMismatch,
    recentProxyLines: mismatchProxyLines.filter((line) => line.includes('/changes')).slice(-3),
    agentEvidence: agentLogAfterMismatch
      .split(/\r?\n/)
      .filter((line) => line.includes('本地当前分支为 feature/e2e-branch'))
      .slice(-3),
  })

  const cursorSequence = Number(readLiveCursor(mainTaskSpaceId).sequence || 0)
  const missingBranchError = await api
    .uploadTaskSpaceChanges(mainTaskSpaceId, {
      batchId: `e2e-missing-${crypto.randomUUID()}`,
      clientSequence: cursorSequence + 1,
      files: [
        {
          path: '.trellis/tasks/03-e2e-missing-branch/task.json',
          content: '{"id":"e2e-missing-branch"}\n',
          baseSha256: null,
        },
      ],
    })
    .then(
      () => null,
      (error) => error,
    )
  assert.ok(missingBranchError)
  assert.equal(missingBranchError.status, 400)
  assert.equal(missingBranchError.serverCode, 'BRANCH_OBSERVATION_REQUIRED')

  const wrongBranchError = await api
    .uploadTaskSpaceChanges(mainTaskSpaceId, {
      batchId: `e2e-wrong-${crypto.randomUUID()}`,
      clientSequence: cursorSequence + 2,
      observedBranchName: 'feature/e2e-branch',
      files: [
        {
          path: '.trellis/tasks/04-e2e-wrong-branch/task.json',
          content: '{"id":"e2e-wrong-branch"}\n',
          baseSha256: null,
        },
      ],
    })
    .then(
      () => null,
      (error) => error,
    )
  assert.ok(wrongBranchError)
  assert.equal(wrongBranchError.status, 400)
  assert.equal(wrongBranchError.serverCode, 'BRANCH_TASK_SPACE_MISMATCH')
  evidence.operations.push({
    name: 'observed-branch-http-guards',
    missing: {
      status: missingBranchError.status,
      code: missingBranchError.serverCode,
    },
    mismatch: {
      status: wrongBranchError.status,
      code: wrongBranchError.serverCode,
    },
  })

  const serverOnlyPath = '.trellis/tasks/05-e2e-server-only'
  const revisionBeforeServerOnly = taskSpaceRevision(mainTaskSpaceId)
  const cursorBeforeServerOnly = readLiveCursor(mainTaskSpaceId)
  const serverUpload = await api.uploadTaskSpaceChanges(mainTaskSpaceId, {
    batchId: `e2e-server-only-${crypto.randomUUID()}`,
    clientSequence: cursorSequence + 1,
    observedBranchName: 'main',
    files: [
      {
        path: `${serverOnlyPath}/task.json`,
        content: `${JSON.stringify({
          id: 'e2e-server-only',
          title: '跨分支同步 E2E 服务端任务',
          status: 'planning',
          assignee: 'yhj',
          priority: 'P2',
          createdAt: '2026-11-12',
          completedAt: null,
        })}\n`,
        baseSha256: null,
      },
    ],
  })
  assert.ok(serverUpload.revision > revisionBeforeServerOnly)
  await delay(2_500)
  assert.equal(fs.existsSync(path.join(workingRoot, serverOnlyPath, 'task.json')), false)
  assert.deepEqual(readLiveCursor(mainTaskSpaceId), cursorBeforeServerOnly)
  assert.equal(
    (await readConfig()).bindings[0].lastErrorCode,
    'BRANCH_MISMATCH',
  )
  evidence.operations.push({
    name: 'feature-pull-rejected',
    branch: 'feature/e2e-branch',
    serverRevision: serverUpload.revision,
    cursor: cursorBeforeServerOnly,
    localFileWritten: false,
  })

  removeTestPath(
    path.join(workingRoot, '.trellis', 'tasks', '02-e2e-feature-dirty'),
    path.join(workingRoot, '.trellis', 'tasks'),
  )
  runGit(['checkout', 'main'])
  const recoveryPath = '.trellis/tasks/06-e2e-recovery-trigger'
  const recoveryUpload = await api.uploadTaskSpaceChanges(mainTaskSpaceId, {
    batchId: `e2e-recovery-${crypto.randomUUID()}`,
    clientSequence: cursorSequence + 2,
    observedBranchName: 'main',
    files: [
      {
        path: `${recoveryPath}/task.json`,
        content: `${JSON.stringify({
          id: 'e2e-recovery-trigger',
          title: '跨分支同步 E2E 恢复触发任务',
          status: 'planning',
          assignee: 'yhj',
          priority: 'P2',
          createdAt: '2026-11-12',
          completedAt: null,
        })}\n`,
        baseSha256: null,
      },
    ],
  })
  await waitFor(
    '切回 main 后由 task.changed 恢复并拉取服务端任务',
    () =>
      fs.existsSync(path.join(workingRoot, serverOnlyPath, 'task.json')) &&
      fs.existsSync(path.join(workingRoot, recoveryPath, 'task.json')) &&
      readLiveCursor(mainTaskSpaceId).revision >= recoveryUpload.revision,
    30_000,
  )
  await waitFor('恢复后清除分支错误', async () => {
    const binding = (await readConfig()).bindings[0]
    return !binding.lastErrorCode && ['ready', 'syncing'].includes(binding.liveSyncStatus)
  })
  evidence.operations.push({
    name: 'main-recovery',
    branch: 'main',
    localFileWritten: true,
    serverRevision: recoveryUpload.revision,
    cursorRevision: readLiveCursor(mainTaskSpaceId).revision,
    bindingStatus: (await readConfig()).bindings[0].liveSyncStatus,
  })

  removeTestPath(
    path.join(workingRoot, serverOnlyPath),
    path.join(workingRoot, '.trellis', 'tasks'),
  )
  removeTestPath(
    path.join(workingRoot, recoveryPath),
    path.join(workingRoot, '.trellis', 'tasks'),
  )
  await stopChild(agent, 'Agent')
  agent = null
  runGit(['checkout', 'feature/e2e-branch'])
  const featureHooks = path.join(store.paths.hooksBaseDir, 'feature-association')
  fs.mkdirSync(featureHooks, { recursive: true })
  const featureAttach = await attachProject({
    api,
    store,
    repoPath: workingRoot,
    hooksDir: featureHooks,
    expectedBranchName: 'feature/e2e-branch',
    teamId,
    developerId: 'yhj',
    displayName: 'Branch Sync E2E',
    allowFileRemote: true,
    initialSyncMode: 'bootstrap',
  })
  const featureTaskSpaceId = featureAttach.taskSpace.id
  evidence.featureTaskSpaceId = featureTaskSpaceId
  assert.notEqual(featureTaskSpaceId, mainTaskSpaceId)
  assert.equal(featureAttach.project.id, projectId)
  const configAfterReplace = await readConfig()
  assert.equal(configAfterReplace.bindings.length, 1)
  assert.equal(configAfterReplace.bindings[0].taskSpaceId, featureTaskSpaceId)
  assert.equal(configAfterReplace.bindings[0].branchName, 'feature/e2e-branch')

  const serverBindingsAfterReplace = bindingsForAgent()
  assert.equal(
    serverBindingsAfterReplace.filter((binding) => binding.sync_status === 'approved').length,
    1,
  )
  assert.equal(
    serverBindingsAfterReplace.find((binding) => binding.task_space_id === mainTaskSpaceId)
      ?.sync_status,
    'revoked',
  )
  const mainRevisionAfterReplace = taskSpaceRevision(mainTaskSpaceId)
  const mainFilesAfterReplace = taskSpaceFileCount(mainTaskSpaceId)

  await startAgent()
  evidence.replacedAgentPid = agent.pid
  await waitFor(
    'feature 分支任务上传',
    () => taskSpaceRevision(featureTaskSpaceId) >= 1,
    30_000,
  )
  await waitFor('feature 同步状态恢复', async () => {
    const binding = (await readConfig()).bindings[0]
    return ['ready', 'syncing'].includes(binding.liveSyncStatus) && !binding.lastErrorCode
  })
  assert.equal(taskSpaceRevision(mainTaskSpaceId), mainRevisionAfterReplace)
  assert.equal(taskSpaceFileCount(mainTaskSpaceId), mainFilesAfterReplace)
  evidence.operations.push({
    name: 'feature-reassociation',
    serverBindings: serverBindingsAfterReplace.map((binding) => ({
      branch: binding.branch_name,
      status: binding.sync_status,
    })),
    localBindingCount: configAfterReplace.bindings.length,
    featureRevision: taskSpaceRevision(featureTaskSpaceId),
    mainRevision: taskSpaceRevision(mainTaskSpaceId),
    mainFiles: taskSpaceFileCount(mainTaskSpaceId),
  })

  evidence.result = 'passed'
  evidence.finishedAt = new Date().toISOString()
}

try {
  await run()
} catch (error) {
  evidence.result = 'failed'
  evidence.finishedAt = new Date().toISOString()
  evidence.error = {
    name: error.name,
    message: error.message,
    stack: error.stack,
  }
  process.exitCode = 1
} finally {
  try {
    await stopChild(agent, 'Agent')
  } catch (error) {
    evidence.cleanupErrors = [...(evidence.cleanupErrors || []), error.message]
  }
  try {
    await stopChild(proxy, '本地代理')
  } catch (error) {
    evidence.cleanupErrors = [...(evidence.cleanupErrors || []), error.message]
  }
  try {
    await runtime?.stop()
  } catch (error) {
    evidence.cleanupErrors = [...(evidence.cleanupErrors || []), error.message]
  }
  proxyLogStream?.end()
  agentLogStream?.end()
  await delay(150)

  const tempAgentLog = path.join(agentRoot, 'logs', 'agent.log')
  if (fs.existsSync(tempAgentLog)) {
    fs.copyFileSync(tempAgentLog, path.join(EVIDENCE_DIR, 'agent.log'))
  }

  const resolvedTempRoot = path.resolve(tempRoot)
  const resolvedSystemTemp = path.resolve(os.tmpdir())
  if (
    resolvedTempRoot.startsWith(`${resolvedSystemTemp}${path.sep}`) &&
    path.basename(resolvedTempRoot).startsWith('trellis-branch-e2e-')
  ) {
    try {
      fs.rmSync(resolvedTempRoot, { recursive: true, force: true })
      evidence.cleanup = { tempRootRemoved: true }
    } catch (error) {
      evidence.cleanup = { tempRootRemoved: false, error: error.message }
    }
  } else {
    evidence.cleanup = { tempRootRemoved: false, error: '临时目录校验失败，未删除' }
  }

  fs.writeFileSync(resultFile, `${JSON.stringify(evidence, null, 2)}\n`)
  fs.writeFileSync(reportJsonFile, `${JSON.stringify(evidence, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`)
}
