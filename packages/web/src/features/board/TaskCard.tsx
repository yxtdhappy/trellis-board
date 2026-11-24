import { Copy, Download } from 'lucide-react'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { copyText } from '@/browser/clipboard.js'
import { conditionBadges } from '@/lib/condition-checks.js'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import {
  attentionReasons,
  branchLabel,
  controlTone,
  dueLabel,
  initials,
  isAttention,
  nextStage,
  taskProgress,
  taskTags,
  type BoardTask,
} from './task-view.ts'
import { StageTape } from './StageTape.tsx'
import { StatusPill, toneSurface } from '@/components/ui/status-pill'
import { priorityTone } from './tone.ts'
import { taskControlView } from '@/lib/team-client.js'
import { ShareTaskButton } from './ShareTaskButton.tsx'

export type TaskLocalState = 'local' | 'readonly' | 'remote'

type TaskCardProps = {
  task: BoardTask
  onOpen: (task: BoardTask) => void
  onEditPlan?: (task: BoardTask) => void
  localState?: TaskLocalState
  onDownload?: (task: BoardTask) => void
}

type CopyTaskNameButtonProps = {
  task: BoardTask
  compact?: boolean
  className?: string
}

export function CopyTaskNameButton({
  task,
  compact = false,
  className = '',
}: CopyTaskNameButtonProps) {
  async function copyName() {
    if (await copyText(task.dirName)) {
      toast.success('已复制')
    } else {
      toast.error('复制失败')
    }
  }

  return (
    <button
      type="button"
      className={cn(
        'flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-2xs text-muted-foreground hover:bg-muted',
        className,
      )}
      onClick={copyName}
      title={`复制任务名：${task.dirName}`}
      aria-label={`复制任务名：${task.dirName}`}
    >
      <Copy className="size-2.5" />
      {compact ? null : '复制任务名'}
    </button>
  )
}

export function TaskCard({ task, onOpen, onEditPlan, localState, onDownload }: TaskCardProps) {
  const progress = taskProgress(task)
  const next = nextStage(task)
  const tags = taskTags(task)
  const conditions = conditionBadges(task)
  const attention = attentionReasons(task).slice(0, 3)
  const control = taskControlView(task)
  const projectLabel = [task.teamName, task.projectName, branchLabel(task)]
    .filter(Boolean)
    .join(' · ')

  return (
    <article
      className={
        isAttention(task)
          ? 'group relative flex flex-col gap-2 rounded-lg border border-destructive/30 bg-card p-2.5 shadow-xs'
          : 'group relative flex flex-col gap-2 rounded-lg border border-border/70 bg-card p-2.5 shadow-xs'
      }
    >
      <button
        type="button"
        className="absolute inset-0 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={`打开任务 ${task.title}`}
        onClick={() => onOpen(task)}
      />
      <div className="flex items-center gap-2">
        <span className="min-w-0 truncate text-2xs text-muted-foreground">{projectLabel}</span>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {task.groupRelationsValid === false ? (
            <StatusPill tone="destructive" size="xs">
              关系异常
            </StatusPill>
          ) : null}
          <StatusPill tone={priorityTone(task.priority)} size="xs">
            {task.priority || 'P2'}
          </StatusPill>
        </div>
      </div>

      {control.available ? (
        <div className="flex flex-wrap items-center gap-1">
          <StatusPill
            tone={controlTone(control.tone)}
            size="xs"
            className="font-medium"
            title={control.description}
          >
            {control.label}
          </StatusPill>
        </div>
      ) : null}

      <h4 className="line-clamp-2 text-xs leading-4 font-semibold text-foreground">{task.title}</h4>
      <p className="break-all text-2xs leading-3.5 text-muted-foreground">{task.dirName}</p>

      {localState ? (
        <div className="relative flex flex-wrap items-center gap-1 text-2xs">
          {localState === 'remote' ? (
            <button
              type="button"
              className={cn(
                'relative flex items-center gap-1 rounded-full border border-warning/35 px-1.5 py-px font-medium hover:brightness-95 dark:hover:brightness-110 disabled:opacity-60',
                toneSurface('warning'),
              )}
              title="下载到本机"
              aria-label={`下载任务 ${task.dirName} 到本机`}
              disabled={!onDownload}
              onClick={() => onDownload?.(task)}
            >
              <Download className="size-2.5" aria-hidden="true" />
              未下载到本机
            </button>
          ) : (
            <StatusPill
              tone={localState === 'readonly' ? 'neutral' : 'success'}
              size="xs"
              className="font-medium"
            >
              {localState === 'readonly' ? '已在本机（只读）' : '已在本机'}
            </StatusPill>
          )}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-1 text-2xs text-muted-foreground">
        <span>{dueLabel(task.execution?.dueDate)}</span>
        {task.execution?.milestone ? (
          <span className="text-foreground/70">{task.execution.milestone}</span>
        ) : null}
        {tags.slice(0, 2).map((tag) => (
          <span key={tag} className="rounded-sm bg-muted px-1 py-px text-2xs">
            {tag}
          </span>
        ))}
        {conditions.map((condition) => (
          <span key={condition.kind} className="rounded-sm bg-muted px-1 py-px text-2xs">
            {condition.label}
          </span>
        ))}
      </div>

      <StageTape stages={task.stages} current={task.derivedStage} />

      {attention.length ? (
        <div className="flex flex-wrap gap-1">
          {attention.map((reason) => (
            <StatusPill key={reason.id} tone="destructive" size="xs">
              {reason.label}
            </StatusPill>
          ))}
        </div>
      ) : null}

      <div className="relative flex items-center gap-1.5 text-2xs text-muted-foreground">
        <Avatar className="size-4 shrink-0 after:hidden">
          <AvatarFallback className="bg-secondary text-2xs font-semibold">
            {initials(task.assignee)}
          </AvatarFallback>
        </Avatar>
        <span className="min-w-0 truncate">{task.assignee || '未派发'}</span>
        <span className="ml-auto shrink-0 whitespace-nowrap">
          {next?.label} · {progress.percent}%
        </span>
        <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center gap-1 rounded-md bg-card/95 pl-1.5 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100">
          {onEditPlan ? (
            <button
              type="button"
              className="rounded-md border border-border bg-card px-1.5 py-0.5 text-2xs text-muted-foreground hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
              onClick={() => onEditPlan(task)}
              disabled={task.archived}
              title={task.archived ? '归档任务只读' : '编辑计划字段'}
            >
              计划
            </button>
          ) : null}
          <ShareTaskButton task={task} compact className="bg-card" />
          <CopyTaskNameButton task={task} className="bg-card" />
        </div>
      </div>
    </article>
  )
}
