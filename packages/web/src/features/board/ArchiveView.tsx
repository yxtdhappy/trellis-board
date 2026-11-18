import { useEffect, useMemo, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useArchiveTasks } from '@/hooks/useArchiveTasks'
import { formatArchiveTimestamp, sortArchivedTasks } from '@/lib/archive-sort.js'
import { branchMatches } from '@/lib/execution-filter.js'
import { archiveProjectAfterTeamChange, resolveArchiveProjectId } from '@/lib/archive-filter.js'
import { archiveAssigneeOptions } from '@/lib/team-client.js'
import { taskInstanceKey } from '@/lib/task-view-key.js'
import { Pagination } from './Pagination.tsx'
import { SearchableSelect } from './SearchableSelect'
import { SelectField } from './SelectField.tsx'
import { branchLabel, initials, type BoardTask } from './task-view.ts'
import { Alert, AlertDescription } from '@/components/ui/alert'

type ArchiveViewProps = {
  tasks: BoardTask[]
  projects: { id: string; name: string; teamId?: string | null }[]
  teams: { id: string; name: string }[]
  projectId: string
  onProjectChange: (id: string) => void
  branch: string
  onBranchChange: (branch: string) => void
  teamMode: boolean
  queryRevision?: number | string | null
  onOpen: (task: BoardTask) => void
  onRefresh?: () => void
}

const PAGE_SIZE = 20

