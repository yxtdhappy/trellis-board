import type { ReactNode } from 'react'
import { cn } from 'cn'
import type { AuditEvent } from '@/api/admin'
import { statusTone } from '@/lib/admin-shared'

export const controlClass =
  'h-8 w-full min-w-0 rounded-md border border-input bg-input/20 px-2.5 text-xs text-foreground outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30'

const TONE_CLASS: Record<string, string> = {
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-destructive-soft text-destructive',
  neutral: 'bg-muted text-muted-foreground',
}

type PanelProps = {
  kicker?: string
  title?: string
  description?: string
  action?: ReactNode
  className?: string
  children: ReactNode
}

export function Panel({ kicker, title, description, action, className, children }: PanelProps) {
  return (
    <section className={cn('flex flex-col gap-2.5 rounded-xl bg-card p-4', className)}>
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {title ? <h2 className="text-sm font-semibold text-foreground">{title}</h2> : null}
          {kicker || description ? (
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              {kicker ? <span className="font-semibold tracking-[0.14em]">{kicker}</span> : null}
              {kicker && description ? ' · ' : null}
              {description}
            </p>
          ) : null}
        </div>
        {action}
      </header>
      {children}
    </section>
  )
}

export function StatusPill({ value }: { value: string | null | undefined }) {
  return (
    <span
      className={cn(
        'rounded-full px-2 py-0.5 text-2xs font-semibold whitespace-nowrap',
        TONE_CLASS[statusTone(value)],
      )}
    >
      {value || 'unknown'}
    </span>
  )
}

export function EmptyRow({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-lg bg-muted/50 px-3 py-4 text-center text-xs text-muted-foreground">
      {children}
    </p>
  )
}

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
      <StatusPill value={event.result} />
    </article>
  )
}
