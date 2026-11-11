import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { AGENT_PROTOCOL_VERSION } from '../server/team/sync-agent-service.js'
import { createUser } from '../server/team/auth.js'
import { createTeamRuntime } from '../server/team/http.js'
import { setUserTeams } from '../server/team/teams.js'
import { readWorkspaceTemplate } from '../server/team/workspace-templates.js'
import { buildZip } from './helpers/zip-builder.js'

const PUBLIC_ORIGIN = 'http://127.0.0.1:4317'
const HOST = '127.0.0.1:4317'
const SILENT_LOGGER = { info() {}, warn() {}, error() {} }
const PASSWORD = 'Template-Password-123'

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
    headers: extraHeaders = {},
    origin = PUBLIC_ORIGIN,
  } = {},
) {
  const address = runtime.address()
  const payload = body == null ? null : JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const headers = { host: HOST, ...extraHeaders }
    if (payload != null) {
      headers['content-type'] = 'application/json'
      headers['content-length'] = Buffer.byteLength(payload)
    }
    if (origin != null && method !== 'GET' && method !== 'HEAD') headers.origin = origin
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
          const contentType = String(response.headers['content-type'] || '')
          let json = null
          if (contentType.includes('application/json') && buffer.length) {
            try {
              json = JSON.parse(buffer.toString('utf8'))
            } catch {
              json = null
            }
          }
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: buffer,
            json,
          })
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

async function login(runtime, username) {
  return request(runtime, '/api/auth/login', {
    method: 'POST',
    body: { username, password: PASSWORD },
  })
}

async function makeUser(runtime, username, { systemAdmin = false, teams = [] } = {}) {
  const user = await createUser(runtime.db, {
    username,
    displayName: username,
    password: PASSWORD,
    systemAdmin,
    mustChangePassword: false,
  })
  if (teams.length) {
    setUserTeams(runtime.db, { userId: user.id, teams })
  }
  return user
}

function seedTeam(runtime, teamId, status = 'active') {
  const now = new Date().toISOString()
  runtime.db
    .prepare(`
    INSERT INTO team(id, name, slug, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `)
    .run(teamId, teamId, teamId, status, now, now)
}

