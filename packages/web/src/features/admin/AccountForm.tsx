import { useState } from 'react'
import type { FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import type { AdminUser, Team } from '@/api/admin'
import { SelectField } from '@/features/board/SelectField'
import { Field, FieldLabel } from '@/components/ui/field'
import { TeamCheckboxList } from './TeamCheckboxList.tsx'

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
}

export function AccountForm({ user, teams, submitLabel, onSubmit }: AccountFormProps) {
  const [displayName, setDisplayName] = useState(user.displayName || user.username)
  const [status, setStatus] = useState(user.status === 'disabled' ? 'disabled' : 'active')
  const [systemAdmin, setSystemAdmin] = useState(user.systemAdmin)
  const [teamIds, setTeamIds] = useState<string[]>(user.teams.map((team) => team.id))
  const [busy, setBusy] = useState(false)

  function toggleTeam(teamId: string) {
    setTeamIds((current) =>
      current.includes(teamId) ? current.filter((id) => id !== teamId) : [...current, teamId],
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
      <Field className="gap-1">
        <FieldLabel
          htmlFor="account-display-name"
          className="text-xs font-medium text-muted-foreground"
        >
          显示名
        </FieldLabel>
        <Input
          id="account-display-name"
          maxLength={80}
          required
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          disabled={busy}
        />
      </Field>
      <Field className="gap-1">
        <FieldLabel htmlFor="account-status" className="text-xs font-medium text-muted-foreground">
          状态
        </FieldLabel>
        <SelectField
          id="account-status"
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
      <TeamCheckboxList
        teams={teams}
        selectedIds={teamIds}
        onToggle={toggleTeam}
        disabled={busy}
        emptyText="暂无团队，可创建团队后再分配。"
      />
      <Button type="submit" className="self-start" disabled={busy}>
        {submitLabel}
      </Button>
    </form>
  )
}
