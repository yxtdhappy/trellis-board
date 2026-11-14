import { AlertCircle } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { invoke, listen } from './tauri.ts'
import { createRefreshCoordinator } from '@/lib/refresh-coordinator.js'

type ChangedBy = { displayName?: string; deviceName?: string; occurredAt?: string }
type ConflictFile = { path?: string; revision?: number; changeType?: string; changedBy?: ChangedBy }
type Conflict = {
  conflictId?: string
  taskId?: string
  taskTitle?: string
  files?: ConflictFile[]
  suggestion?: string
}
type DifferenceSide = { taskId?: string; taskDir?: string }
type Difference = {
  type: string
  taskId?: string
  taskDir?: string
  local?: DifferenceSide | null
  server?: DifferenceSide | null
}
type DiffFile = {
  path?: string
  localContent?: string | null
  serverContent?: string | null
  changedBy?: ChangedBy | string
}
type DiffResult = { taskId?: string; taskTitle?: string; files?: DiffFile[] }
type OwnershipChoice = { taskSpaceId?: string; branchName?: string }
type OwnershipItem = {
  taskId?: string
  taskDir: string
  title?: string
  branchName?: string | null
  choices?: OwnershipChoice[]
}
type ControlEvent =
  | { type: 'initial_sync_review'; taskSpaceId?: string; differences?: Difference[] }
  | { type: 'task_file_conflict'; taskSpaceId?: string; conflict?: Conflict }
  | {
      type: 'task_ownership_review'
      taskSpaceId?: string
      branchName?: string
      items?: OwnershipItem[]
    }
  | {
      type: 'task_sync_error'
      taskSpaceId?: string
      projectName?: string
      branchName?: string
      taskDir?: string
      message?: string
    }
type ReviewOption = { value: string; label: string }
type Action = { label: string; action: string; variant?: 'default' | 'destructive' | 'outline' }

function errorTextOf(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : String(error || fallback)
}

function formatSource(changedBy: ChangedBy | string | null | undefined): string {
  if (!changedBy || typeof changedBy === 'string') return ''
  return [
    changedBy.displayName,
    changedBy.deviceName,
    changedBy.occurredAt ? new Date(changedBy.occurredAt).toLocaleString() : null,
  ]
    .filter(Boolean)
    .join(' · ')
}

function conflictLabel(conflict: string | ConflictFile): string {
  if (typeof conflict === 'string') return conflict
  const parts = [conflict.path ?? '']
  if (Number.isSafeInteger(conflict.revision)) parts.push(`文件版本 r${conflict.revision}`)
  if (conflict.changeType === 'line-endings') parts.push('仅换行差异')
  if (conflict.changeType === 'content') parts.push('内容变化')
  parts.push(formatSource(conflict.changedBy))
  return parts.filter(Boolean).join(' · ')
}

function differenceTypeLabel(type: string): string {
  switch (type) {
    case 'server-only':
      return '仅服务端存在'
    case 'local-only':
      return '仅本地存在'
    case 'content-conflict':
      return '内容冲突'
    case 'move-delete-conflict':
      return '移动或删除冲突'
    case 'invalid':
      return '任务结构或身份异常'
    default:
      return type
  }
}

function differenceTitle(difference: Difference): string {
  return (
    difference.server?.taskId ||
    difference.local?.taskId ||
    difference.taskId ||
    difference.server?.taskDir ||
    difference.local?.taskDir ||
    difference.taskDir ||
    '未知任务'
  )
}

function differenceKey(difference: Difference): string {
  return String(
    difference.taskId ||
      difference.taskDir ||
      difference.local?.taskId ||
      difference.server?.taskId ||
      '',
  )
}

