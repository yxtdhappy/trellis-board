import { useState } from 'react'
import type { FormEvent } from 'react'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { AdminConsole } from '@/hooks/useAdminConsole'
import type { ProjectMember } from '@/api/admin'
import { formatTime } from '@/lib/admin-shared'
import { BranchManagementPanel } from './BranchManagementPanel'
import { AuditItem, EmptyRow, Field, Panel, Row, StatusPill, controlClass } from './shared.tsx'
import { SelectField } from '@/features/board/SelectField'

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
              className={controlClass}
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
              size="sm"
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
            <span className="text-[0.6875rem] font-semibold text-muted-foreground">
              {members.length}
            </span>
          }
        >
          <form className="flex flex-col gap-2" onSubmit={handleSaveMember}>
            <Field label="用户 ID">
              <Input
                maxLength={100}
                required
                placeholder="管理员可复制用户 ID"
                value={userId}
                onChange={(event) => setUserId(event.target.value)}
              />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="角色">
                <SelectField
                  className={controlClass}
                  value={role}
                  options={[
                    { value: 'member', label: '成员' },
                    { value: 'lead', label: '负责人' },
                    { value: 'read_only', label: '只读' },
                  ]}
                  onChange={setRole}
                />
              </Field>
              <Field label="Trellis developer ID">
                <Input
                  maxLength={100}
                  placeholder="只读角色可留空"
                  disabled={readOnly}
                  required={!readOnly}
                  value={developerId}
                  onChange={(event) => setDeveloperId(event.target.value)}
                />
              </Field>
            </div>
            <Button size="sm" type="submit" className="self-start">
              保存成员
            </Button>
          </form>
          <p className="text-[0.6875rem] leading-relaxed text-muted-foreground">
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
                        <StatusPill value={member.role} />
                        <StatusPill value={member.status} />
                      </div>
                      <p className="truncate text-[0.625rem] text-muted-foreground">
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
              className={controlClass}
              value={inviteTeamId}
              placeholder="选择要邀请的团队"
              options={teams
                .filter((team) => !projectTeams.some((access) => access.teamId === team.id))
                .map((team) => ({ value: team.id, label: team.name }))}
              onChange={setInviteTeamId}
            />
            <SelectField
              ariaLabel="团队访问角色"
              className={controlClass}
              value={accessRole}
              options={[
                { value: 'member', label: '成员团队' },
                { value: 'owner', label: '共同所有者' },
              ]}
              onChange={setAccessRole}
            />
            <Button
              size="sm"
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
                      <span className="px-2 text-[0.625rem] text-muted-foreground">所有者团队</span>
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
                    <StatusPill value={access.accessRole} />
                    <StatusPill value={access.teamStatus} />
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
              size="sm"
              type="button"
              className="rounded-full"
              onClick={() => void createPairingCode(selectedTeamId || undefined)}
            >
              生成我的配对码
            </Button>
          }
        >
          <p className="text-[0.6875rem] text-muted-foreground">配对码只在响应中显示一次。</p>
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
                      <StatusPill value={binding.status} />
                      {binding.agentStatus ? <StatusPill value={binding.agentStatus} /> : null}
                    </div>
                    <p className="truncate text-[0.625rem] text-muted-foreground">
                      所有者 {binding.ownerDisplayName || binding.ownerUsername || '未知'} · 分支{' '}
                      <code>{binding.branchName || '未返回'}</code>
                    </p>
                    <p className="truncate text-[0.625rem] text-muted-foreground">
                      仓库 <code>{binding.displayName || binding.localRepoKey || '未返回'}</code>
                    </p>
                    <p className="truncate text-[0.625rem] text-muted-foreground">
                      最近心跳 {formatTime(binding.lastSeenAt)} · 同步{' '}
                      {formatTime(binding.lastSyncedAt)}
                    </p>
                    {binding.lastError ? (
                      <p className="text-[0.625rem] text-destructive">{binding.lastError}</p>
                    ) : null}
                  </div>
                </Row>
              ))
            )}
          </div>
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
