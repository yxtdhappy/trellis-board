import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  fetchTaskSpaceAssignees,
  logout,
  type TaskSpace,
  type TaskSpaceAssignee,
} from '@/api/board'
import { ProjectRail, type LocalAssociation } from '@/components/layout/ProjectRail'
import { useConfirm } from '@/components/ui/confirm-dialog'
import { TopBar, type BoardNavItem } from '@/components/layout/TopBar'
import { isBranchAssociationPaused } from '@/lib/project-rail-association.js'
import { useBoard } from '@/hooks/useBoard'
import { AttentionQueue } from '@/features/board/AttentionQueue'
import { ArchiveView } from '@/features/board/ArchiveView'
import { ExecutionHeader } from '@/features/board/ExecutionHeader'
import { FlowSignals } from '@/features/board/FlowSignals'
import { Kanban } from '@/features/board/Kanban'
import { useLocalTaskState } from '@/features/board/useLocalTaskState'
import type { TaskLocalState } from '@/features/board/TaskCard'
import { toast } from 'sonner'
import { errorMessage, listen } from '@/desktop/tauri'
import { UpdateDialog } from '@/desktop/UpdateDialog'
import { useServerVersion } from '@/hooks/useServerVersion'
import { Overview } from '@/features/board/Overview'
import { OwnershipInboxPanel } from '@/features/board/OwnershipInboxPanel'
import { PluginsView } from '@/features/plugins/PluginsView'
import { PluginPanel } from '@/features/plugins/PluginPanel'
import { TeamView } from '@/features/board/TeamView'
import { filterGroups } from '@/features/board/selectors'
import { AssignmentsDialog } from '@/features/board/dialogs/AssignmentsDialog'
import { CreateTaskDialog } from '@/features/board/dialogs/CreateTaskDialog'
import { PasswordDialog } from '@/features/board/dialogs/PasswordDialog'
import { ProjectManagerDialog } from '@/features/board/dialogs/ProjectManagerDialog'
import { PublishOperationDialog } from '@/features/board/dialogs/PublishOperationDialog'
import { SavedViewsDialog } from '@/features/board/dialogs/SavedViewsDialog'
import { TaskDetailDialog } from '@/features/board/dialogs/TaskDetailDialog'
import { TaskOperationList } from '@/features/board/TaskOperationList'
import { HandoffNotice } from '@/desktop/HandoffNotice'
import { LiveSyncControlDialog } from '@/desktop/LiveSyncControlDialog'
import { SyncNotice } from '@/desktop/SyncNotice'
import { isAttention, type BoardTask } from '@/features/board/task-view'
import { FILTER_STAGES } from '@/lib/execution-filter.js'
import { fetchPanels, type PluginPanel as PluginPanelInfo } from '@/api/panels'
import { fetchDesktopPanels } from '@/api/desktop-plugins'
import { DesktopPluginsView } from '@/features/plugins/DesktopPluginsView'
import { canManageProject, createIdempotencyKey, taskVersion } from '@/lib/team-client.js'
import { normalizeOwnershipBranches } from '@/lib/ownership-inbox.js'
import type { OwnershipBranchOption, OwnershipLocalAssociation } from '@/lib/ownership-inbox.js'
import { taskInstanceKey } from '@/lib/task-view-key.js'
import { Alert, AlertDescription } from '@/components/ui/alert'

function normalizeViews(value: unknown): { id: string; name: string }[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const record = item as Record<string, unknown>
    if (typeof record.id !== 'string' || typeof record.name !== 'string') return []
    return [{ id: record.id, name: record.name }]
  })
}

const NAV: BoardNavItem[] = [
  { id: 'pipeline', label: '任务流水线' },
  { id: 'team', label: '团队视角' },
  { id: 'archive', label: '归档索引' },
]

