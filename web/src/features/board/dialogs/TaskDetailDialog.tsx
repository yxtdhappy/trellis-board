import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { fetchTaskDetail, api } from '@/api/board'
import { renderMarkdown } from '@/lib/markdown.js'
import type { Stage } from '../task-view'
import { dueLabel, isAttention, attentionReasons, nextStage, stageSourceLabel, taskProgress, taskTags } from '../task-view'
import type { BoardTask, DependencyRecord } from '../task-view'
import { StageTape } from '../StageTape'
import { toast } from 'sonner'

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
            size="sm"
            className="ml-auto h-6 text-[10.5px]"
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
  return ARTIFACTS.map((definition) => ({ ...definition, artifact: record[definition.key] })).filter(
    (item) => item.artifact?.path,
  )
}

type TaskDetailActions = {
  setStage: (payload: { projectId: string; taskPath: string; stage: string }) => Promise<void>
  undo: (payload: { projectId: string; taskPath: string }) => Promise<void>
  addDependency: (payload: {
    blocked: { projectId: string; taskPath: string }
    blocker: { projectId: string; taskPath: string }
    reason: string
  }) => Promise<void>
  removeDependency: (id: string) => Promise<void>
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
  const [editingPlan, setEditingPlan] = useState(false)
  const [dueDate, setDueDate] = useState('')
  const [milestone, setMilestone] = useState('')
  const [tags, setTags] = useState('')
  const [blockerKey, setBlockerKey] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState('')

  const dependencyCandidates = tasks
    .filter(
      (candidate) =>
        !candidate.archived &&
        candidate.taskKey !== task?.taskKey &&
        candidate.executionIdentityValid !== false,
    )
    .sort(
      (left, right) =>
        String(left.projectName).localeCompare(String(right.projectName), 'zh-CN') ||
        String(left.title).localeCompare(String(right.title), 'zh-CN'),
    )


  useEffect(() => {
    if (!open || !task) return
    setDetail(null)
    setAssignee(task.assignee || '')
    setEditingPlan(false)
    setBlockerKey('')
    setReason('')
    setLoading(true)
    fetchTaskDetail(task)
      .then((payload) => setDetail(payload || task))
      .catch((error: unknown) => toast.error(error instanceof Error ? error.message : '读取任务失败'))
      .finally(() => setLoading(false))
  }, [open, task])

  const current = detail || task
  const progress = current ? taskProgress(current) : null
  const stage = current ? nextStage(current) : null
  const artifacts = readArtifacts(current)

  async function reloadDetail() {
    if (!task) return
    try {
      const fresh = await fetchTaskDetail(task)
      if (fresh) setDetail(fresh)
    } catch {
      /* 详情刷新失败时保留当前内容，由下一次打开重试 */
    }
  }

  async function run(label: string, operation: () => Promise<void>, success: string) {
    setBusy(label)
    try {
      await operation()
      await reloadDetail()
      toast.success(success)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '操作失败')
    } finally {
      setBusy('')
    }
  }

  async function savePlan() {
    if (!current) return
    try {
      await api('/api/tasks/execution', 'PUT', {
        projectId: current.projectId,
        taskPath: current.relativeDir,
        dueDate: dueDate || null,
        milestone,
        tags: tags
          .split(/[,，\s]+/)
          .map((tag) => tag.trim())
          .filter(Boolean),
      })
      setEditingPlan(false)
      onPlanSaved()
      toast.success('计划字段已保存')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存失败')
    }
  }

  async function addDependency() {
    if (!current) return
    const blocker = dependencyCandidates.find((candidate) => candidate.taskKey === blockerKey)
    if (!blocker) {
      toast.error('请选择当前看板中的阻断方任务')
      return
    }
    if (!reason.trim()) {
      toast.error('阻断原因不能为空')
      return
    }
    await run(
      'dependency',
      () =>
        actions.addDependency({
          blocked: { projectId: current.projectId, taskPath: current.relativeDir },
          blocker: { projectId: blocker.projectId, taskPath: blocker.relativeDir },
          reason: reason.trim(),
        }),
      '阻断依赖已创建',
    )
    setBlockerKey('')
    setReason('')
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[88dvh] overflow-y-auto sm:max-w-[860px]">
          <DialogHeader>
            <DialogTitle className="pr-8 text-base">{current?.title || '任务详情'}</DialogTitle>
            <DialogDescription>
              {current ? `${current.projectName} / ${current.dirName}` : '正在读取任务…'}
            </DialogDescription>
          </DialogHeader>

          {!current ? (
            <p className="py-10 text-center text-xs text-muted-foreground">正在读取任务详情…</p>
          ) : (
            <div className="flex flex-col gap-4">
              <StageTape stages={current.stages} current={current.derivedStage} />

              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {[
                  ['负责人', current.assignee || '未派发'],
                  ['优先级', current.priority || 'P2'],
                  ['截止', dueLabel(current.execution?.dueDate)],
                  ['状态', current.status || '规划'],
                ].map(([label, value]) => (
                  <div key={label} className="flex flex-col gap-1 rounded-lg bg-muted px-2.5 py-2">
                    <span className="text-[10px] text-muted-foreground">{label}</span>
                    <span className="text-xs font-semibold">{value}</span>
                  </div>
                ))}
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] font-semibold text-muted-foreground">关注信号</span>
                {isAttention(current) ? (
                  attentionReasons(current).map((reason) => (
                    <span
                      key={reason.id}
                      className="rounded-full bg-destructive/10 px-2 py-0.5 text-[10px] font-semibold text-destructive"
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
                  {stage?.label} · {progress?.percent}% · {progress?.done}/{progress?.total} 必需阶段
                </span>
              </div>

              <section className="flex flex-col gap-1.5">
                <div className="flex items-center gap-2">
                  <h3 className="text-[11px] font-semibold text-muted-foreground">阶段证据</h3>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-auto h-6 text-[10.5px]"
                    onClick={() => {
                      setEditingPlan((value) => !value)
                      setDueDate(current.execution?.dueDate || '')
                      setMilestone(String(current.execution?.milestone || ''))
                      setTags(taskTags(current).join(', '))
                    }}
                  >
                    编辑计划
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 text-[10.5px]"
                    disabled={!current.history?.undo?.available || Boolean(busy)}
                    title={current.history?.undo?.disabledReason || undefined}
                    onClick={() =>
                      void run(
                        'undo',
                        () =>
                          actions.undo({ projectId: current.projectId, taskPath: current.relativeDir }),
                        '最近操作已撤销',
                      )
                    }
                  >
                    {busy === 'undo' ? '正在撤销…' : '撤销最近操作'}
                  </Button>
                </div>
                {editingPlan ? (
                  <div className="grid gap-2 rounded-lg border border-border p-2.5 sm:grid-cols-[1fr_1fr_1fr_auto]">
                    <div className="flex flex-col gap-1">
                      <Label className="text-[10px]">截止日期</Label>
                      <Input className="h-8 text-xs" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
                    </div>
                    <div className="flex flex-col gap-1">
                      <Label className="text-[10px]">里程碑</Label>
                      <Input className="h-8 text-xs" value={milestone} onChange={(e) => setMilestone(e.target.value)} />
                    </div>
                    <div className="flex flex-col gap-1">
                      <Label className="text-[10px]">标签</Label>
                      <Input className="h-8 text-xs" value={tags} onChange={(e) => setTags(e.target.value)} />
                    </div>
                    <Button size="sm" className="mt-auto h-8 text-[11px]" onClick={savePlan}>
                      保存计划字段
                    </Button>
                  </div>
                ) : null}
                <ul className="flex flex-col divide-y divide-border/60 rounded-lg border border-border">
                  {current.stages.map((item: Stage) => (
                    <li key={item.id}>
                      <button
                        type="button"
                        disabled={Boolean(current.archived) || Boolean(busy)}
                        onClick={() =>
                          void run(
                            `stage:${item.id}`,
                            () =>
                              actions.setStage({
                                projectId: current.projectId,
                                taskPath: current.relativeDir,
                                stage: item.id,
                              }),
                            `已记录检查点：${item.label}`,
                          )
                        }
                        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11px] hover:bg-muted/60 disabled:cursor-not-allowed disabled:opacity-70"
                      >
                        <span className="w-4 text-[10px] text-muted-foreground">{item.index}</span>
                        <span className={item.complete ? 'font-medium' : 'text-muted-foreground'}>{item.label}</span>
                        <span className="ml-auto text-[10px] text-muted-foreground">{stageSourceLabel(item)}</span>
                        <span className="max-w-[45%] truncate text-[10px] text-muted-foreground" title={item.evidence}>
                          {item.evidence || '等待执行'}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>

              {current.execution?.blockedBy ? (
                <section className="flex flex-col gap-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-[11px] font-semibold text-muted-foreground">风险与依赖</h3>
                    <span className="text-[10px] text-muted-foreground">{dependencyStateText(current)}</span>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <div className="flex flex-col gap-1">
                      <h4 className="text-[10px] font-semibold text-muted-foreground">Blocked by / 被谁阻断</h4>
                      {(current.execution.blockedBy || []).length ? (
                        current.execution.blockedBy.map((item) => (
                          <DependencyItem
                            key={item.id}
                            item={item}
                            relation="blocked"
                            disabled={Boolean(current.archived) || Boolean(busy)}
                            onResolve={() =>
                              void run('resolve:' + item.id, () => actions.removeDependency(item.id), '阻断依赖已解除')
                            }
                          />
                        ))
                      ) : (
                        <p className="text-[10.5px] text-muted-foreground">当前没有活动阻断。</p>
                      )}
                    </div>
                    <div className="flex flex-col gap-1">
                      <h4 className="text-[10px] font-semibold text-muted-foreground">Blocks / 阻断了谁</h4>
                      {(current.execution.blocks || []).length ? (
                        (current.execution.blocks || []).map((item) => (
                          <DependencyItem key={item.id} item={item} relation="blocks" disabled />
                        ))
                      ) : (
                        <p className="text-[10.5px] text-muted-foreground">这个任务目前没有阻断其他任务。</p>
                      )}
                    </div>
                  </div>
                  {(current.execution.resolvedBlockedBy || []).length ||
                  (current.execution.resolvedBlocks || []).length ? (
                    <details className="rounded-lg border border-border px-2.5 py-1.5 text-[10.5px] text-muted-foreground">
                      <summary className="cursor-pointer">
                        已解除依赖：曾被阻断 {(current.execution.resolvedBlockedBy || []).length} 项 · 曾阻断其他任务{' '}
                        {(current.execution.resolvedBlocks || []).length} 项
                      </summary>
                      <ul className="mt-1 flex flex-col gap-0.5">
                        {[...(current.execution.resolvedBlockedBy || []), ...(current.execution.resolvedBlocks || [])].map(
                          (item) => (
                            <li key={item.id} className="truncate">
                              {item.title || '未命名任务'} · {item.reason || '未记录原因'}
                            </li>
                          ),
                        )}
                      </ul>
                    </details>
                  ) : null}
                  {!current.archived ? (
                    <div className="grid gap-2 rounded-lg border border-border p-2.5 sm:grid-cols-[1fr_1fr_auto]">
                      <select
                        aria-label="阻断方任务"
                        className="h-8 min-w-0 rounded-md border border-input bg-transparent px-2 text-xs"
                        value={blockerKey}
                        onChange={(event) => setBlockerKey(event.target.value)}
                      >
                        <option value="">请选择阻断方任务</option>
                        {dependencyCandidates.map((candidate) => (
                          <option key={candidate.taskKey} value={candidate.taskKey}>
                            {candidate.projectName} · {candidate.title}
                          </option>
                        ))}
                      </select>
                      <Input
                        className="h-8 text-xs"
                        placeholder="阻断原因（最多 500 字）"
                        maxLength={500}
                        value={reason}
                        onChange={(event) => setReason(event.target.value)}
                      />
                      <Button
                        size="sm"
                        className="h-8 text-[11px]"
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
                      <button
                        key={key}
                        type="button"
                        onClick={() => setArtifact({ label, entry })}
                        className="flex items-center gap-2 rounded-lg bg-muted px-2.5 py-2 text-left hover:bg-muted/70"
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
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="text-[11px] text-muted-foreground">这个任务没有可读取的 Markdown 产物。</p>
                )}
              </section>
            </div>
          )}

          <DialogFooter className="gap-2 sm:justify-between">
            <div className="flex items-center gap-1.5">
              <select
                className="h-8 rounded-md border border-input bg-transparent px-2 text-xs"
                value={assignee}
                onChange={(event) => setAssignee(event.target.value)}
                aria-label="负责人"
              >
                <option value="">请选择负责人</option>
                {assignees.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
              <Button
                size="sm"
                className="h-8 text-[11px]"
                onClick={async () => {
                  if (!current || !assignee) return
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
            <Button variant="outline" size="sm" className="h-8 text-[11px]" onClick={() => onOpenChange(false)}>
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(artifact)} onOpenChange={(value) => !value && setArtifact(null)}>
        <DialogContent className="max-h-[86dvh] overflow-y-auto sm:max-w-[760px]">
          <DialogHeader>
            <DialogTitle className="text-base">工件查看 · {artifact?.label}</DialogTitle>
            <DialogDescription>{artifact?.entry?.path}</DialogDescription>
          </DialogHeader>
          <div
            className="prose prose-sm max-w-none text-xs leading-6 [&_h1]:text-base [&_h2]:text-sm [&_h3]:text-xs [&_p]:my-1.5 [&_li]:my-0.5 [&_ul]:my-1.5 [&_ul]:list-disc [&_ul]:pl-5"
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
    </>
  )
}
