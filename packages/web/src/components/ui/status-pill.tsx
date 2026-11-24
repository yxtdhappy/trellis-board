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
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-destructive',
  destructive: 'bg-destructive',
  neutral: 'bg-muted-foreground',
  info: 'bg-info',
  primary: 'bg-primary',
}

export function toneDot(tone: Tone) {
  return TONE_DOT[tone]
}

// 面状提示（提示条 / 条件卡片 / 图标底板）：bg-*-soft 与 text-* 只在这里出现
type SurfaceTone = 'success' | 'warning' | 'destructive'

const TONE_SURFACE: Record<SurfaceTone, string> = {
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning',
  destructive: 'bg-destructive-soft text-destructive',
}

const TONE_SURFACE_QUIET: Record<SurfaceTone, string> = {
  success: 'bg-success-soft/50 text-success',
  warning: 'bg-warning-soft/50 text-warning',
  destructive: 'bg-destructive-soft/50 text-destructive',
}

export function toneSurface(tone: SurfaceTone, quiet = false): string {
  return quiet ? TONE_SURFACE_QUIET[tone] : TONE_SURFACE[tone]
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
