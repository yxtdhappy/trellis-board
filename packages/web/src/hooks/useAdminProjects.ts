import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import * as admin from '@/api/admin'
import { useConfirm } from '@/components/ui/confirm-dialog'
import type {
  AgentBinding,
  AdminTaskSpace,
  AuditEvent,
  MemberInput,
  ProjectMember,
  ProjectTeamAccess,
  PurgeProjectResult,
  RuntimeProject,
  TeamProject,
} from '@/api/admin'

export type AdminProjects = {
  projects: TeamProject[]
  reloadProjects: (quiet?: boolean) => Promise<TeamProject[]>
  projectOptions: (TeamProject | RuntimeProject)[]
  accessProjectId: string
  selectProject: (projectId: string) => Promise<void>
  refreshAccess: () => void
  members: ProjectMember[]
  bindings: AgentBinding[]
  taskSpaces: AdminTaskSpace[]
  projectTeams: ProjectTeamAccess[]
  projectAudit: AuditEvent[]
  projectAuditHasMore: boolean
  loadProjectAudit: (reset: boolean) => Promise<void>
  saveMember: (input: MemberInput) => Promise<boolean>
  removeMember: (member: ProjectMember) => Promise<void>
  inviteProjectTeam: (teamId: string, accessRole?: string) => Promise<void>
  removeProjectTeam: (access: ProjectTeamAccess) => Promise<void>
  bindingAction: (binding: AgentBinding, action: admin.BindingAction) => Promise<void>
  retireTaskSpace: (taskSpace: AdminTaskSpace, reason?: string) => Promise<TaskSpaceActionOutcome>
  restoreTaskSpace: (taskSpace: AdminTaskSpace) => Promise<TaskSpaceActionOutcome>
  purgeTaskSpace: (
    taskSpace: AdminTaskSpace,
    confirmation: string,
  ) => Promise<TaskSpaceActionOutcome>
  purgeProject: (projectId: string, confirmation: string) => Promise<ProjectActionOutcome>
}

export type TaskSpaceActionOutcome = {
  ok: boolean
  error?: string
  purge?: admin.PurgeTaskSpaceResult
}

export type ProjectActionOutcome = {
  ok: boolean
  error?: string
  purge?: PurgeProjectResult
}

type AdminProjectsOptions = {
  report: (error: unknown, quiet?: boolean) => void
  isAdmin: boolean
  teamId: string
  runtimeProjects: RuntimeProject[]
}

