import { Share2 } from 'lucide-react'
import { toast } from 'sonner'
import { copyText } from '@/browser/clipboard.js'
import { Button } from '@/components/ui/button'
import { buildShareUrl, taskIdFromExecutionKey } from '@/lib/share-link.ts'
import { cn } from '@/lib/utils'
import type { BoardTask } from './task-view.ts'

type ShareTaskButtonProps = {
  task: BoardTask
  compact?: boolean
  className?: string
}

/** 复制网页中转链接：接收方点开后由 share.html 唤起客户端。 */
export function ShareTaskButton({ task, compact = false, className = '' }: ShareTaskButtonProps) {
  const taskId = taskIdFromExecutionKey(task.executionTaskKey)
  const disabled = !task.taskSpaceId || !taskId
  const label = disabled ? '该任务缺少分享所需的任务空间信息' : '复制任务分享链接'

  async function share() {
    if (!task.taskSpaceId || !taskId) return
    const url = buildShareUrl({
      origin: location.origin,
      taskSpaceId: task.taskSpaceId,
      taskId,
    })
    if (await copyText(url)) toast.success('分享链接已复制，发给同事即可打开')
    else toast.error('复制分享链接失败')
  }

  if (!compact) {
    return (
      <Button
        variant="outline"
        className={cn('gap-1.5', className)}
        onClick={share}
        disabled={disabled}
        title={label}
        aria-label={`复制任务 ${task.title} 的分享链接`}
      >
        <Share2 className="size-3.5" aria-hidden="true" />
        分享
      </Button>
    )
  }

  // 卡片悬浮层按 CopyTaskNameButton 的做法用裸按钮，尺寸比设计系统按钮更小。
  return (
    <button
      type="button"
      className={cn(
        'flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-2xs text-muted-foreground hover:bg-muted disabled:opacity-50',
        className,
      )}
      onClick={share}
      disabled={disabled}
      title={label}
      aria-label={`复制任务 ${task.title} 的分享链接`}
    >
      <Share2 className="size-2.5" aria-hidden="true" />
    </button>
  )
}
