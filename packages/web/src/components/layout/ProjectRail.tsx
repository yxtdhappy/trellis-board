import { useEffect, useMemo, useRef, useState } from 'react'
import { Bot, FolderGit2, LockKeyhole, Plus, RefreshCw, Unlink2, Upload, Users } from 'lucide-react'
import { toast } from 'sonner'
import type { TaskSpace } from '@/api/board'
import { Button } from '@/components/ui/button'
import { useConfirm } from '@/components/ui/confirm-dialog'
import { listen } from '@/desktop/tauri'
import { AgentQuickInitDialog } from '@/features/board/dialogs/AgentQuickInitDialog'
import { BranchListenersDialog } from '@/features/board/dialogs/BranchListenersDialog'
import { ProjectOnboardingDialog } from '@/features/board/dialogs/ProjectOnboardingDialog'
import { TaskOwnershipDialog } from '@/features/board/dialogs/TaskOwnershipDialog'
import { sameLocalRepositoryPath } from '@/lib/onboarding-associations.js'
import {
  associationSignature,
  associationOwnershipCounts,
  countProjectPausedBranches,
  desktopStateTopics,
  detachPendingAssociationView,
  isBranchAssociationPaused,
  projectListenerView,
  selectProjectAssociation,
} from '@/lib/project-rail-association.js'
import { createRefreshCoordinator } from '@/lib/refresh-coordinator.js'

type Project = {
  id: string
  name: string
  teamId?: string | null
  syncBranch?: string | null
  teamName?: string | null
  taskSpaces?: TaskSpace[]
  trellisDevId?: string | null
}

type LiveSyncStatus = 'pending' | 'syncing' | 'ready' | 'error'

