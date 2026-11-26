import { useState } from 'react'
import type { FormEvent } from 'react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
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
import { Field, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import type { ProjectActionOutcome } from '@/hooks/useAdminProjects'

type ProjectRemovalDialogProps = {
  project: { id: string; name: string } | null
  onClose: () => void
  onRemove: (projectId: string, confirmation: string) => Promise<ProjectActionOutcome>
}

export function ProjectRemovalDialog({ project, onClose, onRemove }: ProjectRemovalDialogProps) {
  const [step, setStep] = useState<1 | 2>(1)
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  function reset() {
    setStep(1)
    setConfirmation('')
    setBusy(false)
    setError('')
  }

  function close() {
    if (busy) return
    reset()
    onClose()
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!project || step !== 2 || busy) return
    if (confirmation !== project.name) {
      setError('请准确输入完整项目名称后再移除。')
      return
    }
    setError('')
    setBusy(true)
    const outcome = await onRemove(project.id, confirmation)
    setBusy(false)
    if (outcome.ok) {
      reset()
      onClose()
    } else {
      setError(outcome.error || '移除项目失败，请重试。')
    }
  }

  return (
    <Dialog
      open={project !== null}
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      <DialogContent className="sm:max-w-xl" showCloseButton={!busy}>
        <DialogHeader className="gap-1">
          <DialogTitle>移除项目</DialogTitle>
          <DialogDescription className="break-all">
            {step === 1
              ? `这是不可逆的服务端数据删除，项目：${project?.name || ''}。`
              : `再次确认：请输入项目名称 ${project?.name || ''}。`}
          </DialogDescription>
        </DialogHeader>
        {project ? (
          <form className="flex min-h-0 flex-1 flex-col gap-2.5" onSubmit={submit}>
            <DialogBody className="flex flex-col gap-2.5">
              <Alert variant="destructive" className="leading-5">
                <AlertTitle>删除范围</AlertTitle>
                <AlertDescription className="leading-5">
                  将删除该项目的成员、团队访问、任务空间、任务、索引、命令、绑定、游标和冲突。
                  服务端会先创建数据库快照备份，但项目删除后不能从前端恢复。
                </AlertDescription>
              </Alert>
              <p className="text-xs leading-5 text-muted-foreground">
                真实 Git 仓库、客户端本地 <code>.trellis/tasks</code> 和账号本身不会被删除。
              </p>
              {step === 2 ? (
                <Field className="gap-1">
                  <FieldLabel
                    htmlFor="project-removal-confirmation"
                    className="text-xs font-medium text-muted-foreground"
                  >
                    输入项目名称
                  </FieldLabel>
                  <Input
                    id="project-removal-confirmation"
                    autoComplete="off"
                    autoFocus
                    value={confirmation}
                    onChange={(event) => setConfirmation(event.target.value)}
                    placeholder={project.name}
                    disabled={busy}
                  />
                </Field>
              ) : null}
              {error ? <FieldError className="text-xs">{error}</FieldError> : null}
            </DialogBody>
            <DialogFooter>
              <Button variant="outline" type="button" onClick={close} disabled={busy}>
                取消
              </Button>
              {step === 1 ? (
                <Button
                  variant="destructive"
                  type="button"
                  onClick={() => setStep(2)}
                  disabled={busy}
                >
                  继续确认
                </Button>
              ) : (
                <Button
                  variant="destructive"
                  type="submit"
                  disabled={busy || confirmation !== project.name}
                >
                  确认移除项目
                </Button>
              )}
            </DialogFooter>
          </form>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
