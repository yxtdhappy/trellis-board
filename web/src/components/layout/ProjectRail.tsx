import { Plus, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'

type ProjectRailProps = {
  projects: { id: string; name: string }[]
  current: string
  onSelect: (id: string) => void
  onManage: () => void
  syncLabel: string
  syncLive: boolean
  refreshing: boolean
  onRefresh: () => void
}

export function ProjectRail({
  projects,
  current,
  onSelect,
  onManage,
  syncLabel,
  syncLive,
  refreshing,
  onRefresh,
}: ProjectRailProps) {
  return (
    <aside className="hidden w-[230px] shrink-0 flex-col gap-1 border-r border-border bg-sidebar px-2.5 py-3.5 lg:flex">
      <p className="px-2 pb-1 text-[10px] font-semibold tracking-[0.12em] text-muted-foreground">项目</p>
      <button
        type="button"
        onClick={() => onSelect('all')}
        className={
          current === 'all'
            ? 'flex h-7.5 items-center gap-2 rounded-lg bg-sidebar-accent px-2 text-left text-xs font-semibold text-sidebar-accent-foreground'
            : 'flex h-7.5 items-center gap-2 rounded-lg px-2 text-left text-xs font-medium text-foreground hover:bg-sidebar-accent/60'
        }
      >
        <span className="size-1.5 rounded-full bg-primary" aria-hidden="true" />
        全部项目
      </button>
      {projects.map((project) => (
        <button
          key={project.id}
          type="button"
          onClick={() => onSelect(project.id)}
          className={
            current === project.id
              ? 'flex h-7.5 items-center gap-2 rounded-lg bg-sidebar-accent px-2 text-left text-xs font-semibold text-sidebar-accent-foreground'
              : 'flex h-7.5 items-center gap-2 rounded-lg px-2 text-left text-xs font-medium text-foreground hover:bg-sidebar-accent/60'
          }
          title={project.name}
        >
          <span className="size-1.5 rounded-full bg-chart-3" aria-hidden="true" />
          <span className="truncate">{project.name}</span>
        </button>
      ))}

      <button
        type="button"
        onClick={onManage}
        className="mt-2 flex h-7 items-center gap-1.5 rounded-lg px-2 text-left text-xs text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground"
      >
        <Plus className="size-3.5" />
        管理
      </button>

      <div className="mt-auto flex flex-col gap-2 rounded-xl bg-card p-2.5">
        <div className="flex items-center gap-1.5">
          <span
            className={
              syncLive
                ? 'size-1.5 rounded-full bg-primary'
                : 'size-1.5 rounded-full bg-muted-foreground/50'
            }
            aria-hidden="true"
          />
          <span className="text-[11px] font-semibold text-foreground">同步状态</span>
        </div>
        <p className="text-[10.5px] leading-4 text-muted-foreground">{syncLabel}</p>
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 text-[11px]"
          onClick={onRefresh}
          disabled={refreshing}
        >
          <RefreshCw className={refreshing ? 'size-3 animate-spin' : 'size-3'} />
          {refreshing ? '正在扫描…' : '重新扫描仓库'}
        </Button>
      </div>
    </aside>
  )
}
