export const TASK_TYPES = Object.freeze([
  {
    id: 'simple',
    label: '简单',
    description: '单点改动，无跨模块设计',
  },
  {
    id: 'complex',
    label: '复杂',
    description: '需要设计、实施计划与分阶段验收',
  },
  {
    id: 'research',
    label: '研究',
    description: '只做方案调研，不改生产代码',
  },
])

export const TASK_TYPE_IDS = Object.freeze(TASK_TYPES.map((item) => item.id))

const TASK_TYPE_SET = new Set(TASK_TYPE_IDS)
const TASK_TYPE_BY_ID = new Map(TASK_TYPES.map((item) => [item.id, item]))

export function isTaskType(value) {
  return TASK_TYPE_SET.has(String(value || '').trim())
}

export function taskTypeLabel(value) {
  return TASK_TYPE_BY_ID.get(String(value || '').trim())?.label ?? ''
}
