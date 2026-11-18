import type { Tone } from '@/components/ui/status-pill'

const PRIORITY_TONES: Record<string, Tone> = {
  P0: 'danger',
  P1: 'warning',
  P2: 'neutral',
  P3: 'neutral',
}

const LANE_TONES: Record<string, Tone> = {
  planning: 'info',
  review: 'warning',
  implementation: 'primary',
  verification: 'success',
}

const STAGE_TONES: Record<string, Tone> = {
  规划: 'info',
  待放行: 'warning',
  实现: 'primary',
  实现中: 'primary',
  检查: 'success',
  检查中: 'success',
  检查·收尾: 'success',
  planning: 'info',
  in_progress: 'primary',
  review: 'warning',
  check: 'success',
  done: 'success',
}

const SUCCESS_WORDS = ['成功', '已启用', '已产出', '已同步', '已应用', '已批准', '在线', '已归档']
const WARNING_WORDS = ['等待批准', '待产出', '待发布', '等待推送', '已过期', '临近截止', '已逾期']
const DESTRUCTIVE_WORDS = ['失败', '已停用', '需修复', '被阻断', '异常']

export function priorityTone(priority?: string | null): Tone {
  return PRIORITY_TONES[priority || 'P2'] || 'neutral'
}

export function laneTone(laneId: string): Tone {
  return LANE_TONES[laneId] || 'neutral'
}

export function stageTone(label?: string | null): Tone {
  if (!label) return 'neutral'
  return STAGE_TONES[label] || statusTone(label)
}

export function statusTone(label?: string | null): Tone {
  const text = String(label || '')
  if (!text) return 'neutral'
  if (PRIORITY_TONES[text]) return PRIORITY_TONES[text]
  if (STAGE_TONES[text]) return STAGE_TONES[text]
  if (SUCCESS_WORDS.some((word) => text.includes(word))) return 'success'
  if (DESTRUCTIVE_WORDS.some((word) => text.includes(word))) return 'destructive'
  if (WARNING_WORDS.some((word) => text.includes(word))) return 'warning'
  return 'neutral'
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
