import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useConfirm } from '@/components/ui/confirm-dialog'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { TRELLIS_VISIBLE_AGENT_TOOLS } from '@trellis-board/shared/trellis-agent-tools.js'
import { sameLocalRepositoryPath } from '@/lib/onboarding-associations.js'
import { pickProjectTrellisDevId } from '@/lib/team-client.js'
import { normalizeProjectInspection, type ProjectInspection } from '@/lib/project-inspection.js'
import {
  normalizePushState,
  onboardingErrorMessage,
  preflightBlockReason,
} from '@/lib/onboarding-probe.js'
import { AgentToolSelector } from './AgentToolSelector.tsx'
import { OnboardingSkeleton } from './OnboardingSkeleton.tsx'
import {
  normalizeAssociation,
  normalizePreflight,
  stateLabel,
} from './project-onboarding-normalize.ts'
import type {
  Association,
  InitialSyncMode,
  PreflightResult,
  ProjectOnboardingDialogProps,
  PushState,
} from './project-onboarding-types.ts'
import { SelectField } from '../SelectField.tsx'
import { Empty, EmptyDescription } from '@/components/ui/empty'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { toneSurface } from '@/components/ui/status-pill'
import { Field, FieldError, FieldLabel } from '@/components/ui/field'

type OnboardingFeedback = { tone: 'status' | 'error'; text: string } | null

