import { Button } from '@/components/ui/button'
import { StatusPill } from '@/components/ui/status-pill'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { isCompleteOperation, isRetryableOperation } from '@/lib/team-client.js'
import type { PublishOperation } from '@/hooks/useBoard'

const OPERATION_LABELS: Record<string, string> = {
  pending: '等待目标客户端',
  delivered: '已投递',
  running: '客户端执行中',
  succeeded: '已完成',
  cancelled: '已取消',
  failed: '失败',
}

const EXPLANATIONS: Record<string, string> = {
  pending: '任务或改派记录已保存，等待目标用户在客户端上线后接管；Board 会先显示服务端控制状态。',
  delivered: '命令已投递给目标客户端，等待本地执行。',
  running: '目标客户端正在本地调用 task.py 或修改负责人。',
  succeeded: '任务文件已同步并由服务端索引成功。',
  cancelled: '操作已取消，没有生成或修改正式任务。',
  failed: '操作失败，服务端返回了可读错误。',
}

type PublishOperationDialogProps = {
  operation: PublishOperation | null
  onClose: () => void
  onRetry: () => void
}

export function PublishOperationDialog({
  operation,
  onClose,
  onRetry,
}: PublishOperationDialogProps) {
  const status = operation?.status || 'pending'
  const retryable = isRetryableOperation(operation)
  const complete = isCompleteOperation(operation)

  return (
    <Dialog open={Boolean(operation)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-155">
        <DialogHeader>
          <DialogTitle className="text-base">
            {operation?.commandType === 'assign_task'
              ? '改派任务'
              : operation?.commandType === 'create_task'
                ? '创建任务'
                : '任务操作'}
          </DialogTitle>
          <DialogDescription>{EXPLANATIONS[status] || '正在跟踪任务操作…'}</DialogDescription>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-2 text-xs">
          <div className="flex items-center gap-2">
            <StatusPill
              tone={status === 'failed' ? 'destructive' : complete ? 'success' : 'primary'}
            >
              {OPERATION_LABELS[status] || status}
            </StatusPill>
            <span className="text-muted-foreground">操作 #{operation?.id || '待服务端返回'}</span>
          </div>
          {operation?.taskKey ? (
            <p className="text-muted-foreground">任务：{operation.taskKey}</p>
          ) : null}
          {operation?.error ? (
            <p role="alert" className="rounded-lg bg-destructive/10 px-2.5 py-1.5 text-destructive">
              {operation.error}
            </p>
          ) : null}
          {status === 'failed' && retryable ? (
            <p className="text-2xs text-muted-foreground">
              操作已停止自动刷新；确认目标成员权限和任务状态后可手动重试。
            </p>
          ) : null}
        </DialogBody>

        <DialogFooter className="gap-2">
          {status === 'failed' ? <Button onClick={onRetry}>重试操作</Button> : null}
          <Button variant="outline" onClick={onClose}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
