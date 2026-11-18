import type { ReactNode } from 'react'
import { cn } from 'cn'

// 列表/表格内的单行空态。视觉与旧 admin/shared.tsx 的 EmptyRow 一致，块级空态用 ui/empty 的 Empty。
export function EmptyRow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p
      className={cn(
        'rounded-lg bg-muted/50 px-3 py-4 text-center text-xs text-muted-foreground',
        className,
      )}
    >
      {children}
    </p>
  )
}
