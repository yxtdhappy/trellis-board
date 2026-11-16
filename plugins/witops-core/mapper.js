import { safeHtmlToMarkdown } from './html-to-markdown.js'
import { calendarDate } from './util.js'

const BUILTIN_STATUS = new Map([
  [0, '草稿中'],
  [1, '待处理'],
  [2, '已完成'],
  [3, '进行中'],
  [4, '已取消'],
  [97, '待提交'],
  [99, '已关闭'],
])

const BUILTIN_PRIORITY = new Map([
  [1, 'P0'],
  [2, 'P1'],
  [3, 'P2'],
  [4, 'P3'],
])

const BUILTIN_CATEGORY = new Map([
  [0, '产品设计'],
  [1, '后端开发'],
  [2, '前端开发'],
  [3, '测试任务'],
  [4, '任务'],
  [5, '合理化建议'],
  [6, '采购单'],
  [7, '工时'],
])

const BUILTIN_ENV = new Map([
  [0, 'DEV'],
  [1, 'FAT'],
  [2, 'UAT'],
  [3, 'PRO'],
  [4, 'SIT'],
])

export function dictionaryToMap(rows) {
  const map = new Map()
  if (!Array.isArray(rows)) return map
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const code = row.code ?? row.dicConfigCode ?? row.value ?? row.key
    const name = row.name ?? row.dicConfigName ?? row.label ?? row.text
    if (code === undefined || name === undefined) continue
    map.set(Number(code), String(name))
  }
  return map
}

function pick(source, ...keys) {
  for (const key of keys) {
    const value = source?.[key]
    if (value !== undefined && value !== null && value !== '') return value
  }
  return null
}

function text(value) {
  if (value === undefined || value === null) return ''
  return String(value)
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
}

function formatTime(value) {
  if (value === null || value === undefined || value === '') return ''
  const raw = typeof value === 'number' ? new Date(value) : new Date(String(value))
  if (Number.isNaN(raw.getTime())) return text(value)
  const pad = (part) => String(part).padStart(2, '0')
  return `${raw.getFullYear()}-${pad(raw.getMonth() + 1)}-${pad(raw.getDate())} ${pad(raw.getHours())}:${pad(raw.getMinutes())}`
}

function truncate(value, length) {
  const string = String(value ?? '')
  return string.length > length ? `${string.slice(0, length - 1)}…` : string
}

function cell(value) {
  return text(value).replace(/\|/g, '\\|')
}

export function buildTaskLink({ baseUrl, webRoot }, type, businessId) {
  const root = String(baseUrl || '').replace(/\/+$/, '')
  const prefix = String(webRoot ?? '').replace(/^\/+|\/+$/g, '')
  const hashPath = [prefix, 'commonDetail', 'nodeTaskDetail', String(type), String(businessId)]
    .filter(Boolean)
    .join('/')
  return `${root}/#/${hashPath}`
}

/**
 * Trellis assignee 必须对应 `.trellis/workspace/<name>`。
 * 只认 `developerMap[assignedToUserId]`，其次 `config.assignee`；都不命中返回空，由调用方跳过。
 */
export function resolveAssignee(userId, config = {}) {
  const key = userId === null || userId === undefined ? '' : String(userId).trim()
  const mapped =
    key && config.developerMap && typeof config.developerMap === 'object'
      ? config.developerMap[key]
      : undefined
  if (mapped !== undefined && mapped !== null && String(mapped).trim()) return String(mapped).trim()
  return text(config.assignee ?? '')
}

/**
 * 需求（story）关联信息。平台在详情/列表里用 parentType + parentId/parentCode/parentName 表达父节点：
 * parentType=STORY 才是需求，TASK 表示挂在另一个任务下（此时不算需求）。
 */
export function resolveRequirement(detail, story = null) {
  const parentType = text(pick(detail, 'parentType')).toUpperCase()
  if (parentType && parentType !== 'STORY') return null
  const rawId =
    pick(detail, 'parentStoryId', 'storyId') ??
    (parentType === 'STORY' ? pick(detail, 'parentId') : null)
  const id = text(rawId)
  if (!id) return null
  const code = text(pick(detail, 'parentCode', 'storyCode')) || `R${id}`
  const name =
    text(pick(detail, 'parentStoryName', 'storyName', 'parentName')) ||
    text(pick(story, 'name', 'title')) ||
    ''
  return { id, code, name }
}

