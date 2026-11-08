import { ScrollArea } from '@/components/ui/scroll-area'
import { laneTone } from './tone'
import type { BoardTask } from './task-view'
import { laneForTask, nextStage, STAGE_LANES, taskProgress } from './task-view'
import { TaskCard } from './TaskCard'

type KanbanProps = {
  groups: { key: string; parent: BoardTask; members: BoardTask[] }[]
  onOpen: (task: BoardTask) => void
  onEditPlan: (task: BoardTask) => void
}

export function Kanban({ groups, onOpen, onEditPlan }: KanbanProps) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline gap-2">
        <p className="text-[10px] font-semibold tracking-[0.08em] text-muted-foreground">
          FLOW / 四个决策槽位
        </p>
        <h2 className="text-[14.5px] leading-5 font-semibold font-heading">轻量 Kanban</h2>
        <span className="ml-auto text-[10.5px] text-muted-foreground">
          列只表达决策状态，不表达进度百分比 · 共 {groups.length} 组任务
        </span>
      </div>
      <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2 xl:grid-cols-4">
      {STAGE_LANES.map((lane, laneIndex) => {
        const laneGroups = groups.filter((group) => laneForTask(group.parent) === lane.id)
        return (
          <section key={lane.id} className="flex min-h-[100vh] flex-col gap-2 rounded-xl bg-muted/60 p-2.5">
            <header className="flex items-center gap-1.5">
              <span className={`size-1.5 rounded-full ${laneTone(lane.id).split(' ')[0]}`} aria-hidden="true" />
              <h3 className="text-[12.5px] font-semibold">
                <span className="mr-1 text-[10px] text-muted-foreground">
                  {String(laneIndex + 1).padStart(2, '0')}
                </span>
                {lane.label}
              </h3>
              <span className={`rounded-full px-1.5 py-px text-[10px] font-semibold ${laneTone(lane.id)}`}>
                {laneGroups.length}
              </span>
            </header>

            <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-2 pr-1">
              {laneGroups.length === 0 ? (
                <p className="rounded-lg border border-dashed border-border/70 px-2 py-3 text-[10.5px] text-muted-foreground">
                  {lane.hint} · 当前无任务
                </p>
              ) : (
                laneGroups.map((group) => {
                  if (group.members.length === 1) {
                    return (
                      <TaskCard key={group.key} task={group.parent} onOpen={onOpen} onEditPlan={onEditPlan} />
                    )
                  }
                  const children = group.members.filter((task) => task.taskKey !== group.parent.taskKey)
                  return (
                    <div key={group.key} className="flex flex-col gap-1.5 rounded-lg bg-background/40 p-1.5">
                      <div className="flex items-center justify-between px-1 text-[9.5px] text-muted-foreground">
                        <span className="truncate">
                          父任务 · {group.parent.teamName
                            ? `${group.parent.teamName} · ${group.parent.projectName}`
                            : group.parent.projectName}
                        </span>
                        <span>{children.length} 个子任务</span>
                      </div>
                      <TaskCard task={group.parent} onOpen={onOpen} onEditPlan={onEditPlan} showCopy={false} />
                      {children.length ? (
                        <div className="flex flex-col gap-0.5 pl-1">
                          <p className="px-1 text-[9.5px] text-muted-foreground">子任务</p>
                          {children.map((child) => {
                            const progress = taskProgress(child)
                            return (
                              <button
                                key={child.taskKey}
                                type="button"
                                onClick={() => onOpen(child)}
                                className="flex items-center gap-2 rounded-md px-1.5 py-1 text-left text-[10.5px] hover:bg-muted"
                              >
                                <span className="size-1 rounded-full bg-border" aria-hidden="true" />
                                <span className="flex min-w-0 flex-col">
                                  <b className="truncate font-medium">{child.title}</b>
                                  <small className="truncate text-[9.5px] text-muted-foreground">
                                    {child.teamName
                                      ? `${child.teamName} · ${child.projectName}`
                                      : child.projectName}{" "}
                                    · {child.status}
                                  </small>
                                </span>
                                <span className="ml-auto whitespace-nowrap text-[9.5px] text-muted-foreground">
                                  {nextStage(child)?.label} · {progress.percent}%
                                </span>
                              </button>
                            )
                          })}
                        </div>
                      ) : null}
                    </div>
                  )
                })
              )}
            </div>
            </ScrollArea>
          </section>
        )
      })}
      </div>
    </div>
  )
}
