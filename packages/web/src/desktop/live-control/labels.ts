import type { ChangedBy, ConflictFile, Difference, ReviewOption } from './control-event.ts'

export function errorCodeLabel(event: { errorCode?: string; serverCode?: string }): string {
  const code = event.errorCode?.trim() || ''
  const serverCode = event.serverCode?.trim() || ''
  if (code && serverCode) return `${code} (${serverCode})`
  return code || serverCode
}

export function formatSource(changedBy: ChangedBy | string | null | undefined): string {
  if (!changedBy || typeof changedBy === 'string') return ''
  return [
    changedBy.displayName,
    changedBy.deviceName,
    changedBy.occurredAt ? new Date(changedBy.occurredAt).toLocaleString() : null,
  ]
    .filter(Boolean)
    .join(' · ')
}

export function conflictLabel(conflict: ConflictFile): string {
  const parts = [conflict.path ?? '']
  if (Number.isSafeInteger(conflict.revision)) parts.push(`文件版本 r${conflict.revision}`)
  if (conflict.changeType === 'line-endings') parts.push('仅换行差异')
  if (conflict.changeType === 'content') parts.push('内容变化')
  parts.push(formatSource(conflict.changedBy))
  return parts.filter(Boolean).join(' · ')
}

export function differenceTypeLabel(type: string): string {
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

export function differenceTitle(difference: Difference): string {
  return (
    difference.title ||
    difference.local?.title ||
    difference.server?.title ||
    difference.server?.taskId ||
    difference.local?.taskId ||
    difference.taskId ||
    difference.server?.taskDir ||
    difference.local?.taskDir ||
    difference.taskDir ||
    '未知任务'
  )
}

export function differenceKey(difference: Difference): string {
  return String(
    difference.taskId ||
      difference.taskDir ||
      difference.local?.taskId ||
      difference.server?.taskId ||
      '',
  )
}

export function reviewOptions(difference: Difference): {
  options: ReviewOption[]
  fallback: string
} {
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
