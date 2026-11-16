/**
 * Jenkins REST 客户端（零依赖，只用 node:http/https）。
 *
 * 为什么不用全局 fetch：
 * - 需要逐请求控制 TLS 校验（内网 Jenkins 常用自签证书）；
 * - 需要「总时长」超时，而不只是 socket 空闲超时；
 * - 触发构建靠 Location 头拿 queue id，必须不自动跟随重定向；
 * - 需要区分「被反向代理重定向到登录页」和真正的认证失败。
 */
import http from 'node:http'
import https from 'node:https'

export const CLIENT_VERSION = '1.0.0'

const DEFAULT_TIMEOUT_MS = 20_000
const MAX_BODY_BYTES = 8 * 1024 * 1024
const MAX_JOBS = 500
const MAX_FOLDER_DEPTH = 4
const CRUMB_TTL_MS = 30 * 60 * 1000
const QUEUE_POLL_INTERVAL_MS = 1_000

const JOB_TREE = 'jobs[name,fullName,color,url,description,_class]'
const JOB_DETAIL_TREE = [
  'name',
  'fullName',
  'url',
  'color',
  'description',
  'buildable',
  'inQueue',
  'nextBuildNumber',
  'property[parameterDefinitions[name,type,description,defaultParameterValue[value],choices]]',
  'lastBuild[number,result,building,timestamp,duration,displayName]',
  'lastSuccessfulBuild[number,result,timestamp]',
  'lastFailedBuild[number,result,timestamp]',
].join(',')
const BUILD_TREE = [
  'number',
  'result',
  'building',
  'duration',
  'estimatedDuration',
  'timestamp',
  'url',
  'displayName',
  'fullDisplayName',
  'description',
].join(',')

export class JenkinsError extends Error {
  constructor(message, { code = null, status = null, detail = null } = {}) {
    super(message)
    this.name = 'JenkinsError'
    this.code = code
    this.status = status
    this.detail = detail
  }

  get unauthorized() {
    return this.status === 401 || this.status === 403
  }

  get notFound() {
    return this.status === 404
  }
}

function text(value) {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

function positiveInt(value, fallback) {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : fallback
}

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

export function normalizeBaseUrl(value) {
  const raw = text(value)
  if (!raw) return ''
  return raw.replace(/\/+$/, '')
}

export function encodeQuery(query) {
  if (!query || typeof query !== 'object') return ''
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue
    search.append(key, String(value))
  }
  const encoded = search.toString()
  return encoded ? `?${encoded}` : ''
}

/**
 * 把 `folder/job` 形式的名字转成 Jenkins 的 URL 结构：`/job/folder/job/job`。
 * 每段独立编码，斜杠不参与编码，否则 folder 会变成单个 job 名。
 */
export function jobPath(name) {
  const segments = String(name ?? '')
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean)
  if (!segments.length) throw new JenkinsError('缺少 job 名称', { code: 1002 })
  return segments.map((segment) => `/job/${encodeURIComponent(segment)}`).join('')
}

function buildTarget(name, number) {
  const suffix =
    number === undefined || number === null || text(number) === ''
      ? 'lastBuild'
      : encodeURIComponent(text(number))
  return `${jobPath(name)}/${suffix}`
}

/** Jenkins 用颜色表达状态，`_anime` 后缀表示正在构建。 */
export function statusOf(color) {
  const value = text(color).toLowerCase()
  if (!value) return 'unknown'
  if (value.includes('anime')) return 'building'
  if (value.startsWith('blue')) return 'success'
  if (value.startsWith('red')) return 'failed'
  if (value.startsWith('yellow')) return 'unstable'
  if (value.startsWith('aborted')) return 'aborted'
  if (value.startsWith('disabled')) return 'disabled'
  if (value.startsWith('notbuilt') || value.startsWith('grey')) return 'notbuilt'
  return 'unknown'
}

function globMatcher(pattern) {
  const source = text(pattern)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  try {
    return new RegExp(`^${source}$`, 'i')
  } catch {
    return null
  }
}