// 单机插件管理页只保留给 standalone 遗留模式；Team 模式的本机插件入口由桌面 EXE 独立提供。
const STANDALONE_PLUGIN_NAV: BoardNavItem = { id: 'plugins', label: '插件' }
// 仅桌面客户端可见：管理 EXE 内置的本机插件宿主。
const DESKTOP_PLUGIN_NAV: BoardNavItem = { id: 'desktop-plugins', label: '本机插件' }

type DesktopInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>
type DesktopClientIdentity = { name?: string; version?: string }

export function BoardPage() {
  const confirm = useConfirm()
  const controller = useBoard()
  const [view, setView] = useState('pipeline')
  const [panels, setPanels] = useState<PluginPanelInfo[]>([])
  const [selected, setSelected] = useState<BoardTask | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [assignmentsOpen, setAssignmentsOpen] = useState(false)
  const [passwordOpen, setPasswordOpen] = useState(false)
  const [projectsOpen, setProjectsOpen] = useState(false)
  const [viewsOpen, setViewsOpen] = useState(false)
  const [taskAssignees, setTaskAssignees] = useState<TaskSpaceAssignee[]>([])
  const [localAssociations, setLocalAssociations] = useState<LocalAssociation[]>([])
  const [brandName, setBrandName] = useState('Trellis Board')
  const [clientVersion, setClientVersion] = useState('')
  const [updateOpen, setUpdateOpen] = useState(false)
  const serverVersion = useServerVersion()

  const {
    board,
    tasks,
    projects,
    filters,
    setFilters,
    actions,
    teamMode,
    runtime,
    teamPage,
    ownershipInbox,
    loading,
    error,
  } = controller

  const desktopInvoke = (window as Window & { __TAURI__?: { core?: { invoke?: DesktopInvoke } } })
    .__TAURI__?.core?.invoke
  const isTauri = Boolean(desktopInvoke)
  const ownershipTaskSpaces = useMemo(() => {
    const byProject = new Map<string, OwnershipBranchOption[]>()
    for (const project of projects) {
      byProject.set(project.id, normalizeOwnershipBranches(project.taskSpaces))
    }
    return byProject
  }, [projects])
  const ownershipLocalAssociations = useMemo(() => {
    const byTaskSpace = new Map<string, OwnershipLocalAssociation>()
    for (const association of localAssociations) {
      byTaskSpace.set(association.taskSpaceId, {
        status: association.status,
        readOnly: association.readOnly,
        detachPending: association.detachPending,
        lastErrorCode: association.lastErrorCode,
      })
    }
    return byTaskSpace
  }, [localAssociations])
  const localTaskSpaceIds = useMemo(
    () => [...new Set(tasks.flatMap((task) => (task.taskSpaceId ? [task.taskSpaceId] : [])))],
    [tasks],
  )
  const {
    readonlyDirs,
    localDirs,
    refresh: refreshLocalTaskState,
  } = useLocalTaskState(localTaskSpaceIds)
  const localStateFor = useCallback(
    (task: BoardTask): TaskLocalState | undefined => {
      if (!isTauri || !task.taskSpaceId) return undefined
      const key = `${task.taskSpaceId}\u0000${task.relativeDir}`
      if (readonlyDirs.has(key)) return 'readonly'
      if (localDirs.has(key)) return 'local'
      return task.executionTaskKey ? 'remote' : undefined
    },
    [isTauri, readonlyDirs, localDirs],
  )
  const downloadTask = useCallback(
    async (task: BoardTask) => {
      const taskSpaceId = task.taskSpaceId
      const separator = task.executionTaskKey?.indexOf('::') ?? -1
      const taskId =
        task.executionTaskKey && separator >= 0 ? task.executionTaskKey.slice(separator + 2) : ''
      if (!desktopInvoke || !taskSpaceId || !taskId) return
      try {
        await desktopInvoke('live_task_download', { taskSpaceId, taskId })
        toast.success('已下载到本机')
        void refreshLocalTaskState()
      } catch (error) {
        toast.error(errorMessage(error, '下载任务失败'))
      }
    },
    [desktopInvoke, refreshLocalTaskState],
  )
  const canManageAdmin =
    Boolean(runtime?.systemAdmin) ||
    Boolean(runtime?.teams?.some((team) => team.role === 'admin')) ||
    projects.some((project) => canManageProject(project))
  const adminHref = !isTauri && teamMode && canManageAdmin ? '/admin.html' : undefined

  const groups = useMemo(
    () =>
      filterGroups(tasks, filters, projects, board?.savedViews || [], { scopedByServer: teamMode }),
    [tasks, filters, projects, board?.savedViews, teamMode],
  )
  const taskSpacesById = useMemo<Map<string, TaskSpace>>(
    () =>
      new Map(
        projects.flatMap((project) =>
          (project.taskSpaces || []).map((taskSpace) => [taskSpace.id, taskSpace] as const),
        ),
      ),
    [projects],
  )
  const selectedTaskSpace = selected?.taskSpaceId
    ? taskSpacesById.get(selected.taskSpaceId) || null
    : null
  const assignees = useMemo(
    () => [
      ...new Set(
        tasks.map((task) => task.assignee).filter((name): name is string => Boolean(name)),
      ),
    ],
    [tasks],
  )
  const detailAssignees = taskAssignees.length
    ? taskAssignees.map((member) => member.trellisDevId)
    : assignees
  const displayName = runtime?.user?.displayName || runtime?.user?.username || '看板用户'
  const savedViews = useMemo(() => normalizeViews(board?.savedViews), [board?.savedViews])
  const archived = useMemo(() => tasks.filter((task) => task.archived), [tasks])
  const archiveRevisionValue =
    controller.teamStatus?.archiveRevision ?? controller.teamStatus?.queryRevision
  const archiveRevision =
    typeof archiveRevisionValue === 'number' || typeof archiveRevisionValue === 'string'
      ? archiveRevisionValue
      : null
  const activeCount = tasks.filter((task) => !task.archived).length
  // 服务端未下发 features 时按开启处理；只有明确 false 才视为插件被屏蔽。
  const pluginsEnabled = teamMode ? runtime?.features?.pluginsEnabled !== false : true
  const loadPanels = useCallback(async () => {
    const [remote, desktop] = await Promise.all([
      pluginsEnabled ? fetchPanels().catch(() => []) : Promise.resolve([]),
      isTauri && teamMode ? fetchDesktopPanels().catch(() => []) : Promise.resolve([]),
    ])
    setPanels([...remote, ...desktop])
  }, [isTauri, pluginsEnabled, teamMode])
  const navItems = useMemo<BoardNavItem[]>(
    () => [
      ...NAV,
      ...(isTauri && teamMode ? [DESKTOP_PLUGIN_NAV] : []),
      ...(teamMode ? [] : [STANDALONE_PLUGIN_NAV]),
      ...panels
        .filter((panel) => panel.placement === 'view')
        .map((panel) => ({ id: `panel:${panel.pluginId}:${panel.id}`, label: panel.title })),
    ],
    [isTauri, panels, teamMode],
  )
  const activePanel = panels.find((panel) => `panel:${panel.pluginId}:${panel.id}` === view)
  const createProject =
    filters.projectId === 'all'
      ? projects[0]
      : projects.find((project) => project.id === filters.projectId)
  const createProjectId = createProject?.id || ''
  const localTaskSpaceId =
    createProject?.taskSpaces?.find((taskSpace) =>
      localAssociations.some(
        (association) =>
          association.projectId === createProjectId &&
          association.taskSpaceId === taskSpace.id &&
          association.status === 'approved' &&
          !association.readOnly &&
          association.liveSyncStatus !== 'error' &&
          !isBranchAssociationPaused(association),
      ),
    )?.id || ''

  useEffect(() => {
    setSelected(null)
  }, [filters.teamId])

  useEffect(() => {
    if (!selected) return
    const fresh = tasks.find((task) => taskInstanceKey(task) === taskInstanceKey(selected))
    if (fresh && fresh !== selected) setSelected(fresh)
  }, [tasks, selected])

  useEffect(() => {
    if (!selected?.taskSpaceId) {
      setTaskAssignees([])
      return
    }
    let active = true
    fetchTaskSpaceAssignees(selected.taskSpaceId)
      .then((values) => {
        if (active) setTaskAssignees(values)
      })
      .catch(() => {
        if (active) setTaskAssignees([])
      })
    return () => {
      active = false
    }
  }, [selected?.taskSpaceId])

  useEffect(() => {
    if (runtime?.user?.mustChangePassword) setPasswordOpen(true)
  }, [runtime?.user?.mustChangePassword])

  useEffect(() => {
    if (!desktopInvoke) return
    let active = true
    desktopInvoke('client_identity')
      .then((value) => {
        if (!active || !value || typeof value !== 'object') return
        const identity = value as DesktopClientIdentity
        if (typeof identity.name === 'string' && identity.name.trim()) {
          setBrandName(identity.name.trim())
        }
        if (typeof identity.version === 'string' && identity.version.trim()) {
          setClientVersion(identity.version.trim())
        }
      })
      .catch(() => {
        /* 旧客户端没有身份命令时继续使用默认品牌 */
      })
    return () => {
      active = false
    }
  }, [desktopInvoke])

  useEffect(() => {
    if (!listen) return
    let active = true
    let stop: (() => void) | undefined
    void listen('update-open-dialog', () => setUpdateOpen(true)).then((unlisten) => {
      if (active) stop = unlisten
      else unlisten()
    })
    return () => {
      active = false
      stop?.()
    }
  }, [])

  useEffect(() => {
    // Team 模式不再提供单机插件管理页；旧书签/状态落在这里时回退到任务流水线。
    if (teamMode && view === 'plugins') setView('pipeline')
  }, [teamMode, view])

  useEffect(() => {
    if (!runtime) return
    void loadPanels()
  }, [runtime, loadPanels])

  useEffect(() => {
    if (view !== 'plugins' || !pluginsEnabled) return
    void loadPanels()
  }, [view, pluginsEnabled, loadPanels])

  // 插件页改排序后立即重排导航，不用切走再回来。
  useEffect(() => {
    const refresh = () => void loadPanels()
    window.addEventListener('trellis:panels-changed', refresh)
    return () => window.removeEventListener('trellis:panels-changed', refresh)
  }, [loadPanels])

  const syncLabel = teamMode
    ? `${projects.length} 个授权项目 · 事件驱动 · 10 秒可见兜底`
    : controller.status?.refreshRunning
      ? '正在更新 · 当前显示缓存'
      : `文件监听中 · ${projects.length} 个仓库`

  async function handleLogout() {
    if (desktopInvoke) {
      try {
        await desktopInvoke('desktop_logout')
        return
      } catch {
        /* 旧客户端没有桌面退出命令时回退到网页退出流程 */
      }
    }
    try {
      await logout()
    } finally {
      window.location.assign('/login.html')
    }
  }

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
      <TopBar
        brandName={brandName}
        version={clientVersion || undefined}
        serverVersion={serverVersion || undefined}
        onOpenUpdate={isTauri ? () => setUpdateOpen(true) : undefined}
        nav={navItems}
        activeNav={view}
        onNavigate={(id) => setView(id)}
        search={filters.search}
        onSearch={(value) => setFilters({ search: value })}
        onCreate={() => setCreateOpen(true)}
        displayName={displayName}
        teams={runtime?.teams || []}
        teamId={filters.teamId}
        onTeamChange={(teamId) => setFilters({ teamId })}
        onOpenAssignments={() => setAssignmentsOpen(true)}
        onOpenPassword={() => setPasswordOpen(true)}
        onLogout={handleLogout}
        adminHref={adminHref}
      />

      <div className="flex min-h-0 flex-1">
        <ProjectRail
          projects={projects}
          teams={runtime?.teams || []}
          defaultDeveloperId={runtime?.user?.username || ''}
          current={filters.projectId}
          teamId={filters.teamId}
          onSelect={(id) => setFilters({ projectId: id, taskSpaceId: 'all' })}
          currentTaskSpace={filters.taskSpaceId}
          onSelectTaskSpace={(taskSpaceId) => setFilters({ taskSpaceId })}
          ownershipInboxOpen={ownershipInbox.open}
          onSelectOwnershipInbox={ownershipInbox.toggle}
          onManage={() => setProjectsOpen(true)}
          manageEnabled={!teamMode}
          syncLabel={syncLabel}
          syncLive={!controller.status?.refreshRunning}
          refreshing={Boolean(controller.status?.refreshRunning) || loading}
          onRefresh={() => void actions.refresh()}
          onAssociationsChange={setLocalAssociations}
        />

        <main className="flex min-w-0 flex-1 flex-col gap-3 overflow-y-auto px-5 py-4">
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}

          {teamMode && view === 'pipeline' ? (
            <TaskOperationList
              operations={controller.operations}
              userKey={runtime?.user?.username || ''}
              taskSpaceId={filters.taskSpaceId === 'all' ? '' : filters.taskSpaceId}
              onRetry={actions.retryOperation}
              onCancel={actions.cancelOperation}
            />
          ) : null}

          {view === 'pipeline' ? (
            <>
              <ExecutionHeader
                filters={filters}
                onChange={setFilters}
                projects={projects}
                stages={FILTER_STAGES}
                assignees={assignees}
                total={activeCount}
                savedViews={savedViews}
                onSaveView={() => setViewsOpen(true)}
                onDeleteView={(id) => {
                  const view = savedViews.find((item) => item.id === id)
                  if (!view) return
                  void confirm({
                    title: `删除组合视图“${view.name}”？`,
                    description: '内置视图不会被修改。',
                    confirmText: '删除',
                    tone: 'danger',
                  }).then((confirmed) => {
                    if (confirmed) void actions.deleteView(id)
                  })
                }}
              />
              <OwnershipInboxPanel
                count={ownershipInbox.count}
                projectGroups={ownershipInbox.projectGroups}
                projectId={filters.projectId}
                open={ownershipInbox.open}
                items={ownershipInbox.items}
                total={ownershipInbox.total}
                nextCursor={ownershipInbox.nextCursor}
                loading={ownershipInbox.loading}
                loadingMore={ownershipInbox.loadingMore}
                error={ownershipInbox.error}
                currentUserId={runtime?.user?.id || ''}
                isTauri={isTauri}
                invoke={desktopInvoke || null}
                taskSpacesByProject={ownershipTaskSpaces}
                localAssociations={ownershipLocalAssociations}
                onToggle={() => ownershipInbox.toggle(filters.projectId)}
                onRetry={() => void ownershipInbox.reload()}
                onLoadMore={() => void ownershipInbox.loadMore()}
                onAssigned={() => {
                  toast.success('任务归属已更新')
                  void ownershipInbox.reload()
                  void actions.refresh()
                }}
              />
              <FlowSignals
                tasks={tasks.filter((task) => !task.archived)}
                wipLimit={board?.settings?.executionWipLimit}
                onSaveWip={actions.saveWip}
              />
              <AttentionQueue
                tasks={tasks.filter((task) => !task.archived)}
                onOpen={(task) => setSelected(task)}
              />
              <Overview
                active={activeCount}
                archived={archived.length}
                attention={tasks.filter((task) => !task.archived && isAttention(task)).length}
                repositories={projects.length}
              />
              <Kanban
                groups={groups}
                onOpen={(task) => setSelected(task)}
                onEditPlan={(task) => setSelected(task)}
                localStateFor={localStateFor}
                onDownload={(task) => void downloadTask(task)}
              />
            </>
          ) : null}

          {view === 'team' ? (
            <TeamView
              tasks={tasks.filter((task) => !task.archived)}
              projects={projects}
              stages={FILTER_STAGES}
              filters={filters}
              onChange={setFilters}
              onRefresh={() => void actions.refresh()}
              onOpen={(task) => setSelected(task)}
              loading={loading}
              summary={
                teamPage
                  ? `跨项目混合排序 · 当前页 ${teamPage.tasks.length} 条 · 服务端筛选后共 ${teamPage.total} 条`
                  : '按负责人统计'
              }
            />
          ) : null}

          {view === 'plugins' ? <PluginsView /> : null}
          {view === 'desktop-plugins' && isTauri ? <DesktopPluginsView /> : null}

          {activePanel ? (
            <PluginPanel
              panel={activePanel}
              projectId={filters.projectId}
              projectName={projects.find((project) => project.id === filters.projectId)?.name || ''}
            />
          ) : null}

          {view === 'archive' ? (
            <ArchiveView
              tasks={archived}
              projects={runtime?.projects || projects}
              teams={runtime?.teams || []}
              projectId={filters.projectId || 'all'}
              onProjectChange={(projectId) => setFilters({ projectId, taskSpaceId: 'all' })}
              branch={filters.branch}
              onBranchChange={(branch) => setFilters({ branch })}
              teamMode={teamMode}
              queryRevision={archiveRevision}
              onOpen={(task) => setSelected(task)}
              onRefresh={() => void actions.refresh()}
            />
          ) : null}
        </main>
      </div>

      <CreateTaskDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        projects={projects}
        defaultProjectId={filters.projectId}
        defaultTaskSpaceId={filters.taskSpaceId === 'all' ? '' : filters.taskSpaceId}
        localTaskSpaceId={localTaskSpaceId}
        teamMode={teamMode}
        onCreate={actions.createTask}
      />
      <AssignmentsDialog
        open={assignmentsOpen}
        onOpenChange={setAssignmentsOpen}
        assignments={controller.assignments}
        onAccept={actions.accept}
      />
      <PasswordDialog open={passwordOpen} onOpenChange={setPasswordOpen} />
      <ProjectManagerDialog
        open={projectsOpen}
        onOpenChange={setProjectsOpen}
        projects={projects}
        onList={actions.repositories.list}
        onPick={actions.repositories.pick}
        onAdd={actions.repositories.add}
        onRemove={actions.repositories.remove}
        onScan={actions.refresh}
      />
      <PublishOperationDialog
        operation={controller.operation}
        onClose={actions.dismissOperation}
        onRetry={() => void actions.retryOperation()}
      />
      <SavedViewsDialog
        open={viewsOpen}
        onOpenChange={setViewsOpen}
        onSave={async (name, value) => {
          const id = await actions.saveView(name, value)
          if (id) setFilters({ executionView: id })
          return id
        }}
      />
      {isTauri ? (
        <UpdateDialog
          open={updateOpen}
          onOpenChange={setUpdateOpen}
          serverVersion={serverVersion}
        />
      ) : null}
      <HandoffNotice />
      <SyncNotice />
      <LiveSyncControlDialog />
      <TaskDetailDialog
        task={selected}
        open={Boolean(selected)}
        onOpenChange={(open) => !open && setSelected(null)}
        assignees={detailAssignees}
        taskSpace={selectedTaskSpace}
        teamMode={teamMode}
        onAssign={async (task, assignee) => {
          if (teamMode) {
            const version = taskVersion(task)
            if (!version) throw new Error('服务端未返回 taskVersion，请刷新项目后重试')
            const target = taskAssignees.find((member) => member.trellisDevId === assignee)
            if (!target) throw new Error('目标负责人没有可写项目身份，请刷新后重试')
            await actions.assign({
              taskSpaceId: task.taskSpaceId,
              executionTaskKey: task.executionTaskKey,
              assigneeUserId: target.userId,
              expectedTaskVersion: version,
              idempotencyKey: createIdempotencyKey(),
            })
            return
          }
          await actions.assign({
            repositoryId: task.projectId,
            taskDir: task.relativeDir,
            assignee,
          })
        }}
        onPlanSaved={() => void actions.refresh()}
        tasks={tasks}
        actions={actions}
      />
    </div>
  )
}
