export class TeamError extends Error {
  constructor(status, code, message, { details = null, recoverable = false } = {}) {
    super(message)
    this.name = 'TeamError'
    this.status = status
    this.code = code
    this.details = details
    this.recoverable = recoverable
  }
}

export function teamError(status, code, message, options) {
  return new TeamError(status, code, message, options)
}

export function errorPayload(error, fallbackMessage = '团队服务执行失败') {
  if (error instanceof TeamError) {
    return {
      status: error.status,
      body: {
        error: error.message,
        code: error.code,
        ...(error.recoverable ? { recoverable: true } : {}),
        ...(error.details == null ? {} : { details: error.details }),
      },
    }
  }
  return {
    status: 500,
    body: {
      error: fallbackMessage,
      code: 'INTERNAL_ERROR',
    },
  }
}

export const ERROR_CODES = Object.freeze({
  INVALID_INPUT: 'INVALID_INPUT',
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  AUTH_FAILED: 'AUTH_FAILED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  VERSION_CONFLICT: 'VERSION_CONFLICT',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  CURSOR_INVALID: 'CURSOR_INVALID',
  PROJECT_ALREADY_CONNECTED: 'PROJECT_ALREADY_CONNECTED',
  PROJECT_NOT_READY: 'PROJECT_NOT_READY',
  PROJECT_REPAIR_REQUIRED: 'PROJECT_REPAIR_REQUIRED',
  TOOLCHAIN_MISMATCH: 'TOOLCHAIN_MISMATCH',
  HOOKS_PRESENT: 'HOOKS_PRESENT',
  GIT_REMOTE_FAILED: 'GIT_REMOTE_FAILED',
  GIT_UNAVAILABLE: 'GIT_UNAVAILABLE',
  AGENT_AUTH_REQUIRED: 'AGENT_AUTH_REQUIRED',
  AGENT_PROTOCOL_UNSUPPORTED: 'AGENT_PROTOCOL_UNSUPPORTED',
  AGENT_LONG_POLL_REMOVED: 'AGENT_LONG_POLL_REMOVED',
  DESKTOP_TOKEN_INVALID: 'DESKTOP_TOKEN_INVALID',
  BODY_TOO_LARGE: 'BODY_TOO_LARGE',
  RATE_LIMITED: 'RATE_LIMITED',
  PASSWORD_CHANGE_REQUIRED: 'PASSWORD_CHANGE_REQUIRED',
  INVALID_HOST: 'INVALID_HOST',
  CSRF_REJECTED: 'CSRF_REJECTED',
  JSON_REQUIRED: 'JSON_REQUIRED',
  SERVICE_SHUTTING_DOWN: 'SERVICE_SHUTTING_DOWN',
  PLUGIN_DISABLED: 'PLUGIN_DISABLED',
  PLUGIN_NOT_FOUND: 'PLUGIN_NOT_FOUND',
  RELOAD_REQUIRES_RESTART: 'RELOAD_REQUIRES_RESTART',
  CREDENTIALS_MISSING: 'CREDENTIALS_MISSING',
  CONNECTION_LOST: 'CONNECTION_LOST',
  ACCOUNT_IN_USE: 'ACCOUNT_IN_USE',
  LOGIN_TOO_FREQUENT: 'LOGIN_TOO_FREQUENT',
})
