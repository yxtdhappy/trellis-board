export const MAX_TAGS = 10

export const MAX_TAG_LENGTH = 32

export const MAX_MILESTONE_LENGTH = 100

export const MAX_VIEW_NAME_LENGTH = 60

export const MAX_DEPENDENCY_REASON_LENGTH = 500

export const ALLOWED_PRIORITIES = new Set(['P0', 'P1', 'P2', 'P3'])

export const ALLOWED_BLOCKED_FILTERS = new Set(['any', 'blocked', 'unblocked'])

export const FILTER_KEYS = new Set([
  'priorities',
  'stages',
  'tags',
  'dueWithinDays',
  'staleDays',
  'blocked',
])

export function textLength(value) {
  return Array.from(value).length
}

export function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function parseJson(value, fallback = null) {
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

export function chunk(values, size = 400) {
  const chunks = []
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size))
  }
  return chunks
}

export function placeholders(count) {
  return Array.from({ length: count }, () => '?').join(', ')
}

export function normalizeActor(actor) {
  const value = String(actor || '').trim()
  return value || null
}

export function isValidCalendarDate(value) {
  if (typeof value !== 'string') return false
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return false
  const date = new Date(0)
  date.setUTCHours(0, 0, 0, 0)
  date.setUTCFullYear(year, month - 1, day)
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  )
}

export function normalizeTags(tags) {
  if (!Array.isArray(tags)) throw new Error('标签必须是数组')
  const normalized = []
  const seen = new Set()
  for (const rawTag of tags) {
    if (typeof rawTag !== 'string') throw new Error('每个标签都必须是文本')
    const tag = rawTag.trim()
    if (!tag) throw new Error('标签不能为空')
    if (textLength(tag) > MAX_TAG_LENGTH) {
      throw new Error(`单个标签不能超过 ${MAX_TAG_LENGTH} 个字符`)
    }
    const key = tag.toLocaleLowerCase('zh-CN')
    if (seen.has(key)) continue
    seen.add(key)
    normalized.push(tag)
  }
  if (normalized.length > MAX_TAGS) {
    throw new Error(`标签最多 ${MAX_TAGS} 个`)
  }
  return normalized
}

export function normalizeMilestone(value) {
  if (value == null) return ''
  if (typeof value !== 'string') throw new Error('里程碑必须是文本')
  const milestone = value.trim()
  if (textLength(milestone) > MAX_MILESTONE_LENGTH) {
    throw new Error(`里程碑不能超过 ${MAX_MILESTONE_LENGTH} 个字符`)
  }
  return milestone
}

export function normalizeDueDate(value) {
  if (value == null || value === '') return null
  if (!isValidCalendarDate(value)) {
    throw new Error('截止日期必须是有效的 YYYY-MM-DD 公历日期')
  }
  return value
}

export function normalizeStringSet(value, allowed, label) {
  if (!Array.isArray(value)) throw new Error(`${label}必须是数组`)
  const result = []
  const seen = new Set()
  for (const item of value) {
    if (typeof item !== 'string') throw new Error(`${label}只能包含文本`)
    const normalized = item.trim()
    if (!allowed.has(normalized)) throw new Error(`不支持的${label}值: ${normalized}`)
    if (!seen.has(normalized)) {
      seen.add(normalized)
      result.push(normalized)
    }
  }
  return result
}

export function normalizeSavedViewFilter(input, stageIds) {
  if (!isPlainObject(input)) throw new Error('筛选条件必须是对象')
  const payload = input
  for (const key of Object.keys(payload)) {
    if (!FILTER_KEYS.has(key)) throw new Error(`保存视图包含未知筛选字段: ${key}`)
  }

  const filter = {}
  if (payload.priorities != null) {
    const priorities = normalizeStringSet(payload.priorities, ALLOWED_PRIORITIES, '优先级')
    if (priorities.length) filter.priorities = priorities
  }
  if (payload.stages != null) {
    const stages = normalizeStringSet(payload.stages, new Set(stageIds || []), '阶段')
    if (stages.length) filter.stages = stages
  }
  if (payload.tags != null) {
    const tags = normalizeTags(payload.tags)
    if (tags.length) filter.tags = tags
  }
  if (payload.dueWithinDays != null && payload.dueWithinDays !== '') {
    const days = payload.dueWithinDays
    if (typeof days !== 'number' || !Number.isInteger(days) || days < 0 || days > 365) {
      throw new Error('截止窗口必须是 0 到 365 的整数天')
    }
    filter.dueWithinDays = days
  }
  if (payload.staleDays != null && payload.staleDays !== '') {
    const days = payload.staleDays
    if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > 365) {
      throw new Error('停滞天数必须是 1 到 365 的整数天')
    }
    filter.staleDays = days
  }
  if (payload.blocked != null && payload.blocked !== '') {
    if (typeof payload.blocked !== 'string' || !ALLOWED_BLOCKED_FILTERS.has(payload.blocked)) {
      throw new Error('阻断筛选只支持 any、blocked 或 unblocked')
    }
    if (payload.blocked !== 'any') filter.blocked = payload.blocked
  }
  if (!Object.keys(filter).length) throw new Error('保存视图至少需要一个筛选条件')
  return filter
}

export function normalizeDependencyReason(value) {
  if (typeof value !== 'string') throw new Error('阻断原因必须是文本')
  const reason = value.trim()
  if (!reason) throw new Error('阻断原因不能为空')
  if (textLength(reason) > MAX_DEPENDENCY_REASON_LENGTH) {
    throw new Error(`阻断原因不能超过 ${MAX_DEPENDENCY_REASON_LENGTH} 个字符`)
  }
  return reason
}

export function normalizeDependencyTaskKey(value, label) {
  const key = String(value || '').trim()
  if (!key) throw new Error(`缺少${label}任务执行身份`)
  return key
}

export function normalizeViewName(value) {
  if (typeof value !== 'string') throw new Error('视图名称必须是文本')
  const name = value.trim()
  if (!name) throw new Error('视图名称不能为空')
  if (textLength(name) > MAX_VIEW_NAME_LENGTH) {
    throw new Error(`视图名称不能超过 ${MAX_VIEW_NAME_LENGTH} 个字符`)
  }
  return name
}
