export class ApiError extends Error {
  status: number
  code: string | null
  details: unknown
  recoverable: boolean
  payload: unknown

  constructor(
    message: string,
    options: {
      status?: number
      code?: string | null
      details?: unknown
      recoverable?: boolean
      payload?: unknown
    } = {},
  ) {
    super(message)
    this.name = 'ApiError'
    this.status = options.status ?? 0
    this.code = options.code ?? null
    this.details = options.details ?? null
    this.recoverable = options.recoverable ?? false
    this.payload = options.payload ?? null
  }
}

type RequestOptions = {
  method?: string
  body?: unknown
  headers?: Record<string, string>
  signal?: AbortSignal
}

export type JsonResult<T = unknown> = {
  data: T
  status: number
  etag: string | null
}

async function readPayload(response: Response): Promise<any> {
  if (response.status === 204 || response.status === 304) return null
  const contentType = response.headers.get('content-type') || ''
  if (!contentType.includes('json')) {
    const text = await response.text()
    return text ? { error: text.slice(0, 500) } : null
  }
  return response.json().catch(() => null)
}

export async function requestJson<T = unknown>(
  url: string,
  { method = 'GET', body, headers = {}, signal }: RequestOptions = {},
): Promise<JsonResult<T>> {
  const verb = String(method || 'GET').toUpperCase()
  const write = !['GET', 'HEAD'].includes(verb)
  const requestHeaders = new Headers(headers)
  if (write) requestHeaders.set('content-type', 'application/json')

  let response: Response
  try {
    response = await fetch(url, {
      method: verb,
      headers: requestHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
      cache: 'no-store',
      signal,
    })
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') throw error
    throw new ApiError('无法连接团队服务，请检查网络或服务状态')
  }

  const payload = await readPayload(response)
  if (response.status !== 304 && !response.ok) {
    throw new ApiError(payload?.error || `请求失败 (${response.status})`, {
      status: response.status,
      code: payload?.code || null,
      details: payload?.details || null,
      recoverable: Boolean(payload?.recoverable),
      payload,
    })
  }

  return {
    data: payload as T,
    status: response.status,
    etag: response.headers.get('etag'),
  }
}

export function redirectToLogin() {
  const returnTo = `${window.location.pathname}${window.location.search}`
  if (window.location.pathname === '/login.html') return
  const target = `/login.html?returnTo=${encodeURIComponent(returnTo)}`
  window.location.assign(target)
}
