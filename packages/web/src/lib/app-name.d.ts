export const DEFAULT_APP_NAME: string

export function normalizeAppName(value: unknown): string
export function readAppNameFromMeta(doc?: Pick<Document, 'querySelector'> | null): string
export function resolveAppName(options?: {
  runtimeAppName?: unknown
  metaAppName?: unknown
  clientAppName?: unknown
}): string