export type LocalAssociation = {
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
  deferredTasks?: Array<{ taskDir: string; title?: string | null }>
  ownershipPausedCount: number
  ownershipPausedTaskDirs: string[]
  ownershipPendingCount: number
  ownershipPendingTaskDirs: string[]
  detachPending: boolean
  initialReviewPending: boolean
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
  onAssociationsChange?: (associations: LocalAssociation[]) => void
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
  const deferredTasks = Array.isArray(record.deferredTasks)
    ? record.deferredTasks.flatMap((item) => {
        if (!item || typeof item !== 'object') return []
        const task = item as Record<string, unknown>
        if (typeof task.taskDir !== 'string' || !task.taskDir.startsWith('.trellis/tasks/')) {
          return []
        }
        const title = typeof task.title === 'string' && task.title.trim() ? task.title.trim() : null
        return [{ taskDir: task.taskDir, title }]
      })
    : []
  const deferredCount =
    deferredTaskDirs.length ||
    (typeof record.deferredCount === 'number' && Number.isSafeInteger(record.deferredCount)
      ? Math.max(0, record.deferredCount)
      : 0)
  const ownershipPausedTaskDirs = Array.isArray(record.ownershipPausedTaskDirs)
    ? record.ownershipPausedTaskDirs.filter(
        (taskDir): taskDir is string =>
          typeof taskDir === 'string' && taskDir.startsWith('.trellis/tasks/'),
      )
    : []
  const ownershipPendingTaskDirs = Array.isArray(record.ownershipPendingTaskDirs)
    ? record.ownershipPendingTaskDirs.filter(
        (taskDir): taskDir is string =>
          typeof taskDir === 'string' && taskDir.startsWith('.trellis/tasks/'),
      )
    : []
  const ownershipPausedCount =
    ownershipPausedTaskDirs.length ||
    (typeof record.ownershipPausedCount === 'number' &&
    Number.isSafeInteger(record.ownershipPausedCount)
      ? Math.max(0, record.ownershipPausedCount)
      : 0)
  const ownershipPendingCount =
    ownershipPendingTaskDirs.length ||
    (typeof record.ownershipPendingCount === 'number' &&
    Number.isSafeInteger(record.ownershipPendingCount)
      ? Math.max(0, record.ownershipPendingCount)
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
    deferredTasks,
    ownershipPausedCount,
    ownershipPausedTaskDirs,
    ownershipPendingCount,
    ownershipPendingTaskDirs,
    detachPending: record.detachPending === true,
    initialReviewPending: record.initialReviewPending === true,
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
  if (association.detachPending) {
    return detachPendingAssociationView(association)
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
  const ownership = associationOwnershipCounts(association)
  if (association.liveSyncStatus !== 'error' && ownership.totalCount > 0) {
    const detail = [
      ownership.pausedCount ? `${ownership.pausedCount} 个因分支不匹配暂停` : null,
      ownership.pendingCount ? `${ownership.pendingCount} 个待确认归属` : null,
    ]
      .filter(Boolean)
      .join('；')
    return {
      label:
        ownership.pausedCount && ownership.pendingCount
          ? `已关联 · ${ownership.totalCount} 个任务待处理归属`
          : ownership.pausedCount
            ? `已关联 · ${ownership.pausedCount} 个任务因分支不匹配暂停`
            : `已关联 · ${ownership.pendingCount} 个任务待确认归属`,
      detail,
      dotClassName: 'bg-warning',
      textClassName: 'text-warning',
    }
  }
  if (association.initialReviewPending && association.liveSyncStatus !== 'error') {
    return {
      label: '已关联 · 等待确认任务差异',
      detail: '首次同步发现差异，确认处理方式后才会继续同步任务。',
      dotClassName: 'bg-warning',
      textClassName: 'text-warning',
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

function detachOutcome(value: unknown): 'detached' | 'pending' {
  if (typeof value === 'string') {
    return value === 'detached' || value === 'success' ? 'detached' : 'pending'
  }
  if (!value || typeof value !== 'object') return 'pending'
  const record = value as Record<string, unknown>
  if (record.status === 'pending') return 'pending'
  if (record.status === 'detached' || record.status === 'success' || record.detached === true) {
    return 'detached'
  }
  return 'pending'
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
  onAssociationsChange,
}: ProjectRailProps) {
  const invoke = useMemo(() => tauriInvoke(), [])
  const confirm = useConfirm()
  const [associations, setAssociations] = useState<Map<string, LocalAssociation>>(() => new Map())
  const [associationError, setAssociationError] = useState('')
  const [sidecarStatus, setSidecarStatus] = useState<SidecarStatus | null>(null)
  const [onboardingOpen, setOnboardingOpen] = useState(false)
  const [onboardingPath, setOnboardingPath] = useState('')
  const [quickAgentTaskSpaceId, setQuickAgentTaskSpaceId] = useState<string | null>(null)
  const [ownershipTaskSpaceId, setOwnershipTaskSpaceId] = useState<string | null>(null)
  const [inspectingProject, setInspectingProject] = useState(false)
  const [syncingDeferredTaskSpace, setSyncingDeferredTaskSpace] = useState<string | null>(null)
  const [detachingTaskSpace, setDetachingTaskSpace] = useState<string | null>(null)
  const [listenerTaskSpace, setListenerTaskSpace] = useState<TaskSpace | null>(null)
  const associationSignatureRef = useRef('')
  const refreshProjectStateRef = useRef<() => Promise<void>>(async () => {})
  const onAssociationsChangeRef = useRef(onAssociationsChange)

  useEffect(() => {
    onAssociationsChangeRef.current = onAssociationsChange
  }, [onAssociationsChange])

  useEffect(() => {
    if (!invoke) return
    const currentInvoke = invoke
    const currentListen = listen
    let cancelled = false
    let unlisten: (() => void) | undefined
    let fallbackTimer = 0

    async function loadAssociations() {
      try {
        const result = await currentInvoke('list_local_associations')
        if (cancelled) return
        const normalized = normalizeAssociations(result)
        const signature = associationSignature(normalized)
        if (signature !== associationSignatureRef.current) {
          associationSignatureRef.current = signature
          setAssociations(new Map(normalized.map((item) => [item.taskSpaceId, item])))
          onAssociationsChangeRef.current?.(normalized)
        }
        setAssociationError('')
      } catch (error) {
        if (!cancelled) {
          setAssociationError(
            error instanceof Error ? error.message : String(error || '无法读取本地项目关联'),
          )
        }
      }
    }

    async function loadSidecarStatus() {
      try {
        const result = await currentInvoke('desktop_sidecar_status')
        if (cancelled) return
        const next = normalizeSidecarStatus(result)
        setSidecarStatus((current) =>
          current?.running === next?.running && current?.paused === next?.paused
            ? current
            : next,
        )
      } catch {
        if (!cancelled) setSidecarStatus(null)
      }
    }

    const associationRefresh = createRefreshCoordinator(loadAssociations)
    const sidecarRefresh = createRefreshCoordinator(loadSidecarStatus)
    const refreshAll = async () => {
      await Promise.all([associationRefresh.request(), sidecarRefresh.request()])
    }
    refreshProjectStateRef.current = refreshAll

    const clearFallback = () => {
      if (fallbackTimer) window.clearTimeout(fallbackTimer)
      fallbackTimer = 0
    }
    const scheduleFallback = () => {
      clearFallback()
      if (document.visibilityState === 'visible') {
        fallbackTimer = window.setTimeout(() => {
          void refreshAll().finally(scheduleFallback)
        }, 10_000)
      }
    }
    const refreshVisible = () => {
      if (document.visibilityState !== 'visible') return
      void refreshAll()
      scheduleFallback()
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') refreshVisible()
      else clearFallback()
    }
    const onStateChanged = (event: { payload: unknown }) => {
      if (document.visibilityState !== 'visible') return
      const topics = desktopStateTopics(event.payload)
      if (!topics.size) return
      if (topics.has('associations')) void associationRefresh.request()
      if (topics.has('sidecar')) void sidecarRefresh.request()
    }

    async function setup() {
      if (currentListen) {
        try {
          unlisten = await currentListen('desktop-state-changed', onStateChanged)
        } catch {
          unlisten = undefined
        }
      }
      if (cancelled) {
        unlisten?.()
        return
      }
      window.addEventListener('focus', refreshVisible)
      document.addEventListener('visibilitychange', onVisibilityChange)
      await refreshAll()
      if (!cancelled) scheduleFallback()
    }
    void setup()

    return () => {
      cancelled = true
      unlisten?.()
      associationRefresh.dispose()
      sidecarRefresh.dispose()
      clearFallback()
      window.removeEventListener('focus', refreshVisible)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      refreshProjectStateRef.current = async () => {}
    }
  }, [invoke])

  useEffect(() => {
    setListenerTaskSpace(null)
  }, [current, teamId])

  async function startProjectOnboarding() {
    if (!invoke || inspectingProject) return
    setAssociationError('')
    setInspectingProject(true)
    try {
      const picked = await invoke('pick_local_project_folder')
      if (typeof picked !== 'string' || !picked) return
      setOnboardingPath(picked)
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
    const deferredTasks = association.deferredTasks?.length
      ? association.deferredTasks
      : association.deferredTaskDirs.map((taskDir) => ({ taskDir, title: null }))
    const confirmed = await confirm({
      title: '上传本地任务？',
      description: (
        <div className="flex max-h-56 flex-col gap-1 overflow-auto">
          {deferredTasks.map((task) => (
            <div key={task.taskDir}>
              <p className="break-words text-foreground">
                {task.title || task.taskDir.split('/').at(-1) || task.taskDir}
              </p>
              <p className="break-all">{task.taskDir}</p>
            </div>
          ))}
          <p className={deferredTasks.length ? 'mt-1' : undefined}>
            将把 {association.deferredCount} 个本地任务上传到 {association.branchName}
            ，冲突时仍会要求确认。
          </p>
        </div>
      ),
      confirmText: '上传',
    })
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
      void refreshProjectStateRef.current()
    }
  }

  async function detachAssociation(association: LocalAssociation) {
    if (!invoke || detachingTaskSpace) return
    const confirmed = await confirm({
      title: `不再同步分支“${association.branchName}”？`,
      description:
        '仅解除当前客户端与该分支的关联，不影响其他客户端，也不删除服务端任务、冲突或历史。',
      confirmText: '不再同步',
      tone: 'danger',
    })
    if (!confirmed) return
    setDetachingTaskSpace(association.taskSpaceId)
    setAssociationError('')
    try {
      const result = await invoke('detach_local_association', {
        taskSpaceId: association.taskSpaceId,
      })
      if (detachOutcome(result) === 'detached') {
        toast.success('当前客户端已不再同步该分支')
      } else {
        toast.warning('本地已停止同步，服务端解绑待确认')
      }
      void onRefresh()
    } catch (error) {
      const message = associationErrorMessage(error)
      setAssociationError(message)
      toast.error(`服务端解绑未确认：${message}`)
    } finally {
      setDetachingTaskSpace(null)
      void refreshProjectStateRef.current()
    }
  }

  async function openInitialReview() {
    if (!invoke) return
    try {
      const shown = await invoke('live_control_show')
      if (shown !== true) toast.info('没有等待确认的任务差异')
    } catch (error) {
      toast.error(associationErrorMessage(error))
    }
  }

  const syncingAssociations = [...associations.values()].filter(
    (association) =>
      association.status === 'approved' &&
      association.liveSyncStatus === 'syncing' &&
      !association.initialReviewPending,
  )
  const reviewAssociations = [...associations.values()].filter(
    (association) => association.status === 'approved' && association.initialReviewPending,
  )
  const taskSpaceCount = projects.reduce(
    (total, project) => total + (project.taskSpaces?.length || 0),
    0,
  )

  return (
    <aside className="hidden w-[14.375rem] shrink-0 flex-col gap-1 border-r border-border bg-sidebar px-2.5 py-3.5 lg:flex">
      <p className="px-2 pb-1 text-[0.625rem] font-semibold tracking-[0.12em] text-muted-foreground">
        项目
      </p>
      {invoke ? (
        <Button
          variant="outline"
          size="sm"
          onClick={() => void startProjectOnboarding()}
          disabled={inspectingProject}
          className="mb-1 justify-start border-dashed text-[0.6875rem] text-muted-foreground hover:border-primary/50 hover:text-foreground"
        >
          <Plus className="size-3.5" />
          接入本地项目
        </Button>
      ) : null}
      {invoke && syncingAssociations.length ? (
        <div
          role="status"
          className="mb-1 rounded-lg border border-amber-500/35 bg-amber-500/10 px-2 py-1.5 text-[0.625rem] leading-4 text-amber-800 dark:text-amber-300"
        >
          正在同步任务，此时切换 Git 分支可能导致任务错位或污染，建议等待同步完成后再切换。
        </div>
      ) : null}
      {invoke && reviewAssociations.length ? (
        <div
          role="status"
          className="mb-1 rounded-lg border border-amber-500/35 bg-amber-500/10 px-2 py-1.5 text-[0.625rem] leading-4 text-amber-800 dark:text-amber-300"
        >
          有分支等待确认任务差异，确认处理方式后才会同步任务。
        </div>
      ) : null}
      <button
        type="button"
        onClick={() => onSelect('all')}
        className={
          current === 'all'
            ? 'flex h-8 items-center gap-2 rounded-lg border border-primary/40 bg-primary/15 px-2 text-left text-xs font-semibold text-foreground'
            : 'flex h-8 items-center gap-2 rounded-lg px-2 text-left text-xs font-medium text-foreground hover:bg-sidebar-accent/60'
        }
      >
        <span className="size-1.5 rounded-full bg-primary" aria-hidden="true" />
        全部项目
      </button>
      {current === 'all' && taskSpaceCount > 1 ? (
        <p className="px-2 pb-1 text-[0.59375rem] leading-4 text-muted-foreground">
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
        const pausedBranchCount = countProjectPausedBranches(project, associations)
        const showPartialPause =
          !selectedTaskSpace && taskSpaces.length > 1 && pausedBranchCount > 0
        const view = invoke
          ? showPartialPause
            ? {
                label: `已关联 · ${pausedBranchCount}/${taskSpaces.length} 个分支已暂停`,
                detail: '各分支仅按自身状态同步。',
                dotClassName: 'bg-warning',
                textClassName: 'text-warning',
              }
            : projectAssociationView(projectAssociation)
          : null
        const activeView = invoke ? projectAssociationView(activeAssociation) : null
        const hasListenerSummary = taskSpaces.some((taskSpace) => projectListenerView(taskSpace))
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
                      className={`block truncate text-[0.59375rem] ${view.textClassName}`}
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
                  <>
                    <span
                      className="flex size-6 shrink-0 items-center justify-center text-muted-foreground"
                      title={activeView?.label || '本地已关联'}
                    >
                      {activeAssociation.readOnly ? (
                        <LockKeyhole className="size-3.5" aria-hidden="true" />
                      ) : (
                        <FolderGit2 className="size-3.5" aria-hidden="true" />
                      )}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="mr-1.5 shrink-0 text-muted-foreground"
                      aria-label={`初始化 ${project.name} ${activeTaskSpace.branchName} 的编码 Agent`}
                      title="初始化编码 Agent"
                      onClick={() => setQuickAgentTaskSpaceId(activeTaskSpace.id)}
                    >
                      <Bot className="size-3.5" aria-hidden="true" />
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="mr-1.5 shrink-0 text-muted-foreground"
                    aria-label={`${activeAssociation ? '重新关联' : '关联'} ${project.name} ${activeTaskSpace.branchName} 的本地 Git 仓库`}
                    title={activeAssociation ? '重新关联本地 Git 仓库' : '关联本地 Git 仓库'}
                    disabled={inspectingProject}
                    onClick={() => void startProjectOnboarding()}
                  >
                    <FolderGit2 className="size-3.5" aria-hidden="true" />
                  </Button>
                )
              ) : null}
            </div>
            {current === 'all' && hasListenerSummary ? (
              <div className="ml-5 flex flex-col border-l border-border/70 pl-1">
                {taskSpaces.map((taskSpace) => {
                  const listenerView = projectListenerView(taskSpace)
                  if (!listenerView) return null
                  return (
                    <div
                      key={taskSpace.id}
                      className="flex min-w-0 items-center gap-1 px-2 py-0.5 text-[0.53125rem] text-muted-foreground"
                      title={`${taskSpace.branchName}：${listenerView.counts} · ${listenerView.label}`}
                    >
                      <span
                        className={`size-1 shrink-0 rounded-full ${listenerView.dotClassName}`}
                        aria-hidden="true"
                      />
                      <span className="max-w-20 shrink-0 truncate font-medium text-foreground">
                        {taskSpace.branchName}
                      </span>
                      <span className={`min-w-0 truncate ${listenerView.textClassName}`}>
                        {listenerView.counts} · {listenerView.label}
                      </span>
                    </div>
                  )
                })}
              </div>
            ) : null}
            {current === project.id ? (
              <div className="ml-5 flex flex-col border-l border-border/70 pl-1">
                {taskSpaces.map((taskSpace) => {
                  const branchAssociation = associations.get(taskSpace.id)
                  const branchView = invoke ? projectAssociationView(branchAssociation) : null
                  const listenerView = projectListenerView(taskSpace)
                  const detachPending = branchAssociation?.detachPending === true
                  const branchPaused = isBranchAssociationPaused(branchAssociation)
                  const ownership = associationOwnershipCounts(branchAssociation)
                  const deferredDetails = branchAssociation?.deferredTaskDirs
                    .map((taskDir) => taskDir.split('/').at(-1))
                    .join('、')
                  const branchTitle = [
                    listenerView ? `${listenerView.counts} · ${listenerView.label}` : null,
                    branchView ? `本地关联：${branchView.label}` : null,
                    listenerView?.detail,
                  ]
                    .filter(Boolean)
                    .join('；')
                  return (
                    <div
                      key={taskSpace.id}
                      className={
                        currentTaskSpace === taskSpace.id
                          ? 'flex items-center rounded-md border border-primary/35 bg-primary/20 text-[0.625rem] font-semibold text-foreground'
                          : 'flex items-center rounded-md text-[0.625rem] text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground'
                      }
                    >
                      <button
                        type="button"
                        onClick={() => onSelectTaskSpace(taskSpace.id)}
                        className="flex min-w-0 flex-1 items-start gap-1.5 px-2 py-1 text-left"
                        title={branchTitle || taskSpace.branchName}
                      >
                        <span
                          className={`mt-1 size-1 shrink-0 rounded-full ${listenerView?.dotClassName || branchView?.dotClassName || 'bg-chart-3'}`}
                          aria-hidden="true"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1">
                            <span className="min-w-0 flex-1 truncate">{taskSpace.branchName}</span>
                            {branchPaused ? (
                              <span className="shrink-0 text-[0.53125rem] font-medium text-destructive">
                                已暂停
                              </span>
                            ) : null}
                          </span>
                          {listenerView ? (
                            <>
                              <span className="block truncate text-[0.53125rem] leading-3 text-muted-foreground">
                                {listenerView.counts}
                              </span>
                              <span
                                className={`block truncate text-[0.53125rem] leading-3 ${listenerView.textClassName}`}
                              >
                                {listenerView.label}
                              </span>
                            </>
                          ) : null}
                          {detachPending ? (
                            <span className="block truncate text-[0.53125rem] leading-3 text-warning">
                              服务端解绑待确认
                            </span>
                          ) : null}
                        </span>
                      </button>
                      {branchAssociation?.status === 'approved' &&
                      !branchAssociation.readOnly &&
                      !branchPaused &&
                      ownership.totalCount > 0 ? (
                        <button
                          type="button"
                          className="mr-1 shrink-0 rounded px-1 text-[0.53125rem] font-medium text-warning hover:bg-background"
                          aria-label={`处理 ${taskSpace.branchName} 的 ${ownership.totalCount} 个任务归属`}
                          title={branchView?.detail || branchView?.label}
                          onClick={() => setOwnershipTaskSpaceId(taskSpace.id)}
                        >
                          待处理 {ownership.totalCount}
                        </button>
                      ) : null}
                      {branchAssociation?.status === 'approved' &&
                      branchAssociation.initialReviewPending ? (
                        <button
                          type="button"
                          className="mr-1 shrink-0 rounded px-1 text-[0.53125rem] font-medium text-warning hover:bg-background"
                          aria-label={`处理 ${taskSpace.branchName} 的任务差异`}
                          title={branchView?.detail || branchView?.label}
                          onClick={() => void openInitialReview()}
                        >
                          确认差异
                        </button>
                      ) : null}
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
                      {taskSpace.canManage ? (
                        <button
                          type="button"
                          className="mr-1 flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-foreground"
                          aria-label={`查看 ${taskSpace.branchName} 的分支监听详情`}
                          title="查看分支监听详情"
                          onClick={() => setListenerTaskSpace(taskSpace)}
                        >
                          <Users className="size-3" aria-hidden="true" />
                        </button>
                      ) : null}
                      {branchAssociation?.status === 'approved' ? (
                        <button
                          type="button"
                          className="mr-1 flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-destructive disabled:opacity-50"
                          aria-label={`不再同步 ${taskSpace.branchName}`}
                          title={detachPending ? '服务端解绑待确认' : '不再同步此分支'}
                          disabled={detachPending || detachingTaskSpace !== null}
                          onClick={() => void detachAssociation(branchAssociation)}
                        >
                          <Unlink2
                            className={
                              detachingTaskSpace === taskSpace.id
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
                  <p className="px-2 py-1 text-[0.5625rem] leading-4 text-muted-foreground">
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
          className="mx-1 mt-1 rounded-md bg-destructive/10 px-2 py-1.5 text-[0.625rem] leading-4 text-destructive"
        >
          {associationError}
        </p>
      ) : null}

      {!invoke && manageEnabled ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={onManage}
          className="mt-2 justify-start gap-1.5 text-muted-foreground"
        >
          <Plus className="size-3.5" />
          管理
        </Button>
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
          <span className="text-[0.6875rem] font-semibold text-foreground">同步状态</span>
        </div>
        <p className="text-[0.65625rem] leading-4 text-muted-foreground">{syncLabel}</p>
        {invoke ? (
          <p className="text-[0.65625rem] leading-4 text-muted-foreground">
            客户端后台：
            {sidecarStatus?.running ? '运行中' : sidecarStatus?.paused ? '已暂停' : '未运行'}
          </p>
        ) : null}
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 text-[0.6875rem]"
          onClick={onRefresh}
          disabled={refreshing}
        >
          <RefreshCw className={refreshing ? 'size-3 animate-spin' : 'size-3'} />
          {refreshing ? '正在扫描…' : '重新扫描仓库'}
        </Button>
      </div>
      {invoke ? (
        <AgentQuickInitDialog
          open={quickAgentTaskSpaceId !== null}
          onOpenChange={(open) => {
            if (!open) setQuickAgentTaskSpaceId(null)
          }}
          taskSpaceId={quickAgentTaskSpaceId ?? ''}
          defaultDeveloperId={
            projects
              .find((project) =>
                (project.taskSpaces || []).some((space) => space.id === quickAgentTaskSpaceId),
              )
              ?.trellisDevId?.trim() || defaultDeveloperId
          }
          invoke={invoke}
        />
      ) : null}
      {invoke ? (
        <>
          <ProjectOnboardingDialog
            open={onboardingOpen}
            onOpenChange={setOnboardingOpen}
            path={onboardingPath}
            projects={projects}
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
          <TaskOwnershipDialog
            open={ownershipTaskSpaceId !== null}
            onOpenChange={(open) => {
              if (!open) setOwnershipTaskSpaceId(null)
            }}
            taskSpaceId={ownershipTaskSpaceId || ''}
            invoke={invoke}
            onChanged={() => {
              toast.success('任务归属已更新，正在同步当前分支任务。')
              void refreshProjectStateRef.current()
              void onRefresh()
            }}
          />
        </>
      ) : null}
      {listenerTaskSpace ? (
        <BranchListenersDialog
          key={listenerTaskSpace.id}
          taskSpace={listenerTaskSpace}
          open
          onOpenChange={(open) => {
            if (!open) setListenerTaskSpace(null)
          }}
        />
      ) : null}
    </aside>
  )
}
