import { useState } from 'react'
import type { FormEvent } from 'react'
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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { changePassword } from '@/api/board'

type PasswordDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

const MIN_LENGTH = 6

export function PasswordDialog({ open, onOpenChange }: PasswordDialogProps) {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [message, setMessage] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setMessage('')
    if (next.length < MIN_LENGTH) {
      setMessage(`新密码至少 ${MIN_LENGTH} 位`)
      return
    }
    if (next !== confirm) {
      setMessage('两次输入的新密码不一致')
      return
    }
    setSubmitting(true)
    try {
      await changePassword({ currentPassword: current, newPassword: next })
      setCurrent('')
      setNext('')
      setConfirm('')
      setMessage('密码已更新，其他会话已失效')
      onOpenChange(false)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '更新失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>修改密码</DialogTitle>
          <DialogDescription>首次登录或密码被重置后需要先更新密码。</DialogDescription>
        </DialogHeader>
        <form className="flex min-h-0 flex-1 flex-col gap-3" onSubmit={submit}>
          <DialogBody className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="password-current">当前密码</Label>
              <Input
                id="password-current"
                type="password"
                autoComplete="current-password"
                value={current}
                onChange={(event) => setCurrent(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="password-next">新密码</Label>
              <Input
                id="password-next"
                type="password"
                autoComplete="new-password"
                value={next}
                onChange={(event) => setNext(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="password-confirm">确认新密码</Label>
              <Input
                id="password-confirm"
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
              />
            </div>
            <p className="rounded-lg bg-muted px-3 py-2 text-[11px] leading-5 text-muted-foreground">
              至少 {MIN_LENGTH} 位。更新成功后其他会话会立即失效。
            </p>
            {message ? (
              <p className="text-xs text-destructive" role="alert">
                {message}
              </p>
            ) : null}
          </DialogBody>
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? '更新中…' : '更新密码'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
