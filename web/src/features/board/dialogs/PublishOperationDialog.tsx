import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { isCompleteOperation, isRetryableOperation, operationPollDelay } from '@/lib/team-client.js'
import type { PublishOperation } from '@/hooks/useBoard'

const OPERATION_LABELS: Record<string, string> = {
  prepared: '已准备',
  committed: '本地已提交',
  pending_push: '等待推送',
  pushed: '远端已接收',
  applied: '已应用',
  failed: '失败',
}

const EXPLANATIONS: Record<string, string> = {
  prepared: '服务端已准备写入，正在等待本地提交。',
  committed: '本地 Git 提交已完成，等待推送到共享分支。',
  pending_push: '本地提交已完成，但尚未发布到远端共享分支；此时不能视为成功。',
  pushed: '远端已接收提交，正在等待任务索引刷新。',
  applied: '任务写入已应用，项目看板可以刷新。',
  failed: '操作失败，服务端返回了可读错误。',
}

type PublishOperationDialogProps = {
  operation: PublishOperation | null
  onClose: () => void
  onRetry: () => void
}

export function PublishOperationDialog({ operation, onClose, onRetry }: PublishOperationDialogProps) {
  const status = operation?.status || 'prepared'
  const retryable = isRetryableOperation(operation)
  const complete = isCompleteOperation(operation)

  return (
    <Dialog open={Boolean(operation)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[620px]">
        <DialogHeader>
          <DialogTitle className="text-base">
            {operation?.operationType === 'retry' ? '重试发布状态' : '发布状态'}
          </DialogTitle>
          <DialogDescription>{EXPLANATIONS[status] || '正在跟踪 Git 发布状态…'}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2 text-[11px]">
          <div className="flex items-center gap-2">
            <span
              className={
                status === 'failed'
                  ? 'rounded-full bg-destructive/10 px-2 py-0.5 font-semibold text-destructive'
                  : complete
                    ? 'rounded-full bg-emerald-500/10 px-2 py-0.5 font-semibold text-emerald-600'
                    : 'rounded-full bg-primary/10 px-2 py-0.5 font-semibold text-primary'
              }
            >
              {OPERATION_LABELS[status] || status}
            </span>
            <span className="text-muted-foreground">操作 #{operation?.id || '待服务端返回'}</span>
          </div>
          {operation?.taskKey ? (
            <p className="text-muted-foreground">任务：{operation.taskKey}</p>
          ) : null}
          {operation?.localSha ? (
            <p className="truncate text-muted-foreground">本地提交：{operation.localSha}</p>
          ) : null}
          {operation?.remoteSha ? (
            <p className="truncate text-muted-foreground">远端提交：{operation.remoteSha}</p>
          ) : null}
          {operation?.error ? (
            <p role="alert" className="rounded-lg bg-destructive/10 px-2.5 py-1.5 text-destructive">
              {operation.error}
            </p>
          ) : null}
          {retryable ? (
            <p className="text-[10px] text-muted-foreground">
              每 {Math.round(operationPollDelay(1) / 1000)} 秒刷新一次状态；未推送成功前不能视为完成。
            </p>
          ) : null}
        </div>

        <DialogFooter className="gap-2">
          {retryable ? (
            <Button size="sm" className="h-8 text-[11px]" onClick={onRetry}>
              重试发布
            </Button>
          ) : null}
          <Button variant="outline" size="sm" className="h-8 text-[11px]" onClick={onClose}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
