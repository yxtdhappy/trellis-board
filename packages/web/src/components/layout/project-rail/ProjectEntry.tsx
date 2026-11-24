import { Bot, FolderGit2, LockKeyhole, Unlink2, Upload, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { StatusPill, toneSurface } from '@/components/ui/status-pill'
import { Separator } from '@/components/ui/separator'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  associationOwnershipCounts,
  associationTaskStateCounts,
  countProjectPausedBranches,
  isBranchAssociationPaused,
  projectListenerView,
  selectProjectAssociation,
} from '@/lib/project-rail-association.js'
import { cn } from '@/lib/utils'
import { projectAssociationView, visibleTaskSpaces } from './association.ts'
import { StatusDot } from './StatusDot.tsx'
import type { LocalAssociation, Project, WorktreeStatus } from './types.ts'

export type ProjectEntryProps = {
  project: Project
  associations: Map<string, LocalAssociation>
  worktreeStatuses: Map<string, WorktreeStatus>
  current: string
  currentTaskSpace?: string
  inspectingProject: boolean
  invoke: ((command: string, args?: Record<string, unknown>) => Promise<unknown>) | null
  ownershipInboxOpen: boolean
  detachingTaskSpace: string | null
  syncingDeferredTaskSpace: string | null
  onStartOnboarding: () => void
  onSelect: (id: string) => void
  onSelectTaskSpace: (id: string) => void
  onSelectOwnershipInbox: (projectId: string) => void
  onOpenConflicts: (association: LocalAssociation) => void
  onOpenInitialReview: () => void
  onSyncDeferred: (association: LocalAssociation) => void
  onDetach: (association: LocalAssociation) => void
  onListener: (taskSpace: unknown) => void
  onOwnership: (taskSpaceId: string) => void
  onQuickAgent: (taskSpaceId: string) => void
}

