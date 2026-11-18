import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import * as admin from '@/api/admin'
import type { AdminUser, Team, TeamMember } from '@/api/admin'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SelectField } from '@/features/board/SelectField'
import { StatusPill } from '@/components/ui/status-pill'
import { statusTone } from '@/lib/admin-shared'
import { EmptyRow } from '@/components/ui/empty-row'
import { Panel } from '@/features/admin/shared'
import { cn } from '@/lib/utils'

export function TeamsTab() {
  const [teams, setTeams] = useState<Team[]>([])
  const [users, setUsers] = useState<AdminUser[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [members, setMembers] = useState<TeamMember[]>([])
  const [name, setName] = useState('')
  const [userId, setUserId] = useState('')
  const [role, setRole] = useState('member')
  const [busy, setBusy] = useState(false)

  const selected = teams.find((team) => team.id === selectedId) || null

  const reload = useCallback(async () => {
    const [nextTeams, nextUsers] = await Promise.all([
      admin.fetchAdminTeams(),
      admin.fetchUsers('all'),
    ])
    setTeams(nextTeams)
    setUsers(nextUsers)
    setSelectedId((current) =>
      nextTeams.some((team) => team.id === current) ? current : nextTeams[0]?.id || '',
    )
  }, [])

  useEffect(() => {
    void reload().catch((error) => toast.error(admin.formatError(error)))
  }, [reload])

  useEffect(() => {
    if (!selectedId) {
      setMembers([])
      return
    }
    let cancelled = false
    void admin
      .fetchTeamDetail(selectedId)
      .then((detail) => {
        if (!cancelled) setMembers(detail.members)
      })
      .catch((error) => toast.error(admin.formatError(error)))
    return () => {
      cancelled = true
    }
  }, [selectedId, teams])

  async function run(action: () => Promise<void>) {
    setBusy(true)
    try {
      await action()
      await reload()
    } catch (error) {
      toast.error(admin.formatError(error))
    } finally {
      setBusy(false)
    }
  }

  function create() {
    const value = name.trim()
    if (!value) return
    void run(async () => {
      await admin.createTeam(value)
      setName('')
      toast.success('团队已创建。')
    })
  }

  function toggleStatus(team: Team) {
    void run(async () => {
      await admin.updateTeam(team.id, {
        status: team.status === 'active' ? 'disabled' : 'active',
      })
    })
  }

  function addMember() {
    if (!selected || !userId) return
    const user = users.find((item) => item.id === userId)
    if (!user) return
    void run(async () => {
      await admin.saveUserTeams(user.id, [
        ...user.teams
          .filter((team) => team.id !== selected.id)
          .map((team) => ({ teamId: team.id, role: team.role || 'member' })),
        { teamId: selected.id, role },
      ])
      setUserId('')
      toast.success('团队成员已更新。')
    })
  }

  function removeMember(member: TeamMember) {
    const user = users.find((item) => item.id === member.userId)
    if (!user || !selected) return
    void run(async () => {
      await admin.saveUserTeams(
        user.id,
        user.teams
          .filter((team) => team.id !== selected.id)
          .map((team) => ({ teamId: team.id, role: team.role || 'member' })),
      )
    })
  }

  return (
    <div className="grid gap-3 lg:grid-cols-[320px_1fr]">
      <Panel title="团队" description="系统管理员可创建、停用和分配成员。">
        <div className="flex gap-1.5">
          <Input
            className="text-xs"
            value={name}
            placeholder="新团队名称"
            onChange={(event) => setName(event.target.value)}
          />
          <Button disabled={busy} onClick={create}>
            创建
          </Button>
        </div>
        <div className="flex flex-col gap-1">
          {teams.length === 0 ? <EmptyRow>还没有团队</EmptyRow> : null}
          {teams.map((team) => (
            <button
              key={team.id}
              type="button"
              className={cn(
                'flex items-center justify-between rounded-lg px-2.5 py-2 text-left text-xs',
                team.id === selectedId ? 'bg-secondary text-foreground' : 'hover:bg-muted',
              )}
              onClick={() => setSelectedId(team.id)}
            >
              <span className="min-w-0">
                <span className="block truncate font-medium">{team.name}</span>
                <span className="block text-2xs text-muted-foreground">
                  {team.memberCount} 名成员 · {team.projectCount} 个项目
                </span>
              </span>
              <StatusPill tone={statusTone(team.status)}>{team.status || 'unknown'}</StatusPill>
            </button>
          ))}
        </div>
      </Panel>

      <Panel
        title={selected ? selected.name : '团队详情'}
        description={selected ? `slug: ${selected.slug}` : '选择一个团队查看成员。'}
        action={
          selected ? (
            <Button variant="outline" disabled={busy} onClick={() => toggleStatus(selected)}>
              {selected.status === 'active' ? '停用团队' : '启用团队'}
            </Button>
          ) : null
        }
      >
        {selected ? (
          <>
            <div className="flex flex-wrap items-center gap-1.5">
              <SelectField
                ariaLabel="选择用户"
                className="max-w-52"
                placeholder="选择账号"
                value={userId}
                options={users.map((user) => ({
                  value: user.id,
                  label: user.displayName || user.username,
                }))}
                onChange={setUserId}
              />
              <SelectField
                ariaLabel="团队角色"
                className="w-28"
                value={role}
                options={[
                  { value: 'member', label: '成员' },
                  { value: 'admin', label: '团队管理员' },
                ]}
                onChange={(next) => setRole(next)}
              />
              <Button disabled={busy || !userId} onClick={addMember}>
                加入团队
              </Button>
            </div>
            <div className="flex flex-col gap-1">
              {members.map((member) => (
                <div
                  key={member.userId}
                  className="flex items-center justify-between gap-2 rounded-lg bg-muted/40 px-2.5 py-1.5 text-xs"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{member.displayName}</span>
                    <span className="block text-2xs text-muted-foreground">
                      {member.username} · {member.role === 'admin' ? '团队管理员' : '成员'}
                    </span>
                  </span>
                  <Button
                    variant="ghost"
                    size="xs"
                    className="px-1.5"
                    disabled={busy}
                    onClick={() => removeMember(member)}
                  >
                    移出
                  </Button>
                </div>
              ))}
              {members.length === 0 ? <EmptyRow>该团队还没有成员</EmptyRow> : null}
            </div>
          </>
        ) : (
          <EmptyRow>暂无团队</EmptyRow>
        )}
      </Panel>
    </div>
  )
}
