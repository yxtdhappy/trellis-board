import { useEffect, useMemo, useRef, useState } from 'react'
import { FolderGit2, LockKeyhole, Plus, RefreshCw, Upload } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { ProjectOnboardingDialog } from '@/features/board/dialogs/ProjectOnboardingDialog'
import { sameLocalRepositoryPath } from '@/lib/onboarding-associations.js'
import { selectProjectAssociation } from '@/lib/project-rail-association.js'

type Project = {
  id: string
  name: string
  teamId?: string | null
  syncBranch?: string | null
  teamName?: string | null
  taskSpaces?: {
    id: string
    branchName: string
    readOnly?: boolean
    status?: string
  }[]
}

type LiveSyncStatus = 'pending' | 'syncing' | 'ready' | 'error'

type LocalAssociation = {
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
  deferredCount: number
  deferredTaskDirs: string[]
}

type SidecarStatus = {
  running: boolean
  paused: boolean
}

type ProjectAssociationView = {
  label: string
  detail: string | null
  dotClassName: string
  textClassName: string
}

type TauriInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>

type ProjectRailProps = {
  projects: Project[]
  teams: { id: string; name: string }[]
  defaultDeveloperId: string
  current: string
  teamId: string
  onSelect: (id: string) => void
  currentTaskSpace: string
  onSelectTaskSpace: (taskSpaceId: string) => void
  onManage: () => void
  manageEnabled?: boolean
  syncLabel: string
  syncLive: boolean
  refreshing: boolean
  onRefresh: () => void
}

function tauriInvoke(): TauriInvoke | null {
  const runtime = window as Window & {
    __TAURI__?: { core?: { invoke?: TauriInvoke } }
  }
  return runtime.__TAURI__?.core?.invoke || null
}

function normalizeLiveSyncStatus(value: unknown): LiveSyncStatus {
  return value === 'syncing' || value === 'ready' || value === 'error' ? value : 'pending'
}

function normalizeAssociation(value: unknown): LocalAssociation | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (
    typeof record.projectId !== 'string' ||
    typeof record.taskSpaceId !== 'string' ||
    typeof record.repoPath !== 'string' ||
    typeof record.displayName !== 'string' ||
    typeof record.branchName !== 'string' ||
    typeof record.status !== 'string'
  ) {
    return null
  }
  const deferredTaskDirs = Array.isArray(record.deferredTaskDirs)
    ? record.deferredTaskDirs.filter(
        (taskDir): taskDir is string =>
          typeof taskDir === 'string' && taskDir.startsWith('.trellis/tasks/'),
      )
    : []
  const deferredCount =
    deferredTaskDirs.length ||
    (typeof record.deferredCount === 'number' && Number.isSafeInteger(record.deferredCount)
      ? Math.max(0, record.deferredCount)
      : 0)
  return {
    projectId: record.projectId,
    taskSpaceId: record.taskSpaceId,
    repoPath: record.repoPath,
    displayName: record.displayName,
    branchName: record.branchName,
    teamId: typeof record.teamId === 'string' ? record.teamId : null,
    status: record.status,
    readOnly: record.readOnly === true,
    lastErrorCode: typeof record.lastErrorCode === 'string' ? record.lastErrorCode : null,
    lastError: typeof record.lastError === 'string' ? record.lastError : null,
    liveSyncStatus: normalizeLiveSyncStatus(record.liveSyncStatus),
    liveSyncError:
      typeof record.liveSyncError === 'string' && record.liveSyncError.trim()
        ? record.liveSyncError.trim()
        : null,
    deferredCount,
    deferredTaskDirs,
  }
}

function normalizeAssociations(value: unknown): LocalAssociation[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const association = normalizeAssociation(item)
    return association ? [association] : []
  })
}

function normalizeSidecarStatus(value: unknown): SidecarStatus | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (typeof record.running !== 'boolean' || typeof record.paused !== 'boolean') {
    return null
  }
  return { running: record.running, paused: record.paused }
}

function associationErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return message.trim() || '本地项目关联失败，请检查仓库和同步分支后重试。'
}

function deferredSyncErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return message.trim() || '本地待同步任务补传失败'
}

