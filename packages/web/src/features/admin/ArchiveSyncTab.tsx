import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { useConfirm } from '@/components/ui/confirm-dialog'
import type {
  ArchiveCredentialInput,
  ArchiveGitCredential,
  ArchiveTaskSpaceSync,
} from '@/api/admin'
import { formatTime, statusTone } from '@/lib/admin-shared'
import { useArchiveSync } from '@/hooks/useArchiveSync'
import { SelectField } from '@/features/board/SelectField'
import { StatusPill } from '@/components/ui/status-pill'
import { EmptyRow } from '@/components/ui/empty-row'
import { Field, Panel, Row } from './shared.tsx'
import { Skeleton } from '@/components/ui/skeleton'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'

const STATUS_LABELS: Record<string, string> = {
  idle: '等待同步',
  syncing: '正在拉取',
  importing: '正在导入',
  indexing: '正在更新索引',
  current: '已更新',
  stale: '索引落后',
  error: '同步失败',
  index_error: '索引失败',
}

const PROJECT_PREVIEW_LIMIT = 5

function statusLabel(value: string) {
  return STATUS_LABELS[value] || value
}

function credentialStateLabel(value: string) {
  if (value === 'configured') return '已匹配 · 未验证'
  if (value === 'anonymous') return '公开 HTTPS 匿名'
  if (value === 'missing') return '缺少 SSH 凭据'
  if (value === 'unsupported') return '远端协议不支持'
  return value ? `未知凭据状态（${value}）` : '凭据状态未知'
}

function displayText(value: string | null | undefined, fallback: string) {
  return value?.trim() || fallback
}

type AffectedProject = {
  key: string
  name: string
  branches: string[]
}

function credentialProjects(taskSpaces: ArchiveTaskSpaceSync[], credentialId: string) {
  if (!credentialId) return []
  const projects = new Map<string, AffectedProject>()
  taskSpaces.forEach((taskSpace, index) => {
    if (taskSpace.credential?.id !== credentialId) return
    const key = taskSpace.projectId || taskSpace.taskSpaceId || `project-${index}`
    const project = projects.get(key) ?? {
      key,
      name: displayText(taskSpace.projectName, '项目名称缺失'),
      branches: [],
    }
    const branchName = displayText(taskSpace.branchName, '分支名称缺失')
    if (!project.branches.includes(branchName)) project.branches.push(branchName)
    projects.set(key, project)
  })
  return [...projects.values()]
}

function taskSpaceText(taskSpace: ArchiveTaskSpaceSync) {
  const projectName = displayText(taskSpace.projectName, '项目名称缺失')
  const branchName = displayText(taskSpace.branchName, '分支名称缺失')
  return `${projectName} · ${branchName}`
}

function affectedProjectText(project: AffectedProject) {
  return `${project.name} · ${project.branches.join(' / ')}`
}

function shortHead(value: string | null) {
  return value ? value.slice(0, 10) : '—'
}

type CredentialDraft = {
  name: string
  scheme: 'ssh' | 'https'
  host: string
  port: string
  username: string
  token: string
  privateKey: string
}

const EMPTY_CREDENTIAL: CredentialDraft = {
  name: '',
  scheme: 'ssh',
  host: '',
  port: '22',
  username: 'x-access-token',
  token: '',
  privateKey: '',
}

