import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { resolveClientUpdatesDir } from '../config.js'
import { createTeamRuntime } from '../team/http.js'

const SILENT_LOGGER = { info() {}, warn() {}, error() {} }

function testConfig() {
  return {
    mode: 'team',
    bindHost: '127.0.0.1',
    port: 0,
    sessionTtlMs: 12 * 60 * 60 * 1000,
    agentStaleMs: 60_000,
    trustProxy: false,
    allowLocalGitRemotes: false,
    pluginsDisabled: true,
    pluginAllowlist: [],
  }
}

function sendRequest(runtime, pathname, { method = 'GET' } = {}) {
  const address = runtime.address()
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: address.port,
        path: pathname,
        method,
        headers: { host: `127.0.0.1:${address.port}` },
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          })
        })
      },
    )
    req.on('error', reject)
    req.end()
  })
}

test('resolveClientUpdatesDir defaults to <dataDir>/client-updates and honors TRELLIS_CLIENT_UPDATES_DIR', () => {
  const defaultDir = resolveClientUpdatesDir({
    platform: 'linux',
    env: { TRELLIS_BOARD_DATA_DIR: '/var/lib/trellis-board' },
  })
  assert.equal(defaultDir, '/var/lib/trellis-board/client-updates')

  const overridden = resolveClientUpdatesDir({
    platform: 'linux',
    env: {
      TRELLIS_BOARD_DATA_DIR: '/var/lib/trellis-board',
      TRELLIS_CLIENT_UPDATES_DIR: '/srv/client-releases',
    },
  })
  assert.equal(overridden, '/srv/client-releases')
})

test('team server hosts /client-updates/latest.json and .zip without auth and enforces path safety', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-client-updates-'))
  const dataDir = path.join(root, 'server')
  const updatesDir = path.join(dataDir, 'client-updates')
  const outsideSecret = path.join(root, 'secret.zip')
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(outsideSecret, 'secret-payload')

  const runtime = await createTeamRuntime({
    config: testConfig(),
    databaseFile: path.join(dataDir, 'board.sqlite'),
    dataDir,
    publicDir: path.join(root, 'public'),
    requireAdmin: false,
    enablePolling: false,
    logger: SILENT_LOGGER,
  })
  await runtime.start()

  try {
    // Missing directory returns 404 JSON
    const missingDirRes = await sendRequest(runtime, '/client-updates/latest.json')
    assert.equal(missingDirRes.status, 404)

    fs.mkdirSync(updatesDir, { recursive: true })
    const manifestJson = JSON.stringify({
      version: '0.4.59',
      file: 'TrellisBoard_0.4.59_x64-portable.zip',
      sha256: 'a'.repeat(64),
      size: 16,
      notes: 'test',
    })
    const zipBytes = Buffer.from('PK\x03\x04fake-zip-data')
    fs.writeFileSync(path.join(updatesDir, 'latest.json'), manifestJson)
    fs.writeFileSync(path.join(updatesDir, 'TrellisBoard_0.4.59_x64-portable.zip'), zipBytes)
    fs.writeFileSync(path.join(updatesDir, 'notes.txt'), 'not allowed')
    fs.symlinkSync(outsideSecret, path.join(updatesDir, 'escape.zip'))

    // GET & HEAD latest.json
    const getManifest = await sendRequest(runtime, '/client-updates/latest.json')
    assert.equal(getManifest.status, 200)
    assert.equal(getManifest.headers['content-type'], 'application/json; charset=utf-8')
    assert.equal(getManifest.headers['cache-control'], 'no-store, no-cache, must-revalidate')
    assert.equal(getManifest.body.toString('utf8'), manifestJson)

    const headManifest = await sendRequest(runtime, '/client-updates/latest.json', {
      method: 'HEAD',
    })
    assert.equal(headManifest.status, 200)
    assert.equal(Number(headManifest.headers['content-length']), Buffer.byteLength(manifestJson))
    assert.equal(headManifest.body.length, 0)

    // GET & HEAD .zip
    const getZip = await sendRequest(
      runtime,
      '/client-updates/TrellisBoard_0.4.59_x64-portable.zip',
    )
    assert.equal(getZip.status, 200)
    assert.equal(getZip.headers['content-type'], 'application/zip')
    assert.equal(getZip.headers['cache-control'], 'public, max-age=86400')
    assert.equal(
      getZip.headers['content-disposition'],
      'attachment; filename="TrellisBoard_0.4.59_x64-portable.zip"',
    )
    assert.equal(Number(getZip.headers['content-length']), zipBytes.length)
    assert.deepEqual(getZip.body, zipBytes)

    // Unsupported method -> 405
    const postRes = await sendRequest(runtime, '/client-updates/latest.json', { method: 'POST' })
    assert.equal(postRes.status, 405)

    // Traversal / nested path / unsupported extension / symlink escape
    const traversal = await sendRequest(runtime, '/client-updates/%2e%2e%2fboard.sqlite')
    assert.equal(traversal.status, 400)

    const nested = await sendRequest(runtime, '/client-updates/sub/file.zip')
    assert.equal(nested.status, 400)

    const unsupported = await sendRequest(runtime, '/client-updates/notes.txt')
    assert.equal(unsupported.status, 404)

    const missingZip = await sendRequest(
      runtime,
      '/client-updates/TrellisBoard_9.9.9_x64-portable.zip',
    )
    assert.equal(missingZip.status, 404)

    const symlinkEscape = await sendRequest(runtime, '/client-updates/escape.zip')
    assert.equal(symlinkEscape.status, 403)
  } finally {
    await runtime.stop()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
