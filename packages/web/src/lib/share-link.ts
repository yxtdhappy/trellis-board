import { normalizeBasePath } from './base-path.js'

export const MAX_SHARE_PARAM_LENGTH = 512

const RESERVED_FIRST_SEGMENTS = new Set(['api', 'client-updates', 'plugin-ui', 'assets'])
const RESERVED_PAGE_ENDINGS = new Set([
  'login',
  'login.html',
  'admin.html',
  'index.html',
  'share.html',
])

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

export function normalizeShareServerUrl(raw: string): string {
  if (typeof raw !== 'string' || hasControlChar(raw) || raw.includes('\\')) return ''
  const trimmed = raw.trim()
  if (!trimmed) return ''
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return ''
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin === 'null') {
    return ''
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    return ''
  }
  const schemeIndex = trimmed.indexOf('://')
  const pathStart = schemeIndex >= 0 ? trimmed.indexOf('/', schemeIndex + 3) : -1
  const rawPath = pathStart >= 0 ? trimmed.slice(pathStart) : ''
  if (rawPath.includes('//')) return ''
  if (rawPath.split('/').some((segment) => segment === '.' || segment === '..')) {
    return ''
  }
  if (rawPath === '' || rawPath === '/') {
    return parsed.origin
  }
  const basePath = normalizeBasePath(parsed.pathname)
  if (!basePath) return ''
  const segments = basePath.slice(1).split('/')
  if (RESERVED_FIRST_SEGMENTS.has(segments[0].toLowerCase())) return ''
  if (RESERVED_PAGE_ENDINGS.has(segments[segments.length - 1].toLowerCase())) return ''
  return `${parsed.origin}${basePath}`
}

export function isSameShareServer(candidate: string, current: string): boolean {
  const normalizedCandidate = normalizeShareServerUrl(candidate)
  const normalizedCurrent = normalizeShareServerUrl(current)
  return Boolean(normalizedCandidate) && normalizedCandidate === normalizedCurrent
}

export function parseSharePageParams(search: string, origin: string): ShareLinkTarget | null {
  const normalizedServer = normalizeShareServerUrl(origin)
  if (!normalizedServer) {
    return null
  }
  const params = new URLSearchParams(search)
  const taskSpaceId = sanitizeShareParam(params.get('space'))
  const taskId = sanitizeShareParam(params.get('task'))
  if (!taskSpaceId || !taskId) return null
  return {
    origin: normalizedServer,
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
