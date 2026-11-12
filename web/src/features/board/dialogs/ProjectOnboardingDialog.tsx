import { useEffect, useMemo, useRef, useState } from 'react'
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
import { Label } from '@/components/ui/label'
import { TRELLIS_AGENT_TOOLS } from '@shared/trellis-agent-tools.js'
import { sameLocalRepositoryPath } from '@/lib/onboarding-associations.js'
import { SelectField } from '../SelectField'

type TeamOption = {
  id: string
  name: string
}

type ProjectInspection = {
  root: string
  repositoryName: string
  remoteUrl: string
  branchName: string
  head: string
  clean: boolean
  hasTrellis: boolean
  hasTasks: boolean
  hasCommittedTrellis: boolean
  requiresInitialization: boolean
  existingAgentTools: string[]
}

type PushState = {
  state: string
  message?: string
  dirtySummary?: string
}

type SnapshotDifference = {
  type: string
  taskId: string | null
  taskDir: string | null
}

type PreflightCounts = {
  same: number
  localOnly: number
  serverOnly: number
  conflicts: number
  invalid: number
}

type PreflightResult = {
  status: string
  revision: number
  differences: SnapshotDifference[]
  counts: PreflightCounts
}

type InitialSyncMode = 'bootstrap' | 'safe' | 'review'

type LiveSyncStatus = 'pending' | 'syncing' | 'ready' | 'error'

type Association = {
  projectId: string
  taskSpaceId: string
  repoPath: string
  displayName: string
  branchName: string
  teamId: string | null
  status: string
  readOnly: boolean
  lastErrorCode: string | null
  lastError: string | null
  liveSyncStatus: LiveSyncStatus
  liveSyncError: string | null
}

type TauriInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>

type ProjectOnboardingDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  inspection: unknown
  teams: TeamOption[]
  defaultTeamId: string
  defaultDeveloperId: string
  invoke: TauriInvoke
  onAssociated: (association: Association) => void
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function normalizeInspection(value: unknown): ProjectInspection | null {
  if (!value || typeof value !== 'object') return null
  const outer = value as Record<string, unknown>
  const project =
    outer.project && typeof outer.project === 'object'
      ? (outer.project as Record<string, unknown>)
      : outer
  const root = text(project.root)
  const remoteUrl = text(project.remoteUrl)
  const branchName = text(project.branchName)
  if (!root || !remoteUrl || !branchName) return null
  return {
    root,
    repositoryName: text(project.repositoryName) || '本地项目',
    remoteUrl,
    branchName,
    head: text(project.head),
    clean: project.clean === true,
    hasTrellis: project.hasTrellis === true,
    hasTasks: project.hasTasks === true,
    hasCommittedTrellis: project.hasCommittedTrellis === true,
    requiresInitialization: project.requiresInitialization === true,
    existingAgentTools: stringList(project.existingAgentTools),
  }
}

function normalizeAssociation(value: unknown): Association | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  if (
    typeof row.projectId !== 'string' ||
    typeof row.taskSpaceId !== 'string' ||
    typeof row.repoPath !== 'string' ||
    typeof row.displayName !== 'string' ||
    typeof row.branchName !== 'string' ||
    typeof row.status !== 'string'
  ) {
    return null
  }
  return {
    projectId: row.projectId,
    taskSpaceId: row.taskSpaceId,
    repoPath: row.repoPath,
    displayName: row.displayName,
    branchName: row.branchName,
    teamId: typeof row.teamId === 'string' ? row.teamId : null,
    status: row.status,
    readOnly: row.readOnly === true,
    lastErrorCode: typeof row.lastErrorCode === 'string' ? row.lastErrorCode : null,
    lastError: typeof row.lastError === 'string' ? row.lastError : null,
    liveSyncStatus:
      row.liveSyncStatus === 'syncing' ||
      row.liveSyncStatus === 'ready' ||
      row.liveSyncStatus === 'error'
        ? row.liveSyncStatus
        : 'pending',
    liveSyncError: typeof row.liveSyncError === 'string' ? row.liveSyncError : null,
  }
}

