export const DEFAULT_APP_NAME = ''

export function normalizeAppName(value) {
  if (value == null) return ''
  return String(value).trim()
}

export function readAppNameFromMeta(doc = globalThis.document) {
  const content = doc?.querySelector?.('meta[name="trellis-app-name"]')?.getAttribute('content')
  return normalizeAppName(content)
}

export function resolveAppName({ runtimeAppName, metaAppName, clientAppName } = {}) {
  return (
    normalizeAppName(runtimeAppName) ||
    normalizeAppName(metaAppName) ||
    normalizeAppName(clientAppName) ||
    DEFAULT_APP_NAME
  )
}
