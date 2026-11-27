import { invoke as transportInvoke } from '@/desktop/tauri'
import {
  associationOwnershipCounts,
  associationTaskStateCounts,
  detachPendingAssociationView,
  pendingUploadView,
} from '@/lib/project-rail-association.js'
import type {
  LiveSyncStatus,
  LocalAssociation,
  Project,
  ProjectAssociationView,
  SidecarStatus,
  TauriInvoke,
  WorktreeStatus,
} from './types.ts'

/**
 * 与 `@/desktop/tauri` 共用同一套传输：桌面 EXE 走 Tauri IPC，
 * 浏览器客户端页面走本机 headless agent 的 HTTP 桥。
 */
export function tauriInvoke(): TauriInvoke | null {
  return transportInvoke ?? null
}

export function normalizeLiveSyncStatus(value: unknown): LiveSyncStatus {
  return value === 'syncing' || value === 'ready' || value === 'error' ? value : 'pending'
}

export function normalizeAssociation(value: unknown): LocalAssociation | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (
    typeof record.projectId !== 'string' ||
    typeof record.taskSpaceId !== 'string' ||
    typeof record.repoPath !== 'string' ||
    typeof record.displayName !== 'string' ||
    typeof record.branchName !== 'string' ||
    typeof record.status !== 'string'
  ) {
    return null
  }
  const deferredTaskDirs = Array.isArray(record.deferredTaskDirs)
    ? record.deferredTaskDirs.filter(
        (taskDir): taskDir is string =>
          typeof taskDir === 'string' && taskDir.startsWith('.trellis/tasks/'),
      )
    : []
  const deferredTasks = Array.isArray(record.deferredTasks)
    ? record.deferredTasks.flatMap((item) => {
        if (!item || typeof item !== 'object') return []
        const task = item as Record<string, unknown>
        if (typeof task.taskDir !== 'string' || !task.taskDir.startsWith('.trellis/tasks/')) {
          return []
        }
        const title = typeof task.title === 'string' && task.title.trim() ? task.title.trim() : null
        return [{ taskDir: task.taskDir, title }]
      })
    : []
  const taskDirs = (value: unknown) =>
    Array.isArray(value)
      ? value.filter(
          (taskDir): taskDir is string =>
            typeof taskDir === 'string' && taskDir.startsWith('.trellis/tasks/'),
        )
      : []
  const deferredCount =
    deferredTaskDirs.length ||
    (typeof record.deferredCount === 'number' && Number.isSafeInteger(record.deferredCount)
      ? Math.max(0, record.deferredCount)
      : 0)
  const ownershipPausedTaskDirs = taskDirs(record.ownershipPausedTaskDirs)
  const ownershipPendingTaskDirs = taskDirs(record.ownershipPendingTaskDirs)
  const pendingUploadTaskDirs = taskDirs(record.pendingUploadTaskDirs)
  const pendingRejectedTaskDirs = taskDirs(record.pendingRejectedTaskDirs)
  const conflictPendingTaskDirs = taskDirs(record.conflictPendingTaskDirs)
  const ownershipPausedCount =
    ownershipPausedTaskDirs.length ||
    (typeof record.ownershipPausedCount === 'number' &&
    Number.isSafeInteger(record.ownershipPausedCount)
      ? Math.max(0, record.ownershipPausedCount)
      : 0)
  const ownershipPendingCount =
    ownershipPendingTaskDirs.length ||
    (typeof record.ownershipPendingCount === 'number' &&
    Number.isSafeInteger(record.ownershipPendingCount)
      ? Math.max(0, record.ownershipPendingCount)
      : 0)
  const pendingUploadCount =
    pendingUploadTaskDirs.length ||
    (typeof record.pendingUploadCount === 'number' &&
    Number.isSafeInteger(record.pendingUploadCount)
      ? Math.max(0, record.pendingUploadCount)
      : 0)
  const pendingRejectedCount =
    pendingRejectedTaskDirs.length ||
    (typeof record.pendingRejectedCount === 'number' &&
    Number.isSafeInteger(record.pendingRejectedCount)
      ? Math.max(0, record.pendingRejectedCount)
      : 0)
  const conflictPendingCount =
    conflictPendingTaskDirs.length ||
    (typeof record.conflictPendingCount === 'number' &&
    Number.isSafeInteger(record.conflictPendingCount)
      ? Math.max(0, record.conflictPendingCount)
      : 0)
  return {
    projectId: record.projectId,
    taskSpaceId: record.taskSpaceId,
    repoPath: record.repoPath,
    displayName: record.displayName,
    branchName: record.branchName,
    teamId: typeof record.teamId === 'string' ? record.teamId : null,
    status: record.status,
    readOnly: record.readOnly === true,
    lastErrorCode: typeof record.lastErrorCode === 'string' ? record.lastErrorCode : null,
    lastError: typeof record.lastError === 'string' ? record.lastError : null,
    liveSyncStatus: normalizeLiveSyncStatus(record.liveSyncStatus),
    liveSyncError:
      typeof record.liveSyncError === 'string' && record.liveSyncError.trim()
        ? record.liveSyncError.trim()
        : null,
    deferredCount,
    deferredTaskDirs,
    deferredTasks,
    ownershipPausedCount,
    ownershipPausedTaskDirs,
    ownershipPendingCount,
    ownershipPendingTaskDirs,
    pendingUploadCount,
    pendingUploadTaskDirs,
    pendingUploadRetrying: record.pendingUploadRetrying === true,
    pendingRejectedCount,
    pendingRejectedTaskDirs,
    conflictPendingCount,
    conflictPendingTaskDirs,
    detachPending: record.detachPending === true,
    initialReviewPending: record.initialReviewPending === true,
  }
}

