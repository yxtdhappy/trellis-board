export function safeReturnTo(value, fallback = '/') {
  const raw = String(value || '').trim()
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) {
    return fallback
  }
  try {
    const base = 'https://trellis.invalid'
    const target = new URL(raw, base)
    if (target.origin !== base || target.pathname === '/login.html') return fallback
    return `${target.pathname}${target.search}${target.hash}`
  } catch {
    return fallback
  }
}
