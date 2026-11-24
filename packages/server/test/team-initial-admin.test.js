import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  DEFAULT_INITIAL_ADMIN_PASSWORD,
  DEFAULT_INITIAL_ADMIN_USERNAME,
  parseTeamConfig,
} from '../config.js'
import { openDatabase } from '../database.js'
import { loadProjectEnv } from '../env-file.js'
import { createUser } from '../team/auth.js'
import { createTeamRuntime } from '../team/http.js'

const PUBLIC_ORIGIN = 'http://127.0.0.1:4317'
const HOST = '127.0.0.1:4317'

function makeLogger(records = []) {
  return {
    info(message, detail) {
      records.push({ level: 'info', message, detail })
    },
    warn(message, detail) {
      records.push({ level: 'warn', message, detail })
    },
    error(message, detail) {
      records.push({ level: 'error', message, detail })
    },
  }
}

function makeTempDir(prefix = 'trellis-initial-admin-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function request(runtime, pathname, { method = 'GET', body = null, cookie = null } = {}) {
  const payload = body == null ? null : JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const headers = { host: HOST }
    if (payload != null) {
      headers['content-type'] = 'application/json'
      headers['content-length'] = Buffer.byteLength(payload)
    }
    if (method !== 'GET' && method !== 'HEAD') headers.origin = PUBLIC_ORIGIN
    if (cookie) headers.cookie = cookie
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: runtime.address().port,
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
          resolve({ status: response.statusCode, headers: response.headers, body: parsed })
        })
      },
    )
    req.on('error', reject)
    if (payload != null) req.write(payload)
    req.end()
  })
}

function cookieOf(response) {
  return String((response.headers['set-cookie'] || [])[0] || '').split(';')[0]
}

test('parseTeamConfig 未配置或留空时回退到默认初始管理员凭据', () => {
  const defaults = parseTeamConfig({ TRELLIS_BOARD_MODE: 'team' })
  assert.deepEqual(defaults.initialAdmin, {
    username: DEFAULT_INITIAL_ADMIN_USERNAME,
    password: DEFAULT_INITIAL_ADMIN_PASSWORD,
  })
  assert.equal(defaults.initialAdmin.username, 'admin')
  assert.equal(defaults.initialAdmin.password, '123456!@#$%^')

  const blank = parseTeamConfig({
    TRELLIS_BOARD_MODE: 'team',
    TRELLIS_BOARD_ADMIN_USERNAME: '   ',
    TRELLIS_BOARD_ADMIN_PASSWORD: '',
  })
  assert.deepEqual(blank.initialAdmin, {
    username: 'admin',
    password: '123456!@#$%^',
  })
})

test('parseTeamConfig 支持从 .env 读取自定义管理员且进程环境变量优先', (t) => {
  const dir = makeTempDir()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.writeFileSync(
    path.join(dir, '.env'),
    [
      'TRELLIS_BOARD_MODE=team',
      'TRELLIS_BOARD_ADMIN_USERNAME=Root.Admin',
      "TRELLIS_BOARD_ADMIN_PASSWORD='Secret#Pass$2026'",
    ].join('\n') + '\n',
  )

  const envFromFile = {}
  loadProjectEnv({ directory: dir, env: envFromFile })
  const configFromFile = parseTeamConfig(envFromFile)
  assert.deepEqual(configFromFile.initialAdmin, {
    username: 'root.admin',
    password: 'Secret#Pass$2026',
  })

  const envWithOverride = {
    TRELLIS_BOARD_ADMIN_USERNAME: 'CliAdmin',
    TRELLIS_BOARD_ADMIN_PASSWORD: 'Override#Password!',
  }
  loadProjectEnv({ directory: dir, env: envWithOverride })
  const configWithOverride = parseTeamConfig(envWithOverride)
  assert.deepEqual(configWithOverride.initialAdmin, {
    username: 'cliadmin',
    password: 'Override#Password!',
  })
})

