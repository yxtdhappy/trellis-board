import { ScrollArea } from '@/components/ui/scroll-area'
import { StatusPill, toneDot } from '@/components/ui/status-pill'
import { laneTone } from './tone.ts'
import type { BoardTask } from './task-view.ts'
import { laneForTask, nextStage, STAGE_LANES, taskProgress } from './task-view.ts'
import { CopyTaskNameButton, TaskCard, type TaskLocalState } from './TaskCard.tsx'
import { taskInstanceKey } from '@/lib/task-view-key.js'
import { cn } from '@/lib/utils'

type KanbanProps = {
  groups: { key: string; parent: BoardTask; members: BoardTask[] }[]
  onOpen: (task: BoardTask) => void
  onEditPlan: (task: BoardTask) => void
  localStateFor?: (task: BoardTask) => TaskLocalState | undefined
  onDownload?: (task: BoardTask) => void
}

export function Kanban({ groups, onOpen, onEditPlan, localStateFor, onDownload }: KanbanProps) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline gap-2">
        <p className="text-2xs font-semibold tracking-[0.08em] text-muted-foreground">
          FLOW / 四个决策槽位
        </p>
        <h2 className="text-sm leading-5 font-semibold font-heading">轻量 Kanban</h2>
        <span className="ml-auto text-2xs text-muted-foreground">
          列只表达决策状态，不表达进度百分比 · 共 {groups.length} 组任务
        </span>
      </div>
      <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2 xl:grid-cols-4">
        {STAGE_LANES.map((lane, laneIndex) => {
          const laneGroups = groups.filter((group) => laneForTask(group.parent) === lane.id)
          return (
            <section
              key={lane.id}
              className="flex min-h-60 max-h-[72vh] flex-col gap-2 rounded-xl bg-muted/60 p-2.5"
            >
              <header className="flex items-center gap-1.5">
                <span
                  className={cn('size-1.5 rounded-full', toneDot(laneTone(lane.id)))}
                  aria-hidden="true"
                />
                <h3 className="text-xs font-semibold">
                  <span className="mr-1 text-2xs text-muted-foreground">
                    {String(laneIndex + 1).padStart(2, '0')}
                  </span>
                  {lane.label}
                </h3>
                <StatusPill tone={laneTone(lane.id)} size="xs">
                  {laneGroups.length}
                </StatusPill>
              </header>

              <ScrollArea className="min-h-0 flex-1">
                <div className="flex flex-col gap-2 pr-1">
                  {laneGroups.length === 0 ? (
                    <p className="rounded-lg border border-dashed border-border/70 px-2 py-3 text-2xs text-muted-foreground">
                      {lane.hint} · 当前无任务
                    </p>
                  ) : (
                    laneGroups.map((group) => {
                      if (group.members.length === 1) {
                        return (
                          <TaskCard
                            key={group.key}
                            task={group.parent}
                            onOpen={onOpen}
                            onEditPlan={onEditPlan}
                            localState={localStateFor?.(group.parent)}
                            onDownload={onDownload}
                          />
                        )
                      }
                      const children = group.members.filter(
                        (task) => task.taskKey !== group.parent.taskKey,
                      )
                      return (
                        <div
                          key={group.key}
                          className="flex flex-col gap-1.5 rounded-lg bg-background/40 p-1.5"
                        >
                          <div className="flex items-center justify-between gap-2 px-1 text-2xs text-muted-foreground">
                            <span className="min-w-0 truncate">
                              父任务 ·{' '}
                              {group.parent.teamName
                                ? `${group.parent.teamName} · ${group.parent.projectName}`
                                : group.parent.projectName}
                            </span>
                            <span className="shrink-0 whitespace-nowrap">
                              {children.length} 个子任务
                            </span>
                          </div>
                          <TaskCard
                            task={group.parent}
                            onOpen={onOpen}
                            onEditPlan={onEditPlan}
                            localState={localStateFor?.(group.parent)}
                            onDownload={onDownload}
                          />
                          {children.length ? (
                            <div className="flex flex-col gap-1 pl-1">
                              <p className="px-1 text-2xs text-muted-foreground">子任务</p>
                              {children.map((child) => {
                                const progress = taskProgress(child)
                                return (
                                  <div
                                    key={taskInstanceKey(child)}
                                    className="group flex items-center gap-1 rounded-md border border-border/70 bg-card shadow-xs transition-colors hover:bg-muted/60"
                                  >
                                    <button
                                      type="button"
                                      onClick={() => onOpen(child)}
                                      className="flex min-w-0 flex-1 items-center gap-2 py-1 pr-1 pl-1.5 text-left text-2xs"
                                    >
                                      <span
                                        className="size-1 shrink-0 rounded-full bg-border"
                                        aria-hidden="true"
                                      />
                                      <span className="flex min-w-0 flex-col">
                                        <b className="truncate font-medium">{child.title}</b>
                                        <small className="truncate text-2xs text-muted-foreground">
                                          {child.teamName
                                            ? `${child.teamName} · ${child.projectName}`
                                            : child.projectName}{' '}
                                          · {child.status}
                                        </small>
                                      </span>
                                      <span className="ml-auto shrink-0 whitespace-nowrap text-2xs text-muted-foreground">
                                        {nextStage(child)?.label} · {progress.percent}%
                                      </span>
                                    </button>
                                    <CopyTaskNameButton
                                      task={child}
                                      compact
                                      className="mr-1 shrink-0 opacity-0 group-hover:opacity-100 focus:opacity-100"
                                    />
                                  </div>
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
