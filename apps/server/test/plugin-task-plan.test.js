import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHarness } from '../../../packages/test-support/plugin-runtime.js'
import { readExecutionMap } from '../execution-store.js'

function writeTask(workspace, relativeDir, task) {
  const dir = path.join(workspace.repositoryPath, '.trellis', 'tasks', relativeDir)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'task.json'), JSON.stringify(task, null, 2))
  return dir
}

test('task/setPlan 把截止日期写进看板执行表', async () => {
  const harness = await createHarness({ withRepository: true, start: false })
  try {
    writeTask(harness.workspace, '11-13-demo', { id: 'demo', title: '演示任务' })
    const result = harness.tasks.setPlan({
      repositoryId: 'repo',
      relativeDir: '11-13-demo',
      dueDate: '2026-11-20',
    })
    assert.equal(result.taskKey, 'repo::11-13-demo')
    assert.equal(result.executionTaskKey, 'repo::demo')
    assert.equal(result.dueDate, '2026-11-20')
    const plans = readExecutionMap(harness.db, ['repo::demo'])
    assert.equal(plans.get('repo::demo').dueDate, '2026-11-20')
  } finally {
    await harness.cleanup()
  }
})

test('task/setPlan 支持 taskKey 且可清空截止日期', async () => {
  const harness = await createHarness({ withRepository: true, start: false })
  try {
    writeTask(harness.workspace, '11-13-demo', { id: 'demo', title: '演示任务' })
    harness.tasks.setPlan({ taskKey: 'repo::11-13-demo', dueDate: '2026-11-20' })
    const cleared = harness.tasks.setPlan({ taskKey: 'repo::11-13-demo', dueDate: null })
    assert.equal(cleared.dueDate, null)
    assert.equal(readExecutionMap(harness.db, ['repo::demo']).get('repo::demo').dueDate, null)
  } finally {
    await harness.cleanup()
  }
})

test('task/setPlan 拒绝非法日期', async () => {
  const harness = await createHarness({ withRepository: true, start: false })
  try {
    writeTask(harness.workspace, '11-13-demo', { id: 'demo', title: '演示任务' })
    assert.throws(
      () => harness.tasks.setPlan({ taskKey: 'repo::11-13-demo', dueDate: '2026-02-30' }),
      /截止日期/,
    )
  } finally {
    await harness.cleanup()
  }
})

test('task/setPlan 任务不存在时报 404', async () => {
  const harness = await createHarness({ withRepository: true, start: false })
  try {
    assert.throws(
      () => harness.tasks.setPlan({ taskKey: 'repo::not-there', dueDate: '2026-11-20' }),
      (error) =>
        error.code === 1404 || error.httpStatus === 404 || /任务不存在/.test(error.message),
    )
  } finally {
    await harness.cleanup()
  }
})