test('仓库根 .env 可被 loadProjectEnv 正确解析为默认管理员凭据（含 # 不被截断）', () => {
  const env = {}
  const loaded = loadProjectEnv({ env })
  assert.equal(loaded.loaded, true)
  const config = parseTeamConfig(env)
  assert.deepEqual(config.initialAdmin, {
    username: 'admin',
    password: '123456!@#$%^',
  })
})

test('parseTeamConfig 拒绝非法初始管理员用户名与密码且不泄漏密码明文', () => {
  assert.throws(
    () =>
      parseTeamConfig({
        TRELLIS_BOARD_MODE: 'team',
        TRELLIS_BOARD_ADMIN_USERNAME: 'ab',
      }),
    /TRELLIS_BOARD_ADMIN_USERNAME 配置无效/,
  )
  assert.throws(
    () =>
      parseTeamConfig({
        TRELLIS_BOARD_MODE: 'team',
        TRELLIS_BOARD_ADMIN_USERNAME: 'bad user!',
      }),
    /TRELLIS_BOARD_ADMIN_USERNAME 配置无效/,
  )
  assert.throws(
    () =>
      parseTeamConfig({
        TRELLIS_BOARD_MODE: 'team',
        TRELLIS_BOARD_ADMIN_PASSWORD: 'short',
      }),
    (error) =>
      /TRELLIS_BOARD_ADMIN_PASSWORD 配置无效/.test(error.message) &&
      !error.message.includes('short'),
  )
})

