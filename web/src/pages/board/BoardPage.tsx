import { useEffect, useMemo, useState } from 'react'
import { fetchTaskSpaceAssignees, logout, type TaskSpaceAssignee } from '@/api/board'
import { ProjectRail } from '@/components/layout/ProjectRail'
import { TopBar, type BoardNavItem } from '@/components/layout/TopBar'
import { useBoard } from '@/hooks/useBoard'
import { AttentionQueue } from '@/features/board/AttentionQueue'
import { ArchiveView } from '@/features/board/ArchiveView'
import { ExecutionHeader } from '@/features/board/ExecutionHeader'
import { FlowSignals } from '@/features/board/FlowSignals'
import { Kanban } from '@/features/board/Kanban'
import { Overview } from '@/features/board/Overview'
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
import { isAttention, type BoardTask } from '@/features/board/task-view'
import { FILTER_STAGES } from '@/lib/execution-filter.js'
import { fetchPanels, type PluginPanel as PluginPanelInfo } from '@/api/panels'
import { taskVersion } from '@/lib/team-client.js'

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
  { id: 'plugins', label: '插件' },
]

export function BoardPage() {
  const controller = useBoard()
  const adminHref = (window as Window & { __TAURI__?: { core?: { invoke?: unknown } } }).__TAURI__
    ?.core?.invoke
    ? undefined
    : '/admin.html'
  const [view, setView] = useState('pipeline')
  const [panels, setPanels] = useState<PluginPanelInfo[]>([])
  const [selected, setSelected] = useState<BoardTask | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [assignmentsOpen, setAssignmentsOpen] = useState(false)
  const [passwordOpen, setPasswordOpen] = useState(false)
  const [projectsOpen, setProjectsOpen] = useState(false)
  const [viewsOpen, setViewsOpen] = useState(false)
  const [taskAssignees, setTaskAssignees] = useState<TaskSpaceAssignee[]>([])

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
    loading,
    error,
  } = controller

  const groups = useMemo(
    () =>
      filterGroups(tasks, filters, projects, board?.savedViews || [], { scopedByServer: teamMode }),
    [tasks, filters, projects, board?.savedViews, teamMode],
  )
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
  const archiveRevision =
    typeof controller.teamStatus?.queryRevision === 'number' ||
    typeof controller.teamStatus?.queryRevision === 'string'
      ? controller.teamStatus.queryRevision
      : null
  const activeCount = tasks.filter((task) => !task.archived).length
  const navItems = useMemo<BoardNavItem[]>(
    () => [
      ...NAV,
      ...panels
        .filter((panel) => panel.placement === 'view')
        .map((panel) => ({ id: `panel:${panel.pluginId}:${panel.id}`, label: panel.title })),
    ],
    [panels],
  )
  const activePanel = panels.find((panel) => `panel:${panel.pluginId}:${panel.id}` === view)

  useEffect(() => {
    setSelected(null)
  }, [filters.teamId])

  useEffect(() => {
    if (!selected) return
    const fresh = tasks.find((task) => task.taskKey === selected.taskKey)
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
    let cancelled = false
    fetchPanels()
      .then((list) => {
        if (!cancelled) setPanels(list)
      })
      .catch(() => {
        /* 团队模式或插件关闭时没有面板 */
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (view !== 'plugins') return
    fetchPanels()
      .then(setPanels)
      .catch(() => {
        /* 插件页不可用时保留已有面板 */
      })
  }, [view])

  const syncLabel = teamMode
    ? `${projects.length} 个授权项目 · 每 3 秒检查同步状态`
    : controller.status?.refreshRunning
      ? '正在更新 · 当前显示缓存'
      : `文件监听中 · ${projects.length} 个仓库`

  async function handleLogout() {
    try {
      await logout()
    } finally {
      window.location.assign('/login.html')
    }
  }

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
      <TopBar
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
          current={filters.projectId}
          teamId={filters.teamId}
          onSelect={(id) => setFilters({ projectId: id, taskSpaceId: 'all' })}
          currentTaskSpace={filters.taskSpaceId}
          onSelectTaskSpace={(taskSpaceId) => setFilters({ taskSpaceId })}
          onManage={() => setProjectsOpen(true)}
          manageEnabled={!teamMode}
          syncLabel={syncLabel}
          syncLive={!controller.status?.refreshRunning}
          refreshing={Boolean(controller.status?.refreshRunning) || loading}
          onRefresh={() => void actions.refresh()}
        />

        <main className="flex min-w-0 flex-1 flex-col gap-3 overflow-y-auto px-5 py-4">
          {error ? (
            <p
              role="alert"
              className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              {error}
            </p>
          ) : null}

          {teamMode && view === 'pipeline' ? (
            <TaskOperationList
              operations={controller.operations}
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
                  if (!window.confirm(`删除组合视图“${view.name}”？内置视图不会被修改。`)) return
                  void actions.deleteView(id)
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
              onApply={() => void actions.refresh()}
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

          {activePanel ? <PluginPanel panel={activePanel} /> : null}

          {view === 'archive' ? (
            <ArchiveView
              key={`${filters.projectId}:${filters.taskSpaceId}`}
              tasks={archived}
              projects={projects}
              projectId={filters.projectId}
              taskSpaceId={filters.taskSpaceId}
              teamMode={teamMode}
              teamId={filters.teamId}
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
      <TaskDetailDialog
        task={selected}
        open={Boolean(selected)}
        onOpenChange={(open) => !open && setSelected(null)}
        assignees={detailAssignees}
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
              idempotencyKey: crypto.randomUUID(),
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
