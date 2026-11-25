import test from 'node:test'
import assert from 'node:assert/strict'
import { TASK_TYPES, TASK_TYPE_IDS, isTaskType, taskTypeLabel } from '../task-types.js'

test('任务复杂度枚举唯一且与 id 列表一致', () => {
  assert.deepEqual(TASK_TYPE_IDS, ['simple', 'complex', 'research'])
  assert.deepEqual(
    TASK_TYPES.map((item) => item.id),
    [...TASK_TYPE_IDS],
  )
  assert.equal(new Set(TASK_TYPE_IDS).size, TASK_TYPE_IDS.length)
})

test('isTaskType 与 taskTypeLabel 拒绝未知值', () => {
  assert.equal(isTaskType('simple'), true)
  assert.equal(isTaskType('complex'), true)
  assert.equal(isTaskType('research'), true)
  assert.equal(isTaskType('backend'), false)
  assert.equal(isTaskType(' simple '), true)
  assert.equal(isTaskType(null), false)
  assert.equal(taskTypeLabel('complex'), '复杂')
  assert.equal(taskTypeLabel('unknown'), '')
})
