import { useEffect, useState } from 'react'
import { fetchTaskSpaceListeners, type TaskSpace, type TaskSpaceListenerDetails } from '@/api/board'
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
import { projectListenerView } from '@/lib/project-rail-association.js'

type BranchListenersDialogProps = {
  taskSpace: TaskSpace | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

function timeLabel(value: string | null | undefined) {
  if (!value) return '暂无'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN')
}

export function BranchListenersDialog({
  taskSpace,
  open,
  onOpenChange,
}: BranchListenersDialogProps) {
  const [details, setDetails] = useState<TaskSpaceListenerDetails | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open || !taskSpace?.id) return
    let cancelled = false
    fetchTaskSpaceListeners(taskSpace.id)
      .then((payload) => {
        if (!cancelled) setDetails(payload)
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : '无法读取分支监听详情')
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, taskSpace?.id])

  if (!taskSpace) return null

  const summary = details || taskSpace
  const view = projectListenerView(summary)
  const listeners = details?.listeners || []

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[720px]">
        <DialogHeader>
          <DialogTitle>分支监听详情</DialogTitle>
          <DialogDescription>
            {taskSpace.branchName}
            {view ? ` · ${view.counts}` : ''}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          {view ? (
            <div className="rounded-lg border border-border bg-muted/40 px-3 py-2">
              <p className={`text-xs font-medium ${view.textClassName}`}>{view.label}</p>
              <p className="mt-1 text-[11px] text-muted-foreground">{view.detail}</p>
              <p className="mt-1 text-[10.5px] text-muted-foreground">
                最后监听：{timeLabel(details?.lastListenerAt ?? taskSpace.lastListenerAt)}
              </p>
            </div>
          ) : null}
          {loading ? <p className="text-xs text-muted-foreground">正在读取客户端信息…</p> : null}
          {error ? (
            <p
              role="alert"
              className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              {error}
            </p>
          ) : null}
          {!loading && !error && listeners.length === 0 ? (
            <p className="text-xs text-muted-foreground">当前没有已批准的客户端关联。</p>
          ) : null}
          {listeners.length ? (
            <div className="flex flex-col gap-2">
              {listeners.map((listener) => (
                <article
                  key={listener.bindingId}
                  className="rounded-lg border border-border px-3 py-2"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <strong className="text-xs font-semibold">
                      {listener.displayName || listener.username || '未知用户'}
                    </strong>
                    {listener.username ? (
                      <span className="text-[10.5px] text-muted-foreground">
                        @{listener.username}
                      </span>
                    ) : null}
                    <span
                      className={`rounded-full px-2 py-0.5 text-[9.5px] font-medium ${
                        listener.online
                          ? 'bg-primary/10 text-primary'
                          : 'bg-muted text-muted-foreground'
                      }`}
                    >
                      {listener.online ? '在线监听' : '未监听'}
                    </span>
                    <span className="rounded-full bg-muted px-2 py-0.5 text-[9.5px] text-muted-foreground">
                      绑定状态：
                      {listener.bindingStatus === 'approved' ? '已批准' : listener.bindingStatus}
                    </span>
                  </div>
                  <p className="mt-1 text-[11px] text-foreground">
                    设备：{listener.deviceName || '未命名设备'}
                  </p>
                  <p className="mt-0.5 text-[10.5px] text-muted-foreground">
                    最后上报：{timeLabel(listener.listenerReportedAt)} · 最后监听：
                    {timeLabel(listener.lastListenerAt)} · 绑定：
                    {timeLabel(listener.boundAt)}
                  </p>
                </article>
              ))}
            </div>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
