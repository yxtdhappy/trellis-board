import { useMemo } from 'react'
import { Button } from '@/components/ui/button'
import { ownershipInboxItemKey, ownershipInboxReasonLabel } from '@/lib/ownership-inbox.js'
import type { OwnershipInboxItem, OwnershipInboxProjectGroup } from '@/lib/ownership-inbox.js'
import { Empty, EmptyDescription } from '@/components/ui/empty'
import { Skeleton } from '@/components/ui/skeleton'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { toneSurface } from '@/components/ui/status-pill'

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
  onToggle: () => void
  onRetry: () => void
  onLoadMore: () => void
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
  onToggle,
  onRetry,
  onLoadMore,
}: OwnershipInboxPanelProps) {
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
          className="border-warning/40 bg-background/70 text-warning hover:bg-background"
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
                  {group.items.map((item) => (
                    <li key={ownershipInboxItemKey(item)} className="py-2 first:pt-0 last:pb-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <p className="min-w-0 flex-1 break-words text-xs font-semibold text-foreground">
                          {item.title}
                        </p>
                        <span className="rounded-full border border-warning/35 px-1.5 py-0.5 text-2xs font-medium text-warning">
                          待归属
                        </span>
                      </div>
                      <p className="mt-0.5 break-all font-mono text-2xs text-muted-foreground">
                        {item.taskDir}
                      </p>
                      <p className="mt-1 break-words text-xs text-foreground">
                        {ownershipInboxReasonLabel(item.reason)}
                        <span className="ml-1 text-2xs text-muted-foreground">({item.reason})</span>
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
                        <span>最近发现：{inboxTime(item.lastSeenAt)}</span>
                      </div>
                    </li>
                  ))}
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
                size="xs"
                className="border-warning/40 bg-background/70 text-warning"
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
