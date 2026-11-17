import { Copy } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { copyText } from '@/browser/clipboard.js'
import { conditionBadges } from '@/lib/condition-checks.js'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import {
  attentionReasons,
  branchLabel,
  controlToneClass,
  dueLabel,
  initials,
  isAttention,
  nextStage,
  taskProgress,
  taskTags,
  type BoardTask,
} from './task-view.ts'
import { StageTape } from './StageTape.tsx'
import { priorityTone } from './tone.ts'
import { taskControlView } from '@/lib/team-client.js'

type TaskCardProps = {
  task: BoardTask
  onOpen: (task: BoardTask) => void
  onEditPlan?: (task: BoardTask) => void
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

export function TaskCard({ task, onOpen, onEditPlan }: TaskCardProps) {
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
      <div className="flex items-start gap-2">
        <span className="truncate text-2xs text-muted-foreground">{projectLabel}</span>
        <div className="ml-auto flex items-center gap-1">
          {task.groupRelationsValid === false ? (
            <Badge variant="outline" className="h-4 rounded-full px-1.5 text-2xs text-destructive">
              关系异常
            </Badge>
          ) : null}
          <span
            className={cn(
              'rounded-full px-1.5 py-px text-2xs font-semibold',
              priorityTone(task.priority),
            )}
          >
            {task.priority || 'P2'}
          </span>
        </div>
      </div>

      {control.available ? (
        <div className="flex flex-wrap items-center gap-1">
          <span
            className={cn(
              'rounded-full px-1.5 py-px text-2xs font-medium',
              controlToneClass(control.tone),
            )}
            title={control.description}
          >
            {control.label}
          </span>
        </div>
      ) : null}

      <h4 className="line-clamp-2 text-xs leading-4 font-semibold text-foreground">{task.title}</h4>
      <p className="break-all text-2xs leading-3.5 text-muted-foreground">{task.dirName}</p>

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
            <span
              key={reason.id}
              className="rounded-full bg-destructive/10 px-1.5 py-px text-2xs font-medium text-destructive"
            >
              {reason.label}
            </span>
          ))}
        </div>
      ) : null}

      <div className="flex items-center gap-1.5 text-2xs text-muted-foreground">
        <span className="flex size-4 items-center justify-center rounded-full bg-secondary text-2xs font-semibold">
          {initials(task.assignee)}
        </span>
        <span className="truncate">{task.assignee || '未派发'}</span>
        <span className="ml-auto whitespace-nowrap">
          {next?.label} · {progress.percent}%
        </span>
      </div>

      <div className="relative flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        {onEditPlan ? (
          <button
            type="button"
            className="rounded-md border border-border px-1.5 py-0.5 text-2xs text-muted-foreground hover:bg-muted"
            onClick={() => onEditPlan(task)}
            disabled={task.archived}
            title={task.archived ? '归档任务只读' : '编辑计划字段'}
          >
            计划
          </button>
        ) : null}
        <CopyTaskNameButton task={task} />
      </div>
    </article>
  )
}
