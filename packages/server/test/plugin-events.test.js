import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  createHarness,
  startHttpServer,
  waitFor,
} from '@trellis-board/test-support/plugin-runtime.js'
import { createTaskRepository } from '@trellis-board/test-support/task-repository.js'

const PLUGIN = {
  id: 'task-writer',
  module: './packages/test-support/fixtures/plugins/task-writer/index.js',
  enabled: true,
  config: {},
}

async function post(baseUrl, pathname, body) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}

test('task.create / assign / setStage 成功后的事件 payload 完整，失败不发事件', async () => {
  const repo = createTaskRepository()
  fs.mkdirSync(path.join(repo.repositoryPath, '.trellis', 'workspace', 'carol'), {
    recursive: true,
  })
  const harness = await createHarness({
    plugins: [PLUGIN],
    repositories: repo.repositories,
    hostVersion: '0.2.0',
  })
  const http = await startHttpServer(harness.runtime)
  try {
    const failed = await post(http.baseUrl, '/api/plugins/task-writer/create', {
      repositoryId: 'repo',
      title: '失败创建',
      description: '正文',
      assignee: 'nobody',
      priority: 'P2',
      slug: 'failed-create',
      taskType: 'simple',
      workType: 'backend',
    })
    assert.ok(failed.status >= 400, `失败创建应返回错误，实际 ${failed.status}`)
    assert.equal(await harness.store.getState('task-writer', 'last:task.created'), null)

    const created = await post(http.baseUrl, '/api/plugins/task-writer/create', {
      repositoryId: 'repo',
      title: '事件契约',
      description: '正文',
      assignee: 'bob',
      priority: 'P2',
      slug: 'event-contract',
      taskType: 'simple',
      workType: 'backend',
    })
    assert.equal(created.status, 200, JSON.stringify(created.body))
    const relativeDir = created.body.relativeDir
    assert.ok(
      await waitFor(() => harness.store.getState('task-writer', 'last:task.created') !== null),
    )
    const createdEvent = await harness.store.getState('task-writer', 'last:task.created')
    assert.equal(createdEvent.title, '事件契约')
    assert.equal(createdEvent.assignee, 'bob')
    assert.equal(createdEvent.priority, 'P2')
    assert.equal(createdEvent.repoPath, repo.repositoryPath)
    assert.match(createdEvent.taskKey, /^repo::/)

    const assigned = await post(http.baseUrl, '/api/plugins/task-writer/assign', {
      repositoryId: 'repo',
      relativeDir,
      assignee: 'carol',
    })
    assert.equal(assigned.status, 200, JSON.stringify(assigned.body))
    assert.ok(
      await waitFor(
        () => harness.store.getState('task-writer', 'last:task.assigned')?.assignee === 'carol',
      ),
    )
    const assignedEvent = await harness.store.getState('task-writer', 'last:task.assigned')
    assert.equal(assignedEvent.previousAssignee, 'bob')
    assert.equal(assignedEvent.title, '事件契约')
    assert.equal(assignedEvent.priority, 'P2')
    assert.equal(assignedEvent.repoPath, repo.repositoryPath)

    await post(http.baseUrl, '/api/plugins/task-writer/stage', {
      repositoryId: 'repo',
      relativeDir,
      stage: 'implement',
    })
    assert.ok(
      await waitFor(
        () =>
          harness.store.getState('task-writer', 'last:task.stage.changed')?.stage === 'implement',
      ),
    )
    const firstStage = await harness.store.getState('task-writer', 'last:task.stage.changed')
    assert.equal(firstStage.previousStage, null)

    await post(http.baseUrl, '/api/plugins/task-writer/stage', {
      repositoryId: 'repo',
      relativeDir,
      stage: 'check',
    })
    assert.ok(
      await waitFor(
        () => harness.store.getState('task-writer', 'last:task.stage.changed')?.stage === 'check',
      ),
    )
    const secondStage = await harness.store.getState('task-writer', 'last:task.stage.changed')
    assert.equal(secondStage.previousStage, 'implement')
  } finally {
    await http.close()
    await harness.cleanup()
    fs.rmSync(repo.root, { recursive: true, force: true })
  }
})

test('扫描发现派生阶段变化时发 task.stage.derived，payload 含前后阶段', async () => {
  const repo = createTaskRepository()
  const harness = await createHarness({
    plugins: [PLUGIN],
    repositories: repo.repositories,
    hostVersion: '0.2.0',
  })
  try {
    harness.runtime.publishScan(
      {
        tasks: [
          {
            taskKey: 'repo::x',
            projectId: 'repo',
            dirName: 'x',
            derivedStage: 'implement',
            meta: { agent: 'opencode' },
          },
        ],
      },
      {
        tasks: [
          {
            taskKey: 'repo::x',
            projectId: 'repo',
            dirName: 'x',
            derivedStage: 'spec',
            meta: { agent: 'opencode' },
          },
        ],
      },
      { durationMs: 5, repositoriesScanned: 1 },
      'watch',
    )
    assert.ok(
      await waitFor(
        () =>
          harness.store.getState('task-writer', 'last:task.stage.derived')?.derivedStage === 'spec',
      ),
    )
    const event = await harness.store.getState('task-writer', 'last:task.stage.derived')
    assert.equal(event.previousStage, 'implement')
    assert.equal(event.taskKey, 'repo::x')
  } finally {
    await harness.cleanup()
    fs.rmSync(repo.root, { recursive: true, force: true })
  }
})
