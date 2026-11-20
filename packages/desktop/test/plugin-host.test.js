import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const desktopDir = path.resolve(testDir, '..')
const repoRoot = path.resolve(testDir, '..', '..', '..')
const hostPath = path.join(desktopDir, 'plugin-host', 'host.mjs')
const token = 'test-token'
const secret = 'test-secret'

function waitForReady(child, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`本机插件宿主启动超时：${buffer}`))
    }, timeoutMs)
    const onData = (chunk) => {
      buffer += chunk.toString()
      for (const line of buffer.split(/\r?\n/)) {
        if (!line.trim()) continue
        try {
          const message = JSON.parse(line)
          if (message.event === 'ready') {
            cleanup()
            resolve(message)
            return
          }
        } catch {
          // 非 JSON 行是宿主日志，忽略。
        }
      }
    }
    const onExit = (code) => {
      cleanup()
      reject(new Error(`本机插件宿主提前退出（${code}）：${buffer}`))
    }
    const cleanup = () => {
      clearTimeout(timer)
      child.stdout.off('data', onData)
      child.off('exit', onExit)
    }
    child.stdout.on('data', onData)
    child.on('exit', onExit)
  })
}

async function request(base, pathname, options = {}) {
  const headers = { ...(options.headers || {}) }
  if (options.authorized !== false) headers.authorization = `Bearer ${token}`
  const response = await fetch(`${base}${pathname}`, {
    ...options,
    headers,
  })
  const text = await response.text()
  let data = null
  try {
    data = JSON.parse(text)
  } catch {
    data = null
  }
  return { status: response.status, text, data, contentType: response.headers.get('content-type') }
}

async function waitFor(check, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      return await check()
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
  }
  throw lastError || new Error('等待超时')
}

test('本机插件宿主：鉴权、面板重写、生命周期与仓库注入', async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'trellis-plugin-host-'))
  const pluginsDir = path.join(dataDir, 'plugins')
  await mkdir(pluginsDir, { recursive: true })
  await writeFile(
    path.join(pluginsDir, 'plugins.json'),
    JSON.stringify(
      {
        version: 1,
        plugins: [
          {
            id: 'accounts-core',
            module: path.join(repoRoot, 'plugins', 'accounts-core', 'index.js'),
            enabled: true,
            sort: 10,
          },
        ],
      },
      null,
      2,
    ),
  )

  const child = spawn(
    process.execPath,
    [
      hostPath,
      '--data-dir',
      dataDir,
      '--app-dir',
      repoRoot,
      '--plugins-dir',
      pluginsDir,
      '--host-version',
      '0.4.48',
      '--token',
      token,
      '--secret',
      secret,
      '--port',
      '0',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let stderr = ''
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString()
  })

  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGKILL')
    await rm(dataDir, { recursive: true, force: true })
  })

  const ready = await waitForReady(child)
  assert.ok(ready.port > 0)
  const base = `http://127.0.0.1:${ready.port}`

  const unauthorized = await request(base, '/internal/plugins', { authorized: false })
  assert.equal(unauthorized.status, 401)

  const list = await request(base, '/internal/plugins')
  assert.equal(list.status, 200)
  assert.ok(list.data.plugins.some((entry) => entry.id === 'accounts-core'))

  const panels = await waitFor(async () => {
    const response = await request(base, '/internal/panels')
    assert.equal(response.status, 200)
    const panel = response.data.panels.find((entry) => entry.pluginId === 'accounts-core')
    if (!panel) {
      const state = await request(base, '/internal/plugins')
      assert.fail(`账号插件面板尚未注册: ${JSON.stringify(state.data.plugins)} / ${stderr}`)
    }
    return panel
  })
  assert.match(panels.src, /^\/api\/plugins\/accounts-core\/panel/)

  const html = await waitFor(async () => {
    const response = await request(base, `/s/${secret}/accounts-core/panel`)
    assert.equal(response.status, 200)
    return response
  })
  assert.match(html.text, new RegExp(`/s/${secret}/accounts-core/panel/app\\.css`))
  assert.doesNotMatch(html.text, /\/api\/plugins\/accounts-core\//)

  const bridge = await request(base, '/plugin-ui/v1/bridge.js')
  assert.equal(bridge.status, 200)

  const wrongSecret = await request(base, '/s/wrong-secret/accounts-core/panel', {
    authorized: false,
  })
  assert.equal(wrongSecret.status, 401)
  const anonymousApi = await request(base, '/api/panels', { authorized: false })
  assert.equal(anonymousApi.status, 401)

  const empty = await request(base, '/internal/repositories')
  assert.equal(empty.status, 200)
  assert.deepEqual(empty.data.repositories, [])

  const injected = await request(base, '/internal/repositories', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      repositories: [{ id: 'remote-1', name: '示例仓库', path: '/tmp/repo', branchName: 'main' }],
    }),
  })
  assert.equal(injected.status, 200)
  const repositories = await request(base, '/internal/repositories')
  assert.deepEqual(repositories.data.repositories, [
    { id: 'remote-1', name: '示例仓库', path: '/tmp/repo', branchName: 'main' },
  ])

  const stopped = await request(base, '/internal/plugins/accounts-core/stop', { method: 'POST' })
  assert.equal(stopped.status, 200)
  const statusAfterStop = await waitFor(async () => {
    const response = await request(base, `/internal/plugins/accounts-core/logs?tail=10`)
    assert.equal(response.status, 200)
    const state = await request(base, '/internal/plugins')
    const plugin = state.data.plugins.find((entry) => entry.id === 'accounts-core')
    assert.notEqual(plugin.status, 'running')
    return plugin
  })
  assert.notEqual(statusAfterStop.status, 'running')

  const restarted = await request(base, '/internal/plugins/accounts-core/start', { method: 'POST' })
  assert.equal(restarted.status, 200)
  await waitFor(async () => {
    const state = await request(base, '/internal/plugins')
    const plugin = state.data.plugins.find((entry) => entry.id === 'accounts-core')
    assert.equal(plugin.status, 'running')
    return plugin
  })

  const shutdown = await request(base, '/internal/shutdown', { method: 'POST' })
  assert.equal(shutdown.status, 200)
  await new Promise((resolve) => {
    if (child.exitCode !== null) return resolve()
    child.once('exit', resolve)
  })
  assert.equal(stderr.includes('Unhandled'), false, stderr)
})

test('本机插件宿主：空清单可以就绪且不启动插件进程', async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'trellis-plugin-host-empty-'))
  const pluginsDir = path.join(dataDir, 'plugins')
  await mkdir(pluginsDir, { recursive: true })
  await writeFile(path.join(pluginsDir, 'plugins.json'), JSON.stringify({ version: 1, plugins: [] }))

  const child = spawn(
    process.execPath,
    [
      hostPath,
      '--data-dir',
      dataDir,
      '--app-dir',
      repoRoot,
      '--plugins-dir',
      pluginsDir,
      '--host-version',
      '0.4.48',
      '--token',
      token,
      '--secret',
      secret,
      '--port',
      '0',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGKILL')
    await rm(dataDir, { recursive: true, force: true })
  })

  const ready = await waitForReady(child)
  const base = `http://127.0.0.1:${ready.port}`
  const list = await request(base, '/internal/plugins')
  assert.equal(list.status, 200)
  assert.deepEqual(list.data.plugins, [])
  const panels = await request(base, '/internal/panels')
  assert.deepEqual(panels.data.panels, [])
  await request(base, '/internal/shutdown', { method: 'POST' })
  await new Promise((resolve) => {
    if (child.exitCode !== null) return resolve()
    child.once('exit', resolve)
  })
})

