import { LogOut, Moon, Sun } from 'lucide-react'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { TrellisLogo } from '@/components/layout/TrellisLogo'
import { useAppearance } from '@/app/theme'
import type { AdminView } from '@/api/admin'
import { useAdminConsole } from '@/hooks/useAdminConsole'
import { ProjectsTab } from '@/features/admin/ProjectsTab'
import { UsersTab } from '@/features/admin/UsersTab'
import { TeamsTab } from '@/features/admin/TeamsTab'
import { PluginsTab } from '@/features/admin/PluginsTab'
import { TeamSwitcher } from '@/features/admin/TeamSwitcher'
import { DevicesTab } from '@/features/admin/DevicesTab'
import { AuditTab } from '@/features/admin/AuditTab'
import { ArchiveSyncTab } from '@/features/admin/ArchiveSyncTab'
import { OneTimeCredentialDialog } from '@/features/admin/OneTimeCredentialDialog'

const VIEWS: {
  id: AdminView
  label: string
  subtitle: string
  adminOnly: boolean
}[] = [
  {
    id: 'project-access',
    label: '项目协作',
    subtitle: '维护项目成员、Agent 绑定和项目审计。',
    adminOnly: false,
  },
  {
    id: 'users',
    label: '用户账号',
    subtitle: '创建账号、配置所属团队并重置密码。',
    adminOnly: true,
  },
  {
    id: 'archive-sync',
    label: '归档同步',
    subtitle: '配置只读 Git 凭据，查看服务端归档索引和失败日志。',
    adminOnly: true,
  },
  {
    id: 'teams',
    label: '团队',
    subtitle: '创建团队、启停团队并分配团队成员。',
    adminOnly: true,
  },
  {
    id: 'plugins',
    label: '插件',
    subtitle: '启用插件、查看进程状态，并把项目对到插件里的项目。',
    adminOnly: false,
  },
  {
    id: 'agents',
    label: 'Agent 设备',
    subtitle: '查看设备心跳、版本和撤销状态。',
    adminOnly: true,
  },
  {
    id: 'audit',
    label: '系统审计',
    subtitle: '检查跨项目操作结果；敏感字段在渲染前再次隐藏。',
    adminOnly: true,
  },
]

export function AdminPage() {
  const consoleApi = useAdminConsole()
  const { resolvedTheme, setTheme } = useAppearance()
  const nextTheme = resolvedTheme === 'dark' ? 'light' : 'dark'
  const themeLabel = resolvedTheme === 'dark' ? '切换到浅色主题' : '切换到深色主题'
  const {
    phase,
    bootError,
    view,
    setView,
    isAdmin,
    systemAdmin,
    adminTeams,
    adminTeamId,
    setAdminTeamId,
    roleLabel,
    displayName,
    avatarText,
  } = consoleApi
  const activeView = VIEWS.find((item) => item.id === view) ?? VIEWS[0]
  const visibleViews = VIEWS.filter((item) => {
    if (item.id === 'users' || item.id === 'teams' || item.id === 'archive-sync') {
      return systemAdmin
    }
    if (item.adminOnly) return isAdmin
    return true
  })

  return (
    <div className="min-h-dvh bg-background text-foreground">
      <header className="sticky top-0 z-20 flex h-14 items-center justify-between gap-3 border-b border-border bg-card px-4">
        <div className="flex items-center gap-3">
          <a className="flex items-center gap-2" href="/" aria-label="返回 Trellis Board">
            <TrellisLogo size={24} />
            <span className="text-sm font-semibold font-heading">Trellis Board</span>
          </a>
          <a
            className="inline-flex h-8 items-center rounded-lg bg-muted px-2.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
            href="/"
          >
            返回看板
          </a>
        </div>
        <div className="flex items-center gap-2">
          <TeamSwitcher
            teams={adminTeams}
            value={adminTeamId}
            includeAll={systemAdmin || adminTeams.length > 1}
            onChange={setAdminTeamId}
            ariaLabel="管理团队范围"
          />
          <DropdownMenu>
            <DropdownMenuTrigger className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <Avatar className="size-8">
                <AvatarFallback className="bg-secondary text-2xs font-semibold text-muted-foreground">
                  {avatarText}
                </AvatarFallback>
              </Avatar>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <div className="px-2 py-1.5 text-xs">
                <div className="font-medium text-foreground">{displayName}</div>
                <div className="text-xs text-muted-foreground">{roleLabel}</div>
              </div>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => void consoleApi.logout()} variant="destructive">
                <LogOut className="size-3.5" />
                退出登录
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
      </header>

      <main className="flex flex-col gap-3.5 px-6 py-5">
        <div>
          <h1 className="text-lg font-semibold font-heading">团队管理</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">{activeView.subtitle}</p>
        </div>

        {phase === 'loading' ? (
          <p className="rounded-xl bg-card px-4 py-6 text-xs text-muted-foreground">
            正在读取团队账号和项目权限…
          </p>
        ) : null}

        {phase === 'error' ? (
          <p
            role="alert"
            className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-xs text-destructive"
          >
            {bootError}
          </p>
        ) : null}

        {phase === 'denied' ? (
          <div className="flex flex-col gap-1.5 rounded-xl bg-card p-6">
            <strong className="text-sm text-foreground">当前账号没有管理入口</strong>
            <span className="text-xs leading-relaxed text-muted-foreground">
              系统管理员可管理系统能力；项目负责人可管理自己项目的成员、Agent 绑定和审计。
            </span>
          </div>
        ) : null}

        {phase === 'ready' ? (
          <>
            <Tabs value={view} onValueChange={(value) => setView(value)}>
              <TabsList
                aria-label="管理导航"
                className="max-w-full overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
              >
                {visibleViews.map((item) => (
                  <TabsTrigger key={item.id} value={item.id}>
                    {item.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>

            <div>
              {view === 'project-access' ? <ProjectsTab console={consoleApi} /> : null}
              {view === 'archive-sync' ? <ArchiveSyncTab /> : null}
              {view === 'users' ? <UsersTab console={consoleApi} /> : null}
              {view === 'teams' ? <TeamsTab /> : null}
              {view === 'plugins' ? <PluginsTab console={consoleApi} /> : null}
              {view === 'agents' ? <DevicesTab console={consoleApi} /> : null}
              {view === 'audit' ? <AuditTab console={consoleApi} /> : null}
            </div>
          </>
        ) : null}
      </main>

      <OneTimeCredentialDialog
        credential={consoleApi.credential}
        onClose={consoleApi.closeCredential}
      />
    </div>
  )
}
