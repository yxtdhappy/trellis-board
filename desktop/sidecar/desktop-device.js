import http from 'node:http'
import https from 'node:https'
import fs from 'node:fs/promises'
import { AgentApiClient } from '../../agent/api.js'
import {
  CONFIG_SCHEMA_VERSION,
  ConfigStore,
  createConfigRevision,
} from '../../agent/config-store.js'
import {
  AgentError,
  AGENT_ERROR_CODE,
  AGENT_PROTOCOL_VERSION,
  AGENT_VERSION,
  normalizeServerUrl,
  safeErrorMessage,
  validatePairingCode,
} from '../../agent/protocol.js'

const SESSION_COOKIE = 'trellis_team_session'
const MAX_RESPONSE_BYTES = 256 * 1024
const AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,512}$/
const ENROLL_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,512}$/
const USERNAME_PATTERN = /^[A-Za-z0-9._-]{3,64}$/

export function validateDeviceName(value) {
  const name = String(value || '').trim()
  if (!name || Array.from(name).length > 80 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new AgentError(AGENT_ERROR_CODE.CONFIG_INVALID, '设备名格式无效')
  }
  return name
}

export function validateUsername(value) {
  const username = String(value || '')
    .trim()
    .toLowerCase()
  if (!USERNAME_PATTERN.test(username)) {
    throw new AgentError(AGENT_ERROR_CODE.CONFIG_INVALID, '登录名格式无效')
  }
  return username
}

export function validatePassword(value) {
  if (typeof value !== 'string' || Array.from(value).length < 6) {
    throw new AgentError(AGENT_ERROR_CODE.CONFIG_INVALID, '密码至少需要 6 个字符')
  }
  if (Buffer.byteLength(value, 'utf8') > 1024) {
    throw new AgentError(AGENT_ERROR_CODE.CONFIG_INVALID, '密码不能超过 1024 字节')
  }
  return value
}

export function validateSessionToken(value) {
  const token = String(value || '').trim()
  if (!SESSION_TOKEN_PATTERN.test(token)) {
    throw new AgentError(AGENT_ERROR_CODE.CONFIG_INVALID, '管理员会话 Cookie 格式无效')
  }
  return token
}

export function validateAgentId(value) {
  const agentId = String(value || '').trim()
  if (!AGENT_ID_PATTERN.test(agentId)) {
    throw new AgentError(AGENT_ERROR_CODE.CONFIG_INVALID, '设备 ID 格式无效')
  }
  return agentId
}

export function validateEnrollToken(value) {
  const token = String(value || '').trim()
  if (!ENROLL_TOKEN_PATTERN.test(token)) {
    throw new AgentError(AGENT_ERROR_CODE.CONFIG_INVALID, '设备令牌格式无效')
  }
  return token
}

function mapEnrollError(error) {
  if (!(error instanceof AgentError)) return error
  if (error.code === AGENT_ERROR_CODE.DESKTOP_TOKEN_INVALID) {
    return new AgentError(error.code, error.message, { cause: error, terminal: true })
  }
  if (error.code === AGENT_ERROR_CODE.NETWORK_ERROR) {
    return new AgentError(
      AGENT_ERROR_CODE.NETWORK_ERROR,
      '无法连接 Board 服务端，请检查网络后重试',
      { cause: error, retryable: true },
    )
  }
  return error
}

function requireCredentialStore(store) {
  if (!store) {
    throw new AgentError(AGENT_ERROR_CODE.CONFIG_INVALID, '设备注册缺少凭证存储')
  }
  return store
}

async function completeDesktopEnrollment({
  enrolled,
  serverUrl,
  deviceName,
  store,
  credentialStore,
  bindings = [],
}) {
  if (enrolled.protocolVersion !== AGENT_PROTOCOL_VERSION) {
    throw new AgentError(
      AGENT_ERROR_CODE.PROTOCOL_INCOMPATIBLE,
      '服务端 Agent 协议版本与当前客户端不兼容',
    )
  }
  const config = {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    revision: createConfigRevision(),
    serverUrl,
    caFile: null,
    agentId: enrolled.agentId,
    deviceName,
    username: enrolled.username || null,
    teamId: enrolled.teamId || null,
    teams: Array.isArray(enrolled.teams) ? enrolled.teams : [],
    protocolVersion: AGENT_PROTOCOL_VERSION,
    agentVersion: AGENT_VERSION,
    pairedAt: new Date().toISOString(),
    bindings,
  }
  await store.updateConfig(
    async () => {
      await credentialStore.saveCredential(enrolled.credential)
      return config
    },
    { allowMissing: true },
  )
  return {
    agentId: enrolled.agentId,
    deviceName,
    serverUrl,
    protocolVersion: enrolled.protocolVersion,
    username: enrolled.username || null,
    teams: Array.isArray(enrolled.teams) ? enrolled.teams : [],
  }
}

