import type { ReactNode } from 'react'
import { cn } from 'cn'

export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p className={cn('text-2xs font-semibold tracking-[0.2em] text-muted-foreground', className)}>
      {children}
    </p>
  )
}