export function useAdminProjects({
  report,
  isAdmin,
  teamId,
  runtimeProjects,
}: AdminProjectsOptions): AdminProjects {
  const confirm = useConfirm()
  const [projects, setProjects] = useState<TeamProject[]>([])
  const [accessProjectId, setAccessProjectId] = useState('')
  const [members, setMembers] = useState<ProjectMember[]>([])
  const [bindings, setBindings] = useState<AgentBinding[]>([])
  const [taskSpaces, setTaskSpaces] = useState<AdminTaskSpace[]>([])
  const [projectTeams, setProjectTeams] = useState<ProjectTeamAccess[]>([])
  const [projectAudit, setProjectAudit] = useState<AuditEvent[]>([])
  const [projectAuditHasMore, setProjectAuditHasMore] = useState(false)
  const [removedProjectIds, setRemovedProjectIds] = useState<Set<string>>(() => new Set())

  const accessProjectRef = useRef('')
  const projectAuditBeforeRef = useRef<number | null>(null)
  const requestRef = useRef(0)

  const reloadProjects = useCallback(
    async (quiet = false) => {
      try {
        const list = await admin.fetchAdminProjects(teamId)
        setProjects(list)
        return list
      } catch (error) {
        report(error, quiet)
        return []
      }
    },
    [report, teamId],
  )

  const projectOptions = useMemo(() => {
    const list: RuntimeProject[] = [
      ...(isAdmin ? projects : []),
      ...runtimeProjects.filter((project) => admin.canManageProject(project)),
    ]
    const seen = new Set<string>()
    return list
      .filter((project) => {
        if (!project.id || seen.has(project.id) || removedProjectIds.has(project.id)) return false
        seen.add(project.id)
        return true
      })
      .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))
  }, [isAdmin, projects, removedProjectIds, runtimeProjects])

  const selectProject = useCallback(
    async (projectId: string) => {
      const token = requestRef.current + 1
      requestRef.current = token
      accessProjectRef.current = projectId
      projectAuditBeforeRef.current = null
      setAccessProjectId(projectId)
      setMembers([])
      setBindings([])
      setTaskSpaces([])
      setProjectTeams([])
      setProjectAudit([])
      setProjectAuditHasMore(false)
      if (!projectId) return
      const [membersResult, bindingsResult, taskSpacesResult, teamsResult, auditResult] =
        await Promise.allSettled([
          admin.fetchMembers(projectId),
          admin.fetchBindings(projectId),
          admin.fetchProjectTaskSpaces(projectId),
          admin.fetchProjectTeams(projectId),
          admin.fetchProjectAudit(projectId, null),
        ])
      if (requestRef.current !== token) return
      if (membersResult.status === 'fulfilled') setMembers(membersResult.value)
      else report(membersResult.reason)
      if (bindingsResult.status === 'fulfilled') setBindings(bindingsResult.value)
      else report(bindingsResult.reason)
      if (taskSpacesResult.status === 'fulfilled') setTaskSpaces(taskSpacesResult.value)
      else report(taskSpacesResult.reason)
      if (teamsResult.status === 'fulfilled') setProjectTeams(teamsResult.value)
      else report(teamsResult.reason)
      if (auditResult.status === 'fulfilled') {
        projectAuditBeforeRef.current = auditResult.value.at(-1)?.id ?? null
        setProjectAudit(auditResult.value)
        setProjectAuditHasMore(auditResult.value.length >= admin.AUDIT_PAGE_LIMIT)
      } else {
        report(auditResult.reason)
      }
    },
    [report],
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
    setTaskSpaces([])
    setProjectTeams([])
    setProjectAudit([])
    setProjectAuditHasMore(false)
  }, [accessProjectId, projectOptions])

  // 首次进入项目协作时加载可管理项目列表。
  useEffect(() => {
    if (isAdmin) void reloadProjects(true)
  }, [isAdmin, reloadProjects])

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
    [report],
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
    [report],
  )

  const removeMember = useCallback(
    async (member: ProjectMember) => {
      const projectId = accessProjectRef.current
      if (!projectId || !member.userId) {
        toast.error('成员缺少用户 ID，无法移除。')
        return
      }
      const confirmed = await confirm({
        title: `从项目移除 ${member.displayName || member.username}？`,
        confirmText: '移除',
        tone: 'danger',
      })
      if (!confirmed) return
      try {
        setMembers(await admin.removeMember(projectId, member.userId))
        toast.success('项目成员已移除。')
      } catch (error) {
        report(error)
      }
    },
    [confirm, report],
  )

  const inviteProjectTeam = useCallback(
    async (targetTeamId: string, accessRole = 'member') => {
      const projectId = accessProjectRef.current
      if (!projectId || !targetTeamId) {
        toast.error('先选择项目和要邀请的团队。')
        return
      }
      try {
        await admin.inviteProjectTeam(projectId, targetTeamId, accessRole)
        setProjectTeams(await admin.fetchProjectTeams(projectId))
        toast.success('团队访问权限已授予。')
      } catch (error) {
        report(error)
      }
    },
    [report],
  )

  const removeProjectTeam = useCallback(
    async (access: ProjectTeamAccess) => {
      const projectId = accessProjectRef.current
      if (!projectId || !access.teamId) return
      const confirmed = await confirm({
        title: `移除团队 ${access.teamName} 对该项目的访问权限？`,
        confirmText: '移除',
        tone: 'danger',
      })
      if (!confirmed) return
      try {
        await admin.removeProjectTeam(projectId, access.teamId)
        setProjectTeams(await admin.fetchProjectTeams(projectId))
        toast.success('团队访问权限已移除。')
      } catch (error) {
        report(error)
      }
    },
    [confirm, report],
  )

  const bindingAction = useCallback(
    async (binding: AgentBinding, action: admin.BindingAction) => {
      const projectId = accessProjectRef.current
      if (!projectId) return
      if (action !== 'approve') {
        const confirmed = await confirm({
          title: `确认对 Agent 绑定执行“${action}”？`,
          confirmText: '执行',
          tone: 'danger',
        })
        if (!confirmed) return
      }
      try {
        const result = await admin.runBindingAction(projectId, binding.id, action)
        await selectProject(projectId)
        toast.success(`绑定状态已更新${result.commandQueued ? '，同步命令已排队' : ''}。`)
      } catch (error) {
        report(error)
      }
    },
    [confirm, report, selectProject],
  )

  const retireTaskSpace = useCallback(
    async (taskSpace: AdminTaskSpace, reason = '') => {
      const projectId = accessProjectRef.current
      if (!projectId) return { ok: false, error: '先选择项目。' }
      try {
        await admin.retireProjectTaskSpace(projectId, taskSpace.id, reason)
        await selectProject(projectId)
        toast.success(`分支 ${taskSpace.branchName} 已弃用。`)
        return { ok: true }
      } catch (error) {
        report(error)
        return { ok: false, error: admin.formatError(error) }
      }
    },
    [report, selectProject],
  )

  const restoreTaskSpace = useCallback(
    async (taskSpace: AdminTaskSpace) => {
      const projectId = accessProjectRef.current
      if (!projectId) return { ok: false, error: '先选择项目。' }
      try {
        await admin.restoreProjectTaskSpace(projectId, taskSpace.id)
        await selectProject(projectId)
        toast.success(`分支 ${taskSpace.branchName} 已恢复。`)
        return { ok: true }
      } catch (error) {
        report(error)
        return { ok: false, error: admin.formatError(error) }
      }
    },
    [report, selectProject],
  )

  const purgeTaskSpace = useCallback(
    async (taskSpace: AdminTaskSpace, confirmation: string) => {
      const projectId = accessProjectRef.current
      if (!projectId) return { ok: false, error: '先选择项目。' }
      try {
        const result = await admin.purgeProjectTaskSpace(projectId, taskSpace.id, confirmation)
        await selectProject(projectId)
        toast.success(`分支 ${taskSpace.branchName} 已移除。`)
        return { ok: true, purge: result }
      } catch (error) {
        report(error)
        return { ok: false, error: admin.formatError(error) }
      }
    },
    [report, selectProject],
  )

  const purgeProject = useCallback(
    async (projectId: string, confirmation: string) => {
      try {
        const result = await admin.purgeProject(projectId, confirmation)
        await selectProject('')
        setRemovedProjectIds((current) => new Set(current).add(projectId))
        await reloadProjects(true)
        toast.success(`项目 ${result.projectName} 已移除，备份 ${result.backupName} 已创建。`)
        return { ok: true, purge: result }
      } catch (error) {
        report(error)
        return { ok: false, error: admin.formatError(error) }
      }
    },
    [reloadProjects, report, selectProject],
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
    taskSpaces,
    projectTeams,
    projectAudit,
    projectAuditHasMore,
    loadProjectAudit,
    saveMember,
    removeMember,
    inviteProjectTeam,
    removeProjectTeam,
    bindingAction,
    retireTaskSpace,
    restoreTaskSpace,
    purgeTaskSpace,
    purgeProject,
  }
}