export function ArchiveSyncTab() {
  const sync = useArchiveSync()
  const confirm = useConfirm()
  const [enabled, setEnabled] = useState(true)
  const [intervalSeconds, setIntervalSeconds] = useState('300')
  const [editing, setEditing] = useState<ArchiveGitCredential | null>(null)
  const [draft, setDraft] = useState<CredentialDraft>(EMPTY_CREDENTIAL)
  const [expandedCredentialKey, setExpandedCredentialKey] = useState<string | null>(null)
  const configVersionRef = useRef('')

  useEffect(() => {
    if (!sync.overview) {
      configVersionRef.current = ''
      return
    }
    const version = sync.overview.config.updatedAt || 'initial'
    if (configVersionRef.current === version) return
    configVersionRef.current = version
    setEnabled(sync.overview.config.enabled)
    setIntervalSeconds(String(sync.overview.config.intervalSeconds))
  }, [sync.overview])

  function editCredential(credential: ArchiveGitCredential) {
    setEditing(credential)
    setDraft({
      name: credential.name,
      scheme: credential.scheme,
      host: credential.host,
      port: String(credential.port),
      username: credential.username || 'x-access-token',
      token: '',
      privateKey: '',
    })
  }

  function resetCredential() {
    setEditing(null)
    setDraft(EMPTY_CREDENTIAL)
  }

  async function saveConfig(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    await sync.saveConfig({
      enabled,
      intervalSeconds: Number(intervalSeconds),
    })
  }

  async function saveCredential(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const input: ArchiveCredentialInput = {
      name: draft.name.trim(),
      scheme: draft.scheme,
      host: draft.host.trim(),
      port: Number(draft.port),
      username: draft.scheme === 'https' ? draft.username.trim() : undefined,
      token: draft.scheme === 'https' ? draft.token : undefined,
      privateKey: draft.scheme === 'ssh' ? draft.privateKey : undefined,
    }
    const saved = await sync.saveCredential(input, editing?.id)
    if (saved) resetCredential()
  }

  async function deleteCredential(credential: ArchiveGitCredential) {
    const affected = credentialProjects(sync.overview?.taskSpaces ?? [], credential.id)
    const visibleProjects = affected.slice(0, PROJECT_PREVIEW_LIMIT)
    const remainingProjects = affected.length - visibleProjects.length
    const credentialName = displayText(credential.name, '未命名凭据')
    const accepted = await confirm({
      title: `删除 ${displayText(credential.origin, '该来源')} 的归档凭据？`,
      description: (
        <div className="flex flex-col gap-2">
          <p>删除后，该来源的 SSH 归档同步会立即失败；HTTPS 会退回匿名访问。</p>
          <p>
            将影响 <strong className="text-foreground">{affected.length}</strong> 个自动匹配项目。
          </p>
          {affected.length === 0 ? (
            <p>当前没有项目使用凭据“{credentialName}”。</p>
          ) : (
            <>
              <ul
                aria-label={`凭据 ${credentialName} 的受影响项目`}
                className="flex max-h-40 flex-col gap-1 overflow-y-auto rounded-md border border-border bg-muted/30 p-2"
              >
                {visibleProjects.map((project) => (
                  <li
                    key={project.key}
                    className="min-w-0 break-words"
                    title={affectedProjectText(project)}
                  >
                    {affectedProjectText(project)}
                  </li>
                ))}
              </ul>
              {remainingProjects > 0 ? (
                <p>
                  另有 {remainingProjects} 个项目同样受影响，此处仅列出前 {visibleProjects.length}{' '}
                  个。
                </p>
              ) : null}
            </>
          )}
        </div>
      ),
      confirmText: '删除凭据',
      tone: 'danger',
    })
    if (accepted) await sync.removeCredential(credential)
  }

  if (sync.loading && !sync.overview) {
    return (
      <div className="flex flex-col gap-2 rounded-xl bg-card p-4">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-8 w-full" />
      </div>
    )
  }

  if (sync.error && !sync.overview) {
    return (
      <Alert variant="destructive">
        <AlertTitle>{sync.error}</AlertTitle>
        <AlertDescription>
          <Button size="sm" variant="outline" type="button" onClick={() => void sync.reload()}>
            重新读取
          </Button>
        </AlertDescription>
      </Alert>
    )
  }

  const overview = sync.overview
  if (!overview) return null

  return (
    <>
      <div className="grid gap-3.5 xl:grid-cols-[380px_minmax(0,1fr)]">
        <div className="flex flex-col gap-3.5">
          <Panel
            kicker="ARCHIVE / SCHEDULE"
            title="定时同步"
            description="服务端只读取各项目分支的 .trellis/tasks/archive，不经过 Agent 上传。"
            action={
              <Button
                type="button"
                variant="outline"
                disabled={sync.busy}
                onClick={() => void sync.run()}
              >
                全部立即同步
              </Button>
            }
          >
            <form className="flex flex-col gap-3" onSubmit={saveConfig}>
              <label className="flex items-center justify-between gap-3 rounded-lg bg-muted/40 px-3 py-2">
                <span>
                  <strong className="block text-xs font-medium">启用后台同步</strong>
                  <span className="text-xs text-muted-foreground">关闭后仍可手动立即同步。</span>
                </span>
                <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="启用归档同步" />
              </label>
              <Field label="同步周期（秒）" hint="允许 60 到 86400 秒。">
                <Input
                  type="number"
                  min={60}
                  max={86400}
                  required
                  value={intervalSeconds}
                  onChange={(event) => setIntervalSeconds(event.target.value)}
                />
              </Field>
              <p className="text-xs text-muted-foreground">
                最近保存 {formatTime(overview.config.updatedAt)}
              </p>
              <Button type="submit" className="self-start" disabled={sync.busy}>
                保存同步配置
              </Button>
            </form>
          </Panel>

          <Panel
            kicker="ARCHIVE / CREDENTIALS"
            title={editing ? `编辑 ${displayText(editing.origin, '来源地址缺失')}` : '新增来源凭据'}
            description="凭据严格按 scheme + host + port 隔离，不会跨域名或端口复用。"
          >
            <form className="flex flex-col gap-2.5" onSubmit={saveCredential}>
              <div className="grid grid-cols-[1fr_100px] gap-2">
                <Field label="远端协议">
                  <SelectField
                    value={draft.scheme}
                    disabled={Boolean(editing)}
                    options={[
                      { value: 'ssh', label: 'SSH 私钥' },
                      { value: 'https', label: 'HTTPS Token / 匿名' },
                    ]}
                    onChange={(scheme) =>
                      setDraft((current) => ({
                        ...current,
                        scheme: scheme as 'ssh' | 'https',
                        port: scheme === 'ssh' ? '22' : '443',
                      }))
                    }
                  />
                </Field>
                <Field label="端口">
                  <Input
                    type="number"
                    min={1}
                    max={65535}
                    required
                    disabled={Boolean(editing)}
                    value={draft.port}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, port: event.target.value }))
                    }
                  />
                </Field>
              </div>
              <Field label="主机">
                <Input
                  required
                  disabled={Boolean(editing)}
                  placeholder="git.weintdata.cn"
                  value={draft.host}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, host: event.target.value }))
                  }
                />
              </Field>
              <Field label="名称">
                <Input
                  maxLength={100}
                  value={draft.name}
                  placeholder="例如：公司 Git 只读凭据"
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, name: event.target.value }))
                  }
                />
              </Field>
              {draft.scheme === 'https' ? (
                <>
                  <Field label="HTTPS 用户名">
                    <Input
                      maxLength={200}
                      value={draft.username}
                      onChange={(event) =>
                        setDraft((current) => ({ ...current, username: event.target.value }))
                      }
                    />
                  </Field>
                  <Field
                    label={editing ? '轮换 Token（留空则保留）' : '访问 Token'}
                    hint="公开仓库也可以不创建 HTTPS 凭据。"
                  >
                    <Input
                      type="password"
                      autoComplete="new-password"
                      required={!editing}
                      value={draft.token}
                      onChange={(event) =>
                        setDraft((current) => ({ ...current, token: event.target.value }))
                      }
                    />
                  </Field>
                </>
              ) : (
                <>
                  <Field
                    label={editing ? '轮换 SSH 私钥（留空则保留）' : 'SSH 私钥'}
                    hint="连接时只使用私钥，不校验 SSH 主机密钥。"
                  >
                    <Textarea
                      className="min-h-28 font-mono text-xs"
                      autoComplete="off"
                      required={!editing}
                      value={draft.privateKey}
                      onChange={(event) =>
                        setDraft((current) => ({ ...current, privateKey: event.target.value }))
                      }
                    />
                  </Field>
                </>
              )}
              <div className="flex gap-2">
                <Button type="submit" disabled={sync.busy}>
                  {editing ? '保存凭据' : '创建凭据'}
                </Button>
                {editing ? (
                  <Button size="sm" type="button" variant="outline" onClick={resetCredential}>
                    取消编辑
                  </Button>
                ) : null}
              </div>
            </form>
          </Panel>
        </div>

        <div className="flex flex-col gap-3.5">
          <Panel
            kicker="ARCHIVE / ORIGINS"
            title="远端来源凭据"
            action={
              <span className="text-xs font-semibold text-muted-foreground">
                {overview.credentials.length}
              </span>
            }
          >
            <div className="flex flex-col">
              {overview.credentials.length === 0 ? (
                <EmptyRow>尚未配置归档 Git 凭据。公开 HTTPS 可直接匿名读取。</EmptyRow>
              ) : (
                overview.credentials.map((credential, index) => {
                  const credentialKey = credential.id || `credential-${index}`
                  const credentialName = displayText(credential.name, '未命名凭据')
                  const affected = credentialProjects(overview.taskSpaces, credential.id)
                  const expanded = expandedCredentialKey === credentialKey
                  const projectListId = `archive-credential-${index}-projects`
                  return (
                    <Row
                      key={credentialKey}
                      actions={
                        <>
                          <Button
                            size="sm"
                            type="button"
                            variant="outline"
                            disabled={sync.busy}
                            onClick={() => void sync.testCredential(credential)}
                          >
                            测试
                          </Button>
                          <Button
                            size="sm"
                            type="button"
                            variant="ghost"
                            onClick={() => editCredential(credential)}
                          >
                            编辑
                          </Button>
                          <Button
                            size="sm"
                            type="button"
                            variant="ghost"
                            className="text-destructive"
                            disabled={sync.busy}
                            onClick={() => void deleteCredential(credential)}
                          >
                            删除
                          </Button>
                        </>
                      }
                    >
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                          <strong
                            className="min-w-0 truncate text-xs font-medium"
                            title={credentialName}
                          >
                            {credentialName}
                          </strong>
                          <StatusPill tone={statusTone(credential.scheme.toUpperCase())}>
                            {credential.scheme.toUpperCase() || 'unknown'}
                          </StatusPill>
                          <StatusPill tone={statusTone('已配置')}>已配置</StatusPill>
                        </div>
                        <p className="truncate text-xs text-muted-foreground">
                          <code>{displayText(credential.origin, '来源地址缺失')}</code> · 更新{' '}
                          {formatTime(credential.updatedAt)}
                        </p>
                        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                          <span>自动适用 {affected.length} 个项目</span>
                          {affected.length > 0 ? (
                            <Button
                              size="xs"
                              type="button"
                              variant="ghost"
                              aria-label={`${expanded ? '收起' : '查看'}凭据 ${credentialName} 的适用项目`}
                              aria-expanded={expanded}
                              aria-controls={projectListId}
                              onClick={() =>
                                setExpandedCredentialKey((current) =>
                                  current === credentialKey ? null : credentialKey,
                                )
                              }
                            >
                              {expanded ? '收起项目' : '查看项目'}
                            </Button>
                          ) : (
                            <span>当前没有项目使用此来源</span>
                          )}
                        </div>
                        {expanded && affected.length > 0 ? (
                          <ul
                            id={projectListId}
                            tabIndex={0}
                            aria-label={`凭据 ${credentialName} 自动适用的项目`}
                            className="mt-1 flex max-h-40 flex-col gap-1 overflow-y-auto overscroll-contain rounded-md border border-border bg-muted/30 p-2 text-xs text-muted-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
                          >
                            {affected.map((project) => (
                              <li
                                key={project.key}
                                className="min-w-0 break-words"
                                title={affectedProjectText(project)}
                              >
                                {affectedProjectText(project)}
                              </li>
                            ))}
                          </ul>
                        ) : null}
                      </div>
                    </Row>
                  )
                })
              )}
            </div>
          </Panel>

          <Panel
            kicker="ARCHIVE / TASK SPACES"
            title="项目与分支"
            description="最近更新时间是归档文件成功进入任务索引的时间，不是最近尝试时间。"
            action={
              <Button
                type="button"
                variant="outline"
                disabled={sync.busy}
                onClick={() => void sync.reload(true)}
              >
                刷新状态
              </Button>
            }
          >
            <div className="flex flex-col">
              {overview.taskSpaces.length === 0 ? (
                <EmptyRow>暂无活动的项目分支。</EmptyRow>
              ) : (
                overview.taskSpaces.map((taskSpace) => (
                  <TaskSpaceRow
                    key={taskSpace.taskSpaceId}
                    taskSpace={taskSpace}
                    busy={sync.busy}
                    onRun={() => void sync.run(taskSpace.taskSpaceId)}
                    onLogs={() => void sync.openLogs(taskSpace)}
                  />
                ))
              )}
            </div>
          </Panel>
        </div>
      </div>

      <Dialog open={Boolean(sync.logsTaskSpace)} onOpenChange={(open) => !open && sync.closeLogs()}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>归档同步失败日志</DialogTitle>
            <DialogDescription>
              {sync.logsTaskSpace
                ? `${taskSpaceText(sync.logsTaskSpace)}，按时间倒序展示最近 100 条失败。`
                : ''}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="flex flex-col gap-2">
            {sync.logsError ? (
              <Alert variant="destructive">
                <AlertDescription>{sync.logsError}</AlertDescription>
              </Alert>
            ) : null}
            {sync.logs.length === 0 && !sync.logsLoading ? (
              sync.logsError ? null : (
                <EmptyRow>该分支没有失败日志。</EmptyRow>
              )
            ) : (
              sync.logs.map((log) => (
                <article
                  key={log.id}
                  className="rounded-lg border border-border bg-background/60 p-3"
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    <StatusPill tone={statusTone(log.phase)}>{log.phase || 'unknown'}</StatusPill>
                    <code className="text-xs text-destructive">{log.errorCode}</code>
                    <span className="ml-auto text-2xs text-muted-foreground">
                      {formatTime(log.createdAt)}
                    </span>
                  </div>
                  <p className="mt-1 break-words text-xs text-foreground">{log.message}</p>
                </article>
              ))
            )}
            {sync.logsLoading ? <Skeleton className="mx-auto my-2 h-16 w-full" /> : null}
          </DialogBody>
          <DialogFooter>
            {sync.logsHasMore ? (
              <Button
                size="sm"
                type="button"
                variant="outline"
                disabled={sync.logsLoading}
                onClick={() => void sync.loadMoreLogs()}
              >
                加载更多
              </Button>
            ) : null}
            <Button size="sm" type="button" variant="outline" onClick={sync.closeLogs}>
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

