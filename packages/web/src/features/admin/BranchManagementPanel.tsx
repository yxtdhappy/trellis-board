import { useState } from 'react'
import type { FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { useConfirm } from '@/components/ui/confirm-dialog'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import type { AdminTaskSpace } from '@/api/admin'
import type { TaskSpaceActionOutcome } from '@/hooks/useAdminProjects'
import { formatTime, statusTone } from '@/lib/admin-shared'
import { StatusPill } from '@/components/ui/status-pill'
import { EmptyRow } from '@/components/ui/empty-row'
import { Field, Panel, Row } from './shared.tsx'
import { Alert, AlertDescription } from '@/components/ui/alert'

type BranchManagementPanelProps = {
  projectSelected: boolean
  taskSpaces: AdminTaskSpace[]
  onRetire: (taskSpace: AdminTaskSpace, reason?: string) => Promise<TaskSpaceActionOutcome>
  onRestore: (taskSpace: AdminTaskSpace) => Promise<TaskSpaceActionOutcome>
  onPurge: (taskSpace: AdminTaskSpace, confirmation: string) => Promise<TaskSpaceActionOutcome>
}

const GROUP_TITLES = {
  active: '正常分支',
  disabled: '技术停用',
  retired: '已弃用分支',
} as const

function lifecycleLabel(taskSpace: AdminTaskSpace) {
  if (taskSpace.lifecycleStatus === 'retired') return 'retired'
  if (taskSpace.lifecycleStatus === 'disabled') return 'disabled'
  return 'active'
}

function ImpactSummary({ taskSpace }: { taskSpace: AdminTaskSpace }) {
  const taskTitles = taskSpace.unarchivedTaskTitles || []
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/35 p-3 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <strong className="font-medium text-foreground">{taskSpace.branchName}</strong>
        <StatusPill tone={statusTone(lifecycleLabel(taskSpace))}>
          {lifecycleLabel(taskSpace) || 'unknown'}
        </StatusPill>
        {taskSpace.status !== taskSpace.lifecycleStatus ? (
          <StatusPill tone={statusTone(taskSpace.status)}>
            {taskSpace.status || 'unknown'}
          </StatusPill>
        ) : null}
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-muted-foreground sm:grid-cols-3">
        <span>任务 {taskSpace.taskCount}</span>
        <span>文件 {taskSpace.fileCount}</span>
        <span>监听 {taskSpace.onlineListenerCount}</span>
        <span>已关联 {taskSpace.approvedBindingCount}</span>
        <span>未归档 {taskSpace.activeTaskCount}</span>
        <span>最后活动 {formatTime(taskSpace.lastActivityAt)}</span>
      </div>
      {taskTitles.length ? (
        <p className="leading-5 text-muted-foreground">
          未归档任务：{taskTitles.join('、')}
          {taskSpace.activeTaskCount > taskTitles.length
            ? ` 等 ${taskSpace.activeTaskCount} 个`
            : ''}
        </p>
      ) : null}
    </div>
  )
}

