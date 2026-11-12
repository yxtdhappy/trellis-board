import { controlClass } from '@/features/admin/shared'

type TeamOption = {
  id: string
  name: string
}

type TeamSwitcherProps = {
  teams: TeamOption[]
  value: string
  onChange: (teamId: string) => void
  includeAll?: boolean
  disabled?: boolean
  ariaLabel?: string
}

export function TeamSwitcher({
  teams,
  value,
  onChange,
  includeAll = false,
  disabled = false,
  ariaLabel = '筛选团队',
}: TeamSwitcherProps) {
  if (!teams.length || (!includeAll && teams.length === 1)) return null

  return (
    <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
      <span className="hidden sm:inline">团队</span>
      <select
        aria-label={ariaLabel}
        className={`${controlClass} w-auto min-w-28`}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        {includeAll ? <option value="all">全部团队</option> : null}
        {teams.map((team) => (
          <option key={team.id} value={team.id}>
            {team.name}
          </option>
        ))}
      </select>
    </label>
  )
}
