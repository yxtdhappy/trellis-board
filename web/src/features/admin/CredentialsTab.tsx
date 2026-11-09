import { useState } from 'react'
import type { FormEvent } from 'react'
import { KeyRound } from 'lucide-react'
import type { GitCredential, GitCredentialAuthType } from '@/api/admin'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { SelectField } from '@/features/board/SelectField'
import type { AdminConsole } from '@/hooks/useAdminConsole'
import { formatTime } from '@/lib/admin-shared'
import { EmptyRow, Field, Panel, Row } from './shared'

type CredentialForm = {
  id: string | null
  name: string
  host: string
  authType: GitCredentialAuthType
  username: string
  token: string
  privateKey: string
  passphrase: string
}

const EMPTY_FORM: CredentialForm = {
  id: null,
  name: '',
  host: '',
  authType: 'https_token',
  username: '',
  token: '',
  privateKey: '',
  passphrase: '',
}

const AUTH_OPTIONS = [
  { value: 'https_token', label: 'HTTPS 用户名与访问令牌' },
  { value: 'ssh_key', label: 'SSH 私钥' },
]

export function CredentialsTab({ console: consoleApi }: { console: AdminConsole }) {
  const {
    credentials,
    credentialsLoading,
    reloadCredentials,
    createCredential,
    updateCredential,
    deleteCredential,
    adminTeamId,
  } = consoleApi
  const [form, setForm] = useState<CredentialForm>(EMPTY_FORM)
  const [busy, setBusy] = useState(false)
  const canEdit = Boolean(adminTeamId && adminTeamId !== 'all')
  const editing = Boolean(form.id)

  function editCredential(credential: GitCredential) {
    setForm({
      id: credential.id,
      name: credential.name,
      host: credential.host,
      authType: credential.authType,
      username: credential.username || '',
      token: '',
      privateKey: '',
      passphrase: '',
    })
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canEdit || busy) return
    setBusy(true)
    const target = form.id ? credentials.find((item) => item.id === form.id) : null
    let saved = false
    if (target) {
      saved = await updateCredential(target, {
        name: form.name.trim(),
        ...(form.authType === 'https_token'
          ? {
              username: form.username.trim(),
              token: form.token || undefined,
            }
          : {
              privateKey: form.privateKey || undefined,
              passphrase: form.passphrase || undefined,
            }),
      })
    } else {
      saved = await createCredential({
        name: form.name.trim(),
        host: form.host.trim(),
        authType: form.authType,
        ...(form.authType === 'https_token'
          ? {
              username: form.username.trim(),
              token: form.token,
            }
          : {
              privateKey: form.privateKey,
              passphrase: form.passphrase || undefined,
            }),
      })
    }
    setBusy(false)
    if (saved) setForm(EMPTY_FORM)
  }

  return (
    <div className="grid gap-3.5 lg:grid-cols-[430px_minmax(0,1fr)]">
      <Panel
        kicker="GIT / CREDENTIALS"
        title={editing ? '编辑 Git 凭据' : '新增 Git 凭据'}
        description="凭据只在服务端解密使用；编辑时秘密字段留空表示保持现有值。"
      >
        {!canEdit ? (
          <EmptyRow>请先在顶部选择一个具体团队，再维护 Git 凭据。</EmptyRow>
        ) : (
          <form className="flex flex-col gap-2" onSubmit={submit}>
            <Field label="凭据名称">
              <Input
                maxLength={80}
                required
                value={form.name}
                disabled={busy}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
              />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Git 主机">
                <Input
                  maxLength={253}
                  required
                  placeholder="github.com"
                  value={form.host}
                  disabled={busy || editing}
                  onChange={(event) => setForm({ ...form, host: event.target.value })}
                />
              </Field>
              <Field label="认证类型">
                <SelectField
                  value={form.authType}
                  options={AUTH_OPTIONS}
                  disabled={busy || editing}
                  onChange={(value) =>
                    setForm({
                      ...form,
                      authType: value === 'ssh_key' ? 'ssh_key' : 'https_token',
                    })
                  }
                />
              </Field>
            </div>
            {form.authType === 'https_token' ? (
              <>
                <Field label="HTTPS 用户名">
                  <Input
                    maxLength={200}
                    required
                    autoComplete="username"
                    value={form.username}
                    disabled={busy}
                    onChange={(event) => setForm({ ...form, username: event.target.value })}
                  />
                </Field>
                <Field label="访问令牌 / PAT" hint={editing ? '留空保持现有令牌' : undefined}>
                  <Input
                    type="password"
                    maxLength={8192}
                    required={!editing}
                    autoComplete="off"
                    spellCheck={false}
                    value={form.token}
                    disabled={busy}
                    onChange={(event) => setForm({ ...form, token: event.target.value })}
                  />
                </Field>
              </>
            ) : (
              <>
                <Field label="SSH 私钥" hint={editing ? '留空保持现有私钥' : undefined}>
                  <Textarea
                    rows={6}
                    maxLength={32768}
                    required={!editing}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                    value={form.privateKey}
                    disabled={busy}
                    onChange={(event) => setForm({ ...form, privateKey: event.target.value })}
                  />
                </Field>
                <Field label="私钥口令（可选）" hint={editing ? '留空保持现有口令' : undefined}>
                  <Input
                    type="password"
                    maxLength={1024}
                    autoComplete="off"
                    value={form.passphrase}
                    disabled={busy}
                    onChange={(event) => setForm({ ...form, passphrase: event.target.value })}
                  />
                </Field>
              </>
            )}
            <div className="flex items-center gap-1.5">
              <Button size="sm" type="submit" disabled={busy}>
                {busy ? '保存中…' : editing ? '保存修改' : '创建凭据'}
              </Button>
              {editing ? (
                <Button
                  size="sm"
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => setForm(EMPTY_FORM)}
                >
                  取消编辑
                </Button>
              ) : null}
            </div>
          </form>
        )}
      </Panel>

      <Panel
        kicker="TEAM CREDENTIAL POOL"
        title="团队 Git 凭据"
        action={
          <Button
            variant="outline"
            size="sm"
            type="button"
            disabled={credentialsLoading}
            onClick={() => void reloadCredentials()}
          >
            刷新
          </Button>
        }
      >
        <div className="flex flex-col">
          {credentialsLoading && !credentials.length ? (
            <EmptyRow>正在读取 Git 凭据…</EmptyRow>
          ) : credentials.length === 0 ? (
            <EmptyRow>当前团队尚未维护 Git 凭据。</EmptyRow>
          ) : (
            credentials.map((credential) => (
              <Row
                key={credential.id}
                actions={
                  <>
                    <Button
                      size="sm"
                      type="button"
                      variant="outline"
                      disabled={!canEdit}
                      onClick={() => editCredential(credential)}
                    >
                      编辑
                    </Button>
                    <Button
                      size="sm"
                      type="button"
                      variant="ghost"
                      className="text-destructive"
                      disabled={!canEdit}
                      onClick={() => void deleteCredential(credential)}
                    >
                      删除
                    </Button>
                  </>
                }
              >
                <div className="flex items-start gap-2">
                  <KeyRound className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <strong className="truncate text-xs font-medium">{credential.name}</strong>
                      <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">
                        {credential.authType === 'https_token' ? 'HTTPS' : 'SSH'}
                      </span>
                      {credential.teamName ? (
                        <span className="text-[10px] text-muted-foreground">
                          {credential.teamName}
                        </span>
                      ) : null}
                    </div>
                    <p className="truncate text-[10px] text-muted-foreground">
                      <code>{credential.host}</code>
                      {credential.username ? ` · ${credential.username}` : ''}
                    </p>
                    <p className="text-[10px] text-muted-foreground">
                      {credential.projectCount
                        ? `引用项目：${credential.projects.map((project) => project.name).join('、')}`
                        : '尚未被项目引用'}
                    </p>
                    <p className="text-[10px] text-muted-foreground">
                      更新 {formatTime(credential.updatedAt)}
                    </p>
                  </div>
                </div>
              </Row>
            ))
          )}
        </div>
      </Panel>
    </div>
  )
}