export function buildTaskDraft({
  detail,
  story = null,
  type,
  businessId,
  config = {},
  dictionaries = {},
  baseUrl = '',
  webRoot = '',
} = {}) {
  const statusMap = dictionaries.taskStatus?.size ? dictionaries.taskStatus : BUILTIN_STATUS
  const categoryMap = dictionaries.taskCategory?.size ? dictionaries.taskCategory : BUILTIN_CATEGORY
  const priorityMap = dictionaries.priority?.size ? dictionaries.priority : BUILTIN_PRIORITY
  const envMap = dictionaries.systemEnv?.size ? dictionaries.systemEnv : BUILTIN_ENV

  const typeCode = Number(type)
  const code =
    text(pick(detail, 'code', 'taskCode', 'number')) ||
    `witops-${typeCode || 4}-${String(businessId).toLowerCase()}`
  const slug =
    code.replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') ||
    `witops-${typeCode || 4}-${String(businessId).toLowerCase()}`
  const name = text(pick(detail, 'name', 'title', 'subject')) || `平台任务 ${businessId}`
  const categoryCode = Number(pick(detail, 'categoryDicConfigCode', 'categoryCode'))
  const categoryName =
    text(pick(detail, 'categoryDicConfigName', 'categoryName')) ||
    categoryMap.get(categoryCode) ||
    ''
  const statusCode = Number(pick(detail, 'status', 'sourceStatus'))
  const statusName =
    statusMap.get(statusCode) || text(pick(detail, 'statusName')) || String(statusCode || '')
  const priorityCode = Number(pick(detail, 'priority', 'priorityCode'))
  const priorityName = text(pick(detail, 'priorityName'))
  const priority = /^P[0-3]$/.test(priorityName)
    ? priorityName
    : (priorityMap.get(priorityCode) ??
      BUILTIN_PRIORITY.get(priorityCode) ??
      text(config.defaultPriority ?? 'P2'))

  const envCode = Number(pick(detail, 'envDicConfigCode', 'envCode'))
  const env = envMap.get(envCode) || text(pick(detail, 'envDicConfigName', 'envName')) || null

  const dueDate = calendarDate(
    pick(
      detail,
      'expectCompleteTime',
      'expectFinishTime',
      'expectEndTime',
      'deadline',
      'planEndTime',
      'endTime',
    ),
  )

  const assignedToUserId = pick(detail, 'assignedToUserId', 'assignedToId', 'developerId')
  const assignee = resolveAssignee(assignedToUserId, config)

  const link = buildTaskLink({ baseUrl, webRoot }, type, businessId)
  const rawTaskDescription = String(pick(detail, 'description', 'content', 'remark') || '')
  const rawStoryDescription = String(pick(story, 'description', 'content') || '')
  const descriptionSource = rawTaskDescription ? 'task' : rawStoryDescription ? 'story' : 'empty'
  const descriptionHtml = rawTaskDescription || rawStoryDescription
  const { markdown: descriptionMarkdown, validation } = safeHtmlToMarkdown(descriptionHtml)

  const attachmentSource = pick(detail, 'annexResps', 'annexReqList', 'attachments')
  const attachments = Array.isArray(attachmentSource)
    ? attachmentSource.map((item) => text(item?.name ?? item?.fileName ?? item)).filter(Boolean)
    : []

  const product = text(pick(detail, 'productName')) || text(pick(detail, 'productAbbreviation'))
  const requirement = resolveRequirement(detail, story)
  const storyName = requirement
    ? [requirement.code, requirement.name].filter(Boolean).join(' ')
    : ''
  const storyUrl = requirement ? buildTaskLink({ baseUrl, webRoot }, 3, requirement.id) : ''

  const sourceLabel =
    descriptionSource === 'story' ? '父需求' : descriptionSource === 'task' ? '任务' : '无'

  const facts = [
    ['平台任务', `${code}（${name}）`],
    ['类型', text(pick(detail, 'typeName')) || String(type)],
    ['状态', statusName],
    ['优先级', priority],
    ['分类', categoryName],
    ['产品', product],
    ['模块', text(pick(detail, 'projectModuleName', 'moduleName'))],
    ['迭代', text(pick(detail, 'iterationName', 'sprintName'))],
    ['需求', storyName],
    ['需求链接', storyUrl],
    [
      '环境',
      env && /^(DEV|FAT|UAT|PRO|SIT)$/.test(env)
        ? env
        : text(pick(detail, 'envDicConfigName', 'envName')),
    ],
    ['预计工时', text(pick(detail, 'expectHour'))],
    ['期望完成', formatTime(pick(detail, 'expectCompleteTime', 'expectFinishTime'))],
    ['提出时间', formatTime(pick(detail, 'mentionTime'))],
    ['提出人', text(pick(detail, 'createUserName', 'creatorName'))],
    ['创建时间', formatTime(pick(detail, 'createTime', 'createdTime'))],
    ['描述来源', sourceLabel],
    ['链接', link],
  ].filter(([, value]) => value !== '' && value !== null && value !== undefined)

  const prdParts = [
    `# ${code} ${name}`,
    '',
    '## 来源',
    '',
    '| 字段 | 值 |',
    '| --- | --- |',
    ...facts.map(([label, value]) => `| ${cell(label)} | ${cell(value)} |`),
    '',
    '## 任务描述',
    '',
    descriptionMarkdown || '（平台未填写描述）',
  ]

  if (descriptionSource === 'story') {
    prdParts.push('', '> 任务本身没有描述，以上内容来自父需求。')
  }
  if (attachments.length) {
    prdParts.push('', '## 附件', '', ...attachments.map((item) => `- ${item}`))
  }
  if (validation && !validation.ok) {
    prdParts.push('', '> 描述转换回退为纯文本：' + validation.errors.slice(0, 3).join('；'))
  }

  const title = truncate(`${code} 【${categoryName || '任务'}】${name}`, 200)
  const requirementNote = requirement
    ? `所属需求 ${requirement.code}${requirement.name ? `（${requirement.name}）` : ''}，需求 id ${requirement.id}。`
    : ''
  const description = truncate(
    `平台任务 ${code}（${statusName}），来源 ${link}。${requirementNote}${descriptionMarkdown.split('\n').find((line) => line.trim()) ?? ''}`,
    3000,
  )

  const meta = {
    witops: {
      type: Number(type) || type,
      businessId: String(businessId),
      code,
      status: statusName,
      statusCode: Number.isFinite(statusCode) ? statusCode : null,
      priority,
      category: categoryName,
      env: env || null,
      storyId: requirement ? requirement.id : null,
      storyCode: requirement ? requirement.code : null,
      storyName: requirement && requirement.name ? requirement.name : null,
      url: link,
      dueDate: dueDate ?? null,
      importedAt: new Date().toISOString(),
    },
  }
  if (config.agentId) meta.agent = String(config.agentId)

  return {
    title,
    name,
    code,
    slug,
    description,
    prd: `${prdParts.join('\n')}\n`,
    assignee,
    priority,
    dueDate,
    meta,
    extraFiles: config.keepRaw
      ? { 'prd.witops.html': rawTaskDescription || rawStoryDescription }
      : {},
    rawDeveloper: text(assignedToUserId),
  }
}