export function normalizeAssociations(value: unknown): LocalAssociation[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const association = normalizeAssociation(item)
    return association ? [association] : []
  })
}

export function normalizeSidecarStatus(value: unknown): SidecarStatus | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (typeof record.running !== 'boolean' || typeof record.paused !== 'boolean') {
    return null
  }
  return { running: record.running, paused: record.paused }
}

export function associationErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return message.trim() || '本地项目关联失败，请检查仓库和同步分支后重试。'
}

export function deferredSyncErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return message.trim() || '本地待同步任务补传失败'
}

export function projectAssociationView(
  association: LocalAssociation | undefined,
  omitConflict = false,
): ProjectAssociationView {
  if (!association) {
    return {
      label: '未关联 · 关联本地仓库',
      detail: null,
      dotClassName: 'bg-muted-foreground/40',
      textClassName: 'text-muted-foreground',
    }
  }
  if (association.detachPending) {
    return detachPendingAssociationView(association)
  }
  if (association.status !== 'approved') {
    const error =
      association.lastError?.trim() || association.lastErrorCode?.trim() || '本地关联已失效'
    return {
      label: `关联失效 · ${error}`,
      detail: error,
      dotClassName: 'bg-destructive',
      textClassName: 'text-destructive',
    }
  }
  if (association.readOnly) {
    if (association.liveSyncStatus === 'error') {
      return {
        label: '只读已关联 · 同步异常，等待重试',
        detail: association.liveSyncError || '等待客户端自动重试。',
        dotClassName: 'bg-destructive',
        textClassName: 'text-destructive',
      }
    }
    return {
      label: '只读已关联 · 不同步本地修改',
      detail: null,
      dotClassName: 'bg-muted-foreground',
      textClassName: 'text-muted-foreground',
    }
  }
  if (
    association.lastErrorCode === 'BRANCH_MISMATCH' ||
    association.lastErrorCode === 'BINDING_BRANCH_MISMATCH'
  ) {
    return {
      label: '已关联 · 分支不一致，已暂停同步',
      detail: association.liveSyncError || association.lastError || '请切回绑定分支后重试。',
      dotClassName: 'bg-destructive',
      textClassName: 'text-destructive',
    }
  }
  const ownership = associationOwnershipCounts(association)
  const taskState = associationTaskStateCounts(association)
  if (!omitConflict && association.liveSyncStatus !== 'error' && taskState.conflictCount > 0) {
    return {
      label: `已关联 · ${taskState.conflictCount} 个冲突待处理`,
      detail:
        association.conflictPendingTaskDirs
          .map((taskDir) => taskDir.split('/').at(-1))
          .join('、') || null,
      dotClassName: 'bg-destructive',
      textClassName: 'text-destructive',
    }
  }
  if (association.liveSyncStatus !== 'error' && taskState.rejectedCount > 0) {
    return {
      label: `已关联 · ${taskState.rejectedCount} 个任务服务端拒绝待处理`,
      detail:
        association.pendingRejectedTaskDirs
          .map((taskDir) => taskDir.split('/').at(-1))
          .join('、') || null,
      dotClassName: 'bg-warning',
      textClassName: 'text-warning',
    }
  }
  if (association.liveSyncStatus !== 'error' && ownership.totalCount > 0) {
    const detail = [
      ownership.pausedCount ? `${ownership.pausedCount} 个因分支不匹配暂停` : null,
      ownership.pendingCount ? `${ownership.pendingCount} 个待确认归属` : null,
    ]
      .filter(Boolean)
      .join('；')
    return {
      label:
        ownership.pausedCount && ownership.pendingCount
          ? `已关联 · ${ownership.totalCount} 个任务待处理归属`
          : ownership.pausedCount
            ? `已关联 · ${ownership.pausedCount} 个任务因分支不匹配暂停`
            : `已关联 · ${ownership.pendingCount} 个任务待确认归属`,
      detail,
      dotClassName: 'bg-warning',
      textClassName: 'text-warning',
    }
  }
  if (association.initialReviewPending && association.liveSyncStatus !== 'error') {
    return {
      label: '已关联 · 等待确认任务差异',
      detail: '首次同步发现差异，确认处理方式后才会继续同步任务。',
      dotClassName: 'bg-warning',
      textClassName: 'text-warning',
    }
  }
  if (association.liveSyncStatus !== 'error' && taskState.pendingUploadCount > 0) {
    return pendingUploadView(association)
  }
  switch (association.liveSyncStatus) {
    case 'syncing':
      return {
        label: '已关联 · 正在同步已有任务',
        detail: null,
        dotClassName: 'bg-primary animate-pulse',
        textClassName: 'text-muted-foreground',
      }
    case 'ready':
      if (association.deferredCount > 0) {
        return {
          label: `已关联 · ${association.deferredCount} 个本地任务未同步`,
          detail:
            association.deferredTaskDirs.map((taskDir) => taskDir.split('/').at(-1)).join('、') ||
            null,
          dotClassName: 'bg-warning',
          textClassName: 'text-warning',
        }
      }
      return {
        label: '已关联 · 同步正常',
        detail: null,
        dotClassName: 'bg-primary',
        textClassName: 'text-muted-foreground',
      }
    case 'error':
      return {
        label: '已关联 · 同步异常，等待重试',
        detail: association.liveSyncError || '等待客户端自动重试。',
        dotClassName: 'bg-destructive',
        textClassName: 'text-destructive',
      }
    default:
      return {
        label: '已关联 · 等待后台同步',
        detail: null,
        dotClassName: 'bg-chart-3',
        textClassName: 'text-muted-foreground',
      }
  }
}

