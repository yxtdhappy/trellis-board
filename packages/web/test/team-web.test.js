import test from 'node:test'
import assert from 'node:assert/strict'

import { escapeHtml } from '../src/lib/dom.js'
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
  normalizeTeamProject,
  normalizeTeamTaskRow,
  normalizeTeamStatus,
  planEditingState,
  pickProjectTrellisDevId,
  redactSensitiveDetail,
  safeReturnTo,
  shouldReloadTasks,
  taskCommandState,
  taskContentMaterialized,
  taskControlView,
  isActiveOperation,
} from '../src/lib/team-client.js'

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

test('pickProjectTrellisDevId 按远端身份匹配项目 dev id，未匹配时回落', () => {
  const projects = [
    { id: 'p1', remoteIdentityHash: 'hash-a', trellisDevId: 'flyfly6' },
    { id: 'p2', remoteIdentityHash: 'hash-b', trellisDevId: '   ' },
  ]
  assert.equal(pickProjectTrellisDevId(projects, 'hash-a', 'fenglei'), 'flyfly6')
  assert.equal(pickProjectTrellisDevId(projects, ' hash-a ', 'fenglei'), 'flyfly6')
  assert.equal(pickProjectTrellisDevId(projects, 'hash-b', 'fenglei'), 'fenglei')
  assert.equal(pickProjectTrellisDevId(projects, '', 'fenglei'), 'fenglei')
  assert.equal(pickProjectTrellisDevId(projects, 'hash-a', ''), 'flyfly6')
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
        branch: ' DEV ',
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
  assert.equal(query.get('branch'), 'DEV')
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
  const allProjects = new URLSearchParams(
    buildTaskQuery({
      projectId: 'all',
      taskSpaceId: 'all',
      branch: 'feature/dev',
    }),
  )
  assert.equal(allProjects.get('projectIds'), null)
  assert.equal(allProjects.get('taskSpaceId'), null)
  assert.equal(allProjects.get('branch'), 'feature/dev')
})

