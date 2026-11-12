import { useState } from 'react'
import type { FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import type { AdminUser, Team } from '@/api/admin'
import { Field, StatusPill, controlClass } from './shared.tsx'
import { SelectField } from '@/features/board/SelectField'

export type AccountFormValues = {
  displayName: string
  status: string
  systemAdmin: boolean
  teamIds: string[]
}

type AccountFormProps = {
  user: AdminUser
  teams: Team[]
  submitLabel: string
  onSubmit: (values: AccountFormValues) => Promise<unknown>
  onCancel?: () => void
}

export function AccountForm({ user, teams, submitLabel, onSubmit, onCancel }: AccountFormProps) {
  const [displayName, setDisplayName] = useState(user.displayName || user.username)
  const [status, setStatus] = useState(user.status === 'disabled' ? 'disabled' : 'active')
  const [systemAdmin, setSystemAdmin] = useState(user.systemAdmin)
  const [teamIds, setTeamIds] = useState<string[]>(user.teams.map((team) => team.id))
  const [busy, setBusy] = useState(false)

  function toggleTeam(teamId: string, checked: boolean) {
    setTeamIds((current) =>
      checked ? [...current, teamId] : current.filter((id) => id !== teamId),
    )
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    await onSubmit({ displayName: displayName.trim(), status, systemAdmin, teamIds })
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
        <SelectField
          className={controlClass}
          value={status}
          options={[
            { value: 'active', label: '启用' },
            { value: 'disabled', label: '停用' },
          ]}
          onChange={setStatus}
          disabled={busy}
        />
      </Field>
      <label className="flex items-center gap-2 text-xs text-foreground">
        <Checkbox
          checked={systemAdmin}
          onCheckedChange={(checked) => setSystemAdmin(checked === true)}
          disabled={busy}
        />
        系统管理员
      </label>
      <div className="flex flex-col gap-1.5">
        <span className="text-[11px] font-medium text-muted-foreground">所属团队</span>
        {teams.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">暂无团队，可创建团队后再分配。</p>
        ) : (
          <div className="flex flex-col gap-1.5 rounded-lg border border-border p-2">
            {teams.map((team) => (
              <label key={team.id} className="flex items-center gap-2 text-xs text-foreground">
                <Checkbox
                  checked={teamIds.includes(team.id)}
                  onCheckedChange={(checked) => toggleTeam(team.id, checked === true)}
                  disabled={busy}
                />
                <span className="min-w-0 truncate">{team.name}</span>
                <StatusPill value={team.status} />
              </label>
            ))}
          </div>
        )}
      </div>
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
  teams,
  onSave,
  onClose,
}: {
  user: AdminUser | null
  teams: Team[]
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
            {user ? `${user.username} · ID ${user.id}` : '调整显示名、状态、团队和系统管理员权限。'}
          </DialogDescription>
        </DialogHeader>
        {user ? (
          <DialogBody className="flex flex-col gap-2.5">
            <AccountForm
              key={`${user.id}:${user.displayName}:${user.status}:${user.systemAdmin}:${user.teams.map((team) => team.id).join(',')}`}
              user={user}
              teams={teams}
              submitLabel="保存账号"
              onCancel={onClose}
              onSubmit={async (values) => {
                const ok = await onSave(user, values)
                if (ok) onClose()
                return ok
              }}
            />
          </DialogBody>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