function reviewOptions(difference: Difference): { options: ReviewOption[]; fallback: string } {
  if (difference.type === 'server-only') {
    return {
      options: [
        { value: 'use-server', label: '下载服务端任务' },
        { value: 'skip', label: '暂不处理' },
      ],
      fallback: 'use-server',
    }
  }
  if (difference.type === 'local-only') {
    return {
      options: [
        { value: 'use-local', label: '上传本地任务' },
        { value: 'skip', label: '暂不处理' },
      ],
      fallback: 'use-local',
    }
  }
  if (difference.type === 'invalid') {
    return {
      options: difference.local
        ? [
            { value: 'save-local', label: '仅保存本地副本' },
            { value: 'skip', label: '暂不处理' },
          ]
        : [{ value: 'skip', label: '暂不处理' }],
      fallback: 'skip',
    }
  }
  return {
    options: [
      { value: 'use-server', label: '使用服务端版本' },
      { value: 'use-local', label: '使用本地版本' },
      { value: 'save-local', label: '仅保存本地副本' },
      { value: 'skip', label: '暂不处理' },
    ],
    fallback: 'skip',
  }
}

function ActionBar({
  actions,
  busy,
  onAction,
}: {
  actions: Action[]
  busy: boolean
  onAction: (action: string) => void
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {actions.map((item) => (
        <Button
          key={`${item.action}:${item.label}`}
          size="sm"
          variant={item.variant ?? 'outline'}
          disabled={busy && item.action !== 'close'}
          onClick={() => onAction(item.action)}
        >
          {item.label}
        </Button>
      ))}
    </div>
  )
}

