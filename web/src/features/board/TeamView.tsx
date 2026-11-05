import { useMemo, useState } from 'react'
import { Input } from '@/components/ui/input'
import { tasksByOwner } from './selectors'
import { isAttention, initials, nextStage, taskProgress, type BoardTask } from './task-view'

type TeamViewProps = {
  tasks: BoardTask[]
  onOpen: (task: BoardTask) => void
  loading: boolean
  summary: string
}

export function TeamView({ tasks, onOpen, loading, summary }: TeamViewProps) {
  const [search, setSearch] = useState('')
  const owners = useMemo(() => tasksByOwner(tasks), [tasks])
  const keyword = search.trim().toLowerCase()
  const visible = owners.filter(([owner]) => !keyword || owner.toLowerCase().includes(keyword))

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div>
          <h1 className="text-[19px] leading-6 font-semibold font-heading">团队任务队列</h1>
          <p className="text-[11.5px] text-muted-foreground">{summary || '按负责人统计 · 跨项目混合排序'}</p>
        </div>
        <Input
          className="ml-auto h-8 w-56 text-xs"
          placeholder="按负责人筛选"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>

      {loading ? (
        <p className="rounded-xl bg-card px-4 py-10 text-center text-xs text-muted-foreground">正在读取团队任务…</p>
      ) : visible.length === 0 ? (
        <p className="rounded-xl bg-card px-4 py-10 text-center text-xs text-muted-foreground">
          团队视图没有可展示的任务
        </p>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-2.5 overflow-auto lg:grid-cols-2 2xl:grid-cols-3">
          {visible.map(([owner, ownerTasks]) => (
            <article key={owner} className="flex flex-col gap-1.5 rounded-xl bg-card p-3">
              <header className="flex items-center gap-2 border-b border-border/60 pb-2">
                <span className="flex size-6 items-center justify-center rounded-full bg-secondary text-[9px] font-semibold text-muted-foreground">
                  {initials(owner)}
                </span>
                <div className="flex flex-col">
                  <strong className="text-[12.5px]">{owner}</strong>
                  <small className="text-[10px] text-muted-foreground">{ownerTasks.length} 个进行中任务</small>
                </div>
                <span className="ml-auto rounded-full bg-destructive/10 px-2 py-0.5 text-[10px] font-semibold text-destructive">
                  {ownerTasks.filter(isAttention).length} 需关注
                </span>
              </header>
              <ul className="flex flex-col">
                {ownerTasks.map((task) => {
                  const progress = taskProgress(task)
                  return (
                    <li key={task.taskKey}>
                      <button
                        type="button"
                        onClick={() => onOpen(task)}
                        className="flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left hover:bg-muted/60"
                      >
                        <span className="flex min-w-0 flex-col">
                          <b className="truncate text-[11.5px] font-medium">{task.title}</b>
                          <small className="truncate text-[10px] text-muted-foreground">
                            {task.projectName} · {task.status}
                          </small>
                        </span>
                        <span className="ml-auto whitespace-nowrap rounded-full bg-muted px-1.5 py-0.5 text-[9.5px] text-muted-foreground">
                          {nextStage(task)?.label}
                        </span>
                        <span className="w-9 text-right text-[9.5px] text-muted-foreground">{progress.percent}%</span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            </article>
          ))}
        </div>
      )}
    </div>
  )
}
