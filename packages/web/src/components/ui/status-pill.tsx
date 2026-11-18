import type { ReactNode } from 'react'
import { cn } from 'cn'
import { Badge } from '@/components/ui/badge'

export type Tone = 'success' | 'warning' | 'danger' | 'neutral' | 'info'

const TONE_VARIANT: Record<Tone, 'success' | 'warning' | 'destructive' | 'secondary' | 'outline'> =
  {
    success: 'success',
    warning: 'warning',
    danger: 'destructive',
    neutral: 'secondary',
    info: 'outline',
  }

export function StatusPill({
  tone,
  children,
  className,
}: {
  tone: Tone
  children: ReactNode
  className?: string
}) {
  return (
    <Badge variant={TONE_VARIANT[tone]} className={cn('font-semibold', className)}>
      {children}
    </Badge>
  )
}
