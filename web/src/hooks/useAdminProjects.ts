import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import * as admin from '@/api/admin'
import type {
  AdminUser,
  AgentBinding,
  ApprovalDraft,
  AuditEvent,
  ConnectProjectInput,
  MemberInput,
  ProjectAction,
  ProjectMember,
  RuntimeProject,
  TeamProject
} from '@/api/admin'

export type PendingApproval = {
  project: TeamProject
  sha256: string
  files: string[] | number | null
}

export type AdminProjects = {
  projects: TeamProject[]
  reloadProjects: (quiet?: boolean) => Promise<TeamProject[]>
  projectOptions: (TeamProject | RuntimeProject)[]
  accessProjectId: string
  selectProject: (projectId: string) => Promise<void>
  refreshAccess: () => void
  members: ProjectMember[]
  bindings: AgentBinding[]
  projectAudit: AuditEvent[]
  projectAuditHasMore: boolean
  loadProjectAudit: (reset: boolean) => Promise<void>
  saveMember: (input: MemberInput) => Promise<boolean>
  removeMember: (member: ProjectMember) => Promise<void>
  bindingAction: (binding: AgentBinding, action: admin.BindingAction) => Promise<void>
  connectProject: (input: ConnectProjectInput) => Promise<boolean>
  openApproval: (project: TeamProject, draft?: ApprovalDraft | null) => Promise<void>
  pendingApproval: PendingApproval | null
  closeApproval: () => void
  approveProject: (input: { leadUserId: string; leadTrellisDevId: string }) => Promise<boolean>
  projectAction: (project: TeamProject, action: ProjectAction) => Promise<void>
}

type AdminProjectsOptions = {
  report: (error: unknown, quiet?: boolean) => void
  isAdmin: boolean
  runtimeProjects: RuntimeProject[]
  users: AdminUser[]
  reloadUsers: (quiet?: boolean) => Promise<AdminUser[]>
}

