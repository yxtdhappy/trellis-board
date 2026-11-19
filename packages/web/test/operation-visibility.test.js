import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isActiveOperation,
  isDismissibleOperation,
  MAX_VISIBLE_OPERATIONS,
  normalizeDismissedOperationIds,
  operationDismissStorageKey,
  pruneDismissedOperationIds,
  readDismissedOperationIds,
  SUCCEEDED_VISIBLE_MS,
  visibleOperations,
  writeDismissedOperationIds,
} from '../src/lib/operation-visibility.js'

const NOW = Date.parse('2026-11-20T08:00:00.000Z')

function operation(overrides = {}) {
  return {
    id: 'op-1',
    status: 'failed',
    commandType: 'assign_task',
    taskKey: 'demo::task-a',
    raw: { updatedAt: new Date(NOW - 60_000).toISOString() },
    ...overrides,
  }
}

function memoryStorage(seed = {}) {
  const values = new Map(Object.entries(seed))
  return {
    values,
    getItem(key) {
      return values.has(key) ? values.get(key) : null
    },
    setItem(key, value) {
      values.set(key, value)
    },
  }
}

test('进行中操作即使被忽略也始终可见，且不提供忽略入口', () => {
  const operations = [
    operation({ id: 'op-pending', status: 'pending' }),
    operation({ id: 'op-delivered', status: 'delivered' }),
    operation({ id: 'op-running', status: 'running' }),
  ]
  const visible = visibleOperations(operations, {
    now: NOW,
    dismissedIds: ['op-pending', 'op-delivered', 'op-running'],
  })

  assert.deepEqual(
    visible.map((item) => item.id),
    ['op-pending', 'op-delivered', 'op-running'],
  )
  for (const item of operations) {
    assert.equal(isActiveOperation(item), true)
    assert.equal(isDismissibleOperation(item), false)
  }
})

test('失败与取消操作可忽略，忽略后从可见列表移除', () => {
  const operations = [
    operation({ id: 'op-failed', status: 'failed' }),
    operation({ id: 'op-cancelled', status: 'cancelled' }),
  ]

  assert.deepEqual(visibleOperations(operations, { now: NOW }), operations)
  assert.equal(isDismissibleOperation(operations[0]), true)
  assert.equal(isDismissibleOperation(operations[1]), true)
  assert.deepEqual(visibleOperations(operations, { now: NOW, dismissedIds: ['op-failed'] }), [
    operations[1],
  ])
})

test('成功操作保留十分钟后自动隐藏，忽略可提前隐藏', () => {
  const recent = operation({
    id: 'op-recent',
    status: 'succeeded',
    raw: { updatedAt: new Date(NOW - 5 * 60_000).toISOString() },
  })
  const stale = operation({
    id: 'op-stale',
    status: 'succeeded',
    raw: { updatedAt: new Date(NOW - SUCCEEDED_VISIBLE_MS - 60_000).toISOString() },
  })
  const unknownTime = operation({ id: 'op-unknown-time', status: 'succeeded', raw: {} })

  assert.deepEqual(
    visibleOperations([recent, stale, unknownTime], { now: NOW }).map((item) => item.id),
    ['op-recent'],
  )
  assert.deepEqual(
    visibleOperations([recent], { now: NOW, dismissedIds: ['op-recent'] }).map((item) => item.id),
    [],
  )
})

test('忽略记录不隐藏状态未知的操作', () => {
  const operations = [operation({ id: 'op-unknown', status: 'queued' })]

  assert.deepEqual(
    visibleOperations(operations, { now: NOW, dismissedIds: ['op-unknown'] }).map(
      (item) => item.id,
    ),
    ['op-unknown'],
  )
  assert.equal(isDismissibleOperation(operations[0]), false)
  assert.equal(isActiveOperation(operations[0]), false)
})

test('可见列表最多展示八条并保持原顺序', () => {
  const operations = Array.from({ length: MAX_VISIBLE_OPERATIONS + 2 }, (_, index) =>
    operation({ id: `op-${index}`, status: 'failed' }),
  )

  assert.deepEqual(
    visibleOperations(operations, { now: NOW }).map((item) => item.id),
    Array.from({ length: MAX_VISIBLE_OPERATIONS }, (_, index) => `op-${index}`),
  )
})

test('忽略记录按用户与 taskSpace 隔离，缺失时退化为固定值', () => {
  assert.notEqual(
    operationDismissStorageKey('alice', 'space-a'),
    operationDismissStorageKey('bob', 'space-a'),
  )
  assert.notEqual(
    operationDismissStorageKey('alice', 'space-a'),
    operationDismissStorageKey('alice', 'space-b'),
  )
  assert.equal(operationDismissStorageKey('', ''), operationDismissStorageKey(null, undefined))
  assert.match(operationDismissStorageKey('', ''), /anonymous/)
  assert.match(operationDismissStorageKey('', ''), /all$/)
})

test('读写忽略记录容忍存储缺失、内容损坏与写入异常', () => {
  const storage = memoryStorage()
  assert.equal(writeDismissedOperationIds(storage, 'key', ['op-1', 'op-1', '', null]), true)
  assert.deepEqual(readDismissedOperationIds(storage, 'key'), ['op-1'])

  const broken = memoryStorage({ key: '{not-json' })
  assert.deepEqual(readDismissedOperationIds(broken, 'key'), [])

  const throwing = {
    getItem() {
      throw new Error('blocked')
    },
    setItem() {
      throw new Error('quota')
    },
  }
  assert.deepEqual(readDismissedOperationIds(throwing, 'key'), [])
  assert.equal(writeDismissedOperationIds(throwing, 'key', ['op-1']), false)
  assert.equal(writeDismissedOperationIds(null, 'key', ['op-1']), false)
  assert.deepEqual(readDismissedOperationIds(undefined, 'key'), [])
})

test('清理已不在服务端列表中的忽略记录，保留仍在列表的 ID', () => {
  const operations = [
    operation({ id: 'op-active', status: 'pending' }),
    operation({ id: 'op-failed', status: 'failed' }),
  ]

  assert.deepEqual(pruneDismissedOperationIds(['op-active', 'op-failed', 'op-gone'], operations), [
    'op-active',
    'op-failed',
  ])
  assert.deepEqual(normalizeDismissedOperationIds(['op-1', 42, 'op-1', '  ']), ['op-1'])
})
