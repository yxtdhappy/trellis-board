import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { FolderGit2, Radar } from 'lucide-react'
import { toast } from 'sonner'
import { TRELLIS_AGENT_TOOLS } from '@shared/trellis-agent-tools.js'
import { formatError, readSshTrustChallenge } from '@/api/admin'
import type { RemoteProbeResult, SshTrustChallenge, SshTrustResult, TeamProject } from '@/api/admin'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SelectField } from '@/features/board/SelectField'
import type { AdminConsole } from '@/hooks/useAdminConsole'
import { formatTime } from '@/lib/admin-shared'
import { ApprovalForm, ApprovalSummary } from './ApproveProjectDialog'
import { MultiSelectField } from './MultiSelectField'
import { ProjectCredentialDialog } from './ProjectCredentialDialog'
import { EmptyRow, Field, Panel, Row, StatusPill } from './shared'
import { SshTrustDialog } from './SshTrustDialog'

const DEVELOPER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const AGENT_TOOL_LABELS = new Map(TRELLIS_AGENT_TOOLS.map((tool) => [tool.id, tool.label]))

const EMPTY_FORM = {
  remote: '',
  credentialId: '',
  name: '',
  branch: '',
  repositoryId: '',
  agentTools: [] as string[],
  leadUserId: '',
  leadTrellisDevId: '',
}

type ProbeEvidence = {
  remote: string
  credentialId: string
  branch: string
}

type SshRetry =
  | { kind: 'probe'; remote: string; credentialId: string; branch?: string }
  | { kind: 'project'; project: TeamProject; credentialId: string | null }

