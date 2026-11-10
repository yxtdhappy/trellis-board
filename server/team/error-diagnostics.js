import { TeamError } from './errors.js'
import { sanitizeProcessOutput } from './process.js'

const SENSITIVE_KEY = /(?:authorization|cookie|password|passphrase|private[_-]?key|secret|token)/i
const PRIVATE_KEY_BLOCK =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gi
const KNOWN_TOKEN =
  /\b(?:gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{8,}|xox[baprs]-[A-Za-z0-9-]{8,})\b/g
const JWT_TOKEN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g
const AUTHORIZATION_HEADER =
  /(\b(?:proxy-)?authorization\b["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n]*)/gi
const COOKIE_HEADER = /(\b(?:set-)?cookie\b["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n]*)/gi
const KEY_VALUE_SECRET =
  /(\b[\w-]*(?:token|secret|password|passphrase|private[_-]?key|api[_-]?key)[\w-]*\b["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,"'}\]\r\n]+)/gi
const MAX_DIAGNOSTIC_VALUE_CHARS = 12 * 1024
const MAX_DIAGNOSTIC_VALUE_NODES = 128

export function sanitizeDiagnosticText(value, { maxBytes = 2048 } = {}) {
  const text = String(value ?? '')
    .replace(PRIVATE_KEY_BLOCK, '[redacted-private-key]')
    .replace(KNOWN_TOKEN, '[redacted]')
    .replace(JWT_TOKEN, '[redacted]')
    .replace(AUTHORIZATION_HEADER, '$1[redacted]')
    .replace(COOKIE_HEADER, '$1[redacted]')
    .replace(KEY_VALUE_SECRET, '$1[redacted]')
    .replace(/file:\/\/\/[^\r\n"',;)\]]+/gi, 'file:///[redacted-path]')
    .replace(/(["'])(?:[A-Za-z]:[\\/]|\\\\|\/(?!\/))[^"'\r\n]*\1/g, '[redacted-path]')
    .replace(
      /(^|[\s"'(=:,\[])(?:[A-Za-z]:[\\/]|\\\\)(?:(?!\s+[\w-]+\s*[:=])[^\r\n"',;)\]])+/g,
      '$1[redacted-path]',
    )
    .replace(
      /(^|[\s"'(=:,\[])\/(?!\/)(?:(?!\s+[\w-]+\s*[:=])[^\r\n"',;)\]])+/g,
      '$1[redacted-path]',
    )
  return sanitizeProcessOutput(text, { maxBytes })
}

function sanitizeWithinBudget(value, budget, maxBytes = 2048) {
  if (budget.chars <= 0) return '[truncated]'
  const text = sanitizeDiagnosticText(value, {
    maxBytes: Math.min(maxBytes, budget.chars),
  })
  budget.chars = Math.max(0, budget.chars - text.length)
  return text
}

function sanitizeDiagnosticValue(
  value,
  key = '',
  depth = 0,
  seen = new WeakSet(),
  budget = {
    chars: MAX_DIAGNOSTIC_VALUE_CHARS,
    nodes: MAX_DIAGNOSTIC_VALUE_NODES,
  },
) {
  if (budget.chars <= 0 || budget.nodes <= 0) return '[truncated]'
  budget.nodes -= 1
  if (SENSITIVE_KEY.test(key)) return '[redacted]'
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') return sanitizeWithinBudget(value, budget)
  if (value instanceof Error) {
    if (seen.has(value)) return '[circular]'
    seen.add(value)
    return {
      name: sanitizeWithinBudget(value.name, budget, 80),
      code: value.code == null ? null : sanitizeWithinBudget(value.code, budget, 128),
      message: sanitizeWithinBudget(value.message, budget),
      stack: sanitizeWithinBudget(value.stack || '', budget, 8192),
    }
  }
  if (typeof value !== 'object') return sanitizeWithinBudget(value, budget)
  if (depth >= 4) return '[truncated]'
  if (seen.has(value)) return '[circular]'
  seen.add(value)
  if (Array.isArray(value)) {
    return value
      .slice(0, 20)
      .map((entry) => sanitizeDiagnosticValue(entry, key, depth + 1, seen, budget))
  }
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 30)
      .map(([entryKey, entry]) => {
        const safeKey = sanitizeWithinBudget(entryKey, budget, 128)
        return [safeKey, sanitizeDiagnosticValue(entry, entryKey, depth + 1, seen, budget)]
      }),
  )
}

export function diagnosticError(error) {
  const source = error instanceof Error ? error : new Error(String(error))
  const status = Number(source.status)
  const budget = {
    chars: MAX_DIAGNOSTIC_VALUE_CHARS,
    nodes: MAX_DIAGNOSTIC_VALUE_NODES,
  }
  const diagnostic = {
    name: sanitizeDiagnosticText(source.name || 'Error', { maxBytes: 80 }),
    code: source.code == null ? null : sanitizeDiagnosticText(source.code, { maxBytes: 128 }),
    status: Number.isFinite(status) ? status : null,
    message: sanitizeDiagnosticText(source.message),
    details:
      source.details == null
        ? null
        : sanitizeDiagnosticValue(source.details, 'details', 0, new WeakSet(), budget),
  }
  if (!(source instanceof TeamError)) {
    diagnostic.stack = sanitizeDiagnosticText(source.stack || '', { maxBytes: 8192 })
    if (source.cause !== undefined) {
      diagnostic.cause = sanitizeDiagnosticValue(source.cause, 'cause', 0, new WeakSet(), budget)
    }
  }
  return diagnostic
}

export function errorSummary(error, fallback = '操作失败') {
  const code =
    error?.code == null ? '' : sanitizeDiagnosticText(error.code, { maxBytes: 128 }).trim()
  const message =
    sanitizeDiagnosticText(error?.message || fallback, { maxBytes: 900 }).trim() || fallback
  const summary = code && !message.startsWith(`${code}:`) ? `${code}: ${message}` : message
  return summary.slice(0, 1000)
}