export function matchesFilter(job, patterns) {
  if (!Array.isArray(patterns) || patterns.length === 0) return true
  const candidates = [job.name, job.shortName].map((value) => text(value)).filter(Boolean)
  return patterns.some((pattern) => {
    const matcher = globMatcher(pattern)
    return matcher ? candidates.some((candidate) => matcher.test(candidate)) : false
  })
}

function parameterDefinitions(property) {
  const definitions = []
  for (const entry of Array.isArray(property) ? property : []) {
    for (const definition of entry?.parameterDefinitions ?? []) {
      const name = text(definition?.name)
      if (!name) continue
      const rawChoices = definition.choices
      const choices = Array.isArray(rawChoices)
        ? rawChoices.map(text).filter(Boolean)
        : text(rawChoices)
            .split('\n')
            .map((choice) => choice.trim())
            .filter(Boolean)
      const type = text(definition.type) || 'StringParameterDefinition'
      const className = text(definition._class)
      // 动态参数（如 List Git Branches 的 PT_BRANCH）没有静态 choices，
      // 需要调 descriptorByName/<class>/fillValueItems 现取候选值。
      const dynamicChoices = type === 'PT_BRANCH' || /listgitbranches/i.test(className)
      definitions.push({
        name,
        type,
        className,
        description: text(definition.description),
        defaultValue: definition.defaultParameterValue?.value ?? null,
        ...(dynamicChoices ? { dynamicChoices: true } : {}),
        ...(choices.length ? { choices } : {}),
      })
    }
  }
  return definitions
}

function normalizeJob(data) {
  return {
    name: text(data?.fullName) || text(data?.name),
    shortName: text(data?.name),
    url: text(data?.url) || null,
    color: text(data?.color) || 'grey',
    status: statusOf(data?.color),
    description: text(data?.description),
    buildable: data?.buildable !== false,
    inQueue: data?.inQueue === true,
    nextBuildNumber: Number.isInteger(data?.nextBuildNumber) ? data.nextBuildNumber : null,
    parameters: parameterDefinitions(data?.property),
    lastBuild: normalizeBuild(data?.lastBuild),
    lastSuccessfulBuild: normalizeBuild(data?.lastSuccessfulBuild),
    lastFailedBuild: normalizeBuild(data?.lastFailedBuild),
  }
}

function normalizeBuild(data) {
  if (!data || data.number === undefined) return null
  return {
    number: data.number,
    result: text(data.result) || null,
    building: data.building === true,
    duration: Number.isFinite(data.duration) ? data.duration : null,
    estimatedDuration: Number.isFinite(data.estimatedDuration) ? data.estimatedDuration : null,
    timestamp: Number.isFinite(data.timestamp) ? data.timestamp : null,
    url: text(data.url) || null,
    displayName: text(data.displayName) || null,
  }
}

function queueIdFromLocation(location) {
  const match = /\/queue\/item\/(\d+)/.exec(text(location))
  return match ? Number(match[1]) : null
}

function isSuccess(status) {
  return status >= 200 && status < 400
}

function toError(result, method, requestPath) {
  const location = text(result.headers?.location)
  if (result.status >= 300 && result.status < 400) {
    if (/login|securityRealm|j_security_check/i.test(location)) {
      return new JenkinsError(
        'Jenkins 认证失败：请求被重定向到登录页，请检查 username 与 API Token',
        {
          status: 401,
          code: 1001,
          detail: location,
        },
      )
    }
    return new JenkinsError(
      `Jenkins 返回重定向（${result.status}）: ${location || '无 Location'}`,
      {
        status: result.status,
        code: 1002,
      },
    )
  }
  if (result.status === 401 || result.status === 403) {
    // Jenkins 打在 403 的 html 里会直接写出缺哪个权限，解析出来比笼统的“拒绝访问”有用得多。
    const margin = /([^\s<>]+) is missing the ([A-Za-z/]+) permission/.exec(text(result.text))
    const hint = margin
      ? `账号 ${margin[1]} 缺少 ${margin[2]} 权限，需要 Jenkins 管理员在矩阵授权里授予`
      : '请检查 API Token 是否有效、是否有该 job 的读/构建权限'
    return new JenkinsError(`Jenkins 拒绝访问（${result.status}）：${hint}`, {
      status: result.status,
      code: 1001,
    })
  }
  if (result.status === 404) {
    return new JenkinsError(`Jenkins 资源不存在（404）: ${method} ${requestPath}`, {
      status: 404,
      code: 1002,
    })
  }
  const hint = text(result.text).slice(0, 300).replace(/\s+/g, ' ')
  return new JenkinsError(`Jenkins 返回 ${result.status}: ${hint || '无响应体'}`, {
    status: result.status,
    code: 1002,
  })
}

