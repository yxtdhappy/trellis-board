import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { toast } from 'sonner'

export type Assignment = {
  executionTaskKey?: string
  taskKey?: string
  title?: string
  projectName?: string
  priority?: string
  assignee?: string
}

function readString(source: Record<string, unknown>, key: string) {
  const value = source[key]
  return typeof value === 'string' ? value : undefined
}

export function toAssignment(value: unknown): Assignment | null {
  if (!value || typeof value !== 'object') return null
  const source = value as Record<string, unknown>
  const task = source.task && typeof source.task === 'object' ? (source.task as Record<string, unknown>) : source
  return {
    executionTaskKey: readString(task, 'executionTaskKey') ?? readString(source, 'executionTaskKey'),
    taskKey: readString(task, 'taskKey') ?? readString(source, 'taskKey'),
    title: readString(task, 'title') ?? readString(source, 'title'),
    projectName: readString(task, 'projectName') ?? readString(source, 'projectName'),
    priority: readString(task, 'priority') ?? readString(source, 'priority'),
    assignee: readString(task, 'assignee') ?? readString(source, 'assignee'),
  }
}

type AssignmentsDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  assignments: unknown[]
  onAccept: (payload: Record<string, unknown>) => Promise<void>
}

export function AssignmentsDialog({ open, onOpenChange, assignments, onAccept }: AssignmentsDialogProps) {
  const rows = assignments.map(toAssignment).filter((row): row is Assignment => Boolean(row))

  async function accept(row: Assignment) {
    if (!row.executionTaskKey) {
      toast.error('任务缺少执行标识，请刷新后重试')
      return
    }
    try {
      await onAccept({ executionTaskKey: row.executionTaskKey })
      toast.success('已接受任务')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '接受失败')
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>待我接受</DialogTitle>
          <DialogDescription>有 {rows.length} 个任务等待你确认派发。</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          {rows.length === 0 ? (
            <p className="rounded-lg bg-muted px-3 py-6 text-center text-xs text-muted-foreground">
              当前没有待接受任务
            </p>
          ) : (
            rows.map((row) => (
              <div
                key={row.executionTaskKey || row.taskKey}
                className="flex items-center gap-3 rounded-lg bg-muted px-3 py-2.5"
              >
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="truncate text-xs font-semibold">{row.title || row.taskKey}</span>
                  <span className="truncate text-[10.5px] text-muted-foreground">
                    {row.projectName || '未知项目'} · {row.priority || 'P2'} · 指派给 {row.assignee || '未派发'}
                  </span>
                </div>
                <Button size="sm" className="ml-auto h-7 text-[11px]" onClick={() => accept(row)}>
                  接受任务
                </Button>
              </div>
            ))
          )}
        </div>
        <p className="rounded-lg border border-border px-3 py-2 text-[10.5px] leading-5 text-muted-foreground">
          接受后任务进入实现阶段；未接受的任务会保留在待我接受列表，并计入注意力队列。
        </p>
      </DialogContent>
    </Dialog>
  )
}
