import test from 'node:test'
import assert from 'node:assert/strict'
import { formatArchiveTimestamp, sortArchivedTasks } from '../web/src/lib/archive-sort.js'

test('归档任务按真实归档时间倒序，完成日期不覆盖精确时间', () => {
  const tasks = [
    {
      taskKey: 'demo::earlier',
      title: '较早归档',
      completedAt: '2026-10-29',
      archivedAt: '2026-10-29T03:26:45.000Z',
    },
    {
      taskKey: 'demo::latest',
      title: '最新归档',
      completedAt: '2026-10-29',
      archivedAt: '2026-10-29T15:29:17.000Z',
    },
    {
      taskKey: 'demo::previous-day',
      title: '前一天归档',
      completedAt: '2026-10-28',
      archivedAt: '2026-10-28T23:59:59.000Z',
    },
    {
      taskKey: 'demo::cross-day',
      title: '完成日期早但刚归档',
      completedAt: '2026-10-28',
      archivedAt: '2026-10-29T12:03:00.000Z',
    },
  ]

  assert.deepEqual(
    sortArchivedTasks(tasks).map((task) => task.title),
    ['最新归档', '完成日期早但刚归档', '较早归档', '前一天归档'],
  )
})

test('归档列表显示归档时间到分钟，缺少时间时回退完成日期', () => {
  const withArchiveTime = formatArchiveTimestamp({
    completedAt: '2026-10-29',
    archivedAt: '2026-10-29T15:29:17.000Z',
  })
  assert.match(withArchiveTime, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  assert.equal(formatArchiveTimestamp({ completedAt: '2026-10-28' }), '2026-10-28')
  assert.equal(formatArchiveTimestamp({}), '未知')
})
