import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { ApiError, redirectToLogin } from '@/api/request'
import { useConfirm } from '@/components/ui/confirm-dialog'
import * as admin from '@/api/admin'
import type {
  AdminUser,
  AdminView,
  AgentDevice,
  AuditEvent,
  NewUserInput,
  SessionUser,
  Team,
  UserUpdate,
} from '@/api/admin'
import { formatTime } from '@/lib/admin-shared'
import { useAdminProjects } from './useAdminProjects.ts'
import type { AdminProjects } from './useAdminProjects.ts'

export type AdminPhase = 'loading' | 'ready' | 'denied' | 'error'

export type Credential = {
  title: string
  description: string
  value: string
}

export type AdminConsole = AdminProjects & {
  phase: AdminPhase
  bootError: string
  view: AdminView
  setView: (view: AdminView) => void
  isAdmin: boolean
  systemAdmin: boolean
  teams: Team[]
  adminTeams: Team[]
  adminTeamId: string
  setAdminTeamId: (teamId: string) => void
  displayName: string
  roleLabel: string
  avatarText: string
  users: AdminUser[]
  reloadUsers: (quiet?: boolean) => Promise<AdminUser[]>
  devices: AgentDevice[]
  reloadDevices: (quiet?: boolean) => Promise<AgentDevice[]>
  systemAudit: AuditEvent[]
  systemAuditHasMore: boolean
  systemAuditUnavailable: boolean
  loadSystemAudit: (reset: boolean) => Promise<void>
  createUser: (input: NewUserInput) => Promise<boolean>
  updateUser: (target: AdminUser, updates: UserUpdate) => Promise<AdminUser | null>
  toggleUser: (target: AdminUser) => Promise<void>
  resetPassword: (target: AdminUser, password: string) => Promise<boolean>
  revokeDevice: (device: AgentDevice) => Promise<void>
  createPairingCode: (teamId?: string) => Promise<void>
  pairingCode: { code: string; expiresAt: string | null } | null
  createDesktopEnrollToken: () => Promise<void>
  desktopToken: { token: string; expiresAt: string | null } | null
  credential: Credential | null
  showCredential: (title: string, description: string, value: string | null) => void
  closeCredential: () => void
  logout: () => Promise<void>
}

function redirectIfUnauthorized(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.status !== 401) return false
  if (error.code === 'PASSWORD_CHANGE_REQUIRED') window.location.replace('/')
  else redirectToLogin()
  return true
}