async function withRuntime(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-template-'))
  const runtime = await createTeamRuntime({
    config: testConfig(),
    databaseFile: path.join(root, 'board.sqlite'),
    dataDir: root,
    logger: SILENT_LOGGER,
    requireAdmin: false,
    enablePolling: false,
  })
  try {
    await runtime.start()
    await callback(runtime)
  } finally {
    await runtime.stop()
    fs.rmSync(root, { recursive: true, force: true })
  }
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

test('团队成员通过会话下载模板，返回哈希、版本、ETag 与 304', async () => {
  await withRuntime(async (runtime) => {
    seedTeam(runtime, 't1')
    await makeUser(runtime, 'alice', { teams: [{ teamId: 't1', role: 'member' }] })
    const cookie = cookieOf(await login(runtime, 'alice'))

    const first = await request(runtime, '/api/teams/t1/workspace-template', { cookie })
    assert.equal(first.status, 200)
    assert.equal(first.headers['content-type'], 'application/zip')
    assert.match(
      first.headers['content-disposition'],
      /workspace-template-0\.6\.16-template-2\.zip/,
    )
    assert.match(first.headers['x-template-sha256'], /^[a-f0-9]{64}$/)
    assert.equal(first.headers['x-template-version'], '0.6.16-template-2')
    assert.equal(first.headers['x-template-sha256'], sha256(first.body))
    assert.equal(first.headers.etag, `"${sha256(first.body)}"`)
    assert.equal(first.headers['cache-control'], 'private, max-age=0, must-revalidate')

    const cached = await request(runtime, '/api/teams/t1/workspace-template', {
      cookie,
      headers: { 'if-none-match': first.headers.etag },
    })
    assert.equal(cached.status, 304)
    assert.equal(cached.body.length, 0)

    const head = await request(runtime, '/api/teams/t1/workspace-template', {
      method: 'HEAD',
      cookie,
    })
    assert.equal(head.status, 200)
    assert.equal(head.body.length, 0)
    assert.equal(head.headers['x-template-sha256'], first.headers['x-template-sha256'])

    const manifest = await request(runtime, '/api/teams/t1/workspace-template/manifest', { cookie })
    assert.equal(manifest.status, 200)
    assert.notEqual(manifest.headers.etag, first.headers.etag)
    assert.equal(manifest.headers['x-template-sha256'], first.headers['x-template-sha256'])

    const wrongResource = await request(runtime, '/api/teams/t1/workspace-template/manifest', {
      cookie,
      headers: { 'if-none-match': first.headers.etag },
    })
    assert.equal(wrongResource.status, 200)

    const weak = await request(runtime, '/api/teams/t1/workspace-template/manifest', {
      cookie,
      headers: { 'if-none-match': `W/${manifest.headers.etag}` },
    })
    assert.equal(weak.status, 304)

    const list = await request(runtime, '/api/teams/t1/workspace-template/manifest', {
      cookie,
      headers: { 'if-none-match': `"other", ${manifest.headers.etag}` },
    })
    assert.equal(list.status, 304)
  })
})

test('模板清单路由返回版本、默认/可选工具和文件哈希', async () => {
  await withRuntime(async (runtime) => {
    seedTeam(runtime, 't1')
    await makeUser(runtime, 'alice', { teams: [{ teamId: 't1', role: 'member' }] })
    const cookie = cookieOf(await login(runtime, 'alice'))
    const response = await request(runtime, '/api/teams/t1/workspace-template/manifest', { cookie })
    assert.equal(response.status, 200)
    assert.equal(response.json.version, '0.6.16-template-2')
    assert.equal(response.json.templateVersion, '0.6.16')
    assert.equal(response.json.projectVersion, '0.6.16')
    assert.deepEqual(response.json.defaultTools, ['.opencode', '.agents'])
    assert.deepEqual(response.json.tools, ['.opencode', '.agents', '.codex'])
    assert.match(response.json.sha256, /^[a-f0-9]{64}$/)
    assert.ok(response.json.fileCount > 100)
    assert.match(response.headers.etag, /^"[a-f0-9]{64}-manifest"$/)

    const cached = await request(runtime, '/api/teams/t1/workspace-template/manifest', {
      cookie,
      headers: { 'if-none-match': response.headers.etag },
    })
    assert.equal(cached.status, 304)
    assert.equal(cached.body.length, 0)

    const head = await request(runtime, '/api/teams/t1/workspace-template/manifest', {
      method: 'HEAD',
      cookie,
    })
    assert.equal(head.status, 200)
    assert.equal(head.body.length, 0)
    assert.equal(head.headers.etag, response.headers.etag)
  })
})

test('Agent Bearer 可下载其所属团队模板', async () => {
  await withRuntime(async (runtime) => {
    seedTeam(runtime, 't1')
    await makeUser(runtime, 'alice', { teams: [{ teamId: 't1', role: 'member' }] })
    const cookie = cookieOf(await login(runtime, 'alice'))
    const pairing = await request(runtime, '/api/team/pairing-codes', {
      method: 'POST',
      cookie,
      body: {},
    })
    assert.equal(pairing.status, 201)
    const enrolled = await request(runtime, '/api/agent/enroll', {
      method: 'POST',
      origin: null,
      body: {
        protocolVersion: AGENT_PROTOCOL_VERSION,
        agentVersion: '1.0.0',
        platform: 'win32',
        pairingCode: pairing.json.pairingCode,
        deviceName: '模板测试设备',
      },
    })
    assert.equal(enrolled.status, 201)
    const response = await request(runtime, '/api/teams/t1/workspace-template', {
      agentCredential: enrolled.json.credential,
    })
    assert.equal(response.status, 200)
    assert.equal(response.headers['x-template-version'], '0.6.16-template-2')
  })
})

test('非成员、停用团队和未登录请求被拒绝', async () => {
  await withRuntime(async (runtime) => {
    seedTeam(runtime, 't1')
    seedTeam(runtime, 'disabled', 'disabled')
    await makeUser(runtime, 'alice', { teams: [{ teamId: 't1', role: 'member' }] })
    await makeUser(runtime, 'bob', { teams: [{ teamId: 'disabled', role: 'member' }] })
    await makeUser(runtime, 'carol')

    const bobCookie = cookieOf(await login(runtime, 'bob'))
    const carolCookie = cookieOf(await login(runtime, 'carol'))
    assert.equal(
      (
        await request(runtime, '/api/teams/t1/workspace-template', {
          cookie: bobCookie,
        })
      ).status,
      403,
    )
    assert.equal(
      (
        await request(runtime, '/api/teams/t1/workspace-template/manifest', {
          cookie: bobCookie,
        })
      ).status,
      403,
    )
    assert.equal(
      (
        await request(runtime, '/api/teams/disabled/workspace-template', {
          cookie: bobCookie,
        })
      ).status,
      403,
    )
    const disabledMember = await request(runtime, '/api/teams/disabled/workspace-template', {
      cookie: bobCookie,
    })
    assert.match(disabledMember.json.error, /团队已停用/)
    const disabledNonMember = await request(runtime, '/api/teams/disabled/workspace-template', {
      cookie: carolCookie,
    })
    assert.equal(disabledNonMember.status, 403)
    assert.match(disabledNonMember.json.error, /无权下载/)
    assert.doesNotMatch(disabledNonMember.json.error, /团队已停用/)
    assert.equal(
      (
        await request(runtime, '/api/teams/missing/workspace-template', {
          cookie: bobCookie,
        })
      ).status,
      404,
    )
    assert.equal((await request(runtime, '/api/teams/t1/workspace-template')).status, 401)
    assert.equal((await request(runtime, '/api/teams/t1/workspace-template/manifest')).status, 401)
  })
})

test('系统管理员可跨团队下载，非成员团队仍可访问', async () => {
  await withRuntime(async (runtime) => {
    seedTeam(runtime, 't1')
    seedTeam(runtime, 't2')
    await makeUser(runtime, 'root', { systemAdmin: true })
    const cookie = cookieOf(await login(runtime, 'root'))
    for (const teamId of ['t1', 't2']) {
      const response = await request(runtime, `/api/teams/${teamId}/workspace-template`, { cookie })
      assert.equal(response.status, 200)
    }
  })
})

function writeTemplateFixture({ archiveFiles, mutateManifest } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-template-fixture-'))
  const entries = Object.entries(archiveFiles).map(([name, data]) => ({ name, data }))
  const archive = buildZip(entries)
  const files = {}
  for (const [name, data] of Object.entries(archiveFiles)) {
    files[name] = sha256(Buffer.from(data))
  }
  const manifest = {
    schemaVersion: 1,
    version: 'fixture-template-1',
    templateVersion: '0.6.16',
    projectVersion: '0.6.16',
    sha256: sha256(archive),
    bytes: archive.length,
    entryCount: entries.length,
    fileCount: Object.keys(files).length,
    defaultTools: ['.opencode'],
    tools: ['.opencode'],
    baseFiles: ['.trellis'],
    files,
  }
  mutateManifest?.(manifest)
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest))
  fs.writeFileSync(path.join(root, 'workspace-template.zip'), archive)
  return root
}