export function ProjectOnboardingDialog({
  open,
  onOpenChange,
  path,
  projects,
  teams,
  defaultTeamId,
  defaultDeveloperId,
  invoke,
  onAssociated,
}: ProjectOnboardingDialogProps) {
  const confirm = useConfirm()
  const [inspection, setInspection] = useState<ProjectInspection | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [reloadToken, setReloadToken] = useState(0)
  const [teamId, setTeamId] = useState('')
  const [developerId, setDeveloperId] = useState('')
  const [selectedTools, setSelectedTools] = useState<string[]>([])
  const [agentSearch, setAgentSearch] = useState('')
  const [push, setPush] = useState<PushState | null>(null)
  const [preflight, setPreflight] = useState<PreflightResult | null>(null)
  const [localAssociations, setLocalAssociations] = useState<Association[]>([])
  const [associationsLoaded, setAssociationsLoaded] = useState(false)
  const [associationLoadError, setAssociationLoadError] = useState('')
  const [feedback, setFeedback] = useState<OnboardingFeedback>(null)
  const [busy, setBusy] = useState(false)
  const [requiresInitialPush, setRequiresInitialPush] = useState(false)
  const pushCheckInFlight = useRef(false)
  const pushActionSeq = useRef(0)
  const developerIdEdited = useRef(false)
  const defaultsKey = useRef('')
  const dialogHeaderRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) {
      defaultsKey.current = ''
      return
    }
    setInspection(null)
    setSelectedTools([])
    setAgentSearch('')
    setPush(null)
    setPreflight(null)
    setFeedback(null)
    setBusy(false)
    setRequiresInitialPush(false)
  }, [open, path])

  useEffect(() => {
    if (!open) return
    if (defaultsKey.current === path) return
    defaultsKey.current = path
    const preferredTeam = teams.some((team) => team.id === defaultTeamId)
      ? defaultTeamId
      : teams[0]?.id || ''
    setTeamId(preferredTeam)
    developerIdEdited.current = false
    setDeveloperId(defaultDeveloperId.trim())
  }, [open, path, teams, defaultTeamId, defaultDeveloperId])

  useEffect(() => {
    if (!open || !path.trim()) return
    let cancelled = false
    setLoading(true)
    setLoadError('')
    void invoke('inspect_local_project', { path })
      .then((value) => {
        if (cancelled) {
          void invoke('cancel_pending_project').catch(() => {})
          return
        }
        const next = normalizeProjectInspection(value)
        if (!next) {
          setLoadError('没有读取到有效的本地 Git 仓库，请重新选择仓库根目录。')
          setLoading(false)
          return
        }
        setSelectedTools(next.existingAgentTools.filter((id) => id === 'codex'))
        setRequiresInitialPush(Boolean(next.hasTrellis && !next.hasCommittedTrellis))
        setInspection(next)
        setLoading(false)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setLoadError(onboardingErrorMessage(error, '无法读取本地项目'))
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, path, reloadToken, invoke])

  const preferredDeveloperId =
    inspection?.developerName.trim() ||
    pickProjectTrellisDevId(projects, inspection?.remoteIdentityKey, defaultDeveloperId.trim())

  useEffect(() => {
    if (!open || developerIdEdited.current) return
    setDeveloperId(preferredDeveloperId)
  }, [open, path, preferredDeveloperId])

  useEffect(() => {
    if (!open) {
      setLocalAssociations([])
      setAssociationsLoaded(false)
      setAssociationLoadError('')
      return
    }
    let cancelled = false
    setAssociationsLoaded(false)
    setAssociationLoadError('')
    void invoke('list_local_associations')
      .then((value) => {
        if (cancelled) return
        setLocalAssociations(
          Array.isArray(value)
            ? value.map(normalizeAssociation).filter((item): item is Association => Boolean(item))
            : [],
        )
        setAssociationsLoaded(true)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setAssociationLoadError(onboardingErrorMessage(error, '无法读取当前设备的本地项目关联'))
      })
    return () => {
      cancelled = true
    }
  }, [open, path, invoke])

  const missingTools = useMemo(
    () =>
      inspection
        ? TRELLIS_VISIBLE_AGENT_TOOLS.filter(
            (tool) => !inspection.existingAgentTools.includes(tool.id),
          )
        : [],
    [inspection],
  )
  const needsInitialization =
    !inspection?.hasTrellis ||
    !inspection?.hasTasks ||
    Boolean(inspection && missingTools.some((tool) => selectedTools.includes(tool.id)))
  const requiresPushCheck = requiresInitialPush
  const pushReady = push?.state === 'ready'
  const preflightBlockedReason = inspection
    ? preflightBlockReason({
        hasTrellis: inspection.hasTrellis,
        hasTasks: inspection.hasTasks,
        requiresPushCheck,
        pushState: push?.state,
      })
    : ''
  const replacedAssociations = useMemo(
    () =>
      inspection
        ? localAssociations.filter(
            (association) =>
              association.status !== 'revoked' &&
              association.status !== 'rejected' &&
              association.branchName !== inspection.branchName &&
              sameLocalRepositoryPath(association.repoPath, inspection.root),
          )
        : [],
    [inspection, localAssociations],
  )

  function toggleTool(id: string) {
    setPreflight(null)
    setSelectedTools((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    )
    setFeedback(null)
  }

  async function initialize() {
    if (!inspection) return
    if (!developerId.trim()) {
      setFeedback({ tone: 'error', text: '请填写 Trellis developer ID。' })
      return
    }
    if (!selectedTools.length) {
      setFeedback({ tone: 'error', text: '请至少选择一个本机需要使用的编码 Agent。' })
      return
    }
    setBusy(true)
    setFeedback(null)
    setPreflight(null)
    const initializesTaskTree = !inspection.hasTrellis || !inspection.hasTasks
    const needsInitialPush = requiresInitialPush || initializesTaskTree
    try {
      const result = await invoke('initialize_pending_project', {
        developerId: developerId.trim(),
        agentTools: selectedTools,
      })
      const next = normalizeProjectInspection(result)
      if (!next) throw new Error('初始化后没有返回有效项目信息')
      setInspection(next)
      setRequiresInitialPush(needsInitialPush)
      setPush(null)
      setPreflight(null)
      setFeedback({
        tone: 'status',
        text: needsInitialPush
          ? 'Trellis 初始化完成。请提交并推送共享初始化文件。'
          : '本机编码 Agent 工具初始化完成，不影响当前任务空间接入。',
      })
    } catch (error) {
      setFeedback({ tone: 'error', text: onboardingErrorMessage(error, 'Trellis 初始化失败') })
    } finally {
      setBusy(false)
    }
  }

  async function checkPush({ silent = false } = {}) {
    if (!inspection || busy || pushCheckInFlight.current) return
    pushCheckInFlight.current = true
    const actionSeq = pushActionSeq.current
    if (!silent) {
      setBusy(true)
      setFeedback(null)
    }
    try {
      const result = await invoke('check_pending_project_push', {
        branchName: inspection.branchName,
      })
      // 一键提交期间由它返回最终状态，忽略更早发出的轮询结果。
      if (actionSeq !== pushActionSeq.current) return
      const next: PushState = normalizePushState(result)
      setPush(next)
      if (next.state !== 'ready') setPreflight(null)
      if (!silent) setFeedback({ tone: 'status', text: stateLabel(next) })
    } catch (error) {
      if (!silent) {
        setFeedback({ tone: 'error', text: onboardingErrorMessage(error, '检查推送状态失败') })
      }
    } finally {
      pushCheckInFlight.current = false
      if (!silent) setBusy(false)
    }
  }

  async function commitAndPush() {
    if (!inspection || busy) return
    pushActionSeq.current += 1
    setBusy(true)
    setFeedback(null)
    try {
      const result = await invoke('commit_and_push_pending_project')
      const next: PushState = normalizePushState(result)
      setPush(next)
      if (next.state !== 'ready') setPreflight(null)
      setFeedback({ tone: 'status', text: stateLabel(next) })
    } catch (error) {
      setPush(null)
      setFeedback({ tone: 'error', text: onboardingErrorMessage(error, '提交并推送失败') })
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (!open || !inspection || !requiresPushCheck || push?.state === 'ready' || busy) {
      return
    }
    const timer = window.setInterval(() => {
      void checkPush({ silent: true })
    }, 5_000)
    const onFocus = () => {
      void checkPush({ silent: true })
    }
    window.addEventListener('focus', onFocus)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [open, inspection, requiresPushCheck, push?.state, busy])

  function validateBeforePreflight() {
    if (!inspection) return
    if (preflightBlockedReason) {
      setFeedback({ tone: 'error', text: preflightBlockedReason })
      return false
    }
    if (!teamId) {
      setFeedback({ tone: 'error', text: '请选择项目归属团队。' })
      return false
    }
    if (!developerId.trim()) {
      setFeedback({ tone: 'error', text: '请填写 Trellis developer ID。' })
      return false
    }
    return true
  }

  async function runPreflight() {
    if (!inspection || !validateBeforePreflight()) return
    setBusy(true)
    setFeedback(null)
    try {
      const result = await invoke('preflight_pending_project', {
        teamId,
        developerId: developerId.trim(),
        requirePushed: requiresPushCheck,
      })
      const next = normalizePreflight(result)
      if (!next) throw new Error('没有返回有效的任务预检结果')
      setPreflight(next)
    } catch (error) {
      setFeedback({ tone: 'error', text: onboardingErrorMessage(error, '任务预检失败') })
    } finally {
      setBusy(false)
    }
  }

  async function associate(initialMode: InitialSyncMode) {
    if (!inspection || !validateBeforePreflight()) return
    if (!associationsLoaded) {
      setFeedback({
        tone: 'error',
        text: '无法确认当前仓库已有本地绑定，为避免重复绑定，暂不能接入。',
      })
      return
    }
    if (replacedAssociations.length) {
      const confirmed = await confirm({
        title: `替换为分支 ${inspection.branchName}？`,
        description: [
          `当前本机已把该仓库绑定到其他分支：${replacedAssociations
            .map((item) => `${item.branchName}（任务空间 ${item.taskSpaceId}）`)
            .join('、')}。`,
          '替换后本机停止同步旧分支；旧任务空间、旧任务和其他设备的绑定都不会删除。',
          '需要同时同步两个分支时，请为另一个分支使用独立 Git worktree。',
        ].join('\n'),
        confirmText: '替换',
        tone: 'danger',
      })
      if (!confirmed) return
    }
    setBusy(true)
    setFeedback(null)
    try {
      const result = await invoke('associate_pending_project', {
        teamId,
        developerId: developerId.trim(),
        requirePushed: requiresPushCheck,
        initialMode,
      })
      const association = normalizeAssociation(result)
      if (!association) throw new Error('关联后没有返回有效任务空间')
      onAssociated(association)
      onOpenChange(false)
    } catch (error) {
      setFeedback({ tone: 'error', text: onboardingErrorMessage(error, '本地项目接入失败') })
    } finally {
      setBusy(false)
    }
  }

  function cancelPendingProject() {
    if (busy) return
    void invoke('cancel_pending_project').catch(() => {})
    onOpenChange(false)
  }

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen && busy) return
    if (!nextOpen) {
      setLoading(false)
      setLoadError('')
      void invoke('cancel_pending_project').catch(() => {})
    }
    onOpenChange(nextOpen)
  }

  const actionableDifferences =
    preflight?.differences.filter((difference) => difference.type !== 'same') || []
  const newSnapshot = preflight?.status === 'new' || preflight?.status === 'branch_new'
  const hasDifferences = preflight?.status === 'existing' && actionableDifferences.length > 0
  const associationCheckPassed = associationsLoaded && !associationLoadError

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-155" initialFocus={dialogHeaderRef}>
        <DialogHeader ref={dialogHeaderRef} tabIndex={-1} className="outline-none">
          <DialogTitle>接入本地 Git 项目</DialogTitle>
          <DialogDescription>
            客户端负责初始化和任务同步，服务端不会读取或操作项目 Git 仓库。
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4">
          {loading ? (
            <OnboardingSkeleton />
          ) : loadError ? (
            <div className="flex flex-col gap-3 rounded-lg border border-destructive/40 p-4">
              <p className="font-medium text-destructive">无法读取本地项目</p>
              <p className="break-words text-muted-foreground">{loadError}</p>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setReloadToken((token) => token + 1)}
                >
                  重试
                </Button>
              </div>
            </div>
          ) : !inspection ? (
            <Empty className="border border-dashed">
              <EmptyDescription>
                没有读取到有效的本地 Git 仓库，请重新选择仓库根目录。
              </EmptyDescription>
            </Empty>
          ) : (
            <>
              <dl className="grid grid-cols-[92px_minmax(0,1fr)] gap-x-3 gap-y-2 rounded-lg bg-muted/40 p-3">
                <dt className="text-muted-foreground">仓库</dt>
                <dd className="min-w-0 break-words">{inspection.repositoryName}</dd>
                <dt className="text-muted-foreground">当前分支</dt>
                <dd className="break-words">{inspection.branchName}</dd>
                <dt className="text-muted-foreground">远端</dt>
                <dd className="break-all">{inspection.remoteUrl}</dd>
                <dt className="text-muted-foreground">Trellis</dt>
                <dd>
                  {inspection.hasTrellis
                    ? inspection.hasTasks
                      ? '已初始化'
                      : '.trellis 存在，但缺少 tasks 目录'
                    : '尚未初始化'}
                </dd>
                <dt className="text-muted-foreground">Git 状态</dt>
                <dd>{inspection.clean ? '相关路径干净' : '存在未提交文件'}</dd>
              </dl>

              {associationLoadError ? (
                <Alert variant="destructive">
                  <AlertDescription>
                    无法读取本地项目关联，已阻止接入，避免产生重复绑定：{associationLoadError}
                  </AlertDescription>
                </Alert>
              ) : open && !associationsLoaded ? (
                <div className="flex flex-col gap-1.5">
                  <Skeleton className="h-4 w-48" />
                  <Skeleton className="h-8 w-full" />
                </div>
              ) : replacedAssociations.length ? (
                <Alert
                  className={`flex flex-col gap-2 border-warning/35 p-3 ${toneSurface('warning')}`}
                >
                  <p className="font-medium text-warning">将替换当前仓库的旧分支绑定</p>
                  <p className="text-muted-foreground">
                    当前目录准备接入 <code>{inspection.branchName}</code>，但本机仍绑定：
                  </p>
                  <ul className="flex flex-col gap-1">
                    {replacedAssociations.map((association) => (
                      <li key={association.taskSpaceId} className="break-all">
                        分支 <code>{association.branchName}</code>，任务空间{' '}
                        <code>{association.taskSpaceId}</code>
                      </li>
                    ))}
                  </ul>
                  <p className="text-muted-foreground">
                    接入前会再次确认。替换只会停止本机旧分支同步，不会删除旧任务空间、旧任务或其他设备的绑定。需要同时同步两个分支时，请使用独立
                    Git worktree。
                  </p>
                </Alert>
              ) : null}

              <div className="grid gap-3 sm:grid-cols-2">
                <Field className="gap-1.5">
                  <FieldLabel htmlFor="onboard-team">项目归属团队</FieldLabel>
                  <SelectField
                    id="onboard-team"
                    value={teamId}
                    placeholder="请选择团队"
                    options={teams.map((team) => ({ value: team.id, label: team.name }))}
                    onChange={(value) => {
                      setTeamId(value)
                      setPreflight(null)
                    }}
                  />
                </Field>
                <Field className="gap-1.5">
                  <FieldLabel htmlFor="onboard-developer">Trellis developer ID</FieldLabel>
                  <Input
                    id="onboard-developer"
                    value={developerId}
                    maxLength={120}
                    placeholder="例如 zhangsan"
                    onChange={(event) => {
                      developerIdEdited.current = true
                      setDeveloperId(event.target.value)
                      setPreflight(null)
                    }}
                  />
                </Field>
              </div>

              {!inspection.hasTrellis || !inspection.hasTasks || missingTools.length ? (
                <div className="flex flex-col gap-2">
                  <AgentToolSelector
                    existingTools={inspection.existingAgentTools}
                    selectedTools={selectedTools}
                    search={agentSearch}
                    disabled={busy}
                    onSearchChange={setAgentSearch}
                    onToggleTool={toggleTool}
                  />
                  {needsInitialization ? (
                    <Button
                      type="button"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void initialize()}
                    >
                      {busy ? '正在初始化…' : '初始化缺失的 Trellis 与 Agent 工具'}
                    </Button>
                  ) : null}
                </div>
              ) : null}

              {requiresPushCheck ? (
                <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
                  <p className="font-medium">首次推送确认</p>
                  <p className="text-muted-foreground">
                    请先检查生成的初始化文件，然后提交并推送到 <code>{inspection.branchName}</code>
                    。客户端不会自动提交；点击“一键提交并推送”只提交初始化生成的{' '}
                    <code>.trellis</code>、<code>.gitignore</code>、<code>AGENTS.md</code>、
                    <code>.gitattributes</code>、<code>.agents/</code>，也可以手动执行：
                  </p>
                  <code className="rounded bg-muted px-2 py-1 text-xs">
                    git add .trellis && git commit && git push
                  </code>
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" disabled={busy} onClick={() => void commitAndPush()}>
                      一键提交并推送
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void checkPush()}
                    >
                      检查推送状态
                    </Button>
                  </div>
                  {push ? (
                    <p className={pushReady ? 'text-success' : 'text-warning'}>
                      {stateLabel(push)}
                      {push.dirtySummary ? (
                        <span className="mt-1 block break-words">{push.dirtySummary}</span>
                      ) : null}
                    </p>
                  ) : null}
                </div>
              ) : null}

              {preflight ? (
                <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/25 p-3">
                  {preflight.status === 'access_required' ? (
                    <>
                      <p className="font-medium text-destructive">当前团队还没有该项目的访问权限</p>
                      <p className="text-muted-foreground">
                        项目已经被其他团队接入。请让项目负责人邀请当前团队后，再重新执行预检。
                      </p>
                    </>
                  ) : preflight.status === 'unavailable' ? (
                    <>
                      <p className="font-medium text-destructive">项目或任务分支已停用</p>
                      <p className="text-muted-foreground">
                        当前不能接入。请让项目负责人恢复项目或该分支后，再重新执行预检。
                      </p>
                    </>
                  ) : newSnapshot ? (
                    <>
                      <p className="font-medium">服务端还没有这个分支的任务快照</p>
                      <p className="text-muted-foreground">
                        接入后会以当前本地任务作为初始版本上传。当前检测到{' '}
                        {preflight.counts.localOnly} 个可上传任务
                        {preflight.counts.invalid
                          ? `，另有 ${preflight.counts.invalid} 个任务结构异常需要检查`
                          : '。'}
                      </p>
                    </>
                  ) : hasDifferences ? (
                    <>
                      <p className="font-medium text-warning">本地与服务端的任务需要确认</p>
                      <p className="text-muted-foreground">
                        服务端独有 {preflight.counts.serverOnly} 个，本地独有{' '}
                        {preflight.counts.localOnly} 个，内容冲突 {preflight.counts.conflicts} 个
                        {preflight.counts.invalid
                          ? `，结构异常 ${preflight.counts.invalid} 个`
                          : ''}
                        。暂不接入不会建立绑定，也不会写入本地游标或服务端。
                      </p>
                    </>
                  ) : (
                    <>
                      <p className="font-medium text-success">双方任务一致，可以安全接入</p>
                      <p className="text-muted-foreground">
                        服务端版本 {preflight.revision}，没有需要额外处理的差异。
                      </p>
                    </>
                  )}
                </div>
              ) : null}
            </>
          )}
          {feedback ? (
            feedback.tone === 'error' ? (
              <FieldError className="text-xs">{feedback.text}</FieldError>
            ) : (
              <p className="text-xs text-muted-foreground" role="status">
                {feedback.text}
              </p>
            )
          ) : null}
          {!preflight && !feedback && preflightBlockedReason ? (
            <p id="onboard-preflight-reason" className="text-xs text-warning">
              {preflightBlockedReason}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter className="flex-wrap gap-2">
          <Button type="button" variant="outline" disabled={busy} onClick={cancelPendingProject}>
            {preflight ? '暂不接入' : '取消'}
          </Button>
          {loading || loadError ? null : !preflight ? (
            <Button
              type="button"
              disabled={busy || !inspection || Boolean(preflightBlockedReason)}
              aria-describedby={
                preflightBlockedReason && !feedback ? 'onboard-preflight-reason' : undefined
              }
              onClick={() => void runPreflight()}
            >
              {busy ? '正在检查…' : '检查任务差异'}
            </Button>
          ) : preflight.status === 'access_required' ||
            preflight.status === 'unavailable' ? null : newSnapshot ? (
            <Button
              type="button"
              disabled={busy || !associationCheckPassed}
              onClick={() => void associate(preflight.counts.invalid > 0 ? 'review' : 'bootstrap')}
            >
              {busy
                ? '正在接入…'
                : preflight.counts.invalid > 0
                  ? '接入并检查异常任务'
                  : '接入并上传本地任务'}
            </Button>
          ) : hasDifferences ? (
            <>
              <Button
                type="button"
                variant="outline"
                disabled={busy || !associationCheckPassed}
                onClick={() => void associate('safe')}
              >
                仅同步无冲突项
              </Button>
              <Button
                type="button"
                disabled={busy || !associationCheckPassed}
                onClick={() => void associate('review')}
              >
                查看并处理差异
              </Button>
            </>
          ) : (
            <Button
              type="button"
              disabled={busy || !associationCheckPassed}
              onClick={() => void associate('safe')}
            >
              {busy ? '正在接入…' : '接入任务空间'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
