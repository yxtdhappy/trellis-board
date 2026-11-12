import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHarness, makeWorkspace, startHttpServer, waitFor } from '../../../packages/test-support/plugin-runtime.js'
import { createTaskRepository } from '../../../packages/test-support/task-repository.js'
import { publishRepositoryChange } from '../plugins/repository-events.js'

test('repository.added / removed 事件携带 repositoryId 与 name', () => {
  const events = []
  const runtime = { publish: (name, payload) => events.push({ name, payload }) }
  publishRepositoryChange(
    runtime,
    'add',
    [{ id: 'r1', name: '仓库一' }],
    () => '2026-11-05T00:00:00.000Z',
  )
  publishRepositoryChange(
    runtime,
    'remove',
    [{ id: 'r2', name: '仓库二' }],
    () => '2026-11-05T00:00:01.000Z',
  )
  assert.deepEqual(events, [
    {
      name: 'repository.added',
      payload: { repositoryId: 'r1', name: '仓库一', occurredAt: '2026-11-05T00:00:00.000Z' },
    },
    {
      name: 'repository.removed',
      payload: { repositoryId: 'r2', name: '仓库二', occurredAt: '2026-11-05T00:00:01.000Z' },
    },
  ])
})

test('setRepositories 原地更新，插件无需重启即可看到新仓库与事件', async () => {
  const repo = createTaskRepository()
  const second = makeWorkspace({ withRepository: true })
  const taskDir = path.join(second.repositoryPath, '.trellis', 'tasks', '11-04-second')
  fs.mkdirSync(taskDir, { recursive: true })
  fs.writeFileSync(
    path.join(taskDir, 'task.json'),
    JSON.stringify(
      { title: '第二个仓库的任务', status: 'planning', assignee: 'bob', priority: 'P2' },
      null,
      2,
    ),
  )

  const harness = await createHarness({
    plugins: [
      {
        id: 'echo',
        module: './packages/test-support/fixtures/plugins/echo/index.js',
        enabled: true,
        config: {},
      },
    ],
    repositories: repo.repositories,
    hostVersion: '0.2.0',
  })
  const http = await startHttpServer(harness.runtime)
  try {
    harness.runtime.setRepositories([
      ...repo.repositories,
      { id: 'repo2', name: 'Repo2', path: second.repositoryPath },
    ])
    harness.runtime.publish('repository.added', {
      repositoryId: 'repo2',
      name: 'Repo2',
      occurredAt: new Date().toISOString(),
    })

    assert.ok(
      await waitFor(
        () => harness.store.getState('echo', 'last:repository.added')?.repositoryId === 'repo2',
      ),
    )
    const listed = await fetch(`${http.baseUrl}/api/plugins/echo/tasks`).then((response) =>
      response.json(),
    )
    assert.ok(
      listed.tasks.some((task) => task.projectId === 'repo2'),
      JSON.stringify(listed),
    )
  } finally {
    await http.close()
    await harness.cleanup()
    fs.rmSync(repo.root, { recursive: true, force: true })
    fs.rmSync(second.root, { recursive: true, force: true })
  }
})
