import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  createHarness,
  fixtureModule,
  startHttpServer,
} from '@trellis-board/test-support/plugin-runtime.js'

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
    repositories: [
      { id: 'demo-repository', name: 'Demo Repository', path: '/tmp/demo-repository' },
    ],
  })
  const http = await startHttpServer(harness.runtime)
  try {
    const empty = await request(http.baseUrl, '/api/plugins/repo-consumer/list')
    assert.equal(empty.status, 200, JSON.stringify(empty.json))
    assert.deepEqual(
      empty.json.repositories.map((item) => item.id),
      ['demo-repository'],
    )

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
      ['demo-repository', 'added-repository'],
    )

    const project = await request(http.baseUrl, '/api/plugins/repo-consumer/project')
    assert.equal(project.status, 200, JSON.stringify(project.json))
    assert.equal(project.json.project.repositoryId, 'demo-repository')
    assert.equal(project.json.project.name, 'Demo Repository')

    const status = await request(http.baseUrl, '/api/plugins')
    const described = status.json.plugins.find((item) => item.id === 'repo-consumer')
    assert.equal(described.capabilityStatus[0].provider, 'core')
    assert.equal(described.capabilityStatus[0].available, true)
  } finally {
    await http.close()
    await harness.cleanup()
  }
})

test('宿主 trellis.projects.branches 返回本地分支与当前分支', async () => {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-branches-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoPath })
  execFileSync(
    'git',
    [
      '-c',
      'user.name=test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '--allow-empty',
      '-m',
      'init',
    ],
    { cwd: repoPath },
  )
  execFileSync('git', ['checkout', '-q', '-b', 'feature/a'], { cwd: repoPath })
  const harness = await createHarness({
    plugins: [plugin('repo-consumer')],
    repositories: [{ id: 'git-repository', name: 'Git Repository', path: repoPath }],
  })
  const http = await startHttpServer(harness.runtime)
  try {
    const response = await request(
      http.baseUrl,
      '/api/plugins/repo-consumer/branches?repositoryId=git-repository',
    )
    assert.equal(response.status, 200, JSON.stringify(response.json))
    assert.equal(response.json.repositoryId, 'git-repository')
    assert.equal(response.json.branch, 'feature/a')
    assert.deepEqual(response.json.branches, ['feature/a', 'main'])
  } finally {
    await http.close()
    await harness.cleanup()
    fs.rmSync(repoPath, { recursive: true, force: true })
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

test('宿主 trellis.user.current 暴露脱敏登录用户并校验 user:read 权限', async () => {
  const harness = await createHarness({
    plugins: [plugin('repo-consumer'), plugin('repo-reader-without-permission')],
    repositories: [],
    userProvider: () => ({
      userId: 'u-1',
      username: 'kanyifei',
      displayName: 'Kan Yifei',
      serverUrl: 'http://board.internal:4317',
      password: 'must-not-leak-password',
      sessionToken: 'must-not-leak-token',
    }),
  })
  const http = await startHttpServer(harness.runtime)
  try {
    const allowed = await request(http.baseUrl, '/api/plugins/repo-consumer/user')
    assert.equal(allowed.status, 200, JSON.stringify(allowed.json))
    assert.deepEqual(allowed.json, {
      user: {
        userId: 'u-1',
        username: 'kanyifei',
        displayName: 'Kan Yifei',
        serverUrl: 'http://board.internal:4317',
      },
    })

    const denied = await request(http.baseUrl, '/api/plugins/repo-reader-without-permission/user')
    assert.equal(denied.status, 403)
    assert.equal(denied.json.code, 1001)
  } finally {
    await http.close()
    await harness.cleanup()
  }
})

test('宿主 trellis.projects.developers 与 readDeveloper 精确解析 .trellis/.developer 的 name= 与 workspace', async () => {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-devs-'))
  fs.mkdirSync(path.join(repoPath, '.trellis', 'workspace', 'alice'), { recursive: true })
  fs.mkdirSync(path.join(repoPath, '.trellis', 'workspace', 'bob'), { recursive: true })
  fs.mkdirSync(path.join(repoPath, '.trellis', 'workspace', '.hidden'), { recursive: true })
  fs.writeFileSync(
    path.join(repoPath, '.trellis', '.developer'),
    'name=alice\ninitialized_at=2026-11-20T10:09:58.926484\n',
  )
  const harness = await createHarness({
    plugins: [plugin('repo-consumer')],
    repositories: [{ id: 'dev-repo', name: 'Dev Repo', path: repoPath }],
  })
  const http = await startHttpServer(harness.runtime)
  try {
    const project = await request(http.baseUrl, '/api/plugins/repo-consumer/project')
    // fixture 调用 repositoryId: 'demo-repository'，直接查 developers
    const devs = await request(
      http.baseUrl,
      '/api/plugins/repo-consumer/developers?repositoryId=dev-repo',
    )
    assert.equal(devs.status, 200, JSON.stringify(devs.json))
    assert.deepEqual(devs.json, {
      repositoryId: 'dev-repo',
      currentDeveloper: 'alice',
      developers: ['alice', 'bob'],
    })
    assert.equal(project.status, 200)
  } finally {
    await http.close()
    await harness.cleanup()
    fs.rmSync(repoPath, { recursive: true, force: true })
  }
})
