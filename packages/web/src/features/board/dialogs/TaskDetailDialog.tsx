import { useEffect, useMemo, useRef, useState } from 'react'
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
import { Field, FieldLabel } from '@/components/ui/field'
import { fetchTaskDetail, api } from '@/api/board'
import { ApiError } from '@/api/request'
import type { Stage } from '../task-view.ts'
import {
  branchLabel,
  controlTone,
  dueLabel,
  isAttention,
  attentionReasons,
  nextStage,
  stageSourceLabel,
  taskProgress,
  taskTags,
} from '../task-view.ts'
import type { BoardTask } from '../task-view.ts'
import { StageTape } from '../StageTape.tsx'
import { ConditionChecks } from '../ConditionChecks.tsx'
import { toast } from 'sonner'
import { SelectField } from '../SelectField.tsx'
import { StatusPill } from '@/components/ui/status-pill'
import { priorityTone, stageTone, statusLabel, statusTone } from '../tone.ts'
import {
  assignmentActionState,
  planEditingState,
  taskCommandState,
  taskContentMaterialized,
  taskControlView,
} from '@/lib/team-client.js'
import { AssigneeWarningDialog, type AssigneeWarningDetails } from './AssigneeWarningDialog.tsx'
import { DependencyItem } from './TaskDetailDependencyItem.tsx'
import { TaskDetailArchiveFiles } from './TaskDetailArchiveFiles.tsx'
import { TaskDetailArtifactViewer } from './TaskDetailArtifactViewer.tsx'
import { TaskDetailArtifactsSection } from './TaskDetailArtifactsSection.tsx'
import {
  authoritativeTaskField,
  dependencyStateText,
  readArtifacts,
  type ArtifactEntry,
} from './task-detail-artifacts.ts'
import type { TaskDetailDialogProps } from './task-detail-types.ts'
import { Skeleton } from '@/components/ui/skeleton'

