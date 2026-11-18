import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { toast } from 'sonner'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { fetchAdminTeams, formatError } from '@/api/admin'
import type { AdminUser, Team } from '@/api/admin'
import type { AdminConsole } from '@/hooks/useAdminConsole'
import { formatTime, statusTone } from '@/lib/admin-shared'
import { AccountDialog, AccountForm } from './AccountDialog.tsx'
import type { AccountFormValues } from './AccountDialog.tsx'
import { adminPasswordError } from './password-policy.ts'
import { ResetPasswordDialog } from './ResetPasswordDialog.tsx'
import { StatusPill } from '@/components/ui/status-pill'
import { EmptyRow } from '@/components/ui/empty-row'
import { Field, Panel, Row } from './shared.tsx'

export function UsersTab({ console: consoleApi }: { console: AdminConsole }) {
  const { users, reloadUsers, createUser, updateUser, toggleUser, resetPassword } = consoleApi
  const [teams, setTeams] = useState<Team[]>([])
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [teamIds, setTeamIds] = useState<string[]>([])
  const [systemAdmin, setSystemAdmin] = useState(false)
  const [busy, setBusy] = useState(false)
  const [selectedId, setSelectedId] = useState('')
  const [dialogUser, setDialogUser] = useState<AdminUser | null>(null)
  const [resetUser, setResetUser] = useState<AdminUser | null>(null)

  useEffect(() => {
    void reloadUsers()
  }, [reloadUsers])

  useEffect(() => {
    let cancelled = false
    void fetchAdminTeams()
      .then((list) => {
        if (!cancelled) setTeams(list)
      })
      .catch((error) => {
        if (!cancelled) toast.error(formatError(error))
      })
    return () => {
      cancelled = true
    }
  }, [])

  const selectedUser = users.find((user) => user.id === selectedId) ?? null

  function toggleCreateTeam(teamId: string, checked: boolean) {
    setTeamIds((current) =>
      checked ? [...current, teamId] : current.filter((id) => id !== teamId),
    )
  }

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const passwordError = adminPasswordError(password)
    if (passwordError) {
      toast.error(passwordError)
      return
    }
    setBusy(true)
    const created = await createUser({
      username: username.trim(),
      displayName: displayName.trim(),
      password,
      teamIds,
      systemAdmin,
    })
    setBusy(false)
    if (created) {
      setUsername('')
      setDisplayName('')
      setPassword('')
      setTeamIds([])
      setSystemAdmin(false)
    }
  }

  async function saveAccount(user: AdminUser, values: AccountFormValues) {
    const updated = await updateUser(user, values)
    if (updated) toast.success(`账号 ${user.username} 已更新。`)
    return Boolean(updated)
  }

  return (
    <>
      <div className="grid gap-3.5 lg:grid-cols-[380px_minmax(0,1fr)]">
        <div className="flex flex-col gap-3.5">
          <Panel
            kicker="IDENTITY / ACCOUNTS"
            title="创建账号"
            description="仅系统管理员可建号；填写初始密码并分配团队，团队可留空。"
          >
            <form className="flex flex-col gap-2" onSubmit={handleCreate}>
              <Field label="登录名">
                <Input
                  maxLength={64}
                  required
                  autoComplete="off"
                  disabled={busy}
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                />
              </Field>
              <Field label="显示名">
                <Input
                  maxLength={80}
                  required
                  disabled={busy}
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                />
              </Field>
              <Field label="初始密码" hint="至少 6 个字符，不做复杂度校验。">
                <Input
                  type="password"
                  minLength={6}
                  required
                  autoComplete="new-password"
                  disabled={busy}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </Field>
              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-muted-foreground">所属团队</span>
                {teams.length === 0 ? (
                  <p className="text-xs text-muted-foreground">暂无团队，可先建号后补配。</p>
                ) : (
                  <div className="flex flex-col gap-1.5 rounded-lg border border-border p-2">
                    {teams.map((team) => (
                      <label
                        key={team.id}
                        className="flex items-center gap-2 text-xs text-foreground"
                      >
                        <Checkbox
                          checked={teamIds.includes(team.id)}
                          onCheckedChange={(checked) => toggleCreateTeam(team.id, checked === true)}
                          disabled={busy}
                        />
                        <span className="min-w-0 truncate">{team.name}</span>
                        <StatusPill tone={statusTone(team.status)}>
                          {team.status || 'unknown'}
                        </StatusPill>
                      </label>
                    ))}
                  </div>
                )}
              </div>
              <label className="flex items-center gap-2 text-xs text-foreground">
                <Checkbox
                  checked={systemAdmin}
                  onCheckedChange={(checked) => setSystemAdmin(checked === true)}
                  disabled={busy}
                />
                系统管理员
              </label>
              <Button size="sm" type="submit" className="self-start" disabled={busy}>
                创建账号
              </Button>
            </form>
          </Panel>

          <Panel
            kicker="ACCOUNT / UPDATE"
            title="编辑账号"
            description="调整显示名、状态、所属团队和系统管理员权限。"
          >
            {selectedUser ? (
              <AccountForm
                key={`${selectedUser.id}:${selectedUser.displayName}:${selectedUser.status}:${selectedUser.systemAdmin}:${selectedUser.teams.map((team) => team.id).join(',')}`}
                user={selectedUser}
                teams={teams}
                submitLabel="保存账号"
                onSubmit={(values) => saveAccount(selectedUser, values)}
              />
            ) : (
              <EmptyRow>尚未选择账号。点击列表中的「编辑」开始。</EmptyRow>
            )}
          </Panel>
        </div>

        <Panel
          kicker="TEAM ACCOUNTS"
          title="团队账号"
          action={
            <span className="text-xs font-semibold text-muted-foreground">{users.length}</span>
          }
        >
          <div className="flex flex-col">
            {users.length === 0 ? (
              <EmptyRow>暂无用户账号。</EmptyRow>
            ) : (
              users.map((user) => (
                <Row
                  key={user.id}
                  actions={
                    <>
                      <Button
                        variant="ghost"
                        size="sm"
                        type="button"
                        onClick={() => {
                          setSelectedId(user.id)
                          setDialogUser(user)
                        }}
                      >
                        编辑
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        type="button"
                        onClick={() => setResetUser(user)}
                      >
                        重置密码
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        type="button"
                        className={user.status === 'active' ? 'text-destructive' : undefined}
                        onClick={() => void toggleUser(user)}
                      >
                        {user.status === 'active' ? '停用' : '启用'}
                      </Button>
                    </>
                  }
                >
                  <div className="flex items-center gap-2">
                    <Avatar size="sm">
                      <AvatarFallback>
                        {(user.displayName || user.username || '?').slice(0, 1)}
                      </AvatarFallback>
                    </Avatar>
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <strong className="truncate text-xs font-medium">
                          {user.displayName || user.username}
                        </strong>
                        <StatusPill tone={statusTone(user.status)}>
                          {user.status || 'unknown'}
                        </StatusPill>
                        {user.systemAdmin ? (
                          <span className="text-2xs font-semibold text-muted-foreground">
                            系统管理员
                          </span>
                        ) : null}
                      </div>
                      <p className="truncate text-2xs text-muted-foreground">
                        <code>{user.username}</code> · ID <code>{user.id}</code>
                      </p>
                      <p className="truncate text-2xs text-muted-foreground">
                        团队{' '}
                        {user.teams.length
                          ? user.teams.map((team) => team.name).join('、')
                          : '未分配'}
                      </p>
                      <p className="truncate text-2xs text-muted-foreground">
                        最近改密 {formatTime(user.passwordChangedAt)} · 创建{' '}
                        {formatTime(user.createdAt)}
                      </p>
                    </div>
                  </div>
                </Row>
              ))
            )}
          </div>
        </Panel>
      </div>

      <AccountDialog
        user={dialogUser}
        teams={teams}
        onClose={() => setDialogUser(null)}
        onSave={saveAccount}
      />
      <ResetPasswordDialog
        user={resetUser}
        onConfirm={resetPassword}
        onClose={() => setResetUser(null)}
      />
    </>
  )
}
