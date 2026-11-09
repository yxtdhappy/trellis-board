import { KeyRound, LogOut, Moon, Plus, Search, Settings2, Sun } from 'lucide-react'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { useTheme } from '@/app/theme'
import { TrellisLogo } from '@/components/layout/TrellisLogo'
import { initials } from '@/features/board/task-view'
import { TeamSwitcher } from '@/features/admin/TeamSwitcher'

export type BoardNavItem = { id: string; label: string }
type TeamOption = { id: string; name: string }

type TopBarProps = {
  nav: BoardNavItem[]
  activeNav: string
  onNavigate: (id: string) => void
  search: string
  onSearch: (value: string) => void
  onCreate: () => void
  displayName: string
  teams: TeamOption[]
  teamId: string
  onTeamChange: (teamId: string) => void
  onOpenAssignments: () => void
  onOpenPassword: () => void
  onLogout: () => void
  adminHref?: string
}

export function TopBar({
  nav,
  activeNav,
  onNavigate,
  search,
  onSearch,
  onCreate,
  displayName,
  teams,
  teamId,
  onTeamChange,
  onOpenAssignments,
  onOpenPassword,
  onLogout,
  adminHref,
}: TopBarProps) {
  const { theme, toggleTheme } = useTheme()

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-card px-4">
      <a className="flex items-center gap-2" href="/" aria-label="Trellis Board 首页">
        <TrellisLogo size={24} />
        <span className="text-sm font-semibold">Trellis Board</span>
      </a>

      <nav className="ml-3 flex items-center gap-0.5" aria-label="看板视图">
        {nav.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => onNavigate(item.id)}
            className={
              item.id === activeNav
                ? 'rounded-lg bg-secondary px-2.5 py-1.5 text-[12.5px] font-semibold text-foreground'
                : 'rounded-lg px-2.5 py-1.5 text-[12.5px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground'
            }
            aria-current={item.id === activeNav ? 'page' : undefined}
          >
            {item.label}
          </button>
        ))}
      </nav>

      <div className="ml-auto flex items-center gap-2">
        {teams.length > 1 ? (
          <TeamSwitcher teams={teams} value={teamId} includeAll onChange={onTeamChange} />
        ) : null}
        <div className="relative hidden md:block">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="h-8 w-[230px] pl-8 text-xs"
            placeholder="搜索任务、负责人"
            value={search}
            onChange={(event) => onSearch(event.target.value)}
            aria-label="搜索任务"
          />
        </div>
        <Button size="sm" className="h-8 gap-1.5 px-3 text-xs" onClick={onCreate}>
          <Plus className="size-3.5" />
          创建任务
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <Avatar className="size-7">
              <AvatarFallback className="bg-secondary text-[10px] font-semibold text-muted-foreground">
                {initials(displayName)}
              </AvatarFallback>
            </Avatar>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <div className="px-2 py-1.5 text-xs text-muted-foreground">
              {displayName || '未登录'}
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onOpenAssignments}>
              <Settings2 className="size-3.5" />
              待我接受
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onOpenPassword}>
              <KeyRound className="size-3.5" />
              修改密码
            </DropdownMenuItem>
            {adminHref ? (
              <DropdownMenuItem onSelect={() => window.location.assign(adminHref)}>
                <Settings2 className="size-3.5" />
                团队管理
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onLogout} variant="destructive">
              <LogOut className="size-3.5" />
              退出
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          onClick={toggleTheme}
          aria-label={theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'}
          title={theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'}
        >
          {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
        </Button>
      </div>
    </header>
  )
}
