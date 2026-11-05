import { useMemo, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { formatArchiveTimestamp, sortArchivedTasks } from '@/lib/archive-sort.js'
import { dueLabel, initials, type BoardTask } from './task-view'

type ArchiveViewProps = {
  tasks: BoardTask[]
  projects: { id: string; name: string }[]
  onOpen: (task: BoardTask) => void
}

const PAGE_SIZE = 20

export function ArchiveView({ tasks, projects, onOpen }: ArchiveViewProps) {
  const [project, setProject] = useState('all')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)

  const rows = useMemo(() => {
    const keyword = search.trim().toLowerCase()
    const filtered = tasks
      .filter((task) => project === 'all' || task.projectId === project)
      .filter(
        (task) =>
          !keyword ||
          [task.title, task.assignee, task.projectName, task.dirName]
            .map((value) => String(value || '').toLowerCase())
            .some((value) => value.includes(keyword)),
      )
    return sortArchivedTasks(filtered).slice(0, 80)
  }, [tasks, project, search])

  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE))
  const current = Math.min(page, pageCount - 1)
  const visible = rows.slice(current * PAGE_SIZE, current * PAGE_SIZE + PAGE_SIZE)

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-[19px] leading-6 font-semibold font-heading">归档索引</h1>
        <p className="text-[11.5px] text-muted-foreground">归档后离开当前队列，只保留历史证据 · 最多展示 80 条</p>
        <div className="ml-auto flex items-center gap-2">
          <select
            className="h-8 rounded-lg bg-card px-2 text-[11px]"
            value={project}
            onChange={(event) => {
              setProject(event.target.value)
              setPage(0)
            }}
            aria-label="归档项目"
          >
            <option value="all">全部项目</option>
            {projects.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
          <Input
            className="h-8 w-60 text-xs"
            placeholder="搜索任务名或证据"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value)
              setPage(0)
            }}
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto rounded-xl bg-card">
        <table className="w-full border-collapse text-left">
          <thead className="sticky top-0 bg-muted text-[11px] text-muted-foreground">
            <tr>
              <th className="px-4 py-2.5 font-semibold">任务</th>
              <th className="px-3 py-2.5 font-semibold">负责人</th>
              <th className="px-3 py-2.5 font-semibold">完成证据</th>
              <th className="px-3 py-2.5 font-semibold">归档时间</th>
              <th className="px-3 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center text-[11.5px] text-muted-foreground">
                  没有符合条件的归档任务
                </td>
              </tr>
            ) : (
              visible.map((task) => (
                <tr key={task.taskKey} className="border-b border-border/60 text-[11.5px] hover:bg-muted/40">
                  <td className="px-4 py-2.5">
                    <button type="button" className="text-left" onClick={() => onOpen(task)}>
                      <span className="block font-medium">{task.title}</span>
                      <small className="text-[10px] text-muted-foreground">
                        {task.projectName} · {dueLabel(task.execution?.dueDate)}
                      </small>
                    </button>
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
                    <span className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      {task.stages.filter((stage) => stage.complete).length}/13 阶段证据
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-[10.5px] text-muted-foreground">
                    {formatArchiveTimestamp(task)}
                  </td>
                  <td className="px-3 py-2.5 text-right text-[10px] text-muted-foreground">›</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <span>
          显示 {visible.length ? current * PAGE_SIZE + 1 : 0}-{current * PAGE_SIZE + visible.length} / 共 {rows.length} 条
        </span>
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-[11px]"
            onClick={() => setPage((value) => Math.max(0, value - 1))}
            disabled={current === 0}
          >
            上一页
          </Button>
          <span>
            第 {current + 1} / {pageCount} 页
          </span>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-[11px]"
            onClick={() => setPage((value) => Math.min(pageCount - 1, value + 1))}
            disabled={current >= pageCount - 1}
          >
            下一页
          </Button>
        </div>
      </div>
    </div>
  )
}