export function BranchManagementPanel({
  projectSelected,
  taskSpaces,
  onRetire,
  onRestore,
  onPurge,
}: BranchManagementPanelProps) {
  const confirm = useConfirm()
  const [retireTarget, setRetireTarget] = useState<AdminTaskSpace | null>(null)
  const [retireReason, setRetireReason] = useState('')
  const [retireBusy, setRetireBusy] = useState(false)
  const [retireError, setRetireError] = useState('')
  const [restoreId, setRestoreId] = useState('')
  const [purgeTarget, setPurgeTarget] = useState<AdminTaskSpace | null>(null)
  const [purgeStep, setPurgeStep] = useState<1 | 2>(1)
  const [purgeConfirmation, setPurgeConfirmation] = useState('')
  const [purgeBusy, setPurgeBusy] = useState(false)
  const [purgeError, setPurgeError] = useState('')

  const groups = {
    active: taskSpaces.filter((taskSpace) => taskSpace.lifecycleStatus === 'active'),
    disabled: taskSpaces.filter((taskSpace) => taskSpace.lifecycleStatus === 'disabled'),
    retired: taskSpaces.filter((taskSpace) => taskSpace.lifecycleStatus === 'retired'),
  }

  function openRetire(taskSpace: AdminTaskSpace) {
    setRetireTarget(taskSpace)
    setRetireReason('')
    setRetireError('')
  }

  function closeRetire() {
    if (retireBusy) return
    setRetireTarget(null)
    setRetireReason('')
    setRetireError('')
  }

  async function submitRetire(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!retireTarget || retireBusy) return
    setRetireError('')
    setRetireBusy(true)
    const outcome = await onRetire(retireTarget, retireReason)
    setRetireBusy(false)
    if (outcome.ok) {
      setRetireTarget(null)
      setRetireReason('')
    } else {
      setRetireError(outcome.error || '弃用失败，请重试。')
    }
  }

  async function restore(taskSpace: AdminTaskSpace) {
    if (restoreId) return
    const confirmed = await confirm({
      title: `恢复分支 ${taskSpace.branchName}？`,
      description: '恢复后旧客户端监听不会自动恢复。',
      confirmText: '恢复',
    })
    if (!confirmed) return
    setRestoreId(taskSpace.id)
    const outcome = await onRestore(taskSpace)
    setRestoreId('')
    if (!outcome.ok) return
  }

  function openPurge(taskSpace: AdminTaskSpace) {
    setPurgeTarget(taskSpace)
    setPurgeStep(1)
    setPurgeConfirmation('')
    setPurgeError('')
  }

  function closePurge() {
    if (purgeBusy) return
    setPurgeTarget(null)
    setPurgeStep(1)
    setPurgeConfirmation('')
    setPurgeError('')
  }

  async function submitPurge(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!purgeTarget || purgeStep !== 2 || purgeBusy) return
    if (purgeConfirmation !== purgeTarget.branchName) {
      setPurgeError('请准确输入分支名称后再移除。')
      return
    }
    setPurgeError('')
    setPurgeBusy(true)
    const outcome = await onPurge(purgeTarget, purgeConfirmation)
    setPurgeBusy(false)
    if (outcome.ok) {
      setPurgeTarget(null)
      setPurgeStep(1)
      setPurgeConfirmation('')
    } else {
      setPurgeError(outcome.error || '移除失败，请重试。')
    }
  }

  function branchActions(taskSpace: AdminTaskSpace) {
    const retired = taskSpace.lifecycleStatus === 'retired'
    return (
      <>
        {retired ? (
          <Button
            variant="outline"
            size="sm"
            type="button"
            disabled={Boolean(restoreId) || retireBusy || purgeBusy}
            aria-label={`恢复分支 ${taskSpace.branchName}`}
            onClick={() => void restore(taskSpace)}
          >
            恢复
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            type="button"
            disabled={retireBusy || purgeBusy || Boolean(restoreId)}
            aria-label={`弃用分支 ${taskSpace.branchName}`}
            onClick={() => openRetire(taskSpace)}
          >
            弃用
          </Button>
        )}
        <Button
          variant="destructive"
          size="sm"
          type="button"
          disabled={retireBusy || purgeBusy || Boolean(restoreId)}
          aria-label={`移除分支 ${taskSpace.branchName}`}
          onClick={() => openPurge(taskSpace)}
        >
          移除分支
        </Button>
      </>
    )
  }

  return (
    <Panel
      kicker="BRANCH LIFECYCLE"
      title="分支管理"
      description="弃用会隐藏分支并停止同步，保留数据可恢复；移除会删除服务端分支数据，但不删除真实 Git 分支。"
      action={
        <span className="text-xs font-semibold text-muted-foreground">{taskSpaces.length}</span>
      }
    >
      {!projectSelected ? (
        <EmptyRow>先选择项目。</EmptyRow>
      ) : taskSpaces.length === 0 ? (
        <EmptyRow>该项目还没有任务空间。</EmptyRow>
      ) : (
        <div className="flex flex-col gap-3">
          {(Object.keys(GROUP_TITLES) as Array<keyof typeof GROUP_TITLES>).map((group) => {
            const rows = groups[group]
            if (!rows.length) return null
            return (
              <section key={group} className="flex flex-col">
                <h3 className="mb-1 flex items-center gap-2 px-1 text-xs font-semibold text-muted-foreground">
                  {GROUP_TITLES[group]}
                  <span className="rounded-full bg-muted px-1.5 py-0.5">{rows.length}</span>
                </h3>
                {rows.map((taskSpace) => (
                  <Row key={taskSpace.id} actions={branchActions(taskSpace)}>
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <div className="flex items-center gap-1.5">
                        <code className="truncate text-xs font-medium text-foreground">
                          {taskSpace.branchName}
                        </code>
                        <StatusPill tone={statusTone(lifecycleLabel(taskSpace))}>
                          {lifecycleLabel(taskSpace) || 'unknown'}
                        </StatusPill>
                        {taskSpace.status !== taskSpace.lifecycleStatus ? (
                          <StatusPill tone={statusTone(taskSpace.status)}>
                            {taskSpace.status || 'unknown'}
                          </StatusPill>
                        ) : null}
                      </div>
                      <p className="truncate text-2xs text-muted-foreground">
                        任务 {taskSpace.taskCount} · 文件 {taskSpace.fileCount} · 监听{' '}
                        {taskSpace.onlineListenerCount}/{taskSpace.approvedBindingCount} · 最后活动{' '}
                        {formatTime(taskSpace.lastActivityAt)}
                      </p>
                      {taskSpace.retiredReason ? (
                        <p className="truncate text-2xs text-muted-foreground">
                          弃用原因：{taskSpace.retiredReason}
                        </p>
                      ) : null}
                    </div>
                  </Row>
                ))}
              </section>
            )
          })}
        </div>
      )}

      <Dialog
        open={retireTarget !== null}
        onOpenChange={(open) => {
          if (!open) closeRetire()
        }}
      >
        <DialogContent className="sm:max-w-136">
          <DialogHeader className="gap-1">
            <DialogTitle>弃用分支</DialogTitle>
            <DialogDescription>
              弃用后普通成员看不到该分支，客户端同步会停止；任务和审计数据仍保留。
            </DialogDescription>
          </DialogHeader>
          {retireTarget ? (
            <form className="flex min-h-0 flex-1 flex-col gap-2.5" onSubmit={submitRetire}>
              <DialogBody className="flex flex-col gap-2.5">
                <ImpactSummary taskSpace={retireTarget} />
                <Field label="弃用原因（可选）">
                  <Textarea
                    maxLength={500}
                    rows={3}
                    placeholder="记录为什么不再使用这个分支"
                    value={retireReason}
                    onChange={(event) => setRetireReason(event.target.value)}
                    disabled={retireBusy}
                  />
                </Field>
                {retireError ? (
                  <p role="alert" className="text-xs text-destructive">
                    {retireError}
                  </p>
                ) : null}
              </DialogBody>
              <DialogFooter>
                <Button
                  variant="outline"
                  size="sm"
                  type="button"
                  onClick={closeRetire}
                  disabled={retireBusy}
                >
                  取消
                </Button>
                <Button size="sm" type="submit" disabled={retireBusy}>
                  确认弃用
                </Button>
              </DialogFooter>
            </form>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog
        open={purgeTarget !== null}
        onOpenChange={(open) => {
          if (!open) closePurge()
        }}
      >
        <DialogContent className="sm:max-w-xl">
          <DialogHeader className="gap-1">
            <DialogTitle>移除分支</DialogTitle>
            <DialogDescription>
              {purgeStep === 1
                ? '这是不可逆的服务端数据删除。请先确认影响范围。'
                : `再次确认：请输入分支名称 ${purgeTarget?.branchName || ''}。`}
            </DialogDescription>
          </DialogHeader>
          {purgeTarget ? (
            <form className="flex min-h-0 flex-1 flex-col gap-2.5" onSubmit={submitPurge}>
              <DialogBody className="flex flex-col gap-2.5">
                <ImpactSummary taskSpace={purgeTarget} />
                {purgeStep === 1 ? (
                  <Alert variant="destructive" className="leading-5">
                    <AlertDescription className="leading-5">
                      将删除该分支的任务快照、绑定、游标、命令、冲突和索引；服务端会先创建数据库备份。
                      真实 Git 分支和客户端本地 <code>.trellis/tasks</code> 不会删除。
                    </AlertDescription>
                  </Alert>
                ) : (
                  <Field label="输入分支名称">
                    <Input
                      autoComplete="off"
                      autoFocus
                      value={purgeConfirmation}
                      onChange={(event) => setPurgeConfirmation(event.target.value)}
                      placeholder={purgeTarget.branchName}
                      disabled={purgeBusy}
                    />
                  </Field>
                )}
                {purgeError ? (
                  <p role="alert" className="text-xs text-destructive">
                    {purgeError}
                  </p>
                ) : null}
              </DialogBody>
              <DialogFooter>
                <Button
                  variant="outline"
                  size="sm"
                  type="button"
                  onClick={closePurge}
                  disabled={purgeBusy}
                >
                  取消
                </Button>
                {purgeStep === 1 ? (
                  <Button
                    variant="destructive"
                    size="sm"
                    type="button"
                    onClick={() => setPurgeStep(2)}
                    disabled={purgeBusy}
                  >
                    继续确认
                  </Button>
                ) : (
                  <Button
                    variant="destructive"
                    size="sm"
                    type="submit"
                    disabled={purgeBusy || purgeConfirmation !== purgeTarget.branchName}
                  >
                    确认移除
                  </Button>
                )}
              </DialogFooter>
            </form>
          ) : null}
        </DialogContent>
      </Dialog>
    </Panel>
  )
}
