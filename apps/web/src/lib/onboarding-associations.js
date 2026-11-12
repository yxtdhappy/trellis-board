export function normalizeLocalRepoPath(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) return ''
  const windowsPath = /^[A-Za-z]:[\\/]/.test(text) || text.startsWith('\\\\')
  let normalized = text.replaceAll('\\', '/').replace(/\/+/g, '/')
  while (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1)
  }
  return windowsPath ? normalized.toLowerCase() : normalized
}

export function sameLocalRepositoryPath(left, right) {
  const normalizedLeft = normalizeLocalRepoPath(left)
  return Boolean(normalizedLeft) && normalizedLeft === normalizeLocalRepoPath(right)
}
