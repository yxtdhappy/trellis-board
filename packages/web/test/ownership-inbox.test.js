import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildOwnershipInboxQuery,
  mergeOwnershipInboxItems,
  normalizeOwnershipInboxPage,
  ownershipInboxItemKey,
  ownershipInboxReasonLabel,
  summarizeOwnershipInbox,
} from '../src/lib/ownership-inbox.js'
import { normalizeTeamProject } from '../src/lib/team-client.js'

test('项目级待归属数量只读取 ownershipInboxCount，并与本地待确认归属分离', () => {
  const projects = [
    { id: 'board', name: 'trellis-board', ownershipInboxCount: 2, ownershipPendingCount: 99 },
    { id: 'server', name: 'trellis-server', ownershipInboxCount: 3 },
    { id: 'empty', name: 'empty', ownershipInboxCount: 0, ownershipPendingCount: 8 },
  ]

  assert.deepEqual(summarizeOwnershipInbox(projects, 'all'), {
    count: 5,
    groups: [
      { projectId: 'board', projectName: 'trellis-board', count: 2 },
      { projectId: 'server', projectName: 'trellis-server', count: 3 },
    ],
  })
  assert.deepEqual(summarizeOwnershipInbox(projects, 'board'), {
    count: 2,
    groups: [{ projectId: 'board', projectName: 'trellis-board', count: 2 }],
  })
})

test('团队项目归一化保留项目级 inbox 数量', () => {
  assert.equal(normalizeTeamProject({ id: 'p1', ownershipInboxCount: 4 }).ownershipInboxCount, 4)
  assert.equal(normalizeTeamProject({ id: 'p2', ownership_inbox_count: 6 }).ownershipInboxCount, 6)
  assert.equal(normalizeTeamProject({ id: 'p3' }).ownershipInboxCount, 0)
})

test('inbox 响应只保留有界摘要并能稳定聚合分页', () => {
  const first = normalizeOwnershipInboxPage({
    items: [
      {
        projectId: 'p1',
        projectName: '项目一',
        taskId: 'task-a',
        taskDir: '.trellis/tasks/task-a',
        title: '任务 A',
        reason: 'TASK_OWNERSHIP_REQUIRED',
        sourceBranches: ['main', 'main'],
        sourceClients: [
          { displayName: '桌面端 A', username: 'a' },
          { displayName: '桌面端 A', username: 'a' },
        ],
        firstSeenAt: '2026-11-18T01:00:00.000Z',
        lastSeenAt: '2026-11-18T02:00:00.000Z',
      },
      { projectId: '', taskId: 'invalid' },
    ],
    total: 2,
    nextCursor: 'next',
  })
  assert.equal(first.items.length, 1)
  assert.deepEqual(first.items[0].sourceBranches, ['main'])
  assert.deepEqual(first.items[0].sourceClients, [{ displayName: '桌面端 A', username: 'a' }])
  assert.equal(first.nextCursor, 'next')

  const second = normalizeOwnershipInboxPage({
    items: [
      {
        projectId: 'p1',
        projectName: '项目一',
        taskId: 'task-a',
        taskDir: '.trellis/tasks/task-a',
        title: '任务 A 更新',
        reason: 'TASK_OWNERSHIP_REQUIRED',
        sourceBranches: ['main'],
        sourceClients: [],
        firstSeenAt: '2026-11-18T01:00:00.000Z',
        lastSeenAt: '2026-11-18T03:00:00.000Z',
      },
      {
        projectId: 'p2',
        projectName: '项目二',
        taskId: 'task-b',
        taskDir: '.trellis/tasks/task-b',
        title: '任务 B',
        reason: 'TASK_OWNERSHIP_REQUIRED',
        sourceBranches: ['feature/a'],
        sourceClients: [{ displayName: '桌面端 B', username: 'b' }],
        firstSeenAt: '2026-11-18T02:00:00.000Z',
        lastSeenAt: '2026-11-18T04:00:00.000Z',
      },
    ],
    total: 2,
  })
  const merged = mergeOwnershipInboxItems(first.items, second.items)
  assert.deepEqual(merged.map(ownershipInboxItemKey), ['p1::task-a', 'p2::task-b'])
  assert.equal(merged[0].title, '任务 A 更新')
})

test('inbox 查询只携带项目、团队和独立分页参数', () => {
  const query = new URLSearchParams(
    buildOwnershipInboxQuery({
      teamId: 'team-a',
      projectId: 'p1',
      limit: 500,
      cursor: 'next page',
    }),
  )
  assert.equal(query.get('teamId'), 'team-a')
  assert.equal(query.get('projectIds'), 'p1')
  assert.equal(query.get('limit'), '200')
  assert.equal(query.get('cursor'), 'next page')
  for (const key of ['q', 'branch', 'stage', 'assignee', 'taskSpaceId']) {
    assert.equal(query.get(key), null)
  }

  const all = new URLSearchParams(buildOwnershipInboxQuery({ teamId: 'all', projectId: 'all' }))
  assert.equal(all.get('teamId'), null)
  assert.equal(all.get('projectIds'), null)
  assert.equal(all.get('limit'), '50')
})

test('待归属原因提供可读文案并保留未知代码', () => {
  assert.equal(ownershipInboxReasonLabel('TASK_OWNERSHIP_REQUIRED'), '尚未确定分支归属')
  assert.equal(ownershipInboxReasonLabel('FUTURE_REASON'), 'FUTURE_REASON')
})
