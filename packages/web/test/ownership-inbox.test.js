import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildOwnershipInboxQuery,
  defaultOwnershipBranch,
  mergeOwnershipInboxItems,
  normalizeOwnershipBranches,
  normalizeOwnershipInboxPage,
  ownershipAssignAvailability,
  ownershipAssignErrorMessage,
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
        taskSpaceId: 'space-main',
        title: '任务 A',
        reason: 'TASK_OWNERSHIP_REQUIRED',
        assigneeUserId: 'user-a',
        assigneeDevId: 'yuhaojie',
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
  assert.equal(first.items[0].taskSpaceId, 'space-main')
  assert.equal(first.items[0].assigneeUserId, 'user-a')
  assert.equal(first.items[0].assigneeDevId, 'yuhaojie')
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

test('待归属分支候选只保留有效任务空间并默认来源分支', () => {
  const branches = normalizeOwnershipBranches([
    { id: 'space-main', branchName: 'main', status: 'active' },
    { id: 'space-dev', branchName: 'dev', status: 'active' },
    { id: 'space-retired', branchName: 'old', status: 'disabled' },
    { id: 'space-main', branchName: 'main', status: 'active' },
    { id: '', branchName: 'broken', status: 'active' },
  ])
  assert.deepEqual(branches, [
    { taskSpaceId: 'space-main', branchName: 'main' },
    { taskSpaceId: 'space-dev', branchName: 'dev' },
  ])
  assert.deepEqual(defaultOwnershipBranch({ sourceBranches: ['dev'] }, branches), {
    taskSpaceId: 'space-dev',
    branchName: 'dev',
  })
  assert.deepEqual(defaultOwnershipBranch({ sourceBranches: ['unknown'] }, branches), {
    taskSpaceId: 'space-main',
    branchName: 'main',
  })
  assert.equal(defaultOwnershipBranch({ sourceBranches: [] }, []), null)
})

test('归属可用性只对负责人且本机可写关联开放', () => {
  const item = {
    projectId: 'p1',
    taskId: 'task-a',
    taskDir: '.trellis/tasks/task-a',
    taskSpaceId: 'space-main',
    assigneeUserId: 'user-a',
    sourceBranches: ['main'],
  }
  const taskSpaces = [
    { id: 'space-main', branchName: 'main', status: 'active' },
    { id: 'space-dev', branchName: 'dev', status: 'active' },
  ]
  const association = {
    status: 'approved',
    readOnly: false,
    detachPending: false,
    lastErrorCode: null,
  }
  const base = {
    item,
    currentUserId: 'user-a',
    isTauri: true,
    branches: normalizeOwnershipBranches(taskSpaces),
    association,
  }

  assert.equal(ownershipAssignAvailability(base).available, true)
  assert.deepEqual(ownershipAssignAvailability(base).branches, [
    { taskSpaceId: 'space-main', branchName: 'main' },
    { taskSpaceId: 'space-dev', branchName: 'dev' },
  ])
  assert.equal(
    ownershipAssignAvailability({ ...base, currentUserId: 'user-b' }).reason,
    '仅任务负责人可操作',
  )
  assert.equal(
    ownershipAssignAvailability({ ...base, item: { ...item, assigneeUserId: null } }).reason,
    '负责人未知，等待来源客户端重新同步',
  )
  assert.equal(
    ownershipAssignAvailability({ ...base, isTauri: false }).reason,
    '请在桌面客户端中操作',
  )
  assert.equal(
    ownershipAssignAvailability({ ...base, association: null }).reason,
    '请在本机关联该分支后操作',
  )
  assert.equal(
    ownershipAssignAvailability({
      ...base,
      association: { ...association, status: 'revoked' },
    }).reason,
    '当前本地关联已失效，请重新关联',
  )
  assert.equal(
    ownershipAssignAvailability({
      ...base,
      association: { ...association, detachPending: true },
    }).reason,
    '当前分支正在解绑，请稍后再试',
  )
  assert.equal(
    ownershipAssignAvailability({
      ...base,
      association: { ...association, readOnly: true },
    }).reason,
    '当前关联为只读，不能修改任务归属',
  )
  assert.equal(
    ownershipAssignAvailability({
      ...base,
      association: { ...association, lastErrorCode: 'BRANCH_MISMATCH' },
    }).reason,
    '当前 Git 分支与关联分支不一致，请切回绑定分支后重试',
  )
  assert.equal(
    ownershipAssignAvailability({ ...base, branches: [] }).reason,
    '当前项目没有可用的任务空间分支',
  )
})

test('归属错误映射为可操作提示', () => {
  assert.equal(
    ownershipAssignErrorMessage(new Error('任务归属决定包含无效的任务目录')),
    '本机没有该任务副本，请在负责人本机操作',
  )
  assert.equal(
    ownershipAssignErrorMessage(new Error('只能把任务归属到当前项目可见的有效分支')),
    '所选分支不属于当前项目的有效任务空间',
  )
  assert.equal(
    ownershipAssignErrorMessage('Error: 任务归属决定必须包含 1 到 200 个任务'),
    '任务归属决定必须包含 1 到 200 个任务',
  )
  assert.equal(
    ownershipAssignErrorMessage({ message: '任务归属决定包含无效的任务目录' }),
    '本机没有该任务副本，请在负责人本机操作',
  )
  assert.equal(ownershipAssignErrorMessage(null), '任务归属失败，请稍后重试')
})