test('BoardFilters 的单数优先级和阶段映射到服务端查询参数', () => {
  const query = new URLSearchParams(
    buildTaskQuery({
      priority: 'P1',
      stage: 'implement',
    }),
  )
  assert.equal(query.get('priorities'), 'P1')
  assert.equal(query.get('stages'), 'implement')
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

test('任务空间监听聚合兼容驼峰和下划线字段', () => {
  const project = normalizeTeamProject({
    id: 'p1',
    taskSpaces: [
      {
        id: 'space-a',
        project_id: 'p1',
        branch_name: 'feature/listener',
        online_listener_count: 2,
        approved_binding_count: '3',
        listener_reported_binding_count: 3,
        listener_state: 'online',
        last_listener_at: '2026-11-13T08:00:00.000Z',
      },
    ],
  })
  assert.equal(project.taskSpaces[0].onlineListenerCount, 2)
  assert.equal(project.taskSpaces[0].approvedBindingCount, 3)
  assert.equal(project.taskSpaces[0].listenerReportedBindingCount, 3)
  assert.equal(project.taskSpaces[0].listenerState, 'online')
  assert.equal(project.taskSpaces[0].lastListenerAt, '2026-11-13T08:00:00.000Z')
})

test('创建和改派允许目标客户端离线，只拒绝停用或只读任务空间', () => {
  assert.deepEqual(taskCommandState({}, false), { canSubmit: true, reason: null })
  assert.deepEqual(taskCommandState({ id: 'legacy-server-space' }, true), {
    canSubmit: true,
    reason: null,
  })
  assert.deepEqual(taskCommandState({ listenerState: 'online', onlineListenerCount: 0 }, true), {
    canSubmit: true,
    reason: null,
  })
  for (const listenerState of ['inactive', 'unassociated']) {
    assert.deepEqual(taskCommandState({ listenerState, onlineListenerCount: 0 }, true), {
      canSubmit: true,
      reason: null,
    })
  }
  assert.deepEqual(
    taskCommandState({ listenerState: 'unknown_legacy', onlineListenerCount: 0 }, true),
    { canSubmit: true, reason: null },
  )
  assert.deepEqual(taskCommandState({ listenerState: 'disabled', onlineListenerCount: 1 }, true), {
    canSubmit: false,
    reason: '该分支任务空间已停用',
  })
  assert.deepEqual(taskCommandState({ status: 'active', readOnly: true }, true), {
    canSubmit: false,
    reason: '当前账号对该分支只有只读权限',
  })
  assert.equal(taskCommandState({ role: 'read_only' }, true).canSubmit, false)
})

test('任务控制状态覆盖待交付、租约、版本、迁移和 handoff', () => {
  const pending = taskControlView({
    materializationState: 'pending',
    taskVersion: 2,
    controlTaskVersion: 2,
  })
  assert.equal(pending.label, '等待客户端接管')
  assert.equal(pending.contentMaterialized, false)

  const claimed = taskControlView({
    materializationState: 'claimed',
    leaseStatus: 'expired',
    leaseExpiresAt: '2020-01-01T00:00:00.000Z',
  })
  assert.equal(claimed.state, 'lease_expired')
  assert.equal(claimed.label, '写入租约已过期')
  assert.equal(taskContentMaterialized({ materializationState: 'claimed' }), false)

  assert.equal(
    taskControlView({
      materializationState: 'materialized',
      taskVersion: 3,
      controlTaskVersion: 4,
    }).state,
    'version_stale',
  )
  assert.equal(
    taskControlView({
      materializationState: 'materialized',
      executionIdentityConflict: true,
    }).state,
    'migration_conflict',
  )
  assert.equal(
    taskControlView({
      materializationState: 'materialized',
      handoffState: 'source_cleanup_pending',
    }).label,
    '等待来源副本清理',
  )
  assert.equal(
    taskControlView({
      materializationState: 'materialized',
      handoffState: 'completed',
    }).label,
    '认领与清理已完成',
  )
  assert.equal(
    taskControlView({
      materializationState: 'pending',
      previousAssigneeUserId: 'user-old',
    }).state,
    'reassigned',
  )
  assert.equal(taskContentMaterialized({ materializationState: 'materialized' }), true)
})

test('未知控制状态保留可读兜底且不宣称正文已 materialize', () => {
  const view = taskControlView({
    controlState: 'future_state',
    materializationState: 'materialized',
  })
  assert.equal(view.state, 'future_state')
  assert.equal(view.label, '状态未知')
  assert.match(view.description, /future_state/)
  assert.equal(view.contentMaterialized, false)
  assert.equal(taskControlView({}).available, false)
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
    branch_name: 'dev',
    source_branch_name: 'dev1',
    task_space_indexed_revision: 6,
    relative_dir: '.trellis/tasks/task',
    derived_stage: 'implement',
    assignee_dev_id: 'dev-a',
    previous_assignee_user_id: 'user-old',
    control_state: 'claimed',
    materialization_state: 'claimed',
    control_task_version: 8,
    handoff_state: 'target_materializing',
    lease_status: 'active',
    lease_expires_at: '2030-01-01T00:00:00.000Z',
    lease_expired: false,
    attention_reasons: ['overdue'],
  })
  assert.equal(row.taskKey, 'p1::task')
  assert.equal(row.executionTaskKey, 'exec-1')
  assert.equal(row.branchName, 'dev')
  assert.equal(row.sourceBranchName, 'dev1')
  assert.equal(row.taskVersion, 7)
  assert.equal(row.assignmentVersion, 2)
  assert.equal(row.taskSpaceIndexedRevision, 6)
  assert.equal(row.derivedStage, 'implement')
  assert.equal(row.assignee, 'dev-a')
  assert.equal(row.previousAssigneeUserId, 'user-old')
  assert.equal(row.controlState, 'claimed')
  assert.equal(row.materializationState, 'claimed')
  assert.equal(row.controlTaskVersion, 8)
  assert.equal(row.handoffState, 'target_materializing')
  assert.equal(row.leaseStatus, 'active')
  assert.equal(row.leaseExpiresAt, '2030-01-01T00:00:00.000Z')
  assert.equal(row.leaseExpired, false)
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

test('只有执行中的任务操作继续自动查询', () => {
  assert.equal(isActiveOperation({ status: 'pending' }), true)
  assert.equal(isActiveOperation({ status: 'delivered' }), true)
  assert.equal(isActiveOperation({ status: 'running' }), true)
  assert.equal(isActiveOperation({ status: 'failed' }), false)
  assert.equal(isActiveOperation({ status: 'succeeded' }), false)
  assert.equal(isActiveOperation({ status: 'cancelled' }), false)
})

test('登录回跳只接受同源相对路径', () => {
  assert.equal(safeReturnTo('/admin.html?tab=projects'), '/admin.html?tab=projects')
  assert.equal(safeReturnTo('//example.com/steal'), '/')
  assert.equal(safeReturnTo('https://example.com/steal'), '/')
  assert.equal(safeReturnTo('/\\example.com'), '/')
  assert.equal(safeReturnTo('/login.html?returnTo=%2F'), '/')
})
