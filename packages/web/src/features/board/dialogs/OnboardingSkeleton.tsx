import { Loader2 } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'

export function OnboardingSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-busy="true" aria-live="polite">
      <p className="flex items-center gap-2 text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        正在读取本地仓库信息…
      </p>
      <div className="flex flex-col gap-2 rounded-lg bg-muted/40 p-3">
        <Skeleton className="h-3.5 w-3/4" />
        <Skeleton className="h-3.5 w-1/2" />
        <Skeleton className="h-3.5 w-11/12" />
        <Skeleton className="h-3.5 w-2/3" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Skeleton className="h-14" />
        <Skeleton className="h-14" />
      </div>
    </div>
  )
}
