export const MAX_SHARE_PARAM_LENGTH = 512

export type ShareLinkTarget = {
  origin: string
  taskSpaceId: string
  taskId: string
}

function hasControlChar(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

export function sanitizeShareParam(value: string | null | undefined): string {
  if (typeof value !== 'string' || hasControlChar(value)) return ''
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > MAX_SHARE_PARAM_LENGTH) {
    return ''
  }
  return trimmed
}

export function parseSharePageParams(search: string, origin: string): ShareLinkTarget | null {
  let parsedOrigin: URL
  try {
    parsedOrigin = new URL(origin)
  } catch {
    return null
  }
  if (!['http:', 'https:'].includes(parsedOrigin.protocol) || parsedOrigin.origin === 'null') {
    return null
  }
  const params = new URLSearchParams(search)
  const taskSpaceId = sanitizeShareParam(params.get('space'))
  const taskId = sanitizeShareParam(params.get('task'))
  if (!taskSpaceId || !taskId) return null
  return {
    origin: parsedOrigin.origin,
    taskSpaceId,
    taskId,
  }
}

/** `executionTaskKey` 形如 `<taskSpaceId>::<taskId>`，只取任务 id 部分作为链接参数。 */
export function taskIdFromExecutionKey(executionTaskKey: string | null | undefined): string {
  if (!executionTaskKey) return ''
  const separator = executionTaskKey.indexOf('::')
  return separator < 0 ? '' : executionTaskKey.slice(separator + 2)
}

export function buildShareUrl({ origin, taskSpaceId, taskId }: ShareLinkTarget): string {
  const query = new URLSearchParams({
    space: taskSpaceId,
    task: taskId,
  }).toString()
  return `${origin.replace(/\/+$/, '')}/share.html?${query}`
}

export function buildProtocolUrl({ origin, taskSpaceId, taskId }: ShareLinkTarget): string {
  const query = new URLSearchParams({
    server: origin.replace(/\/+$/, ''),
    space: taskSpaceId,
    task: taskId,
  }).toString()
  return `spec-board://task?${query}`
}
