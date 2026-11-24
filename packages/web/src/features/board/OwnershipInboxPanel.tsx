import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  defaultOwnershipBranch,
  ownershipAssignAvailability,
  ownershipAssignErrorMessage,
  ownershipInboxItemKey,
  ownershipInboxReasonLabel,
} from '@/lib/ownership-inbox.js'
import type {
  OwnershipBranchOption,
  OwnershipInboxItem,
  OwnershipInboxProjectGroup,
  OwnershipLocalAssociation,
} from '@/lib/ownership-inbox.js'
import { Empty, EmptyDescription } from '@/components/ui/empty'
import { Skeleton } from '@/components/ui/skeleton'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { StatusPill, toneSurface } from '@/components/ui/status-pill'
import { SelectField } from './SelectField'

type OwnershipInboxPanelProps = {
  count: number
  projectGroups: OwnershipInboxProjectGroup[]
  projectId: string
  open: boolean
  items: OwnershipInboxItem[]
  total: number
  nextCursor: string | null
  loading: boolean
  loadingMore: boolean
  error: string
  currentUserId: string
  isTauri: boolean
  invoke: ((command: string, args?: Record<string, unknown>) => Promise<unknown>) | null
  taskSpacesByProject: Map<string, OwnershipBranchOption[]>
  localAssociations: Map<string, OwnershipLocalAssociation>
  onToggle: () => void
  onRetry: () => void
  onLoadMore: () => void
  onAssigned: () => void
}

function inboxTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '时间未知'
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function clientLabel(client: OwnershipInboxItem['sourceClients'][number]) {
  if (!client.username || client.username === client.displayName) return client.displayName
  return `${client.displayName} (@${client.username})`
}

