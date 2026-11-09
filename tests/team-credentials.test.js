import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { openDatabase } from '../server/database.js'
import { createUser } from '../server/team/auth.js'
import { createGitCredentialService } from '../server/team/git-credentials.js'
import {
  createGitManager,
  gitEnvironment,
  normalizeGitRemote,
  readGitProject,
  recommendedProjectName,
  sshScanEnvironment,
  sshScanFailureDetails,
} from '../server/team/git-manager.js'
import { createTeamRuntime } from '../server/team/http.js'
import {
  minimalEnvironment,
  runProcess,
  sanitizeProcessOutput,
  trellisEnvironment,
} from '../server/team/process.js'

const PUBLIC_ORIGIN = 'http://127.0.0.1:4317'
const SILENT_LOGGER = {
  info() {},
  warn() {},
  error() {},
}
const HOST = '127.0.0.1:4317'
const PROXY_ENV_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
]

test('Git 子进程仅继承标准代理环境', () => {
  const original = Object.fromEntries(PROXY_ENV_KEYS.map((key) => [key, process.env[key]]))
  try {
    for (const key of PROXY_ENV_KEYS) delete process.env[key]
    process.env.HTTP_PROXY = 'http://upper-proxy.example:8080'
    process.env.NO_PROXY = 'localhost,*.example.com'

    const upper = gitEnvironment()
    assert.equal(upper.HTTP_PROXY, 'http://upper-proxy.example:8080')
    assert.equal(upper.NO_PROXY, 'localhost,*.example.com')
    assert.equal(upper.https_proxy, undefined)
    assert.equal(upper.GIT_CONFIG_NOSYSTEM, '1')
    assert.equal(
      gitEnvironment({ GIT_CONFIG_GLOBAL: 'C:/tmp/trellis-empty-git-config' }).GIT_CONFIG_GLOBAL,
      'C:/tmp/trellis-empty-git-config',
    )
    assert.equal(minimalEnvironment().HTTP_PROXY, undefined)
    const trellisEnv = trellisEnvironment()
    assert.equal(trellisEnv.NO_COLOR, '1')
    assert.equal(trellisEnv.FORCE_COLOR, '0')
    assert.equal(trellisEnv.HTTP_PROXY, undefined)

    delete process.env.HTTP_PROXY
    delete process.env.NO_PROXY
    process.env.https_proxy = 'http://lower-proxy.example:8080'

    const lower = gitEnvironment()
    assert.equal(lower.https_proxy, 'http://lower-proxy.example:8080')
    assert.equal(lower.HTTP_PROXY, undefined)

    delete process.env.https_proxy
    process.env.http_proxy = ''

    const empty = gitEnvironment()
    assert.equal(empty.http_proxy, undefined)
  } finally {
    for (const key of PROXY_ENV_KEYS) delete process.env[key]
    for (const [key, value] of Object.entries(original)) {
      if (value !== undefined) process.env[key] = value
    }
  }
})

test('SSH 主机扫描失败摘要脱敏并保留退出信息', () => {
  const details = sshScanFailureDetails({
    code: 1,
    signal: null,
    stderr: [
      'fetch https://user:secret@example.test failed Bearer abc.def',
      String.raw`load C:\Users\example\private\id_ed25519`,
    ].join('\n'),
    stdout: 'host key material',
    environmentKeys: ['PATH', 'PROGRAMDATA'],
    gitConfigGlobal: 'C:/Users/example/private/.empty-git-config',
    gitConfigGlobalIsolated: true,
  })

  assert.equal(details.code, 1)
  assert.equal(details.signal, null)
  assert.equal(details.stdoutBytes, Buffer.byteLength('host key material', 'utf8'))
  assert.deepEqual(details.environmentKeys, ['PATH', 'PROGRAMDATA'])
  assert.equal(details.gitConfigGlobalIsolated, true)
  assert.match(details.stderr, /https:\/\/\*\*\*@example\.test/)
  assert.match(details.stderr, /Bearer \*\*\*/)
  assert.equal(details.stderr.includes('secret'), false)
  assert.equal(details.stderr.includes('abc.def'), false)
  assert.equal(details.stderr.includes(String.raw`C:\Users\example`), false)
  assert.match(details.stderr, /\[local-path\]/)
  assert.equal(JSON.stringify(details).includes('C:/Users/example'), false)
})