function projectAssociationView(association: LocalAssociation | undefined): ProjectAssociationView {
  if (!association) {
    return {
      label: '未关联 · 关联本地仓库',
      detail: null,
      dotClassName: 'bg-muted-foreground/40',
      textClassName: 'text-muted-foreground',
    }
  }
  if (association.status !== 'approved') {
    const error =
      association.lastError?.trim() || association.lastErrorCode?.trim() || '本地关联已失效'
    return {
      label: `关联失效 · ${error}`,
      detail: error,
      dotClassName: 'bg-destructive',
      textClassName: 'text-destructive',
    }
  }
  if (association.readOnly) {
    if (association.liveSyncStatus === 'error') {
      return {
        label: '只读已关联 · 同步异常，等待重试',
        detail: association.liveSyncError || '等待客户端自动重试。',
        dotClassName: 'bg-destructive',
        textClassName: 'text-destructive',
      }
    }
    return {
      label: '只读已关联 · 不同步本地修改',
      detail: null,
      dotClassName: 'bg-muted-foreground',
      textClassName: 'text-muted-foreground',
    }
  }
  if (
    association.lastErrorCode === 'BRANCH_MISMATCH' ||
    association.lastErrorCode === 'BINDING_BRANCH_MISMATCH'
  ) {
    return {
      label: '已关联 · 分支不一致，已暂停同步',
      detail: association.liveSyncError || association.lastError || '请切回绑定分支后重试。',
      dotClassName: 'bg-destructive',
      textClassName: 'text-destructive',
    }
  }
  switch (association.liveSyncStatus) {
    case 'syncing':
      return {
        label: '已关联 · 正在同步已有任务',
        detail: null,
        dotClassName: 'bg-primary animate-pulse',
        textClassName: 'text-muted-foreground',
      }
    case 'ready':
      if (association.deferredCount > 0) {
        return {
          label: `已关联 · ${association.deferredCount} 个本地任务未同步`,
          detail:
            association.deferredTaskDirs.map((taskDir) => taskDir.split('/').at(-1)).join('、') ||
            null,
          dotClassName: 'bg-warning',
          textClassName: 'text-warning',
        }
      }
      return {
        label: '已关联 · 同步正常',
        detail: null,
        dotClassName: 'bg-primary',
        textClassName: 'text-muted-foreground',
      }
    case 'error':
      return {
        label: '已关联 · 同步异常，等待重试',
        detail: association.liveSyncError || '等待客户端自动重试。',
        dotClassName: 'bg-destructive',
        textClassName: 'text-destructive',
      }
    default:
      return {
        label: '已关联 · 等待后台同步',
        detail: null,
        dotClassName: 'bg-chart-3',
        textClassName: 'text-muted-foreground',
      }
  }
}

