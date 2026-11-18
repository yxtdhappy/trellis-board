import type { ReactNode } from 'react'
import { cn } from 'cn'
import { Badge } from '@/components/ui/badge'

export type Tone = 'success' | 'warning' | 'danger' | 'destructive' | 'neutral' | 'info' | 'primary'

const TONE_VARIANT: Record<
  Tone,
  'success' | 'warning' | 'danger' | 'destructive' | 'secondary' | 'info' | 'primary-soft'
> = {
  success: 'success',
  warning: 'warning',
  danger: 'danger',
  destructive: 'destructive',
  neutral: 'secondary',
  info: 'info',
  primary: 'primary-soft',
}

const TONE_DOT: Record<Tone, string> = {
  success: 'bg-success-soft',
  warning: 'bg-warning-soft',
  danger: 'bg-destructive',
  destructive: 'bg-destructive-soft',
  neutral: 'bg-muted-foreground',
  info: 'bg-info-soft',
  primary: 'bg-primary-soft',
}

export function toneDot(tone: Tone) {
  return TONE_DOT[tone]
}

export function StatusPill({
  tone,
  children,
  className,
  title,
  size = 'default',
}: {
  tone: Tone
  children: ReactNode
  className?: string
  title?: string
  size?: 'default' | 'xs'
}) {
  return (
    <Badge
      variant={TONE_VARIANT[tone]}
      size={size}
      className={cn('font-semibold', className)}
      title={title}
    >
      {children}
    </Badge>
  )
}
