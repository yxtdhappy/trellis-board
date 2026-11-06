import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import * as admin from '@/api/admin'
import type { Team } from '@/api/admin'
import { controlClass } from '@/features/admin/shared'

export function TeamSwitcher() {
  const [teams, setTeams] = useState<Team[]>([])
  const [activeTeamId, setActiveTeamId] = useState('')
  const [systemAdmin, setSystemAdmin] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const runtime = await admin.fetchRuntime()
        if (cancelled) return
        setTeams(runtime.teams)
        setActiveTeamId(runtime.activeTeamId || '')
        setSystemAdmin(runtime.systemAdmin)
      } catch {
        // 团队切换器失败不阻断主页面。
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  if (teams.length === 0) return null

  async function changeTeam(teamId: string) {
    if (teamId === activeTeamId) return
    if (!teamId && !systemAdmin) return
    setBusy(true)
    try {
      await admin.switchTeam(teamId)
      window.location.reload()
    } catch (error) {
      toast.error(admin.formatError(error))
      setBusy(false)
    }
  }

  return (
    <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
      <span className="hidden sm:inline">团队</span>
      <select
        aria-label="切换活动团队"
        className={`${controlClass} w-auto min-w-28`}
        value={activeTeamId}
        disabled={busy}
        onChange={(event) => void changeTeam(event.target.value)}
      >
        {systemAdmin ? <option value="">全部团队</option> : null}
        {teams.map((team) => (
          <option key={team.id} value={team.id}>
            {team.name}
          </option>
        ))}
      </select>
    </label>
  )
}