function normalizePreflight(value: unknown): PreflightResult | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  const status = text(row.status)
  if (!status) return null
  const differences = Array.isArray(row.differences)
    ? row.differences
        .filter((item): item is Record<string, unknown> =>
          Boolean(item && typeof item === 'object'),
        )
        .map((item) => ({
          type: text(item.type),
          taskId: typeof item.taskId === 'string' ? item.taskId : null,
          taskDir: typeof item.taskDir === 'string' ? item.taskDir : null,
        }))
        .filter((item) => item.type)
    : []
  const rawCounts =
    row.counts && typeof row.counts === 'object' ? (row.counts as Record<string, unknown>) : {}
  const count = (key: string) => {
    const value = rawCounts[key]
    return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0
  }
  return {
    status,
    revision: typeof row.revision === 'number' && Number.isFinite(row.revision) ? row.revision : 0,
    differences,
    counts: {
      same: count('same'),
      localOnly: count('localOnly'),
      serverOnly: count('serverOnly'),
      conflicts: count('conflicts'),
      invalid: count('invalid'),
    },
  }
}

function stateLabel(push: PushState | null): string {
  if (!push) return ''
  switch (push.state) {
    case 'waiting_commit':
      return '等待提交：请先提交 .trellis 初始化文件。'
    case 'waiting_push':
      return '等待推送：本地提交还没有推送到远端分支。'
    case 'branch_missing':
      return '远端分支还不存在，请先执行 git push -u origin 当前分支。'
    case 'remote_ahead':
      return '远端分支比本地更新，请先拉取并处理后再接入。'
    case 'diverged':
      return '本地与远端已经分叉，请先处理 Git 历史。'
    case 'unable_to_verify':
      return '暂时无法连接远端，不能确认是否已经推送。'
    case 'ready':
      return '初始化文件已提交并推送，可以接入团队。'
    default:
      return push.message || '等待检查推送状态。'
  }
}

