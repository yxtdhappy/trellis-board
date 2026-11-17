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
import type { AdminUser } from '@/api/admin'
import { Field } from './shared.tsx'
import { adminPasswordError } from './password-policy.ts'

export function ResetPasswordDialog({
  user,
  onConfirm,
  onClose,
}: {
  user: AdminUser | null
  onConfirm: (user: AdminUser, password: string) => Promise<boolean>
  onClose: () => void
}) {
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  function close() {
    setPassword('')
    setConfirmation('')
    setError('')
    onClose()
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const passwordError = adminPasswordError(password)
    if (passwordError) {
      setError(passwordError)
      return
    }
    if (password !== confirmation) {
      setError('两次输入的密码不一致。')
      return
    }
    if (!user) return
    setError('')
    setBusy(true)
    const ok = await onConfirm(user, password)
    setBusy(false)
    if (ok) close()
  }

  return (
    <Dialog
      open={user !== null}
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader className="gap-1">
          <p className="text-2xs font-semibold tracking-[0.2em] text-muted-foreground">
            ACCOUNT / PASSWORD
          </p>
          <DialogTitle>重置密码</DialogTitle>
          <DialogDescription>
            {user ? `${user.username} 的全部会话会立即失效，需要重新登录。` : ''}
          </DialogDescription>
        </DialogHeader>
        <form className="flex min-h-0 flex-1 flex-col gap-2.5" onSubmit={handleSubmit}>
          <DialogBody className="flex flex-col gap-2.5">
            <Field label="新密码" hint="至少 6 个字符，不做复杂度校验。">
              <Input
                type="password"
                minLength={6}
                required
                autoComplete="new-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                disabled={busy}
              />
            </Field>
            <Field label="确认新密码">
              <Input
                type="password"
                minLength={6}
                required
                autoComplete="new-password"
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                disabled={busy}
              />
            </Field>
            {error ? (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" size="sm" type="button" onClick={close} disabled={busy}>
              取消
            </Button>
            <Button size="sm" type="submit" disabled={busy}>
              重置密码
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