test('SSH 扫描仅保留 Windows OpenSSH 所需的 PROGRAMDATA', () => {
  assert.equal(
    sshScanEnvironment({
      platform: 'win32',
      programData: 'C:/ProgramData',
    }).PROGRAMDATA,
    'C:/ProgramData',
  )
  assert.equal(
    sshScanEnvironment({
      platform: 'linux',
      programData: 'C:/ProgramData',
    }).PROGRAMDATA,
    undefined,
  )
})

function testConfig(overrides = {}) {
  return {
    mode: 'team',
    bindHost: '127.0.0.1',
    port: 0,
    publicUrl: new URL(PUBLIC_ORIGIN),
    publicOrigin: PUBLIC_ORIGIN,
    sessionTtlMs: 12 * 60 * 60 * 1000,
    agentStaleMs: 60_000,
    gitPollMs: 60_000,
    cookieSecure: false,
    trustProxy: false,
    allowLocalGitRemotes: true,
    ...overrides,
  }
}

function makeWorkspace(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const dataDir = path.join(root, 'data')
  const db = openDatabase({
    databaseFile: path.join(dataDir, 'board.sqlite'),
    fallbackRepositories: [],
    importLegacyRepositories: false,
    legacyJsonImport: false,
    logger: SILENT_LOGGER,
  })
  t.after(() => {
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { root, dataDir, db }
}

function seedActor(db, { id, teamId, teamName = teamId, role = 'admin', systemAdmin = false }) {
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO team(id, name, slug, status, created_at, updated_at)
    VALUES (?, ?, ?, 'active', ?, ?)
  `).run(teamId, teamName, teamId, now, now)
  db.prepare(`
    INSERT INTO user_account(
      id, username_key, username, display_name, password_hash,
      password_params_json, system_admin, status, must_change_password,
      password_changed_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'unused', '{}', ?, 'active', 0, ?, ?, ?)
  `).run(id, id.toLowerCase(), id, id, systemAdmin ? 1 : 0, now, now, now)
  if (!systemAdmin) {
    db.prepare(`
      INSERT INTO team_member(team_id, user_id, role, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(teamId, id, role, now, now)
  }
  return { userId: id, systemAdmin }
}

function insertProject(
  db,
  { projectId, teamId, credentialId, remoteUrl = 'https://github.com/example/repo.git' },
) {
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO repositories(id, name, path, path_key, position, created_at, updated_at)
    VALUES (?, ?, ?, ?, 0, ?, ?)
  `).run(
    projectId,
    '示例项目',
    path.join(os.tmpdir(), projectId),
    path.join(os.tmpdir(), projectId).toLowerCase(),
    now,
    now,
  )
  db.prepare(`
    INSERT INTO team_project(
      repository_id, team_id, workspace_key, remote_url, remote_identity_hash,
      sync_branch, git_credential_id, trusted_task_toolchain_sha256,
      sync_status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'main', ?, ?, 'current', ?, ?)
  `).run(
    projectId,
    teamId,
    `${projectId}-workspace`,
    remoteUrl,
    'f'.repeat(64),
    credentialId,
    'a'.repeat(64),
    now,
    now,
  )
}

test('Git 凭据密文保存、团队隔离、更新和引用删除保护', (t) => {
  const { dataDir, db } = makeWorkspace(t, 'trellis-team-credentials-')
  const owner = seedActor(db, {
    id: 'credential-owner',
    teamId: 'team-a',
  })
  const other = seedActor(db, {
    id: 'credential-other',
    teamId: 'team-b',
  })
  const service = createGitCredentialService({ db, dataDir })

  const created = service.create(owner, {
    teamId: 'team-a',
    name: 'GitHub 账号',
    host: 'GitHub.com',
    authType: 'https_token',
    username: 'build-bot',
    token: 'super-secret-token',
  })
  assert.equal(created.host, 'github.com')
  assert.equal(created.username, 'build-bot')
  assert.equal(JSON.stringify(created).includes('super-secret-token'), false)

  const stored = db.prepare('SELECT * FROM git_credential WHERE id = ?').get(created.id)
  assert.equal(JSON.stringify(stored).includes('super-secret-token'), false)
  assert.equal(fs.readFileSync(path.join(dataDir, 'git-credentials.key')).length, 32)

  const remote = normalizeGitRemote('https://github.com/example/repo.git', testConfig())
  assert.equal(
    service.resolveForRemote(owner, {
      teamId: 'team-a',
      credentialId: created.id,
      remote,
    }).payload.token,
    'super-secret-token',
  )
  assert.throws(
    () =>
      service.resolveForRemote(other, {
        teamId: 'team-b',
        credentialId: created.id,
        remote,
      }),
    (error) => error.code === 'FORBIDDEN',
  )
  assert.throws(
    () =>
      service.resolveForRemote(owner, {
        teamId: 'team-a',
        credentialId: created.id,
        remote: normalizeGitRemote('https://gitlab.com/example/repo.git', testConfig()),
      }),
    (error) => error.code === 'INVALID_INPUT',
  )
  db.prepare("UPDATE git_credential SET host = 'evil.example.com' WHERE id = ?").run(created.id)
  assert.throws(
    () =>
      service.resolveForRemote(owner, {
        teamId: 'team-a',
        credentialId: created.id,
        remote: normalizeGitRemote('https://evil.example.com/example/repo.git', testConfig()),
      }),
    (error) => error.code === 'GIT_CREDENTIAL_DECRYPT_FAILED',
  )
  db.prepare("UPDATE git_credential SET host = 'github.com' WHERE id = ?").run(created.id)

  insertProject(db, {
    projectId: 'credential-project',
    teamId: 'team-a',
    credentialId: created.id,
  })
  const project = readGitProject(db, 'credential-project')
  assert.equal(project.teamId, 'team-a')
  assert.equal(
    service.resolveProjectCredential(project, remote).payload.token,
    'super-secret-token',
  )
  assert.throws(
    () => service.remove(owner, created.id),
    (error) =>
      error.code === 'GIT_CREDENTIAL_IN_USE' &&
      error.details.projects[0].id === 'credential-project',
  )

  const updated = service.update(owner, created.id, {
    name: 'GitHub 发布账号',
    username: 'release-bot',
    token: 'rotated-secret-token',
  })
  assert.equal(updated.name, 'GitHub 发布账号')
  assert.equal(JSON.stringify(updated).includes('rotated-secret-token'), false)
  assert.equal(
    service.resolveForRemote(owner, {
      teamId: 'team-a',
      credentialId: created.id,
      remote,
    }).payload.token,
    'rotated-secret-token',
  )

  db.prepare('UPDATE team_project SET git_credential_id = NULL WHERE repository_id = ?').run(
    'credential-project',
  )
  assert.deepEqual(service.remove(owner, created.id), { ok: true })
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM git_credential').get().count, 0)
  const auditText = db
    .prepare("SELECT detail_json FROM audit_event WHERE action LIKE 'git_credential_%'")
    .all()
    .map((row) => row.detail_json)
    .join('\n')
  assert.equal(auditText.includes('super-secret-token'), false)
  assert.equal(auditText.includes('rotated-secret-token'), false)
})

test('主密钥缺失时禁止静默重建并拒绝解密已有凭据', (t) => {
  const { dataDir, db } = makeWorkspace(t, 'trellis-team-credentials-key-')
  const owner = seedActor(db, {
    id: 'key-owner',
    teamId: 'team-key',
  })
  const service = createGitCredentialService({ db, dataDir })
  const created = service.create(owner, {
    teamId: 'team-key',
    name: 'SSH 构建密钥',
    host: 'gitlab.example.com',
    authType: 'ssh_key',
    privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nfixture\n-----END OPENSSH PRIVATE KEY-----',
    passphrase: 'key-passphrase',
  })
  fs.rmSync(path.join(dataDir, 'git-credentials.key'))

  assert.throws(
    () =>
      service.resolveForRemote(owner, {
        teamId: 'team-key',
        credentialId: created.id,
        remote: normalizeGitRemote('git@gitlab.example.com:group/repo.git', testConfig()),
      }),
    (error) => error.code === 'GIT_CREDENTIAL_KEY_MISSING',
  )
  assert.equal(fs.existsSync(path.join(dataDir, 'git-credentials.key')), false)
})

test('远端探测返回推荐名称、默认分支、全部分支，并处理无默认分支与空仓库', async (t) => {
  const { root, dataDir, db } = makeWorkspace(t, 'trellis-team-probe-')
  const staleAuthDir = path.join(dataDir, '.git-auth', 'run-stale')
  fs.mkdirSync(staleAuthDir, { recursive: true })
  fs.writeFileSync(path.join(staleAuthDir, 'identity'), 'stale-private-key')
  const manager = createGitManager({
    db,
    config: testConfig(),
    dataDir,
    credentialService: createGitCredentialService({ db, dataDir }),
  })
  assert.equal(fs.readFileSync(path.join(dataDir, '.empty-git-config'), 'utf8'), '')
  assert.equal(fs.existsSync(staleAuthDir), false)
  const bare = path.join(root, 'repo.git')
  const seed = path.join(root, 'seed')
  git(root, ['init', '--bare', '--initial-branch=main', bare])
  fs.mkdirSync(seed)
  git(seed, ['init', '--initial-branch=main'])
  git(seed, ['config', 'user.name', 'Probe Test'])
  git(seed, ['config', 'user.email', 'probe@example.invalid'])
  write(path.join(seed, 'README.md'), 'probe\n')
  git(seed, ['add', '--', '.'])
  git(seed, ['commit', '-m', 'seed'])
  git(seed, ['remote', 'add', 'origin', pathToFileURL(bare).href])
  git(seed, ['push', '-u', 'origin', 'main'])
  git(seed, ['checkout', '-b', 'dev'])
  write(path.join(seed, 'dev.txt'), 'dev\n')
  git(seed, ['add', '--', '.'])
  git(seed, ['commit', '-m', 'dev'])
  git(seed, ['push', 'origin', 'dev'])

  const remote = normalizeGitRemote(bare, testConfig())
  const result = await manager.probeRemote({
    actor: { userId: 'probe-user' },
    remote,
  })
  assert.equal(result.recommendedName, 'repo')
  assert.equal(result.defaultBranch, 'main')
  assert.deepEqual(result.branches, ['dev', 'main'])
  assert.equal(
    recommendedProjectName(normalizeGitRemote('git@github.com:example/repo.git', testConfig())),
    'repo',
  )
  assert.equal(
    recommendedProjectName(normalizeGitRemote('https://github.com/example/repo.git', testConfig())),
    'repo',
  )

  const detached = path.join(root, 'detached.git')
  const detachedSeed = path.join(root, 'detached-seed')
  git(root, ['init', '--bare', '--initial-branch=main', detached])
  fs.mkdirSync(detachedSeed)
  git(detachedSeed, ['init', '--initial-branch=main'])
  git(detachedSeed, ['config', 'user.name', 'Probe Test'])
  git(detachedSeed, ['config', 'user.email', 'probe@example.invalid'])
  write(path.join(detachedSeed, 'README.md'), 'detached\n')
  git(detachedSeed, ['add', '--', '.'])
  git(detachedSeed, ['commit', '-m', 'seed'])
  git(detachedSeed, ['remote', 'add', 'origin', pathToFileURL(detached).href])
  git(detachedSeed, ['push', '-u', 'origin', 'main'])
  const mainSha = git(detached, ['rev-parse', 'main']).stdout.trim()
  git(detached, ['update-ref', '--no-deref', 'HEAD', mainSha])
  const detachedResult = await manager.probeRemote({
    actor: { userId: 'detached-user' },
    remote: normalizeGitRemote(detached, testConfig()),
  })
  assert.equal(detachedResult.defaultBranch, null)
  assert.deepEqual(detachedResult.branches, ['main'])

  const empty = path.join(root, 'empty.git')
  git(root, ['init', '--bare', '--initial-branch=main', empty])
  await assert.rejects(
    () =>
      manager.probeRemote({
        actor: { userId: 'empty-user' },
        remote: normalizeGitRemote(empty, testConfig()),
      }),
    (error) => error.code === 'GIT_REMOTE_NO_HEADS',
  )
})

test('远端探测按用户限流', async (t) => {
  const { root, dataDir, db } = makeWorkspace(t, 'trellis-team-probe-limit-')
  const manager = createGitManager({
    db,
    config: testConfig(),
    dataDir,
    credentialService: createGitCredentialService({ db, dataDir }),
  })
  const bare = path.join(root, 'limited.git')
  git(root, ['init', '--bare', '--initial-branch=main', bare])
  const remote = normalizeGitRemote(bare, testConfig())
  for (let index = 0; index < 5; index += 1) {
    await assert.rejects(
      () =>
        manager.probeRemote({
          actor: { userId: 'limited-user' },
          remote,
        }),
      (error) => error.code === 'GIT_REMOTE_NO_HEADS',
    )
  }
  await assert.rejects(
    () =>
      manager.probeRemote({
        actor: { userId: 'limited-user' },
        remote,
      }),
    (error) => error.code === 'GIT_REMOTE_PROBE_RATE_LIMITED',
  )
})

test('团队 HTTP 凭据接口不下发秘密并隔离非团队管理员', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-team-credential-http-'))
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

  const admin = await createUser(runtime.db, {
    username: 'credential-admin',
    displayName: '凭据管理员',
    password: 'Credential-Password-123',
    systemAdmin: false,
    mustChangePassword: false,
  })
  const member = await createUser(runtime.db, {
    username: 'credential-member',
    displayName: '普通成员',
    password: 'Member-Password-123',
    systemAdmin: false,
    mustChangePassword: false,
  })
  const now = new Date().toISOString()
  runtime.db
    .prepare(`
    INSERT INTO team(id, name, slug, status, created_at, updated_at)
    VALUES ('credential-team', '凭据团队', 'credential-team', 'active', ?, ?)
  `)
    .run(now, now)
  runtime.db
    .prepare(`
    INSERT INTO team_member(team_id, user_id, role, created_at, updated_at)
    VALUES ('credential-team', ?, 'admin', ?, ?)
  `)
    .run(admin.id, now, now)
  runtime.db
    .prepare(`
    INSERT INTO team_member(team_id, user_id, role, created_at, updated_at)
    VALUES ('credential-team', ?, 'member', ?, ?)
  `)
    .run(member.id, now, now)

  const adminCookie = await login(runtime, admin.username, 'Credential-Password-123')
  const memberCookie = await login(runtime, member.username, 'Member-Password-123')
  const created = await request(runtime, '/api/admin/git-credentials', {
    method: 'POST',
    cookie: adminCookie,
    body: {
      teamId: 'credential-team',
      name: 'HTTP GitHub',
      host: 'github.com',
      authType: 'https_token',
      username: 'build-bot',
      token: 'http-secret-token',
    },
  })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  assert.equal(JSON.stringify(created.body).includes('http-secret-token'), false)
  insertProject(runtime.db, {
    projectId: 'http-credential-project',
    teamId: 'credential-team',
    credentialId: created.body.credential.id,
  })

  const listed = await request(runtime, '/api/admin/git-credentials?teamId=credential-team', {
    cookie: adminCookie,
  })
  assert.equal(listed.status, 200)
  assert.equal(listed.body.credentials.length, 1)
  assert.equal(listed.body.credentials[0].projectCount, 1)
  assert.equal(listed.body.credentials[0].projects[0].id, 'http-credential-project')
  assert.equal(JSON.stringify(listed.body).includes('http-secret-token'), false)
  const projects = await request(runtime, '/api/admin/projects?teamId=credential-team', {
    cookie: adminCookie,
  })
  assert.equal(projects.status, 200)
  assert.equal(projects.body.projects[0].credential.id, created.body.credential.id)
  assert.equal(JSON.stringify(projects.body).includes('http-secret-token'), false)
  assert.equal(
    (
      await request(runtime, '/api/team/projects', {
        cookie: adminCookie,
      })
    ).status,
    200,
  )

  const inUse = await request(runtime, `/api/admin/git-credentials/${created.body.credential.id}`, {
    method: 'DELETE',
    cookie: adminCookie,
    body: {},
  })
  assert.equal(inUse.status, 409)
  assert.equal(inUse.body.code, 'GIT_CREDENTIAL_IN_USE')

  const forbidden = await request(runtime, '/api/admin/git-credentials', {
    method: 'POST',
    cookie: memberCookie,
    body: {
      teamId: 'credential-team',
      name: '不应创建',
      host: 'gitlab.com',
      authType: 'https_token',
      username: 'member',
      token: 'member-secret',
    },
  })
  assert.equal(forbidden.status, 403)
  assert.equal(
    (
      await request(runtime, '/api/admin/git-credentials?teamId=credential-team', {
        cookie: memberCookie,
      })
    ).status,
    403,
  )

  const bare = path.join(root, 'http-probe.git')
  git(root, ['init', '--bare', '--initial-branch=main', bare])
  const probed = await request(runtime, '/api/admin/projects/probe', {
    method: 'POST',
    cookie: adminCookie,
    body: {
      teamId: 'credential-team',
      remoteUrl: bare,
      credentialId: null,
    },
  })
  assert.equal(probed.status, 422)
  assert.equal(probed.body.code, 'GIT_REMOTE_NO_HEADS')
})

test('子进程输出按字节截断并按已知秘密脱敏', async () => {
  const secret = 'credential-output-secret'
  const result = await runProcess(
    process.execPath,
    [
      '-e',
      `process.stdout.write(${JSON.stringify(secret + 'x'.repeat(64))}); process.stderr.write(${JSON.stringify(secret)})`,
    ],
    {
      cwd: process.cwd(),
      maxOutputBytes: 24,
      redact: [secret],
    },
  )
  assert.equal(result.truncated, true)
  assert.equal(result.stdout.includes(secret), false)
  assert.equal(result.stderr.includes(secret), false)
  assert.match(result.stdout, /\[redacted\]/)
  assert.equal(
    sanitizeProcessOutput(`prefix ${secret} suffix`, { redact: [secret] }),
    'prefix [redacted] suffix',
  )
})

function git(cwd, args) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    shell: false,
    env: process.env,
  })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} 失败：${result.stderr || result.stdout}`)
  }
  return result
}

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content, 'utf8')
}

function request(
  runtime,
  pathname,
  { method = 'GET', body = null, cookie = null, origin = PUBLIC_ORIGIN } = {},
) {
  const address = runtime.address()
  const payload = body == null ? null : JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const headers = { host: HOST }
    if (payload != null) {
      headers['content-type'] = 'application/json'
      headers['content-length'] = Buffer.byteLength(payload)
    }
    if (origin != null && method !== 'GET' && method !== 'HEAD') {
      headers.origin = origin
    }
    if (cookie) headers.cookie = cookie
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
          if (text) {
            try {
              parsed = JSON.parse(text)
            } catch {
              parsed = text
            }
          }
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: parsed,
          })
        })
      },
    )
    req.on('error', reject)
    if (payload != null) req.write(payload)
    req.end()
  })
}

async function login(runtime, username, password) {
  const response = await request(runtime, '/api/auth/login', {
    method: 'POST',
    body: { username, password },
  })
  assert.equal(response.status, 200, JSON.stringify(response.body))
  return String((response.headers['set-cookie'] || [])[0] || '').split(';')[0]
}