export function ProjectEntry(props: ProjectEntryProps) {
  const {
    project,
    associations,
    worktreeStatuses,
    current,
    currentTaskSpace,
    inspectingProject,
    invoke,
    ownershipInboxOpen,
    detachingTaskSpace,
    syncingDeferredTaskSpace,
    onStartOnboarding,
    onSelect,
    onSelectTaskSpace,
    onSelectOwnershipInbox,
    onOpenConflicts,
    onOpenInitialReview,
    onSyncDeferred,
    onDetach,
    onListener,
    onOwnership,
    onQuickAgent,
  } = props
  const openConflicts = onOpenConflicts
  const openInitialReview = onOpenInitialReview
  const detachAssociation = onDetach
  const syncDeferredTasks = onSyncDeferred
  const setListenerTaskSpace = onListener
  const setOwnershipTaskSpaceId = onOwnership
  const setQuickAgentTaskSpaceId = onQuickAgent

  const taskSpaces = visibleTaskSpaces(project, worktreeStatuses)
  const projectInboxCount = Math.max(0, project.ownershipInboxCount || 0)
  const selectedTaskSpace =
    current === project.id
      ? taskSpaces.find((taskSpace) => taskSpace.id === currentTaskSpace)
      : undefined
  const activeTaskSpace = current === project.id ? selectedTaskSpace || taskSpaces[0] : null
  const activeAssociation = activeTaskSpace ? associations.get(activeTaskSpace.id) : undefined
  const projectAssociation = selectProjectAssociation(project, associations, selectedTaskSpace?.id)
  const pausedBranchCount = countProjectPausedBranches(project, associations)
  const showPartialPause = !selectedTaskSpace && taskSpaces.length > 1 && pausedBranchCount > 0
  const projectConflictCount = projectAssociation
    ? associationTaskStateCounts(projectAssociation).conflictCount
    : 0
  const conflictAssociation =
    invoke && projectConflictCount > 0 && projectAssociation?.status === 'approved'
      ? projectAssociation
      : undefined
  const view = invoke
    ? showPartialPause
      ? {
          label: `已关联 · ${pausedBranchCount}/${taskSpaces.length} 个分支已暂停`,
          detail: '各分支仅按自身状态同步。',
          dotClassName: 'bg-warning',
          textClassName: 'text-warning',
        }
      : projectAssociationView(projectAssociation, projectConflictCount > 0)
    : null
  const activeView = invoke ? projectAssociationView(activeAssociation) : null
  const hasListenerSummary = taskSpaces.some((taskSpace) => projectListenerView(taskSpace))
  return (
    <div key={project.id} className="flex flex-col">
      <div
        className={
          current === project.id
            ? 'flex items-center rounded-lg border border-primary/40 bg-primary/15 text-foreground'
            : 'flex items-center rounded-lg border border-transparent hover:bg-sidebar-accent/60'
        }
      >
        <button
          type="button"
          onClick={() => onSelect(project.id)}
          className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left"
          title={project.name}
        >
          <StatusDot className={view?.dotClassName || 'bg-chart-3'} />
          <span className="min-w-0">
            <span className="block truncate text-xs font-medium">{project.name}</span>
            {view ? (
              <span
                className={cn('block truncate text-2xs', view.textClassName)}
                title={view.detail || view.label}
                aria-live="polite"
              >
                {view.label}
                {view.detail ? <span className="sr-only">，详情：{view.detail}</span> : null}
              </span>
            ) : null}
          </span>
        </button>
        {current === 'all' && projectInboxCount > 0 ? (
          <StatusPill
            tone="warning"
            size="xs"
            className="mr-1 py-0.5"
            title={`待归属任务 ${projectInboxCount}`}
          >
            待归属任务 {projectInboxCount}
          </StatusPill>
        ) : null}
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
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="mr-1.5 shrink-0 text-muted-foreground"
                      aria-label={`初始化 ${project.name} ${activeTaskSpace.branchName} 的编码 Agent`}
                      onClick={() => setQuickAgentTaskSpaceId(activeTaskSpace.id)}
                    />
                  }
                >
                  <Bot className="size-3.5" aria-hidden="true" />
                </TooltipTrigger>
                <TooltipContent>初始化编码 Agent</TooltipContent>
              </Tooltip>
            </>
          ) : (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="mr-1.5 shrink-0 text-muted-foreground"
                    aria-label={`${activeAssociation ? '重新关联' : '关联'} ${project.name} ${activeTaskSpace.branchName} 的本地 Git 仓库`}
                    disabled={inspectingProject}
                    onClick={() => void onStartOnboarding()}
                  />
                }
              >
                <FolderGit2 className="size-3.5" aria-hidden="true" />
              </TooltipTrigger>
              <TooltipContent>
                {activeAssociation ? '重新关联本地 Git 仓库' : '关联本地 Git 仓库'}
              </TooltipContent>
            </Tooltip>
          )
        ) : null}
      </div>
      {conflictAssociation ? (
        <button
          type="button"
          className="ml-5 mt-0.5 flex min-w-0 items-center gap-1.5 rounded-md border border-destructive/35 bg-destructive/10 px-2 py-1 text-left text-2xs text-destructive hover:bg-destructive/15"
          aria-label={`处理 ${conflictAssociation.branchName} 的 ${projectConflictCount} 个冲突`}
          title={
            conflictAssociation.conflictPendingTaskDirs
              .map((taskDir) => taskDir.split('/').at(-1))
              .join('、') || conflictAssociation.branchName
          }
          onClick={() => void openConflicts(conflictAssociation)}
        >
          <StatusDot className="bg-destructive" />
          <span className="min-w-0 flex-1 truncate">
            已关联 · {projectConflictCount} 个冲突待处理 · 点击处理
          </span>
        </button>
      ) : null}
      {current === project.id ? (
        <button
          type="button"
          className={cn(
            'ml-5 mt-0.5 flex min-w-0 items-center gap-1.5 rounded-md border px-2 py-1 text-left text-2xs disabled:pointer-events-none disabled:opacity-60',
            projectInboxCount > 0
              ? cn(
                  'border-warning/35 hover:brightness-95 dark:hover:brightness-110',
                  toneSurface('warning'),
                )
              : 'border-border/70 bg-muted/30 text-muted-foreground',
          )}
          aria-expanded={projectInboxCount > 0 && ownershipInboxOpen}
          aria-controls={projectInboxCount > 0 ? 'ownership-inbox-list' : undefined}
          aria-label={`待归属任务 ${projectInboxCount}`}
          disabled={projectInboxCount === 0}
          title={
            projectInboxCount > 0
              ? `${project.name} 有 ${projectInboxCount} 个项目级待归属任务`
              : `${project.name} 当前没有项目级待归属任务`
          }
          onClick={() => onSelectOwnershipInbox(project.id)}
        >
          <StatusDot className={projectInboxCount > 0 ? 'bg-warning' : 'bg-muted-foreground/40'} />
          <span className="min-w-0 flex-1 truncate">待归属任务</span>
          <StatusPill
            tone={projectInboxCount > 0 ? 'warning' : 'neutral'}
            size="xs"
            className="shrink-0 py-0.5"
          >
            {projectInboxCount}
          </StatusPill>
        </button>
      ) : null}
      {current === 'all' && hasListenerSummary ? (
        <div className="ml-5 flex gap-1">
          <Separator orientation="vertical" className="bg-border/70" />
          <div className="flex min-w-0 flex-1 flex-col">
            {taskSpaces.map((taskSpace) => {
              const listenerView = projectListenerView(taskSpace)
              if (!listenerView) return null
              return (
                <div
                  key={taskSpace.id}
                  className="flex min-w-0 items-center gap-1 px-2 py-0.5 text-2xs text-muted-foreground"
                  title={`${taskSpace.branchName}：${listenerView.counts} · ${listenerView.label}`}
                >
                  <span
                    className={cn('size-1 shrink-0 rounded-full', listenerView.dotClassName)}
                    aria-hidden="true"
                  />
                  <span className="max-w-20 shrink-0 truncate font-medium text-foreground">
                    {taskSpace.branchName}
                  </span>
                  <span className={cn('min-w-0 truncate', listenerView.textClassName)}>
                    {listenerView.counts} · {listenerView.label}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      ) : null}
      {current === project.id ? (
        <div className="ml-5 flex gap-1">
          <Separator orientation="vertical" className="bg-border/70" />
          <div className="flex min-w-0 flex-1 flex-col">
            {taskSpaces.map((taskSpace) => {
              const branchAssociation = associations.get(taskSpace.id)
              const worktreeStatus = worktreeStatuses.get(taskSpace.id)
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
                worktreeStatus?.archiveSyncPending
                  ? '本地任务已归档，等待服务端归档同步完成'
                  : null,
                worktreeStatus?.lastVisibilityError
                  ? `可见性检查失败：${worktreeStatus.lastVisibilityError}`
                  : null,
                listenerView?.detail,
              ]
                .filter(Boolean)
                .join('；')
              const showOwnershipAction =
                branchAssociation?.status === 'approved' &&
                !branchAssociation.readOnly &&
                !branchPaused &&
                ownership.totalCount > 0
              const showInitialReviewAction =
                branchAssociation?.status === 'approved' && branchAssociation.initialReviewPending
              return (
                <div
                  key={taskSpace.id}
                  className={
                    currentTaskSpace === taskSpace.id
                      ? 'flex flex-col rounded-md border border-primary/35 bg-primary/20 text-2xs font-semibold text-foreground'
                      : 'flex flex-col rounded-md border border-transparent text-2xs text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground'
                  }
                >
                  <div className="flex items-center">
                    <button
                      type="button"
                      onClick={() => onSelectTaskSpace(taskSpace.id)}
                      className="flex min-w-0 flex-1 items-start gap-1.5 px-2 py-1 text-left"
                      title={branchTitle || taskSpace.branchName}
                    >
                      <span
                        className={cn(
                          'mt-1 size-1 shrink-0 rounded-full',
                          listenerView?.dotClassName || branchView?.dotClassName || 'bg-chart-3',
                        )}
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1">
                          <span className="min-w-0 flex-1 truncate">{taskSpace.branchName}</span>
                          {branchPaused ? (
                            <span className="shrink-0 text-2xs font-medium text-destructive">
                              已暂停
                            </span>
                          ) : null}
                        </span>
                        {listenerView ? (
                          <>
                            <span className="block truncate text-2xs leading-3 text-muted-foreground">
                              {listenerView.counts}
                            </span>
                            <span
                              className={cn(
                                'block truncate text-2xs leading-3',
                                listenerView.textClassName,
                              )}
                            >
                              {listenerView.label}
                            </span>
                          </>
                        ) : null}
                        {detachPending ? (
                          <span className="block truncate text-2xs leading-3 text-warning">
                            服务端解绑待确认
                          </span>
                        ) : null}
                        {worktreeStatus?.archiveSyncPending ? (
                          <span className="block truncate text-2xs leading-3 text-warning">
                            等待归档同步
                          </span>
                        ) : null}
                        {worktreeStatus?.lastVisibilityError ? (
                          <span className="block truncate text-2xs leading-3 text-warning">
                            可见性检查失败
                          </span>
                        ) : null}
                      </span>
                    </button>
                    {branchAssociation?.status === 'approved' &&
                    !branchAssociation.readOnly &&
                    branchAssociation.deferredCount > 0 ? (
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        className="mr-1 size-5 shrink-0 text-warning hover:bg-background hover:text-warning disabled:opacity-60"
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
                      </Button>
                    ) : null}
                    {taskSpace.canManage ? (
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <Button
                              variant="ghost"
                              size="icon-xs"
                              className="mr-1 size-5 shrink-0 text-muted-foreground hover:bg-background"
                              aria-label={`查看 ${taskSpace.branchName} 的分支监听详情`}
                              onClick={() => setListenerTaskSpace(taskSpace)}
                            />
                          }
                        >
                          <Users className="size-3" aria-hidden="true" />
                        </TooltipTrigger>
                        <TooltipContent>查看分支监听详情</TooltipContent>
                      </Tooltip>
                    ) : null}
                    {branchAssociation?.status === 'approved' ? (
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        className="mr-1 size-5 shrink-0 text-muted-foreground hover:bg-background hover:text-destructive"
                        aria-label={`不再同步 ${taskSpace.branchName}`}
                        title={detachPending ? '服务端解绑待确认' : '不再同步此分支'}
                        disabled={detachPending || detachingTaskSpace !== null}
                        onClick={() => void detachAssociation(branchAssociation)}
                      >
                        <Unlink2
                          className={
                            detachingTaskSpace === taskSpace.id ? 'size-3 animate-pulse' : 'size-3'
                          }
                          aria-hidden="true"
                        />
                      </Button>
                    ) : null}
                  </div>
                  {showOwnershipAction || showInitialReviewAction ? (
                    <div className="flex flex-wrap items-center gap-1 pr-2 pb-1 pl-4.5">
                      {showOwnershipAction ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          className="h-5 shrink-0 rounded border-0 px-1.5 text-2xs font-medium text-warning hover:bg-background hover:text-warning"
                          aria-label={`处理 ${taskSpace.branchName} 的 ${ownership.totalCount} 个任务归属`}
                          title={branchView?.detail || branchView?.label}
                          onClick={() => setOwnershipTaskSpaceId(taskSpace.id)}
                        >
                          待处理 {ownership.totalCount}
                        </Button>
                      ) : null}
                      {showInitialReviewAction ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          className="h-5 shrink-0 rounded border-0 px-1.5 text-2xs font-medium text-warning hover:bg-background hover:text-warning"
                          aria-label={`处理 ${taskSpace.branchName} 的任务差异`}
                          title={branchView?.detail || branchView?.label}
                          onClick={() => void openInitialReview()}
                        >
                          确认差异
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              )
            })}
            {currentTaskSpace === 'all' && taskSpaces.length > 1 ? (
              <p className="px-2 py-1 text-2xs leading-4 text-muted-foreground">按分支独立统计</p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}
