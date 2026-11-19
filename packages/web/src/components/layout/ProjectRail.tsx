import { useEffect, useMemo, useRef, useState } from 'react'
import { Plus, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import type { TaskSpace } from '@/api/board'
import { StatusDot } from './project-rail/StatusDot.tsx'
import { ProjectEntry } from './project-rail/ProjectEntry.tsx'
import {
  associationErrorMessage,
  deferredSyncErrorMessage,
  detachOutcome,
  normalizeAssociation,
  normalizeAssociations,
  normalizeSidecarStatus,
  tauriInvoke,
} from './project-rail/association.ts'
import type { LocalAssociation, ProjectRailProps, SidecarStatus } from './project-rail/types.ts'

export type { LocalAssociation }
import { Button } from '@/components/ui/button'
import { useConfirm } from '@/components/ui/confirm-dialog'
import { listen } from '@/desktop/tauri'
import { AgentQuickInitDialog } from '@/features/board/dialogs/AgentQuickInitDialog'
import { BranchListenersDialog } from '@/features/board/dialogs/BranchListenersDialog'
import { ProjectOnboardingDialog } from '@/features/board/dialogs/ProjectOnboardingDialog'
import { TaskOwnershipDialog } from '@/features/board/dialogs/TaskOwnershipDialog'
import { sameLocalRepositoryPath } from '@/lib/onboarding-associations.js'
import { associationSignature, desktopStateTopics } from '@/lib/project-rail-association.js'
import { createRefreshCoordinator } from '@/lib/refresh-coordinator.js'
import { cn } from '@/lib/utils'
import { toneSurface } from '@/components/ui/status-pill'
import { Alert } from '@/components/ui/alert'
import { Panel } from '@/components/ui/panel'

export function ProjectRail({
  projects,
  teams,
  defaultDeveloperId,
  current,
  teamId,
  onSelect,
  currentTaskSpace,
  onSelectTaskSpace,
  ownershipInboxOpen,
  onSelectOwnershipInbox,
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
          current?.running === next?.running && current?.paused === next?.paused ? current : next,
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

  async function openConflicts(association: LocalAssociation) {
    if (!invoke) return
    try {
      const shown = await invoke('live_conflicts_show', { taskSpaceId: association.taskSpaceId })
      if (shown !== true) toast.info('没有待处理的任务冲突')
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
    <aside className="hidden w-58 shrink-0 flex-col gap-1 border-r border-border bg-sidebar px-2.5 py-3.5 lg:flex">
      <p className="px-2 pb-1 text-2xs font-semibold tracking-[0.12em] text-muted-foreground">
        项目
      </p>
      {invoke ? (
        <Button
          variant="outline"
          size="sm"
          onClick={() => void startProjectOnboarding()}
          disabled={inspectingProject}
          className="mb-1 justify-start border-dashed text-xs text-muted-foreground hover:border-primary/50 hover:text-foreground"
        >
          <Plus className="size-3.5" />
          接入本地项目
        </Button>
      ) : null}
      {invoke && syncingAssociations.length ? (
        <Alert
          role="status"
          className={cn(
            'mb-1 border-warning/35 px-2 py-1.5 text-2xs leading-4',
            toneSurface('warning'),
          )}
        >
          正在同步任务，此时切换 Git 分支可能导致任务错位或污染，建议等待同步完成后再切换。
        </Alert>
      ) : null}
      {invoke && reviewAssociations.length ? (
        <Alert
          role="status"
          className={cn(
            'mb-1 border-warning/35 px-2 py-1.5 text-2xs leading-4',
            toneSurface('warning'),
          )}
        >
          有分支等待确认任务差异，确认处理方式后才会同步任务。
        </Alert>
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
        <StatusDot className="bg-primary" />
        全部项目
      </button>
      {current === 'all' && taskSpaceCount > 1 ? (
        <p className="px-2 pb-1 text-2xs leading-4 text-muted-foreground">全部项目按分支独立统计</p>
      ) : null}
      {projects.map((project) => (
        <ProjectEntry
          key={project.id}
          project={project}
          associations={associations}
          current={current}
          currentTaskSpace={currentTaskSpace}
          inspectingProject={inspectingProject}
          invoke={invoke}
          ownershipInboxOpen={ownershipInboxOpen}
          detachingTaskSpace={detachingTaskSpace}
          syncingDeferredTaskSpace={syncingDeferredTaskSpace}
          onStartOnboarding={() => void startProjectOnboarding()}
          onSelect={onSelect}
          onSelectTaskSpace={onSelectTaskSpace}
          onSelectOwnershipInbox={onSelectOwnershipInbox}
          onOpenConflicts={openConflicts}
          onOpenInitialReview={() => void openInitialReview()}
          onSyncDeferred={(association) => void syncDeferredTasks(association)}
          onDetach={(association) => void detachAssociation(association)}
          onListener={(taskSpace) => setListenerTaskSpace(taskSpace as TaskSpace)}
          onOwnership={(taskSpaceId) => setOwnershipTaskSpaceId(taskSpaceId)}
          onQuickAgent={(taskSpaceId) => setQuickAgentTaskSpaceId(taskSpaceId)}
        />
      ))}

      {associationError ? (
        <Alert variant="destructive" className="mx-1 mt-1 text-2xs leading-4">
          {associationError}
        </Alert>
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

      <Panel as="div" className="mt-auto gap-2 p-2.5">
        <div className="flex items-center gap-1.5">
          <StatusDot
            className={
              invoke
                ? sidecarStatus?.running
                  ? 'bg-primary'
                  : 'bg-destructive'
                : syncLive
                  ? 'bg-primary'
                  : 'bg-muted-foreground/50'
            }
          />
          <span className="text-xs font-semibold text-foreground">同步状态</span>
        </div>
        <p className="text-2xs leading-4 text-muted-foreground">{syncLabel}</p>
        {invoke ? (
          <p className="text-2xs leading-4 text-muted-foreground">
            客户端后台：
            {sidecarStatus?.running ? '运行中' : sidecarStatus?.paused ? '已暂停' : '未运行'}
          </p>
        ) : null}
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 text-xs"
          onClick={onRefresh}
          disabled={refreshing}
        >
          <RefreshCw className={refreshing ? 'size-3 animate-spin' : 'size-3'} />
          {refreshing ? '正在扫描…' : '重新扫描仓库'}
        </Button>
      </Panel>
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
