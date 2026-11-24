export const WORK_TYPES = Object.freeze([
  {
    id: 'backend',
    label: '后端',
    description: '服务端、接口、数据库、脚本',
  },
  {
    id: 'frontend',
    label: '前端',
    description: '页面、组件、样式、交互',
  },
  {
    id: 'fullstack',
    label: '全栈',
    description: '前后端都有可验收改动',
  },
  {
    id: 'research',
    label: '研究',
    description: '方案调研、技术验证，不改生产代码',
  },
  {
    id: 'docs',
    label: '文档',
    description: '文档、规范、说明',
  },
])

export const WORK_TYPE_IDS = Object.freeze(WORK_TYPES.map((item) => item.id))

const WORK_TYPE_SET = new Set(WORK_TYPE_IDS)
const WORK_TYPE_BY_ID = new Map(WORK_TYPES.map((item) => [item.id, item]))

export function isWorkType(value) {
  return WORK_TYPE_SET.has(String(value || '').trim())
}

export function workTypeLabel(value) {
  return WORK_TYPE_BY_ID.get(String(value || '').trim())?.label ?? ''
}
