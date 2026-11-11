import { useEffect, useMemo, useState } from 'react'
import { FolderGit2, LockKeyhole, Plus, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { ProjectOnboardingDialog } from '@/features/board/dialogs/ProjectOnboardingDialog'

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
  switch (association.liveSyncStatus) {
    case 'syncing':
      return {
        label: '已关联 · 正在同步已有任务',
        detail: null,
        dotClassName: 'bg-primary animate-pulse',
        textClassName: 'text-muted-foreground',
      }
    case 'ready':
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

  useEffect(() => {
    if (!invoke) return
    const currentInvoke = invoke
    let cancelled = false
    async function loadAssociations() {
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
  }, [invoke])

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

  const syncingAssociations = [...associations.values()].filter(
    (association) => association.status === 'approved' && association.liveSyncStatus === 'syncing',
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
            ? 'flex h-7.5 items-center gap-2 rounded-lg bg-sidebar-accent px-2 text-left text-xs font-semibold text-sidebar-accent-foreground'
            : 'flex h-7.5 items-center gap-2 rounded-lg px-2 text-left text-xs font-medium text-foreground hover:bg-sidebar-accent/60'
        }
      >
        <span className="size-1.5 rounded-full bg-primary" aria-hidden="true" />
        全部项目
      </button>
      {projects.map((project) => {
        const taskSpaces = project.taskSpaces || []
        const activeTaskSpace =
          current === project.id
            ? taskSpaces.find((taskSpace) => taskSpace.id === currentTaskSpace) || taskSpaces[0]
            : null
        const association = activeTaskSpace
          ? associations.get(activeTaskSpace.id)
          : associations.get(currentTaskSpace)
        const view = invoke ? projectAssociationView(association) : null
        return (
          <div key={project.id} className="flex flex-col">
            <div
              className={
                current === project.id
                  ? 'flex items-center rounded-lg bg-sidebar-accent text-sidebar-accent-foreground'
                  : 'flex items-center rounded-lg hover:bg-sidebar-accent/60'
              }
            >
              <button
                type="button"
                onClick={() => {
                  onSelect(project.id)
                  if (taskSpaces[0]) onSelectTaskSpace(taskSpaces[0].id)
                }}
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
                association?.status === 'approved' ? (
                  <span
                    className="mr-1.5 flex size-6 shrink-0 items-center justify-center text-muted-foreground"
                    title={view?.label || '本地已关联'}
                  >
                    {association.readOnly ? (
                      <LockKeyhole className="size-3.5" aria-hidden="true" />
                    ) : (
                      <FolderGit2 className="size-3.5" aria-hidden="true" />
                    )}
                  </span>
                ) : (
                  <button
                    type="button"
                    className="mr-1.5 flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground"
                    aria-label={`${association ? '重新关联' : '关联'} ${project.name} ${activeTaskSpace.branchName} 的本地 Git 仓库`}
                    title={association ? '重新关联本地 Git 仓库' : '关联本地 Git 仓库'}
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
                  return (
                    <button
                      key={taskSpace.id}
                      type="button"
                      onClick={() => onSelectTaskSpace(taskSpace.id)}
                      className={
                        currentTaskSpace === taskSpace.id
                          ? 'flex items-center gap-1.5 rounded-md bg-sidebar-accent/70 px-2 py-1 text-left text-[10px] font-medium text-foreground'
                          : 'flex items-center gap-1.5 rounded-md px-2 py-1 text-left text-[10px] text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground'
                      }
                      title={branchView?.label || taskSpace.branchName}
                    >
                      <span
                        className={`size-1 shrink-0 rounded-full ${branchView?.dotClassName || 'bg-chart-3'}`}
                        aria-hidden="true"
                      />
                      <span className="truncate">{taskSpace.branchName}</span>
                    </button>
                  )
                })}
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
          invoke={invoke}
          onAssociated={(association) => {
            setAssociations((currentMap) => {
              const next = new Map(currentMap)
              next.set(association.taskSpaceId, association)
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