test('空库启动自动创建初始管理员，首次登录需改密且日志不输出明文密码', async (t) => {
  const root = makeTempDir()
  let runtime = null
  t.after(async () => {
    await runtime?.stop()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const dataDir = path.join(root, 'data')
  const databaseFile = path.join(dataDir, 'board.sqlite')
  const logs = []
  const config = {
    ...parseTeamConfig({ TRELLIS_BOARD_MODE: 'team', PORT: '4317' }),
    bindHost: '127.0.0.1',
    port: 0,
  }

  runtime = await createTeamRuntime({
    config,
    databaseFile,
    dataDir,
    logger: makeLogger(logs),
    requireAdmin: true,
    enablePolling: false,
  })
  await runtime.start()

  assert.equal(
    logs.some((entry) => JSON.stringify(entry).includes(DEFAULT_INITIAL_ADMIN_PASSWORD)),
    false,
    '启动日志不得包含明文密码',
  )
  assert.equal(
    logs.some(
      (entry) =>
        entry.message === '已自动初始化系统管理员' &&
        entry.detail?.username === 'admin' &&
        entry.detail?.mustChangePassword === true,
    ),
    true,
  )

  const login = await request(runtime, '/api/auth/login', {
    method: 'POST',
    body: {
      username: DEFAULT_INITIAL_ADMIN_USERNAME,
      password: DEFAULT_INITIAL_ADMIN_PASSWORD,
    },
  })
  assert.equal(login.status, 200)
  assert.equal(login.body.user.username, 'admin')
  assert.equal(login.body.user.systemAdmin, true)
  assert.equal(login.body.user.mustChangePassword, true)
  const cookie = cookieOf(login)

  const blocked = await request(runtime, '/api/admin/users', { cookie })
  assert.equal(blocked.status, 403)
  assert.equal(blocked.body.code, 'PASSWORD_CHANGE_REQUIRED')

  const changed = await request(runtime, '/api/auth/password', {
    method: 'POST',
    cookie,
    body: {
      currentPassword: DEFAULT_INITIAL_ADMIN_PASSWORD,
      newPassword: 'New-Admin-Password-2026',
    },
  })
  assert.equal(changed.status, 200)
  assert.equal(changed.body.user.mustChangePassword, false)

  const users = await request(runtime, '/api/admin/users', { cookie })
  assert.equal(users.status, 200)
  assert.equal(users.body.users.length, 1)
  assert.equal(users.body.users[0].username, 'admin')
})

test('已有有效系统管理员时重启不新建管理员也不覆盖原密码', async (t) => {
  const root = makeTempDir()
  let runtime = null
  t.after(async () => {
    await runtime?.stop()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const dataDir = path.join(root, 'data')
  const databaseFile = path.join(dataDir, 'board.sqlite')

  const db = openDatabase({
    databaseFile,
    fallbackRepositories: [],
    importLegacyRepositories: false,
    legacyJsonImport: false,
  })
  try {
    await createUser(db, {
      username: 'existing-admin',
      displayName: '已有管理员',
      password: 'Existing-Password-123',
      systemAdmin: true,
      mustChangePassword: false,
    })
  } finally {
    db.close()
  }

  runtime = await createTeamRuntime({
    config: {
      ...parseTeamConfig({
        TRELLIS_BOARD_MODE: 'team',
        TRELLIS_BOARD_ADMIN_USERNAME: 'new-env-admin',
        TRELLIS_BOARD_ADMIN_PASSWORD: 'Another-Password-456',
      }),
      bindHost: '127.0.0.1',
      port: 0,
    },
    databaseFile,
    dataDir,
    logger: makeLogger(),
    requireAdmin: true,
    enablePolling: false,
  })
  await runtime.start()

  const usernames = runtime.db
    .prepare('SELECT username FROM user_account ORDER BY username')
    .all()
    .map((row) => row.username)
  assert.deepEqual(usernames, ['existing-admin'])

  const existingLogin = await request(runtime, '/api/auth/login', {
    method: 'POST',
    body: { username: 'existing-admin', password: 'Existing-Password-123' },
  })
  assert.equal(existingLogin.status, 200)

  const envLogin = await request(runtime, '/api/auth/login', {
    method: 'POST',
    body: { username: 'new-env-admin', password: 'Another-Password-456' },
  })
  assert.equal(envLogin.status, 401)
})

test('无有效系统管理员但目标用户名已被占用时启动失败且不提权覆盖', async (t) => {
  const root = makeTempDir()
  let checkDb = null
  t.after(() => {
    checkDb?.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const dataDir = path.join(root, 'data')
  const databaseFile = path.join(dataDir, 'board.sqlite')

  const db = openDatabase({
    databaseFile,
    fallbackRepositories: [],
    importLegacyRepositories: false,
    legacyJsonImport: false,
  })
  try {
    await createUser(db, {
      username: 'admin',
      displayName: '普通成员',
      password: 'Member-Password-123',
      systemAdmin: false,
      mustChangePassword: false,
    })
  } finally {
    db.close()
  }

  await assert.rejects(
    () =>
      createTeamRuntime({
        config: {
          ...parseTeamConfig({ TRELLIS_BOARD_MODE: 'team' }),
          bindHost: '127.0.0.1',
          port: 0,
        },
        databaseFile,
        dataDir,
        logger: makeLogger(),
        requireAdmin: true,
        enablePolling: false,
      }),
    (error) => error.status === 409 && error.code === 'CONFLICT',
  )

  checkDb = openDatabase({
    databaseFile,
    fallbackRepositories: [],
    importLegacyRepositories: false,
    legacyJsonImport: false,
  })
  const account = checkDb
    .prepare('SELECT system_admin, status FROM user_account WHERE username_key = ?')
    .get('admin')
  assert.equal(account.system_admin, 0)
  assert.equal(account.status, 'active')
})

test('未提供 config.initialAdmin 且无管理员时仍保持 503 AUTH_REQUIRED 报错', async (t) => {
  const root = makeTempDir()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const dataDir = path.join(root, 'data')
  const databaseFile = path.join(dataDir, 'board.sqlite')

  await assert.rejects(
    () =>
      createTeamRuntime({
        config: {
          mode: 'team',
          bindHost: '127.0.0.1',
          port: 0,
          sessionTtlMs: 12 * 60 * 60 * 1000,
          agentStaleMs: 60_000,
          trustProxy: false,
          allowLocalGitRemotes: false,
        },
        databaseFile,
        dataDir,
        logger: makeLogger(),
        requireAdmin: true,
        enablePolling: false,
      }),
    (error) => error.status === 503 && error.code === 'AUTH_REQUIRED',
  )
})
