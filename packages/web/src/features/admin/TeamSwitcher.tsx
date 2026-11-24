import { SelectField } from '@/features/board/SelectField'

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
    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className="hidden shrink-0 whitespace-nowrap sm:inline">团队</span>
      <SelectField
        ariaLabel={ariaLabel}
        className="w-auto min-w-28 max-w-48"
        value={value}
        disabled={disabled}
        options={[
          ...(includeAll ? [{ value: 'all', label: '全部团队' }] : []),
          ...teams.map((team) => ({ value: team.id, label: team.name })),
        ]}
        onChange={onChange}
      />
    </label>
  )
}
