import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BUILTIN_VIEWS,
  dueDateDistance,
  laneForStageIndex,
  normalizeTagsInput,
  taskMatchesFilter,
  taskMatchesView,
} from '../web/src/lib/execution-filter.js'

const NOW = new Date('2026-10-30T09:00:00.000Z')

function task(overrides = {}) {
  const { execution: executionOverride, ...taskOverrides } = overrides
  return {
    taskKey: 'demo::task',
    priority: 'P1',
    derivedStage: 'implement',
    archived: false,
    ...taskOverrides,
    execution: {
      dueDate: '2026-11-02',
      tags: ['后端', 'SQLite'],
      lastActivityAt: '2026-10-20T00:00:00.000Z',
      historyStatus: 'tracking',
      attentionReasons: ['due_soon', 'priority', 'stale', 'implementing'],
      ...executionOverride,
    },
  }
}

test('标签输入去空白、忽略大小写去重并限制数量和长度', () => {
  assert.deepEqual(normalizeTagsInput('UX, ux, 后端'), ['UX', '后端'])
  assert.throws(() => normalizeTagsInput(['有效', ''], { rejectEmpty: true }), /不能为空/)
  assert.throws(() => normalizeTagsInput('x'.repeat(33)), /32/)
  assert.throws(
    () => normalizeTagsInput(Array.from({ length: 11 }, (_, index) => `tag-${index}`)),
    /最多 10 个/,
  )
})

test('检查阶段及后续阶段进入检查/收尾分栏', () => {
  const task = { archived: false }
  assert.equal(laneForStageIndex(task, 0), 'planning')
  assert.equal(laneForStageIndex(task, 5), 'review')
  assert.equal(laneForStageIndex(task, 6), 'implementation')
  assert.equal(laneForStageIndex(task, 7), 'verification')
  assert.equal(laneForStageIndex(task, 12), 'verification')
  assert.equal(laneForStageIndex({ archived: true }, 7), null)
  assert.equal(laneForStageIndex(task, -1), null)
})

test('组合筛选按 AND 匹配，标签组内命中任意标签即可', () => {
  const filter = {
    priorities: ['P1'],
    stages: ['implement'],
    tags: ['sqlite'],
    dueWithinDays: 3,
    staleDays: 5,
  }
  assert.equal(taskMatchesFilter(task(), filter, NOW), true)
  assert.equal(taskMatchesFilter(task({ priority: 'P2' }), filter, NOW), false)
  assert.equal(
    taskMatchesFilter(
      task({
        execution: { tags: ['其他'] },
      }),
      filter,
      NOW,
    ),
    false,
  )
})

test('临近截止包含逾期，停滞筛选要求存在追踪事件', () => {
  assert.equal(dueDateDistance('2026-10-29', NOW), -1)
  assert.equal(
    taskMatchesFilter(
      task({
        execution: { dueDate: '2026-10-29' },
      }),
      { dueWithinDays: 3 },
      NOW,
    ),
    true,
  )
  assert.equal(
    taskMatchesFilter(
      task({
        execution: { historyStatus: 'missing', lastActivityAt: null },
      }),
      { staleDays: 1 },
      NOW,
    ),
    false,
  )
})

test('阻断筛选区分 blocked 与 unblocked，旧视图缺失字段按 any 处理', () => {
  const blocked = task({
    execution: {
      isBlocked: true,
      isUnblockedReady: false,
    },
  })
  const unblocked = task({
    execution: {
      isBlocked: false,
      isUnblockedReady: true,
    },
  })
  assert.equal(taskMatchesFilter(blocked, { blocked: 'blocked' }, NOW), true)
  assert.equal(taskMatchesFilter(unblocked, { blocked: 'blocked' }, NOW), false)
  assert.equal(taskMatchesFilter(unblocked, { blocked: 'unblocked' }, NOW), true)
  assert.equal(
    taskMatchesFilter(
      { ...blocked, execution: { tags: ['后端'] } },
      {
        blocked: 'any',
        tags: ['后端'],
      },
      NOW,
    ),
    true,
  )
  assert.equal(taskMatchesView(unblocked, { id: 'saved', filter: { tags: ['后端'] } }, NOW), true)
})

test('内置视图稳定返回今日焦点、P0/P1、截止、停滞和阶段匹配', () => {
  const tasks = [
    task(),
    task({
      priority: 'P2',
      derivedStage: 'check',
      execution: {
        dueDate: null,
        tags: [],
        lastActivityAt: NOW.toISOString(),
        historyStatus: 'tracking',
        attentionReasons: ['checking'],
      },
    }),
  ]
  const matchesBuiltin = (id) => {
    const view = BUILTIN_VIEWS.find((candidate) => candidate.id === id)
    return tasks.filter((item) => taskMatchesView(item, view, NOW)).length
  }
  assert.equal(matchesBuiltin('today'), 2)
  assert.equal(matchesBuiltin('priority'), 1)
  assert.equal(matchesBuiltin('due-soon'), 1)
  assert.equal(matchesBuiltin('stale'), 1)
  assert.equal(matchesBuiltin('checking'), 1)
  assert.equal(matchesBuiltin('blocked'), 0)
  assert.equal(matchesBuiltin('unblocked-ready'), 0)
  assert.equal(taskMatchesView(tasks[0], { id: 'saved', filter: { tags: ['后端'] } }, NOW), true)
})
