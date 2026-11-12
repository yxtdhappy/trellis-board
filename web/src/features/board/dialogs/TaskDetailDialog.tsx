import { useEffect, useMemo, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
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
import { Label } from '@/components/ui/label'
import { fetchTaskDetail, api } from '@/api/board'
import { ApiError } from '@/api/request'
import { renderMarkdown } from '@/lib/markdown.js'
import type { Stage } from '../task-view'
import {
  dueLabel,
  isAttention,
  attentionReasons,
  nextStage,
  stageSourceLabel,
  taskProgress,
  taskTags,
} from '../task-view'
import type { BoardTask, DependencyRecord } from '../task-view'
import { StageTape } from '../StageTape'
import { ConditionChecks } from '../ConditionChecks'
import { toast } from 'sonner'
import { SelectField } from '../SelectField'
import { priorityTone, stageTone, statusLabel, statusTone } from '../tone'
import { assignmentActionState, planEditingState } from '@/lib/team-client.js'
import { AssigneeWarningDialog, type AssigneeWarningDetails } from './AssigneeWarningDialog'

const ARTIFACTS = [
  { key: 'prd', label: 'PRD', hint: '需求、范围与验收标准' },
  { key: 'design', label: 'Design', hint: '技术设计与关键取舍' },
  { key: 'implement', label: 'Implement', hint: '实施计划与检查项' },
  { key: 'implementationReport', label: '实施报告', hint: '实现结果与验证记录' },
  { key: 'checkReport', label: '检查报告', hint: '质量检查与问题闭环' },
  { key: 'e2eReport', label: 'E2E 报告', hint: '真实环境端到端验证' },
] as const

type ArtifactEntry = { path?: string; content?: string; truncated?: boolean }

function dependencyStateText(task: BoardTask) {
  const execution = task.execution || {}
  const blockedBy = execution.blockedBy || []
  const state = execution.isBlocked
    ? `当前被 ${blockedBy.length} 项依赖阻断`
    : execution.isUnblockedReady
      ? '已有阻断解除，当前无活动阻断，可继续推进'
      : '当前没有活动阻断'
  const wip =
    task.archived || task.derivedStage !== 'implement'
      ? '当前阶段不计入实现中 WIP'
      : execution.risk?.wipState === 'over_limit'
        ? '实现中 WIP 超出软上限'
        : execution.risk?.wipState === 'at_limit'
          ? '实现中 WIP 达到软上限'
          : '实现中 WIP 在软上限内'
  return `${state} · ${wip}`
}

function DependencyItem({
  item,
  relation,
  disabled,
  onResolve,
}: {
  item: DependencyRecord
  relation: 'blocked' | 'blocks'
  disabled?: boolean
  onResolve?: () => void
}) {
  return (
    <article className="flex flex-col gap-1 rounded-lg bg-muted px-2.5 py-2 text-[11px]">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="rounded-full bg-background px-1.5 py-0.5 text-[9px] font-semibold text-muted-foreground">
          {relation === 'blocked' ? '阻断我' : '我阻断'}
        </span>
        <strong className="text-[11.5px] font-semibold">{item.title || '未命名任务'}</strong>
        <small className="text-[10px] text-muted-foreground">
          {item.projectName || ''}
          {item.createdBy ? ` · ${item.createdBy}` : ''}
        </small>
      </div>
      <p className="text-[10.5px] text-muted-foreground">{item.reason || '未记录原因'}</p>
      <div className="flex items-center gap-2">
        <time className="text-[10px] text-muted-foreground" dateTime={item.createdAt}>
          {item.createdAt ? new Date(item.createdAt).toLocaleString('zh-CN') : '时间未知'}
        </time>
        {onResolve ? (
          <Button
            variant="ghost"
            size="xs"
            className="ml-auto"
            disabled={disabled}
            onClick={onResolve}
          >
            解除依赖
          </Button>
        ) : null}
      </div>
    </article>
  )
}

function readArtifacts(task: BoardTask | null) {
  const source = task?.artifacts
  if (!source || typeof source !== 'object') return []
  const record = source as Record<string, ArtifactEntry>
  return ARTIFACTS.map((definition) => ({
    ...definition,
    artifact: record[definition.key],
  })).filter((item) => item.artifact?.path)
}

type TaskDetailActions = {
  addDependency: (payload: {
    blocked: { taskSpaceId: string; executionTaskKey?: string; taskPath?: string }
    blocker: { taskSpaceId: string; executionTaskKey?: string; taskPath?: string }
    reason: string
    assigneeDecision?: {
      warningId: string
      action: 'continue' | 'takeover'
    }
  }) => Promise<void>
  removeDependency: (
    id: string,
    assigneeDecision?: { warningId: string; action: 'continue' | 'takeover' },
  ) => Promise<void>
}

type TaskDetailDialogProps = {
  task: BoardTask | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onAssign: (task: BoardTask, assignee: string) => Promise<void>
  assignees: string[]
  onPlanSaved: () => void
  tasks: BoardTask[]
  actions: TaskDetailActions
}

export function TaskDetailDialog({
  task,
  open,
  onOpenChange,
  onAssign,
  assignees,
  onPlanSaved,
  tasks,
  actions,
}: TaskDetailDialogProps) {
  const [detail, setDetail] = useState<BoardTask | null>(null)
  const [loading, setLoading] = useState(false)
  const [assignee, setAssignee] = useState('')
  const [artifact, setArtifact] = useState<{ label: string; entry: ArtifactEntry } | null>(null)
  const artifactHeaderRef = useRef<HTMLDivElement>(null)
  const [editingPlan, setEditingPlan] = useState(false)
  const [dueDate, setDueDate] = useState('')
  const [milestone, setMilestone] = useState('')
  const [tags, setTags] = useState('')
  const [blockerKey, setBlockerKey] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState('')
  const [assigneeWarning, setAssigneeWarning] = useState<AssigneeWarningDetails | null>(null)
  const assigneeRetryRef = useRef<
    ((decision?: { warningId: string; action: 'continue' | 'takeover' }) => Promise<void>) | null
  >(null)
  const detailTaskKeyRef = useRef<string | null>(null)

  const dependencyCandidates = tasks
    .filter(
      (candidate) =>
        !candidate.archived &&
        candidate.taskSpaceId === task?.taskSpaceId &&
        candidate.taskKey !== task?.taskKey &&
        candidate.executionIdentityValid !== false,
    )
    .sort(
      (left, right) =>
        String(left.projectName).localeCompare(String(right.projectName), 'zh-CN') ||
        String(left.title).localeCompare(String(right.title), 'zh-CN'),
    )

  useEffect(() => {
    if (!open || !task) {
      if (!open) detailTaskKeyRef.current = null
      return
    }
    const taskChanged = detailTaskKeyRef.current !== task.taskKey
    if (taskChanged) {
      detailTaskKeyRef.current = task.taskKey
      setDetail(null)
      setAssignee(task.assignee || '')
      setEditingPlan(false)
      setBlockerKey('')
      setReason('')
    }
    let cancelled = false
    setLoading(true)
    fetchTaskDetail(task)
      .then((payload) => {
        if (cancelled) return
        const fresh = payload || task
        setDetail(fresh)
        if (fresh.archived) setEditingPlan(false)
        if (!editingPlan) setAssignee(fresh.assignee || '')
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          toast.error(error instanceof Error ? error.message : '读取任务失败')
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [editingPlan, open, task])

  const current = useMemo<BoardTask | null>(() => {
    if (!detail || (task && detail.taskKey !== task.taskKey)) return task
    return {
      ...detail,
      archived: Boolean(detail.archived || task?.archived),
    }
  }, [detail, task])
  const progress = current ? taskProgress(current) : null
  const stage = current ? nextStage(current) : null
  const artifacts = readArtifacts(current)
  const { readOnly: assignmentReadOnly, canSubmit: canAssign } = assignmentActionState(
    current,
    assignee,
    assignees,
  )
  const { readOnly: planReadOnly, canEdit: canEditPlan } = planEditingState(current)

  async function reloadDetail() {
    if (!task) return
    try {
      const fresh = await fetchTaskDetail(task)
      if (fresh) setDetail(fresh)
    } catch {
      /* 详情刷新失败时保留当前内容，由下一次打开重试 */
    }
  }

  async function run(
    label: string,
    operation: (decision?: { warningId: string; action: 'continue' | 'takeover' }) => Promise<void>,
    success: string,
  ): Promise<boolean> {
    setBusy(label)
    try {
      await operation()
      await reloadDetail()
      toast.success(success)
      return true
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.code === 'ASSIGNEE_CONFIRMATION_REQUIRED' &&
        error.details &&
        typeof error.details === 'object'
      ) {
        assigneeRetryRef.current = async (decision) => {
          await operation(decision)
          await reloadDetail()
          toast.success(success)
        }
        setAssigneeWarning(error.details as AssigneeWarningDetails)
        return false
      }
      toast.error(error instanceof Error ? error.message : '操作失败')
      return false
    } finally {
      setBusy('')
    }
  }

  async function savePlan() {
    if (!current) return
    if (planReadOnly) {
      setEditingPlan(false)
      return
    }
    await run(
      'plan',
      async (assigneeDecision) => {
        await api('/api/tasks/execution', 'PUT', {
          taskSpaceId: current.taskSpaceId,
          taskPath: current.relativeDir,
          dueDate: dueDate || null,
          milestone,
          tags: tags
            .split(/[,，\s]+/)
            .map((tag) => tag.trim())
            .filter(Boolean),
          ...(assigneeDecision ? { assigneeDecision } : {}),
        })
        setEditingPlan(false)
        onPlanSaved()
      },
      '计划字段已保存',
    )
  }

  async function addDependency() {
    if (!current) return
    if (!current.taskSpaceId || !blockerKey) {
      toast.error('当前任务缺少任务空间信息，请刷新后重试')
      return
    }
    const blocker = dependencyCandidates.find((candidate) => candidate.taskKey === blockerKey)
    if (!blocker) {
      toast.error('请选择当前看板中的阻断方任务')
      return
    }
    if (!blocker.taskSpaceId) {
      toast.error('阻断方任务缺少任务空间信息，请刷新后重试')
      return
    }
    const currentTaskSpaceId = current.taskSpaceId
    const blockerTaskSpaceId = blocker.taskSpaceId
    if (!reason.trim()) {
      toast.error('阻断原因不能为空')
      return
    }
    const succeeded = await run(
      'dependency',
      (assigneeDecision) =>
        actions.addDependency({
          blocked: {
            taskSpaceId: currentTaskSpaceId,
            executionTaskKey: current.executionTaskKey,
          },
          blocker: {
            taskSpaceId: blockerTaskSpaceId,
            executionTaskKey: blocker.executionTaskKey,
          },
          reason: reason.trim(),
          ...(assigneeDecision ? { assigneeDecision } : {}),
        }),
      '阻断依赖已创建',
    )
    if (succeeded) {
      setBlockerKey('')
      setReason('')
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-[1240px]">
          <DialogHeader>
            <DialogTitle className="pr-8 text-base">{current?.title || '任务详情'}</DialogTitle>
            <DialogDescription>
              {current
                ? `${current.teamName ? `${current.teamName} · ` : ''}${current.projectName}${current.branchName ? ` · 分支 ${current.branchName}` : ''} / ${current.dirName}`
                : '正在读取任务…'}
            </DialogDescription>
          </DialogHeader>

          {!current ? (
            <p className="py-10 text-center text-xs text-muted-foreground">正在读取任务详情…</p>
          ) : (
            <DialogBody className="flex flex-col gap-4">
              <StageTape stages={current.stages} current={current.derivedStage} />

              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {[
                  ['负责人', current.assignee || '未派发'],
                  ['优先级', current.priority || 'P2'],
                  ['截止', dueLabel(current.execution?.dueDate)],
                  ['状态', statusLabel(current.status) || '规划'],
                ].map(([label, value]) => (
                  <div key={label} className="flex flex-col gap-1 rounded-lg bg-muted px-2.5 py-2">
                    <span className="text-[10px] text-muted-foreground">{label}</span>
                    <span
                      className={`w-fit rounded-full px-1.5 py-px text-[11px] font-semibold ${
                        label === '优先级'
                          ? priorityTone(value)
                          : label === '状态'
                            ? statusTone(value)
                            : 'bg-transparent p-0 text-xs text-foreground'
                      }`}
                    >
                      {value}
                    </span>
                  </div>
                ))}
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] font-semibold text-muted-foreground">关注信号</span>
                {isAttention(current) ? (
                  attentionReasons(current).map((reason) => (
                    <span
                      key={reason.id}
                      className="rounded-full bg-destructive-soft px-2 py-0.5 text-[10px] font-semibold text-destructive"
                    >
                      {reason.label}
                    </span>
                  ))
                ) : (
                  <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px] font-semibold text-secondary-foreground">
                    无风险信号
                  </span>
                )}
                <span className="ml-auto text-[10.5px] text-muted-foreground">
                  {stage?.label} · {progress?.percent}% · {progress?.done}/{progress?.total}{' '}
                  必需阶段
                </span>
              </div>

              <ConditionChecks
                key={`${current.taskKey}:${current.derivedStage}`}
                task={current}
                loading={loading}
              />

              <section className="flex flex-col gap-1.5">
                <div className="flex items-center gap-2">
                  <h3 className="text-[11px] font-semibold text-muted-foreground">阶段证据</h3>
                  {canEditPlan ? (
                    <Button
                      size="sm"
                      className="ml-auto h-7 px-3 text-[11px] font-semibold"
                      onClick={() => {
                        setEditingPlan((value) => !value)
                        setDueDate(current.execution?.dueDate || '')
                        setMilestone(String(current.execution?.milestone || ''))
                        setTags(taskTags(current).join(', '))
                      }}
                    >
                      编辑计划
                    </Button>
                  ) : null}
                </div>
                {editingPlan && canEditPlan ? (
                  <div className="grid gap-2 rounded-lg border border-border p-2.5 sm:grid-cols-[1fr_1fr_1fr_auto]">
                    <div className="flex flex-col gap-1">
                      <Label className="text-[10px]">截止日期</Label>
                      <Input
                        className="text-xs"
                        type="date"
                        value={dueDate}
                        onChange={(e) => setDueDate(e.target.value)}
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <Label className="text-[10px]">里程碑</Label>
                      <Input
                        className="text-xs"
                        value={milestone}
                        onChange={(e) => setMilestone(e.target.value)}
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <Label className="text-[10px]">标签</Label>
                      <Input
                        className="text-xs"
                        value={tags}
                        onChange={(e) => setTags(e.target.value)}
                      />
                    </div>
                    <Button size="sm" className="mt-auto" onClick={savePlan}>
                      保存计划字段
                    </Button>
                  </div>
                ) : null}
                <ul className="flex flex-col divide-y divide-border/60 rounded-lg border border-border">
                  {current.stages.map((item: Stage) => (
                    <li key={item.id}>
                      <div className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11px]">
                        <span className="w-4 text-[10px] text-muted-foreground">{item.index}</span>
                        <span
                          className={`rounded-full px-1.5 py-px text-[10px] font-medium ${stageTone(item.label)}`}
                        >
                          {item.label}
                        </span>
                        <span className="ml-auto text-[10px] text-muted-foreground">
                          {stageSourceLabel(item)}
                        </span>
                        <span
                          className="max-w-[45%] truncate text-[10px] text-muted-foreground"
                          title={item.evidence}
                        >
                          {item.evidence || '等待执行'}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>

              {current.execution?.blockedBy ? (
                <section className="flex flex-col gap-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-[11px] font-semibold text-muted-foreground">风险与依赖</h3>
                    <span className="text-[10px] text-muted-foreground">
                      {dependencyStateText(current)}
                    </span>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <div className="flex flex-col gap-1">
                      <h4 className="text-[10px] font-semibold text-muted-foreground">
                        Blocked by / 被谁阻断
                      </h4>
                      {(current.execution.blockedBy || []).length ? (
                        current.execution.blockedBy.map((item) => (
                          <DependencyItem
                            key={item.id}
                            item={item}
                            relation="blocked"
                            disabled={Boolean(current.archived) || Boolean(busy)}
                            onResolve={() =>
                              void run(
                                'resolve:' + item.id,
                                (decision) => actions.removeDependency(item.id, decision),
                                '阻断依赖已解除',
                              )
                            }
                          />
                        ))
                      ) : (
                        <p className="text-[10.5px] text-muted-foreground">当前没有活动阻断。</p>
                      )}
                    </div>
                    <div className="flex flex-col gap-1">
                      <h4 className="text-[10px] font-semibold text-muted-foreground">
                        Blocks / 阻断了谁
                      </h4>
                      {(current.execution.blocks || []).length ? (
                        (current.execution.blocks || []).map((item) => (
                          <DependencyItem key={item.id} item={item} relation="blocks" disabled />
                        ))
                      ) : (
                        <p className="text-[10.5px] text-muted-foreground">
                          这个任务目前没有阻断其他任务。
                        </p>
                      )}
                    </div>
                  </div>
                  {(current.execution.resolvedBlockedBy || []).length ||
                  (current.execution.resolvedBlocks || []).length ? (
                    <details className="rounded-lg border border-border px-2.5 py-1.5 text-[10.5px] text-muted-foreground">
                      <summary className="cursor-pointer">
                        已解除依赖：曾被阻断 {(current.execution.resolvedBlockedBy || []).length} 项
                        · 曾阻断其他任务 {(current.execution.resolvedBlocks || []).length} 项
                      </summary>
                      <ul className="mt-1 flex flex-col gap-0.5">
                        {[
                          ...(current.execution.resolvedBlockedBy || []),
                          ...(current.execution.resolvedBlocks || []),
                        ].map((item) => (
                          <li key={item.id} className="truncate">
                            {item.title || '未命名任务'} · {item.reason || '未记录原因'}
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                  {!current.archived ? (
                    <div className="grid gap-2 rounded-lg border border-border p-2.5 sm:grid-cols-[1fr_1fr_auto]">
                      <SelectField
                        ariaLabel="阻断方任务"
                        className="min-w-0 text-xs"
                        placeholder="请选择阻断方任务"
                        value={blockerKey}
                        options={dependencyCandidates.map((candidate) => ({
                          value: candidate.taskKey,
                          label: `${candidate.projectName} · ${candidate.title}`,
                        }))}
                        onChange={setBlockerKey}
                      />
                      <Input
                        className="text-xs"
                        placeholder="阻断原因（最多 500 字）"
                        maxLength={500}
                        value={reason}
                        onChange={(event) => setReason(event.target.value)}
                      />
                      <Button
                        size="sm"
                        disabled={busy === 'dependency'}
                        onClick={() => void addDependency()}
                      >
                        {busy === 'dependency' ? '正在创建…' : '创建阻断依赖'}
                      </Button>
                    </div>
                  ) : null}
                </section>
              ) : null}

              <section className="flex flex-col gap-1.5">
                <h3 className="text-[11px] font-semibold text-muted-foreground">任务产物</h3>
                {loading && !artifacts.length ? (
                  <p className="text-[11px] text-muted-foreground">任务产物正在读取…</p>
                ) : artifacts.length ? (
                  <div className="flex flex-col gap-1">
                    {artifacts.map(({ key, label, hint, artifact: entry }) => (
                      <Button
                        key={key}
                        variant="ghost"
                        className="h-auto items-start justify-start gap-2 rounded-lg bg-muted px-2.5 py-2 text-left hover:bg-muted/70"
                        onClick={() => setArtifact({ label, entry })}
                      >
                        <span className="flex size-6 items-center justify-center rounded bg-card text-[9px] font-bold text-muted-foreground">
                          MD
                        </span>
                        <span className="flex min-w-0 flex-col">
                          <b className="text-[11.5px] font-semibold">{label}</b>
                          <small className="truncate text-[10px] text-muted-foreground">
                            {hint} · {entry?.path?.split('/').pop()}
                          </small>
                        </span>
                        <span className="ml-auto text-[10px] text-primary">查看</span>
                      </Button>
                    ))}
                  </div>
                ) : (
                  <p className="text-[11px] text-muted-foreground">
                    这个任务没有可读取的 Markdown 产物。
                  </p>
                )}
              </section>
            </DialogBody>
          )}

          <DialogFooter className="gap-2 sm:justify-between">
            <div className="flex items-center gap-1.5">
              <SelectField
                className="w-40 text-xs"
                placeholder="请选择负责人"
                value={assignee}
                options={assignees.map((name) => ({ value: name, label: name }))}
                onChange={setAssignee}
                ariaLabel="负责人"
                disabled={assignmentReadOnly}
              />
              <Button
                size="sm"
                disabled={!canAssign}
                onClick={async () => {
                  if (!current || !canAssign) return
                  try {
                    await onAssign(current, assignee)
                    toast.success('负责人已更新')
                  } catch (error) {
                    toast.error(error instanceof Error ? error.message : '更新失败')
                  }
                }}
              >
                更新派发
              </Button>
            </div>
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(artifact)} onOpenChange={(value) => !value && setArtifact(null)}>
        <DialogContent className="sm:max-w-[820px]" initialFocus={artifactHeaderRef}>
          <DialogHeader ref={artifactHeaderRef} tabIndex={-1} className="outline-none">
            <DialogTitle className="text-base">工件查看 · {artifact?.label}</DialogTitle>
            <DialogDescription>{artifact?.entry?.path}</DialogDescription>
          </DialogHeader>
          <DialogBody
            className="markdown-body max-w-none break-words [&_pre]:whitespace-pre-wrap [&_pre]:break-words [&_img]:max-w-full"
            dangerouslySetInnerHTML={{
              __html: renderMarkdown(artifact?.entry?.content || '（无可预览内容）'),
            }}
          />
          <DialogFooter className="gap-2">
            <Button variant="outline" className="gap-1.5" onClick={() => setArtifact(null)}>
              <X className="size-3.5" />
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AssigneeWarningDialog
        warning={assigneeWarning}
        onCancel={() => {
          setAssigneeWarning(null)
          assigneeRetryRef.current = null
        }}
        onContinue={async () => {
          if (!assigneeWarning || !assigneeRetryRef.current) return
          await assigneeRetryRef.current({
            warningId: assigneeWarning.warningId,
            action: 'continue',
          })
          setAssigneeWarning(null)
          assigneeRetryRef.current = null
        }}
        onTakeover={async () => {
          if (!assigneeWarning?.actorAssignee || !assigneeRetryRef.current || !current) {
            throw new Error('当前账号尚未映射到项目 Trellis developer ID')
          }
          await assigneeRetryRef.current({
            warningId: assigneeWarning.warningId,
            action: 'takeover',
          })
          setAssigneeWarning(null)
          assigneeRetryRef.current = null
        }}
      />
    </>
  )
}
