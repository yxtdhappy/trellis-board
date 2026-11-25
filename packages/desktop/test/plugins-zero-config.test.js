import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHarness, startHttpServer } from '@trellis-board/test-support/plugin-runtime.js'
import { createTaskRepository } from '@trellis-board/test-support/task-repository.js'

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = path.resolve(TEST_DIR, '..', '..', '..', 'plugins')
const moduleOf = (id) => path.join(PLUGIN_DIR, id, 'index.js')

function plugin(id, config = {}, extra = {}) {
  return { id, module: moduleOf(id), enabled: true, config, ...extra }
}

async function request(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method ?? 'GET',
    headers: options.body
      ? { 'content-type': 'application/json', ...options.headers }
      : options.headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  })
  const text = await response.text()
  return { status: response.status, json: text ? JSON.parse(text) : null }
}

test('a2a-intake 空配置自动签发本地 token 并保护 /a2a', async () => {
  const repo = createTaskRepository()
  fs.writeFileSync(path.join(repo.repositoryPath, '.trellis', '.developer'), 'bob\n')
  const harness = await createHarness({
    plugins: [plugin('a2a-intake', {})],
    repositories: repo.repositories,
    hostVersion: '0.4.48',
  })
  const http = await startHttpServer(harness.runtime)
  try {
    const config = await request(http.baseUrl, '/api/plugins/a2a-intake/config')
    assert.equal(config.status, 200, JSON.stringify(config.json))
    assert.ok(config.json.token.length >= 24)
    assert.equal(config.json.repositoryId, repo.repositories[0].id)

    const body = {
      jsonrpc: '2.0',
      id: 1,
      method: 'message/send',
      params: {
        message: {
          role: 'user',
          messageId: 'zero-config-1',
          parts: [
            {
              kind: 'text',
              text: JSON.stringify({ title: '零配置任务', workType: 'backend' }),
            },
          ],
        },
      },
    }
    const missing = await request(http.baseUrl, '/a2a', { method: 'POST', body })
    assert.equal(missing.status, 401)
    const wrong = await request(http.baseUrl, '/a2a', {
      method: 'POST',
      body,
      headers: { authorization: 'Bearer nope' },
    })
    assert.equal(wrong.status, 403)
    const accepted = await request(http.baseUrl, '/a2a', {
      method: 'POST',
      body,
      headers: { authorization: `Bearer ${config.json.token}` },
    })
    assert.equal(accepted.status, 200, JSON.stringify(accepted.json))
    assert.ok(accepted.json.result?.metadata?.trellisTaskKey)

    const again = await request(http.baseUrl, '/api/plugins/a2a-intake/config')
    assert.equal(again.json.token, config.json.token)
  } finally {
    await http.close()
    await harness.cleanup()
    fs.rmSync(repo.root, { recursive: true, force: true })
  }
})

test('scenario-copilot 空配置把项目目录作为工作区', async () => {
  const repo = createTaskRepository()
  const harness = await createHarness({
    plugins: [plugin('scenario-copilot', {})],
    repositories: repo.repositories,
    hostVersion: '0.4.48',
  })
  const http = await startHttpServer(harness.runtime)
  try {
    const defaults = await request(http.baseUrl, '/api/plugins/scenario-copilot/defaults')
    assert.equal(defaults.status, 200, JSON.stringify(defaults.json))
    assert.equal(defaults.json.workspace, repo.repositoryPath)
    assert.ok(
      defaults.json.outputRoot.startsWith(
        path.join(harness.workspace.dataDir, 'plugin-data', 'scenario-copilot'),
      ),
    )
  } finally {
    await http.close()
    await harness.cleanup()
    fs.rmSync(repo.root, { recursive: true, force: true })
  }
})

test('acp-dispatch 空命令时从 PATH 自动发现 Agent CLI', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX 可执行位断言只在非 Windows 上运行')
    return
  }
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-agent-bin-'))
  const command = path.join(bin, 'opencode')
  fs.writeFileSync(command, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  const originalPath = process.env.PATH
  process.env.PATH = `${bin}${path.delimiter}${originalPath}`
  const repo = createTaskRepository()
  const harness = await createHarness({
    plugins: [plugin('acp-dispatch', { agent: 'opencode', command: '' })],
    repositories: repo.repositories,
    hostVersion: '0.4.48',
  })
  const http = await startHttpServer(harness.runtime)
  try {
    const status = await request(http.baseUrl, '/api/plugins/acp-dispatch/status')
    assert.equal(status.status, 200, JSON.stringify(status.json))
    assert.equal(status.json.configured, true)
    assert.equal(status.json.command, command)
  } finally {
    process.env.PATH = originalPath
    await http.close()
    await harness.cleanup()
    fs.rmSync(repo.root, { recursive: true, force: true })
    fs.rmSync(bin, { recursive: true, force: true })
  }
})

test('六个内置插件以空 config 全部进入 running', async () => {
  const repo = createTaskRepository()
  const harness = await createHarness({
    plugins: [
      plugin('witops-core', {}),
      plugin('scenario-copilot', {}),
      plugin('jenkins-ops', {}),
      plugin('accounts-core', {}),
      plugin('acp-dispatch', {}),
      plugin('a2a-intake', {}),
    ],
    repositories: repo.repositories,
    hostVersion: '0.4.48',
  })
  try {
    const listed = harness.runtime.list()
    assert.equal(listed.plugins.length, 6)
    for (const item of listed.plugins) {
      assert.equal(item.status, 'running', `${item.id}: ${item.lastError || ''}`)
      assert.equal(item.compatible, true, item.id)
      assert.deepEqual(item.missingSecrets, [], item.id)
    }
  } finally {
    await harness.cleanup()
    fs.rmSync(repo.root, { recursive: true, force: true })
  }
})
