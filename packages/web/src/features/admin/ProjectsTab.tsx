import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { toast } from 'sonner'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { AdminConsole } from '@/hooks/useAdminConsole'
import type { ProjectMember } from '@/api/admin'
import {
  addBinding,
  listBindings,
  listTeamPlugins,
  removeBinding,
  type PluginBindingView,
  type TeamPluginView,
} from '@/api/team-plugins'
import { formatTime, statusTone } from '@/lib/admin-shared'
import { BranchManagementPanel } from './BranchManagementPanel'
import { StatusPill } from '@/components/ui/status-pill'
import { EmptyRow } from '@/components/ui/empty-row'
import { AuditItem, Row } from './shared.tsx'
import { SelectField } from '@/features/board/SelectField'
import { Panel } from '@/components/ui/panel'
import { Field, FieldLabel } from '@/components/ui/field'
import { PluginBindingForm } from './PluginBindingForm.tsx'
import type { BindingDraft } from './PluginBindingForm.tsx'

export function ProjectsTab({ console: consoleApi }: { console: AdminConsole }) {
  const {
    projectOptions,
    accessProjectId,
    selectProject,
    refreshAccess,
    members,
    bindings,
    taskSpaces,
    projectTeams,
    teams,
    projectAudit,
    projectAuditHasMore,
    loadProjectAudit,
    saveMember,
    removeMember,
    inviteProjectTeam,
    removeProjectTeam,
    retireTaskSpace,
    restoreTaskSpace,
    purgeTaskSpace,
    createPairingCode,
  } = consoleApi

  const [userId, setUserId] = useState('')
  const [role, setRole] = useState('member')
  const [developerId, setDeveloperId] = useState('')
  const [inviteTeamId, setInviteTeamId] = useState('')
  const [accessRole, setAccessRole] = useState('member')
  const readOnly = role === 'read_only'
  const selectedTeamId = projectOptions.find((project) => project.id === accessProjectId)?.teamId

  /**
   * 插件项目绑定（design.md §7.4）：项目设置页的快捷入口，只处理当前项目，
   * 绑定关系本身仍存在 `/api/plugins/<id>/bindings`，与 admin 插件页是同一份数据。
   */
  const [pluginChoices, setPluginChoices] = useState<TeamPluginView[]>([])
  const [pluginId, setPluginId] = useState('')
  const [pluginBindings, setPluginBindings] = useState<PluginBindingView[]>([])
  const [pluginBusy, setPluginBusy] = useState(false)
  const [pluginForm, setPluginForm] = useState<BindingDraft>({
    externalProjectId: '',
    externalProjectName: '',
  })

  useEffect(() => {
    if (!selectedTeamId) {
      setPluginChoices([])
      setPluginId('')
      return
    }
    void listTeamPlugins(selectedTeamId)
      .then((rows) => {
        const available = rows.filter((row) => row.teamEnabled || row.enabled)
        setPluginChoices(available)
        setPluginId((current) =>
          available.some((row) => row.id === current) ? current : (available[0]?.id ?? ''),
        )
      })
      .catch(() => setPluginChoices([]))
  }, [selectedTeamId])

  const reloadPluginBindings = useCallback(async () => {
    if (!selectedTeamId || !pluginId || !accessProjectId) {
      setPluginBindings([])
      return
    }
    const rows = await listBindings(pluginId, selectedTeamId)
    setPluginBindings(rows.filter((row) => row.projectId === accessProjectId))
  }, [accessProjectId, pluginId, selectedTeamId])

  useEffect(() => {
    void reloadPluginBindings().catch(() => setPluginBindings([]))
  }, [reloadPluginBindings])

  async function runPluginBinding(action: () => Promise<void>, message: string) {
    if (pluginBusy) return
    setPluginBusy(true)
    try {
      await action()
      toast.success(message)
      await reloadPluginBindings()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '操作失败')
    } finally {
      setPluginBusy(false)
    }
  }

  async function handleSaveMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const saved = await saveMember({
      userId: userId.trim(),
      role,
      trellisDevId: readOnly ? null : developerId.trim() || null,
    })
    if (saved) {
      setUserId('')
      setDeveloperId('')
    }
  }

  function editMember(member: ProjectMember) {
    setUserId(member.userId || '')
    setRole(member.role || 'member')
    setDeveloperId(member.trellisDevId || '')
  }

  return (
    <div className="grid gap-3.5 lg:grid-cols-[420px_minmax(0,1fr)]">
      <div className="flex flex-col gap-3.5">
        <Panel
          kicker="PROJECT / PEOPLE & AGENTS"
          title="选择项目"
          description="选择有管理权限的项目，维护成员 developer ID、确认 Agent 绑定并查看项目审计。"
        >
          <div className="flex items-center gap-2">
            <SelectField
              ariaLabel="项目"
              value={accessProjectId}
              placeholder="请选择项目"
              options={projectOptions.map((project) => ({
                value: project.id,
                label: `${project.name} · ${project.syncStatus}`,
              }))}
              onChange={(next) => void selectProject(next)}
            />
            <Button
              variant="outline"
              type="button"
              disabled={!accessProjectId}
              onClick={refreshAccess}
            >
              刷新项目数据
            </Button>
          </div>
        </Panel>

        <Panel
          kicker="MEMBERS"
          title="项目成员"
          action={
            <span className="text-xs font-semibold text-muted-foreground">{members.length}</span>
          }
        >
          <form className="flex flex-col gap-2" onSubmit={handleSaveMember}>
            <Field className="gap-1">
              <FieldLabel
                htmlFor="member-user-id"
                className="text-xs font-medium text-muted-foreground"
              >
                用户 ID
              </FieldLabel>
              <Input
                id="member-user-id"
                maxLength={100}
                required
                placeholder="管理员可复制用户 ID"
                value={userId}
                onChange={(event) => setUserId(event.target.value)}
              />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field className="gap-1">
                <FieldLabel
                  htmlFor="member-role"
                  className="text-xs font-medium text-muted-foreground"
                >
                  角色
                </FieldLabel>
                <SelectField
                  id="member-role"
                  value={role}
                  options={[
                    { value: 'member', label: '成员' },
                    { value: 'lead', label: '负责人' },
                    { value: 'read_only', label: '只读' },
                  ]}
                  onChange={setRole}
                />
              </Field>
              <Field className="gap-1">
                <FieldLabel
                  htmlFor="member-developer-id"
                  className="text-xs font-medium text-muted-foreground"
                >
                  Trellis developer ID
                </FieldLabel>
                <Input
                  id="member-developer-id"
                  maxLength={100}
                  placeholder="只读角色可留空"
                  disabled={readOnly}
                  required={!readOnly}
                  value={developerId}
                  onChange={(event) => setDeveloperId(event.target.value)}
                />
              </Field>
            </div>
            <Button type="submit" className="self-start">
              保存成员
            </Button>
          </form>
          <p className="text-xs leading-relaxed text-muted-foreground">
            负责人和成员必须映射 developer ID；停用账号或最后一名负责人保护由服务端校验。
          </p>
          <div className="flex flex-col">
            {!accessProjectId ? (
              <EmptyRow>先选择项目。</EmptyRow>
            ) : members.length === 0 ? (
              <EmptyRow>项目还没有成员。</EmptyRow>
            ) : (
              members.map((member) => (
                <Row
                  key={member.userId || member.trellisDevId || member.username}
                  actions={
                    <>
                      <Button
                        variant="ghost"
                        size="sm"
                        type="button"
                        onClick={() => editMember(member)}
                      >
                        编辑
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        type="button"
                        className="text-destructive"
                        onClick={() => void removeMember(member)}
                      >
                        移除
                      </Button>
                    </>
                  }
                >
                  <div className="flex items-center gap-2">
                    <Avatar size="sm">
                      <AvatarFallback>
                        {(member.displayName || member.username || '?').slice(0, 1)}
                      </AvatarFallback>
                    </Avatar>
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <strong className="truncate text-xs font-medium">
                          {member.displayName || member.username || member.userId}
                        </strong>
                        <StatusPill tone={statusTone(member.role)}>
                          {member.role || 'unknown'}
                        </StatusPill>
                        <StatusPill tone={statusTone(member.status)}>
                          {member.status || 'unknown'}
                        </StatusPill>
                      </div>
                      <p className="truncate text-2xs text-muted-foreground">
                        用户 <code>{member.userId || '未知'}</code> · developer{' '}
                        <code>{member.trellisDevId || '未配置'}</code>
                      </p>
                    </div>
                  </div>
                </Row>
              ))
            )}
          </div>
        </Panel>
      </div>

      <div className="flex flex-col gap-3.5">
        <BranchManagementPanel
          projectSelected={Boolean(accessProjectId)}
          taskSpaces={taskSpaces}
          onRetire={retireTaskSpace}
          onRestore={restoreTaskSpace}
          onPurge={purgeTaskSpace}
        />

        <Panel
          kicker="TEAM ACCESS"
          title="跨团队访问"
          description="同一个 Git 项目只保留一个全局任务空间；邀请其他团队不会复制项目或任务。"
        >
          <div className="grid grid-cols-[minmax(0,1fr)_110px_auto] gap-2">
            <SelectField
              ariaLabel="邀请团队"
              value={inviteTeamId}
              placeholder="选择要邀请的团队"
              options={teams
                .filter((team) => !projectTeams.some((access) => access.teamId === team.id))
                .map((team) => ({ value: team.id, label: team.name }))}
              onChange={setInviteTeamId}
            />
            <SelectField
              ariaLabel="团队访问角色"
              value={accessRole}
              options={[
                { value: 'member', label: '成员团队' },
                { value: 'owner', label: '共同所有者' },
              ]}
              onChange={setAccessRole}
            />
            <Button
              type="button"
              disabled={!accessProjectId || !inviteTeamId}
              onClick={() => {
                void inviteProjectTeam(inviteTeamId, accessRole)
                setInviteTeamId('')
              }}
            >
              邀请
            </Button>
          </div>
          <div className="flex flex-col">
            {!accessProjectId ? (
              <EmptyRow>先选择项目。</EmptyRow>
            ) : projectTeams.length === 0 ? (
              <EmptyRow>暂无团队访问记录。</EmptyRow>
            ) : (
              projectTeams.map((access) => (
                <Row
                  key={access.teamId}
                  actions={
                    access.accessRole === 'owner' ? (
                      <span className="px-2 text-2xs text-muted-foreground">所有者团队</span>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        type="button"
                        className="text-destructive"
                        onClick={() => void removeProjectTeam(access)}
                      >
                        移除
                      </Button>
                    )
                  }
                >
                  <div className="flex items-center gap-1.5">
                    <strong className="text-xs font-medium">{access.teamName}</strong>
                    <StatusPill tone={statusTone(access.accessRole)}>
                      {access.accessRole || 'unknown'}
                    </StatusPill>
                    <StatusPill tone={statusTone(access.teamStatus)}>
                      {access.teamStatus || 'unknown'}
                    </StatusPill>
                  </div>
                </Row>
              ))
            )}
          </div>
        </Panel>

        <Panel
          kicker="AGENT BINDINGS"
          title="Agent 绑定"
          action={
            <Button
              variant="outline"
              type="button"
              className="rounded-full"
              onClick={() => void createPairingCode(selectedTeamId || undefined)}
            >
              生成我的配对码
            </Button>
          }
        >
          <p className="text-xs text-muted-foreground">配对码只在响应中显示一次。</p>
          <div className="flex flex-col">
            {!accessProjectId ? (
              <EmptyRow>先选择项目。</EmptyRow>
            ) : bindings.length === 0 ? (
              <EmptyRow>暂无 Agent 绑定。</EmptyRow>
            ) : (
              bindings.map((binding) => (
                <Row key={binding.id}>
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <div className="flex items-center gap-1.5">
                      <strong className="truncate text-xs font-medium">
                        {binding.deviceName || binding.agentId}
                      </strong>
                      <StatusPill tone={statusTone(binding.status)}>
                        {binding.status || 'unknown'}
                      </StatusPill>
                      {binding.agentStatus ? (
                        <StatusPill tone={statusTone(binding.agentStatus)}>
                          {binding.agentStatus || 'unknown'}
                        </StatusPill>
                      ) : null}
                    </div>
                    <p className="truncate text-2xs text-muted-foreground">
                      所有者 {binding.ownerDisplayName || binding.ownerUsername || '未知'} · 分支{' '}
                      <code>{binding.branchName || '未返回'}</code>
                    </p>
                    <p className="truncate text-2xs text-muted-foreground">
                      仓库 <code>{binding.displayName || binding.localRepoKey || '未返回'}</code>
                    </p>
                    <p className="truncate text-2xs text-muted-foreground">
                      最近心跳 {formatTime(binding.lastSeenAt)} · 同步{' '}
                      {formatTime(binding.lastSyncedAt)}
                    </p>
                    {binding.lastError ? (
                      <p className="text-2xs text-destructive">{binding.lastError}</p>
                    ) : null}
                  </div>
                </Row>
              ))
            )}
          </div>
        </Panel>

        <Panel
          kicker="PLUGIN BINDINGS"
          title="插件项目绑定"
          description="把当前项目和插件里的项目对上，成员在插件面板里选项目时不用再猜。只影响绑定关系，不影响任务数据。"
        >
          {!accessProjectId ? (
            <EmptyRow>先选择项目。</EmptyRow>
          ) : !selectedTeamId || pluginChoices.length === 0 ? (
            <EmptyRow>这个团队还没有为项目启用插件，先去「插件」页启用。</EmptyRow>
          ) : (
            <>
              {pluginChoices.length > 1 ? (
                <Field className="gap-1">
                  <FieldLabel
                    htmlFor="binding-plugin"
                    className="text-xs font-medium text-muted-foreground"
                  >
                    插件
                  </FieldLabel>
                  <SelectField
                    id="binding-plugin"
                    ariaLabel="插件"
                    value={pluginId}
                    options={pluginChoices.map((row) => ({ value: row.id, label: row.name }))}
                    onChange={setPluginId}
                  />
                </Field>
              ) : null}
              <div className="flex flex-col">
                {pluginBindings.length === 0 ? (
                  <EmptyRow>当前项目还没有绑定插件侧项目。</EmptyRow>
                ) : (
                  pluginBindings.map((binding) => (
                    <Row
                      key={binding.id}
                      actions={
                        <Button
                          variant="ghost"
                          size="sm"
                          type="button"
                          className="text-destructive"
                          disabled={pluginBusy}
                          onClick={() =>
                            void runPluginBinding(
                              () => removeBinding(binding.pluginId, binding.teamId, binding.id),
                              '已解除绑定',
                            )
                          }
                        >
                          解除
                        </Button>
                      }
                    >
                      <p className="text-xs font-semibold text-foreground">
                        插件项目：{binding.externalProjectName || binding.externalProjectId}
                      </p>
                      <p className="text-2xs text-muted-foreground">
                        {binding.externalProjectId} · 绑定于 {formatTime(binding.createdAt)}
                      </p>
                    </Row>
                  ))
                )}
              </div>
              <PluginBindingForm
                className="mt-1"
                submitProps={{ size: 'sm', className: 'self-start' }}
                draft={pluginForm}
                onChange={setPluginForm}
                disabled={pluginBusy || !pluginId}
                onSubmit={() =>
                  void runPluginBinding(async () => {
                    await addBinding(pluginId, selectedTeamId, {
                      projectId: accessProjectId,
                      externalProjectId: pluginForm.externalProjectId.trim(),
                      externalProjectName: pluginForm.externalProjectName.trim(),
                    })
                    setPluginForm({ externalProjectId: '', externalProjectName: '' })
                  }, '已绑定插件项目')
                }
              />
            </>
          )}
        </Panel>

        <Panel
          kicker="PROJECT AUDIT"
          title="项目审计"
          action={
            accessProjectId && projectAuditHasMore ? (
              <Button
                variant="outline"
                size="sm"
                type="button"
                onClick={() => void loadProjectAudit(false)}
              >
                加载更多
              </Button>
            ) : null
          }
        >
          {!accessProjectId ? (
            <EmptyRow>请选择一个有管理权限的项目。</EmptyRow>
          ) : projectAudit.length === 0 ? (
            <EmptyRow>暂无审计事件。</EmptyRow>
          ) : (
            <div className="flex flex-col">
              {projectAudit.map((event) => (
                <AuditItem key={event.id} event={event} />
              ))}
            </div>
          )}
        </Panel>
      </div>
    </div>
  )
}
