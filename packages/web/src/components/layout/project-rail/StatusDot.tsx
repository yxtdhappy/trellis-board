import { cn } from '@/lib/utils'
export function StatusDot({ className }: { className?: string }) {
  return <span className={cn('size-1.5 shrink-0 rounded-full', className)} aria-hidden="true" />
}
