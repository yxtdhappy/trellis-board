export const TASK_SLUG_PATTERN = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/

export function normalizeTaskSlug(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

export function slugifyTaskTitle(value, maxLength = 100) {
  const source = String(value ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

  if (!/[a-z]/.test(source)) return ''
  if (source.length <= maxLength) return source

  const clipped = source.slice(0, maxLength)
  const lastSeparator = clipped.lastIndexOf('-')
  return (lastSeparator > 0 ? clipped.slice(0, lastSeparator) : clipped).replace(/-+$/g, '')
}
