import { Button } from '@/components/ui/button'
import { StatusPill } from '@/components/ui/status-pill'
import type { ArchiveTaskSpaceSync } from '@/api/admin'
import { formatTime, statusTone } from '@/lib/admin-shared'
import { Row } from './shared.tsx'
import { credentialStateLabel, displayText, shortHead, statusLabel } from './archive-sync-format.ts'

export function TaskSpaceRow({
  taskSpace,
  busy,
  onRun,
  onLogs,
}: {
  taskSpace: ArchiveTaskSpaceSync
  busy: boolean
  onRun: () => void
  onLogs: () => void
}) {
  const failed = taskSpace.status === 'error' || taskSpace.status === 'index_error'
  const projectName = displayText(taskSpace.projectName, '项目名称缺失')
  const branchName = displayText(taskSpace.branchName, '分支名称缺失')
  return (
    <Row
      actions={
        <>
          <Button size="sm" type="button" variant="outline" disabled={busy} onClick={onRun}>
            立即同步
          </Button>
          {taskSpace.failureCount > 0 ? (
            <Button size="sm" type="button" variant="ghost" onClick={onLogs}>
              失败日志
            </Button>
          ) : null}
        </>
      }
    >
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <strong className="min-w-0 truncate text-xs font-medium" title={projectName}>
            {projectName}
          </strong>
          <StatusPill tone="neutral">{branchName || 'unknown'}</StatusPill>
          <StatusPill tone={statusTone(taskSpace.status)}>
            {statusLabel(taskSpace.status) || 'unknown'}
          </StatusPill>
          <span className="text-2xs text-muted-foreground">
            {credentialStateLabel(taskSpace.credentialState)}
          </span>
        </div>
        <div className="grid gap-x-4 gap-y-0.5 text-xs text-muted-foreground sm:grid-cols-2">
          <span>
            最近更新：{taskSpace.lastIndexedAt ? formatTime(taskSpace.lastIndexedAt) : '尚未更新'}
          </span>
          <span>最近尝试：{formatTime(taskSpace.lastAttemptAt)}</span>
          <span>最近成功：{formatTime(taskSpace.lastSuccessAt)}</span>
          <span>
            文件 {taskSpace.fileCount} · 归档 revision {taskSpace.archiveIndexedRevision}/
            {taskSpace.archiveRevision}
          </span>
          <span>
            Commit <code>{shortHead(taskSpace.remoteHead)}</code>
          </span>
          {taskSpace.credentialState === 'configured' ? (
            <span
              className="truncate"
              title={`使用凭据：${displayText(taskSpace.credential?.name, '凭据名称缺失')}`}
            >
              使用凭据：{displayText(taskSpace.credential?.name, '凭据名称缺失')}
            </span>
          ) : null}
          <span className="truncate" title={taskSpace.origin || taskSpace.remoteUrl}>
            来源 <code>{displayText(taskSpace.origin || taskSpace.remoteUrl, '来源地址缺失')}</code>
          </span>
        </div>
        {taskSpace.nextAttemptAt ? (
          <p className="text-2xs text-muted-foreground">
            下次自动尝试：{formatTime(taskSpace.nextAttemptAt)}
          </p>
        ) : null}
        {taskSpace.lastError ? (
          <p
            className={
              failed
                ? 'break-words text-2xs text-destructive'
                : 'break-words text-2xs text-muted-foreground'
            }
          >
            {taskSpace.lastError}
          </p>
        ) : null}
      </div>
    </Row>
  )
}
