import type { ReactNode } from 'react'
import type { AuditEvent } from '@/api/admin'
import { StatusPill } from '@/components/ui/status-pill'
import { statusTone } from '@/lib/admin-shared'

export function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: ReactNode
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
      {hint ? <span className="text-2xs text-muted-foreground">{hint}</span> : null}
    </label>
  )
}

export function Row({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex min-h-12 items-center justify-between gap-3 border-b border-border py-2 last:border-b-0">
      <div className="min-w-0 flex-1">{children}</div>
      {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
    </div>
  )
}

const ACTION_LABELS: Record<string, string> = {
  'task.create': '创建任务',
  'task.stage.record': '更新任务阶段',
  'artifact.upload': '上传产物',
  'evidence.verify': '阶段证据校验通过',
  'task.assign': '调整负责人',
  'project.member.save': '保存成员',
  task_space_retired: '弃用分支',
  task_space_restored: '恢复分支',
  task_space_purged: '移除分支',
}

function auditClock(value: string | null | undefined) {
  const date = new Date(String(value || ''))
  if (Number.isNaN(date.getTime())) return '—'
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function auditSummary(event: AuditEvent) {
  const detail = (event.detail || {}) as Record<string, unknown>
  const base = ACTION_LABELS[event.action] || event.action || 'unknown'
  const from = typeof detail.from === 'string' ? detail.from : ''
  const to = typeof detail.to === 'string' ? detail.to : ''
  if (from && to) return `${base} ${from} → ${to}`
  if (event.action === 'task.create' && event.targetId) return `${base} ${event.targetId}`
  const branchName = typeof detail.branchName === 'string' ? detail.branchName : ''
  if (event.action.startsWith('task_space_') && branchName) return `${base} ${branchName}`
  const title = typeof detail.title === 'string' ? detail.title : ''
  return title ? `${base} ${title}` : base
}

export function AuditItem({ event }: { event: AuditEvent }) {
  const actor = event.actorUserId || event.actorAgentId || 'system'
  return (
    <article className="flex items-center gap-3 border-b border-border/60 py-2 text-xs last:border-b-0">
      <span className="w-11 shrink-0 text-2xs tabular-nums text-muted-foreground">
        {auditClock(event.occurredAt)}
      </span>
      <span className="w-16 shrink-0 truncate font-medium">{actor}</span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground">{auditSummary(event)}</span>
      <StatusPill tone={statusTone(event.result)} className="whitespace-nowrap">
        {event.result || 'unknown'}
      </StatusPill>
    </article>
  )
}
