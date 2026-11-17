import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { SelectField } from '../SelectField'

type OwnershipChoice = {
  taskSpaceId: string
  branchName: string
}

type OwnershipItem = {
  taskId: string
  taskDir: string
  title: string
  branchName: string | null
  suggestedBranchName: string | null
  choices: OwnershipChoice[]
}

type OwnershipResponse = {
  taskSpaceId: string
  branchName: string
  projectTaskSpaces: OwnershipChoice[]
  items: OwnershipItem[]
}

type TaskOwnershipDialogProps = {
  open: boolean
  taskSpaceId: string
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>
  onOpenChange: (open: boolean) => void
  onChanged: () => void
}

function normalizeChoice(value: unknown): OwnershipChoice | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (typeof record.taskSpaceId !== 'string' || typeof record.branchName !== 'string') return null
  const branchName = record.branchName.trim()
  return record.taskSpaceId && branchName ? { taskSpaceId: record.taskSpaceId, branchName } : null
}

function normalizeItem(value: unknown): OwnershipItem | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (
    typeof record.taskDir !== 'string' ||
    !record.taskDir.startsWith('.trellis/tasks/') ||
    typeof record.title !== 'string'
  ) {
    return null
  }
  const choices = Array.isArray(record.choices)
    ? record.choices.flatMap((choice) => {
        const normalized = normalizeChoice(choice)
        return normalized ? [normalized] : []
      })
    : []
  const taskId =
    typeof record.taskId === 'string' && record.taskId.trim()
      ? record.taskId.trim()
      : record.taskDir
  return {
    taskId,
    taskDir: record.taskDir,
    title: record.title.trim() || taskId,
    branchName: typeof record.branchName === 'string' ? record.branchName : null,
    suggestedBranchName:
      typeof record.suggestedBranchName === 'string' ? record.suggestedBranchName : null,
    choices,
  }
}

function normalizeResponse(value: unknown, fallbackTaskSpaceId: string): OwnershipResponse {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const projectTaskSpaces = Array.isArray(record.projectTaskSpaces)
    ? record.projectTaskSpaces.flatMap((choice) => {
        const normalized = normalizeChoice(choice)
        return normalized ? [normalized] : []
      })
    : []
  const items = Array.isArray(record.items)
    ? record.items.flatMap((item) => {
        const normalized = normalizeItem(item)
        return normalized ? [normalized] : []
      })
    : []
  return {
    taskSpaceId: typeof record.taskSpaceId === 'string' ? record.taskSpaceId : fallbackTaskSpaceId,
    branchName: typeof record.branchName === 'string' ? record.branchName : '',
    projectTaskSpaces,
    items,
  }
}

