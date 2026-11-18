import type { ComponentProps, ElementType, ReactNode } from 'react'
import { cn } from 'cn'

type PanelTag = 'section' | 'div' | 'aside' | 'article'

type PanelProps = {
  kicker?: string
  title?: string
  description?: string
  action?: ReactNode
  as?: PanelTag
  className?: string
  children: ReactNode
} & Omit<ComponentProps<'section'>, 'children' | 'className' | 'title' | 'ref'>

export function Panel({
  kicker,
  title,
  description,
  action,
  as = 'section',
  className,
  children,
  ...props
}: PanelProps) {
  const Tag = as as ElementType
  const hasHeader = Boolean(kicker || title || description || action)
  return (
    <Tag className={cn('flex flex-col gap-2.5 rounded-xl bg-card p-4', className)} {...props}>
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
    </Tag>
  )
}
