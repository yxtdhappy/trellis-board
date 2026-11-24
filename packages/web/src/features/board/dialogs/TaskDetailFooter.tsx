import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { DialogFooter } from '@/components/ui/dialog'
import { SelectField } from '../SelectField.tsx'
import { ShareTaskButton } from '../ShareTaskButton.tsx'
import type { BoardTask } from '../task-view.ts'

type TaskDetailFooterProps = {
  current: BoardTask | null
  assignee: string
  assignees: string[]
  onAssigneeChange: (value: string) => void
  assignmentReadOnly: boolean
  commandBlocked: boolean
  commandReason?: string | null
  canAssign: boolean
  onAssign: (task: BoardTask, assignee: string) => Promise<void>
  onClose: () => void
}

export function TaskDetailFooter({
  current,
  assignee,
  assignees,
  onAssigneeChange,
  assignmentReadOnly,
  commandBlocked,
  commandReason,
  canAssign,
  onAssign,
  onClose,
}: TaskDetailFooterProps) {
  return (
    <DialogFooter className="flex-col gap-1 sm:flex-col sm:justify-start">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-1.5">
          <SelectField
            className="w-auto min-w-0 flex-1 text-xs sm:w-40 sm:flex-none"
            placeholder="请选择负责人"
            value={assignee}
            options={assignees.map((name) => ({ value: name, label: name }))}
            onChange={onAssigneeChange}
            ariaLabel="负责人"
            disabled={assignmentReadOnly || commandBlocked}
          />
          <Button
            disabled={!canAssign}
            onClick={async () => {
              if (!current || !canAssign) return
              try {
                await onAssign(current, assignee)
                toast.success('负责人已更新')
              } catch (error) {
                toast.error(error instanceof Error ? error.message : '更新失败')
              }
            }}
          >
            更新派发
          </Button>
        </div>
        <div className="flex items-center gap-1.5">
          {current ? <ShareTaskButton task={current} /> : null}
          <Button variant="outline" onClick={onClose}>
            关闭
          </Button>
        </div>
      </div>
      {commandBlocked ? (
        <p className="text-2xs text-warning" role="status">
          {commandReason}
        </p>
      ) : null}
      {!assignmentReadOnly ? (
        <p className="max-w-72 text-2xs leading-4 text-muted-foreground">
          目标客户端离线时也可以先排队；接管后旧负责人本地副本可能保留、进入受保护清理， 或被 Git
          跟踪而需要手工处理。
        </p>
      ) : null}
    </DialogFooter>
  )
}