export function TaskDetailDialog({
  task,
  open,
  onOpenChange,
  onAssign,
  assignees,
  taskSpace = null,
  onPlanSaved,
  tasks,
  actions,
}: TaskDetailDialogProps) {
  const [detail, setDetail] = useState<BoardTask | null>(null)
  const [loading, setLoading] = useState(false)
  const [assignee, setAssignee] = useState('')
  const [artifact, setArtifact] = useState<{ label: string; entry?: ArtifactEntry } | null>(null)
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
    if (!taskContentMaterialized(task)) {
      setDetail(null)
      setLoading(false)
      return
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
    if (!detail) return task
    if (task && detail.taskKey !== task.taskKey) return task
    if (!task) return detail
    return {
      ...detail,
      sourceBranchName: task.sourceBranchName || detail.sourceBranchName,
      archived: Boolean(task.archived || detail.archived),
      executionTaskKey: authoritativeTaskField(task, detail, 'executionTaskKey'),
      executionIdentityValid: authoritativeTaskField(task, detail, 'executionIdentityValid'),
      executionIdentityConflict: authoritativeTaskField(task, detail, 'executionIdentityConflict'),
      taskVersion: authoritativeTaskField(task, detail, 'taskVersion'),
      taskSpaceRevision: authoritativeTaskField(task, detail, 'taskSpaceRevision'),
      taskSpaceIndexedRevision: authoritativeTaskField(task, detail, 'taskSpaceIndexedRevision'),
      controlTaskVersion: authoritativeTaskField(task, detail, 'controlTaskVersion'),
      controlState: authoritativeTaskField(task, detail, 'controlState'),
      materializationState: authoritativeTaskField(task, detail, 'materializationState'),
      handoffState: authoritativeTaskField(task, detail, 'handoffState'),
      leaseStatus: authoritativeTaskField(task, detail, 'leaseStatus'),
      leaseExpiresAt: authoritativeTaskField(task, detail, 'leaseExpiresAt'),
      leaseExpired: authoritativeTaskField(task, detail, 'leaseExpired'),
      previousAssigneeUserId: authoritativeTaskField(task, detail, 'previousAssigneeUserId'),
    }
  }, [detail, task])
  const progress = current ? taskProgress(current) : null
  const stage = current ? nextStage(current) : null
  const control = current ? taskControlView(current) : null
  const contentMaterialized = current ? taskContentMaterialized(current) : false
  const artifacts = readArtifacts(current)
  const archiveFiles = Array.isArray(current?.files) ? current.files : []
  const { readOnly: assignmentReadOnly, canSubmit: assignmentCanSubmit } = assignmentActionState(
    current,
    assignee,
    assignees,
  )
  const commandState = taskCommandState(taskSpace)
  const commandBlocked = !assignmentReadOnly && !commandState.canSubmit
  const canAssign = assignmentCanSubmit && commandState.canSubmit
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

  const ownershipLabel = current ? branchLabel(current) : null

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-310">
          <DialogHeader>
            <DialogTitle className="pr-8 text-base">{current?.title || '任务详情'}</DialogTitle>
            <DialogDescription>
              {current
                ? `${current.teamName ? `${current.teamName} · ` : ''}${current.projectName}${ownershipLabel ? ` · ${ownershipLabel}` : ''} / ${current.dirName}`
                : '正在读取任务…'}
            </DialogDescription>
          </DialogHeader>

          {!current ? (
            <div className="flex flex-col gap-2 px-2 py-4">
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
          ) : (
            <DialogBody className="flex flex-col gap-4">
              {contentMaterialized ? (
                <StageTape stages={current.stages} current={current.derivedStage} />
              ) : null}

              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {[
                  ['负责人', current.assignee || '未派发'],
                  ['优先级', current.priority || 'P2'],
                  ['截止', dueLabel(current.execution?.dueDate)],
                  ['状态', statusLabel(current.status) || '规划'],
                ].map(([label, value]) => (
                  <div key={label} className="flex flex-col gap-1 rounded-lg bg-muted px-2.5 py-2">
                    <span className="text-2xs text-muted-foreground">{label}</span>
                    {label === '优先级' || label === '状态' ? (
                      <StatusPill
                        tone={label === '优先级' ? priorityTone(value) : statusTone(value)}
                        size="xs"
                        className="w-fit text-xs"
                      >
                        {value}
                      </StatusPill>
                    ) : (
                      <span className="w-fit text-xs font-semibold">{value}</span>
                    )}
                  </div>
                ))}
              </div>

              {control?.available ? (
                <section className="rounded-lg border border-border bg-muted/60 px-3 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-2xs font-semibold tracking-[0.08em] text-muted-foreground">
                      服务端控制状态
                    </span>
                    <StatusPill tone={controlTone(control.tone)}>{control.label}</StatusPill>
                  </div>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    {control.description}
                  </p>
                </section>
              ) : null}

              {contentMaterialized ? (
                <>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-xs font-semibold text-muted-foreground">关注信号</span>
                    {isAttention(current) ? (
                      attentionReasons(current).map((reason) => (
                        <StatusPill key={reason.id} tone="destructive">
                          {reason.label}
                        </StatusPill>
                      ))
                    ) : (
                      <StatusPill tone="neutral">无风险信号</StatusPill>
                    )}
                    <span className="ml-auto text-2xs text-muted-foreground">
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
                      <h3 className="text-xs font-semibold text-muted-foreground">阶段证据</h3>
                      {canEditPlan ? (
                        <Button
                          className="ml-auto text-xs font-semibold"
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
                        <Field className="gap-1">
                          <FieldLabel htmlFor="task-plan-due-date" className="text-2xs">
                            截止日期
                          </FieldLabel>
                          <Input
                            id="task-plan-due-date"
                            className="text-xs"
                            type="date"
                            value={dueDate}
                            onChange={(e) => setDueDate(e.target.value)}
                          />
                        </Field>
                        <Field className="gap-1">
                          <FieldLabel htmlFor="task-plan-milestone" className="text-2xs">
                            里程碑
                          </FieldLabel>
                          <Input
                            id="task-plan-milestone"
                            className="text-xs"
                            value={milestone}
                            onChange={(e) => setMilestone(e.target.value)}
                          />
                        </Field>
                        <Field className="gap-1">
                          <FieldLabel htmlFor="task-plan-tags" className="text-2xs">
                            标签
                          </FieldLabel>
                          <Input
                            id="task-plan-tags"
                            className="text-xs"
                            value={tags}
                            onChange={(e) => setTags(e.target.value)}
                          />
                        </Field>
                        <Button className="mt-auto" onClick={savePlan}>
                          保存计划字段
                        </Button>
                      </div>
                    ) : null}
                    <ul className="flex flex-col divide-y divide-border/60 rounded-lg border border-border">
                      {current.stages.map((item: Stage) => (
                        <li key={item.id}>
                          <div className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs">
                            <span className="w-4 text-2xs text-muted-foreground">{item.index}</span>
                            <StatusPill
                              tone={stageTone(item.label)}
                              size="xs"
                              className="font-medium"
                            >
                              {item.label}
                            </StatusPill>
                            <span className="ml-auto text-2xs text-muted-foreground">
                              {stageSourceLabel(item)}
                            </span>
                            <span
                              className="max-w-[45%] truncate text-2xs text-muted-foreground"
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
                        <h3 className="text-xs font-semibold text-muted-foreground">风险与依赖</h3>
                        <span className="text-2xs text-muted-foreground">
                          {dependencyStateText(current)}
                        </span>
                      </div>
                      <div className="grid gap-2 sm:grid-cols-2">
                        <div className="flex flex-col gap-1">
                          <h4 className="text-2xs font-semibold text-muted-foreground">
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
                            <p className="text-2xs text-muted-foreground">当前没有活动阻断。</p>
                          )}
                        </div>
                        <div className="flex flex-col gap-1">
                          <h4 className="text-2xs font-semibold text-muted-foreground">
                            Blocks / 阻断了谁
                          </h4>
                          {(current.execution.blocks || []).length ? (
                            (current.execution.blocks || []).map((item) => (
                              <DependencyItem
                                key={item.id}
                                item={item}
                                relation="blocks"
                                disabled
                              />
                            ))
                          ) : (
                            <p className="text-2xs text-muted-foreground">
                              这个任务目前没有阻断其他任务。
                            </p>
                          )}
                        </div>
                      </div>
                      {(current.execution.resolvedBlockedBy || []).length ||
                      (current.execution.resolvedBlocks || []).length ? (
                        <details className="rounded-lg border border-border px-2.5 py-1.5 text-2xs text-muted-foreground">
                          <summary className="cursor-pointer">
                            已解除依赖：曾被阻断{' '}
                            {(current.execution.resolvedBlockedBy || []).length} 项 · 曾阻断其他任务{' '}
                            {(current.execution.resolvedBlocks || []).length} 项
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
                            aria-label="阻断原因"
                            className="text-xs"
                            placeholder="阻断原因（最多 500 字）"
                            maxLength={500}
                            value={reason}
                            onChange={(event) => setReason(event.target.value)}
                          />
                          <Button
                            disabled={busy === 'dependency'}
                            onClick={() => void addDependency()}
                          >
                            {busy === 'dependency' ? '正在创建…' : '创建阻断依赖'}
                          </Button>
                        </div>
                      ) : null}
                    </section>
                  ) : null}

                  <TaskDetailArtifactsSection
                    artifacts={artifacts}
                    loading={loading}
                    onOpen={setArtifact}
                  />

                  {current.archived ? (
                    <TaskDetailArchiveFiles
                      files={archiveFiles}
                      loading={loading}
                      busy={busy}
                      onBusy={setBusy}
                    />
                  ) : null}
                </>
              ) : (
                <section className="rounded-lg border border-dashed border-border bg-muted/40 px-3 py-3">
                  <h3 className="text-xs font-semibold">等待客户端接管</h3>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    当前只展示服务端元数据，不请求或渲染尚不存在的任务正文，也不会写入本地工作区。
                    目标客户端上线并完成 materialization 后，详情会自动刷新为可读取内容。
                  </p>
                </section>
              )}
            </DialogBody>
          )}

          <DialogFooter className="gap-2 sm:justify-between">
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-1.5">
                <SelectField
                  className="w-40 text-xs"
                  placeholder="请选择负责人"
                  value={assignee}
                  options={assignees.map((name) => ({ value: name, label: name }))}
                  onChange={setAssignee}
                  ariaLabel="负责人"
                  disabled={assignmentReadOnly || commandBlocked}
                />
                <Button
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
              {commandBlocked ? (
                <p className="text-2xs text-warning" role="status">
                  {commandState.reason}
                </p>
              ) : null}
              {!assignmentReadOnly ? (
                <p className="max-w-72 text-2xs leading-4 text-muted-foreground">
                  目标客户端离线时也可以先排队；接管后旧负责人本地副本可能保留、进入受保护清理，
                  或被 Git 跟踪而需要手工处理。
                </p>
              ) : null}
            </div>
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <TaskDetailArtifactViewer artifact={artifact} onClose={() => setArtifact(null)} />
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
