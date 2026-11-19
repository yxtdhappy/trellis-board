const SENSITIVE_KEY =
  /(password|token|secret|credential|authorization|cookie|private.?key|passphrase)/i

export function redactSensitiveDetail(value, depth = 0) {
  if (depth > 4) return '[已截断]'
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') return value.slice(0, 500)
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => redactSensitiveDetail(item, depth + 1))
  }
  if (typeof value !== 'object') return String(value).slice(0, 200)
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      SENSITIVE_KEY.test(key) ? '[已隐藏]' : redactSensitiveDetail(item, depth + 1),
    ]),
  )
}
