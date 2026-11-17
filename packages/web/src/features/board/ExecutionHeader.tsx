import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
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

const BLOCKED_OPTIONS = [
  { id: 'any', name: '不限' },
  { id: 'blocked', name: '仅被阻断' },
  { id: 'unblocked', name: '阻断已解除' },
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
          <div className="flex items-center gap-0.5 rounded-lg bg-muted p-0.5">
            {[
              { id: 'all', label: '全部进行中' },
              { id: 'mine', label: '只看我的' },
            ].map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => onChange({ scope: item.id === 'mine' ? 'mine' : 'all' })}
                className={
                  (item.id === 'mine') === (filters.scope === 'mine')
                    ? 'rounded-md bg-card px-2.5 py-1 text-xs font-semibold'
                    : 'rounded-md px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground'
                }
              >
                {item.label}
              </button>
            ))}
          </div>
          <Button variant="outline" size="sm" onClick={onSaveView}>
            保存组合视图
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {savedViews.map((view) => (
          <span
            key={view.id}
            className={
              filters.executionView === view.id
                ? 'flex items-center gap-1 rounded-full bg-primary px-2.5 py-1 text-xs font-semibold text-primary-foreground'
                : 'flex items-center gap-1 rounded-full border border-border bg-card px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground'
            }
          >
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
            className={
              filters.executionView === view.id
                ? 'rounded-full bg-primary px-2.5 py-1 text-xs font-semibold text-primary-foreground'
                : 'rounded-full border border-border bg-card px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground'
            }
          >
            {view.name}
          </button>
        ))}
        <span className="ml-auto text-xs text-muted-foreground">
          {currentViewLabel} · {today}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <FilterField
          label="项目"
          value={filters.projectId}
          options={[
            { id: 'all', name: '全部授权项目' },
            ...projects.map((p) => ({ id: p.id, name: p.name })),
          ]}
          onChange={(value) => onChange({ projectId: value })}
        />
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
        <FilterField
          label="负责人"
          value={filters.assignee || '__all'}
          options={[
            { id: '__all', name: '全部负责人' },
            ...assignees.map((name) => ({ id: name, name })),
          ]}
          onChange={(value) => onChange({ assignee: value === '__all' ? '' : value })}
        />
        <FilterField
          label="优先级"
          value={filters.priority || '__all'}
          options={[
            { id: '__all', name: '全部优先级' },
            ...PRIORITIES.map((p) => ({ id: p, name: p })),
          ]}
          onChange={(value) => onChange({ priority: value === '__all' ? '' : value })}
        />
        <FilterField
          label="阶段"
          value={filters.stage || '__all'}
          options={[
            { id: '__all', name: '全部阶段' },
            ...stages.map((stage) => ({ id: stage.id, name: stage.label })),
          ]}
          onChange={(value) => onChange({ stage: value === '__all' ? '' : value })}
        />
        <FilterField
          label="阻断"
          value={filters.blocked}
          options={BLOCKED_OPTIONS}
          onChange={(value) => onChange({ blocked: value as BoardFilters['blocked'] })}
        />
      </div>
    </div>
  )
}

type FilterFieldProps = {
  label: string
  value: string
  options: { id: string; name: string }[]
  onChange: (value: string) => void
}

function FilterField({ label, value, options, onChange }: FilterFieldProps) {
  const current = options.find((option) => option.id === value) || options[0]
  return (
    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
      {label}
      <Select value={current.id} onValueChange={(next) => onChange(String(next ?? ''))}>
        <SelectTrigger className="min-w-28 gap-1.5 rounded-md text-xs">
          <span data-slot="select-value" className="flex flex-1 items-center gap-1.5 text-left">
            {current.name}
          </span>
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.id} value={option.id}>
              {option.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  )
}