function parseResponseBody(text) {
  if (!text.trim()) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new AgentError(AGENT_ERROR_CODE.INVALID_RESPONSE, 'Board 服务端返回了无效 JSON')
  }
}

function responseError(response, fallback) {
  const message =
    typeof response.body?.error === 'string'
      ? response.body.error.slice(0, 500)
      : `${fallback}：HTTP ${response.status}`
  return new AgentError(AGENT_ERROR_CODE.HTTP_ERROR, message)
}

export function parseSessionCookie(headers) {
  const values = headers?.['set-cookie']
  const rows = Array.isArray(values) ? values : values == null ? [] : [values]
  const matches = []
  for (const row of rows) {
    const pair = String(row || '').split(';', 1)[0]
    const separator = pair.indexOf('=')
    if (separator < 0) continue
    if (pair.slice(0, separator).trim() !== SESSION_COOKIE) continue
    matches.push(pair.slice(separator + 1).trim())
  }
  if (matches.length !== 1) {
    throw new AgentError(
      AGENT_ERROR_CODE.INVALID_RESPONSE,
      matches.length ? 'Board 登录响应包含重复会话 Cookie' : 'Board 登录响应缺少会话 Cookie',
    )
  }
  return validateSessionToken(matches[0])
}

function normalizeTeams(value) {
  if (!Array.isArray(value)) return []
  return value.flatMap((team) => {
    if (!team || typeof team !== 'object') return []
    const id = String(team.id || '').trim()
    const name = String(team.name || '').trim()
    if (!id || !name || name.length > 160) return []
    return [
      {
        id,
        name,
        role: team.role == null ? null : String(team.role).slice(0, 32),
      },
    ]
  })
}

async function loginRequest({ serverUrl, username, password, request = requestJson }) {
  const response = await request(new URL('/api/auth/login', serverUrl), {
    method: 'POST',
    headers: { origin: serverUrl },
    body: { username, password },
  })
  if (response.status !== 200) {
    throw responseError(response, '登录失败')
  }
  const payload = parseResponseBody(response.text)
  const sessionToken = parseSessionCookie(response.headers)
  const user = payload?.user
  if (!user || typeof user !== 'object') {
    throw new AgentError(AGENT_ERROR_CODE.INVALID_RESPONSE, '登录响应缺少用户信息')
  }
  const returnedUsername = validateUsername(user.username)
  return {
    sessionToken,
    expiresAt: typeof payload.expiresAt === 'string' ? payload.expiresAt : null,
    username: returnedUsername,
    mustChangePassword: user.mustChangePassword === true,
  }
}

async function readRuntime({ serverUrl, sessionToken, request = requestJson }) {
  const response = await request(new URL('/api/runtime', serverUrl), {
    method: 'GET',
    headers: {
      cookie: `${SESSION_COOKIE}=${encodeURIComponent(sessionToken)}`,
    },
  })
  if (response.status !== 200) {
    throw responseError(response, '无法读取登录账号信息')
  }
  const payload = parseResponseBody(response.text)
  if (payload?.authenticated !== true || !payload.user || typeof payload.user !== 'object') {
    throw new AgentError(AGENT_ERROR_CODE.INVALID_RESPONSE, '登录会话未生效')
  }
  return {
    username: validateUsername(payload.user.username),
    teams: normalizeTeams(payload.teams),
  }
}

async function logoutRequest({ serverUrl, sessionToken, request = requestJson }) {
  return request(new URL('/api/auth/logout', serverUrl), {
    method: 'POST',
    headers: {
      origin: serverUrl,
      cookie: `${SESSION_COOKIE}=${encodeURIComponent(sessionToken)}`,
    },
    body: {},
  })
}

