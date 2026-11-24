import { cn } from '@/lib/utils'

type StatTileProps = {
  label: string
  value: number
  suffix?: string
  caption: string
  tone?: string
  className?: string
  valueClassName?: string
  captionClassName?: string
}

export function StatTile({
  label,
  value,
  suffix,
  caption,
  tone,
  className,
  valueClassName,
  captionClassName,
}: StatTileProps) {
  return (
    <div className={cn('flex min-w-0 flex-col', className)}>
      <p className="text-2xs text-muted-foreground">{label}</p>
      <p
        className={cn(
          'text-xl leading-6 font-semibold font-heading tabular-nums',
          valueClassName,
          tone,
        )}
      >
        {value}
        {suffix ? (
          <span className="text-xs font-normal text-muted-foreground">{suffix}</span>
        ) : null}
      </p>
      <p className={cn('text-2xs text-muted-foreground', captionClassName)}>{caption}</p>
    </div>
  )
}