export function OwnershipInboxPanel({
  count,
  projectGroups,
  projectId,
  open,
  items,
  total,
  nextCursor,
  loading,
  loadingMore,
  error,
  currentUserId,
  isTauri,
  invoke,
  taskSpacesByProject,
  localAssociations,
  onToggle,
  onRetry,
  onLoadMore,
  onAssigned,
}: OwnershipInboxPanelProps) {
  const [assigningKey, setAssigningKey] = useState<string | null>(null)
  const [branchDraft, setBranchDraft] = useState('')
  const [submittingKey, setSubmittingKey] = useState<string | null>(null)
  const [assignErrors, setAssignErrors] = useState<Record<string, string>>({})

  function clearAssignError(key: string) {
    setAssignErrors((current) => {
      if (!current[key]) return current
      const next = { ...current }
      delete next[key]
      return next
    })
  }

  function startAssign(item: OwnershipInboxItem, branches: OwnershipBranchOption[]) {
    const key = ownershipInboxItemKey(item)
    const branch = defaultOwnershipBranch(item, branches)
    setAssigningKey(key)
    setBranchDraft(branch?.branchName || '')
    clearAssignError(key)
  }

  function cancelAssign() {
    setAssigningKey(null)
    setBranchDraft('')
  }

  async function submitAssign(item: OwnershipInboxItem) {
    if (!invoke || submittingKey || !branchDraft) return
    const key = ownershipInboxItemKey(item)
    setSubmittingKey(key)
    clearAssignError(key)
    try {
      await invoke('set_task_ownership', {
        taskSpaceId: item.taskSpaceId,
        decisions: [{ taskDir: item.taskDir, action: 'use-branch', branchName: branchDraft }],
      })
      setAssigningKey(null)
      setBranchDraft('')
      onAssigned()
    } catch (assignError) {
      setAssignErrors((current) => ({
        ...current,
        [key]: ownershipAssignErrorMessage(assignError),
      }))
    } finally {
      setSubmittingKey(null)
    }
  }

  const groupedItems = useMemo(() => {
    const groups = new Map<string, { projectName: string; items: OwnershipInboxItem[] }>()
    for (const item of items) {
      const current = groups.get(item.projectId)
      if (current) {
        current.items.push(item)
      } else {
        groups.set(item.projectId, { projectName: item.projectName, items: [item] })
      }
    }
    return [...groups.entries()].map(([projectIdValue, group]) => ({
      projectId: projectIdValue,
      ...group,
    }))
  }, [items])

  if (count < 1) return null

  const scopeLabel =
    projectId === 'all'
      ? '全部项目'
      : projectGroups.find((group) => group.projectId === projectId)?.projectName || '当前项目'

  return (
    <section
      className={`rounded-xl border border-warning/35 px-3 py-2.5 ${toneSurface('warning')}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <div role="status" className="min-w-0 flex-1">
          <p className="text-xs font-semibold">
            {scopeLabel}：待归属任务 {count}
          </p>
          <p className="mt-0.5 text-2xs leading-4">
            这些任务尚未确定 Git 分支归属，不属于任何分支看板或合入统计。
            {projectId === 'all' && projectGroups.length
              ? ` ${projectGroups
                  .map((group) => `${group.projectName} ${group.count}`)
                  .join(' · ')}`
              : ''}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="border-warning/40 bg-background/70 text-warning hover:bg-background hover:text-warning dark:bg-background/70 dark:hover:bg-background"
          aria-expanded={open}
          aria-controls="ownership-inbox-list"
          onClick={onToggle}
        >
          {open ? '收起待归属任务' : '查看待归属任务'}
        </Button>
      </div>

      {open ? (
        <div id="ownership-inbox-list" className="mt-2 border-t border-warning/25 pt-2">
          {error ? (
            <Alert variant="destructive" className="mb-2 bg-background/70 px-2 py-1.5">
              <AlertDescription className="flex flex-wrap items-center gap-2 text-xs">
                <span className="min-w-0 flex-1 break-words">待归属任务加载失败：{error}</span>
                <Button type="button" variant="outline" size="xs" onClick={onRetry}>
                  重试
                </Button>
              </AlertDescription>
            </Alert>
          ) : null}

          {loading && items.length === 0 ? (
            <div className="flex flex-col gap-1.5 py-2">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          ) : null}

          {!loading && !error && items.length === 0 ? (
            <Empty className="p-3">
              <EmptyDescription>当前范围内没有待归属任务。</EmptyDescription>
            </Empty>
          ) : null}

          <div className="flex flex-col gap-2">
            {groupedItems.map((group) => (
              <div key={group.projectId} className="rounded-lg bg-background/65 p-2">
                {projectId === 'all' ? (
                  <p className="mb-1 text-2xs font-semibold text-warning">{group.projectName}</p>
                ) : null}
                <ul className="flex flex-col divide-y divide-border/60">
                  {group.items.map((item) => {
                    const key = ownershipInboxItemKey(item)
                    const availability = ownershipAssignAvailability({
                      item,
                      currentUserId,
                      isTauri,
                      branches: taskSpacesByProject.get(item.projectId) || [],
                      association: localAssociations.get(item.taskSpaceId) || null,
                    })
                    const submitting = submittingKey === key
                    const assigning = assigningKey === key
                    const assignBusy = Boolean(submittingKey)
                    return (
                      <li key={key} className="py-2 first:pt-0 last:pb-0">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <p className="min-w-0 flex-1 break-words text-xs font-semibold text-foreground">
                            {item.title}
                          </p>
                          <StatusPill tone="warning" size="xs" className="shrink-0">
                            待归属
                          </StatusPill>
                        </div>
                        <p className="mt-0.5 break-all font-mono text-2xs text-muted-foreground">
                          {item.taskDir}
                        </p>
                        <p className="mt-1 break-words text-xs text-foreground">
                          {ownershipInboxReasonLabel(item.reason)}
                          <span className="ml-1 text-2xs text-muted-foreground">
                            ({item.reason})
                          </span>
                        </p>
                        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-2xs leading-4 text-muted-foreground">
                          <span>
                            来源分支：
                            {item.sourceBranches.length ? item.sourceBranches.join('、') : '未知'}
                          </span>
                          <span>
                            来源客户端：
                            {item.sourceClients.length
                              ? item.sourceClients.map(clientLabel).join('、')
                              : '未知'}
                          </span>
                          <span>负责人：{item.assigneeDevId || '未知'}</span>
                          <span>最近发现：{inboxTime(item.lastSeenAt)}</span>
                        </div>
                        <div className="mt-1.5 flex flex-wrap items-center gap-2">
                          {assigning ? (
                            <>
                              <SelectField
                                id={`ownership-branch-${key.replace(/[^a-zA-Z0-9_-]/g, '-')}`}
                                value={branchDraft}
                                ariaLabel="归属分支"
                                placeholder="选择归属分支"
                                className="w-auto min-w-40 max-w-56"
                                options={availability.branches.map((branch) => ({
                                  value: branch.branchName,
                                  label: branch.branchName,
                                }))}
                                onChange={setBranchDraft}
                                disabled={assignBusy}
                              />
                              <Button
                                type="button"
                                variant="outline"
                                className="border-warning/40 bg-background/70 text-warning hover:bg-background hover:text-warning dark:bg-background/70 dark:hover:bg-background"
                                disabled={!branchDraft || assignBusy}
                                onClick={() => void submitAssign(item)}
                              >
                                {submitting ? '归属中…' : '确认归属'}
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                disabled={assignBusy}
                                onClick={cancelAssign}
                              >
                                取消
                              </Button>
                            </>
                          ) : (
                            <Button
                              type="button"
                              variant="outline"
                              className="border-warning/40 bg-background/70 text-warning hover:bg-background hover:text-warning dark:bg-background/70 dark:hover:bg-background"
                              disabled={!availability.available || assignBusy}
                              title={availability.reason || undefined}
                              onClick={() => startAssign(item, availability.branches)}
                            >
                              {submitting ? '归属中…' : '归属分支'}
                            </Button>
                          )}
                          {!availability.available ? (
                            <span className="text-2xs text-muted-foreground">
                              {availability.reason}
                            </span>
                          ) : null}
                        </div>
                        {assignErrors[key] ? (
                          <p className="mt-1 text-2xs text-destructive">{assignErrors[key]}</p>
                        ) : null}
                      </li>
                    )
                  })}
                </ul>
              </div>
            ))}
          </div>

          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-2xs">
            <span>
              已加载 {items.length} 条{total > items.length ? `，共 ${total} 条` : ''}
            </span>
            {nextCursor ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="border-warning/40 bg-background/70 text-warning hover:bg-background hover:text-warning dark:bg-background/70 dark:hover:bg-background"
                disabled={loadingMore}
                onClick={onLoadMore}
              >
                {loadingMore ? '加载中…' : '加载更多'}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  )
}
