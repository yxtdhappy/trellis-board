import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  DEFAULT_INITIAL_ADMIN_PASSWORD,
  DEFAULT_INITIAL_ADMIN_USERNAME,
  normalizeBasePath,
  parseTeamConfig,
} from '../config.js'
import { loadProjectEnv } from '../env-file.js'
import { AGENT_PROTOCOL_VERSION } from '../team/sync-agent-service.js'
import { createTeamRuntime } from '../team/http.js'

const HOST = 'spec-board.weintdata.cn'
const PUBLIC_ORIGIN = `http://${HOST}`
const SILENT_LOGGER = { info() {}, warn() {}, error() {} }

function makeTempDir(prefix = 'trellis-subpath-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function request(
  runtime,
  pathname,
  { method = 'GET', body = null, cookie = null, headers: extraHeaders = {} } = {},
) {
  const payload = body == null ? null : JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const headers = { host: HOST, ...extraHeaders }
    if (payload != null) {
      headers['content-type'] = 'application/json'
      headers['content-length'] = Buffer.byteLength(payload)
    }
    if (method !== 'GET' && method !== 'HEAD' && !('origin' in headers)) {
      headers.origin = PUBLIC_ORIGIN
    }
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
          const raw = Buffer.concat(chunks)
          const text = raw.toString('utf8')
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
            raw,
            text,
          })
        })
      },
    )
    req.on('error', reject)
    if (payload != null) req.write(payload)
    req.end()
  })
}

function parseSetCookie(header) {
  return new Map(
    String(header || '')
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf('=')
        return index < 0 ? [part, ''] : [part.slice(0, index), part.slice(index + 1)]
      }),
  )
}

test('normalizeBasePath 规范化合法子路径并拒绝非法或保留前缀', () => {
  assert.equal(normalizeBasePath(undefined), '')
  assert.equal(normalizeBasePath(''), '')
  assert.equal(normalizeBasePath('   '), '')
  assert.equal(normalizeBasePath('/'), '')
  assert.equal(normalizeBasePath('/weint-spec-board'), '/weint-spec-board')
  assert.equal(normalizeBasePath('weint-spec-board/'), '/weint-spec-board')
  assert.equal(normalizeBasePath('/team/spec_board.v1/'), '/team/spec_board.v1')

  for (const invalid of [
    '/a//b',
    '/../secret',
    '/./secret',
    '/bad\\path',
    '/bad?x=1',
    '/bad#hash',
    '/bad space',
    '/bad"quote',
    '/api',
    '/api/sub',
    '/client-updates',
    '/plugin-ui',
    '/assets',
  ]) {
    assert.throws(() => normalizeBasePath(invalid), /TRELLIS_BOARD_BASE_PATH 配置无效/, invalid)
  }
})

test('parseTeamConfig 默认 trustProxy=true，支持覆盖，且仓库 .env 默认配置生效', () => {
  const defaults = parseTeamConfig({ TRELLIS_BOARD_MODE: 'team' })
  assert.equal(defaults.trustProxy, true)
  assert.equal(defaults.basePath, '')

  const overridden = parseTeamConfig({
    TRELLIS_BOARD_MODE: 'team',
    TRELLIS_BOARD_TRUST_PROXY: 'false',
    TRELLIS_BOARD_BASE_PATH: 'weint-spec-board/',
  })
  assert.equal(overridden.trustProxy, false)
  assert.equal(overridden.basePath, '/weint-spec-board')

  const repoEnv = {}
  loadProjectEnv({ env: repoEnv })
  const fromRepoEnv = parseTeamConfig(repoEnv)
  assert.equal(fromRepoEnv.basePath, '/weint-spec-board')
  assert.equal(fromRepoEnv.trustProxy, true)
})

