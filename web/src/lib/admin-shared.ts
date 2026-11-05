export type Tone = 'success' | 'warning' | 'danger' | 'neutral'

export function formatTime(value: string | null | undefined): string {
  if (!value) return '从未'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(date)
}

const TONE_BY_STATUS: Record<string, Tone> = {
  current: 'success',
  active: 'success',
  approved: 'success',
  success: 'success',
  pushed: 'success',
  applied: 'success',
  stale: 'warning',
  pending_push: 'warning',
  pending: 'warning',
  provisioning: 'warning',
  warning: 'warning',
  needs_repair: 'danger',
  failed: 'danger',
  error: 'danger',
  rejected: 'danger',
  revoked: 'danger',
  disabled: 'danger'
}

export function statusTone(status: string | null | undefined): Tone {
  return (status && TONE_BY_STATUS[status]) || 'neutral'
}
