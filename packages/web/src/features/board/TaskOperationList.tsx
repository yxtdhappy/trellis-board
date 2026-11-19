import { useEffect, useState } from 'react'
import { EyeOff, LoaderCircle, RotateCcw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { PublishOperation } from '@/hooks/board-types.ts'
import { Panel } from '@/components/ui/panel'
import {
  isDismissibleOperation,
  normalizeDismissedOperationIds,
  operationDismissStorageKey,
  pruneDismissedOperationIds,
  readDismissedOperationIds,
  visibleOperations,
  writeDismissedOperationIds,
} from '@/lib/operation-visibility.js'

type TaskOperationListProps = {
  operations: PublishOperation[]
  userKey: string
  taskSpaceId: string
  onRetry: (id: string) => Promise<void>
  onCancel: (id: string) => Promise<void>
}

function resolveLocalStorage(): Storage | null {
  try {
    return window.localStorage || null
  } catch {
    /* 隐私模式或禁用存储时按无持久化处理 */
    return null
  }
}

function statusView(operation: PublishOperation): { label: string; tone: string } {
  switch (operation.status) {
    case 'pending':
      return { label: '等待客户端接管', tone: 'text-warning' }
    case 'delivered':
      return { label: '等待 Agent 执行', tone: 'text-warning' }
    case 'running':
      return { label: 'Agent 正在执行', tone: 'text-primary' }
    case 'succeeded':
      return { label: '客户端已完成接管', tone: 'text-success' }
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

export function TaskOperationList({
  operations,
  userKey,
  taskSpaceId,
  onRetry,
  onCancel,
}: TaskOperationListProps) {
  const storageKey = operationDismissStorageKey(userKey, taskSpaceId)
  return (
    <TaskOperationListBody
      key={storageKey}
      operations={operations}
      storageKey={storageKey}
      onRetry={onRetry}
      onCancel={onCancel}
    />
  )
}

type TaskOperationListBodyProps = Omit<TaskOperationListProps, 'userKey' | 'taskSpaceId'> & {
  storageKey: string
}

function TaskOperationListBody({
  operations,
  storageKey,
  onRetry,
  onCancel,
}: TaskOperationListBodyProps) {
  const [dismissedIds, setDismissedIds] = useState<string[]>(() =>
    readDismissedOperationIds(resolveLocalStorage(), storageKey),
  )

  useEffect(() => {
    // 空列表可能是尚未加载或服务端暂无记录，此时不能清空本地忽略记录。
    if (!operations.length) return
    const pruned = pruneDismissedOperationIds(dismissedIds, operations)
    if (pruned.length === dismissedIds.length) return
    setDismissedIds(pruned)
    writeDismissedOperationIds(resolveLocalStorage(), storageKey, pruned)
  }, [operations, dismissedIds, storageKey])

  const dismiss = (id: string) => {
    const next = normalizeDismissedOperationIds([...dismissedIds, id])
    setDismissedIds(next)
    writeDismissedOperationIds(resolveLocalStorage(), storageKey, next)
  }

  const visible = visibleOperations(operations, { dismissedIds })
  if (!visible.length) return null
  return (
    <Panel className="gap-0 border border-border px-3 py-2.5">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div>
          <h2 className="text-xs font-semibold">创建与改派操作</h2>
          <p className="text-2xs text-muted-foreground">
            任务会先以待交付控制状态进入看板；目标客户端上线后接管、落地正文并完成 operation。
            已结束的操作可以忽略，忽略记录只保存在当前浏览器。
          </p>
        </div>
      </div>
      <div className="flex flex-col divide-y divide-border/70">
        {visible.map((operation) => {
          const status = statusView(operation)
          const active = ['pending', 'delivered', 'running'].includes(operation.status || '')
          const dismissible = isDismissibleOperation(operation) && Boolean(operation.id)
          return (
            <div
              key={operation.id || `${operation.commandType}-${operation.taskKey}`}
              className="flex flex-wrap items-center gap-2 py-2 text-xs"
            >
              {active ? (
                <LoaderCircle className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
              ) : null}
              <strong className="min-w-0 flex-1 truncate font-medium">
                {actionLabel(operation)} · {operationTitle(operation)}
              </strong>
              <span className={status.tone}>{status.label}</span>
              {operation.error ? (
                <span className="basis-full break-words text-2xs text-destructive">
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
              {dismissible ? (
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  className="gap-1 text-muted-foreground"
                  onClick={() => dismiss(operation.id as string)}
                >
                  <EyeOff className="size-3" />
                  忽略
                </Button>
              ) : null}
            </div>
          )
        })}
      </div>
    </Panel>
  )
}