export function OnboardingTab({ console: consoleApi }: { console: AdminConsole }) {
  const {
    projects,
    reloadProjects,
    users,
    reloadUsers,
    connectProject,
    openApproval,
    pendingApproval,
    approveProject,
    projectAction,
    credentials,
    reloadCredentials,
    probeRemote,
    confirmSshTrust,
    changeProjectCredential,
    adminTeamId,
  } = consoleApi
  const activeUsers = users.filter((user) => user.status === 'active')
  const defaultLeadUserId = activeUsers[0]?.id ?? ''
  const [form, setForm] = useState(() => ({
    ...EMPTY_FORM,
    leadUserId: defaultLeadUserId,
  }))
  const [nameManual, setNameManual] = useState(false)
  const [branches, setBranches] = useState<string[]>([])
  const [branchQuery, setBranchQuery] = useState('')
  const [probe, setProbe] = useState<ProbeEvidence | null>(null)
  const [existingAgentTools, setExistingAgentTools] = useState<string[]>([])
  const [probeBusy, setProbeBusy] = useState(false)
  const [busy, setBusy] = useState(false)
  const [sshChallenge, setSshChallenge] = useState<SshTrustChallenge | null>(null)
  const [sshRetry, setSshRetry] = useState<SshRetry | null>(null)
  const [credentialProject, setCredentialProject] = useState<TeamProject | null>(null)
  const [credentialBusy, setCredentialBusy] = useState(false)
  const requestRef = useRef(0)

  useEffect(() => {
    if (adminTeamId && adminTeamId !== 'all' && users.length === 0) void reloadUsers(true)
  }, [adminTeamId, reloadUsers, users.length])

  const credentialOptions = [
    { value: '', label: '无需凭据（公开仓库）' },
    ...credentials.map((credential) => ({
      value: credential.id,
      label: `${credential.name} · ${credential.host} · ${credential.authType === 'https_token' ? 'HTTPS' : 'SSH'}`,
    })),
  ]
  const filteredBranches = branches.filter(
    (branch) =>
      !branchQuery.trim() ||
      branch.toLowerCase().includes(branchQuery.trim().toLowerCase()) ||
      branch === form.branch,
  )
  const branchOptions = filteredBranches.map((branch) => ({
    value: branch,
    label: branch,
  }))
  const agentToolOptions = TRELLIS_AGENT_TOOLS.map((tool) => ({
    value: tool.id,
    label: tool.label,
  }))
  const leadOptions = activeUsers.map((user) => ({
    value: user.id,
    label: `${user.displayName || user.username}（${user.username}）`,
  }))
  const leadUserId =
    form.leadUserId && activeUsers.some((user) => user.id === form.leadUserId)
      ? form.leadUserId
      : defaultLeadUserId
  const developerIdValid = DEVELOPER_ID_PATTERN.test(form.leadTrellisDevId.trim())
  const probeValid = Boolean(
    probe &&
    form.remote.trim() === probe.remote &&
    form.credentialId === probe.credentialId &&
    form.branch === probe.branch &&
    form.branch &&
    branches.includes(form.branch),
  )

  function resetProbe() {
    requestRef.current += 1
    setProbe(null)
    setBranches([])
    setBranchQuery('')
    setExistingAgentTools([])
    setProbeBusy(false)
  }

  function resetForm() {
    requestRef.current += 1
    setForm({
      ...EMPTY_FORM,
      agentTools: [],
      leadUserId: activeUsers[0]?.id ?? '',
    })
    setNameManual(false)
    setBranches([])
    setBranchQuery('')
    setProbe(null)
    setExistingAgentTools([])
    setProbeBusy(false)
  }

  async function runProbe(
    remote = form.remote.trim(),
    credentialId = form.credentialId,
    branch?: string,
  ) {
    if (!remote) {
      toast.error('请先填写 Git 远端 URL。')
      return
    }
    const requestId = requestRef.current + 1
    requestRef.current = requestId
    setProbe(null)
    setExistingAgentTools([])
    setForm((current) => ({ ...current, agentTools: [] }))
    if (!branch) {
      setBranches([])
      setBranchQuery('')
    }
    setProbeBusy(true)
    try {
      const result = await probeRemote({
        remoteUrl: remote,
        credentialId: credentialId || null,
        branch,
      })
      if (requestRef.current !== requestId) return
      applyProbeResult(result, remote, credentialId)
    } catch (error) {
      if (requestRef.current !== requestId) return
      const challenge = readSshTrustChallenge(error)
      if (challenge) {
        setSshRetry({ kind: 'probe', remote, credentialId, branch })
        setSshChallenge(challenge)
      } else {
        toast.error(formatError(error))
      }
    } finally {
      if (requestRef.current === requestId) setProbeBusy(false)
    }
  }

  function applyProbeResult(result: RemoteProbeResult, remote: string, credentialId: string) {
    setBranches(result.branches)
    setBranchQuery('')
    const branch = result.branch || result.defaultBranch || ''
    setExistingAgentTools(result.existingAgentTools)
    setProbe({ remote, credentialId, branch })
    setForm((current) => ({
      ...current,
      name: nameManual ? current.name : result.recommendedName,
      branch,
      agentTools: result.existingAgentTools,
    }))
  }

  function changeRemote(remote: string) {
    resetProbe()
    setForm((current) => ({
      ...current,
      remote,
      name: nameManual ? current.name : '',
      branch: '',
      agentTools: [],
    }))
  }

  function changeCredential(credentialId: string) {
    resetProbe()
    setForm((current) => ({
      ...current,
      credentialId,
      name: nameManual ? current.name : '',
      branch: '',
      agentTools: [],
    }))
  }

  function changeBranch(branch: string) {
    setExistingAgentTools([])
    setForm((current) => ({ ...current, branch, agentTools: [] }))
    void runProbe(form.remote.trim(), form.credentialId, branch)
  }

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!probeValid || !probe) {
      toast.error('请先选择凭据并成功识别远端分支。')
      return
    }
    if (!form.agentTools.length) {
      toast.error('请至少选择一个 Agent 工具。')
      return
    }
    if (!leadUserId || !developerIdValid) {
      toast.error('请选择首个负责人并填写合法的 Trellis developer ID。')
      return
    }
    setBusy(true)
    const connected = await connectProject({
      name: form.name.trim(),
      syncBranch: form.branch,
      remoteUrl: probe.remote,
      credentialId: probe.credentialId || null,
      repositoryId: form.repositoryId.trim(),
      agentTools: [...new Set([...existingAgentTools, ...form.agentTools])],
      leadUserId,
      leadTrellisDevId: form.leadTrellisDevId.trim(),
    })
    setBusy(false)
    if (connected) resetForm()
  }

  async function confirmHost(challengeId: string): Promise<SshTrustResult> {
    const result = await confirmSshTrust(challengeId)
    const retry = sshRetry
    setSshChallenge(null)
    setSshRetry(null)
    if (retry?.kind === 'probe') {
      await runProbe(retry.remote, retry.credentialId, retry.branch)
    } else if (retry?.kind === 'project') {
      await saveProjectCredential(retry.project, retry.credentialId)
    }
    return result
  }

  async function saveProjectCredential(project: TeamProject, credentialId: string | null) {
    setCredentialBusy(true)
    try {
      await changeProjectCredential(project.id, credentialId)
      await Promise.all([reloadProjects(true), reloadCredentials(true)])
      toast.success('项目 Git 凭据已更新。')
      setCredentialProject(null)
      return true
    } catch (error) {
      const challenge = readSshTrustChallenge(error)
      if (challenge) {
        setSshRetry({ kind: 'project', project, credentialId })
        setSshChallenge(challenge)
      } else {
        toast.error(formatError(error))
      }
      return false
    } finally {
      setCredentialBusy(false)
    }
  }

  return (
    <>
      <div className="grid gap-3.5 lg:grid-cols-[430px_minmax(0,1fr)]">
        <div className="flex flex-col gap-3.5">
          <Panel
            kicker="GIT / PROJECT ONBOARDING"
            title="新增或升级项目"
            description="识别远端后选择初始化工具和首个负责人，再确认工具链摘要。"
          >
            {adminTeamId === 'all' ? (
              <EmptyRow>请先在顶部选择一个具体团队，再接入项目。</EmptyRow>
            ) : null}
            <form
              className="flex flex-col gap-2"
              hidden={adminTeamId === 'all'}
              onSubmit={handleCreate}
            >
              <Field label="Git 远端 URL">
                <div className="flex items-center gap-1.5">
                  <Input
                    maxLength={2048}
                    required
                    autoComplete="off"
                    disabled={busy || probeBusy}
                    value={form.remote}
                    onChange={(event) => changeRemote(event.target.value)}
                  />
                  <Button
                    type="button"
                    size="sm"
                    className="shrink-0"
                    disabled={
                      !form.remote.trim() ||
                      probeBusy ||
                      busy ||
                      !adminTeamId ||
                      adminTeamId === 'all'
                    }
                    onClick={() => void runProbe()}
                  >
                    <Radar className={probeBusy ? 'size-3.5 animate-pulse' : 'size-3.5'} />
                    {probeBusy ? '识别中…' : '识别远端'}
                  </Button>
                </div>
              </Field>
              <Field label="Git 凭据">
                <SelectField
                  value={form.credentialId}
                  options={credentialOptions}
                  disabled={busy || probeBusy}
                  onChange={changeCredential}
                />
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="项目名称">
                  <Input
                    maxLength={80}
                    required
                    disabled={busy || probeBusy}
                    value={form.name}
                    onChange={(event) => {
                      setNameManual(true)
                      setForm({ ...form, name: event.target.value })
                    }}
                  />
                </Field>
                <Field
                  label="共享分支"
                  hint={probe && !branches.length ? '未识别到可用分支' : undefined}
                >
                  <SelectField
                    value={form.branch}
                    options={branchOptions}
                    placeholder={probe ? '选择真实分支' : '请先识别远端'}
                    disabled={busy || probeBusy || !branches.length}
                    onChange={changeBranch}
                  />
                </Field>
              </div>
              {branches.length > 8 ? (
                <Field label="筛选分支">
                  <Input
                    value={branchQuery}
                    placeholder="输入分支名筛选"
                    disabled={busy || probeBusy}
                    onChange={(event) => setBranchQuery(event.target.value)}
                  />
                </Field>
              ) : null}
              <Field
                label="Agent 工具"
                hint="至少选择一项；目标仓库缺少 .trellis 时会在接入过程中自动初始化。"
              >
                <MultiSelectField
                  value={form.agentTools}
                  lockedValues={existingAgentTools}
                  options={agentToolOptions}
                  placeholder="选择要初始化的 Agent 工具"
                  ariaLabel="Agent 工具"
                  disabled={busy || probeBusy}
                  onChange={(agentTools) => setForm((current) => ({ ...current, agentTools }))}
                />
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="首个负责人">
                  <SelectField
                    value={leadUserId}
                    options={leadOptions}
                    placeholder="没有 active 团队用户"
                    disabled={busy || probeBusy || activeUsers.length === 0}
                    onChange={(leadUserId) => setForm((current) => ({ ...current, leadUserId }))}
                  />
                </Field>
                <Field
                  label="负责人 Trellis developer ID"
                  hint={form.leadTrellisDevId && !developerIdValid ? '格式无效' : undefined}
                >
                  <Input
                    maxLength={64}
                    required
                    pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,63}"
                    disabled={busy || probeBusy}
                    value={form.leadTrellisDevId}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        leadTrellisDevId: event.target.value,
                      }))
                    }
                  />
                </Field>
              </div>
              <Field label="已有本地仓库 ID（可选）">
                <Input
                  maxLength={100}
                  disabled={busy || probeBusy}
                  value={form.repositoryId}
                  onChange={(event) => setForm({ ...form, repositoryId: event.target.value })}
                />
              </Field>
              <Button
                size="sm"
                type="submit"
                className="self-start"
                disabled={
                  busy ||
                  probeBusy ||
                  !probeValid ||
                  !form.name.trim() ||
                  !form.agentTools.length ||
                  !leadUserId ||
                  !developerIdValid
                }
              >
                {busy ? '接入与初始化中…' : '克隆、初始化并检查工具链'}
              </Button>
            </form>
          </Panel>

          <Panel
            kicker="TOOLCHAIN / APPROVAL"
            title="批准项目接入"
            description="批准后服务端会运行已批准工具链的 hooks 预检；摘要变化会要求重新批准。"
          >
            {pendingApproval ? (
              <>
                <p className="text-xs text-foreground">
                  {pendingApproval.project.name || pendingApproval.project.id} ·{' '}
                  {pendingApproval.project.syncBranch || '共享分支未返回'}
                </p>
                <ApprovalSummary sha256={pendingApproval.sha256} files={pendingApproval.files} />
                <ApprovalForm
                  key={pendingApproval.project.id}
                  users={users}
                  defaultLeadUserId={pendingApproval.project.bootstrapLeadUserId}
                  defaultLeadTrellisDevId={pendingApproval.project.bootstrapLeadTrellisDevId}
                  agentTools={pendingApproval.project.agentTools}
                  onSubmit={(values) => approveProject(values)}
                />
              </>
            ) : (
              <EmptyRow>先克隆并检查项目工具链，或从列表点击「批准接入」。</EmptyRow>
            )}
          </Panel>
        </div>

        <Panel
          kicker="REGISTERED PROJECTS"
          title="已接入项目"
          action={
            <Button variant="outline" size="sm" type="button" onClick={() => void reloadProjects()}>
              刷新
            </Button>
          }
        >
          <div className="flex flex-col">
            {projects.length === 0 ? (
              <EmptyRow>尚未接入团队项目。</EmptyRow>
            ) : (
              projects.map((project) => {
                const canApprove = project.syncStatus === 'provisioning' || !project.scriptsSha256
                const canRepair = project.syncStatus === 'needs_repair'
                const canRefresh = !['disabled', 'provisioning'].includes(project.syncStatus)
                const canDisable = project.syncStatus !== 'disabled'
                return (
                  <Row
                    key={project.id}
                    actions={
                      <>
                        {canApprove ? (
                          <Button
                            size="sm"
                            type="button"
                            onClick={() => void openApproval(project)}
                          >
                            批准接入
                          </Button>
                        ) : null}
                        <Button
                          variant="outline"
                          size="sm"
                          type="button"
                          onClick={() => setCredentialProject(project)}
                        >
                          更换凭据
                        </Button>
                        {canRefresh ? (
                          <Button
                            variant="outline"
                            size="sm"
                            type="button"
                            onClick={() => void projectAction(project, 'refresh')}
                          >
                            刷新 Git
                          </Button>
                        ) : null}
                        {canRepair ? (
                          <Button
                            variant="outline"
                            size="sm"
                            type="button"
                            onClick={() => void projectAction(project, 'repair')}
                          >
                            尝试修复
                          </Button>
                        ) : null}
                        {canDisable ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            type="button"
                            className="text-destructive"
                            onClick={() => void projectAction(project, 'disable')}
                          >
                            停用项目
                          </Button>
                        ) : null}
                      </>
                    }
                  >
                    <div className="flex items-start gap-2">
                      <FolderGit2 className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <strong className="truncate text-xs font-medium">{project.name}</strong>
                          <StatusPill value={project.syncStatus} />
                          {project.stale ? (
                            <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">
                              需要关注
                            </span>
                          ) : null}
                        </div>
                        <p className="truncate text-[10px] text-muted-foreground">
                          <code>{project.id}</code> · 共享分支{' '}
                          <code>{project.syncBranch || '未配置'}</code>
                        </p>
                        <p className="truncate text-[10px] text-muted-foreground">
                          Git 凭据 {project.credential?.name || '无需凭据'}
                        </p>
                        <p className="truncate text-[10px] text-muted-foreground">
                          Agent 工具{' '}
                          {project.agentTools.length
                            ? project.agentTools
                                .map((tool) => AGENT_TOOL_LABELS.get(tool) || tool)
                                .join('、')
                            : '未记录'}
                        </p>
                        <p className="truncate text-[10px] text-muted-foreground">
                          工具链摘要 <code>{project.scriptsSha256 || '尚未批准'}</code>
                        </p>
                        <p className="truncate text-[10px] text-muted-foreground">
                          hooks 状态 {project.hooksStatus || '核心项目接口暂未暴露 hooks 状态'}
                        </p>
                        <p className="truncate text-[10px] text-muted-foreground">
                          最近 fetch {formatTime(project.lastFetchAt)} · push{' '}
                          {formatTime(project.lastPushAt)}
                        </p>
                        {project.lastError ? (
                          <p className="text-[10px] text-destructive">{project.lastError}</p>
                        ) : null}
                      </div>
                    </div>
                  </Row>
                )
              })
            )}
          </div>
        </Panel>
      </div>

      <SshTrustDialog
        challenge={sshChallenge}
        onConfirm={confirmHost}
        onClose={() => {
          setSshChallenge(null)
          setSshRetry(null)
        }}
      />
      {credentialProject ? (
        <ProjectCredentialDialog
          key={credentialProject.id}
          project={credentialProject}
          credentials={credentials}
          busy={credentialBusy}
          onSave={(credentialId) => saveProjectCredential(credentialProject, credentialId)}
          onClose={() => {
            if (!credentialBusy) setCredentialProject(null)
          }}
        />
      ) : null}
    </>
  )
}
