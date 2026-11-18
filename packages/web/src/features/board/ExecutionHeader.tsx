import { Input } from '@/components/ui/input'
import { SelectField } from '@/features/board/SelectField'
import { badgeVariants } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import { BUILTIN_VIEWS } from '@/lib/execution-filter.js'
import type { BoardFilters } from '@/hooks/useBoard'

type ExecutionHeaderProps = {
  filters: BoardFilters
  onChange: (patch: Partial<BoardFilters>) => void
  projects: { id: string; name: string }[]
  stages: { id: string; label: string }[]
  assignees: string[]
  total: number
  savedViews: { id: string; name: string }[]
  onSaveView: () => void
  onDeleteView: (id: string) => void
}

const PRIORITIES = ['P0', 'P1', 'P2', 'P3']

function viewPill(active: boolean) {
  return cn(
    badgeVariants({ variant: active ? 'default' : 'outline' }),
    'h-auto gap-1 px-2.5 py-1 text-xs',
    active ? 'font-semibold' : 'bg-card text-muted-foreground hover:text-foreground',
  )
}

const BLOCKED_OPTIONS = [
  { value: 'any', label: '不限' },
  { value: 'blocked', label: '仅被阻断' },
  { value: 'unblocked', label: '阻断已解除' },
]

export function ExecutionHeader({
  filters,
  onChange,
  projects,
  stages,
  assignees,
  total,
  savedViews,
  onSaveView,
  onDeleteView,
}: ExecutionHeaderProps) {
  const currentViewLabel =
    savedViews.find((view) => view.id === filters.executionView)?.name ??
    BUILTIN_VIEWS.find((view) => view.id === filters.executionView)?.name ??
    '全部进行中'
  const today = new Date().toISOString().slice(0, 10)

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0">
          <p className="text-2xs font-semibold tracking-[0.08em] text-muted-foreground">
            PERSONAL / CURRENT REPOSITORY
          </p>
          <h1 className="text-lg leading-6 font-semibold font-heading">把每个任务放回流程里</h1>
          <p className="text-xs text-muted-foreground">
            全部授权项目 · 13 阶段证据 · {total} 个进行中任务
          </p>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Tabs
            value={filters.scope === 'mine' ? 'mine' : 'all'}
            onValueChange={(value) => onChange({ scope: value === 'mine' ? 'mine' : 'all' })}
          >
            <TabsList aria-label="任务范围">
              <TabsTrigger value="all">全部进行中</TabsTrigger>
              <TabsTrigger value="mine">只看我的</TabsTrigger>
            </TabsList>
          </Tabs>
          <Button variant="outline" onClick={onSaveView}>
            保存组合视图
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {savedViews.map((view) => (
          <span key={view.id} className={viewPill(filters.executionView === view.id)}>
            <button type="button" onClick={() => onChange({ executionView: view.id })}>
              {view.name}
            </button>
            <button
              type="button"
              aria-label={`删除组合视图 ${view.name}`}
              className="opacity-70 hover:opacity-100"
              onClick={() => onDeleteView(view.id)}
            >
              ×
            </button>
          </span>
        ))}
        {BUILTIN_VIEWS.map((view) => (
          <button
            key={view.id}
            type="button"
            onClick={() => onChange({ executionView: view.id })}
            className={viewPill(filters.executionView === view.id)}
          >
            {view.name}
          </button>
        ))}
        <span className="ml-auto text-xs text-muted-foreground">
          {currentViewLabel} · {today}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          项目
          <SelectField
            ariaLabel="项目"
            className="w-auto min-w-28"
            value={filters.projectId}
            options={[
              { value: 'all', label: '全部授权项目' },
              ...projects.map((p) => ({ value: p.id, label: p.name })),
            ]}
            onChange={(value) => onChange({ projectId: value })}
          />
        </label>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          分支
          <Input
            className="w-32 text-xs"
            value={filters.branch}
            maxLength={200}
            placeholder="模糊匹配"
            onChange={(event) => onChange({ branch: event.target.value })}
          />
        </label>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          负责人
          <SelectField
            ariaLabel="负责人"
            className="w-auto min-w-28"
            value={filters.assignee || '__all'}
            options={[
              { value: '__all', label: '全部负责人' },
              ...assignees.map((name) => ({ value: name, label: name })),
            ]}
            onChange={(value) => onChange({ assignee: value === '__all' ? '' : value })}
          />
        </label>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          优先级
          <SelectField
            ariaLabel="优先级"
            className="w-auto min-w-28"
            value={filters.priority || '__all'}
            options={[
              { value: '__all', label: '全部优先级' },
              ...PRIORITIES.map((p) => ({ value: p, label: p })),
            ]}
            onChange={(value) => onChange({ priority: value === '__all' ? '' : value })}
          />
        </label>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          阶段
          <SelectField
            ariaLabel="阶段"
            className="w-auto min-w-28"
            value={filters.stage || '__all'}
            options={[
              { value: '__all', label: '全部阶段' },
              ...stages.map((stage) => ({ value: stage.id, label: stage.label })),
            ]}
            onChange={(value) => onChange({ stage: value === '__all' ? '' : value })}
          />
        </label>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          阻断
          <SelectField
            ariaLabel="阻断"
            className="w-auto min-w-28"
            value={filters.blocked}
            options={BLOCKED_OPTIONS}
            onChange={(value) => onChange({ blocked: value as BoardFilters['blocked'] })}
          />
        </label>
      </div>
    </div>
  )
}
