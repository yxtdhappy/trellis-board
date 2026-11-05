import { useState } from 'react'
import type { FormEvent } from 'react'
import { FolderGit2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { AdminConsole } from '@/hooks/useAdminConsole'
import { formatTime } from '@/lib/admin-shared'
import { ApprovalForm, ApprovalSummary } from './ApproveProjectDialog'
import { EmptyRow, Field, Panel, Row, StatusPill } from './shared'

const EMPTY_FORM = { name: '', branch: '', remote: '', repositoryId: '' }

export function OnboardingTab({ console: consoleApi }: { console: AdminConsole }) {
  const {
    projects,
    reloadProjects,
    users,
    connectProject,
    openApproval,
    pendingApproval,
    approveProject,
    projectAction
  } = consoleApi
  const [form, setForm] = useState(EMPTY_FORM)
  const [busy, setBusy] = useState(false)

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    const connected = await connectProject({
      name: form.name.trim(),
      syncBranch: form.branch.trim(),
      remoteUrl: form.remote,
      repositoryId: form.repositoryId.trim()
    })
    setBusy(false)
    if (connected) setForm(EMPTY_FORM)
  }

  return (
    <div className="grid gap-3.5 lg:grid-cols-[430px_minmax(0,1fr)]">
      <div className="flex flex-col gap-3.5">
        <Panel
          kicker="GIT / PROJECT ONBOARDING"
          title="新增或升级项目"
          description="克隆共享分支后先确认脚本工具链摘要，再指定首个负责人启用项目。"
        >
          <form className="flex flex-col gap-2" onSubmit={handleCreate}>
            <div className="grid grid-cols-2 gap-2">
              <Field label="项目名称">
                <Input
                  maxLength={100}
                  required
                  disabled={busy}
                  value={form.name}
                  onChange={(event) => setForm({ ...form, name: event.target.value })}
                />
              </Field>
              <Field label="共享分支">
                <Input
                  maxLength={200}
                  required
                  placeholder="main"
                  disabled={busy}
                  value={form.branch}
                  onChange={(event) => setForm({ ...form, branch: event.target.value })}
                />
              </Field>
            </div>
            <Field label="Git 远端 URL">
              <Input
                maxLength={2048}
                required
                autoComplete="off"
                disabled={busy}
                value={form.remote}
                onChange={(event) => setForm({ ...form, remote: event.target.value })}
              />
            </Field>
            <Field label="已有本地仓库 ID（可选）">
              <Input
                maxLength={100}
                disabled={busy}
                value={form.repositoryId}
                onChange={(event) => setForm({ ...form, repositoryId: event.target.value })}
              />
            </Field>
            <Button size="sm" type="submit" className="self-start" disabled={busy}>
              克隆并检查工具链
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
  )
}
