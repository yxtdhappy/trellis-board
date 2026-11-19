import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

// config.js 在 import 时求值 dataDir/pluginsDir，测试目录必须先于它生效。
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-standalone-'))
process.env.TRELLIS_BOARD_DATA_DIR = dataDir

const { startStandaloneServer, stopStandaloneServer } = await import('../index.js')
const { SERVER_VERSION } = await import('../standalone/http-io.js')

const logger = { log() {}, warn() {}, error() {} }

function request(base, pathname, init) {
  return fetch(`${base}${pathname}`, init)
}

test('独立服务器暴露健康检查、看板与错误响应', async (t) => {
  const runtime = await startStandaloneServer({
    standalonePort: 0,
    bindHost: '127.0.0.1',
    logger,
  })
  const base = `http://127.0.0.1:${runtime.address().port}`
  t.after(async () => {
    await stopStandaloneServer()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  const health = await request(base, '/api/health')
  assert.equal(health.status, 200)
  assert.deepEqual(await health.json(), {
    status: 'ok',
    processId: process.pid,
    version: SERVER_VERSION,
  })

  const repositories = await request(base, '/api/repositories')
  assert.equal(repositories.status, 200)
  assert.deepEqual(await repositories.json(), { repositories: [] })

  const unknown = await request(base, '/api/unknown')
  assert.equal(unknown.status, 404)
  assert.deepEqual(await unknown.json(), { error: '接口不存在' })

  const badBody = await request(base, '/api/repositories', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{',
  })
  assert.equal(badBody.status, 400)
  assert.deepEqual(await badBody.json(), { error: '请求体不是合法 JSON' })

  const started = await request(base, '/api/board/refresh/start', { method: 'POST' })
  assert.equal(started.status, 202)
  assert.equal((await started.json()).refreshRunning, true)

  const board = await request(base, '/api/board')
  assert.equal(board.status, 200)
  const payload = await board.json()
  assert.ok(Array.isArray(payload.projects))
  assert.ok(Array.isArray(payload.tasks))
  assert.equal(typeof payload.refreshRunning, 'boolean')

  const pluginUi = await request(base, '/plugin-ui/v1/ui.css')
  assert.equal(pluginUi.status, 200)
  assert.match(await pluginUi.text(), /\.tb-btn/)
})

test('重复关闭服务器是安全的', async () => {
  await stopStandaloneServer()
  await stopStandaloneServer()
})
