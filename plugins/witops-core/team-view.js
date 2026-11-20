/**
 * team 面板的纯函数层：平台列表归一化、需求分组、筛选参数映射。
 *
 * 单独成模块的原因有两个：
 * 1. 宿主的插件测试 harness 没有 team 模式，路由层只能靠它自己的单测覆盖；
 * 2. 分组/排序是纯计算，抽出来才能直接断言"需求在外层、任务缺陷在子行"。
 */
import { resolveRequirement } from './mapper.js'
import { calendarDate, numberOrNull, pick, text } from './util.js'

const KIND_BY_TYPE = {
  0: { kind: 'workOrder', label: '工单' },
  1: { kind: 'release', label: '发版单' },
  2: { kind: 'bug', label: '缺陷' },
  3: { kind: 'requirement', label: '需求' },
  4: { kind: 'task', label: '任务' },
}

/** 与平台 sourceStatus / tasksStatus 一致，顺序即"未完成优先"的语义顺序。 */
const STATUS_BY_CODE = {
  0: '草稿中',
  1: '待处理',
  2: '已完成',
  3: '进行中',
  4: '已取消',
  97: '待提交',
  99: '已关闭',
}

const PRIORITY_BY_CODE = { 1: 'P0', 2: 'P1', 3: 'P2', 4: 'P3' }

/** 状态排序权重：进行中 → 待处理 → 待提交 → 已完成 → 已关闭 → 已取消 → 草稿。 */
const STATUS_WEIGHT = { 3: 0, 1: 1, 97: 2, 2: 3, 99: 4, 4: 5, 0: 6 }

/** 平台分页接口既可能返回数组，也可能包一层 records/list/rows。 */
export function rowsOf(payload) {
  if (Array.isArray(payload)) return payload
  const rows = pick(payload, 'records', 'list', 'rows', 'items', 'children')
  if (Array.isArray(rows)) return rows
  return []
}

/** 状态看板口径：按状态分列返回 [{ status, statusName, taskResps }]。 */
function isStatusBoard(payload) {
  const columns = rowsOf(payload)
  return columns.some((column) => Array.isArray(column?.taskResps))
}

function flattenStatusBoard(payload) {
  const rows = []
  for (const column of rowsOf(payload)) {
    const tasks = Array.isArray(column?.taskResps) ? column.taskResps : []
    for (const task of tasks) {
      rows.push({
        ...task,
        __columnStatus: column?.status ?? task?.__columnStatus,
        __columnName: column?.statusName ?? task?.__columnName,
      })
    }
  }
  return rows
}

export function kindOf(type) {
  return KIND_BY_TYPE[type] ?? { kind: 'task', label: `类型 ${type}` }
}

function statusOf(row) {
  const code = numberOrNull(
    pick(row, 'sourceStatus', 'tasksStatus', 'taskStatus', 'status', '__columnStatus'),
  )
  const label = text(
    pick(
      row,
      'sourceStatusName',
      'tasksStatusName',
      'taskStatusName',
      'statusName',
      '__columnName',
    ),
  )
  return {
    code,
    label: label || (code === null ? '' : STATUS_BY_CODE[code] || String(code)),
  }
}

function priorityOf(row) {
  const code = numberOrNull(
    pick(row, 'priorityDicConfigCode', 'priorityCode', 'priorityDicConfigCodes'),
  )
  const label = text(pick(row, 'priorityName', 'priorityDicConfigName'))
  return {
    code,
    label: label || (code === null ? '' : PRIORITY_BY_CODE[code] || ''),
  }
}

/**
 * 列表行 → 面板行。字段来源是 weint-witops-web 的 use（nodeTask/page、task/task/page、
 * task/childTask 三个接口的字段名不完全一致），所以全部走 pick 兜底。
 */
