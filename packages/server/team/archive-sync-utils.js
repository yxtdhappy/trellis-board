import { ERROR_CODES, teamError } from './errors.js'

export const MIN_INTERVAL_SECONDS = 60
export const MAX_INTERVAL_SECONDS = 24 * 60 * 60
export const MAX_CONCURRENT_TASKS = 2
export const MAX_FAILURE_LOGS = 100
export const BACKOFF_SECONDS = [30, 60, 120, 300, 600, 1800]

export function boundedInteger(value, label, minimum, maximum) {
  const number = Number(value)
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw teamError(
      400,
      ERROR_CODES.INVALID_INPUT,
      `${label}必须是 ${minimum} 到 ${maximum} 的整数`,
    )
  }
  return number
}

export function booleanValue(value, label) {
  if (value === true || value === 1 || value === '1' || value === 'true') return true
  if (value === false || value === 0 || value === '0' || value === 'false') return false
  throw teamError(400, ERROR_CODES.INVALID_INPUT, `${label}必须是布尔值`)
}

export function phaseForError(error) {
  if (error?.archivePhase === 'fetch' || error?.archivePhase === 'import') {
    return error.archivePhase
  }
  const code = String(error?.code || '')
  if (
    code.startsWith('ARCHIVE_ENTRY_') ||
    code.startsWith('ARCHIVE_FILE_') ||
    code === 'ARCHIVE_PATH_INVALID' ||
    code === 'ARCHIVE_TREE_TOO_LARGE'
  ) {
    return 'import'
  }
  return 'fetch'
}

export function normalizedErrorCode(error, phase) {
  const code = String(error?.code || '').trim()
  if (code && /^[A-Z0-9_:-]{2,100}$/.test(code)) return code
  return phase === 'index' ? 'ARCHIVE_INDEX_FAILED' : 'ARCHIVE_SYNC_FAILED'
}

export function normalizedLimit(value, fallback = 50) {
  if (value == null || value === '') return fallback
  return boundedInteger(value, 'limit', 1, 100)
}
