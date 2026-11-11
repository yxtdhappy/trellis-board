import test from 'node:test'
import assert from 'node:assert/strict'

import { escapeHtml } from '../web/src/lib/dom.js'
import {
  archiveAssigneeOptions,
  assignmentActionState,
  assignableProjectMembers,
  canManageProject,
  canWriteProject,
  createIdempotencyKey,
  buildTaskQuery,
  normalizeAuditEvent,
  normalizeAssignments,
  normalizeBoardPage,
  normalizeOperation,
  normalizeRuntime,
  normalizeTaskPage,
  normalizeTeamTaskRow,
  normalizeTeamStatus,
  planEditingState,
  redactSensitiveDetail,
  safeReturnTo,
  shouldReloadTasks,
} from '../web/src/lib/team-client.js'

test('幂等键在没有 randomUUID 的 HTTP 页面仍可生成', () => {
  const fallback = createIdempotencyKey({})
  const random = createIdempotencyKey({
    getRandomValues(bytes) {
      return bytes.fill(7)
    },
  })
  assert.match(fallback, /^[A-Za-z0-9._:-]{8,200}$/)
  assert.equal(random, '07'.repeat(16))
})

test('escapeHtml 转义所有 HTML 上下文危险字符', () => {
  assert.equal(escapeHtml(`<a title="'">&</a>`), '&lt;a title=&quot;&#39;&quot;&gt;&amp;&lt;/a&gt;')
})

test('团队查询参数保留服务端筛选并限制页大小', () => {
  const query = new URLSearchParams(
    buildTaskQuery(
      {
        scope: 'mine',
        projectIds: ['p1', 'p2'],
        priorities: ['P0', 'P1'],
        stages: ['implement'],
        tags: ['后端'],
        q: ' 看板 ',
        blocked: 'blocked',
        archived: true,
      },
      { limit: 500, cursor: 'next token' },
    ),
  )
  assert.equal(query.get('scope'), 'mine')
  assert.equal(query.get('teamId'), null)
  assert.equal(query.get('projectIds'), 'p1,p2')
  assert.equal(query.get('priorities'), 'P0,P1')
  assert.equal(query.get('q'), '看板')
  assert.equal(query.get('limit'), '200')
  assert.equal(query.get('cursor'), 'next token')
  assert.equal(query.get('blocked'), 'blocked')
  assert.equal(query.get('archived'), '1')
  const scoped = new URLSearchParams(
    buildTaskQuery({
      teamId: 'team-a',
      projectId: 'p1',
    }),
  )
  assert.equal(scoped.get('teamId'), 'team-a')
  assert.equal(scoped.get('projectIds'), 'p1')
})

test('归档负责人选择在选项刷新时保持并继续查询该负责人', () => {
  assert.deepEqual(archiveAssigneeOptions(['alice', 'bob'], ''), [
    { value: '__all', label: '全部负责人' },
    { value: 'alice', label: 'alice' },
    { value: 'bob', label: 'bob' },
  ])
  assert.deepEqual(archiveAssigneeOptions(['alice', 'yhj', 'alice'], 'yhj'), [
    { value: '__all', label: '全部负责人' },
    { value: 'yhj', label: 'yhj' },
    { value: 'alice', label: 'alice' },
  ])
  assert.deepEqual(archiveAssigneeOptions([], 'yhj'), [
    { value: '__all', label: '全部负责人' },
    { value: 'yhj', label: 'yhj' },
  ])
  const query = new URLSearchParams(
    buildTaskQuery({
      assignee: 'yhj',
      archived: true,
    }),
  )
  assert.equal(query.get('assignee'), 'yhj')
  assert.equal(query.get('archived'), '1')
})