export async function logoutDesktopSession(options = {}) {
  const serverUrl = normalizeServerUrl(options.serverUrl)
  const sessionToken = validateSessionToken(options.sessionToken)
  const response = await (options.request || requestJson)(new URL('/api/auth/logout', serverUrl), {
    method: 'POST',
    headers: {
      origin: serverUrl,
      cookie: `${SESSION_COOKIE}=${encodeURIComponent(sessionToken)}`,
    },
    body: {},
  })
  if (response.status !== 200) {
    throw responseError(response, '退出登录失败')
  }
  return { loggedOut: true }
}

async function clearAgentTransientState(store) {
  const paths = store.paths
  await Promise.all([
    fs.rm(paths.eventCursorsFile, { force: true }),
    fs.rm(paths.liveCursorsFile, { force: true }),
    fs.rm(paths.liveSuppressionFile, { force: true }),
    fs.rm(paths.stateFile, { force: true }),
    fs.rm(paths.eventsDir, { recursive: true, force: true }),
    fs.rm(paths.pendingLiveDir, { recursive: true, force: true }),
    fs.rm(paths.liveBackupsDir, { recursive: true, force: true }),
  ])
  await fs.mkdir(paths.eventsDir, { recursive: true, mode: 0o700 })
  await fs.mkdir(paths.pendingLiveDir, { recursive: true, mode: 0o700 })
  await fs.mkdir(paths.liveBackupsDir, { recursive: true, mode: 0o700 })
}

async function clearDeviceRegistration(store) {
  await store.withConfigLock(async () => {
    await Promise.all([
      fs.rm(store.paths.configFile, { force: true }),
      fs.rm(store.paths.credentialFile, { force: true }),
    ])
  })
  await clearAgentTransientState(store)
}

async function reusableDevice({
  existing,
  serverUrl,
  username,
  deviceName,
  credentialStore,
  apiClientFactory,
}) {
  if (
    !existing ||
    existing.serverUrl !== serverUrl ||
    String(existing.username || '').toLowerCase() !== username
  ) {
    return null
  }
  let credential
  try {
    credential = await credentialStore.loadCredential()
  } catch {
    return null
  }
  const api = apiClientFactory({
    serverUrl,
    credential,
  })
  try {
    await api.heartbeat({
      agentId: existing.agentId,
      deviceName,
      protocolVersion: AGENT_PROTOCOL_VERSION,
      agentVersion: AGENT_VERSION,
      bindings: existing.bindings.map((binding) => ({
        taskSpaceId: binding.taskSpaceId,
        projectId: binding.projectId,
        localRepoKey: binding.localRepoKey,
        branchName: binding.branchName,
        remoteIdentityKey: binding.remoteIdentityKey,
        displayName: binding.displayName,
        status: binding.syncStatus,
      })),
    })
  } catch (error) {
    if (
      error?.code === AGENT_ERROR_CODE.AUTH_REVOKED ||
      error?.status === 401 ||
      error?.status === 403 ||
      error?.code === AGENT_ERROR_CODE.CREDENTIAL_MISSING ||
      error?.code === AGENT_ERROR_CODE.CREDENTIAL_CORRUPT
    ) {
      return null
    }
    throw error
  }
  return { credential }
}

/**
 * 桌面登录只把 Cookie 返回给 Tauri；密码、Cookie 和设备凭证均不进入配置文件。
 */