test('trustProxy=true 时登录限流按 X-Forwarded-For 隔离，false 时共用连接 IP', async () => {
  for (const trustProxy of [true, false]) {
    const root = makeTempDir(`trellis-proxy-${trustProxy}-`)
    const dataDir = path.join(root, 'data')
    const config = {
      ...parseTeamConfig({
        TRELLIS_BOARD_MODE: 'team',
        TRELLIS_BOARD_TRUST_PROXY: String(trustProxy),
      }),
      bindHost: '127.0.0.1',
      port: 0,
    }
    let runtime = null
    try {
      runtime = await createTeamRuntime({
        config,
        databaseFile: path.join(dataDir, 'board.sqlite'),
        dataDir,
        logger: SILENT_LOGGER,
        requireAdmin: true,
        enablePolling: false,
      })
      await runtime.start()

      for (let attempt = 0; attempt < 5; attempt += 1) {
        const failed = await request(runtime, '/api/auth/login', {
          method: 'POST',
          headers: { 'x-forwarded-for': '203.0.113.10' },
          body: { username: DEFAULT_INITIAL_ADMIN_USERNAME, password: 'Wrong-Password-123' },
        })
        assert.equal(failed.status, 401)
      }

      const sixthSameIp = await request(runtime, '/api/auth/login', {
        method: 'POST',
        headers: { 'x-forwarded-for': '203.0.113.10' },
        body: {
          username: DEFAULT_INITIAL_ADMIN_USERNAME,
          password: DEFAULT_INITIAL_ADMIN_PASSWORD,
        },
      })
      assert.equal(sixthSameIp.status, 429)

      const anotherClient = await request(runtime, '/api/auth/login', {
        method: 'POST',
        headers: { 'x-forwarded-for': '203.0.113.20' },
        body: {
          username: DEFAULT_INITIAL_ADMIN_USERNAME,
          password: DEFAULT_INITIAL_ADMIN_PASSWORD,
        },
      })
      assert.equal(anotherClient.status, trustProxy ? 200 : 429)
    } finally {
      if (runtime) await runtime.stop()
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    }
  }
})

test('POST /api/agent/enroll 遵循 config.trustProxy 限流隔离', async () => {
  for (const trustProxy of [true, false]) {
    const root = makeTempDir(`trellis-agent-ip-${trustProxy}-`)
    const dataDir = path.join(root, 'data')
    const config = {
      ...parseTeamConfig({
        TRELLIS_BOARD_MODE: 'team',
        TRELLIS_BOARD_TRUST_PROXY: String(trustProxy),
      }),
      bindHost: '127.0.0.1',
      port: 0,
    }
    let runtime = null
    try {
      runtime = await createTeamRuntime({
        config,
        databaseFile: path.join(dataDir, 'board.sqlite'),
        dataDir,
        logger: SILENT_LOGGER,
        requireAdmin: false,
        enablePolling: false,
      })
      await runtime.start()

      for (let attempt = 0; attempt < 30; attempt += 1) {
        const response = await request(runtime, '/api/agent/enroll', {
          method: 'POST',
          headers: { 'x-forwarded-for': '198.51.100.1' },
          body: {
            protocolVersion: AGENT_PROTOCOL_VERSION,
            agentVersion: '0.1.0',
            platform: 'win32',
            deviceName: 'PC-1',
            pairingCode: 'invalid-pairing-code-0001',
          },
        })
        assert.equal(response.status, 401)
      }

      const blockedSameIp = await request(runtime, '/api/agent/enroll', {
        method: 'POST',
        headers: { 'x-forwarded-for': '198.51.100.1' },
        body: {
          protocolVersion: AGENT_PROTOCOL_VERSION,
          agentVersion: '0.1.0',
          platform: 'win32',
          deviceName: 'PC-1',
          pairingCode: 'invalid-pairing-code-0001',
        },
      })
      assert.equal(blockedSameIp.status, 429)

      const otherClient = await request(runtime, '/api/agent/enroll', {
        method: 'POST',
        headers: { 'x-forwarded-for': '198.51.100.2' },
        body: {
          protocolVersion: AGENT_PROTOCOL_VERSION,
          agentVersion: '0.1.0',
          platform: 'win32',
          deviceName: 'PC-2',
          pairingCode: 'invalid-pairing-code-0001',
        },
      })
      assert.equal(otherClient.status, trustProxy ? 401 : 429)
    } finally {
      if (runtime) await runtime.stop()
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    }
  }
})