function ReviewChoice({
  difference,
  value,
  onChange,
}: {
  difference: Difference
  value: string
  onChange: (value: string) => void
}) {
  const { options } = reviewOptions(difference)
  const current = options.find((option) => option.value === value)
  return (
    <Select value={value} onValueChange={(next) => onChange(String(next ?? ''))}>
      <SelectTrigger size="sm" className="mt-1 w-full">
        <span data-slot="select-value" className="flex flex-1 items-center text-left">
          {current?.label ?? value}
        </span>
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function DiffFileView({ file }: { file: DiffFile }) {
  const source = formatSource(file.changedBy)
  return (
    <div>
      <p className="font-medium text-foreground">{file.path}</p>
      <div className="mt-2 grid gap-2 md:grid-cols-2">
        {[
          { label: '本地版本', content: file.localContent },
          { label: '服务端版本', content: file.serverContent },
        ].map((side) => (
          <section key={side.label}>
            <strong className="text-[0.6875rem] text-muted-foreground">{side.label}</strong>
            <pre className="mt-1 max-h-[13.75rem] overflow-auto rounded-md bg-background/60 p-2 text-[0.6875rem] leading-5 whitespace-pre-wrap break-words">
              {side.content ?? '该文件在对应版本中不存在'}
            </pre>
          </section>
        ))}
      </div>
      {source ? <p className="mt-1 text-muted-foreground">{source}</p> : null}
    </div>
  )
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!invoke) throw new Error('本地客户端控制接口不可用')
  return invoke<T>(command, args)
}

export function ControlApp() {
  const [event, setEvent] = useState<ControlEvent | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [errorText, setErrorText] = useState<string | null>(null)
  const [diff, setDiff] = useState<DiffResult | null>(null)
  const [choices, setChoices] = useState<Record<string, string>>({})
  const [ownershipSelected, setOwnershipSelected] = useState<Set<string>>(() => new Set())
  const [ownershipBranches, setOwnershipBranches] = useState<Record<string, string>>({})
  const cardRef = useRef<HTMLDivElement>(null)

  const [refreshCoordinator] = useState(() => {
    let signature = ''
    return createRefreshCoordinator(async () => {
      try {
        const next = await call<ControlEvent | null>('live_control_pending')
        const nextSignature = JSON.stringify(next)
        if (nextSignature !== signature) {
          signature = nextSignature
          setEvent(next)
          setLoaded(true)
          setBusy(false)
          setExpanded(false)
          setDiff(null)
          setChoices({})
          if (next?.type === 'task_ownership_review') {
            const items = next.items ?? []
            setOwnershipSelected(new Set(items.map((item) => item.taskDir)))
            setOwnershipBranches(
              Object.fromEntries(
                items.map((item) => [item.taskDir, item.branchName || next.branchName || '']),
              ),
            )
          } else {
            setOwnershipSelected(new Set())
            setOwnershipBranches({})
          }
        }
      } catch (error) {
        setErrorText(errorTextOf(error, '读取待确认事件失败'))
      }
    })
  })
  const refresh = useCallback(() => refreshCoordinator.request(), [refreshCoordinator])

  async function runAction(action: string) {
    if (!event) return
    if (action === 'close') {
      try {
        await call('live_control_dismiss')
        setEvent(null)
        await refresh()
      } catch (error) {
        setErrorText(errorTextOf(error, '关闭通知失败'))
      }
      return
    }
    if (action === 'review-open') {
      setExpanded(true)
      return
    }
    if (action === 'review-collapse') {
      setExpanded(false)
      return
    }
    if (action === 'back') {
      setDiff(null)
      return
    }
    if (busy) return
    setBusy(true)
    setErrorText(null)
    try {
      if (event.type === 'task_file_conflict') {
        const conflict = event.conflict ?? {}
        if (action === 'view-difference') {
          const result = await call<DiffResult>('live_control_diff', {
            taskSpaceId: event.taskSpaceId,
            conflictId: conflict.conflictId,
          })
          setBusy(false)
          setDiff(result)
          return
        }
        if (
          action === 'overwrite-server' &&
          !window.confirm('这会用本地任务目录覆盖服务端当前版本，双方内容都会先备份。确认继续？')
        ) {
          setBusy(false)
          return
        }
        await call('live_control_decide', {
          taskSpaceId: event.taskSpaceId,
          conflictId: conflict.conflictId,
          action,
        })
      } else if (event.type === 'initial_sync_review') {
        if (action === 'apply-review') {
          const decisions = (event.differences ?? [])
            .filter((item) => item.type !== 'same')
            .map((item) => ({
              taskId: differenceKey(item),
              action: choices[differenceKey(item)] ?? reviewOptions(item).fallback,
            }))
          await call('live_control_initial', {
            taskSpaceId: event.taskSpaceId,
            mode: 'review',
            decisions,
          })
        } else {
          await call('live_control_initial', {
            taskSpaceId: event.taskSpaceId,
            mode: action,
          })
        }
      } else if (event.type === 'task_ownership_review') {
        const selected = new Set(ownershipSelected)
        const items = (event.items ?? []).filter((item) => selected.has(item.taskDir))
        if (!items.length) throw new Error('请至少选择一个任务')
        const decisions = items.map((item) => {
          if (action === 'ownership-defer') {
            return { taskDir: item.taskDir, action: 'defer' }
          }
          return {
            taskDir: item.taskDir,
            action: 'use-branch',
            branchName:
              action === 'ownership-current'
                ? event.branchName
                : ownershipBranches[item.taskDir] || event.branchName,
          }
        })
        for (let index = 0; index < decisions.length; index += 200) {
          await call('set_task_ownership', {
            taskSpaceId: event.taskSpaceId,
            decisions: decisions.slice(index, index + 200),
          })
        }
      }
      setEvent(null)
      setBusy(false)
    } catch (error) {
      setErrorText(errorTextOf(error, '操作失败'))
      setBusy(false)
      setChoices({})
    }
  }

  useEffect(() => {
    let cancelled = false
    let unlisten: (() => void) | undefined
    let timer = 0

    const clearFallback = () => {
      if (timer) window.clearTimeout(timer)
      timer = 0
    }
    const scheduleFallback = () => {
      clearFallback()
      if (document.visibilityState === 'visible') {
        timer = window.setTimeout(() => {
          void refresh().finally(scheduleFallback)
        }, 10_000)
      }
    }
    const refreshVisible = () => {
      if (document.visibilityState !== 'visible') return
      void refresh()
      scheduleFallback()
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') refreshVisible()
      else clearFallback()
    }

    async function setup() {
      if (listen) {
        try {
          unlisten = await listen('live-control-changed', refreshVisible)
        } catch {
          unlisten = undefined
        }
      }
      if (cancelled) {
        unlisten?.()
        return
      }
      window.addEventListener('focus', refreshVisible)
      document.addEventListener('visibilitychange', onVisibilityChange)
      await refresh()
      if (!cancelled) scheduleFallback()
    }
    void setup()

    return () => {
      cancelled = true
      unlisten?.()
      clearFallback()
      window.removeEventListener('focus', refreshVisible)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      refreshCoordinator.dispose()
    }
  }, [refresh, refreshCoordinator])

  useEffect(() => {
    const element = cardRef.current
    const send = invoke
    if (!element || !send) return
    let frame = 0
    const report = () => {
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(() => {
        const rect = element.getBoundingClientRect()
        void send('live_control_resize', { height: Math.ceil(rect.bottom + 12) }).catch(() => {})
      })
    }
    report()
    const observer = new ResizeObserver(report)
    observer.observe(element)
    return () => {
      window.cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [])

  const differences =
    event?.type === 'initial_sync_review'
      ? (event.differences ?? []).filter((item) => item.type !== 'same')
      : []
  const conflict = event?.type === 'task_file_conflict' ? (event.conflict ?? {}) : null
  const conflictSource = formatSource(conflict?.files?.find((file) => file.changedBy)?.changedBy)
  const ownershipItems = event?.type === 'task_ownership_review' ? (event.items ?? []) : []
  const ownershipChoices =
    event?.type === 'task_ownership_review'
      ? [
          ...new Map(
            ownershipItems
              .flatMap((item) => item.choices ?? [])
              .filter(
                (choice): choice is OwnershipChoice & { branchName: string } =>
                  typeof choice.branchName === 'string' && Boolean(choice.branchName),
              )
              .map((choice) => [choice.branchName, choice] as const),
          ).values(),
        ]
      : []

  let title = '当前没有待处理事件'
  if (!loaded) title = '正在读取待确认事件…'
  else if (diff) title = `任务「${diff.taskTitle || diff.taskId || '未知任务'}」差异`
  else if (event?.type === 'initial_sync_review') title = '任务差异需要确认'
  else if (conflict)
    title = `任务「${conflict.taskTitle || conflict.taskId || '未知任务'}」发生冲突`
  else if (event?.type === 'task_ownership_review') title = '任务归属需要确认'
  else if (event?.type === 'task_sync_error') title = '任务同步失败'

  let message = ''
  if (busy) message = '正在提交，请稍候…'
  else if (diff) message = '本地版本与服务端版本逐项对照。关闭后可继续选择保留哪一份。'
  else if (event?.type === 'initial_sync_review')
    message = '本地仓库和团队服务端任务不一致。可以先仅同步安全项，或逐项决定每个任务保留哪一份。'
  else if (conflict)
    message = conflictSource
      ? `${conflictSource} 修改了该任务。本次没有覆盖任何文件，请选择保留哪一份。`
      : '任务文件已发生变化。本次没有覆盖任何文件，请选择保留哪一份。'
  else if (event?.type === 'task_ownership_review')
    message = '以下任务无法唯一判断属于哪个分支。可批量归属、逐项选择或暂不处理。'
  else if (event?.type === 'task_sync_error')
    message = event.message || '任务空间同步暂时失败，请稍后重试。'

  let actions: Action[] = []
  if (diff) {
    actions = [{ label: '返回冲突处理', action: 'back', variant: 'default' }]
  } else if (event?.type === 'initial_sync_review' && expanded) {
    actions = [
      { label: '返回摘要', action: 'review-collapse' },
      { label: '应用选择', action: 'apply-review', variant: 'default' },
    ]
  } else if (event?.type === 'initial_sync_review') {
    actions = [
      { label: '仅同步无冲突项', action: 'safe' },
      { label: '查看并处理差异', action: 'review-open', variant: 'default' },
      { label: '稍后处理', action: 'close' },
    ]
  } else if (conflict) {
    actions = [
      { label: '查看差异', action: 'view-difference' },
      { label: '使用服务端版本', action: 'use-server' },
      { label: '用我的版本覆盖', action: 'overwrite-server', variant: 'destructive' },
      { label: '仅保存本地副本', action: 'save-local-copy' },
      { label: '稍后处理', action: 'close' },
    ]
  } else if (event?.type === 'task_ownership_review') {
    actions = [
      { label: '归属当前分支', action: 'ownership-current', variant: 'default' },
      { label: '应用逐项选择', action: 'ownership-apply' },
      { label: '暂不处理', action: 'ownership-defer' },
      { label: '关闭窗口', action: 'close' },
    ]
  } else if (event?.type === 'task_sync_error') {
    actions = [{ label: '关闭', action: 'close', variant: 'default' }]
  }

  return (
    <main className="bg-background p-3">
      <Card ref={cardRef} className="w-full [--card-spacing:--spacing(5)]">
        <CardHeader>
          <p className="text-[0.625rem] font-semibold tracking-[0.2em] text-muted-foreground">
            团队实时同步
          </p>
          <h1 className="font-heading text-xl font-medium">{title}</h1>
          {message ? (
            <p role="status" className="text-sm leading-6 text-muted-foreground">
              {message}
            </p>
          ) : null}
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {diff ? (
            <div className="flex flex-col gap-4 text-xs">
              {(diff.files ?? []).map((file, index) => (
                <DiffFileView key={`${file.path ?? 'file'}:${index}`} file={file} />
              ))}
            </div>
          ) : null}

          {!diff && event?.type === 'initial_sync_review' && !expanded ? (
            <dl className="grid grid-cols-[80px_minmax(0,1fr)] gap-2 rounded-md bg-muted/50 p-3 text-xs">
              <dt className="text-muted-foreground">任务空间</dt>
              <dd className="break-words">{event.taskSpaceId ?? ''}</dd>
              {differences.length > 0 ? (
                <>
                  <dt className="text-muted-foreground">差异</dt>
                  <dd className="break-words">
                    {differences
                      .map(
                        (item) => `${differenceTitle(item)}（${differenceTypeLabel(item.type)}）`,
                      )
                      .join('、')}
                  </dd>
                </>
              ) : null}
            </dl>
          ) : null}

          {!diff && event?.type === 'initial_sync_review' && expanded ? (
            <div className="flex flex-col gap-3 text-xs">
              {differences.map((item, index) => {
                const key = differenceKey(item)
                const pathSummary = [
                  item.local?.taskDir ? `本地：${item.local.taskDir}` : null,
                  item.server?.taskDir ? `服务端：${item.server.taskDir}` : null,
                ]
                  .filter(Boolean)
                  .join('；')
                return (
                  <div key={`${key}:${index}`} className="rounded-md bg-muted/50 p-3">
                    <p className="font-medium text-foreground">
                      {differenceTitle(item)} · {differenceTypeLabel(item.type)}
                    </p>
                    {pathSummary ? (
                      <p className="mt-1 break-words text-muted-foreground">{pathSummary}</p>
                    ) : null}
                    <div className="mt-2 flex flex-col gap-1">
                      <span className="text-muted-foreground">处理方式</span>
                      <ReviewChoice
                        difference={item}
                        value={choices[key] ?? reviewOptions(item).fallback}
                        onChange={(value) =>
                          setChoices((current) => ({ ...current, [key]: value }))
                        }
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          ) : null}

          {!diff && conflict ? (
            <dl className="grid grid-cols-[80px_minmax(0,1fr)] gap-2 rounded-md bg-muted/50 p-3 text-xs">
              {(conflict.files ?? []).length > 0 ? (
                <>
                  <dt className="text-muted-foreground">冲突文件</dt>
                  <dd className="flex flex-col gap-1 break-words">
                    {(conflict.files ?? []).map((file, index) => (
                      <span key={`${file.path ?? 'conflict'}:${index}`}>{conflictLabel(file)}</span>
                    ))}
                  </dd>
                </>
              ) : null}
              {conflict.suggestion ? (
                <>
                  <dt className="text-muted-foreground">处理建议</dt>
                  <dd className="break-words">{conflict.suggestion}</dd>
                </>
              ) : null}
            </dl>
          ) : null}

          {!diff && event?.type === 'task_ownership_review' ? (
            <div className="flex flex-col gap-2 text-xs">
              {ownershipItems.map((item) => (
                <div key={item.taskDir} className="rounded-md bg-muted/50 p-3">
                  <label className="flex items-start gap-2 font-medium text-foreground">
                    <input
                      type="checkbox"
                      checked={ownershipSelected.has(item.taskDir)}
                      onChange={(change) =>
                        setOwnershipSelected((current) => {
                          const next = new Set(current)
                          if (change.target.checked) next.add(item.taskDir)
                          else next.delete(item.taskDir)
                          return next
                        })
                      }
                    />
                    <span>{item.title || item.taskId || item.taskDir}</span>
                  </label>
                  <p className="mt-1 break-all text-muted-foreground">{item.taskDir}</p>
                  <p className="mt-1 text-muted-foreground">
                    {item.branchName ? `当前归属：${item.branchName}` : '当前归属：未确认'}
                  </p>
                  <select
                    className="mt-2 w-full rounded-md border border-border bg-background px-2 py-1 text-xs"
                    value={ownershipBranches[item.taskDir] || event.branchName || ''}
                    onChange={(change) =>
                      setOwnershipBranches((current) => ({
                        ...current,
                        [item.taskDir]: change.target.value,
                      }))
                    }
                  >
                    {ownershipChoices.length ? (
                      ownershipChoices.map((choice) => (
                        <option key={choice.branchName} value={choice.branchName}>
                          {choice.branchName}
                        </option>
                      ))
                    ) : (
                      <option value={event.branchName || ''}>
                        {event.branchName || '当前分支'}
                      </option>
                    )}
                  </select>
                </div>
              ))}
            </div>
          ) : null}

          {!diff && event?.type === 'task_sync_error' ? (
            <dl className="grid grid-cols-[80px_minmax(0,1fr)] gap-2 rounded-md bg-muted/50 p-3 text-xs">
              <dt className="text-muted-foreground">任务空间</dt>
              <dd className="break-words">
                {[event.projectName, event.branchName].filter(Boolean).join(' / ') ||
                  event.taskSpaceId ||
                  ''}
              </dd>
              {event.taskSpaceId ? (
                <>
                  <dt className="text-muted-foreground">诊断 ID</dt>
                  <dd className="break-all text-muted-foreground">{event.taskSpaceId}</dd>
                </>
              ) : null}
              {event.taskDir ? (
                <>
                  <dt className="text-muted-foreground">任务目录</dt>
                  <dd className="break-all text-muted-foreground">{event.taskDir}</dd>
                </>
              ) : null}
            </dl>
          ) : null}

          {errorText ? (
            <p role="alert" className="flex items-start gap-2 text-sm text-destructive">
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              {errorText}
            </p>
          ) : null}

          {actions.length > 0 ? (
            <ActionBar actions={actions} busy={busy} onAction={runAction} />
          ) : null}
        </CardContent>
      </Card>
    </main>
  )
}
