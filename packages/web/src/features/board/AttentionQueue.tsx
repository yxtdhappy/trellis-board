import { ScrollArea } from '@/components/ui/scroll-area'
import { priorityTone } from './tone.ts'
import {
  attentionReasons,
  branchLabel,
  dueLabel,
  isAttention,
  type BoardTask,
} from './task-view.ts'
import { taskInstanceKey } from '@/lib/task-view-key.js'
import { cn } from '@/lib/utils'

type AttentionQueueProps = {
  tasks: BoardTask[]
  onOpen: (task: BoardTask) => void
}

const MAX_ROWS = 6

export function AttentionQueue({ tasks, onOpen }: AttentionQueueProps) {
  const queue = tasks.filter(isAttention)

  return (
    <section className="flex flex-col gap-2 rounded-xl border border-border bg-card p-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <p className="text-2xs font-semibold tracking-[0.08em] text-muted-foreground">
          ATTENTION QUEUE
        </p>
        <h2 className="text-sm leading-5 font-semibold font-heading">注意力队列</h2>
        <span className="rounded-full bg-destructive-soft px-1.5 py-px text-2xs font-semibold text-destructive">
          {queue.length}
        </span>
        <span className="ml-auto text-2xs text-muted-foreground">每行一个信号，按紧急程度排列</span>
      </div>

      {queue.length === 0 ? (
        <p className="text-xs text-muted-foreground">当前没有逾期、截止、停滞与阶段信号。</p>
      ) : (
        <ScrollArea className="max-h-49">
          <ul className="flex flex-col divide-y divide-border/60 pr-2">
            {queue.slice(0, MAX_ROWS).map((task) => (
              <li key={taskInstanceKey(task)}>
                <button
                  type="button"
                  onClick={() => onOpen(task)}
                  className="flex w-full items-center gap-2 py-1.5 text-left hover:bg-muted/50"
                >
                  <span
                    className={cn(
                      'shrink-0 rounded-full px-1.5 py-px text-2xs font-semibold',
                      priorityTone(task.priority),
                    )}
                  >
                    {task.priority || 'P2'}
                  </span>
                  <span className="truncate text-xs font-medium">{task.title}</span>
                  <span className="shrink-0 text-2xs text-muted-foreground">
                    {[task.teamName, task.projectName, branchLabel(task)]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                  <span className="ml-auto flex shrink-0 items-center gap-1">
                    {attentionReasons(task)
                      .slice(0, 2)
                      .map((reason) => (
                        <span
                          key={reason.id}
                          className="rounded-full bg-destructive-soft px-1.5 py-px text-2xs font-medium text-destructive"
                        >
                          {reason.label}
                        </span>
                      ))}
                    <span className="text-2xs text-muted-foreground">
                      {dueLabel(task.execution?.dueDate)}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </ScrollArea>
      )}

      <p className="text-2xs text-muted-foreground">
        按逾期、截止、优先级、检查、实现和停滞排序。
        {queue.length > MAX_ROWS ? ` 另有 ${queue.length - MAX_ROWS} 个信号未展开。` : ''}
      </p>
    </section>
  )
}
