import { useMemo, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { useArchiveTasks } from '@/hooks/useArchiveTasks'
import { formatArchiveTimestamp } from '@/lib/archive-sort.js'
import { archiveProjectAfterTeamChange, resolveArchiveProjectId } from '@/lib/archive-filter.js'
import { archiveAssigneeOptions } from '@/lib/team-client.js'
import { taskInstanceKey } from '@/lib/task-view-key.js'
import { Pagination } from './Pagination.tsx'
import { SearchableSelect } from './SearchableSelect'
import { SelectField } from './SelectField.tsx'
import { branchLabel, initials, type BoardTask } from './task-view.ts'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Panel } from '@/components/ui/panel'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

type ArchiveViewProps = {
  projects: { id: string; name: string; teamId?: string | null }[]
  teams: { id: string; name: string }[]
  projectId: string
  onProjectChange: (id: string) => void
  branch: string
  onBranchChange: (branch: string) => void
  queryRevision?: number | string | null
  onOpen: (task: BoardTask) => void
}

const PAGE_SIZE = 20

export function ArchiveView({
  projects,
  teams,
  projectId,
  onProjectChange,
  branch,
  onBranchChange,
  queryRevision,
  onOpen,
}: ArchiveViewProps) {
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
  const archive = useArchiveTasks({
    enabled: true,
    teamId: archiveTeamId,
    projectId: effectiveProjectId,
    taskSpaceId: 'all',
    branch,
    revision: queryRevision,
  })

  const owners = useMemo(
    () => [...new Set(archive.assignees.filter((name): name is string => Boolean(name)))],
    [archive.assignees],
  )

  const pageCount = archive.pageCount
  const current = archive.pageIndex
  const visible = archive.tasks
  const total = archive.total

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
          variant="outline"
          className="ml-auto"
          onClick={() => archive.refresh()}
          disabled={archive.loading}
        >
          刷新
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="w-64 text-xs"
          placeholder="搜索任务名或证据"
          value={archive.search}
          onChange={(event) => archive.setSearch(event.target.value)}
        />
        <Input
          className="w-36 text-xs"
          aria-label="分支模糊筛选"
          value={branch}
          maxLength={200}
          placeholder="分支模糊筛选"
          onChange={(event) => onBranchChange(event.target.value)}
        />
        <SelectField
          ariaLabel="负责人"
          className="w-36 text-xs"
          value={archive.assignee || '__all'}
          options={archiveAssigneeOptions(owners, archive.assignee)}
          onChange={(next) => archive.setAssignee(next === '__all' ? '' : next)}
        />
        <SearchableSelect
          ariaLabel="团队"
          className="w-40 xl:ml-auto"
          value={archiveTeamId}
          options={teamOptions}
          onChange={(next) => {
            setArchiveTeamId(next)
            const nextProjectId = archiveProjectAfterTeamChange(effectiveProjectId, next, projects)
            if (nextProjectId !== effectiveProjectId) onProjectChange(nextProjectId)
          }}
        />
        <SearchableSelect
          ariaLabel="项目"
          className="w-52"
          value={effectiveProjectId}
          options={projectOptions}
          onChange={onProjectChange}
        />
      </div>

      {archive.error ? (
        <Alert variant="destructive">
          <AlertDescription>{archive.error}</AlertDescription>
        </Alert>
      ) : null}

      <Panel
        as="div"
        className="min-h-0 flex-1 overflow-hidden border border-border p-0"
        aria-busy={archive.loading}
      >
        <Table containerClassName="h-full overflow-y-auto" className="border-collapse text-left">
          <TableHeader className="sticky top-0 z-10 bg-muted text-2xs text-muted-foreground">
            <TableRow className="border-0 hover:bg-transparent">
              <TableHead className="h-auto text-inherit px-3 py-2 font-semibold">任务</TableHead>
              <TableHead className="h-auto text-inherit px-3 py-2 font-semibold">负责人</TableHead>
              <TableHead className="h-auto text-inherit px-3 py-2 font-semibold">
                完成证据
              </TableHead>
              <TableHead className="h-auto text-inherit px-3 py-2 text-right font-semibold whitespace-nowrap">
                归档时间
              </TableHead>
              <TableHead className="h-auto text-inherit px-3 py-2" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {archive.loading && visible.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="px-3 py-10 text-center text-xs text-muted-foreground"
                >
                  正在加载归档任务
                </TableCell>
              </TableRow>
            ) : visible.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="px-3 py-10 text-center text-xs text-muted-foreground"
                >
                  没有符合条件的归档任务
                </TableCell>
              </TableRow>
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
                  <TableRow
                    key={taskInstanceKey(task)}
                    className="cursor-pointer border-b border-border/60 text-xs hover:bg-muted/40"
                    onClick={() => onOpen(task)}
                  >
                    <TableCell className="whitespace-normal break-words px-3 py-2.5">
                      <span className="block break-words font-medium">{task.title}</span>
                      <small className="block break-all text-2xs text-muted-foreground">
                        #{task.dirName} · {projectLabel} · 已归档
                      </small>
                    </TableCell>
                    <TableCell className="whitespace-normal break-words px-3 py-2.5">
                      <span className="flex items-center gap-1.5">
                        <Avatar className="size-4 shrink-0 after:hidden">
                          <AvatarFallback className="bg-secondary text-2xs font-semibold">
                            {initials(task.assignee)}
                          </AvatarFallback>
                        </Avatar>
                        <span className="break-words">{task.assignee || '未派发'}</span>
                      </span>
                    </TableCell>
                    <TableCell className="whitespace-normal px-3 py-2.5">
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
                    </TableCell>
                    <TableCell className="whitespace-nowrap px-3 py-2.5 text-right text-2xs tabular-nums text-muted-foreground">
                      {formatArchiveTimestamp(task)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap px-3 py-2.5 text-right">
                      <button
                        type="button"
                        aria-label={`打开归档任务 ${task.title}`}
                        onClick={(event) => {
                          event.stopPropagation()
                          onOpen(task)
                        }}
                        className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                      >
                        <ChevronRight className="size-3.5" />
                      </button>
                    </TableCell>
                  </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>
      </Panel>

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
              if (next > current) archive.next()
              else if (next < current) archive.previous()
            }}
            numbered={false}
            hasNext={archive.hasNext}
          />
        </div>
      </div>
    </div>
  )
}
