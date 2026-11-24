const PROTOCOL_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:/

export function normalizeBasePath(value) {
  if (value == null) return ''
  const trimmed = String(value).trim()
  if (!trimmed || trimmed === '/') return ''
  if (/[\u0000-\u0020\u007f\\?#%"'<>&]/.test(trimmed) || trimmed.includes('//')) {
    return ''
  }
  const withLeading = trimmed.startsWith('/') ? trimmed : `/${trimmed}`
  const stripped =
    withLeading.length > 1 && withLeading.endsWith('/') ? withLeading.slice(0, -1) : withLeading
  const segments = stripped.slice(1).split('/')
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..' || !/^[A-Za-z0-9._~-]+$/.test(segment)) {
      return ''
    }
  }
  return `/${segments.join('/')}`
}

export function readBasePath(doc = globalThis.document) {
  const content = doc?.querySelector?.('meta[name="trellis-base-path"]')?.getAttribute('content')
  return normalizeBasePath(content)
}

export function withBasePath(pathname, basePath = readBasePath()) {
  const raw = String(pathname ?? '')
  const normalizedBase = normalizeBasePath(basePath)
  if (!normalizedBase || !raw) return raw
  if (PROTOCOL_PATTERN.test(raw) || !raw.startsWith('/') || raw.startsWith('//')) return raw
  if (raw === '/') return `${normalizedBase}/`
  if (
    raw === normalizedBase ||
    raw.startsWith(`${normalizedBase}/`) ||
    raw.startsWith(`${normalizedBase}?`) ||
    raw.startsWith(`${normalizedBase}#`)
  ) {
    return raw
  }
  return `${normalizedBase}${raw}`
}

export function stripBasePath(pathname, basePath = readBasePath()) {
  const raw = String(pathname ?? '')
  const normalizedBase = normalizeBasePath(basePath)
  if (!normalizedBase) return raw
  if (raw === normalizedBase) return '/'
  if (raw.startsWith(`${normalizedBase}/`)) return raw.slice(normalizedBase.length)
  return raw
}

export function appOriginWithBase(loc = globalThis.window?.location, basePath = readBasePath()) {
  const origin = String(loc?.origin || '')
  const normalizedBase = normalizeBasePath(basePath)
  return `${origin}${normalizedBase}`
}
