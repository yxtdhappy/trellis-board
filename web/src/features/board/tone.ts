const PRIORITY_TONES: Record<string, string> = {
  P0: 'bg-destructive text-white',
  P1: 'bg-warning-soft text-warning',
  P2: 'bg-secondary text-secondary-foreground',
  P3: 'bg-muted text-muted-foreground',
}

const LANE_TONES: Record<string, string> = {
  planning: 'bg-info-soft text-info',
  review: 'bg-warning-soft text-warning',
  implementation: 'bg-primary-soft text-primary',
  verification: 'bg-success-soft text-success',
}

const STAGE_TONES: Record<string, string> = {
  规划: LANE_TONES.planning,
  待放行: LANE_TONES.review,
  实现: LANE_TONES.implementation,
  实现中: LANE_TONES.implementation,
  检查: LANE_TONES.verification,
  检查中: LANE_TONES.verification,
  '检查·收尾': LANE_TONES.verification,
  planning: LANE_TONES.planning,
  in_progress: LANE_TONES.implementation,
  review: LANE_TONES.review,
  check: LANE_TONES.verification,
  done: LANE_TONES.verification,
}

const SUCCESS_WORDS = ['成功', '已启用', '已产出', '已同步', '已应用', '已批准', '在线', '已归档']
const WARNING_WORDS = ['等待批准', '待产出', '待发布', '等待推送', '已过期', '临近截止', '已逾期']
const DESTRUCTIVE_WORDS = ['失败', '已停用', '需修复', '被阻断', '异常']

export function priorityTone(priority?: string | null) {
  return PRIORITY_TONES[priority || 'P2'] || PRIORITY_TONES.P2
}

export function laneTone(laneId: string) {
  return LANE_TONES[laneId] || 'bg-secondary text-secondary-foreground'
}

export function stageTone(label?: string | null) {
  if (!label) return 'bg-secondary text-secondary-foreground'
  return STAGE_TONES[label] || statusTone(label)
}

export function statusTone(label?: string | null) {
  const text = String(label || '')
  if (!text) return 'bg-secondary text-secondary-foreground'
  if (PRIORITY_TONES[text]) return PRIORITY_TONES[text]
  if (STAGE_TONES[text]) return STAGE_TONES[text]
  if (SUCCESS_WORDS.some((word) => text.includes(word))) return 'bg-success-soft text-success'
  if (DESTRUCTIVE_WORDS.some((word) => text.includes(word))) return 'bg-destructive-soft text-destructive'
  if (WARNING_WORDS.some((word) => text.includes(word))) return 'bg-warning-soft text-warning'
  return 'bg-secondary text-secondary-foreground'
}

const STATUS_LABELS: Record<string, string> = {
  planning: '规划',
  in_progress: '实现中',
  review: '待放行',
  check: '检查中',
  done: '已完成',
  blocked: '被阻断',
  archived: '已归档',
}

export function statusLabel(value?: string | null) {
  const text = String(value || '')
  return STATUS_LABELS[text] || text
}