export function detachOutcome(value: unknown): 'detached' | 'pending' {
  if (typeof value === 'string') {
    return value === 'detached' || value === 'success' ? 'detached' : 'pending'
  }
  if (!value || typeof value !== 'object') return 'pending'
  const record = value as Record<string, unknown>
  if (record.status === 'pending') return 'pending'
  if (record.status === 'detached' || record.status === 'success' || record.detached === true) {
    return 'detached'
  }
  return 'pending'
}

export function normalizeWorktreeStatus(value: unknown): WorktreeStatus | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (
    typeof record.path !== 'string' ||
    typeof record.branchName !== 'string' ||
    typeof record.autoManaged !== 'boolean' ||
    typeof record.status !== 'string' ||
    (record.visibility !== 'hidden' &&
      record.visibility !== 'visible' &&
      record.visibility !== 'hidden_empty' &&
      record.visibility !== 'hidden_missing')
  ) {
    return null
  }
  return {
    path: record.path,
    branchName: record.branchName,
    taskSpaceId: typeof record.taskSpaceId === 'string' ? record.taskSpaceId : null,
    autoManaged: record.autoManaged,
    status: record.status,
    visibility: record.visibility,
    archiveSyncPending: record.archiveSyncPending === true,
    activeTaskCount:
      typeof record.activeTaskCount === 'number' && Number.isSafeInteger(record.activeTaskCount)
        ? Math.max(0, record.activeTaskCount)
        : 0,
    serverActiveTaskCount:
      typeof record.serverActiveTaskCount === 'number' &&
      Number.isSafeInteger(record.serverActiveTaskCount)
        ? Math.max(0, record.serverActiveTaskCount)
        : 0,
    lastError: typeof record.lastError === 'string' ? record.lastError : null,
    lastVisibilityError:
      typeof record.lastVisibilityError === 'string' ? record.lastVisibilityError : null,
    lastVisibilityAt: typeof record.lastVisibilityAt === 'string' ? record.lastVisibilityAt : null,
  }
}

export function normalizeWorktreeStatuses(value: unknown): WorktreeStatus[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const status = normalizeWorktreeStatus(item)
    return status ? [status] : []
  })
}

export function worktreeStatusSignature(statuses: WorktreeStatus[]): string {
  return statuses
    .map(
      (status) =>
        `${status.taskSpaceId || status.path}:${status.autoManaged}:${status.visibility}:${status.status}:${status.archiveSyncPending}:${status.activeTaskCount}:${status.serverActiveTaskCount}:${status.lastError || ''}:${status.lastVisibilityError || ''}`,
    )
    .sort()
    .join('|')
}

export function visibleTaskSpaces(project: Project, worktreeStatuses: Map<string, WorktreeStatus>) {
  return (project.taskSpaces || []).filter((taskSpace) => {
    const status = worktreeStatuses.get(taskSpace.id)
    return !status || !status.autoManaged || status.visibility === 'visible'
  })
}