export async function loginDesktop(options = {}) {
  const serverUrl = normalizeServerUrl(options.serverUrl)
  const username = validateUsername(options.username)
  const password = validatePassword(options.password)
  const deviceName = validateDeviceName(options.deviceName)
  const store =
    options.store ||
    new ConfigStore(options.root, {
      secureDirectory: options.secureDirectory !== false,
    })
  await store.ensureDirectories()
  const credentialStore = requireCredentialStore(options.credentialStore)
  const request = options.request || requestJson
  const apiClientFactory =
    options.apiClientFactory ||
    (({ serverUrl: value, credential }) =>
      new AgentApiClient({
        serverUrl: value,
        credential,
        ca: options.ca || null,
      }))
  const session = await loginRequest({
    serverUrl,
    username,
    password,
    request,
  })
  try {
    const runtime = await readRuntime({
      serverUrl,
      sessionToken: session.sessionToken,
      request,
    })
    if (runtime.username !== session.username) {
      throw new AgentError(AGENT_ERROR_CODE.INVALID_RESPONSE, '登录响应的用户身份不一致')
    }
    const existing = await store.readConfig().catch(() => null)
    if (session.mustChangePassword) {
      if (options.forceNew === true) {
        await clearDeviceRegistration(store)
      }
      return {
        ...session,
        serverUrl,
        teams: runtime.teams,
        deviceReady: false,
      }
    }

    const reusable =
      options.forceNew === true
        ? null
        : await reusableDevice({
            existing,
            serverUrl,
            username,
            deviceName,
            credentialStore,
            apiClientFactory,
          })
    if (reusable) {
      await store.updateConfig(
        (current) => ({
          ...current,
          serverUrl,
          deviceName,
          username,
          teams: runtime.teams,
        }),
        { allowMissing: false },
      )
      return {
        ...session,
        serverUrl,
        teams: runtime.teams,
        deviceReady: true,
      }
    }

    const issued = await request(new URL('/api/desktop/enroll-tokens', serverUrl), {
      method: 'POST',
      headers: {
        origin: serverUrl,
        cookie: `${SESSION_COOKIE}=${encodeURIComponent(session.sessionToken)}`,
      },
      body: { deviceName },
    })
    if (issued.status !== 201) {
      throw responseError(issued, '无法签发桌面设备令牌')
    }
    const token = validateEnrollToken(parseResponseBody(issued.text)?.token)
    const sameAccount =
      existing &&
      existing.serverUrl === serverUrl &&
      String(existing.username || '').toLowerCase() === username
    // 设备槽替换后旧 binding 已由服务端撤销，新设备必须由用户手动重新选择仓库。
    const bindings = []
    const api = options.apiClient || new AgentApiClient({ serverUrl })
    const enrolled = await api.enrollWithToken({ token, deviceName })
    await completeDesktopEnrollment({
      enrolled,
      serverUrl,
      deviceName,
      store,
      credentialStore,
      bindings,
    })
    await store.updateConfig(
      (current) => ({
        ...current,
        username,
        teams: runtime.teams,
      }),
      { allowMissing: false },
    )
    if (!sameAccount || options.forceNew === true) {
      await clearAgentTransientState(store)
    }
    return {
      ...session,
      serverUrl,
      teams: runtime.teams,
      deviceReady: true,
    }
  } catch (error) {
    await logoutRequest({
      serverUrl,
      sessionToken: session.sessionToken,
      request,
    }).catch(() => {})
    throw error
  }
}

export function readLocalAssociations(root) {
  const store = new ConfigStore(root)
  return store.readConfig({ allowMissing: false }).then((config) =>
    config.bindings.map((binding) => ({
      taskSpaceId: binding.taskSpaceId,
      projectId: binding.projectId,
      repoPath: binding.repoPath,
      displayName: binding.displayName,
      branchName: binding.branchName,
      teamId: binding.teamId,
      status: binding.syncStatus,
      readOnly: binding.readOnly === true,
      liveSyncStatus: binding.liveSyncStatus,
      liveSyncError: binding.liveSyncError,
      lastErrorCode: binding.lastErrorCode,
      lastError: binding.lastError,
    })),
  )
}

/**
 * 桌面端默认注册路径：登录会话签发的一次性令牌换取设备凭证。
 */
export async function enrollWithToken(token, deviceInfo = {}) {
  const enrollToken = validateEnrollToken(token)
  const serverUrl = normalizeServerUrl(deviceInfo.serverUrl)
  const deviceName = validateDeviceName(deviceInfo.deviceName)
  const store =
    deviceInfo.store ||
    new ConfigStore(deviceInfo.root, {
      secureDirectory: deviceInfo.secureDirectory !== false,
    })
  await store.ensureDirectories()
  if (!deviceInfo.replace) {
    const existing = await store.readConfig()
    if (existing) {
      throw new AgentError(
        AGENT_ERROR_CODE.CONFIG_INVALID,
        '当前安装已经注册设备；如需更换账号，请显式选择重新注册',
      )
    }
  }
  const credentialStore = requireCredentialStore(deviceInfo.credentialStore)
  const api = deviceInfo.apiClient || new AgentApiClient({ serverUrl })
  let enrolled
  try {
    enrolled = await api.enrollWithToken({ token: enrollToken, deviceName })
  } catch (error) {
    throw mapEnrollError(error)
  }
  return completeDesktopEnrollment({
    enrolled,
    serverUrl,
    deviceName,
    store,
    credentialStore,
  })
}