export function useAdminProjects({
  report,
  isAdmin,
  runtimeProjects,
  users,
  reloadUsers
}: AdminProjectsOptions): AdminProjects {
  const [projects, setProjects] = useState<TeamProject[]>([])
  const [accessProjectId, setAccessProjectId] = useState('')
  const [members, setMembers] = useState<ProjectMember[]>([])
  const [bindings, setBindings] = useState<AgentBinding[]>([])
  const [projectAudit, setProjectAudit] = useState<AuditEvent[]>([])
  const [projectAuditHasMore, setProjectAuditHasMore] = useState(false)
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null)

  const accessProjectRef = useRef('')
  const projectAuditBeforeRef = useRef<number | null>(null)
  const requestRef = useRef(0)

  const reloadProjects = useCallback(
    async (quiet = false) => {
      try {
        const list = await admin.fetchAdminProjects()
        setProjects(list)
        return list
      } catch (error) {
        report(error, quiet)
        return []
      }
    },
    [report]
  )

  const projectOptions = useMemo(() => {
    const list: RuntimeProject[] = isAdmin
      ? projects
      : runtimeProjects.filter((project) => admin.canManageProject(project))
    const seen = new Set<string>()
    return list
      .filter((project) => {
        if (!project.id || seen.has(project.id)) return false
        seen.add(project.id)
        return true
      })
      .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))
  }, [isAdmin, projects, runtimeProjects])

  const selectProject = useCallback(
    async (projectId: string) => {
      const token = requestRef.current + 1
      requestRef.current = token
      accessProjectRef.current = projectId
      projectAuditBeforeRef.current = null
      setAccessProjectId(projectId)
      setMembers([])
      setBindings([])
      setProjectAudit([])
      setProjectAuditHasMore(false)
      if (!projectId) return
      const [membersResult, bindingsResult, auditResult] = await Promise.allSettled([
        admin.fetchMembers(projectId),
        admin.fetchBindings(projectId),
        admin.fetchProjectAudit(projectId, null)
      ])
      if (requestRef.current !== token) return
      if (membersResult.status === 'fulfilled') setMembers(membersResult.value)
      else report(membersResult.reason)
      if (bindingsResult.status === 'fulfilled') setBindings(bindingsResult.value)
      else report(bindingsResult.reason)
      if (auditResult.status === 'fulfilled') {
        projectAuditBeforeRef.current = auditResult.value.at(-1)?.id ?? null
        setProjectAudit(auditResult.value)
        setProjectAuditHasMore(auditResult.value.length >= admin.AUDIT_PAGE_LIMIT)
      } else {
        report(auditResult.reason)
      }
    },
    [report]
  )

  useEffect(() => {
    if (!accessProjectId) return
    if (projectOptions.some((project) => project.id === accessProjectId)) return
    requestRef.current += 1
    accessProjectRef.current = ''
    projectAuditBeforeRef.current = null
    setAccessProjectId('')
    setMembers([])
    setBindings([])
    setProjectAudit([])
    setProjectAuditHasMore(false)
  }, [accessProjectId, projectOptions])

  // 首次进入项目协作时加载可管理项目列表。
  useEffect(() => {
    if (isAdmin) void reloadProjects(true)
  }, [isAdmin, reloadProjects])

  // 在另一个页面/标签里修复或批准了项目时，切回来要看到最新状态。
  useEffect(() => {
    if (!isAdmin) return
    const refresh = () => {
      if (document.visibilityState === 'visible') void reloadProjects(true)
    }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [isAdmin, reloadProjects])

  const refreshAccess = useCallback(() => {
    if (accessProjectRef.current) void selectProject(accessProjectRef.current)
  }, [selectProject])

  const loadProjectAudit = useCallback(
    async (reset: boolean) => {
      const projectId = accessProjectRef.current
      if (!projectId) return
      const token = requestRef.current
      const before = reset ? null : projectAuditBeforeRef.current
      try {
        const events = await admin.fetchProjectAudit(projectId, before)
        if (requestRef.current !== token) return
        projectAuditBeforeRef.current = events.at(-1)?.id ?? (reset ? null : before)
        setProjectAudit((current) => (reset ? events : [...current, ...events]))
        setProjectAuditHasMore(events.length >= admin.AUDIT_PAGE_LIMIT)
      } catch (error) {
        report(error)
      }
    },
    [report]
  )

  const saveMember = useCallback(
    async (input: MemberInput) => {
      const projectId = accessProjectRef.current
      if (!projectId) {
        toast.error('先选择项目。')
        return false
      }
      try {
        setMembers(await admin.saveMember(projectId, input))
        toast.success('项目成员已保存。')
        return true
      } catch (error) {
        report(error)
        return false
      }
    },
    [report]
  )

  const removeMember = useCallback(
    async (member: ProjectMember) => {
      const projectId = accessProjectRef.current
      if (!projectId || !member.userId) {
        toast.error('成员缺少用户 ID，无法移除。')
        return
      }
      if (!window.confirm(`从项目移除 ${member.displayName || member.username}？`)) return
      try {
        setMembers(await admin.removeMember(projectId, member.userId))
        toast.success('项目成员已移除。')
      } catch (error) {
        report(error)
      }
    },
    [report]
  )

  const bindingAction = useCallback(
    async (binding: AgentBinding, action: admin.BindingAction) => {
      const projectId = accessProjectRef.current
      if (!projectId) return
      if (action !== 'approve' && !window.confirm(`确认对 Agent 绑定执行“${action}”？`)) return
      try {
        const result = await admin.runBindingAction(projectId, binding.id, action)
        await selectProject(projectId)
        toast.success(`绑定状态已更新${result.commandQueued ? '，同步命令已排队' : ''}。`)
      } catch (error) {
        report(error)
      }
    },
    [report, selectProject]
  )

  const openApproval = useCallback(
    async (project: TeamProject, draft: ApprovalDraft | null = null) => {
      if (!isAdmin) return
      if (!users.length) await reloadUsers(true)
      const sha256 = draft?.toolchainSha256 || project.scriptsSha256
      if (!sha256) {
        toast.error('项目没有可批准的工具链摘要，请重新连接或修复项目。')
        return
      }
      setPendingApproval({ project, sha256, files: draft?.files ?? null })
    },
    [isAdmin, reloadUsers, users.length]
  )

  const connectProject = useCallback(
    async (input: ConnectProjectInput) => {
      try {
        const result = await admin.connectProject(input)
        await reloadProjects(true)
        await openApproval(result.project, result.approval)
        return true
      } catch (error) {
        report(error)
        return false
      }
    },
    [openApproval, reloadProjects, report]
  )

  const approveProject = useCallback(
    async (input: { leadUserId: string; leadTrellisDevId: string }) => {
      if (!pendingApproval) return false
      try {
        const result = await admin.approveProject(pendingApproval.project.id, {
          toolchainSha256: pendingApproval.sha256,
          ...input
        })
        setPendingApproval(null)
        if (result.warning?.message) {
          // 项目已启用，只是首轮索引没建好；提示而不是当成失败。
          toast.warning(result.warning.message)
        } else {
          toast.success('项目工具链已批准，首个负责人已配置。')
        }
        await reloadProjects(true)
        return true
      } catch (error) {
        report(error)
        return false
      }
    },
    [pendingApproval, reloadProjects, report]
  )

  const projectAction = useCallback(
    async (project: TeamProject, action: ProjectAction) => {
      if (action === 'disable' && !window.confirm(`停用项目 ${project.name}？相关 Agent 绑定会被删除。`)) {
        return
      }
      if (action === 'repair' && !window.confirm(`对 ${project.name} 执行受控修复？`)) return
      try {
        await admin.runProjectAction(project.id, action)
        const suffix =
          action === 'refresh' ? '已刷新。' : action === 'repair' ? '已执行修复检查。' : '已停用。'
        toast.success(`项目 ${project.name} ${suffix}`)
        await reloadProjects(true)
      } catch (error) {
        report(error)
      }
    },
    [reloadProjects, report]
  )

  return {
    projects,
    reloadProjects,
    projectOptions,
    accessProjectId,
    selectProject,
    refreshAccess,
    members,
    bindings,
    projectAudit,
    projectAuditHasMore,
    loadProjectAudit,
    saveMember,
    removeMember,
    bindingAction,
    connectProject,
    openApproval,
    pendingApproval,
    closeApproval: () => setPendingApproval(null),
    approveProject,
    projectAction
  }
}