export function ProjectRail({
  projects,
  teams,
  defaultDeveloperId,
  current,
  teamId,
  onSelect,
  currentTaskSpace,
  onSelectTaskSpace,
  onManage,
  manageEnabled = true,
  syncLabel,
  syncLive,
  refreshing,
  onRefresh,
}: ProjectRailProps) {
  const invoke = useMemo(() => tauriInvoke(), [])
  const [associations, setAssociations] = useState<Map<string, LocalAssociation>>(() => new Map())
  const [associationError, setAssociationError] = useState('')
  const [sidecarStatus, setSidecarStatus] = useState<SidecarStatus | null>(null)
  const [onboardingOpen, setOnboardingOpen] = useState(false)
  const [onboardingProject, setOnboardingProject] = useState<unknown>(null)
  const [inspectingProject, setInspectingProject] = useState(false)
  const [syncingDeferredTaskSpace, setSyncingDeferredTaskSpace] = useState<string | null>(null)
  const [associationRefreshNonce, setAssociationRefreshNonce] = useState(0)
  const associationRequestInFlight = useRef(false)

  useEffect(() => {
    if (!invoke) return
    const currentInvoke = invoke
    let cancelled = false
    async function loadAssociations() {
      if (cancelled || associationRequestInFlight.current) return
      associationRequestInFlight.current = true
      try {
        const result = await currentInvoke('list_local_associations')
        if (cancelled) return
        setAssociations(
          new Map(normalizeAssociations(result).map((item) => [item.taskSpaceId, item])),
        )
        setAssociationError('')
      } catch (error) {
        if (!cancelled) {
          setAssociationError(
            error instanceof Error ? error.message : String(error || '无法读取本地项目关联'),
          )
        }
      } finally {
        associationRequestInFlight.current = false
      }
    }
    void loadAssociations()
    const associationTimer = window.setInterval(() => void loadAssociations(), 3_000)
    async function loadSidecarStatus() {
      try {
        const result = await currentInvoke('desktop_sidecar_status')
        if (!cancelled) setSidecarStatus(normalizeSidecarStatus(result))
      } catch {
        if (!cancelled) setSidecarStatus(null)
      }
    }
    void loadSidecarStatus()
    const timer = window.setInterval(() => void loadSidecarStatus(), 3_000)
    return () => {
      cancelled = true
      window.clearInterval(associationTimer)
      window.clearInterval(timer)
    }
  }, [invoke, associationRefreshNonce])

  async function startProjectOnboarding() {
    if (!invoke || inspectingProject) return
    setAssociationError('')
    setInspectingProject(true)
    try {
      const inspected = await invoke('inspect_local_project')
      if (inspected == null) return
      setOnboardingProject(inspected)
      setOnboardingOpen(true)
    } catch (error) {
      const message = associationErrorMessage(error)
      setAssociationError(message)
      toast.error(message)
    } finally {
      setInspectingProject(false)
    }
  }

  async function syncDeferredTasks(association: LocalAssociation) {
    if (!invoke || syncingDeferredTaskSpace || association.deferredCount < 1) return
    const confirmed = window.confirm(
      `将把 ${association.deferredCount} 个本地任务上传到 ${association.branchName}，冲突时仍会要求确认。是否继续？`,
    )
    if (!confirmed) return
    setSyncingDeferredTaskSpace(association.taskSpaceId)
    try {
      const raw = await invoke('sync_deferred_tasks', {
        taskSpaceId: association.taskSpaceId,
      })
      const result: Record<string, unknown> =
        raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
      if (result.conflict === true) {
        toast.error('补同步遇到任务冲突，请在同步确认窗口处理')
      } else if (typeof result.remainingCount === 'number' && result.remainingCount > 0) {
        toast.error(`仍有 ${result.remainingCount} 个本地任务待处理，请查看同步确认窗口`)
      } else {
        const syncedCount =
          typeof result.syncedCount === 'number' ? result.syncedCount : association.deferredCount
        toast.success(`已补传 ${syncedCount} 个本地任务`)
        void onRefresh()
      }
    } catch (error) {
      const message = deferredSyncErrorMessage(error)
      setAssociationError(message)
      toast.error(message)
    } finally {
      setSyncingDeferredTaskSpace(null)
      setAssociationRefreshNonce((value) => value + 1)
    }
  }

  const syncingAssociations = [...associations.values()].filter(
    (association) => association.status === 'approved' && association.liveSyncStatus === 'syncing',
  )
  const taskSpaceCount = projects.reduce(
    (total, project) => total + (project.taskSpaces?.length || 0),
    0,
  )

  return (
    <aside className="hidden w-[230px] shrink-0 flex-col gap-1 border-r border-border bg-sidebar px-2.5 py-3.5 lg:flex">
      <p className="px-2 pb-1 text-[10px] font-semibold tracking-[0.12em] text-muted-foreground">
        项目
      </p>
      {invoke ? (
        <button
          type="button"
          onClick={() => void startProjectOnboarding()}
          disabled={inspectingProject}
          className="mb-1 flex h-7.5 items-center gap-2 rounded-lg border border-dashed border-border px-2 text-left text-[11px] text-muted-foreground hover:border-primary/50 hover:text-foreground disabled:opacity-60"
        >
          <Plus className={inspectingProject ? 'size-3.5 animate-pulse' : 'size-3.5'} />
          {inspectingProject ? '正在检查本地项目…' : '接入本地项目'}
        </button>
      ) : null}
      {invoke && syncingAssociations.length ? (
        <div
          role="status"
          className="mb-1 rounded-lg border border-amber-500/35 bg-amber-500/10 px-2 py-1.5 text-[10px] leading-4 text-amber-800 dark:text-amber-300"
        >
          正在同步任务，此时切换 Git 分支可能导致任务错位或污染，建议等待同步完成后再切换。
        </div>
      ) : null}
      <button
        type="button"
        onClick={() => onSelect('all')}
        className={
          current === 'all'
            ? 'flex h-7.5 items-center gap-2 rounded-lg border border-primary/40 bg-primary/15 px-2 text-left text-xs font-semibold text-foreground'
            : 'flex h-7.5 items-center gap-2 rounded-lg px-2 text-left text-xs font-medium text-foreground hover:bg-sidebar-accent/60'
        }
      >
        <span className="size-1.5 rounded-full bg-primary" aria-hidden="true" />
        全部项目
      </button>
      {current === 'all' && taskSpaceCount > 1 ? (
        <p className="px-2 pb-1 text-[9.5px] leading-4 text-muted-foreground">
          全部项目按分支独立统计
        </p>
      ) : null}
      {projects.map((project) => {
        const taskSpaces = project.taskSpaces || []
        const selectedTaskSpace =
          current === project.id
            ? taskSpaces.find((taskSpace) => taskSpace.id === currentTaskSpace)
            : undefined
        const activeTaskSpace = current === project.id ? selectedTaskSpace || taskSpaces[0] : null
        const activeAssociation = activeTaskSpace ? associations.get(activeTaskSpace.id) : undefined
        const projectAssociation = selectProjectAssociation(
          project,
          associations,
          selectedTaskSpace?.id,
        )
        const view = invoke ? projectAssociationView(projectAssociation) : null
        const activeView = invoke ? projectAssociationView(activeAssociation) : null
        return (
          <div key={project.id} className="flex flex-col">
            <div
              className={
                current === project.id
                  ? 'flex items-center rounded-lg border border-primary/40 bg-primary/15 text-foreground'
                  : 'flex items-center rounded-lg hover:bg-sidebar-accent/60'
              }
            >
              <button
                type="button"
                onClick={() => onSelect(project.id)}
                className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left"
                title={project.name}
              >
                <span
                  className={`size-1.5 shrink-0 rounded-full ${view?.dotClassName || 'bg-chart-3'}`}
                  aria-hidden="true"
                />
                <span className="min-w-0">
                  <span className="block truncate text-xs font-medium">{project.name}</span>
                  {view ? (
                    <span
                      className={`block truncate text-[9.5px] ${view.textClassName}`}
                      title={view.detail || view.label}
                      aria-live="polite"
                    >
                      {view.label}
                      {view.detail ? <span className="sr-only">，详情：{view.detail}</span> : null}
                    </span>
                  ) : null}
                </span>
              </button>
              {invoke && activeTaskSpace ? (
                activeAssociation?.status === 'approved' ? (
                  <span
                    className="mr-1.5 flex size-6 shrink-0 items-center justify-center text-muted-foreground"
                    title={activeView?.label || '本地已关联'}
                  >
                    {activeAssociation.readOnly ? (
                      <LockKeyhole className="size-3.5" aria-hidden="true" />
                    ) : (
                      <FolderGit2 className="size-3.5" aria-hidden="true" />
                    )}
                  </span>
                ) : (
                  <button
                    type="button"
                    className="mr-1.5 flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground"
                    aria-label={`${activeAssociation ? '重新关联' : '关联'} ${project.name} ${activeTaskSpace.branchName} 的本地 Git 仓库`}
                    title={activeAssociation ? '重新关联本地 Git 仓库' : '关联本地 Git 仓库'}
                    disabled={inspectingProject}
                    onClick={() => void startProjectOnboarding()}
                  >
                    <FolderGit2
                      className={inspectingProject ? 'size-3.5 animate-pulse' : 'size-3.5'}
                      aria-hidden="true"
                    />
                  </button>
                )
              ) : null}
            </div>
            {current === project.id ? (
              <div className="ml-5 flex flex-col border-l border-border/70 pl-1">
                {taskSpaces.map((taskSpace) => {
                  const branchAssociation = associations.get(taskSpace.id)
                  const branchView = invoke ? projectAssociationView(branchAssociation) : null
                  const branchPaused =
                    branchAssociation?.status === 'approved' &&
                    (branchAssociation.lastErrorCode === 'BRANCH_MISMATCH' ||
                      branchAssociation.lastErrorCode === 'BINDING_BRANCH_MISMATCH')
                  const deferredDetails = branchAssociation?.deferredTaskDirs
                    .map((taskDir) => taskDir.split('/').at(-1))
                    .join('、')
                  return (
                    <div
                      key={taskSpace.id}
                      className={
                        currentTaskSpace === taskSpace.id
                          ? 'flex items-center rounded-md border border-primary/35 bg-primary/20 text-[10px] font-semibold text-foreground'
                          : 'flex items-center rounded-md text-[10px] text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground'
                      }
                    >
                      <button
                        type="button"
                        onClick={() => onSelectTaskSpace(taskSpace.id)}
                        className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1 text-left"
                        title={branchView?.detail || branchView?.label || taskSpace.branchName}
                      >
                        <span
                          className={`size-1 shrink-0 rounded-full ${branchView?.dotClassName || 'bg-chart-3'}`}
                          aria-hidden="true"
                        />
                        <span className="min-w-0 flex-1 truncate">{taskSpace.branchName}</span>
                        {branchPaused ? (
                          <span className="shrink-0 text-[8.5px] font-medium text-destructive">
                            已暂停
                          </span>
                        ) : null}
                      </button>
                      {branchAssociation?.status === 'approved' &&
                      !branchAssociation.readOnly &&
                      branchAssociation.deferredCount > 0 ? (
                        <button
                          type="button"
                          className="mr-1 flex size-5 shrink-0 items-center justify-center rounded text-warning hover:bg-background disabled:opacity-60"
                          aria-label={`上传 ${taskSpace.branchName} 的 ${branchAssociation.deferredCount} 个本地任务`}
                          title={`上传本地任务${deferredDetails ? `：${deferredDetails}` : ''}`}
                          disabled={syncingDeferredTaskSpace !== null}
                          onClick={() => void syncDeferredTasks(branchAssociation)}
                        >
                          <Upload
                            className={
                              syncingDeferredTaskSpace === taskSpace.id
                                ? 'size-3 animate-pulse'
                                : 'size-3'
                            }
                            aria-hidden="true"
                          />
                        </button>
                      ) : null}
                    </div>
                  )
                })}
                {currentTaskSpace === 'all' && taskSpaces.length > 1 ? (
                  <p className="px-2 py-1 text-[9px] leading-4 text-muted-foreground">
                    按分支独立统计
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        )
      })}

      {associationError ? (
        <p
          role="alert"
          className="mx-1 mt-1 rounded-md bg-destructive/10 px-2 py-1.5 text-[10px] leading-4 text-destructive"
        >
          {associationError}
        </p>
      ) : null}

      {!invoke && manageEnabled ? (
        <button
          type="button"
          onClick={onManage}
          className="mt-2 flex h-7 items-center gap-1.5 rounded-lg px-2 text-left text-xs text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground"
        >
          <Plus className="size-3.5" />
          管理
        </button>
      ) : null}

      <div className="mt-auto flex flex-col gap-2 rounded-xl bg-card p-2.5">
        <div className="flex items-center gap-1.5">
          <span
            className={
              invoke
                ? sidecarStatus?.running
                  ? 'size-1.5 rounded-full bg-primary'
                  : 'size-1.5 rounded-full bg-destructive'
                : syncLive
                  ? 'size-1.5 rounded-full bg-primary'
                  : 'size-1.5 rounded-full bg-muted-foreground/50'
            }
            aria-hidden="true"
          />
          <span className="text-[11px] font-semibold text-foreground">同步状态</span>
        </div>
        <p className="text-[10.5px] leading-4 text-muted-foreground">{syncLabel}</p>
        {invoke ? (
          <p className="text-[10.5px] leading-4 text-muted-foreground">
            客户端后台：
            {sidecarStatus?.running ? '运行中' : sidecarStatus?.paused ? '已暂停' : '未运行'}
          </p>
        ) : null}
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 text-[11px]"
          onClick={onRefresh}
          disabled={refreshing}
        >
          <RefreshCw className={refreshing ? 'size-3 animate-spin' : 'size-3'} />
          {refreshing ? '正在扫描…' : '重新扫描仓库'}
        </Button>
      </div>
      {invoke ? (
        <ProjectOnboardingDialog
          open={onboardingOpen}
          onOpenChange={setOnboardingOpen}
          inspection={onboardingProject}
          teams={teams}
          defaultTeamId={teamId === 'all' ? '' : teamId}
          defaultDeveloperId={defaultDeveloperId}
          invoke={invoke}
          onAssociated={(association) => {
            const normalized = normalizeAssociation(association)
            if (!normalized) {
              toast.error('项目关联成功，但客户端返回了无效的关联状态')
              return
            }
            setAssociations((currentMap) => {
              const next = new Map(currentMap)
              for (const [taskSpaceId, existing] of next) {
                if (
                  taskSpaceId !== normalized.taskSpaceId &&
                  sameLocalRepositoryPath(existing.repoPath, normalized.repoPath)
                ) {
                  next.delete(taskSpaceId)
                }
              }
              next.set(normalized.taskSpaceId, normalized)
              return next
            })
            toast.success('本地项目已接入团队任务空间，正在同步任务。')
            void onRefresh()
          }}
        />
      ) : null}
    </aside>
  )
}
