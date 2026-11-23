import test from 'node:test'
import assert from 'node:assert/strict'
import {
  HANDOFF_NOTICE_DISMISSED_STORAGE_KEY,
  handoffNoticeKey,
  legacyHandoffNoticeKey,
  MAX_DISMISSED_NOTICES,
  normalizeDismissedNoticeIds,
  normalizeHandoffNotices,
  readDismissedNotices,
  visibleHandoffNotices,
  writeDismissedNotices,
} from '../src/lib/handoff-notice.js'

const CYCLE_A = '2026-11-19T08:00:00.000Z'
const CYCLE_B = '2026-11-20T01:57:03.950Z'

function notice(overrides = {}) {
  return {
    executionTaskKey: 'space-1::task-a',
    taskId: 'task-a',
    relativeDir: '.trellis/tasks/task-a',
    handoffState: 'source_cleanup_conflict',
    ackState: 'done',
    outcome: 'conflict',
    reason: 'git_modified',
    backupId: null,
    materializedAt: CYCLE_A,
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

test('归一化保留 materializedAt，缺失或空串回落为 null', () => {
  const notices = normalizeHandoffNotices([
    notice({ materializedAt: `  ${CYCLE_A}  ` }),
    notice({ executionTaskKey: 'space-1::task-b', materializedAt: '' }),
    {
      executionTaskKey: 'space-1::task-c',
      taskId: 'task-c',
      relativeDir: '.trellis/tasks/task-c',
      handoffState: 'source_cleanup_pending',
      ackState: 'pending',
      outcome: '',
    },
    { executionTaskKey: 'broken' },
    null,
  ])

  assert.equal(notices.length, 3)
  assert.equal(notices[0].materializedAt, CYCLE_A)
  assert.equal(notices[1].materializedAt, null)
  assert.equal(notices[2].materializedAt, null)
  assert.equal(notices[2].outcome, '')
  assert.deepEqual(normalizeHandoffNotices(null), [])
})

test('通知键包含物化轮次，旧客户端缺失时使用占位值', () => {
  assert.equal(legacyHandoffNoticeKey(notice()), 'space-1::task-a:source_cleanup_conflict:conflict')
  assert.equal(
    handoffNoticeKey(notice()),
    `space-1::task-a:source_cleanup_conflict:conflict:${CYCLE_A}`,
  )
  assert.equal(
    handoffNoticeKey(notice({ materializedAt: null })),
    'space-1::task-a:source_cleanup_conflict:conflict:-',
  )

  // 缺失轮次的同一记录必须保持同一关闭键，避免刷新后重新出现。
  const [legacy] = normalizeHandoffNotices([{ ...notice(), materializedAt: undefined }])
  assert.equal(handoffNoticeKey(legacy), 'space-1::task-a:source_cleanup_conflict:conflict:-')
})

test('同一任务再次委派后轮次变化，已关闭的旧轮次不再命中', () => {
  const dismissed = [handoffNoticeKey(notice())]

  assert.deepEqual(visibleHandoffNotices([notice()], dismissed), [])

  const nextCycle = notice({ materializedAt: CYCLE_B })
  assert.deepEqual(visibleHandoffNotices([nextCycle], dismissed), [nextCycle])
})

test('固定面板只展示未关闭的冲突和处理中项，保持原顺序', () => {
  const first = notice({ executionTaskKey: 'space-1::first' })
  const pending = notice({
    executionTaskKey: 'space-1::pending',
    handoffState: 'source_cleanup_pending',
    ackState: 'pending',
    outcome: '',
  })
  const cleaned = notice({ executionTaskKey: 'space-1::cleaned', outcome: 'cleaned' })

  const visible = visibleHandoffNotices(
    [first, pending, cleaned],
    new Set([handoffNoticeKey(first)]),
  )

  assert.deepEqual(
    visible.map((item) => item.executionTaskKey),
    ['space-1::pending'],
  )
  assert.deepEqual(visibleHandoffNotices(null, []), [])
})

test('关闭状态写入去重并限制上限，可再次读出', () => {
  const storage = memoryStorage()
  const ids = Array.from({ length: MAX_DISMISSED_NOTICES + 50 }, (_, index) => `key-${index}`)
  ids.push('key-1')

  assert.equal(writeDismissedNotices(storage, ids), true)
  const stored = readDismissedNotices(storage)

  assert.equal(stored.length, MAX_DISMISSED_NOTICES)
  assert.equal(new Set(stored).size, stored.length)
  assert.equal(stored[0], 'key-50')
  assert.equal(stored.at(-1), `key-${MAX_DISMISSED_NOTICES + 49}`)
  assert.ok(storage.values.has(HANDOFF_NOTICE_DISMISSED_STORAGE_KEY))
})

test('存储损坏或不可用时降级为空并静默失败', () => {
  const corrupted = memoryStorage({ [HANDOFF_NOTICE_DISMISSED_STORAGE_KEY]: '{oops' })
  const wrongShape = memoryStorage({ [HANDOFF_NOTICE_DISMISSED_STORAGE_KEY]: '{"a":1}' })
  assert.deepEqual(readDismissedNotices(corrupted), [])
  assert.deepEqual(readDismissedNotices(wrongShape), [])
  assert.deepEqual(readDismissedNotices(null), [])
  assert.deepEqual(readDismissedNotices({}), [])
  assert.equal(writeDismissedNotices(null, ['key']), false)

  const blocked = {
    getItem() {
      throw new Error('blocked')
    },
    setItem() {
      throw new Error('blocked')
    },
  }
  assert.deepEqual(readDismissedNotices(blocked), [])
  assert.equal(writeDismissedNotices(blocked, ['key']), false)
})

test('非字符串与重复的关闭标识被忽略', () => {
  assert.deepEqual(normalizeDismissedNoticeIds(['a', 'a', 1, null, ' ', 'b']), ['a', 'b'])
  assert.deepEqual(normalizeDismissedNoticeIds('not-a-list'), [])
})