export async function enrollDesktopDevice(options = {}) {
  const serverUrl = normalizeServerUrl(options.serverUrl)
  const pairingCode = validatePairingCode(options.pairingCode)
  const deviceName = validateDeviceName(options.deviceName)
  const store =
    options.store ||
    new ConfigStore(options.root, {
      secureDirectory: options.secureDirectory !== false,
    })
  await store.ensureDirectories()
  if (!options.replace) {
    const existing = await store.readConfig()
    if (existing) {
      throw new AgentError(
        AGENT_ERROR_CODE.CONFIG_INVALID,
        '当前安装已经注册设备；如需更换账号，请显式选择重新注册',
      )
    }
  }
  const credentialStore = requireCredentialStore(options.credentialStore)
  const api = options.apiClient || new AgentApiClient({ serverUrl })
  const enrolled = await api.enroll({ pairingCode, deviceName })
  return completeDesktopEnrollment({
    enrolled,
    serverUrl,
    deviceName,
    store,
    credentialStore,
  })
}

function requestJson(url, { method, headers, body, timeoutMs = 30_000 }) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http
    const payload = body == null ? null : Buffer.from(JSON.stringify(body), 'utf8')
    const request = transport.request(
      url,
      {
        method,
        timeout: timeoutMs,
        headers: {
          accept: 'application/json',
          ...(payload
            ? {
                'content-type': 'application/json',
                'content-length': String(payload.length),
              }
            : {}),
          ...headers,
        },
      },
      (response) => {
        const chunks = []
        let size = 0
        response.on('data', (chunk) => {
          size += chunk.length
          if (size > MAX_RESPONSE_BYTES) {
            request.destroy(new Error('Board 服务端响应过大'))
            return
          }
          chunks.push(chunk)
        })
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let parsed = null
          if (text) {
            try {
              parsed = JSON.parse(text)
            } catch {
              parsed = null
            }
          }
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: parsed,
            text,
          })
        })
      },
    )
    request.on('timeout', () => {
      request.destroy(new Error('Board 请求超时'))
    })
    request.on('error', reject)
    if (payload) request.write(payload)
    request.end()
  })
}

export async function revokeDesktopDevice(options = {}) {
  const serverUrl = normalizeServerUrl(options.serverUrl)
  const agentId = validateAgentId(options.agentId)
  const sessionToken = validateSessionToken(options.sessionCookie)
  let url
  try {
    url = new URL(`${serverUrl}/api/admin/agents/${encodeURIComponent(agentId)}/revoke`)
  } catch (error) {
    throw new AgentError(AGENT_ERROR_CODE.INVALID_RESPONSE, '服务端地址无法解析', { cause: error })
  }
  const response = await requestJson(url, {
    method: 'POST',
    headers: {
      origin: serverUrl,
      cookie: `${SESSION_COOKIE}=${encodeURIComponent(sessionToken)}`,
    },
    body: {},
    timeoutMs: options.timeoutMs,
  })
  if (response.status !== 200) {
    const message =
      typeof response.body?.error === 'string'
        ? response.body.error.slice(0, 500)
        : `设备撤销失败：HTTP ${response.status}`
    throw new AgentError(AGENT_ERROR_CODE.HTTP_ERROR, message)
  }
  return {
    revoked: response.body?.revoked === true,
    agentId: response.body?.agentId || agentId,
  }
}

export async function readAgentIdentity(root) {
  const store = new ConfigStore(root)
  try {
    const config = await store.readConfig({ allowMissing: false })
    return { agentId: config.agentId, serverUrl: config.serverUrl }
  } catch (error) {
    throw new AgentError(
      AGENT_ERROR_CODE.CONFIG_MISSING,
      `无法读取设备配置：${safeErrorMessage(error)}`,
    )
  }
}
