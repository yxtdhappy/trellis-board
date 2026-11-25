import type { Association, PreflightResult, PushState } from './project-onboarding-types.ts'

export type PreflightDiffTone = 'info' | 'primary' | 'warning' | 'danger' | 'neutral'

export type PreflightPresentationMode =
  | 'none'
  | 'blocked'
  | 'bootstrap'
  | 'bootstrap-invalid'
  | 'server-only'
  | 'review'
  | 'ready'

export function preflightPresentationMode(
  preflight: PreflightResult | null,
): PreflightPresentationMode {
  if (!preflight) return 'none'
  if (preflight.status === 'access_required' || preflight.status === 'unavailable') {
    return 'blocked'
  }
  if (preflight.status === 'new' || preflight.status === 'branch_new') {
    return preflight.counts.invalid > 0 ? 'bootstrap-invalid' : 'bootstrap'
  }
  const { localOnly, serverOnly, conflicts, invalid } = preflight.counts
  const hasReviewItems =
    localOnly > 0 ||
    conflicts > 0 ||
    invalid > 0 ||
    preflight.differences.some((item) => item.type !== 'same' && item.type !== 'server-only')
  if (hasReviewItems) return 'review'
  if (serverOnly > 0 || preflight.differences.some((item) => item.type === 'server-only')) {
    return 'server-only'
  }
  return 'ready'
}

export function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function nonEmptyText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

export function preflightDifferenceLabel(type: string): string {
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

export function preflightDifferenceTone(type: string): PreflightDiffTone {
  switch (type) {
    case 'server-only':
      return 'info'
    case 'local-only':
      return 'primary'
    case 'content-conflict':
      return 'warning'
    case 'move-delete-conflict':
    case 'invalid':
      return 'danger'
    default:
      return 'neutral'
  }
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
    initialReviewPending: row.initialReviewPending === true,
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
        .map((item) => {
          const local = record(item.local)
          const server = record(item.server)
          return {
            type: text(item.type),
            taskId: typeof item.taskId === 'string' ? item.taskId : null,
            taskDir: typeof item.taskDir === 'string' ? item.taskDir : null,
            title:
              nonEmptyText(item.title) ??
              nonEmptyText(local?.title) ??
              nonEmptyText(server?.title) ??
              null,
            localTaskDir: nonEmptyText(local?.taskDir),
            serverTaskDir: nonEmptyText(server?.taskDir),
          }
        })
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