export function normalizeTeamTask(row, extra = {}) {
  const type = numberOrNull(pick(row, 'type', 'nodeTaskType')) ?? 4
  const id = text(pick(row, 'businessId', 'sourceId', 'id'))
  const status = statusOf(row)
  const priority = priorityOf(row)
  const requirement = resolveRequirement(row)
  const kind = kindOf(type)
  return {
    id,
    businessId: id,
    sourceId: text(pick(row, 'sourceId', 'businessId', 'id')) || id,
    type,
    kind: kind.kind,
    kindLabel: kind.label,
    typeName: text(pick(row, 'typeName')) || kind.label,
    code: text(pick(row, 'code', 'businessCode', 'taskCode')),
    name: text(pick(row, 'name', 'title', 'taskName')),
    statusCode: status.code,
    status: status.label,
    priorityCode: priority.code,
    priority: priority.label,
    assignee: text(pick(row, 'assignedToUserName', 'assigneeName', 'assignedToName')),
    assigneeId: text(pick(row, 'assignedToUserId', 'assigneeId')),
    startDate: calendarDate(pick(row, 'expectStartTime', 'startTime', 'planStartTime')),
    dueDate: calendarDate(
      pick(
        row,
        'expectCompleteTime',
        'expectFinishTime',
        'expectEndTime',
        'deadline',
        'planEndTime',
      ),
    ),
    testStart: calendarDate(pick(row, 'expectTestStart')),
    testComplete: calendarDate(pick(row, 'expectTestComplete')),
    onlineDate: calendarDate(pick(row, 'expectOnline')),
    category: text(pick(row, 'taskCategoryName', 'categoryDicConfigName', 'category')),
    module: text(pick(row, 'projectModuleName', 'moduleName')),
    iteration: text(pick(row, 'iterationName', 'sprintName')),
    product: text(pick(row, 'productAbbreviation', 'productName')),
    projectId: text(pick(row, 'projectId', 'projectProductId')),
    storyId: requirement ? requirement.id : null,
    storyCode: requirement ? requirement.code : null,
    storyName: requirement && requirement.name ? requirement.name : null,
    createdAt: text(pick(row, 'createTime', 'createdAt')),
    mentionTime: text(pick(row, 'mentionTime')),
    ...extra,
  }
}

/**
 * 平台列表 → 面板行。`flatten: true` 会把 childTask 那种嵌套 children 拍平并带 level。
 */
export function normalizeTeamTasks(payload, { flatten = false, extra = {} } = {}) {
  const source = isStatusBoard(payload) ? flattenStatusBoard(payload) : rowsOf(payload)
  const items = []
  const seen = new Set()

  const push = (row, level) => {
    const item = normalizeTeamTask(row, { ...extra, level })
    if (!item.id) return
    const key = `${item.type}:${item.id}`
    if (seen.has(key)) return
    seen.add(key)
    items.push(item)
  }

  const walk = (rows, level) => {
    for (const row of rows) {
      push(row, level)
      const children = Array.isArray(row?.children) ? row.children : []
      if (flatten && children.length) walk(children, level + 1)
    }
  }

  walk(source, 0)
  return items
}

function comparePriority(left, right) {
  const a = left.priorityCode ?? 9
  const b = right.priorityCode ?? 9
  return a - b
}

function compareStatus(left, right) {
  const a = STATUS_WEIGHT[left.statusCode] ?? 9
  const b = STATUS_WEIGHT[right.statusCode] ?? 9
  return a - b
}

function compareDate(left, right) {
  const a = left.dueDate || '9999-12-31'
  const b = right.dueDate || '9999-12-31'
  return a < b ? -1 : a > b ? 1 : 0
}

function compareCode(left, right) {
  const a = left.code || left.id || ''
  const b = right.code || right.id || ''
  return a.localeCompare(b, 'zh-Hans-CN', { numeric: true })
}

/** 需求行排序：优先级 → 状态（进行中在前）→ 截止日期 → 编号。 */
export function sortRequirements(items) {
  return [...items].sort(
    (left, right) =>
      comparePriority(left, right) ||
      compareStatus(left, right) ||
      compareDate(left, right) ||
      compareCode(left, right),
  )
}

/** 子行排序：类型（需求 → 任务 → 缺陷 → 工单）→ 状态 → 优先级 → 编号。 */
const CHILD_TYPE_WEIGHT = { 3: 0, 4: 1, 2: 2, 0: 3, 1: 4 }

export function sortChildren(items) {
  return [...items].sort(
    (left, right) =>
      (CHILD_TYPE_WEIGHT[left.type] ?? 9) - (CHILD_TYPE_WEIGHT[right.type] ?? 9) ||
      compareStatus(left, right) ||
      comparePriority(left, right) ||
      compareCode(left, right),
  )
}

export const ORPHAN_GROUP_KEY = 'orphans'

/**
 * 按需求分组：外层需求，内层任务/缺陷/子需求。
 *
 * - 需求行优先用列表里真实的那条（type=3）；列表没返回父需求时用子行带的
 *   storyCode/storyName 合成一行，避免任务因为"父需求不在本页"变成孤儿。
 * - 没有 storyId 的条目统一进入「未关联需求」分组。
 */
