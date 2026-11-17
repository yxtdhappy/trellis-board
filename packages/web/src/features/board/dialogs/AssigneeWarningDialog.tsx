import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

export type AssigneeWarningDetails = {
  warningId: string
  expiresAt: string
  assignee: {
    userId?: string
    username?: string | null
    displayName?: string | null
  }
  actorAssignee?: string | null
  task: {
    taskKey?: string
    executionTaskKey?: string
    title?: string
  }
}

type AssigneeWarningDialogProps = {
  warning: AssigneeWarningDetails | null
  onCancel: () => void
  onContinue: () => Promise<void>
  onTakeover: () => Promise<void>
}

export function AssigneeWarningDialog({
  warning,
  onCancel,
  onContinue,
  onTakeover,
}: AssigneeWarningDialogProps) {
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const assignee = warning?.assignee?.displayName || warning?.assignee?.username || '其他成员'

  async function run(label: string, action: () => Promise<void>) {
    setBusy(label)
    setError('')
    try {
      await action()
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : '操作失败')
    } finally {
      setBusy('')
    }
  }

  return (
    <Dialog open={Boolean(warning)} onOpenChange={(open) => !open && !busy && onCancel()}>
      <DialogContent className="sm:max-w-[31.25rem]">
        <DialogHeader>
          <DialogTitle>你正在修改他人负责的任务</DialogTitle>
          <DialogDescription>
            当前责任人是 {assignee}。建议先沟通，避免多人重复推进同一任务。
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          <div className="rounded-lg bg-muted px-3 py-2 text-xs leading-5 text-muted-foreground">
            <p>任务：{warning?.task?.title || warning?.task?.taskKey || '当前任务'}</p>
            <p>继续推进会保留原责任人并记录审计；只有接管任务才会显式改派。</p>
          </div>
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant="outline" disabled={Boolean(busy)} onClick={onCancel}>
            取消
          </Button>
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={Boolean(busy)}
              onClick={() => void run('continue', onContinue)}
            >
              {busy === 'continue' ? '正在提交…' : '继续推进'}
            </Button>
            <Button
              disabled={Boolean(busy) || !warning?.actorAssignee}
              title={
                !warning?.actorAssignee ? '当前账号尚未映射到项目 Trellis developer ID' : undefined
              }
              onClick={() => void run('takeover', onTakeover)}
            >
              {busy === 'takeover' ? '正在接管…' : '接管任务'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
