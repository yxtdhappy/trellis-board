import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createTeamRuntime } from '../team/http.js'

const PUBLIC_ORIGIN = 'http://127.0.0.1:4319'
const SILENT_LOGGER = { info() {}, warn() {}, error() {} }

function read(relativePath) {
  return fs.readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8')
}

function readTree(relativeDir) {
  const base = new URL(`../${relativeDir}/`, import.meta.url)
  return fs
    .readdirSync(base, { recursive: true })
    .filter((name) => name.endsWith('.js'))
    .map((name) => fs.readFileSync(new URL(name, base), 'utf8'))
    .join('\n')
}

test('Team runtime 只装配任务空间快照链路，不导入旧 Git 或实时覆盖层', () => {
  const http = read('team/http.js')
  const httpTree = `${http}\n${readTree('team/http')}`
  for (const legacy of [
    './git-manager.js',
    './git-credentials.js',
    './live-sync.js',
    './projects.js',
    './task-writes.js',
    './task-index.js',
  ]) {
    assert.equal(httpTree.includes(legacy), false, legacy)
  }
  for (const current of [
    './gitless-board-service.js',
    './task-space-service.js',
    './task-snapshot-service.js',
    './task-space-index.js',
    './task-command-service.js',
  ]) {
    assert.equal(http.includes(current), true, current)
  }
  assert.match(httpTree, /task-spaces\/preflight/)
  assert.equal(httpTree.includes('/detach$'), true)
  assert.equal(httpTree.includes('/listeners$'), true)
  assert.match(read('team/task-space/bindings.js'), /function detachAgent/)
  assert.match(read('team/task-space/bindings.js'), /function listenerDetails/)
  assert.doesNotMatch(httpTree, /\bspawn\s*\(|\bexecFile\s*\(/)
  const snapshotService = read('team/task-snapshot-service.js')
  assert.doesNotMatch(snapshotService, /from ['"]node:child_process['"]/)
  assert.doesNotMatch(snapshotService, /['"]\.\/(?:git-manager|git-credentials|live-sync)\.js['"]/)
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

function get(runtime, pathname) {
  const address = runtime.address()
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: address.port,
        path: pathname,
        method: 'GET',
        headers: { host: '127.0.0.1:4319' },
      },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }),
        )
      },
    )
    req.on('error', reject)
    req.end()
  })
}

test('团队模式静态资源能提供字体与外部主题脚本', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-team-static-'))
  const publicDir = path.join(root, 'public')
  const markerName = `custom-public-${process.pid}-${Date.now()}.txt`
  fs.mkdirSync(path.join(publicDir, 'assets'), { recursive: true })
  fs.writeFileSync(path.join(publicDir, 'index.html'), '<!doctype html><title>board</title>')
  fs.writeFileSync(path.join(publicDir, 'login.html'), '<!doctype html><title>login</title>')
  fs.writeFileSync(path.join(publicDir, 'admin.html'), '<!doctype html><title>admin</title>')
  fs.writeFileSync(path.join(publicDir, 'theme-init.js'), 'void 0;\n')
  fs.writeFileSync(path.join(publicDir, markerName), 'custom-public')
  fs.writeFileSync(
    path.join(publicDir, 'assets', 'inter-latin.woff2'),
    Buffer.from('wOF2', 'ascii'),
  )

  const runtime = await createTeamRuntime({
    config: testConfig(),
    databaseFile: path.join(root, 'data', 'board.sqlite'),
    dataDir: path.join(root, 'data'),
    publicDir,
    logger: SILENT_LOGGER,
    requireAdmin: false,
    enablePolling: false,
  })
  await runtime.start()
  t.after(async () => {
    await runtime.stop()
    fs.rmSync(root, { recursive: true, force: true })
  })

  const font = await get(runtime, '/assets/inter-latin.woff2')
  assert.equal(font.status, 200)
  assert.equal(font.headers['content-type'], 'font/woff2')
  assert.equal(font.body.toString('ascii'), 'wOF2')

  const script = await get(runtime, '/theme-init.js')
  assert.equal(script.status, 200)
  assert.match(String(script.headers['content-type']), /text\/javascript/)
  assert.match(String(script.headers['content-security-policy']), /script-src 'self'/)
  assert.match(
    String(script.headers['content-security-policy']),
    /connect-src 'self' ipc: http:\/\/ipc\.localhost/,
  )
  assert.match(
    String(script.headers['content-security-policy']),
    /frame-src 'self' http:\/\/127\.0\.0\.1:\*/,
  )

  const marker = await get(runtime, `/${markerName}`)
  assert.equal(marker.status, 200)
  assert.equal(marker.body.toString(), 'custom-public')

  for (const pathname of ['/', '/index.html', '/login.html', '/admin.html']) {
    assert.equal((await get(runtime, pathname)).status, 200)
  }

  const missing = await get(runtime, '/assets/missing.woff2')
  assert.equal(missing.status, 404)
  assert.deepEqual(JSON.parse(missing.body.toString()), {
    error: '静态资源不存在',
    code: 'NOT_FOUND',
  })
})

test('团队模式默认从 packages/server/public 提供静态资源', async (t) => {
  const publicDir = new URL('../public/', import.meta.url)
  const markerName = `default-public-${process.pid}-${Date.now()}.txt`
  const markerFile = new URL(markerName, publicDir)
  const createdPublicDir = !fs.existsSync(publicDir)
  fs.mkdirSync(publicDir, { recursive: true })
  fs.writeFileSync(markerFile, 'default-public')
  t.after(() => {
    fs.rmSync(markerFile, { force: true })
    if (createdPublicDir) fs.rmdirSync(publicDir)
  })

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-team-default-static-'))
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

  const response = await get(runtime, `/${markerName}`)
  assert.equal(response.status, 200)
  assert.equal(response.body.toString(), 'default-public')
})
