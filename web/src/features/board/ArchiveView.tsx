import { useMemo, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { formatArchiveTimestamp, sortArchivedTasks } from '@/lib/archive-sort.js'
import { Pagination } from './Pagination'
import { SelectField } from './SelectField'
import { initials, type BoardTask } from './task-view'

type ArchiveViewProps = {
  tasks: BoardTask[]
  projects: { id: string; name: string }[]
  onOpen: (task: BoardTask) => void
  onRefresh?: () => void
}

const PAGE_SIZE = 20

export function ArchiveView({ tasks, projects, onOpen, onRefresh }: ArchiveViewProps) {
  const [project, setProject] = useState('all')
  const [assignee, setAssignee] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)

  const owners = useMemo(
    () => [...new Set(tasks.map((task) => task.assignee).filter((name): name is string => Boolean(name)))],
    [tasks],
  )

  const rows = useMemo(() => {
    const keyword = search.trim().toLowerCase()
    const filtered = tasks
      .filter((task) => project === 'all' || task.projectId === project)
      .filter((task) => !assignee || task.assignee === assignee)
      .filter(
        (task) =>
          !keyword ||
          [task.title, task.assignee, task.projectName, task.dirName]
            .map((value) => String(value || '').toLowerCase())
            .some((value) => value.includes(keyword)),
      )
    return sortArchivedTasks(filtered).slice(0, 80)
  }, [tasks, project, assignee, search])

  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE))
  const current = Math.min(page, pageCount - 1)
  const visible = rows.slice(current * PAGE_SIZE, current * PAGE_SIZE + PAGE_SIZE)
  const projectName = project === 'all' ? '全部项目' : (projects.find((item) => item.id === project)?.name ?? '全部项目')

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0">
          <h1 className="text-[19px] leading-6 font-semibold font-heading">归档后离开当前队列，只保留历史证据</h1>
          <p className="text-[11.5px] text-muted-foreground">
            working commit → 原子归档 → journal；历史任务只读回看。
          </p>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          className="ml-auto h-7 rounded-md px-2 text-[11.5px] text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          刷新
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="h-8 w-64 text-xs"
          placeholder="搜索任务名或证据"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value)
            setPage(0)
          }}
        />
        <SelectField
          ariaLabel="项目"
          className="h-8 w-36 text-[11.5px]"
          value={project}
          options={[{ value: 'all', label: '全部项目' }, ...projects.map((item) => ({ value: item.id, label: item.name }))]}
          onChange={(next) => {
            setProject(next)
            setPage(0)
          }}
        />
        <SelectField
          ariaLabel="负责人"
          className="h-8 w-36 text-[11.5px]"
          value={assignee || '__all'}
          options={[{ value: '__all', label: '全部负责人' }, ...owners.map((name) => ({ value: name, label: name }))]}
          onChange={(next) => {
            setAssignee(next === '__all' ? '' : next)
            setPage(0)
          }}
        />
        <span className="ml-auto text-[11px] text-muted-foreground">{projectName}</span>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-border bg-card">
        <ScrollArea className="h-full">
          <table className="w-full border-collapse text-left">
            <thead className="sticky top-0 bg-muted text-[10.5px] text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-semibold">任务</th>
                <th className="px-3 py-2 font-semibold">负责人</th>
                <th className="px-3 py-2 font-semibold">完成证据</th>
                <th className="px-3 py-2 text-right font-semibold">归档时间</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-3 py-10 text-center text-[11.5px] text-muted-foreground">
                    没有符合条件的归档任务
                  </td>
                </tr>
              ) : (
                visible.map((task) => {
                  const evidence = task.stages
                    .filter((stage) => stage.complete)
                    .map((stage) => stage.label)
                    .slice(0, 2)
                  return (
                    <tr
                      key={task.taskKey}
                      className="cursor-pointer border-b border-border/60 text-[11.5px] hover:bg-muted/40"
                      onClick={() => onOpen(task)}
                    >
                      <td className="px-3 py-2.5">
                        <span className="block font-medium">{task.title}</span>
                        <small className="text-[10px] text-muted-foreground">
                          #{task.dirName} · 已归档
                        </small>
                      </td>
                      <td className="px-3 py-2.5">
                        <span className="flex items-center gap-1.5">
                          <span className="flex size-4 items-center justify-center rounded-full bg-secondary text-[8px] font-semibold">
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
                                className="rounded-sm border border-border px-1.5 py-px text-[10px] text-muted-foreground"
                              >
                                {label}
                              </span>
                            ))}
                          </span>
                        ) : (
                          <span className="text-[10.5px] text-muted-foreground">无完成证据</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-right text-[10.5px] text-muted-foreground">
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
        <span className="text-[11px] text-muted-foreground">
          显示 {visible.length ? current * PAGE_SIZE + 1 : 0}-{current * PAGE_SIZE + visible.length} / 共 {rows.length} 条
        </span>
        <div className="ml-auto">
          <Pagination page={current} pageCount={pageCount} onChange={setPage} />
        </div>
      </div>
    </div>
  )
}
