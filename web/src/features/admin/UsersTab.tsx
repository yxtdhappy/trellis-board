import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { toast } from 'sonner'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import type { AdminConsole } from '@/hooks/useAdminConsole'
import type { AdminUser } from '@/api/admin'
import { formatTime } from '@/lib/admin-shared'
import { AccountDialog, AccountForm } from './AccountDialog'
import type { AccountFormValues } from './AccountDialog'
import { EmptyRow, Field, Panel, Row, StatusPill } from './shared'

export function UsersTab({ console: consoleApi }: { console: AdminConsole }) {
  const { users, reloadUsers, createUser, updateUser, toggleUser, resetPassword } = consoleApi
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [systemAdmin, setSystemAdmin] = useState(false)
  const [busy, setBusy] = useState(false)
  const [selectedId, setSelectedId] = useState('')
  const [dialogUser, setDialogUser] = useState<AdminUser | null>(null)

  useEffect(() => {
    void reloadUsers()
  }, [reloadUsers])

  const selectedUser = users.find((user) => user.id === selectedId) ?? null

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    const created = await createUser({
      username: username.trim(),
      displayName: displayName.trim(),
      systemAdmin
    })
    setBusy(false)
    if (created) {
      setUsername('')
      setDisplayName('')
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
            description="创建账号时由服务端生成一次性临时密码；重置密码会撤销该用户全部会话。"
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
              <label className="flex items-center gap-2 text-xs text-foreground">
                <Checkbox
                  checked={systemAdmin}
                  onCheckedChange={(checked) => setSystemAdmin(checked === true)}
                  disabled={busy}
                />
                系统管理员
              </label>
              <Button size="sm" type="submit" className="self-start" disabled={busy}>
                创建并生成临时密码
              </Button>
            </form>
          </Panel>

          <Panel
            kicker="ACCOUNT / UPDATE"
            title="编辑账号"
            description="从账号列表选择成员后调整显示名、状态和系统管理员权限。"
          >
            {selectedUser ? (
              <AccountForm
                key={selectedUser.id}
                user={selectedUser}
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
            <span className="text-[11px] font-semibold text-muted-foreground">{users.length}</span>
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
                        onClick={() => void resetPassword(user)}
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
                        <StatusPill value={user.status} />
                        {user.systemAdmin ? (
                          <span className="text-[10px] font-semibold text-muted-foreground">
                            系统管理员
                          </span>
                        ) : null}
                        {user.mustChangePassword ? (
                          <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">
                            待改密
                          </span>
                        ) : null}
                      </div>
                      <p className="truncate text-[10px] text-muted-foreground">
                        <code>{user.username}</code> · ID <code>{user.id}</code>
                      </p>
                      <p className="truncate text-[10px] text-muted-foreground">
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

      <AccountDialog user={dialogUser} onClose={() => setDialogUser(null)} onSave={saveAccount} />
    </>
  )
}
