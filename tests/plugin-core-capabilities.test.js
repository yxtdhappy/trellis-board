import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHarness, fixtureModule, startHttpServer } from './helpers/plugin-runtime.js'

function plugin(id) {
  return { id, module: fixtureModule(id), enabled: true }
}

async function request(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method ?? 'GET',
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  })
  return { status: response.status, json: await response.json() }
}

test('宿主 trellis.repositories 能力对声明依赖的插件可用且可写', async () => {
  const harness = await createHarness({
    plugins: [plugin('repo-consumer')],
    repositories: [],
  })
  const http = await startHttpServer(harness.runtime)
  try {
    const empty = await request(http.baseUrl, '/api/plugins/repo-consumer/list')
    assert.equal(empty.status, 200, JSON.stringify(empty.json))
    assert.deepEqual(empty.json.repositories, [])

    const repositoryPath = path.join(harness.workspace.root, 'added-repository')
    fs.mkdirSync(path.join(repositoryPath, '.trellis'), { recursive: true })
    const added = await request(http.baseUrl, '/api/plugins/repo-consumer/add', {
      method: 'POST',
      body: { path: repositoryPath, name: 'Added Repository' },
    })
    assert.equal(added.status, 200)
    assert.equal(added.json.added[0].id, 'added-repository')
    assert.equal(added.json.added[0].name, 'Added Repository')

    const listed = await request(http.baseUrl, '/api/plugins/repo-consumer/list')
    assert.equal(listed.status, 200)
    assert.deepEqual(
      listed.json.repositories.map((repository) => repository.id),
      ['added-repository'],
    )

    const status = await request(http.baseUrl, '/api/plugins')
    const described = status.json.plugins.find((item) => item.id === 'repo-consumer')
    assert.equal(described.capabilityStatus[0].provider, 'core')
    assert.equal(described.capabilityStatus[0].available, true)
  } finally {
    await http.close()
    await harness.cleanup()
  }
})

test('宿主能力仍按 manifest 权限拒绝未声明权限的调用', async () => {
  const harness = await createHarness({
    plugins: [plugin('repo-reader-without-permission')],
    repositories: [],
  })
  const http = await startHttpServer(harness.runtime)
  try {
    const response = await request(http.baseUrl, '/api/plugins/repo-reader-without-permission/list')
    assert.equal(response.status, 403)
    assert.equal(response.json.code, 1001)
  } finally {
    await http.close()
    await harness.cleanup()
  }
})

test('trellis.capabilities 可发现并代理调用其他插件的能力', async () => {
  const harness = await createHarness({
    plugins: [plugin('cap-provider'), plugin('cap-broker')],
    repositories: [],
  })
  const http = await startHttpServer(harness.runtime)
  try {
    const listed = await request(http.baseUrl, '/api/plugins/cap-broker/list')
    assert.equal(listed.status, 200, JSON.stringify(listed.json))
    const demo = listed.json.capabilities.find((item) => item.name === 'demo.echo')
    assert.ok(demo, '能力目录缺少 demo.echo')
    assert.equal(demo.provider, 'cap-provider')
    assert.equal(demo.available, true)

    const called = await request(http.baseUrl, '/api/plugins/cap-broker/call')
    assert.equal(called.status, 200, JSON.stringify(called.json))
    assert.deepEqual(called.json, { text: 'via-broker', caller: 'cap-broker' })

    const recursive = await request(http.baseUrl, '/api/plugins/cap-broker/recursive')
    assert.equal(recursive.status, 400)
    assert.equal(recursive.json.code, -32602)
  } finally {
    await http.close()
    await harness.cleanup()
  }
})