export function useAdminConsole(): AdminConsole {
  const confirm = useConfirm()
  const [phase, setPhase] = useState<AdminPhase>('loading')
  const [bootError, setBootError] = useState('')
  const [user, setUser] = useState<SessionUser | null>(null)
  const [isAdmin, setIsAdmin] = useState(false)
  const [systemAdmin, setSystemAdmin] = useState(false)
  const [teams, setTeams] = useState<Team[]>([])
  const [adminTeamId, setAdminTeamId] = useState('')
  const [runtimeProjects, setRuntimeProjects] = useState<admin.RuntimeProject[]>([])
  const [view, setView] = useState<AdminView>('project-access')

  const [users, setUsers] = useState<AdminUser[]>([])
  const [devices, setDevices] = useState<AgentDevice[]>([])
  const [systemAudit, setSystemAudit] = useState<AuditEvent[]>([])
  const [systemAuditHasMore, setSystemAuditHasMore] = useState(false)
  const [systemAuditUnavailable, setSystemAuditUnavailable] = useState(false)
  const [credential, setCredential] = useState<Credential | null>(null)
  const [pairingCode, setPairingCode] = useState<{ code: string; expiresAt: string | null } | null>(
    null,
  )
  const [desktopToken, setDesktopToken] = useState<{
    token: string
    expiresAt: string | null
  } | null>(null)

  const systemAuditBeforeRef = useRef<number | null>(null)
  const adminTeams = systemAdmin ? teams : teams.filter((team) => team.role === 'admin')

  const report = useCallback((error: unknown, quiet = false) => {
    if (redirectIfUnauthorized(error)) return
    if (!quiet) toast.error(admin.formatError(error))
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const runtime = await admin.fetchRuntime()
        if (cancelled) return
        setUser(runtime.user)
        setSystemAdmin(runtime.systemAdmin)
        setTeams(runtime.teams)
        setRuntimeProjects(runtime.projects)
        if (!runtime.team && !runtime.systemAdmin) {
          window.location.replace('/')
          return
        }
        if (!runtime.authenticated || !runtime.user) {
          redirectToLogin()
          return
        }
        if (runtime.user.mustChangePassword) {
          window.location.replace('/')
          return
        }
        const manageableTeams = runtime.systemAdmin
          ? runtime.teams
          : runtime.teams.filter((team) => team.role === 'admin')
        const canAdmin = runtime.systemAdmin || manageableTeams.length > 0
        setAdminTeamId(runtime.systemAdmin ? 'all' : manageableTeams[0]?.id || '')
        const canManage =
          canAdmin || runtime.projects.some((project) => admin.canManageProject(project))
        setIsAdmin(canAdmin)
        setPhase(canManage ? 'ready' : 'denied')
      } catch (error) {
        if (cancelled) return
        if (redirectIfUnauthorized(error)) return
        setBootError(admin.formatError(error))
        setPhase('error')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    systemAuditBeforeRef.current = null
    setUsers([])
    setDevices([])
    setSystemAudit([])
    setSystemAuditHasMore(false)
    setPairingCode(null)
    setCredential(null)
  }, [adminTeamId])

  const reloadUsers = useCallback(
    async (quiet = false) => {
      try {
        const list = await admin.fetchUsers(adminTeamId || undefined)
        setUsers(list)
        return list
      } catch (error) {
        report(error, quiet)
        return []
      }
    },
    [adminTeamId, report],
  )

  const reloadDevices = useCallback(
    async (quiet = false) => {
      if (!isAdmin) return []
      try {
        const list = await admin.fetchDevices(adminTeamId || undefined)
        setDevices(list)
        return list
      } catch (error) {
        report(error, quiet)
        return []
      }
    },
    [adminTeamId, isAdmin, report],
  )

  const loadSystemAudit = useCallback(
    async (reset: boolean) => {
      const before = reset ? null : systemAuditBeforeRef.current
      try {
        const events = await admin.fetchSystemAudit(before, adminTeamId || undefined)
        systemAuditBeforeRef.current = events.at(-1)?.id ?? (reset ? null : before)
        setSystemAudit((current) => (reset ? events : [...current, ...events]))
        setSystemAuditHasMore(events.length >= admin.AUDIT_PAGE_LIMIT)
        setSystemAuditUnavailable(false)
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) {
          systemAuditBeforeRef.current = null
          setSystemAudit([])
          setSystemAuditHasMore(false)
          setSystemAuditUnavailable(true)
          return
        }
        report(error)
      }
    },
    [adminTeamId, report],
  )

  const showCredential = useCallback((title: string, description: string, value: string | null) => {
    if (!value) {
      toast.error('服务端没有返回一次性凭证，请重新执行操作。')
      return
    }
    setCredential({ title, description, value })
  }, [])

  const createUser = useCallback(
    async (input: NewUserInput) => {
      try {
        const created = await admin.createUser(input)
        if (!created) {
          toast.error('服务端没有返回新账号，请刷新后重试。')
          return false
        }
        toast.success(`账号 ${created.username} 已创建。`)
        await reloadUsers(true)
        return true
      } catch (error) {
        report(error)
        return false
      }
    },
    [reloadUsers, report],
  )

  const updateUser = useCallback(
    async (target: AdminUser, updates: UserUpdate) => {
      try {
        const updated = await admin.updateUser(target.id, updates)
        setUsers((current) => current.map((item) => (item.id === updated.id ? updated : item)))
        return updated
      } catch (error) {
        report(error)
        return null
      }
    },
    [report],
  )

  const toggleUser = useCallback(
    async (target: AdminUser) => {
      const status = target.status === 'active' ? 'disabled' : 'active'
      const confirmed = await confirm({
        title: `${status === 'disabled' ? '停用' : '启用'}账号 ${target.username}？`,
        confirmText: status === 'disabled' ? '停用' : '启用',
        tone: status === 'disabled' ? 'danger' : 'default',
      })
      if (!confirmed) return
      const updated = await updateUser(target, { status })
      if (updated) {
        toast.success(`账号 ${updated.username} 已${status === 'active' ? '启用' : '停用'}。`)
      }
    },
    [confirm, updateUser],
  )

  const resetPassword = useCallback(
    async (target: AdminUser, password: string) => {
      try {
        await admin.resetUserPassword(target.id, password)
        toast.success(`账号 ${target.username} 的密码已重置，原会话已失效。`)
        await reloadUsers(true)
        return true
      } catch (error) {
        report(error)
        return false
      }
    },
    [reloadUsers, report],
  )

  const revokeDevice = useCallback(
    async (device: AgentDevice) => {
      if (!adminTeamId || adminTeamId === 'all') {
        toast.error('请先在顶部选择一个具体团队，再撤销该团队的设备绑定。')
        return
      }
      const confirmed = await confirm({
        title: `撤销 Agent 设备 ${device.deviceName}？`,
        description: '相关绑定和待执行命令会失效。',
        confirmText: '撤销',
        tone: 'danger',
      })
      if (!confirmed) return
      try {
        await admin.revokeDevice(device.id, adminTeamId)
        toast.success('Agent 设备已撤销。')
        await reloadDevices(true)
      } catch (error) {
        report(error)
      }
    },
    [adminTeamId, confirm, reloadDevices, report],
  )

  const createPairingCode = useCallback(
    async (teamId?: string) => {
      const targetTeamId = teamId || adminTeamId
      if (!targetTeamId || targetTeamId === 'all') {
        toast.error('请先在顶部选择一个具体团队，再生成配对码。')
        return
      }
      try {
        const result = await admin.createPairingCode(targetTeamId)
        if (result.pairingCode) {
          setPairingCode({ code: result.pairingCode, expiresAt: result.expiresAt })
        }
        showCredential(
          'Agent 配对码',
          result.expiresAt
            ? `仅显示一次，有效期至 ${formatTime(result.expiresAt)}。`
            : '仅显示一次，请立即完成 Agent 配对。',
          result.pairingCode,
        )
      } catch (error) {
        report(error)
      }
    },
    [adminTeamId, report, showCredential],
  )

  const createDesktopEnrollToken = useCallback(async () => {
    try {
      const result = await admin.createDesktopEnrollToken()
      if (result.token) {
        setDesktopToken({ token: result.token, expiresAt: result.expiresAt })
        toast.success('已生成一次性桌面设备令牌，5 分钟内有效。')
      }
    } catch (error) {
      report(error)
    }
  }, [report])

  const logout = useCallback(async () => {
    try {
      await admin.logout()
    } catch {
      // 即使服务端会话已失效，也回到登录页。
    }
    window.location.replace('/login.html')
  }, [])

  const projects = useAdminProjects({
    report,
    isAdmin,
    teamId: adminTeamId,
    runtimeProjects,
  })
  const displayName = user?.displayName || user?.username || '团队账号'

  return {
    ...projects,
    phase,
    bootError,
    view,
    setView,
    isAdmin,
    systemAdmin,
    teams,
    adminTeams,
    adminTeamId,
    setAdminTeamId,
    displayName,
    roleLabel: systemAdmin ? '系统管理员' : isAdmin ? '团队管理员' : '项目负责人',
    avatarText: displayName.slice(0, 1),
    users,
    reloadUsers,
    devices,
    reloadDevices,
    systemAudit,
    systemAuditHasMore,
    systemAuditUnavailable,
    loadSystemAudit,
    createUser,
    updateUser,
    toggleUser,
    resetPassword,
    revokeDevice,
    createPairingCode,
    pairingCode,
    createDesktopEnrollToken,
    desktopToken,
    credential,
    showCredential,
    closeCredential: () => setCredential(null),
    logout,
  }
}