test('任务页兼容驼峰和下划线响应', () => {
  const page = normalizeTaskPage({
    rows: [
      {
        taskKey: 'a',
        relativeDir: '.trellis/tasks/11-08-project-onboarding-remote-info',
      },
      {
        taskKey: 'b',
        relative_dir: '.trellis/tasks/11-09-task-detail-request-storm',
        archived_at: '2026-11-09T08:00:00.000Z',
      },
    ],
    assignees: ['alice', 'bob'],
    next_cursor: 'c2',
    total_count: 12,
    query_revision: 7,
    query_day: '2026-11-03',
  })
  assert.equal(page.tasks[0].taskKey, 'a')
  assert.equal(page.tasks[0].dirName, '11-08-project-onboarding-remote-info')
  assert.equal(page.tasks[1].taskKey, 'b')
  assert.equal(page.tasks[1].dirName, '11-09-task-detail-request-storm')
  assert.equal(page.tasks[1].archivedAt, '2026-11-09T08:00:00.000Z')
  assert.deepEqual(page.assignees, ['alice', 'bob'])
  assert.equal(page.nextCursor, 'c2')
  assert.equal(page.total, 12)
  assert.equal(page.queryRevision, 7)
  assert.equal(page.queryDay, '2026-11-03')
})

test('仅 queryRevision、queryDay 或当前项目 boardVersion 变化时重载', () => {
  const base = {
    queryRevision: 1,
    queryDay: '2026-11-03',
    boardVersions: { p1: 3, p2: 8 },
  }
  assert.equal(shouldReloadTasks(base, { ...base }, 'p1'), false)
  assert.equal(shouldReloadTasks(base, { ...base, queryRevision: 2 }, 'p1'), true)
  assert.equal(shouldReloadTasks(base, { ...base, queryDay: '2026-11-04' }, 'p1'), true)
  assert.equal(shouldReloadTasks(base, { ...base, boardVersions: { p1: 4, p2: 8 } }, 'p1'), true)
  assert.equal(shouldReloadTasks(base, { ...base, boardVersions: { p1: 3, p2: 9 } }, 'p1'), false)
})

test('runtime 只在显式 team 模式启用团队界面', () => {
  const standalone = normalizeRuntime({ mode: 'standalone' })
  assert.equal(standalone.team, false)
  const team = normalizeRuntime({
    mode: 'team',
    user: {
      id: 'u1',
      display_name: '张三',
      system_admin: true,
    },
  })
  assert.equal(team.team, true)
  assert.equal(team.user.displayName, '张三')
  assert.equal(team.systemAdmin, true)
  const withTeams = normalizeRuntime({
    mode: 'team',
    teams: [{ id: 't1', name: '团队一', role: 'member' }],
  })
  assert.deepEqual(withTeams.teams, [
    { id: 't1', name: '团队一', role: 'member', status: 'active' },
  ])
})

test('项目写能力同时受角色和同步状态约束', () => {
  assert.equal(canWriteProject({ role: 'member', syncStatus: 'current' }), true)
  assert.equal(canWriteProject({ role: 'read_only', syncStatus: 'current' }), false)
  assert.equal(canWriteProject({ role: 'lead', syncStatus: 'needs_repair' }), false)
})

test('项目负责人或可管理任务空间具备项目管理能力', () => {
  assert.equal(canManageProject({ role: 'member', taskSpaces: [] }), false)
  assert.equal(canManageProject({ role: 'lead' }), true)
  assert.equal(canManageProject({ role: null, capabilities: { manageMembers: true } }), true)
  assert.equal(canManageProject({ role: null, taskSpaces: [{ canManage: true }] }), true)
})

test('团队负责人候选只包含 active 的 lead/member developer', () => {
  const members = assignableProjectMembers({
    members: [
      { user_id: 'u1', role: 'lead', status: 'active', trellis_dev_id: 'dev-lead' },
      { user_id: 'u2', role: 'member', status: 'active', trellis_dev_id: 'dev-member' },
      { user_id: 'u3', role: 'read_only', status: 'active', trellis_dev_id: 'dev-reader' },
      { user_id: 'u4', role: 'member', status: 'disabled', trellis_dev_id: 'dev-disabled' },
      { user_id: 'u5', role: 'member', status: 'active', trellis_dev_id: '' },
    ],
  })
  assert.deepEqual(
    members.map((member) => member.trellisDevId),
    ['dev-lead', 'dev-member'],
  )
})

test('归档任务禁用派发选择并阻止提交', () => {
  assert.deepEqual(assignmentActionState({ archived: false }, 'dev-a', ['dev-a']), {
    readOnly: false,
    canSubmit: true,
  })
  assert.deepEqual(assignmentActionState({ archived: true }, 'dev-a', ['dev-a']), {
    readOnly: true,
    canSubmit: false,
  })
  assert.deepEqual(assignmentActionState(null, 'dev-a', ['dev-a']), {
    readOnly: false,
    canSubmit: false,
  })
})

