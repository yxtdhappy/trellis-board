import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { ApiError, redirectToLogin } from '@/api/request'
import * as admin from '@/api/admin'
import type { AdminUser, AdminView, AgentDevice, AuditEvent, NewUserInput, SessionUser, UserUpdate } from '@/api/admin'
import { formatTime } from '@/lib/admin-shared'
import { useAdminProjects } from './useAdminProjects'
import type { AdminProjects } from './useAdminProjects'

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
  createPairingCode: () => Promise<void>
  pairingCode: { code: string; expiresAt: string | null } | null
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
  const [phase, setPhase] = useState<AdminPhase>('loading')
  const [bootError, setBootError] = useState('')
  const [user, setUser] = useState<SessionUser | null>(null)
  const [isAdmin, setIsAdmin] = useState(false)
  const [systemAdmin, setSystemAdmin] = useState(false)
  const [runtimeProjects, setRuntimeProjects] = useState<admin.RuntimeProject[]>([])
  const [view, setView] = useState<AdminView>('project-access')

  const [users, setUsers] = useState<AdminUser[]>([])
  const [devices, setDevices] = useState<AgentDevice[]>([])
  const [systemAudit, setSystemAudit] = useState<AuditEvent[]>([])
  const [systemAuditHasMore, setSystemAuditHasMore] = useState(false)
  const [systemAuditUnavailable, setSystemAuditUnavailable] = useState(false)
  const [credential, setCredential] = useState<Credential | null>(null)
  const [pairingCode, setPairingCode] = useState<{ code: string; expiresAt: string | null } | null>(null)

  const systemAuditBeforeRef = useRef<number | null>(null)

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
        const canAdmin = runtime.systemAdmin || runtime.teamRole === 'admin'
        const canManage =
          canAdmin ||
          runtime.projects.some((project) => admin.canManageProject(project))
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

  const reloadUsers = useCallback(
    async (quiet = false) => {
      try {
        const list = await admin.fetchUsers()
        setUsers(list)
        return list
      } catch (error) {
        report(error, quiet)
        return []
      }
    },
    [report]
  )

  const reloadDevices = useCallback(
    async (quiet = false) => {
      if (!isAdmin) return []
      try {
        const list = await admin.fetchDevices()
        setDevices(list)
        return list
      } catch (error) {
        report(error, quiet)
        return []
      }
    },
    [isAdmin, report]
  )

  const loadSystemAudit = useCallback(
    async (reset: boolean) => {
      const before = reset ? null : systemAuditBeforeRef.current
      try {
        const events = await admin.fetchSystemAudit(before)
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
    [report]
  )

  const showCredential = useCallback(
    (title: string, description: string, value: string | null) => {
      if (!value) {
        toast.error('服务端没有返回一次性凭证，请重新执行操作。')
        return
      }
      setCredential({ title, description, value })
    },
    []
  )

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
    [reloadUsers, report]
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
    [report]
  )

  const toggleUser = useCallback(
    async (target: AdminUser) => {
      const status = target.status === 'active' ? 'disabled' : 'active'
      if (!window.confirm(`${status === 'disabled' ? '停用' : '启用'}账号 ${target.username}？`)) return
      const updated = await updateUser(target, { status })
      if (updated) {
        toast.success(`账号 ${updated.username} 已${status === 'active' ? '启用' : '停用'}。`)
      }
    },
    [updateUser]
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
    [reloadUsers, report]
  )

  const revokeDevice = useCallback(
    async (device: AgentDevice) => {
      if (!window.confirm(`撤销 Agent 设备 ${device.deviceName}？相关绑定和待执行命令会失效。`)) return
      try {
        await admin.revokeDevice(device.id)
        toast.success('Agent 设备已撤销。')
        await reloadDevices(true)
      } catch (error) {
        report(error)
      }
    },
    [reloadDevices, report]
  )

  const createPairingCode = useCallback(async () => {
    try {
      const result = await admin.createPairingCode()
      if (result.pairingCode) {
        setPairingCode({ code: result.pairingCode, expiresAt: result.expiresAt })
      }
      showCredential(
        'Agent 配对码',
        result.expiresAt
          ? `仅显示一次，有效期至 ${formatTime(result.expiresAt)}。`
          : '仅显示一次，请立即完成 Agent 配对。',
        result.pairingCode
      )
    } catch (error) {
      report(error)
    }
  }, [report, showCredential])

  const logout = useCallback(async () => {
    try {
      await admin.logout()
    } catch {
      // 即使服务端会话已失效，也回到登录页。
    }
    window.location.replace('/login.html')
  }, [])

  const projects = useAdminProjects({ report, isAdmin, runtimeProjects, users, reloadUsers })
  const displayName = user?.displayName || user?.username || '团队账号'

  return {
    ...projects,
    phase,
    bootError,
    view,
    setView,
    isAdmin,
    systemAdmin,
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
    credential,
    showCredential,
    closeCredential: () => setCredential(null),
    logout
  }
}
