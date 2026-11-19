import { useMemo, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Separator } from '@/components/ui/separator'
import { Pagination } from './Pagination.tsx'
import { SelectField } from './SelectField.tsx'
import { branchLabel, controlTone, dueLabel, initials, type BoardTask } from './task-view.ts'
import { StatusPill } from '@/components/ui/status-pill'
import { priorityTone, stageTone, statusLabel } from './tone.ts'
import { branchMatches } from '@/lib/execution-filter.js'
import { taskInstanceKey } from '@/lib/task-view-key.js'
import type { BoardFilters } from '@/hooks/board-types.ts'
import { taskControlView } from '@/lib/team-client.js'
import { Panel } from '@/components/ui/panel'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

type TeamViewProps = {
  tasks: BoardTask[]
  projects: { id: string; name: string }[]
  stages: { id: string; label: string }[]
  filters: BoardFilters
  onChange: (patch: Partial<BoardFilters>) => void
  onRefresh: () => void
  onOpen: (task: BoardTask) => void
  loading: boolean
  summary: string
}

const PAGE_SIZE = 10
const PRIORITIES = ['P0', 'P1', 'P2', 'P3']
const BLOCKED_OPTIONS = [
  { value: 'any', label: '不限' },
  { value: 'blocked', label: '仅被阻断' },
  { value: 'unblocked', label: '阻断已解除' },
]