export function ProjectOnboardingDialog({
  open,
  onOpenChange,
  inspection: rawInspection,
  teams,
  defaultTeamId,
  defaultDeveloperId,
  invoke,
  onAssociated,
}: ProjectOnboardingDialogProps) {
  const [inspection, setInspection] = useState<ProjectInspection | null>(null)
  const [teamId, setTeamId] = useState('')
  const [developerId, setDeveloperId] = useState('')
  const [selectedTools, setSelectedTools] = useState<string[]>([])
  const [agentSearch, setAgentSearch] = useState('')
  const [push, setPush] = useState<PushState | null>(null)
  const [preflight, setPreflight] = useState<PreflightResult | null>(null)
  const [localAssociations, setLocalAssociations] = useState<Association[]>([])
  const [associationsLoaded, setAssociationsLoaded] = useState(false)
  const [associationLoadError, setAssociationLoadError] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [requiresInitialPush, setRequiresInitialPush] = useState(false)
  const pushCheckInFlight = useRef(false)
  const developerIdEdited = useRef(false)
  const dialogHeaderRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const normalized = normalizeInspection(rawInspection)
    setInspection(normalized)
    const preferredTeam = teams.some((team) => team.id === defaultTeamId)
      ? defaultTeamId
      : teams[0]?.id || ''
    setTeamId(preferredTeam)
    developerIdEdited.current = false
    setDeveloperId(defaultDeveloperId.trim())
    setSelectedTools(normalized?.existingAgentTools.filter((id) => id === 'codex') || [])
    setAgentSearch('')
    setPush(null)
    setPreflight(null)
    setMessage('')
    setBusy(false)
    setRequiresInitialPush(Boolean(normalized?.hasTrellis && !normalized.hasCommittedTrellis))
  }, [open, rawInspection, teams, defaultTeamId])

  useEffect(() => {
    if (!open || developerIdEdited.current) return
    setDeveloperId(defaultDeveloperId.trim())
  }, [open, rawInspection, defaultDeveloperId])

  useEffect(() => {
    if (!open) {
      setLocalAssociations([])
      setAssociationsLoaded(false)
      setAssociationLoadError('')
      return
    }
    let cancelled = false
    setAssociationsLoaded(false)
    setAssociationLoadError('')
    void invoke('list_local_associations')
      .then((value) => {
        if (cancelled) return
        setLocalAssociations(
          Array.isArray(value)
            ? value.map(normalizeAssociation).filter((item): item is Association => Boolean(item))
            : [],
        )
        setAssociationsLoaded(true)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setAssociationLoadError(
          error instanceof Error ? error.message : '无法读取当前设备的本地项目关联',
        )
      })
    return () => {
      cancelled = true
    }
  }, [open, rawInspection, invoke])

  const missingTools = useMemo(
    () =>
      inspection
        ? TRELLIS_AGENT_TOOLS.filter((tool) => !inspection.existingAgentTools.includes(tool.id))
        : [],
    [inspection],
  )
  const visibleAgentTools = useMemo(() => {
    const query = agentSearch.trim().toLowerCase()
    if (!query) return TRELLIS_AGENT_TOOLS
    return TRELLIS_AGENT_TOOLS.filter(
      (tool) => tool.label.toLowerCase().includes(query) || tool.id.toLowerCase().includes(query),
    )
  }, [agentSearch])
  const needsInitialization =
    !inspection?.hasTrellis ||
    !inspection?.hasTasks ||
    Boolean(inspection && missingTools.some((tool) => selectedTools.includes(tool.id)))
  const requiresPushCheck = requiresInitialPush
  const pushReady = push?.state === 'ready'
  const replacedAssociations = useMemo(
    () =>
      inspection
        ? localAssociations.filter(
            (association) =>
              association.status !== 'revoked' &&
              association.status !== 'rejected' &&
              association.branchName !== inspection.branchName &&
              sameLocalRepositoryPath(association.repoPath, inspection.root),
          )
        : [],
    [inspection, localAssociations],
  )

  function toggleTool(id: string) {
    setPreflight(null)
    setSelectedTools((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    )
    setMessage('')
  }

  async function initialize() {
    if (!inspection) return
    if (!developerId.trim()) {
      setMessage('请填写 Trellis developer ID。')
      return
    }
    if (!selectedTools.length) {
      setMessage('请至少选择一个本机需要使用的编码 Agent。')
      return
    }
    setBusy(true)
    setMessage('')
    setPreflight(null)
    const initializesTaskTree = !inspection.hasTrellis || !inspection.hasTasks
    const needsInitialPush = requiresInitialPush || initializesTaskTree
    try {
      const result = await invoke('initialize_pending_project', {
        developerId: developerId.trim(),
        agentTools: selectedTools,
      })
      const next = normalizeInspection(result)
      if (!next) throw new Error('初始化后没有返回有效项目信息')
      setInspection(next)
      setRequiresInitialPush(needsInitialPush)
      setPush(null)
      setPreflight(null)
      setMessage(
        needsInitialPush
          ? 'Trellis 初始化完成。请提交并推送共享初始化文件。'
          : '本机编码 Agent 工具初始化完成，不影响当前任务空间接入。',
      )
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Trellis 初始化失败')
    } finally {
      setBusy(false)
    }
  }

  async function checkPush({ silent = false } = {}) {
    if (!inspection || busy || pushCheckInFlight.current) return
    pushCheckInFlight.current = true
    if (!silent) {
      setBusy(true)
      setMessage('')
    }
    try {
      const result = (await invoke('check_pending_project_push', {
        branchName: inspection.branchName,
      })) as Record<string, unknown>
      const next: PushState = {
        state: text(result.state),
        message: text(result.message),
        dirtySummary: text(result.dirtySummary),
      }
      setPush(next)
      if (next.state !== 'ready') setPreflight(null)
      if (!silent) setMessage(stateLabel(next))
    } catch (error) {
      if (!silent) {
        setMessage(error instanceof Error ? error.message : '检查推送状态失败')
      }
    } finally {
      pushCheckInFlight.current = false
      if (!silent) setBusy(false)
    }
  }

  useEffect(() => {
    if (!open || !inspection || !requiresPushCheck || push?.state === 'ready' || busy) {
      return
    }
    const timer = window.setInterval(() => {
      void checkPush({ silent: true })
    }, 5_000)
    const onFocus = () => {
      void checkPush({ silent: true })
    }
    window.addEventListener('focus', onFocus)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [open, inspection, requiresPushCheck, push?.state, busy])

  function validateBeforePreflight() {
    if (!inspection) return
    if (!teamId) {
      setMessage('请选择项目归属团队。')
      return false
    }
    if (!developerId.trim()) {
      setMessage('请填写 Trellis developer ID。')
      return false
    }
    if (requiresPushCheck && !pushReady) {
      setMessage('请先确认初始化文件已经提交并成功推送到远端分支。')
      return false
    }
    return true
  }

  async function runPreflight() {
    if (!inspection || !validateBeforePreflight()) return
    setBusy(true)
    setMessage('')
    try {
      const result = await invoke('preflight_pending_project', {
        teamId,
        developerId: developerId.trim(),
        requirePushed: requiresPushCheck,
      })
      const next = normalizePreflight(result)
      if (!next) throw new Error('没有返回有效的任务预检结果')
      setPreflight(next)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '任务预检失败')
    } finally {
      setBusy(false)
    }
  }

  async function associate(initialMode: InitialSyncMode) {
    if (!inspection || !validateBeforePreflight()) return
    if (!associationsLoaded) {
      setMessage('无法确认当前仓库已有本地绑定，为避免重复绑定，暂不能接入。')
      return
    }
    if (
      replacedAssociations.length &&
      !window.confirm(
        [
          `当前本机已把该仓库绑定到其他分支：${replacedAssociations
            .map((item) => `${item.branchName}（任务空间 ${item.taskSpaceId}）`)
            .join('、')}。`,
          `确认替换为分支 ${inspection.branchName} 吗？`,
          '替换后本机停止同步旧分支；旧任务空间、旧任务和其他设备的绑定都不会删除。',
          '需要同时同步两个分支时，请为另一个分支使用独立 Git worktree。',
        ].join('\n'),
      )
    ) {
      return
    }
    setBusy(true)
    setMessage('')
    try {
      const result = await invoke('associate_pending_project', {
        teamId,
        developerId: developerId.trim(),
        requirePushed: requiresPushCheck,
        initialMode,
      })
      const association = normalizeAssociation(result)
      if (!association) throw new Error('关联后没有返回有效任务空间')
      onAssociated(association)
      onOpenChange(false)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '本地项目接入失败')
    } finally {
      setBusy(false)
    }
  }

  function cancelPendingProject() {
    if (busy) return
    void invoke('cancel_pending_project').catch(() => {})
    onOpenChange(false)
  }

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen && busy) return
    if (!nextOpen) {
      void invoke('cancel_pending_project').catch(() => {})
    }
    onOpenChange(nextOpen)
  }

  const actionableDifferences =
    preflight?.differences.filter((difference) => difference.type !== 'same') || []
  const newSnapshot = preflight?.status === 'new' || preflight?.status === 'branch_new'
  const hasDifferences = preflight?.status === 'existing' && actionableDifferences.length > 0
  const associationCheckPassed = associationsLoaded && !associationLoadError

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[620px]" initialFocus={dialogHeaderRef}>
        <DialogHeader ref={dialogHeaderRef} tabIndex={-1} className="outline-none">
          <DialogTitle>接入本地 Git 项目</DialogTitle>
          <DialogDescription>
            客户端负责初始化和任务同步，服务端不会读取或操作项目 Git 仓库。
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4">
          {!inspection ? (
            <p className="rounded-lg border border-dashed border-border p-4 text-muted-foreground">
              没有读取到有效的本地 Git 仓库，请重新选择仓库根目录。
            </p>
          ) : (
            <>
              <dl className="grid grid-cols-[92px_minmax(0,1fr)] gap-x-3 gap-y-2 rounded-lg bg-muted/40 p-3">
                <dt className="text-muted-foreground">仓库</dt>
                <dd className="min-w-0 break-words">{inspection.repositoryName}</dd>
                <dt className="text-muted-foreground">当前分支</dt>
                <dd className="break-words">{inspection.branchName}</dd>
                <dt className="text-muted-foreground">远端</dt>
                <dd className="break-all">{inspection.remoteUrl}</dd>
                <dt className="text-muted-foreground">Trellis</dt>
                <dd>
                  {inspection.hasTrellis
                    ? inspection.hasTasks
                      ? '已初始化'
                      : '.trellis 存在，但缺少 tasks 目录'
                    : '尚未初始化'}
                </dd>
                <dt className="text-muted-foreground">Git 状态</dt>
                <dd>{inspection.clean ? '相关路径干净' : '存在未提交文件'}</dd>
              </dl>

              {associationLoadError ? (
                <p className="rounded-lg border border-destructive/40 p-3 text-destructive">
                  无法读取本地项目关联，已阻止接入，避免产生重复绑定：{associationLoadError}
                </p>
              ) : open && !associationsLoaded ? (
                <p className="rounded-lg border border-dashed border-border p-3 text-muted-foreground">
                  正在核对当前仓库已有的本地绑定…
                </p>
              ) : replacedAssociations.length ? (
                <div className="flex flex-col gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
                  <p className="font-medium text-amber-700 dark:text-amber-400">
                    将替换当前仓库的旧分支绑定
                  </p>
                  <p className="text-muted-foreground">
                    当前目录准备接入 <code>{inspection.branchName}</code>，但本机仍绑定：
                  </p>
                  <ul className="flex flex-col gap-1">
                    {replacedAssociations.map((association) => (
                      <li key={association.taskSpaceId} className="break-all">
                        分支 <code>{association.branchName}</code>，任务空间{' '}
                        <code>{association.taskSpaceId}</code>
                      </li>
                    ))}
                  </ul>
                  <p className="text-muted-foreground">
                    接入前会再次确认。替换只会停止本机旧分支同步，不会删除旧任务空间、旧任务或其他设备的绑定。需要同时同步两个分支时，请使用独立
                    Git worktree。
                  </p>
                </div>
              ) : null}

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="onboard-team">项目归属团队</Label>
                  <SelectField
                    id="onboard-team"
                    value={teamId}
                    placeholder="请选择团队"
                    options={teams.map((team) => ({ value: team.id, label: team.name }))}
                    onChange={(value) => {
                      setTeamId(value)
                      setPreflight(null)
                    }}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="onboard-developer">Trellis developer ID</Label>
                  <Input
                    id="onboard-developer"
                    value={developerId}
                    maxLength={120}
                    placeholder="例如 zhangsan"
                    onChange={(event) => {
                      developerIdEdited.current = true
                      setDeveloperId(event.target.value)
                      setPreflight(null)
                    }}
                  />
                </div>
              </div>

              {!inspection.hasTrellis || !inspection.hasTasks || missingTools.length ? (
                <div className="flex flex-col gap-2">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <p className="font-medium">本机编码 Agent</p>
                      <p className="text-muted-foreground">
                        只影响当前电脑；已存在的工具不会重复初始化，其他设备无需选择相同工具。
                      </p>
                    </div>
                    <Input
                      type="search"
                      aria-label="搜索 Agent"
                      className="h-8 w-full sm:w-52"
                      placeholder="搜索名称或 ID"
                      value={agentSearch}
                      onChange={(event) => setAgentSearch(event.target.value)}
                    />
                  </div>
                  <div className="grid max-h-64 gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
                    {visibleAgentTools.length ? (
                      visibleAgentTools.map((tool) => {
                        const existing = inspection.existingAgentTools.includes(tool.id)
                        return (
                          <label
                            key={tool.id}
                            className="flex items-center gap-2 rounded-md border border-border px-2.5 py-2"
                          >
                            <input
                              type="checkbox"
                              checked={existing || selectedTools.includes(tool.id)}
                              disabled={existing || busy}
                              onChange={() => toggleTool(tool.id)}
                            />
                            <span>{tool.label}</span>
                            {existing ? (
                              <span className="ml-auto text-[10px] text-muted-foreground">
                                已存在
                              </span>
                            ) : null}
                          </label>
                        )
                      })
                    ) : (
                      <p className="rounded-md border border-dashed border-border px-2.5 py-3 text-muted-foreground sm:col-span-2">
                        没有匹配的 Agent
                      </p>
                    )}
                  </div>
                  {needsInitialization ? (
                    <Button
                      type="button"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void initialize()}
                    >
                      {busy ? '正在初始化…' : '初始化缺失的 Trellis 与 Agent 工具'}
                    </Button>
                  ) : null}
                </div>
              ) : null}

              {requiresPushCheck ? (
                <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
                  <p className="font-medium">首次推送确认</p>
                  <p className="text-muted-foreground">
                    请先检查生成的 `.trellis` 文件，然后手动提交并推送到 `{inspection.branchName}
                    `。客户端不会自动 commit 或 push。
                  </p>
                  <code className="rounded bg-muted px-2 py-1 text-[11px]">
                    git add .trellis && git commit && git push
                  </code>
                  <Button
                    type="button"
                    variant="outline"
                    className="w-fit"
                    disabled={busy}
                    onClick={() => void checkPush()}
                  >
                    {busy ? '正在检查…' : '检查推送状态'}
                  </Button>
                  {push ? (
                    <p
                      className={
                        pushReady
                          ? 'text-emerald-700 dark:text-emerald-400'
                          : 'text-amber-700 dark:text-amber-400'
                      }
                    >
                      {stateLabel(push)}
                      {push.dirtySummary ? (
                        <span className="mt-1 block break-words">{push.dirtySummary}</span>
                      ) : null}
                    </p>
                  ) : null}
                </div>
              ) : null}

              {preflight ? (
                <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/25 p-3">
                  {preflight.status === 'access_required' ? (
                    <>
                      <p className="font-medium text-destructive">当前团队还没有该项目的访问权限</p>
                      <p className="text-muted-foreground">
                        项目已经被其他团队接入。请让项目负责人邀请当前团队后，再重新执行预检。
                      </p>
                    </>
                  ) : preflight.status === 'unavailable' ? (
                    <>
                      <p className="font-medium text-destructive">项目或任务分支已停用</p>
                      <p className="text-muted-foreground">
                        当前不能接入。请让项目负责人恢复项目或该分支后，再重新执行预检。
                      </p>
                    </>
                  ) : newSnapshot ? (
                    <>
                      <p className="font-medium">服务端还没有这个分支的任务快照</p>
                      <p className="text-muted-foreground">
                        接入后会以当前本地任务作为初始版本上传。当前检测到{' '}
                        {preflight.counts.localOnly} 个可上传任务
                        {preflight.counts.invalid
                          ? `，另有 ${preflight.counts.invalid} 个任务结构异常需要检查`
                          : '。'}
                      </p>
                    </>
                  ) : hasDifferences ? (
                    <>
                      <p className="font-medium text-amber-700 dark:text-amber-400">
                        本地与服务端的任务需要确认
                      </p>
                      <p className="text-muted-foreground">
                        服务端独有 {preflight.counts.serverOnly} 个，本地独有{' '}
                        {preflight.counts.localOnly} 个，内容冲突 {preflight.counts.conflicts} 个
                        {preflight.counts.invalid
                          ? `，结构异常 ${preflight.counts.invalid} 个`
                          : ''}
                        。暂不接入不会建立绑定，也不会写入本地游标或服务端。
                      </p>
                    </>
                  ) : (
                    <>
                      <p className="font-medium text-emerald-700 dark:text-emerald-400">
                        双方任务一致，可以安全接入
                      </p>
                      <p className="text-muted-foreground">
                        服务端版本 {preflight.revision}，没有需要额外处理的差异。
                      </p>
                    </>
                  )}
                </div>
              ) : null}
            </>
          )}
          {message ? (
            <p className="text-xs text-muted-foreground" role="status">
              {message}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter className="flex-wrap gap-2">
          <Button type="button" variant="outline" disabled={busy} onClick={cancelPendingProject}>
            {preflight ? '暂不接入' : '取消'}
          </Button>
          {!preflight ? (
            <Button
              type="button"
              disabled={busy || !inspection || (requiresPushCheck && !pushReady)}
              onClick={() => void runPreflight()}
            >
              {busy ? '正在检查…' : '检查任务差异'}
            </Button>
          ) : preflight.status === 'access_required' ||
            preflight.status === 'unavailable' ? null : newSnapshot ? (
            <Button
              type="button"
              disabled={busy || !associationCheckPassed}
              onClick={() => void associate(preflight.counts.invalid > 0 ? 'review' : 'bootstrap')}
            >
              {busy
                ? '正在接入…'
                : preflight.counts.invalid > 0
                  ? '接入并检查异常任务'
                  : '接入并上传本地任务'}
            </Button>
          ) : hasDifferences ? (
            <>
              <Button
                type="button"
                disabled={busy || !associationCheckPassed}
                onClick={() => void associate('safe')}
              >
                仅同步无冲突项
              </Button>
              <Button
                type="button"
                disabled={busy || !associationCheckPassed}
                onClick={() => void associate('review')}
              >
                查看并处理差异
              </Button>
            </>
          ) : (
            <Button
              type="button"
              disabled={busy || !associationCheckPassed}
              onClick={() => void associate('safe')}
            >
              {busy ? '正在接入…' : '接入任务空间'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
