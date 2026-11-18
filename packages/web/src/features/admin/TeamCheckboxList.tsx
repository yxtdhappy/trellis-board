import type { Team } from '@/api/admin'
import { Checkbox } from '@/components/ui/checkbox'
import { StatusPill } from '@/components/ui/status-pill'
import { statusTone } from '@/lib/admin-shared'

type TeamCheckboxListProps = {
  teams: Team[]
  selectedIds: string[]
  onToggle: (teamId: string) => void
  disabled?: boolean
  emptyText: string
}

export function TeamCheckboxList({
  teams,
  selectedIds,
  onToggle,
  disabled,
  emptyText,
}: TeamCheckboxListProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">所属团队</span>
      {teams.length === 0 ? (
        <p className="text-xs text-muted-foreground">{emptyText}</p>
      ) : (
        <div className="flex flex-col gap-1.5 rounded-lg border border-border p-2">
          {teams.map((team) => (
            <label key={team.id} className="flex items-center gap-2 text-xs text-foreground">
              <Checkbox
                checked={selectedIds.includes(team.id)}
                onCheckedChange={() => onToggle(team.id)}
                disabled={disabled}
              />
              <span className="min-w-0 truncate">{team.name}</span>
              <StatusPill tone={statusTone(team.status)}>{team.status || 'unknown'}</StatusPill>
            </label>
          ))}
        </div>
      )}
    </div>
  )
}
