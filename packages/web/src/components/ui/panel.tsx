import type { ReactNode } from 'react'
import { cn } from 'cn'

type PanelProps = {
  kicker?: string
  title?: string
  description?: string
  action?: ReactNode
  className?: string
  children: ReactNode
}

export function Panel({ kicker, title, description, action, className, children }: PanelProps) {
  const hasHeader = Boolean(kicker || title || description || action)
  return (
    <section className={cn('flex flex-col gap-2.5 rounded-xl bg-card p-4', className)}>
      {hasHeader ? (
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
      ) : null}
      {children}
    </section>
  )
}
