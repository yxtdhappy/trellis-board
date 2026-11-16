import { LoaderCircle, RotateCcw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { PublishOperation } from '@/hooks/useBoard'

type TaskOperationListProps = {
  operations: PublishOperation[]
  onRetry: (id: string) => Promise<void>
  onCancel: (id: string) => Promise<void>
}

function statusView(operation: PublishOperation): { label: string; tone: string } {
  switch (operation.status) {
    case 'pending':
      return { label: '等待投递', tone: 'text-muted-foreground' }
    case 'delivered':
      return { label: '等待 Agent 执行', tone: 'text-amber-700 dark:text-amber-400' }
    case 'running':
      return { label: 'Agent 正在执行', tone: 'text-primary' }
    case 'succeeded':
      return { label: '已完成，正式任务已同步', tone: 'text-emerald-700 dark:text-emerald-400' }
    case 'failed':
      return { label: '执行失败', tone: 'text-destructive' }
    case 'cancelled':
      return { label: '已取消', tone: 'text-muted-foreground' }
    default:
      return { label: operation.status || '处理中', tone: 'text-muted-foreground' }
  }
}

function operationTitle(operation: PublishOperation): string {
  const raw = operation.raw as Record<string, unknown> | undefined
  const payload =
    raw?.payload && typeof raw.payload === 'object' ? (raw.payload as Record<string, unknown>) : {}
  if (typeof payload.title === 'string' && payload.title.trim()) return payload.title
  if (operation.taskKey) return operation.taskKey.split('::').at(-1) || operation.taskKey
  return operation.commandType === 'assign_task' ? '任务改派' : '任务创建'
}

function actionLabel(operation: PublishOperation): string {
  return operation.commandType === 'assign_task' ? '改派中' : '创建中'
}

export function TaskOperationList({ operations, onRetry, onCancel }: TaskOperationListProps) {
  const visible = operations
    .filter(
      (operation) =>
        operation.status !== 'succeeded' ||
        Date.now() -
          Date.parse(String((operation.raw as Record<string, unknown>)?.updatedAt || '')) <
          10 * 60 * 1000,
    )
    .slice(0, 8)
  if (!visible.length) return null
  return (
    <section className="rounded-xl border border-border bg-card px-3 py-2.5">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div>
          <h2 className="text-xs font-semibold">创建与改派操作</h2>
          <p className="text-[0.65625rem] text-muted-foreground">
            这些是独立操作项；成功前不会插入正式任务卡，也不会提前改变负责人。
          </p>
        </div>
      </div>
      <div className="flex flex-col divide-y divide-border/70">
        {visible.map((operation) => {
          const status = statusView(operation)
          const active = ['pending', 'delivered', 'running'].includes(operation.status || '')
          return (
            <div
              key={operation.id || `${operation.commandType}-${operation.taskKey}`}
              className="flex flex-wrap items-center gap-2 py-2 text-[0.6875rem]"
            >
              {active ? (
                <LoaderCircle className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
              ) : null}
              <strong className="min-w-0 flex-1 truncate font-medium">
                {actionLabel(operation)} · {operationTitle(operation)}
              </strong>
              <span className={status.tone}>{status.label}</span>
              {operation.error ? (
                <span className="basis-full break-words text-[0.65625rem] text-destructive">
                  {operation.error}
                </span>
              ) : null}
              {operation.status === 'failed' && operation.id ? (
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  className="gap-1"
                  onClick={() => void onRetry(operation.id as string)}
                >
                  <RotateCcw className="size-3" />
                  重试
                </Button>
              ) : null}
              {active && operation.id ? (
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  className="gap-1 text-muted-foreground"
                  onClick={() => void onCancel(operation.id as string)}
                >
                  <X className="size-3" />
                  取消
                </Button>
              ) : null}
            </div>
          )
        })}
      </div>
    </section>
  )
}
