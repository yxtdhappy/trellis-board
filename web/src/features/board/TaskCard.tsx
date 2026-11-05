import { Copy } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { toast } from 'sonner'
import {
  attentionReasons,
  dueLabel,
  initials,
  isAttention,
  nextStage,
  taskProgress,
  taskTags,
  type BoardTask,
} from './task-view'
import { StageTape } from './StageTape'

type TaskCardProps = {
  task: BoardTask
  onOpen: (task: BoardTask) => void
  onEditPlan?: (task: BoardTask) => void
  showCopy?: boolean
}

const priorityTone: Record<string, string> = {
  P0: 'bg-destructive text-primary-foreground',
  P1: 'bg-secondary text-secondary-foreground',
  P2: 'bg-muted text-muted-foreground',
  P3: 'bg-muted text-muted-foreground',
}

export function TaskCard({ task, onOpen, onEditPlan, showCopy = true }: TaskCardProps) {
  const progress = taskProgress(task)
  const next = nextStage(task)
  const tags = taskTags(task)
  const risks = task.execution?.risk
  const attention = attentionReasons(task).slice(0, 3)

  async function copyName() {
    try {
      await navigator.clipboard.writeText(task.dirName)
      toast.success('已复制')
    } catch {
      toast.error('复制失败')
    }
  }

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
        <span className="truncate text-[10.5px] text-muted-foreground">{task.projectName}</span>
        <div className="ml-auto flex items-center gap-1">
          {task.groupRelationsValid === false ? (
            <Badge variant="outline" className="h-4 rounded-full px-1.5 text-[9px] text-destructive">
              关系异常
            </Badge>
          ) : null}
          <span
            className={`rounded-full px-1.5 py-px text-[9px] font-semibold ${
              priorityTone[task.priority || 'P2'] || priorityTone.P2
            }`}
          >
            {task.priority || 'P2'}
          </span>
        </div>
      </div>

      <h4 className="line-clamp-2 text-[12px] leading-4 font-semibold text-foreground">{task.title}</h4>

      <div className="flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground">
        <span>{dueLabel(task.execution?.dueDate)}</span>
        {task.execution?.milestone ? <span className="text-foreground/70">{task.execution.milestone}</span> : null}
        {tags.slice(0, 2).map((tag) => (
          <span key={tag} className="rounded-sm bg-muted px-1 py-px text-[9.5px]">
            {tag}
          </span>
        ))}
        {risks?.dorMissingCount ? (
          <span className="rounded-sm bg-muted px-1 py-px text-[9.5px]">DoR 缺 {risks.dorMissingCount}</span>
        ) : null}
        {risks?.dodMissingCount ? (
          <span className="rounded-sm bg-muted px-1 py-px text-[9.5px]">DoD 缺 {risks.dodMissingCount}</span>
        ) : null}
      </div>

      <StageTape stages={task.stages} current={task.derivedStage} />

      {attention.length ? (
        <div className="flex flex-wrap gap-1">
          {attention.map((reason) => (
            <span
              key={reason.id}
              className="rounded-full bg-destructive/10 px-1.5 py-px text-[9.5px] font-medium text-destructive"
            >
              {reason.label}
            </span>
          ))}
        </div>
      ) : null}

      <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
        <span className="flex size-4 items-center justify-center rounded-full bg-secondary text-[8px] font-semibold">
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
            className="rounded-md border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted"
            onClick={() => onEditPlan(task)}
            disabled={task.archived}
            title={task.archived ? '归档任务只读' : '编辑计划字段'}
          >
            计划
          </button>
        ) : null}
        {showCopy ? (
          <button
            type="button"
            className="flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted"
            onClick={copyName}
            title={`复制任务名：${task.dirName}`}
          >
            <Copy className="size-2.5" />
            复制任务名
          </button>
        ) : null}
      </div>
    </article>
  )
}
