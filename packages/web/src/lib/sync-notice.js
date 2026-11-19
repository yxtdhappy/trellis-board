function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

export function syncNoticeView(payload) {
  if (!payload || typeof payload !== 'object') return null
  const record = payload
  if (record.type !== 'task_sync_notice') return null
  const project = text(record.projectName)
  const branch = text(record.branchName)
  const message = text(record.message)
  const reason =
    message || (branch ? `本地分支与绑定分支 ${branch} 不一致` : '本地分支与任务空间绑定分支不一致')
  const separator = /[。.!！]$/.test(reason) ? '' : '。'
  const title = project ? `项目「${project}」已暂停同步` : '任务同步已暂停'
  const taskSpaceId = text(record.taskSpaceId)
  return {
    id: `sync-notice:${project || taskSpaceId || 'unknown'}`,
    title,
    description: `${reason}${separator}切回绑定分支后会自动恢复。`,
  }
}
