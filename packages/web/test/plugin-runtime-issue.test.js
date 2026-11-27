import test from 'node:test'
import assert from 'node:assert/strict'

import {
  PYTHON_UNAVAILABLE,
  hasPythonUnavailable,
  pythonUnavailableToast,
} from '../src/features/plugins/runtime-issue.ts'

test('顶层 code 为 1011 时判定为 Python 不可用', () => {
  assert.equal(PYTHON_UNAVAILABLE, 1011)
  assert.equal(hasPythonUnavailable({ code: 1011 }), true)
  assert.equal(hasPythonUnavailable({ status: 'failed', reason: 'x', code: 1011 }), true)
})

test('批量结果里任意一项 code 为 1011 时判定为 Python 不可用', () => {
  assert.equal(hasPythonUnavailable({ results: [{ code: 1011 }] }), true)
  assert.equal(
    hasPythonUnavailable({ results: [{ status: 'ok' }, { status: 'failed', code: 1011 }] }),
    true,
  )
})

test('无关错误码与字符串形式的 1011 不算 Python 不可用', () => {
  assert.equal(hasPythonUnavailable({ code: 1012 }), false)
  assert.equal(hasPythonUnavailable({ code: '1011' }), false)
  assert.equal(hasPythonUnavailable({ reason: 'python 1011 不可用' }), false)
  assert.equal(hasPythonUnavailable({ results: [{ code: -32603 }, { status: 'ok' }] }), false)
  assert.equal(hasPythonUnavailable({ results: [] }), false)
})

test('非对象负载不会抛错且判定为无问题', () => {
  assert.equal(hasPythonUnavailable(null), false)
  assert.equal(hasPythonUnavailable(undefined), false)
  assert.equal(hasPythonUnavailable(1011), false)
  assert.equal(hasPythonUnavailable('1011'), false)
  assert.equal(hasPythonUnavailable([{ code: 1011 }]), false)
})

test('环境门提示文案固定且带可操作按钮', () => {
  assert.deepEqual(pythonUnavailableToast(), {
    id: 'python-unavailable',
    title: '本地 Python 运行环境不可用',
    description: '任务未下发。请先检查运行环境，完成后重新下发。',
    actionLabel: '检查运行环境',
  })
})
