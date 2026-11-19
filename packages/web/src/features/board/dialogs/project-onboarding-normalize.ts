import type { Association, PreflightResult, PushState } from './project-onboarding-types.ts'

export function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function normalizeAssociation(value: unknown): Association | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  if (
    typeof row.projectId !== 'string' ||
    typeof row.taskSpaceId !== 'string' ||
    typeof row.repoPath !== 'string' ||
    typeof row.displayName !== 'string' ||
    typeof row.branchName !== 'string' ||
    typeof row.status !== 'string'
  ) {
    return null
  }
  return {
    projectId: row.projectId,
    taskSpaceId: row.taskSpaceId,
    repoPath: row.repoPath,
    displayName: row.displayName,
    branchName: row.branchName,
    teamId: typeof row.teamId === 'string' ? row.teamId : null,
    status: row.status,
    readOnly: row.readOnly === true,
    lastErrorCode: typeof row.lastErrorCode === 'string' ? row.lastErrorCode : null,
    lastError: typeof row.lastError === 'string' ? row.lastError : null,
    liveSyncStatus:
      row.liveSyncStatus === 'syncing' ||
      row.liveSyncStatus === 'ready' ||
      row.liveSyncStatus === 'error'
        ? row.liveSyncStatus
        : 'pending',
    liveSyncError: typeof row.liveSyncError === 'string' ? row.liveSyncError : null,
  }
}

export function normalizePreflight(value: unknown): PreflightResult | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  const status = text(row.status)
  if (!status) return null
  const differences = Array.isArray(row.differences)
    ? row.differences
        .filter((item): item is Record<string, unknown> =>
          Boolean(item && typeof item === 'object'),
        )
        .map((item) => ({
          type: text(item.type),
          taskId: typeof item.taskId === 'string' ? item.taskId : null,
          taskDir: typeof item.taskDir === 'string' ? item.taskDir : null,
        }))
        .filter((item) => item.type)
    : []
  const rawCounts =
    row.counts && typeof row.counts === 'object' ? (row.counts as Record<string, unknown>) : {}
  const count = (key: string) => {
    const value = rawCounts[key]
    return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0
  }
  return {
    status,
    revision: typeof row.revision === 'number' && Number.isFinite(row.revision) ? row.revision : 0,
    differences,
    counts: {
      same: count('same'),
      localOnly: count('localOnly'),
      serverOnly: count('serverOnly'),
      conflicts: count('conflicts'),
      invalid: count('invalid'),
    },
  }
}

export function stateLabel(push: PushState | null): string {
  if (!push) return ''
  switch (push.state) {
    case 'waiting_commit':
      return '等待提交：请先提交 .trellis 初始化文件。'
    case 'waiting_push':
      return '等待推送：本地提交还没有推送到远端分支。'
    case 'branch_missing':
      return '远端分支还不存在，请先执行 git push -u origin 当前分支。'
    case 'remote_ahead':
      return '远端分支比本地更新，请先拉取并处理后再接入。'
    case 'diverged':
      return '本地与远端已经分叉，请先处理 Git 历史。'
    case 'unable_to_verify':
      return '暂时无法连接远端，不能确认是否已经推送。'
    case 'ready':
      return '初始化文件已提交并推送，可以接入团队。'
    default:
      return push.message || '等待检查推送状态。'
  }
}
