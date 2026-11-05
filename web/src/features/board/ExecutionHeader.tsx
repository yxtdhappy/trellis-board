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
  onApply: () => void
  loading: boolean
  savedViews: { id: string; name: string }[]
  onSaveView: () => void
  onDeleteView: (id: string) => void
}

export function ExecutionHeader({
  filters,
  onChange,
  projects,
  stages,
  assignees,
  total,
  onApply,
  loading,
  savedViews,
  onSaveView,
  onDeleteView,
}: ExecutionHeaderProps) {
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0">
          <h1 className="text-[19px] leading-6 font-semibold font-heading">任务流程视图</h1>
          <p className="text-[11.5px] text-muted-foreground">
            把每个任务放回流程里 · {total} 个进行中任务 · 13 阶段证据
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
                    ? 'rounded-md bg-card px-2.5 py-1 text-[11.5px] font-semibold'
                    : 'rounded-md px-2.5 py-1 text-[11.5px] text-muted-foreground hover:text-foreground'
                }
              >
                {item.label}
              </button>
            ))}
          </div>
          <Button variant="outline" size="sm" className="h-8 text-xs" onClick={onSaveView}>
            保存组合视图
          </Button>
          <Button variant="outline" size="sm" className="h-8 text-xs" onClick={onApply} disabled={loading}>
            应用筛选
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {savedViews.map((view) => (
          <span
            key={view.id}
            className={
              filters.executionView === view.id
                ? 'flex items-center gap-1 rounded-full bg-primary px-2.5 py-1 text-[11px] font-semibold text-primary-foreground'
                : 'flex items-center gap-1 rounded-full border border-border bg-card px-2.5 py-1 text-[11px] text-muted-foreground hover:text-foreground'
            }
          >
            <button type="button" onClick={() => onChange({ executionView: view.id })}>
              {view.name}
            </button>
            <button
              type="button"
              aria-label={`删除组合视图 ${view.name}`}
              className="text-[10px] opacity-70 hover:opacity-100"
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
            title={view.hint}
            className={
              filters.executionView === view.id
                ? 'rounded-full bg-primary px-2.5 py-1 text-[11px] font-semibold text-primary-foreground'
                : 'rounded-full border border-border bg-card px-2.5 py-1 text-[11px] text-muted-foreground hover:text-foreground'
            }
          >
            {view.label}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <FilterSelect
          label="项目"
          value={filters.projectId}
          options={[{ id: 'all', name: '全部授权项目' }, ...projects.map((p) => ({ id: p.id, name: p.name }))]}
          onChange={(value) => onChange({ projectId: value })}
        />
        <FilterSelect
          label="负责人"
          value={filters.assignee}
          options={[{ id: '', name: '全部负责人' }, ...assignees.map((name) => ({ id: name, name }))]}
          onChange={(value) => onChange({ assignee: value })}
        />
        <FilterSelect
          label="阶段"
          value={filters.stage}
          options={[{ id: '', name: '全部阶段' }, ...stages.map((stage) => ({ id: stage.id, name: stage.label }))]}
          onChange={(value) => onChange({ stage: value })}
        />
        <FilterSelect
          label="阻断"
          value={filters.blocked}
          options={[
            { id: 'any', name: '不限' },
            { id: 'blocked', name: '仅被阻断' },
            { id: 'unblocked', name: '阻断已解除' },
          ]}
          onChange={(value) => onChange({ blocked: value as BoardFilters['blocked'] })}
        />
      </div>
    </div>
  )
}

type FilterSelectProps = {
  label: string
  value: string
  options: { id: string; name: string }[]
  onChange: (value: string) => void
  hideLabel?: boolean
}

function FilterSelect({ label, value, options, onChange, hideLabel }: FilterSelectProps) {
  return (
    <label className="flex items-center gap-1.5 rounded-lg bg-card px-2.5 py-1.5 text-[11px]">
      {hideLabel ? null : <span className="text-muted-foreground">{label}</span>}
      <select
        className="bg-transparent text-[11px] font-medium outline-none"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.id || option.name} value={option.id}>
            {option.name}
          </option>
        ))}
      </select>
    </label>
  )
}
