import { normalizeBasePath, readBasePath, stripBasePath, withBasePath } from './base-path.js'

export function safeReturnTo(value, fallback, basePath = readBasePath()) {
  const normalizedBase = normalizeBasePath(basePath)
  const defaultFallback = fallback === undefined ? withBasePath('/', normalizedBase) : fallback
  const raw = String(value || '').trim()
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) {
    return defaultFallback
  }
  try {
    const base = 'https://trellis.invalid'
    const target = new URL(raw, base)
    if (target.origin !== base) return defaultFallback
    if (
      normalizedBase &&
      target.pathname !== normalizedBase &&
      !target.pathname.startsWith(`${normalizedBase}/`)
    ) {
      return defaultFallback
    }
    const relativePath = stripBasePath(target.pathname, normalizedBase)
    if (relativePath === '/login.html' || relativePath === '/login') return defaultFallback
    return `${target.pathname}${target.search}${target.hash}`
  } catch {
    return defaultFallback
  }
}
