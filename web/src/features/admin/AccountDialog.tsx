import { useState } from 'react'
import type { FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import type { AdminUser } from '@/api/admin'
import { Field, controlClass } from './shared'

export type AccountFormValues = {
  displayName: string
  status: string
  systemAdmin: boolean
}

type AccountFormProps = {
  user: AdminUser
  submitLabel: string
  onSubmit: (values: AccountFormValues) => Promise<unknown>
  onCancel?: () => void
}

export function AccountForm({ user, submitLabel, onSubmit, onCancel }: AccountFormProps) {
  const [displayName, setDisplayName] = useState(user.displayName || user.username)
  const [status, setStatus] = useState(user.status === 'disabled' ? 'disabled' : 'active')
  const [systemAdmin, setSystemAdmin] = useState(user.systemAdmin)
  const [busy, setBusy] = useState(false)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    await onSubmit({ displayName: displayName.trim(), status, systemAdmin })
    setBusy(false)
  }

  return (
    <form className="flex flex-col gap-2.5" onSubmit={handleSubmit}>
      <Field label="显示名">
        <Input
          maxLength={80}
          required
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          disabled={busy}
        />
      </Field>
      <Field label="状态">
        <select
          className={controlClass}
          value={status}
          onChange={(event) => setStatus(event.target.value)}
          disabled={busy}
        >
          <option value="active">启用</option>
          <option value="disabled">停用</option>
        </select>
      </Field>
      <label className="flex items-center gap-2 text-xs text-foreground">
        <Checkbox
          checked={systemAdmin}
          onCheckedChange={(checked) => setSystemAdmin(checked === true)}
          disabled={busy}
        />
        系统管理员
      </label>
      <div className="flex items-center justify-end gap-2 pt-1">
        {onCancel ? (
          <Button variant="outline" size="sm" type="button" onClick={onCancel} disabled={busy}>
            取消
          </Button>
        ) : null}
        <Button size="sm" type="submit" disabled={busy}>
          {submitLabel}
        </Button>
      </div>
    </form>
  )
}

export function AccountDialog({
  user,
  onSave,
  onClose
}: {
  user: AdminUser | null
  onSave: (user: AdminUser, values: AccountFormValues) => Promise<boolean>
  onClose: () => void
}) {
  return (
    <Dialog
      open={user !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader className="gap-1">
          <p className="text-[10px] font-semibold tracking-[0.2em] text-muted-foreground">
            ACCOUNT / UPDATE
          </p>
          <DialogTitle>编辑账号</DialogTitle>
          <DialogDescription>
            {user ? `${user.username} · ID ${user.id}` : '调整显示名、状态和系统管理员权限。'}
          </DialogDescription>
        </DialogHeader>
        {user ? (
          <AccountForm
            key={user.id}
            user={user}
            submitLabel="保存账号"
            onCancel={onClose}
            onSubmit={async (values) => {
              const ok = await onSave(user, values)
              if (ok) onClose()
              return ok
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
