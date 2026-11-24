import test from 'node:test'
import assert from 'node:assert/strict'
import { WORK_TYPES, WORK_TYPE_IDS, isWorkType, workTypeLabel } from '../work-types.js'

test('任务类型枚举唯一且包含五个固定值', () => {
  assert.deepEqual([...WORK_TYPE_IDS], ['backend', 'frontend', 'fullstack', 'research', 'docs'])
  assert.equal(new Set(WORK_TYPE_IDS).size, WORK_TYPE_IDS.length)
  assert.equal(WORK_TYPES.length, WORK_TYPE_IDS.length)
  for (const id of WORK_TYPE_IDS) {
    assert.equal(isWorkType(id), true)
    assert.ok(workTypeLabel(id))
  }
})

test('任务类型拒绝空值、大小写差异与未知值', () => {
  assert.equal(isWorkType(''), false)
  assert.equal(isWorkType(null), false)
  assert.equal(isWorkType('Frontend'), false)
  assert.equal(isWorkType('backend '), true)
  assert.equal(isWorkType('test'), false)
  assert.equal(workTypeLabel('unknown'), '')
})