export function summarizeRecord(record, { type, imported }) {
  const statusMap = BUILTIN_STATUS
  const statusCode = Number(pick(record, 'status', 'sourceStatus'))
  const requirement = resolveRequirement(record)
  return {
    type: Number(type) || type,
    businessId: String(pick(record, 'businessId', 'id') ?? ''),
    code: text(pick(record, 'code', 'taskCode')) || '',
    name: text(pick(record, 'name', 'title')) || '',
    status: statusMap.get(statusCode) ?? text(pick(record, 'statusName')) ?? '',
    priority:
      BUILTIN_PRIORITY.get(
        Number(pick(record, 'priority', 'priorityCode', 'priorityDicConfigCode')),
      ) ??
      text(pick(record, 'priorityName')) ??
      '',
    developer: text(
      pick(
        record,
        'assignedToUserName',
        'assigneeName',
        'developer',
        'developerName',
        'assignedToName',
      ),
    ),
    expectCompleteTime: formatTime(pick(record, 'expectCompleteTime', 'expectFinishTime')),
    dueDate: calendarDate(
      pick(
        record,
        'expectCompleteTime',
        'expectFinishTime',
        'expectEndTime',
        'deadline',
        'planEndTime',
      ),
    ),
    storyId: requirement?.id ?? null,
    storyCode: requirement?.code ?? null,
    storyName: requirement?.name ?? null,
    imported: Boolean(imported),
    taskKey: imported?.taskKey ?? null,
  }
}
