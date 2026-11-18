import { ScrollArea } from '@/components/ui/scroll-area'
import { StatusPill } from '@/components/ui/status-pill'
import { priorityTone } from './tone.ts'
import {
  attentionReasons,
  branchLabel,
  dueLabel,
  isAttention,
  type BoardTask,
} from './task-view.ts'
import { taskInstanceKey } from '@/lib/task-view-key.js'

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
        <StatusPill tone="destructive" size="xs">
          {queue.length}
        </StatusPill>
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
                  <StatusPill tone={priorityTone(task.priority)} size="xs" className="shrink-0">
                    {task.priority || 'P2'}
                  </StatusPill>
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
                        <StatusPill
                          key={reason.id}
                          tone="destructive"
                          size="xs"
                          className="font-medium"
                        >
                          {reason.label}
                        </StatusPill>
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
