import { Fragment, useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import type { AdminConsole } from '@/hooks/useAdminConsole'
import type { AuditEvent } from '@/api/admin'
import { formatTime } from '@/lib/admin-shared'
import { EmptyRow, Panel, StatusPill } from './shared.tsx'
import { SelectField } from '@/features/board/SelectField'

const RANGE_OPTIONS = [
  { value: '7', label: '最近 7 天' },
  { value: '30', label: '最近 30 天' },
  { value: 'all', label: '全部时间' },
]

function actorOf(event: AuditEvent): string {
  return event.actorUserId || event.actorAgentId || 'system'
}

export function AuditTab({ console: consoleApi }: { console: AdminConsole }) {
  const { systemAudit, systemAuditHasMore, systemAuditUnavailable, loadSystemAudit } = consoleApi
  const [action, setAction] = useState('all')
  const [actor, setActor] = useState('all')
  const [range, setRange] = useState('7')

  useEffect(() => {
    void loadSystemAudit(true)
  }, [loadSystemAudit])

  const actions = useMemo(
    () => [...new Set(systemAudit.map((event) => event.action).filter(Boolean))].sort(),
    [systemAudit],
  )
  const actors = useMemo(() => [...new Set(systemAudit.map(actorOf))].sort(), [systemAudit])
  const filtered = useMemo(() => {
    const days = range === 'all' ? 0 : Number(range)
    const cutoff = days ? Date.now() - days * 86_400_000 : 0
    return systemAudit.filter((event) => {
      if (action !== 'all' && event.action !== action) return false
      if (actor !== 'all' && actorOf(event) !== actor) return false
      if (cutoff && (!event.occurredAt || new Date(event.occurredAt).getTime() < cutoff))
        return false
      return true
    })
  }, [action, actor, range, systemAudit])

  return (
    <div className="flex flex-col gap-3.5">
      <Panel kicker="SYSTEM / AUDIT TRAIL" title="筛选">
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex min-w-40 flex-1 flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">动作</span>
            <SelectField
              value={action}
              options={[
                { value: 'all', label: '全部动作' },
                ...actions.map((item) => ({ value: item, label: item })),
              ]}
              onChange={setAction}
            />
          </label>
          <label className="flex min-w-40 flex-1 flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">操作人</span>
            <SelectField
              value={actor}
              options={[
                { value: 'all', label: '全部操作人' },
                ...actors.map((item) => ({ value: item, label: item })),
              ]}
              onChange={setActor}
            />
          </label>
          <label className="flex min-w-32 flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">时间范围</span>
            <SelectField
              value={range}
              options={RANGE_OPTIONS.map((option) => ({
                value: option.value,
                label: option.label,
              }))}
              onChange={setRange}
            />
          </label>
          <Button variant="outline" type="button" onClick={() => void loadSystemAudit(true)}>
            刷新
          </Button>
        </div>
      </Panel>

      <Panel
        kicker="SYSTEM / AUDIT TRAIL"
        title="系统审计"
        description="审计详情在服务端脱敏后，浏览器渲染前再次隐藏 password、token、credential 等敏感键。"
        action={
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              已加载 {systemAudit.length} / 显示 {filtered.length}
            </span>
            {systemAuditHasMore ? (
              <Button
                variant="outline"
                size="sm"
                type="button"
                onClick={() => void loadSystemAudit(false)}
              >
                加载更多
              </Button>
            ) : null}
          </div>
        }
      >
        {systemAuditUnavailable ? (
          <EmptyRow>核心服务尚未提供 /api/admin/audit；项目审计仍可从“项目协作”查看。</EmptyRow>
        ) : filtered.length === 0 ? (
          <EmptyRow>暂无审计事件。</EmptyRow>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>时间</TableHead>
                <TableHead>操作人</TableHead>
                <TableHead>动作</TableHead>
                <TableHead>对象</TableHead>
                <TableHead>结果</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((event) => {
                const detail = JSON.stringify(event.detail ?? {}, null, 2)
                return (
                  <Fragment key={event.id}>
                    <TableRow>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {formatTime(event.occurredAt)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        <code>{actorOf(event)}</code>
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        {event.action || 'unknown'}
                      </TableCell>
                      <TableCell>
                        <span className="text-muted-foreground">
                          {event.targetType || 'unknown'}
                        </span>{' '}
                        <code>{event.targetId || '-'}</code>
                        {event.projectId ? (
                          <span className="text-muted-foreground"> · {event.projectId}</span>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <StatusPill value={event.result} />
                      </TableCell>
                    </TableRow>
                    {detail !== '{}' ? (
                      <TableRow>
                        <TableCell colSpan={5} className="bg-muted/40">
                          <pre className="max-h-40 overflow-auto text-2xs text-muted-foreground">
                            {detail}
                          </pre>
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </Fragment>
                )
              })}
            </TableBody>
          </Table>
        )}
      </Panel>
    </div>
  )
}