export function TeamView({
  tasks,
  projects,
  stages,
  filters,
  onChange,
  onRefresh,
  onOpen,
  loading,
  summary,
}: TeamViewProps) {
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)

  const scopedTasks = useMemo(() => {
    return tasks.filter(
      (task) =>
        (!filters.projectId ||
          filters.projectId === 'all' ||
          task.projectId === filters.projectId) &&
        branchMatches(task.branchName, filters.branch),
    )
  }, [tasks, filters.projectId, filters.branch])

  const owners = useMemo(() => {
    const counts = new Map<string, number>()
    for (const task of scopedTasks) {
      const owner = task.assignee || '未派发'
      counts.set(owner, (counts.get(owner) ?? 0) + 1)
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])
  }, [scopedTasks])

  const keyword = search.trim().toLowerCase()
  const rows = useMemo(() => {
    return scopedTasks.filter((task) => {
      if (
        keyword &&
        ![task.title, task.assignee, task.teamName, task.projectName, task.dirName]
          .map((value) => String(value || '').toLowerCase())
          .some((value) => value.includes(keyword))
      ) {
        return false
      }
      if (filters.assignee && task.assignee !== filters.assignee) {
        return false
      }
      if (filters.priority && filters.priority !== '__all' && task.priority !== filters.priority) {
        return false
      }
      if (filters.stage && filters.stage !== '__all') {
        const currentStage = task.stage || task.derivedStage
        if (currentStage !== filters.stage) return false
      }
      if (filters.blocked === 'blocked' && !task.execution?.isBlocked) {
        return false
      }
      if (filters.blocked === 'unblocked' && !task.execution?.isUnblockedReady) {
        return false
      }
      return true
    })
  }, [scopedTasks, keyword, filters.assignee, filters.priority, filters.stage, filters.blocked])

  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE))
  const current = Math.min(page, pageCount - 1)
  const visible = rows.slice(current * PAGE_SIZE, current * PAGE_SIZE + PAGE_SIZE)
  const maxOwnerCount = owners[0]?.[1] ?? 1

  return (
    <div className="flex min-h-0 flex-1 gap-3">
      <Panel as="aside" className="w-67 shrink-0 overflow-y-auto border border-border p-3">
        <div className="flex flex-col gap-1">
          <h2 className="text-sm font-semibold font-heading">跨项目查询</h2>
          <p className="text-2xs text-muted-foreground">筛选条件即时生效</p>
        </div>

        <Separator className="mb-2" />
        <div className="pt-2">
          <p className="text-2xs font-semibold text-muted-foreground">按负责人统计</p>
          <ul className="mt-1.5 flex flex-col gap-1.5">
            {owners.length === 0 ? (
              <li className="text-2xs text-muted-foreground">暂无任务</li>
            ) : (
              owners.map(([owner, count]) => (
                <li key={owner} className="flex items-center gap-2">
                  <Avatar className="size-5 shrink-0 after:hidden">
                    <AvatarFallback className="bg-secondary text-2xs font-semibold text-muted-foreground">
                      {initials(owner)}
                    </AvatarFallback>
                  </Avatar>
                  <span className="truncate text-xs">{owner}</span>
                  <span className="ml-auto flex w-21 shrink-0 items-center justify-end gap-1">
                    <Progress
                      value={Math.round((count / maxOwnerCount) * 100)}
                      className="w-full gap-0"
                      trackClassName="h-1.5 rounded-full bg-secondary"
                      indicatorClassName="rounded-full bg-primary"
                    />
                    <span className="w-4 shrink-0 text-right text-2xs tabular-nums text-muted-foreground">
                      {count}
                    </span>
                  </span>
                </li>
              ))
            )}
          </ul>
        </div>

        <Separator className="mb-2" />
        <div className="flex flex-col gap-1.5 pt-2">
          <SelectField
            ariaLabel="项目"
            className="text-xs"
            value={filters.projectId}
            options={[
              { value: 'all', label: '全部授权项目' },
              ...projects.map((p) => ({ value: p.id, label: p.name })),
            ]}
            onChange={(next) => onChange({ projectId: next })}
          />
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            分支
            <Input
              className="min-w-0 flex-1 text-xs"
              value={filters.branch}
              maxLength={200}
              placeholder="模糊匹配"
              onChange={(event) => {
                onChange({ branch: event.target.value })
                setPage(0)
              }}
            />
          </label>
          <SelectField
            ariaLabel="负责人"
            className="text-xs"
            value={filters.assignee || '__all'}
            options={[
              { value: '__all', label: '全部负责人' },
              ...owners.map(([owner]) => ({ value: owner, label: owner })),
            ]}
            onChange={(next) => onChange({ assignee: next === '__all' ? '' : next })}
          />
          <SelectField
            ariaLabel="优先级"
            className="text-xs"
            value={filters.priority || '__all'}
            options={[
              { value: '__all', label: '不限' },
              ...PRIORITIES.map((p) => ({ value: p, label: p })),
            ]}
            onChange={(next) => onChange({ priority: next === '__all' ? '' : next })}
          />
          <SelectField
            ariaLabel="阶段"
            className="text-xs"
            value={filters.stage || '__all'}
            options={[
              { value: '__all', label: '全部阶段' },
              ...stages.map((s) => ({ value: s.id, label: s.label })),
            ]}
            onChange={(next) => onChange({ stage: next === '__all' ? '' : next })}
          />
          <SelectField
            ariaLabel="阻断"
            className="text-xs"
            value={filters.blocked}
            options={BLOCKED_OPTIONS}
            onChange={(next) => onChange({ blocked: next as BoardFilters['blocked'] })}
          />
        </div>
      </Panel>

      <Panel className="min-h-0 flex-1 gap-2 border border-border p-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-0">
            <p className="text-2xs font-semibold tracking-[0.08em] text-muted-foreground">
              TEAM CAPACITY
            </p>
            <h1 className="text-lg leading-6 font-semibold font-heading">谁在推进，谁需要帮助</h1>
            <p className="text-xs text-muted-foreground">
              {summary || '任务按负责人归集；阶段与风险来自任务产物和人工检查点。'}
            </p>
          </div>
          <Input
            className="ml-auto w-52 text-xs"
            placeholder="搜索任务或负责人"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value)
              setPage(0)
            }}
          />
          <Button variant="outline" onClick={onRefresh}>
            刷新
          </Button>
        </div>

        {loading ? (
          <p className="px-1 py-10 text-center text-xs text-muted-foreground">正在读取团队任务…</p>
        ) : (
          <Table
            containerClassName="min-h-0 flex-1 overflow-auto"
            className="border-collapse text-left"
          >
            <TableHeader className="sticky top-0 z-10 bg-muted text-2xs text-muted-foreground">
              <TableRow className="border-0 hover:bg-transparent">
                <TableHead className="h-auto text-inherit px-3 py-2 font-semibold">任务</TableHead>
                <TableHead className="h-auto text-inherit px-3 py-2 font-semibold">
                  负责人
                </TableHead>
                <TableHead className="h-auto text-inherit px-3 py-2 font-semibold">项目</TableHead>
                <TableHead className="h-auto text-inherit px-3 py-2 font-semibold whitespace-nowrap">
                  阶段
                </TableHead>
                <TableHead className="h-auto text-inherit px-3 py-2 font-semibold whitespace-nowrap">
                  优先级
                </TableHead>
                <TableHead className="h-auto text-inherit px-3 py-2 text-right font-semibold whitespace-nowrap">
                  更新
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="px-3 py-10 text-center text-xs text-muted-foreground"
                  >
                    团队视图没有可展示的任务
                  </TableCell>
                </TableRow>
              ) : (
                visible.map((task) => {
                  const stageLabel = task.stages.find(
                    (item) => item.id === task.derivedStage,
                  )?.label
                  const projectLabel = [task.teamName, task.projectName, branchLabel(task)]
                    .filter(Boolean)
                    .join(' · ')
                  const control = taskControlView(task)
                  return (
                    <TableRow
                      key={taskInstanceKey(task)}
                      className="cursor-pointer border-b border-border/60 text-xs hover:bg-muted/40"
                      onClick={() => onOpen(task)}
                    >
                      <TableCell className="whitespace-normal px-3 py-2">
                        <span className="block font-medium">{task.title}</span>
                        <small className="text-2xs text-muted-foreground">
                          #{task.dirName} · {projectLabel}
                        </small>
                        {control.available ? (
                          <StatusPill
                            tone={controlTone(control.tone)}
                            size="xs"
                            className="mt-1 w-fit font-medium"
                            title={control.description}
                          >
                            {control.label}
                          </StatusPill>
                        ) : null}
                      </TableCell>
                      <TableCell className="whitespace-normal px-3 py-2">
                        <span className="flex items-center gap-1.5">
                          <Avatar className="size-4 after:hidden">
                            <AvatarFallback className="bg-secondary text-2xs font-semibold">
                              {initials(task.assignee)}
                            </AvatarFallback>
                          </Avatar>
                          {task.assignee || '未派发'}
                        </span>
                      </TableCell>
                      <TableCell className="whitespace-normal px-3 py-2 text-xs text-muted-foreground">
                        {projectLabel}
                      </TableCell>
                      <TableCell className="whitespace-normal px-3 py-2 whitespace-nowrap">
                        <StatusPill tone={stageTone(stageLabel)} size="xs" className="font-medium">
                          {stageLabel || statusLabel(task.stage || task.status) || '未开始'}
                        </StatusPill>
                      </TableCell>
                      <TableCell className="whitespace-normal px-3 py-2 whitespace-nowrap">
                        <StatusPill tone={priorityTone(task.priority)} size="xs">
                          {task.priority || 'P2'}
                        </StatusPill>
                      </TableCell>
                      <TableCell className="whitespace-normal px-3 py-2 text-right text-2xs whitespace-nowrap text-muted-foreground">
                        {dueLabel(task.execution?.dueDate)}
                      </TableCell>
                    </TableRow>
                  )
                })
              )}
            </TableBody>
          </Table>
        )}

        <Pagination
          page={current}
          pageCount={pageCount}
          onChange={setPage}
          label={`显示 ${visible.length ? current * PAGE_SIZE + 1 : 0}-${current * PAGE_SIZE + visible.length} / 共 ${rows.length} 条`}
        />
      </Panel>
    </div>
  )
}