test('归档任务隐藏并阻止编辑计划字段', () => {
  assert.deepEqual(planEditingState({ archived: false }), {
    readOnly: false,
    canEdit: true,
  })
  assert.deepEqual(planEditingState({ archived: true }), {
    readOnly: true,
    canEdit: false,
  })
  assert.deepEqual(planEditingState(null), {
    readOnly: false,
    canEdit: false,
  })
})

test('assignment 兼容下划线响应并保留条件更新版本', () => {
  const rows = normalizeAssignments({
    assignments: [
      {
        execution_task_key: 'p1::task',
        assignment_version: 3,
        assignment_state: 'pending',
      },
    ],
  })
  assert.equal(rows[0].executionTaskKey, 'p1::task')
  assert.equal(rows[0].assignmentVersion, 3)
  assert.equal(rows[0].assignmentState, 'pending')
})

test('团队查询行统一下划线字段，保留执行键与版本', () => {
  const row = normalizeTeamTaskRow({
    task_key: 'p1::task',
    execution_task_key: 'exec-1',
    task_version: 7,
    assignment_version: 2,
    project_id: 'p1',
    project_name: '项目一',
    relative_dir: '.trellis/tasks/task',
    derived_stage: 'implement',
    assignee_dev_id: 'dev-a',
    attention_reasons: ['overdue'],
  })
  assert.equal(row.taskKey, 'p1::task')
  assert.equal(row.executionTaskKey, 'exec-1')
  assert.equal(row.taskVersion, 7)
  assert.equal(row.assignmentVersion, 2)
  assert.equal(row.derivedStage, 'implement')
  assert.equal(row.assignee, 'dev-a')
  assert.equal(row.dirName, 'task')
})

test('单项目 board 分页从 pagePayload 顶层读取游标与版本', () => {
  const page = normalizeBoardPage({
    board: { projects: [], tasks: [{ taskKey: 'p::one' }] },
    nextCursor: 'next-page',
    total: 220,
    queryRevision: 9,
    queryDay: '2026-11-03',
  })
  assert.equal(page.nextCursor, 'next-page')
  assert.equal(page.total, 220)
  assert.equal(page.queryRevision, 9)
  assert.equal(page.tasks[0].taskKey, 'p::one')
})

test('审计详情渲染前再次隐藏敏感键', () => {
  assert.deepEqual(
    redactSensitiveDetail({
      action: 'reset',
      temporaryPassword: 'secret',
      nested: { agentToken: 'secret', safe: 'visible' },
    }),
    {
      action: 'reset',
      temporaryPassword: '[已隐藏]',
      nested: { agentToken: '[已隐藏]', safe: 'visible' },
    },
  )
})

test('审计事件归一化后仍隐藏一次性凭证', () => {
  const event = normalizeAuditEvent({
    id: '7',
    action: 'user_created',
    detail: { temporary_password: 'secret', userId: 'u1' },
  })
  assert.equal(event.id, 7)
  assert.equal(event.detail.temporary_password, '[已隐藏]')
  assert.equal(event.detail.userId, 'u1')
})

test('团队状态读取 assignments.pending 并保留项目版本', () => {
  const status = normalizeTeamStatus({
    queryRevision: 4,
    assignments: { pending: 3 },
    projects: [{ id: 'p1', boardVersion: 'v1' }],
  })
  assert.equal(status.pendingAssignments, 3)
  assert.equal(status.boardVersions.p1, 'v1')
})

test('任务操作保留命令类型和任务空间', () => {
  const operation = normalizeOperation({
    id: 'op1',
    status: 'running',
    command_type: 'assign_task',
    task_space_id: 'space-1',
  })
  assert.equal(operation.commandType, 'assign_task')
  assert.equal(operation.taskSpaceId, 'space-1')
})

test('登录回跳只接受同源相对路径', () => {
  assert.equal(safeReturnTo('/admin.html?tab=projects'), '/admin.html?tab=projects')
  assert.equal(safeReturnTo('//example.com/steal'), '/')
  assert.equal(safeReturnTo('https://example.com/steal'), '/')
  assert.equal(safeReturnTo('/\\example.com'), '/')
  assert.equal(safeReturnTo('/login.html?returnTo=%2F'), '/')
})
