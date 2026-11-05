import type { ReactNode } from 'react'
import { cn } from 'cn'
import type { AuditEvent } from '@/api/admin'
import { formatTime, statusTone } from '@/lib/admin-shared'

export const controlClass =
  'h-7 w-full min-w-0 rounded-md border border-input bg-input/20 px-2 text-xs text-foreground outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30'

const TONE_CLASS: Record<string, string> = {
  success: 'bg-secondary text-secondary-foreground',
  warning: 'bg-muted text-muted-foreground',
  danger: 'bg-destructive/10 text-destructive',
  neutral: 'bg-muted text-muted-foreground'
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
          {kicker ? (
            <p className="text-[10px] font-semibold tracking-[0.2em] text-muted-foreground">{kicker}</p>
          ) : null}
          {title ? <h2 className="text-[13.5px] font-semibold text-foreground">{title}</h2> : null}
        </div>
        {action}
      </header>
      {description ? (
        <p className="text-[11px] leading-relaxed text-muted-foreground">{description}</p>
      ) : null}
      {children}
    </section>
  )
}

export function StatusPill({ value }: { value: string | null | undefined }) {
  return (
    <span
      className={cn(
        'rounded-full px-2 py-0.5 text-[10px] font-semibold whitespace-nowrap',
        TONE_CLASS[statusTone(value)]
      )}
    >
      {value || 'unknown'}
    </span>
  )
}

export function EmptyRow({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-lg bg-muted/50 px-3 py-4 text-center text-[11px] text-muted-foreground">
      {children}
    </p>
  )
}

export function Field({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: ReactNode
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
      {children}
      {hint ? <span className="text-[10px] text-muted-foreground">{hint}</span> : null}
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

export function AuditItem({ event }: { event: AuditEvent }) {
  const detail = JSON.stringify(event.detail ?? {}, null, 2)
  return (
    <article className="flex flex-col gap-1 border-b border-border py-2.5 last:border-b-0">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-muted-foreground">{formatTime(event.occurredAt)}</span>
        <StatusPill value={event.result} />
      </div>
      <p className="text-xs font-medium text-foreground">{event.action || 'unknown'}</p>
      <p className="text-[11px] text-muted-foreground">
        目标 {event.targetType || 'unknown'} <code>{event.targetId || '-'}</code> · 项目{' '}
        <code>{event.projectId || '全局'}</code>
      </p>
      <p className="text-[11px] text-muted-foreground">
        操作者 {event.actorUserId || event.actorAgentId || 'system'} · 关联 ID{' '}
        <code>{event.correlationId || '-'}</code>
      </p>
      {detail !== '{}' ? (
        <pre className="max-h-40 overflow-auto rounded-md bg-muted/60 p-2 text-[10px] text-muted-foreground">
          {detail}
        </pre>
      ) : null}
    </article>
  )
}
