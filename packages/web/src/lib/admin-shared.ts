import type { Tone } from '@/components/ui/status-pill'

export type { Tone }

export function formatTime(value: string | null | undefined): string {
  if (!value) return '从未'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}

const TONE_BY_STATUS: Record<string, Tone> = {
  current: 'success',
  active: 'success',
  approved: 'success',
  success: 'success',
  running: 'success',
  stale: 'warning',
  pending: 'warning',
  warning: 'warning',
  retired: 'warning',
  starting: 'warning',
  'missing-secret': 'warning',
  syncing: 'info',
  importing: 'info',
  indexing: 'info',
  needs_repair: 'destructive',
  failed: 'destructive',
  error: 'destructive',
  index_error: 'destructive',
  rejected: 'destructive',
  revoked: 'destructive',
  disabled: 'destructive',
  crashing: 'destructive',
  incompatible: 'destructive',
}

export function statusTone(status: string | null | undefined): Tone {
  return (status && TONE_BY_STATUS[status]) || 'neutral'
}