test('加载期逐文件校验归档：缺文件、多文件、哈希不符均拒绝', () => {
  const roots = []
  try {
    const validRoot = writeTemplateFixture({
      archiveFiles: { '.trellis/a.txt': 'a\n', '.opencode/x.md': 'x\n' },
    })
    roots.push(validRoot)
    const template = readWorkspaceTemplate({ rootDir: validRoot })
    assert.equal(template.manifest.fileCount, 2)
    assert.match(template.manifestEtag, /-manifest"$/)
    assert.notEqual(template.manifestEtag, template.etag)

    const missingRoot = writeTemplateFixture({
      archiveFiles: { '.trellis/a.txt': 'a\n', '.opencode/x.md': 'x\n' },
      mutateManifest(manifest) {
        manifest.files['.trellis/missing.txt'] = '0'.repeat(64)
        manifest.fileCount += 1
      },
    })
    roots.push(missingRoot)
    assert.throws(() => readWorkspaceTemplate({ rootDir: missingRoot }), /缺少清单文件/)

    const extraRoot = writeTemplateFixture({
      archiveFiles: {
        '.trellis/a.txt': 'a\n',
        '.opencode/x.md': 'x\n',
        '.opencode/extra.md': 'extra\n',
      },
      mutateManifest(manifest) {
        delete manifest.files['.opencode/extra.md']
        manifest.fileCount -= 1
      },
    })
    roots.push(extraRoot)
    assert.throws(() => readWorkspaceTemplate({ rootDir: extraRoot }), /清单外文件/)

    const mismatchRoot = writeTemplateFixture({
      archiveFiles: { '.trellis/a.txt': 'a\n', '.opencode/x.md': 'x\n' },
      mutateManifest(manifest) {
        manifest.files['.trellis/a.txt'] = 'f'.repeat(64)
      },
    })
    roots.push(mismatchRoot)
    assert.throws(() => readWorkspaceTemplate({ rootDir: mismatchRoot }), /文件哈希与清单不一致/)
  } finally {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true })
  }
})

test('加载期拒绝未知 schemaVersion', () => {
  const root = writeTemplateFixture({
    archiveFiles: { '.trellis/a.txt': 'a\n', '.opencode/x.md': 'x\n' },
    mutateManifest(manifest) {
      manifest.schemaVersion = 2
    },
  })
  try {
    assert.throws(() => readWorkspaceTemplate({ rootDir: root }), /schemaVersion 不受支持/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