export function groupByRequirement(items) {
  const requirementRows = new Map()
  const childGroups = new Map()
  const orphans = []

  for (const item of items) {
    if (item.type !== 3) continue
    if (!item.storyId) requirementRows.set(item.id, item)
  }

  for (const item of items) {
    if (item.type === 3 && !item.storyId) continue
    const storyId = item.storyId
    if (!storyId) {
      orphans.push(item)
      continue
    }
    if (!childGroups.has(storyId)) childGroups.set(storyId, [])
    childGroups.get(storyId).push(item)
  }

  const groups = []
  const used = new Set()

  for (const [storyId, requirement] of requirementRows) {
    const children = childGroups.get(storyId) ?? []
    used.add(storyId)
    groups.push({ key: `req:${storyId}`, requirement, children: sortChildren(children) })
  }

  for (const [storyId, children] of childGroups) {
    if (used.has(storyId)) continue
    const first = children[0]
    groups.push({
      key: `req:${storyId}`,
      requirement: {
        id: storyId,
        type: 3,
        kind: 'requirement',
        kindLabel: '需求',
        code: first.storyCode || `R${storyId}`,
        name: first.storyName || '',
        status: '',
        priority: '',
        assignee: '',
        dueDate: null,
        synthetic: true,
      },
      children: sortChildren(children),
    })
  }

  groups.sort(
    (left, right) =>
      comparePriority(left.requirement, right.requirement) ||
      compareStatus(left.requirement, right.requirement) ||
      compareDate(left.requirement, right.requirement) ||
      compareCode(left.requirement, right.requirement),
  )

  if (orphans.length) {
    groups.push({
      key: ORPHAN_GROUP_KEY,
      requirement: {
        id: '',
        type: 3,
        kind: 'requirement',
        kindLabel: '未关联需求',
        code: '',
        name: `未关联需求（${orphans.length}）`,
        status: '',
        priority: '',
        assignee: '',
        dueDate: null,
        orphan: true,
      },
      children: sortChildren(orphans),
    })
  }

  return groups
}

/** 面板支持的筛选键 → 平台 /task/task/page、/nodeTask/page 的真实参数名。 */
const FILTER_PARAMS = {
  code: { key: 'code' },
  name: { key: 'name' },
  status: { key: 'sourceStatus' },
  priority: { key: 'priorityDicConfigCodes' },
  assignee: { key: 'assignedToUserIds' },
  module: { key: 'projectModuleIds' },
  iteration: { key: 'iterationId', numeric: true },
  createTime: { key: 'createTime' },
}

/**
 * 只映射平台请求模型里真实存在的字段（PageTaskReq / PageNodeTaskReq）。
 * 之前面板下发的 `priority`、`categories` 在模型里不存在，等于没过滤，这里一并纠正。
 * `types` 也不在这里：它在 PageTaskReq 里是业务类型（0/1/5...），不是 需求3/任务4/缺陷2，
 * 传 3/4/2 会把结果筛成 0 条（RD411-2602 空列表的直接原因之一）。
 */
export function buildTaskFilters(query = {}) {
  const params = {}
  for (const [from, rule] of Object.entries(FILTER_PARAMS)) {
    const raw = query[from]
    const value = Array.isArray(raw)
      ? raw
          .map((part) => text(part))
          .filter(Boolean)
          .join(',')
      : text(raw)
    if (!value) continue
    params[rule.key] = rule.numeric ? Number(value) : value
  }
  return params
}

/** 面板偏好只落这些键，避免把临时状态写进 store。 */
const PREF_KEYS = ['projectIds', 'filters', 'pageSize', 'sort']

export function sanitizePreferences(input = {}) {
  const output = {}
  if (Array.isArray(input.projectIds)) {
    output.projectIds = input.projectIds
      .map((id) => text(id))
      .filter(Boolean)
      .slice(0, 20)
  }
  if (input.filters && typeof input.filters === 'object' && !Array.isArray(input.filters)) {
    const filters = {}
    for (const key of [
      'code',
      'name',
      'status',
      'priority',
      'assignee',
      'iteration',
      'createFrom',
      'createTo',
    ]) {
      const value = input.filters[key]
      if (Array.isArray(value)) {
        const list = value.map((part) => text(part)).filter(Boolean)
        if (list.length) filters[key] = list
      } else if (text(value)) {
        filters[key] = text(value)
      }
    }
    output.filters = filters
  }
  if (text(input.sort)) output.sort = text(input.sort)
  const size = numberOrNull(input.pageSize)
  if (size && size > 0) output.pageSize = Math.min(200, Math.max(10, size))
  return Object.fromEntries(Object.entries(output).filter(([key]) => PREF_KEYS.includes(key)))
}
