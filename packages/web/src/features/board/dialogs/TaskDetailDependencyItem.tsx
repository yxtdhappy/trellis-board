import { Button } from '@/components/ui/button'
import type { DependencyRecord } from '../task-view.ts'

export function DependencyItem({
  item,
  relation,
  disabled,
  onResolve,
}: {
  item: DependencyRecord
  relation: 'blocked' | 'blocks'
  disabled?: boolean
  onResolve?: () => void
}) {
  return (
    <article className="flex flex-col gap-1 rounded-lg bg-muted px-2.5 py-2 text-xs">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="rounded-full bg-background px-1.5 py-0.5 text-2xs font-semibold text-muted-foreground">
          {relation === 'blocked' ? '阻断我' : '我阻断'}
        </span>
        <strong className="text-xs font-semibold">{item.title || '未命名任务'}</strong>
        <small className="text-2xs text-muted-foreground">
          {item.projectName || ''}
          {item.createdBy ? ` · ${item.createdBy}` : ''}
        </small>
      </div>
      <p className="text-2xs text-muted-foreground">{item.reason || '未记录原因'}</p>
      <div className="flex items-center gap-2">
        <time className="text-2xs text-muted-foreground" dateTime={item.createdAt}>
          {item.createdAt ? new Date(item.createdAt).toLocaleString('zh-CN') : '时间未知'}
        </time>
        {onResolve ? (
          <Button
            variant="ghost"
            size="xs"
            className="ml-auto"
            disabled={disabled}
            onClick={onResolve}
          >
            解除依赖
          </Button>
        ) : null}
      </div>
    </article>
  )
}