function normalizeError(error) {
  if (error instanceof JenkinsError) return error
  const code = text(error?.code)
  const detail = text(error?.message) || String(error)
  if (code === 'ECONNREFUSED') {
    return new JenkinsError(`无法连接 Jenkins（连接被拒绝）: ${detail}`, { code: 1002, detail })
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return new JenkinsError(`Jenkins 域名解析失败: ${detail}`, { code: 1002, detail })
  }
  if (
    code.startsWith('CERT_') ||
    code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
    code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
    code === 'SELF_SIGNED_CERT_IN_CHAIN'
  ) {
    return new JenkinsError(
      `Jenkins TLS 证书校验失败（自签证书可把 verifyTls 设为 false）: ${detail}`,
      {
        code: 1002,
        detail,
      },
    )
  }
  if (code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'EPIPE') {
    return new JenkinsError(`Jenkins 连接中断: ${detail}`, { code: 1003, detail })
  }
  return new JenkinsError(detail, { code: 1002, detail })
}

function retryable(error, method) {
  if (method !== 'GET') return false
  if (error.status) return error.status >= 500
  return true
}

export function createJenkinsClient(options = {}) {
  const baseUrl = normalizeBaseUrl(options.baseUrl)
  if (!baseUrl) throw new JenkinsError('缺少 Jenkins 地址 baseUrl', { code: 1002 })
  const username = text(options.username)
  const password = text(options.password)
  let sessionCookie = ''
  let loginPromise = null
  const timeoutMs = positiveInt(options.timeoutMs, DEFAULT_TIMEOUT_MS)
  const retries = Math.max(0, Number(options.retries ?? 1) || 0)
  const verifyTls = options.verifyTls !== false
  const crumbMode = options.crumb === 'off' || options.crumb === 'force' ? options.crumb : 'auto'
  const maxBodyBytes = positiveInt(options.maxBodyBytes, MAX_BODY_BYTES)
  const logger = options.logger ?? { warn() {} }

  let crumbCache = null

  function buildHeaders(extra = {}) {
    const headers = {
      accept: 'application/json, text/plain, */*',
      'user-agent': `trellis-board-jenkins-ops/${CLIENT_VERSION}`,
    }
    // 认证方式只有一种：表单登录换会话 Cookie。
    // Jenkins 的 Basic 认证（账号+API Token）在 SSO 环境下会拿到与网页不同的身份，
    // 表单登录才能复用网页用户的权限与组信息。
    if (sessionCookie) headers.cookie = sessionCookie
    return { ...headers, ...extra }
  }

  function cookiePairs(headers) {
    const raw = headers?.['set-cookie']
    const list = Array.isArray(raw) ? raw : raw ? [raw] : []
    return list
      .map((line) => text(line).split(';')[0].trim())
      .filter((pair) => pair && pair.includes('='))
  }

  // Jenkins 表单登录：必须先 GET /login 拿到初始 JSESSIONID，再 POST 表单，
  // 否则服务端不会下发新的会话 Cookie（实测 Jenkins 2.361）。
  async function performLogin() {
    if (!username) throw new JenkinsError('表单登录需要 username', { code: 1002 })
    if (!password) throw new JenkinsError('表单登录需要 password', { code: 1002 })
    const seed = await sendOnce('GET', '/login', {
      headers: { accept: 'text/html,application/xhtml+xml' },
    })
    let jar = cookiePairs(seed.headers).join('; ')
    const form = [
      `j_username=${encodeURIComponent(username)}`,
      `j_password=${encodeURIComponent(password)}`,
      'from=%2F',
      'Submit=',
    ].join('&')
    const response = await sendOnce('POST', '/j_spring_security_check', {
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'text/html,application/xhtml+xml',
        ...(jar ? { cookie: jar } : {}),
      },
      body: form,
    })
    const fresh = cookiePairs(response.headers)
    if (fresh.length) jar = fresh.join('; ')
    if (!jar) {
      throw new JenkinsError(
        `Jenkins 登录失败（HTTP ${response.status}）：未返回会话 Cookie，请检查账号密码`,
        {
          code: 1001,
          status: response.status || 401,
        },
      )
    }
    const who = await sendOnce('GET', '/whoAmI/api/json', { headers: { cookie: jar } })
    let identity = null
    try {
      identity = JSON.parse(who.body.toString('utf8'))
    } catch {
      identity = null
    }
    if (!identity || !identity.authenticated || identity.name === 'anonymous') {
      throw new JenkinsError('Jenkins 登录失败：账号或密码不正确', { code: 1001, status: 401 })
    }
    return { cookie: jar, user: identity.name }
  }

  async function ensureSession() {
    if (sessionCookie) return
    if (!password) return
    if (!loginPromise) {
      loginPromise = performLogin()
        .then((result) => {
          sessionCookie = result.cookie
          loginPromise = null
          return result
        })
        .catch((error) => {
          loginPromise = null
          throw error
        })
    }
    await loginPromise
  }

  function sendOnce(method, requestPath, { query, body, headers, timeoutMs: budget } = {}) {
    let url
    try {
      url = new URL(`${baseUrl}${requestPath}${encodeQuery(query)}`)
    } catch {
      throw new JenkinsError(`Jenkins 地址不合法: ${baseUrl}${requestPath}`, { code: 1002 })
    }
    const payload =
      body === undefined || body === null
        ? null
        : Buffer.isBuffer(body)
          ? body
          : Buffer.from(String(body), 'utf8')
    const transport = url.protocol === 'https:' ? https : http
    const requestHeaders = buildHeaders(headers)
    if (payload) requestHeaders['content-length'] = String(payload.length)
    const requestOptions = {
      method,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      headers: requestHeaders,
    }
    if (url.protocol === 'https:') requestOptions.rejectUnauthorized = verifyTls
    const limit = positiveInt(budget, timeoutMs)

    return new Promise((resolve, reject) => {
      let settled = false
      let timer = null
      const finish = (fn) => (value) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        fn(value)
      }
      const request = transport.request(requestOptions, (response) => {
        const chunks = []
        let size = 0
        response.on('data', (chunk) => {
          size += chunk.length
          if (size > maxBodyBytes) {
            request.destroy(
              new JenkinsError(`Jenkins 响应体超过 ${maxBodyBytes} 字节，已中断`, { code: 1005 }),
            )
            return
          }
          chunks.push(chunk)
        })
        response.on('end', () =>
          finish(resolve)({
            status: response.statusCode ?? 0,
            headers: response.headers ?? {},
            body: Buffer.concat(chunks),
          }),
        )
        response.on('error', finish(reject))
      })
      timer = setTimeout(() => {
        request.destroy(
          new JenkinsError(`Jenkins 请求超时（${limit}ms）: ${method} ${url.pathname}`, {
            code: 1003,
          }),
        )
      }, limit)
      timer.unref?.()
      request.on('error', finish(reject))
      if (payload) request.write(payload)
      request.end()
    })
  }

  function interpret(response) {
    const raw = response.body.toString('utf8')
    return {
      status: response.status,
      headers: response.headers ?? {},
      text: raw,
      contentType: text(response.headers?.['content-type']),
      json() {
        if (!raw.trim()) return null
        try {
          return JSON.parse(raw)
        } catch {
          if (/<html/i.test(raw.slice(0, 400))) {
            throw new JenkinsError(
              'Jenkins 返回 HTML 页面（通常是登录页或反向代理错误页），请检查 baseUrl 与认证',
              { status: 200, code: 1001, detail: raw.slice(0, 200) },
            )
          }
          throw new JenkinsError('Jenkins 返回的不是合法 JSON', {
            status: response.status,
            code: 1002,
            detail: raw.slice(0, 200),
          })
        }
      },
    }
  }

  async function request(method, requestPath, requestOptions = {}) {
    if (password && !sessionCookie) await ensureSession()
    const attempts = Math.max(1, 1 + (requestOptions.retry ?? retries))
    const allowStatus = requestOptions.allowStatus ?? []
    let lastError = null
    let relogged = false
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const result = interpret(await sendOnce(method, requestPath, requestOptions))
        if (isSuccess(result.status) || allowStatus.includes(result.status)) return result
        // 会话过期：Jenkins 会重定向到 /login 或直接 403，此时重新登录一次
        if (
          !relogged &&
          password &&
          !requestOptions.noRelogin &&
          (result.status === 401 ||
            (result.status === 403 && /\/login\?from=|Access Denied/i.test(result.text)))
        ) {
          relogged = true
          sessionCookie = ''
          await ensureSession()
          attempt -= 1
          continue
        }
        throw toError(result, method, requestPath)
      } catch (error) {
        lastError = normalizeError(error)
        if (attempt + 1 >= attempts || !retryable(lastError, method)) throw lastError
        await delay(200 * (attempt + 1))
      }
    }
    throw lastError
  }

  async function ensureCrumb(force = false) {
    if (crumbMode === 'off') return null
    if (!force && crumbCache) {
      if (crumbCache.disabled) return null
      if (crumbCache.expiresAt > Date.now()) return crumbCache
    }
    try {
      const result = await request('GET', '/crumbIssuer/api/json', { retry: 0, allowStatus: [404] })
      if (result.status === 404) {
        if (crumbMode === 'force') {
          throw new JenkinsError(
            'Jenkins 未启用 CSRF（crumbIssuer 返回 404），但 crumb 被设为 force',
            {
              code: 1002,
            },
          )
        }
        crumbCache = { disabled: true }
        return null
      }
      const data = result.json()
      const field = text(data?.crumbRequestField)
      const value = text(data?.crumb)
      if (!field || !value) {
        crumbCache = { disabled: true }
        return null
      }
      crumbCache = { field, value, expiresAt: Date.now() + CRUMB_TTL_MS }
      return crumbCache
    } catch (error) {
      if (error instanceof JenkinsError && error.unauthorized) throw error
      if (crumbMode === 'force') throw error
      logger.warn?.('获取 Jenkins crumb 失败，按无 crumb 继续', { message: error.message })
      crumbCache = { disabled: true }
      return null
    }
  }

  async function post(requestPath, { query, body, headers, timeoutMs: budget } = {}) {
    let crumb = await ensureCrumb()
    let retried = false
    for (;;) {
      const merged = crumb ? { [crumb.field]: crumb.value, ...(headers ?? {}) } : headers
      try {
        return await request('POST', requestPath, {
          query,
          body,
          headers: merged,
          timeoutMs: budget,
          retry: 0,
        })
      } catch (error) {
        const stale = error instanceof JenkinsError && error.status === 403 && crumb && !retried
        if (!stale) throw error
        retried = true
        crumb = await ensureCrumb(true)
      }
    }
  }

  async function listJobs({ folder = '', recursive = true, filter = [], views = [] } = {}) {
    const viewNames = (Array.isArray(views) ? views : []).map(text).filter(Boolean)
    const jobs = []
    const seen = new Set()
    const pending = viewNames.length
      ? viewNames.map((view) => ({
          requestPath: `/view/${encodeURIComponent(view)}/api/json`,
          view,
          depth: 0,
        }))
      : [{ folder: text(folder), depth: 0, view: null }]

    while (pending.length && jobs.length < MAX_JOBS) {
      const current = pending.shift()
      const requestPath =
        current.requestPath ?? `${current.folder ? jobPath(current.folder) : ''}/api/json`
      const response = await request('GET', requestPath, { query: { tree: JOB_TREE } })
      const data = response.json()
      for (const entry of data?.jobs ?? []) {
        const name = text(entry?.fullName) || text(entry?.name)
        if (!name || seen.has(name)) continue
        seen.add(name)
        const isFolder = /folder/i.test(text(entry?._class))
        const job = {
          name,
          shortName: text(entry?.name),
          url: text(entry?.url) || null,
          color: text(entry?.color) || 'grey',
          status: statusOf(entry?.color),
          description: text(entry?.description),
          folder: current.folder ?? '',
          view: current.view ?? null,
          isFolder,
        }
        if (isFolder) {
          if (recursive && current.depth < MAX_FOLDER_DEPTH) {
            pending.push({ folder: name, depth: current.depth + 1, view: current.view ?? null })
          }
          continue
        }
        jobs.push(job)
      }
    }

    return {
      jobs: jobs.filter((job) => matchesFilter(job, filter)).slice(0, MAX_JOBS),
      total: jobs.length,
      ...(viewNames.length ? { views: viewNames } : {}),
    }
  }

  async function getJob(name) {
    const response = await request('GET', `${jobPath(name)}/api/json`, {
      query: { tree: JOB_DETAIL_TREE },
    })
    return normalizeJob(response.json())
  }

  async function waitForBuild(queueId, { timeoutMs: budget = 60_000 } = {}) {
    const deadline = Date.now() + budget
    while (Date.now() < deadline) {
      const response = await request('GET', `/queue/item/${encodeURIComponent(queueId)}/api/json`, {
        retry: 0,
      })
      const item = response.json()
      if (item?.cancelled) {
        throw new JenkinsError('排队中的构建已被取消（可能被更早的构建顶掉）', { code: 1002 })
      }
      const number = item?.executable?.number
      if (Number.isInteger(number)) return number
      await delay(QUEUE_POLL_INTERVAL_MS)
    }
    return null
  }

  // 动态参数候选值：List Git Branches 等插件通过 descriptorByName 暴露 fillValueItems
  async function listParameterValues(name, parameterName, className) {
    const job = text(name)
    const param = text(parameterName)
    const cls = text(className)
    if (!job || !param || !cls) {
      throw new JenkinsError('需要 job、参数名与参数类名才能取候选值', { code: 1002 })
    }
    const result = await request(
      'GET',
      `${jobPath(job)}/descriptorByName/${encodeURIComponent(cls)}/fillValueItems`,
      { query: { param }, retry: 0 },
    )
    const data = result.json() ?? {}
    const values = (Array.isArray(data.values) ? data.values : [])
      .map((item) => (typeof item === 'string' ? item : text(item?.value ?? item?.name)))
      .filter(Boolean)
    return { job, parameter: param, values }
  }

  async function triggerBuild(name, { parameters, wait = false, waitTimeoutMs } = {}) {
    const entries = Object.entries(parameters ?? {}).filter(
      ([key, value]) => text(key) && value !== undefined && value !== null,
    )
    const hasParameters = entries.length > 0
    const body = hasParameters
      ? new URLSearchParams(
          entries.map(([key, value]) => [
            key,
            Array.isArray(value) ? value.join(',') : String(value),
          ]),
        ).toString()
      : null
    const target = `${jobPath(name)}/${hasParameters ? 'buildWithParameters' : 'build'}`
    const response = await post(target, {
      ...(body ? { body, headers: { 'content-type': 'application/x-www-form-urlencoded' } } : {}),
    })
    const location = text(response.headers.location)
    const queueId = queueIdFromLocation(location)
    const result = {
      job: name,
      triggered: true,
      parameterized: hasParameters,
      parameters: hasParameters ? Object.fromEntries(entries) : {},
      queueUrl: location || null,
      queueId,
      buildNumber: null,
    }
    if (wait && queueId) {
      result.buildNumber = await waitForBuild(queueId, { timeoutMs: waitTimeoutMs })
    }
    return result
  }

  async function getBuild(name, number) {
    const response = await request('GET', `${buildTarget(name, number)}/api/json`, {
      query: { tree: BUILD_TREE },
    })
    return { job: name, ...normalizeBuild(response.json()) }
  }

  async function getBuildLog(name, number, { tail } = {}) {
    const response = await request('GET', `${buildTarget(name, number)}/consoleText`)
    const lines = response.text.split('\n')
    const limit = positiveInt(tail, 0)
    const truncated = limit > 0 && lines.length > limit
    return {
      job: name,
      number: number ?? null,
      totalLines: lines.length,
      truncated,
      text: truncated ? lines.slice(-limit).join('\n') : response.text,
    }
  }

  async function stopBuild(name, number) {
    await post(`${buildTarget(name, number)}/stop`)
    return { job: name, number: number ?? null, stopped: true }
  }

  async function listQueue() {
    const data = (
      await request('GET', '/queue/api/json', {
        query: {
          tree: 'items[id,task[name,url],why,inQueueSince,stuck,blocked,buildableStartMilliseconds,cancelable,params]',
        },
      })
    ).json()
    return {
      items: (data?.items ?? []).map((item) => ({
        id: item.id,
        job: text(item?.task?.name),
        url: text(item?.task?.url) || null,
        why: text(item?.why) || null,
        inQueueSince: Number.isFinite(item?.inQueueSince) ? item.inQueueSince : null,
        stuck: item?.stuck === true,
        blocked: item?.blocked === true,
        buildable: item?.buildable === true,
        cancelable: item?.cancelable !== false,
        params: text(item?.params) || null,
      })),
    }
  }

  async function cancelQueue(id) {
    const queueId = text(id)
    if (!queueId) throw new JenkinsError('缺少队列 id', { code: 1002 })
    await post('/queue/cancelItem', { query: { id: queueId } })
    return { id: queueId, cancelled: true }
  }

  async function listArtifacts(name, number) {
    const data = (
      await request('GET', `${buildTarget(name, number)}/api/json`, {
        query: { tree: 'number,artifacts[fileName,relativePath,displayPath],url' },
      })
    ).json()
    const buildNumber = data?.number ?? number ?? null
    return {
      job: name,
      number: buildNumber,
      artifacts: (data?.artifacts ?? []).map((artifact) => ({
        fileName: text(artifact?.fileName),
        relativePath: text(artifact?.relativePath),
        displayPath: text(artifact?.displayPath) || text(artifact?.relativePath),
        size: Number.isFinite(artifact?.size) ? artifact.size : null,
        downloadPath: `${jobPath(name)}/${encodeURIComponent(buildNumber)}/artifact/${text(
          artifact?.relativePath,
        )
          .split('/')
          .map((segment) => encodeURIComponent(segment))
          .join('/')}`,
      })),
    }
  }

  async function fetchArtifact(name, number, artifactPath) {
    const relative = text(artifactPath)
    if (!relative) throw new JenkinsError('缺少产物路径', { code: 1002 })
    const encoded = relative
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/')
    const target = `${buildTarget(name, number)}/artifact/${encoded}`
    const response = await request('GET', target, { retry: 0 })
    return {
      job: name,
      number: number ?? null,
      path: relative,
      contentType: response.contentType || 'application/octet-stream',
      size: Buffer.byteLength(response.text, 'utf8'),
      base64: Buffer.from(response.text, 'binary').toString('base64'),
    }
  }

  async function testConnection() {
    const response = await request('GET', '/api/json', {
      query: { tree: 'mode,nodeDescription,useSecurity,jobs[name]' },
    })
    const data = response.json()
    return {
      ok: true,
      jenkinsVersion: text(response.headers['x-jenkins']) || null,
      mode: text(data?.mode) || null,
      nodeDescription: text(data?.nodeDescription) || null,
      useSecurity: data?.useSecurity === true,
      jobCount: Array.isArray(data?.jobs) ? data.jobs.length : null,
    }
  }

  return {
    baseUrl,
    username,
    hasPassword: Boolean(password),
    authMode: password ? 'password' : 'none',
    login: performLogin,
    listJobs,
    getJob,
    listParameterValues,
    triggerBuild,
    getBuild,
    getBuildLog,
    stopBuild,
    listQueue,
    cancelQueue,
    listArtifacts,
    fetchArtifact,
    testConnection,
    snapshot: () => ({
      baseUrl,
      username,
      hasPassword: Boolean(password),
      verifyTls,
      crumb: crumbMode,
      timeoutMs,
    }),
  }
}