function TaskSpaceRow({
  taskSpace,
  busy,
  onRun,
  onLogs,
}: {
  taskSpace: ArchiveTaskSpaceSync
  busy: boolean
  onRun: () => void
  onLogs: () => void
}) {
  const failed = taskSpace.status === 'error' || taskSpace.status === 'index_error'
  return (
    <Row
      actions={
        <>
          <Button size="sm" type="button" variant="outline" disabled={busy} onClick={onRun}>
            立即同步
          </Button>
          {taskSpace.failureCount > 0 ? (
            <Button size="sm" type="button" variant="ghost" onClick={onLogs}>
              失败日志
            </Button>
          ) : null}
        </>
      }
    >
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <strong className="truncate text-xs font-medium">
            {displayText(taskSpace.projectName, '项目名称缺失')}
          </strong>
          <StatusPill tone={statusTone(displayText(taskSpace.branchName, '分支名称缺失'))}>
            {displayText(taskSpace.branchName, '分支名称缺失') || 'unknown'}
          </StatusPill>
          <StatusPill tone={statusTone(statusLabel(taskSpace.status))}>
            {statusLabel(taskSpace.status) || 'unknown'}
          </StatusPill>
          <span className="text-2xs text-muted-foreground">
            {credentialStateLabel(taskSpace.credentialState)}
          </span>
        </div>
        <div className="grid gap-x-4 gap-y-0.5 text-xs text-muted-foreground sm:grid-cols-2">
          <span>
            最近更新：{taskSpace.lastIndexedAt ? formatTime(taskSpace.lastIndexedAt) : '尚未更新'}
          </span>
          <span>最近尝试：{formatTime(taskSpace.lastAttemptAt)}</span>
          <span>最近成功：{formatTime(taskSpace.lastSuccessAt)}</span>
          <span>
            文件 {taskSpace.fileCount} · 归档 revision {taskSpace.archiveIndexedRevision}/
            {taskSpace.archiveRevision}
          </span>
          <span>
            Commit <code>{shortHead(taskSpace.remoteHead)}</code>
          </span>
          {taskSpace.credentialState === 'configured' ? (
            <span
              className="truncate"
              title={`使用凭据：${displayText(taskSpace.credential?.name, '凭据名称缺失')}`}
            >
              使用凭据：{displayText(taskSpace.credential?.name, '凭据名称缺失')}
            </span>
          ) : null}
          <span className="truncate" title={taskSpace.origin || taskSpace.remoteUrl}>
            来源 <code>{displayText(taskSpace.origin || taskSpace.remoteUrl, '来源地址缺失')}</code>
          </span>
        </div>
        {taskSpace.nextAttemptAt ? (
          <p className="text-2xs text-muted-foreground">
            下次自动尝试：{formatTime(taskSpace.nextAttemptAt)}
          </p>
        ) : null}
        {taskSpace.lastError ? (
          <p className={failed ? 'text-2xs text-destructive' : 'text-2xs text-muted-foreground'}>
            {taskSpace.lastError}
          </p>
        ) : null}
      </div>
    </Row>
  )
}
