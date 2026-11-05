import { dueLabel, isAttention, attentionReasons, recommendedTask, type BoardTask } from './task-view'

type AttentionQueueProps = {
  tasks: BoardTask[]
  onOpen: (task: BoardTask) => void
}

export function AttentionQueue({ tasks, onOpen }: AttentionQueueProps) {
  const queue = tasks.filter(isAttention)
  const top = recommendedTask(queue)

  if (!queue.length) {
    return (
      <section className="rounded-xl border border-border/70 bg-card px-3 py-2.5">
        <h2 className="text-[11px] font-semibold text-muted-foreground">注意力队列</h2>
        <p className="mt-1 text-[11px] text-muted-foreground">当前没有逾期、截止、停滞与阶段信号。</p>
      </section>
    )
  }

  return (
    <section className="flex flex-col gap-1.5 rounded-xl border border-border/70 bg-card px-3 py-2.5">
      <div className="flex items-center gap-2">
        <h2 className="text-[11px] font-semibold text-muted-foreground">注意力队列</h2>
        <span className="rounded-full bg-destructive/10 px-1.5 py-px text-[10px] font-semibold text-destructive">
          {queue.length}
        </span>
        <span className="ml-auto text-[10.5px] text-muted-foreground">逾期、截止、停滞与阶段信号</span>
      </div>
      <ul className="flex flex-col divide-y divide-border/60">
        {queue.slice(0, 5).map((task) => (
          <li key={task.taskKey}>
            <button
              type="button"
              onClick={() => onOpen(task)}
              className="flex w-full items-center gap-2 py-1.5 text-left hover:bg-muted/50"
            >
              <span className="truncate text-[11.5px] font-medium">{task.title}</span>
              <span className="shrink-0 text-[10px] text-muted-foreground">{task.projectName}</span>
              <span className="ml-auto flex shrink-0 items-center gap-1">
                {attentionReasons(task)
                  .slice(0, 2)
                  .map((reason) => (
                    <span
                      key={reason.id}
                      className="rounded-full bg-destructive/10 px-1.5 py-px text-[9.5px] font-medium text-destructive"
                    >
                      {reason.label}
                    </span>
                  ))}
                <span className="text-[10px] text-muted-foreground">{dueLabel(task.execution?.dueDate)}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {top && queue.length > 5 ? (
        <p className="text-[10.5px] text-muted-foreground">
          共 {queue.length} 个信号 · 建议先处理「{top.title}」
        </p>
      ) : null}
    </section>
  )
}