export function TaskOwnershipDialog({
  open,
  taskSpaceId,
  invoke,
  onOpenChange,
  onChanged,
}: TaskOwnershipDialogProps) {
  const dialogHeaderRef = useRef<HTMLDivElement>(null)
  const [result, setResult] = useState<OwnershipResponse | null>(null)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [otherBranch, setOtherBranch] = useState('')
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => {
    if (!open || !taskSpaceId) return
    let active = true
    setResult(null)
    setSelected(new Set())
    setLoading(true)
    setMessage('')
    invoke('list_task_ownership', { taskSpaceId })
      .then((value) => {
        if (!active) return
        const next = normalizeResponse(value, taskSpaceId)
        setResult(next)
        setSelected(new Set(next.items.map((item) => item.taskDir)))
        setOtherBranch('')
      })
      .catch((error) => {
        if (active) {
          setResult(null)
          setSelected(new Set())
          setMessage(error instanceof Error ? error.message : '无法读取任务归属候选')
        }
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [invoke, open, taskSpaceId])

  const items = result?.items || []
  const choices = useMemo(() => {
    const values = new Map<string, OwnershipChoice>()
    for (const choice of [
      ...(result?.projectTaskSpaces || []),
      ...items.flatMap((item) => item.choices),
    ]) {
      values.set(choice.taskSpaceId, choice)
    }
    return [...values.values()].sort((left, right) => {
      if (left.branchName === result?.branchName) return -1
      if (right.branchName === result?.branchName) return 1
      return left.branchName.localeCompare(right.branchName, 'zh-CN')
    })
  }, [items, result?.branchName, result?.projectTaskSpaces])
  const otherChoices = choices.filter((choice) => choice.branchName !== result?.branchName)
  const selectedDirs = [...selected].filter((taskDir) =>
    items.some((item) => item.taskDir === taskDir),
  )
  const allSelected = items.length > 0 && selectedDirs.length === items.length
  const pausedItems = items.filter((item) => item.branchName)
  const pendingItems = items.filter((item) => !item.branchName)

  function toggleAll(checked: boolean) {
    setSelected(checked ? new Set(items.map((item) => item.taskDir)) : new Set())
  }

  function toggleItem(taskDir: string, checked: boolean) {
    setSelected((current) => {
      const next = new Set(current)
      if (checked) next.add(taskDir)
      else next.delete(taskDir)
      return next
    })
  }

  async function submitDecisions(action: 'use-branch' | 'defer', branchName = '') {
    if (!selectedDirs.length || submitting) return
    setSubmitting(true)
    setMessage('')
    try {
      const decisions = selectedDirs.map((taskDir) =>
        action === 'use-branch' ? { taskDir, action, branchName } : { taskDir, action },
      )
      for (let index = 0; index < decisions.length; index += 200) {
        await invoke('set_task_ownership', {
          taskSpaceId,
          decisions: decisions.slice(index, index + 200),
        })
      }
      onChanged()
      onOpenChange(false)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '保存任务归属失败')
    } finally {
      setSubmitting(false)
    }
  }

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen && submitting) return
    onOpenChange(nextOpen)
  }

  function renderOwnershipGroup(label: string, group: OwnershipItem[]) {
    if (!group.length) return null
    return (
      <section className="flex flex-col gap-2">
        <h3 className="text-xs font-semibold text-muted-foreground">
          {label}（{group.length}）
        </h3>
        {group.map((item) => (
          <label
            key={item.taskDir}
            className="flex items-start gap-2 rounded-lg border border-border p-2.5"
          >
            <Checkbox
              checked={selected.has(item.taskDir)}
              onCheckedChange={(checked) => toggleItem(item.taskDir, checked === true)}
              disabled={submitting}
            />
            <span className="min-w-0 flex-1">
              <span className="block text-xs font-medium text-foreground">{item.title}</span>
              <span className="mt-0.5 block break-all text-2xs text-muted-foreground">
                {item.taskDir}
              </span>
              <span className="mt-1 block text-2xs text-muted-foreground">
                {item.branchName ? `当前归属：${item.branchName}` : '当前归属：未确认'}
                {item.suggestedBranchName ? ` · 建议：${item.suggestedBranchName}` : ''}
              </span>
            </span>
          </label>
        ))}
      </section>
    )
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-190" initialFocus={dialogHeaderRef}>
        <DialogHeader ref={dialogHeaderRef} tabIndex={-1} className="outline-none">
          <DialogTitle>确认任务归属分支</DialogTitle>
          <DialogDescription>
            只处理当前分支中归属为其他分支或仍待确认的任务；选择后会写入本地 task.json。
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          {loading ? <p className="text-xs text-muted-foreground">正在读取本地任务…</p> : null}
          {!loading && !items.length ? (
            <p className="text-xs text-muted-foreground">当前没有需要处理归属的任务。</p>
          ) : null}
          {items.length ? (
            <>
              <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border p-2">
                <label className="flex items-center gap-2 text-xs font-medium">
                  <Checkbox
                    checked={allSelected}
                    onCheckedChange={(checked) => toggleAll(checked === true)}
                    disabled={submitting}
                  />
                  全选
                </label>
                <span className="text-xs text-muted-foreground">
                  已选 {selectedDirs.length}/{items.length}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={!selectedDirs.length || submitting || !result?.branchName}
                  onClick={() => void submitDecisions('use-branch', result?.branchName || '')}
                >
                  归属当前分支
                </Button>
                <SelectField
                  id="ownership-other-branch"
                  value={otherBranch}
                  placeholder="其他可见分支"
                  ariaLabel="其他可见分支"
                  options={otherChoices.map((choice) => ({
                    value: choice.branchName,
                    label: choice.branchName,
                  }))}
                  onChange={setOtherBranch}
                  disabled={submitting || !otherChoices.length}
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={!selectedDirs.length || !otherBranch || submitting}
                  onClick={() => void submitDecisions('use-branch', otherBranch)}
                >
                  归属所选分支
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={!selectedDirs.length || submitting}
                  onClick={() => void submitDecisions('defer')}
                >
                  暂不处理
                </Button>
              </div>
              {renderOwnershipGroup('因分支不匹配暂停', pausedItems)}
              {renderOwnershipGroup('待确认归属', pendingItems)}
            </>
          ) : null}
          {message ? (
            <p role="alert" className="text-xs text-destructive">
              {message}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
