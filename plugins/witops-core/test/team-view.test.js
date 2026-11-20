import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ORPHAN_GROUP_KEY,
  buildTaskFilters,
  groupByRequirement,
  normalizeTeamTasks,
  sanitizePreferences,
  sortChildren,
} from '../team-view.js'

const requirement = {
  businessId: '3001',
  code: 'R3001',
  name: '需求 A',
  type: 3,
  status: 3,
  priority: 2,
  expectCompleteTime: '2026-11-30 18:00:00',
  assignedToUserName: '张三',
  projectId: 'p1',
}

const task = {
  businessId: '10001',
  code: 'T10001',
  name: '列表页重构',
  type: 4,
  status: 3,
  priorityDicConfigCode: 2,
  assignedToUserName: '李四',
  parentType: 'STORY',
  parentId: 3001,
  parentCode: 'R3001',
  parentName: '需求 A',
  expectCompleteTime: '2026-11-20 18:00:00',
}

const bug = {
  businessId: '40001',
  code: 'B40001',
  name: '登录失败',
  type: 2,
  status: 1,
  priority: 1,
  parentType: 'STORY',
  parentId: 3001,
  parentCode: 'R3001',
  parentName: '需求 A',
}

test('normalizeTeamTasks 统一字段名与状态/优先级文案', () => {
  const [item] = normalizeTeamTasks({ records: [task], total: 1 })
  assert.equal(item.id, '10001')
  assert.equal(item.code, 'T10001')
  assert.equal(item.type, 4)
  assert.equal(item.kind, 'task')
  assert.equal(item.status, '进行中')
  assert.equal(item.priority, 'P1')
  assert.equal(item.assignee, '李四')
  assert.equal(item.dueDate, '2026-11-20')
  assert.equal(item.storyId, '3001')
  assert.equal(item.storyCode, 'R3001')
})

test('normalizeTeamTasks 支持状态看板分列返回', () => {
  const items = normalizeTeamTasks([
    { status: 3, statusName: '进行中', taskResps: [{ businessId: '1', type: 4, name: 'A' }] },
    { status: 1, statusName: '待处理', taskResps: [{ businessId: '2', type: 2, name: 'B' }] },
  ])
  assert.deepEqual(
    items.map((item) => item.status),
    ['进行中', '待处理'],
  )
})

test('normalizeTeamTasks flatten 会展开 childTask 的嵌套 children', () => {
  const items = normalizeTeamTasks(
    {
      children: [
        {
          businessId: '1',
          type: 4,
          name: '子任务',
          children: [{ businessId: '2', type: 4, name: '孙任务' }],
        },
      ],
    },
    { flatten: true },
  )
  assert.deepEqual(
    items.map((item) => [item.id, item.level]),
    [
      ['1', 0],
      ['2', 1],
    ],
  )
})

test('groupByRequirement 外层需求、内层任务与缺陷', () => {
  const groups = groupByRequirement(normalizeTeamTasks({ records: [task, bug, requirement] }))
  assert.equal(groups.length, 1)
  const [group] = groups
  assert.equal(group.key, 'req:3001')
  assert.equal(group.requirement.code, 'R3001')
  assert.equal(group.requirement.name, '需求 A')
  // 子行顺序：任务在缺陷前
  assert.deepEqual(
    group.children.map((item) => item.code),
    ['T10001', 'B40001'],
  )
})

test('groupByRequirement 父需求不在本页时按子行信息合成需求行', () => {
  const groups = groupByRequirement(normalizeTeamTasks({ records: [task] }))
  assert.equal(groups.length, 1)
  assert.equal(groups[0].requirement.synthetic, true)
  assert.equal(groups[0].requirement.code, 'R3001')
  assert.equal(groups[0].requirement.name, '需求 A')
})

test('groupByRequirement 没有 storyId 的条目进「未关联需求」分组', () => {
  const loose = { businessId: '9', code: 'T9', name: '零散任务', type: 4, status: 1 }
  const groups = groupByRequirement(normalizeTeamTasks({ records: [loose, task] }))
  assert.equal(groups.length, 2)
  assert.equal(groups.at(-1).key, ORPHAN_GROUP_KEY)
  assert.equal(groups.at(-1).children[0].code, 'T9')
})

test('groupByRequirement 没有子项的需求仍然保留（只选「需求」类型时也能看到）', () => {
  const groups = groupByRequirement(normalizeTeamTasks({ records: [requirement] }))
  assert.equal(groups.length, 1)
  assert.equal(groups[0].children.length, 0)
})

test('sortChildren 按类型 → 状态 → 优先级排序', () => {
  const sorted = sortChildren([
    { type: 2, statusCode: 1, priorityCode: 1, code: 'B1' },
    { type: 4, statusCode: 1, priorityCode: 1, code: 'T1' },
    { type: 4, statusCode: 3, priorityCode: 3, code: 'T2' },
  ])
  assert.deepEqual(
    sorted.map((item) => item.code),
    ['T2', 'T1', 'B1'],
  )
})

test('buildTaskFilters 只映射平台请求模型里真实存在的参数', () => {
  const params = buildTaskFilters({
    code: ' T1 ',
    name: '重构',
    status: ['1', '3'],
    priority: ['2'],
    assignee: ['900'],
    iteration: '45',
    categories: '不该出现',
    types: '3,4',
    createTime: '2026-11-01 00:00:00,2026-11-30 23:59:59',
  })
  assert.deepEqual(params, {
    code: 'T1',
    name: '重构',
    sourceStatus: '1,3',
    priorityDicConfigCodes: '2',
    assignedToUserIds: '900',
    iterationId: 45,
    createTime: '2026-11-01 00:00:00,2026-11-30 23:59:59',
  })
  // types 不是行的类型，传下去会把结果筛成 0，必须丢掉
  assert.equal('types' in params, false)
})

test('sanitizePreferences 只保留白名单键并裁剪项目数量', () => {
  const prefs = sanitizePreferences({
    projectIds: ['p1', '', 'p2', ...Array.from({ length: 30 }, (_, index) => `x${index}`)],
    filters: { code: 'T1', status: ['1', '3'], bogus: 'x' },
    pageSize: 5000,
    expanded: ['req:1'],
  })
  assert.equal(prefs.projectIds.length, 20)
  assert.deepEqual(prefs.filters, { code: 'T1', status: ['1', '3'] })
  assert.equal(prefs.pageSize, 200)
  assert.equal('expanded' in prefs, false)
})