test('子路径配置支持双模式转发、无尾斜杠重定向、HTML 注入、Cookie Path 与归档下载前缀', async () => {
  const root = makeTempDir('trellis-subpath-http-')
  const dataDir = path.join(root, 'data')
  const publicDir = path.join(root, 'public')
  const clientUpdatesDir = path.join(dataDir, 'client-updates')
  let runtime = null
  try {
    fs.mkdirSync(path.join(publicDir, 'assets'), { recursive: true })
    fs.mkdirSync(clientUpdatesDir, { recursive: true })

    fs.writeFileSync(
      path.join(publicDir, 'index.html'),
      '<!doctype html><html><head><link rel="icon" href="./favicon.svg" /><script src="./theme-init.js"></script><script type="module" src="./assets/main.js"></script></head><body>board</body></html>',
    )
    fs.writeFileSync(
      path.join(publicDir, 'login.html'),
      '<!doctype html><html><head><link rel="icon" href="./favicon.svg" /><script src="./theme-init.js"></script></head><body>login</body></html>',
    )
    fs.writeFileSync(
      path.join(publicDir, 'admin.html'),
      '<!doctype html><html><head><link rel="icon" href="./favicon.svg" /><script src="./theme-init.js"></script></head><body>admin</body></html>',
    )
    fs.writeFileSync(path.join(publicDir, 'favicon.svg'), '<svg></svg>')
    fs.writeFileSync(path.join(publicDir, 'theme-init.js'), 'void 0;\n')
    fs.writeFileSync(path.join(publicDir, 'assets', 'main.js'), 'console.log("ok");\n')
    fs.writeFileSync(
      path.join(clientUpdatesDir, 'latest.json'),
      JSON.stringify({
        version: '0.4.58',
        file: 'TrellisBoard_0.4.58_x64-portable.zip',
        sha256: '0'.repeat(64),
        size: 1,
      }),
    )

    const logs = []
    const logger = {
      info(message, detail) {
        logs.push({ message, detail })
      },
      warn() {},
      error() {},
    }
    const config = {
      ...parseTeamConfig({
        TRELLIS_BOARD_MODE: 'team',
        TRELLIS_BOARD_BASE_PATH: '/weint-spec-board',
        TRELLIS_BOARD_TRUST_PROXY: 'true',
      }),
      bindHost: '127.0.0.1',
      port: 0,
    }
    runtime = await createTeamRuntime({
      config,
      databaseFile: path.join(dataDir, 'board.sqlite'),
      dataDir,
      clientUpdatesDir,
      publicDir,
      logger,
      requireAdmin: true,
      enablePolling: false,
    })
    await runtime.start()

    assert.equal(
      logs.some(
        (entry) =>
          entry.message === 'Trellis Team Board 已启动' &&
          entry.detail?.basePath === '/weint-spec-board' &&
          String(entry.detail?.url || '').endsWith('/weint-spec-board'),
      ),
      true,
    )

    // 无尾斜杠入口跳转
    const bare = await request(runtime, '/weint-spec-board?view=team')
    assert.equal(bare.status, 302)
    assert.equal(bare.headers.location, '/weint-spec-board/?view=team')

    // 透传前缀 & 剥离前缀双模式静态页面与资源
    for (const htmlPath of [
      '/weint-spec-board/',
      '/weint-spec-board/login.html',
      '/weint-spec-board/admin.html',
      '/',
      '/login.html',
    ]) {
      const page = await request(runtime, htmlPath)
      assert.equal(page.status, 200, htmlPath)
      assert.match(page.text, /<meta name="trellis-base-path" content="\/weint-spec-board" \/>/)
      assert.match(page.text, /href="\/weint-spec-board\/favicon\.svg"/)
      assert.match(page.text, /src="\/weint-spec-board\/theme-init\.js"/)
      assert.equal(page.headers['content-length'], String(page.raw.length))
      assert.match(String(page.headers['content-security-policy']), /base-uri 'none'/)
    }

    const headPage = await request(runtime, '/weint-spec-board/', { method: 'HEAD' })
    assert.equal(headPage.status, 200)
    assert.equal(headPage.raw.length, 0)
    assert.ok(Number(headPage.headers['content-length']) > 0)

    // 兄弟路径不误匹配
    assert.equal((await request(runtime, '/weint-spec-board-other/')).status, 404)

    // 透传前缀与剥离前缀 API / 更新端点
    assert.equal((await request(runtime, '/weint-spec-board/api/health')).status, 200)
    assert.equal((await request(runtime, '/api/health')).status, 200)
    assert.equal((await request(runtime, '/weint-spec-board/assets/main.js')).status, 200)
    assert.equal(
      (await request(runtime, '/weint-spec-board/client-updates/latest.json')).status,
      200,
    )
    assert.equal((await request(runtime, '/client-updates/latest.json')).status, 200)

    // 登录与退出 Cookie Path=/weint-spec-board
    const loginRes = await request(runtime, '/weint-spec-board/api/auth/login', {
      method: 'POST',
      body: { username: DEFAULT_INITIAL_ADMIN_USERNAME, password: DEFAULT_INITIAL_ADMIN_PASSWORD },
    })
    assert.equal(loginRes.status, 200)
    const setCookieHeader = (loginRes.headers['set-cookie'] || [])[0]
    assert.equal(parseSetCookie(setCookieHeader).get('Path'), '/weint-spec-board')
    const sessionCookiePair = String(setCookieHeader).split(';')[0]

    const logoutRes = await request(runtime, '/weint-spec-board/api/auth/logout', {
      method: 'POST',
      cookie: sessionCookiePair,
      body: {},
    })
    assert.equal(logoutRes.status, 200)
    const clearAttrs = parseSetCookie((logoutRes.headers['set-cookie'] || [])[0])
    assert.equal(clearAttrs.get('Path'), '/weint-spec-board')
    assert.equal(clearAttrs.get('Max-Age'), '0')

    // 归档附件 downloadUrl 带 /weint-spec-board 前缀
    const now = new Date().toISOString()
    const adminRow = runtime.db
      .prepare('SELECT id FROM user_account WHERE username_key = ?')
      .get('admin')
    runtime.db
      .prepare(
        'INSERT INTO team(id, name, slug, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run('t1', '研发一组', 't1', 'active', now, now)
    runtime.db
      .prepare(
        "INSERT INTO team_member(team_id, user_id, role, created_at, updated_at) VALUES (?, ?, 'admin', ?, ?)",
      )
      .run('t1', adminRow.id, now, now)
    runtime.db
      .prepare(
        `INSERT INTO sync_project(
          id, name, remote_url, remote_identity_hash, baseline_branch, owner_team_id,
          status, created_by_user_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
      )
      .run(
        'p1',
        'repo',
        'https://example.com/repo.git',
        'a'.repeat(64),
        'main',
        't1',
        adminRow.id,
        now,
        now,
      )
    runtime.db
      .prepare(
        `INSERT INTO sync_project_team_access(
          project_id, team_id, access_role, created_by_user_id, created_at
        ) VALUES (?, ?, 'owner', ?, ?)`,
      )
      .run('p1', 't1', adminRow.id, now)
    runtime.db
      .prepare(
        `INSERT INTO sync_task_space(
          id, project_id, branch_name, status, revision, indexed_revision,
          created_by_user_id, created_at, updated_at
        ) VALUES (?, ?, 'main', 'active', 0, 0, ?, ?, ?)`,
      )
      .run('space-1', 'p1', adminRow.id, now, now)

    const taskDir = '.trellis/tasks/archive/2026-11/11-24-demo'
    const staging = runtime.services.archiveSnapshots.createStaging('space-1', 'attempt-1')
    const files = [
      staging.writeBlob(
        { relativePath: `${taskDir}/task.json`, blobOid: 'a'.repeat(40) },
        Buffer.from(
          JSON.stringify({
            id: 'demo',
            title: '归档测试',
            description: '',
            status: 'completed',
            priority: 'P2',
            assignee: DEFAULT_INITIAL_ADMIN_USERNAME,
            creator: DEFAULT_INITIAL_ADMIN_USERNAME,
            branch: 'main',
          }),
        ),
      ),
      staging.writeBlob(
        { relativePath: `${taskDir}/shot.png`, blobOid: 'b'.repeat(40) },
        Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      ),
    ]
    const published = runtime.services.archiveSnapshots.publish({
      staging,
      head: 'c'.repeat(40),
      files,
    })
    const snapshotId = crypto.randomUUID()
    runtime.db
      .prepare(
        `INSERT INTO sync_archive_snapshot(
          id, task_space_id, source_head, status, storage_root,
          file_count, byte_count, manifest_sha256, published_at
        ) VALUES (?, 'space-1', ?, 'published', ?, ?, ?, ?, ?)`,
      )
      .run(
        snapshotId,
        published.sourceHead,
        published.storageRoot,
        published.fileCount,
        published.byteCount,
        published.manifestSha256,
        now,
      )
    const fileId = crypto.randomUUID()
    for (const file of published.files) {
      const id = file.relativePath.endsWith('shot.png') ? fileId : crypto.randomUUID()
      runtime.db
        .prepare(
          `INSERT INTO sync_archive_file(
            id, task_space_id, snapshot_id, relative_path, blob_oid, sha256, content_text,
            size_bytes, mime_type, storage_key, text_excerpt, task_id, task_dir, source_head, updated_at
          ) VALUES (?, 'space-1', ?, ?, ?, ?, '', ?, ?, ?, NULL, ?, ?, ?, ?)`,
        )
        .run(
          id,
          snapshotId,
          file.relativePath,
          file.blobOid,
          file.sha256,
          file.sizeBytes,
          file.mimeType,
          file.storageKey,
          file.relativePath.endsWith('/task.json') ? 'demo' : null,
          taskDir,
          published.sourceHead,
          now,
        )
    }
    published.release()
    runtime.db
      .prepare(
        'UPDATE sync_task_space SET archive_revision = 1, archive_snapshot_id = ?, archive_candidate_snapshot_id = NULL WHERE id = ?',
      )
      .run(snapshotId, 'space-1')
    await runtime.services.taskSpaceIndex.materializeNow('space-1', { source: 'archive' })

    const relogin = await request(runtime, '/weint-spec-board/api/auth/login', {
      method: 'POST',
      body: { username: DEFAULT_INITIAL_ADMIN_USERNAME, password: DEFAULT_INITIAL_ADMIN_PASSWORD },
    })
    assert.equal(relogin.status, 200)
    const cookie = String((relogin.headers['set-cookie'] || [])[0]).split(';')[0]
    const passwordRes = await request(runtime, '/weint-spec-board/api/auth/password', {
      method: 'POST',
      cookie,
      body: {
        currentPassword: DEFAULT_INITIAL_ADMIN_PASSWORD,
        newPassword: 'Admin-Password-2026!',
      },
    })
    assert.equal(passwordRes.status, 200)
    const taskKey = runtime.db
      .prepare('SELECT execution_task_key FROM sync_task_index WHERE task_space_id = ?')
      .get('space-1').execution_task_key
    const detail = await request(
      runtime,
      `/weint-spec-board/api/tasks/${encodeURIComponent(taskKey)}?taskSpaceId=space-1`,
      { cookie },
    )
    assert.equal(detail.status, 200)
    const shot = detail.body.task.files.find((item) => item.name === 'shot.png')
    assert.equal(
      shot.downloadUrl,
      `/weint-spec-board/api/archive-files/${encodeURIComponent(fileId)}?taskSpaceId=space-1`,
    )
    const download = await request(runtime, shot.downloadUrl, { cookie })
    assert.equal(download.status, 200)
    assert.deepEqual(download.raw, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  } finally {
    if (runtime) await runtime.stop()
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  }
})
