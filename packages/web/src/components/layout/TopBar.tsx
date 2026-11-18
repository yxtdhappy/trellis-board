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
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useAppearance } from '@/app/theme'
import { TrellisLogo } from '@/components/layout/TrellisLogo'
import { PreferencesDialog } from '@/features/settings/PreferencesDialog'
import { initials } from '@/features/board/task-view'
import { TeamSwitcher } from '@/features/admin/TeamSwitcher'

export type BoardNavItem = { id: string; label: string }
type TeamOption = { id: string; name: string }

function SearchField({
  className,
  inputClassName,
  autoFocus,
  value,
  onChange,
}: {
  className?: string
  inputClassName?: string
  autoFocus?: boolean
  value: string
  onChange: (value: string) => void
}) {
  return (
    <div className={cn('relative', className)}>
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        autoFocus={autoFocus}
        className={cn('pl-8 text-xs', inputClassName)}
        placeholder="搜索任务、负责人"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-label="搜索任务"
      />
    </div>
  )
}

type TopBarProps = {
  brandName: string
  version?: string
  serverVersion?: string
  onOpenUpdate?: () => void
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
  brandName,
  version,
  serverVersion,
  onOpenUpdate,
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
  const displayVersion = onOpenUpdate ? version : serverVersion

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
        <div className="flex h-14 shrink-0 items-center gap-2">
          <a className="flex h-14 items-center" href="/" aria-label={`${brandName} 首页`}>
            <TrellisLogo size={24} />
          </a>
          <span className="flex min-w-0 flex-col justify-center leading-none @max-[64em]:hidden">
            <a className="max-w-40 truncate text-sm font-semibold" href="/" title={brandName}>
              {brandName}
            </a>
            {displayVersion ? (
              onOpenUpdate ? (
                <Button
                  type="button"
                  variant="link"
                  size="xs"
                  className="mt-0.5 h-auto justify-start p-0 text-2xs font-medium text-muted-foreground hover:text-foreground"
                  onClick={onOpenUpdate}
                  aria-label={`客户端版本 v${displayVersion}，检查更新`}
                >
                  v{displayVersion}
                </Button>
              ) : (
                <span
                  className="mt-1 text-2xs font-medium text-muted-foreground"
                  title="服务端版本"
                >
                  v{displayVersion}
                </span>
              )
            ) : null}
          </span>
        </div>

        {searchOpen ? (
          <div className="flex min-w-0 flex-1 items-center gap-2 @max-[48em]:order-last @max-[48em]:h-10 @max-[48em]:w-full @max-[48em]:flex-none @min-[64em]:hidden">
            <SearchField
              className="min-w-0 flex-1"
              inputClassName="w-full"
              autoFocus
              value={search}
              onChange={onSearch}
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 rounded-lg text-muted-foreground"
              onClick={() => setSearchOpen(false)}
            >
              取消
            </Button>
          </div>
        ) : (
          <nav
            ref={navRef}
            className="topbar-nav ml-3 flex h-14 min-w-0 flex-1 items-center gap-0.5 overflow-x-auto overscroll-x-contain @max-[48em]:order-last @max-[48em]:ml-0 @max-[48em]:h-10 @max-[48em]:w-full @max-[48em]:flex-none @max-[48em]:border-t @max-[48em]:border-border"
            aria-label="看板视图"
          >
            {nav.map((item) => (
              <Button
                key={item.id}
                variant="ghost"
                size="sm"
                onClick={() => onNavigate(item.id)}
                className={
                  item.id === activeNav
                    ? 'shrink-0 gap-0 bg-secondary font-semibold whitespace-nowrap text-foreground hover:bg-secondary'
                    : 'shrink-0 gap-0 font-medium whitespace-nowrap text-muted-foreground'
                }
                aria-current={item.id === activeNav ? 'page' : undefined}
              >
                {item.label}
              </Button>
            ))}
          </nav>
        )}

        <div className="ml-auto flex h-14 shrink-0 items-center gap-2">
          {teams.length > 1 ? (
            <TeamSwitcher teams={teams} value={teamId} includeAll onChange={onTeamChange} />
          ) : null}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8 @min-[64em]:hidden"
                  onClick={() => setSearchOpen(true)}
                  aria-label="搜索任务、负责人"
                />
              }
            >
              <Search className="size-4" />
            </TooltipTrigger>
            <TooltipContent>搜索任务、负责人</TooltipContent>
          </Tooltip>
          <SearchField
            className="hidden @min-[64em]:block"
            inputClassName="w-60 @max-[80em]:w-40"
            value={search}
            onChange={onSearch}
          />
          <Button className="gap-1.5 px-3 text-xs" onClick={onCreate}>
            <Plus className="size-3.5" />
            创建任务
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <Avatar className="size-8">
                <AvatarFallback className="bg-secondary text-2xs font-semibold text-muted-foreground">
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
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  onClick={() => setTheme(nextTheme)}
                  aria-label={themeLabel}
                />
              }
            >
              {resolvedTheme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
            </TooltipTrigger>
            <TooltipContent>{themeLabel}</TooltipContent>
          </Tooltip>
        </div>
        <PreferencesDialog open={preferencesOpen} onOpenChange={setPreferencesOpen} />
      </header>
    </div>
  )
}
