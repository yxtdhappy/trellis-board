import test from 'node:test'
import assert from 'node:assert/strict'

import { taskGroupInstanceKey, taskInstanceKey } from '../src/lib/task-view-key.js'

test('任务实例 key 在单机模式保持原 taskKey', () => {
  assert.equal(taskInstanceKey({ taskKey: 'repo::task' }), 'repo::task')
})

test('相同 taskKey 在不同 taskSpace 生成不同实例 key', () => {
  const main = { taskSpaceId: 'space-main', taskKey: 'repo::task' }
  const dev = { taskSpaceId: 'space-dev', taskKey: 'repo::task' }
  assert.notEqual(taskInstanceKey(main), taskInstanceKey(dev))
})

test('任务组 key 同时绑定 taskSpace 和 groupKey', () => {
  const main = {
    taskSpaceId: 'space-main',
    taskKey: 'repo::child',
    groupKey: 'repo::parent',
  }
  const dev = { ...main, taskSpaceId: 'space-dev' }
  assert.notEqual(taskGroupInstanceKey(main), taskGroupInstanceKey(dev))
  assert.match(taskGroupInstanceKey(main), /repo::parent$/)
})
