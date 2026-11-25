import { useEffect, useState } from 'react'
import { GitBranch } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
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
import { Empty, EmptyDescription } from '@/components/ui/empty'
import { Skeleton } from '@/components/ui/skeleton'
import {
  branchRebindErrorMessage,
  branchRebindView,
  normalizeBranchInspection,
  type BranchInspection,
} from '@/lib/branch-rebind.js'
import { cn } from '@/lib/utils'
import type { LocalAssociation } from '@/components/layout/project-rail/types.ts'

type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>

type BranchRebindDialogProps = {
  association: LocalAssociation | null
  projectName: string
  invoke: Invoke | null
  onOpenChange: (open: boolean) => void
  onConfirm: (repoPath: string) => void
}

export function BranchRebindDialog({
  association,
  projectName,
  invoke,
  onOpenChange,
  onConfirm,
}: BranchRebindDialogProps) {
  const [inspection, setInspection] = useState<BranchInspection | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const taskSpaceId = association?.taskSpaceId
  const open = Boolean(association)

  useEffect(() => {
    if (!open || !taskSpaceId || !invoke) return
    let cancelled = false
    setInspection(null)
    setError('')
    setLoading(true)
    invoke('inspect_associated_project_branches', { taskSpaceId })
      .then((payload) => {
        if (!cancelled) setInspection(normalizeBranchInspection(payload))
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(branchRebindErrorMessage(reason))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [invoke, open, taskSpaceId])

  if (!association) return null

  const view = branchRebindView(inspection, association.branchName)
  const repoPath = view.repoPath || association.repoPath

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-140">
        <DialogHeader>
          <DialogTitle>重新绑定分支</DialogTitle>
          <DialogDescription className="break-words">
            {projectName} · 当前绑定 {association.branchName}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          <div className="rounded-lg border border-border bg-muted/40 px-3 py-2">
            <p className="text-2xs text-muted-foreground">本地仓库</p>
            <p className="mt-0.5 break-all text-xs text-foreground">{repoPath || '未知路径'}</p>
            <p className="mt-1 text-2xs text-muted-foreground">
              客户端不会自动切换分支；请先在本地仓库检出目标分支。
            </p>
          </div>
          {loading ? (
            <div className="flex flex-col gap-2" aria-label="正在读取本地分支">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
            </div>
          ) : null}
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          {!loading && !error ? (
            <>
              {view.rows.length ? (
                <div className="flex flex-col gap-1.5">
                  {view.rows.map((row) => (
                    <div
                      key={row.name}
                      aria-disabled={!row.selectable}
                      className={cn(
                        'flex items-center gap-2 rounded-lg border px-3 py-2 text-xs',
                        row.current
                          ? 'border-primary/50 bg-primary-soft/40 text-foreground'
                          : 'border-border text-muted-foreground',
                      )}
                    >
                      <GitBranch className="size-3.5 shrink-0" />
                      <span className="min-w-0 flex-1 truncate font-medium">{row.name}</span>
                      {row.current ? (
                        <Badge variant="primary-soft" size="xs">
                          当前检出
                        </Badge>
                      ) : null}
                      {row.bound ? (
                        <Badge variant="outline" size="xs">
                          已绑定
                        </Badge>
                      ) : null}
                      {!row.current ? (
                        <span className="shrink-0 text-2xs text-muted-foreground">需先切换</span>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : (
                <Empty className="p-4">
                  <EmptyDescription>仓库没有可用的本地分支。</EmptyDescription>
                </Empty>
              )}
              {view.rows.some((row) => !row.current) ? (
                <p className="text-2xs text-muted-foreground">
                  其他分支需先在本地仓库手动切换，切换后重新打开此弹窗。
                </p>
              ) : null}
              {!view.canRebind && view.reason ? (
                <Alert>
                  <AlertDescription>{view.reason}</AlertDescription>
                </Alert>
              ) : null}
            </>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            type="button"
            disabled={loading || !view.canRebind}
            onClick={() => {
              onConfirm(repoPath)
              onOpenChange(false)
            }}
          >
            {view.targetBranch ? `重新绑定到 ${view.targetBranch}` : '重新绑定'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
