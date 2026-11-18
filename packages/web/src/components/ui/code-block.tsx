import type { ComponentProps } from 'react'
import { cn } from 'cn'

export function CodeBlock({ className, ...props }: ComponentProps<'pre'>) {
  return (
    <pre
      className={cn(
        'overflow-auto font-mono text-xs leading-relaxed break-words whitespace-pre-wrap',
        className,
      )}
      {...props}
    />
  )
}
