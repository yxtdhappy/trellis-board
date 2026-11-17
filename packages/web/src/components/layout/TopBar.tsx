import { useEffect, useRef, useState } from 'react'
import {
  KeyRound,
  LogOut,
  Moon,
  Plus,
  Search,
  Settings2,
  SlidersHorizontal,
  Sun,
} from 'lucide-react'
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
import { useAppearance } from '@/app/theme'
import { TrellisLogo } from '@/components/layout/TrellisLogo'
import { PreferencesDialog } from '@/features/settings/PreferencesDialog'
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
  const { resolvedTheme, setTheme } = useAppearance()
  const navRef = useRef<HTMLElement>(null)
  const [preferencesOpen, setPreferencesOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const nextTheme = resolvedTheme === 'dark' ? 'light' : 'dark'
  const themeLabel = resolvedTheme === 'dark' ? '切换到浅色主题' : '切换到深色主题'

  // 插件多到需要横向滚动时，切到视口外的面板要把它滚进来
  useEffect(() => {
    const nav = navRef.current
    const active = nav?.querySelector<HTMLElement>('[aria-current="page"]')
    if (!nav || !active) return
    const navRect = nav.getBoundingClientRect()
    const itemRect = active.getBoundingClientRect()
    if (itemRect.left < navRect.left) {
      nav.scrollBy({ left: itemRect.left - navRect.left - 8, behavior: 'smooth' })
    } else if (itemRect.right > navRect.right) {
      nav.scrollBy({ left: itemRect.right - navRect.right + 8, behavior: 'smooth' })
    }
  }, [activeNav, nav.length])

  useEffect(() => {
    if (!searchOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSearchOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [searchOpen])

  return (
    <div className="@container shrink-0">
      <header className="flex h-14 flex-wrap items-center gap-3 border-b border-border bg-card px-4 @max-[48em]:h-24 @max-[48em]:items-start @max-[48em]:gap-y-0">
        <a
          className="flex h-14 shrink-0 items-center gap-2"
          href="/"
          aria-label="Trellis Board 首页"
        >
          <TrellisLogo size={24} />
          <span className="text-sm font-semibold @max-[64em]:hidden">Trellis Board</span>
        </a>

        {searchOpen ? (
          <div className="flex min-w-0 flex-1 items-center gap-2 @max-[48em]:order-last @max-[48em]:h-10 @max-[48em]:w-full @max-[48em]:flex-none @min-[64em]:hidden">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                autoFocus
                className="w-full pl-8 text-xs"
                placeholder="搜索任务、负责人"
                value={search}
                onChange={(event) => onSearch(event.target.value)}
                aria-label="搜索任务"
              />
            </div>
            <button
              type="button"
              onClick={() => setSearchOpen(false)}
              className="shrink-0 rounded-lg px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              取消
            </button>
          </div>
        ) : (
          <nav
            ref={navRef}
            className="topbar-nav ml-3 flex h-14 min-w-0 flex-1 items-center gap-0.5 overflow-x-auto overscroll-x-contain @max-[48em]:order-last @max-[48em]:ml-0 @max-[48em]:h-10 @max-[48em]:w-full @max-[48em]:flex-none @max-[48em]:border-t @max-[48em]:border-border"
            aria-label="看板视图"
          >
            {nav.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => onNavigate(item.id)}
                className={
                  item.id === activeNav
                    ? 'shrink-0 rounded-lg bg-secondary px-2.5 py-1.5 text-[0.78125rem] font-semibold whitespace-nowrap text-foreground'
                    : 'shrink-0 rounded-lg px-2.5 py-1.5 text-[0.78125rem] font-medium whitespace-nowrap text-muted-foreground hover:bg-muted hover:text-foreground'
                }
                aria-current={item.id === activeNav ? 'page' : undefined}
              >
                {item.label}
              </button>
            ))}
          </nav>
        )}

        <div className="ml-auto flex h-14 shrink-0 items-center gap-2">
          {teams.length > 1 ? (
            <TeamSwitcher teams={teams} value={teamId} includeAll onChange={onTeamChange} />
          ) : null}
          <Button
            variant="ghost"
            size="icon"
            className="size-8 @min-[64em]:hidden"
            onClick={() => setSearchOpen(true)}
            aria-label="搜索任务、负责人"
            title="搜索任务、负责人"
          >
            <Search className="size-4" />
          </Button>
          <div className="relative hidden @min-[64em]:block">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="w-60 pl-8 text-xs @max-[80em]:w-40"
              placeholder="搜索任务、负责人"
              value={search}
              onChange={(event) => onSearch(event.target.value)}
              aria-label="搜索任务"
            />
          </div>
          <Button className="gap-1.5 px-3 text-xs" onClick={onCreate}>
            <Plus className="size-3.5" />
            创建任务
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <Avatar className="size-7">
                <AvatarFallback className="bg-secondary text-[0.625rem] font-semibold text-muted-foreground">
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
              <DropdownMenuItem onSelect={() => setPreferencesOpen(true)}>
                <SlidersHorizontal className="size-3.5" />
                偏好设置
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
            onClick={() => setTheme(nextTheme)}
            aria-label={themeLabel}
            title={themeLabel}
          >
            {resolvedTheme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </Button>
        </div>
        <PreferencesDialog open={preferencesOpen} onOpenChange={setPreferencesOpen} />
      </header>
    </div>
  )
}