export function ArchiveView({
  tasks,
  projects,
  teams,
  projectId,
  onProjectChange,
  branch,
  onBranchChange,
  teamMode,
  queryRevision,
  onOpen,
  onRefresh,
}: ArchiveViewProps) {
  const [assignee, setAssignee] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)
  const [archiveTeamId, setArchiveTeamId] = useState('all')
  const teamOptions = useMemo(
    () => [
      { value: 'all', label: '全部团队' },
      ...teams.map((team) => ({ value: team.id, label: team.name })),
    ],
    [teams],
  )
  const availableProjects = useMemo(
    () => projects.filter((project) => archiveTeamId === 'all' || project.teamId === archiveTeamId),
    [archiveTeamId, projects],
  )
  const effectiveProjectId = resolveArchiveProjectId(projectId, projects)
  const projectOptions = useMemo(() => {
    const options = [
      { value: 'all', label: '全部项目' },
      ...availableProjects.map((project) => ({ value: project.id, label: project.name })),
    ]
    if (
      effectiveProjectId !== 'all' &&
      !options.some((option) => option.value === effectiveProjectId)
    ) {
      const current = projects.find((project) => project.id === effectiveProjectId)
      options.push({ value: effectiveProjectId, label: current?.name || effectiveProjectId })
    }
    return options
  }, [availableProjects, effectiveProjectId, projects])
  useEffect(() => {
    setPage(0)
  }, [projectId])
  const archive = useArchiveTasks({
    enabled: teamMode,
    teamId: archiveTeamId,
    projectId: effectiveProjectId,
    taskSpaceId: 'all',
    branch,
    revision: queryRevision,
  })

  const owners = useMemo(
    () => [
      ...new Set(
        (teamMode
          ? archive.assignees
          : tasks
              .filter((task) => branchMatches(task.branchName, branch))
              .map((task) => task.assignee)
        ).filter((name): name is string => Boolean(name)),
      ),
    ],
    [archive.assignees, tasks, branch, teamMode],
  )

  const rows = useMemo(() => {
    if (teamMode) return archive.tasks
    const keyword = search.trim().toLowerCase()
    const filtered = tasks
      .filter((task) => effectiveProjectId === 'all' || task.projectId === effectiveProjectId)
      .filter((task) => branchMatches(task.branchName, branch))
      .filter((task) => !assignee || task.assignee === assignee)
      .filter(
        (task) =>
          !keyword ||
          [task.title, task.assignee, task.teamName, task.projectName, task.dirName]
            .map((value) => String(value || '').toLowerCase())
            .some((value) => value.includes(keyword)),
      )
    return sortArchivedTasks(filtered)
  }, [archive.tasks, effectiveProjectId, tasks, branch, assignee, search, teamMode])

  const pageCount = teamMode ? archive.pageCount : Math.max(1, Math.ceil(rows.length / PAGE_SIZE))
  const current = teamMode ? archive.pageIndex : Math.min(page, pageCount - 1)
  const visible = teamMode ? rows : rows.slice(current * PAGE_SIZE, current * PAGE_SIZE + PAGE_SIZE)
  const total = teamMode ? archive.total : rows.length

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0">
          <h1 className="text-lg leading-6 font-semibold font-heading">
            归档后离开当前队列，只保留历史证据
          </h1>
          <p className="text-xs text-muted-foreground">
            working commit → 原子归档 → journal；历史任务只读回看。
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          onClick={() => {
            if (teamMode) archive.refresh()
            else onRefresh?.()
          }}
          disabled={teamMode && archive.loading}
        >
          刷新
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="w-64 text-xs"
          placeholder="搜索任务名或证据"
          value={teamMode ? archive.search : search}
          onChange={(event) => {
            if (teamMode) archive.setSearch(event.target.value)
            else setSearch(event.target.value)
            setPage(0)
          }}
        />
        <Input
          className="w-36 text-xs"
          aria-label="分支模糊筛选"
          value={branch}
          maxLength={200}
          placeholder="分支模糊筛选"
          onChange={(event) => {
            onBranchChange(event.target.value)
            setPage(0)
          }}
        />
        <SelectField
          ariaLabel="负责人"
          className="w-36 text-xs"
          value={(teamMode ? archive.assignee : assignee) || '__all'}
          options={archiveAssigneeOptions(owners, teamMode ? archive.assignee : assignee)}
          onChange={(next) => {
            const value = next === '__all' ? '' : next
            if (teamMode) archive.setAssignee(value)
            else setAssignee(value)
            setPage(0)
          }}
        />
        {teamMode ? (
          <>
            <SearchableSelect
              ariaLabel="团队"
              className="ml-auto w-40"
              value={archiveTeamId}
              options={teamOptions}
              onChange={(next) => {
                setArchiveTeamId(next)
                const nextProjectId = archiveProjectAfterTeamChange(
                  effectiveProjectId,
                  next,
                  projects,
                )
                if (nextProjectId !== effectiveProjectId) onProjectChange(nextProjectId)
                setPage(0)
              }}
            />
            <SearchableSelect
              ariaLabel="项目"
              className="w-52"
              value={effectiveProjectId}
              options={projectOptions}
              onChange={(next) => {
                onProjectChange(next)
                setPage(0)
              }}
            />
          </>
        ) : (
          <SearchableSelect
            ariaLabel="项目"
            className="ml-auto w-52"
            value={effectiveProjectId}
            options={projectOptions}
            onChange={(next) => {
              onProjectChange(next)
              setPage(0)
            }}
          />
        )}
      </div>

      {teamMode && archive.error ? (
        <Alert variant="destructive">
          <AlertDescription>{archive.error}</AlertDescription>
        </Alert>
      ) : null}

      <div
        className="min-h-0 flex-1 overflow-hidden rounded-xl border border-border bg-card"
        aria-busy={teamMode && archive.loading}
      >
        <ScrollArea className="h-full">
          <table className="w-full border-collapse text-left">
            <thead className="sticky top-0 bg-muted text-2xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-semibold">任务</th>
                <th className="px-3 py-2 font-semibold">负责人</th>
                <th className="px-3 py-2 font-semibold">完成证据</th>
                <th className="px-3 py-2 text-right font-semibold">归档时间</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {teamMode && archive.loading && visible.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-3 py-10 text-center text-xs text-muted-foreground">
                    正在加载归档任务
                  </td>
                </tr>
              ) : visible.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-3 py-10 text-center text-xs text-muted-foreground">
                    没有符合条件的归档任务
                  </td>
                </tr>
              ) : (
                visible.map((task) => {
                  const evidence = task.stages
                    .filter((stage) => stage.complete)
                    .map((stage) => stage.label)
                    .slice(0, 2)
                  const projectLabel = [task.teamName, task.projectName, branchLabel(task)]
                    .filter(Boolean)
                    .join(' · ')
                  return (
                    <tr
                      key={taskInstanceKey(task)}
                      className="cursor-pointer border-b border-border/60 text-xs hover:bg-muted/40"
                      onClick={() => onOpen(task)}
                    >
                      <td className="px-3 py-2.5">
                        <span className="block font-medium">{task.title}</span>
                        <small className="text-2xs text-muted-foreground">
                          #{task.dirName} · {projectLabel} · 已归档
                        </small>
                      </td>
                      <td className="px-3 py-2.5">
                        <span className="flex items-center gap-1.5">
                          <span className="flex size-4 items-center justify-center rounded-full bg-secondary text-2xs font-semibold">
                            {initials(task.assignee)}
                          </span>
                          {task.assignee || '未派发'}
                        </span>
                      </td>
                      <td className="px-3 py-2.5">
                        {evidence.length ? (
                          <span className="flex flex-wrap gap-1">
                            {evidence.map((label) => (
                              <span
                                key={label}
                                className="rounded-sm border border-border px-1.5 py-px text-2xs text-muted-foreground"
                              >
                                {label}
                              </span>
                            ))}
                          </span>
                        ) : (
                          <span className="text-2xs text-muted-foreground">无完成证据</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-right text-2xs text-muted-foreground">
                        {formatArchiveTimestamp(task)}
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <button
                          type="button"
                          aria-label={`打开归档任务 ${task.title}`}
                          onClick={(event) => {
                            event.stopPropagation()
                            onOpen(task)
                          }}
                          className="text-muted-foreground hover:text-foreground"
                        >
                          <ChevronRight className="size-3.5" />
                        </button>
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </ScrollArea>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">
          显示 {visible.length ? current * PAGE_SIZE + 1 : 0}-{current * PAGE_SIZE + visible.length}{' '}
          / 共 {total} 条
        </span>
        <div className="ml-auto">
          <Pagination
            page={current}
            pageCount={pageCount}
            onChange={(next) => {
              if (!teamMode) {
                setPage(next)
              } else if (next > current) {
                archive.next()
              } else if (next < current) {
                archive.previous()
              }
            }}
            numbered={!teamMode}
            hasNext={teamMode ? archive.hasNext : undefined}
          />
        </div>
      </div>
    </div>
  )
}
