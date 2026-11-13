import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzip } from 'node:zlib'
import { databaseFile as defaultDatabaseFile, dataDir as defaultDataDir } from '../config.js'
import { createBoardEventService } from '../board-events.js'
import { openDatabase } from '../database.js'
import { STAGE_IDS } from '../metadata.js'
import { createAgentEventStream } from './agent-event-stream.js'
import { appendAuditEvent, listAuditEvents } from './audit.js'
import { createDesktopAuthService } from './desktop-auth.js'
import { diagnosticError } from './error-diagnostics.js'
import {
  changePassword,
  clearSessionCookie,
  createUser,
  hasActiveAdmin,
  listUsers,
  login,
  parseCookieHeader,
  readSession,
  resetUserPassword,
  revokeSession,
  SESSION_COOKIE,
  sessionCookie,
  updateUserAdmin,
} from './auth.js'
import { ERROR_CODES, errorPayload, teamError } from './errors.js'
import { createGitlessBoardService } from './gitless-board-service.js'
import { CAPABILITIES, roleCanWrite } from './permissions.js'
import { createSyncAgentService } from './sync-agent-service.js'
import { createTaskCommandService } from './task-command-service.js'
import { createTaskSnapshotBackupService } from './task-snapshot-backup.js'
import { createTaskSnapshotService } from './task-snapshot-service.js'
import { createTaskSpaceIndex } from './task-space-index.js'
import { createTaskSpaceService } from './task-space-service.js'
import {
  TEAM_ROLES,
  createTeam,
  listTeamMembers,
  listTeamsForActor,
  listUserTeams,
  readTeam,
  resolveTeamScope,
  setUserTeams,
  updateTeam,
  validateTeamAssignments,
} from './teams.js'
import {
  authorizeWorkspaceTemplate,
  publicWorkspaceTemplateManifest,
  readWorkspaceTemplate,
} from './workspace-templates.js'
import { TASK_SNAPSHOT_MAX_TRANSPORT_BYTES } from '../../../packages/shared/task-snapshot.js'

const serverDir = path.dirname(fileURLToPath(import.meta.url))
const defaultPublicDir = path.resolve(serverDir, '../public')
const MAX_JSON_BYTES = 64 * 1024
const MAX_LIVE_BATCH_BYTES = TASK_SNAPSHOT_MAX_TRANSPORT_BYTES
const EXECUTION_WIP_LIMIT = 2
const DEFAULT_REFRESH_CONCURRENCY = 4
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const STATIC_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.woff2', 'font/woff2'],
  ['.woff', 'font/woff'],
  ['.ttf', 'font/ttf'],
  ['.ico', 'image/x-icon'],
  ['.webmanifest', 'application/manifest+json'],
  ['.map', 'application/json'],
  ['.txt', 'text/plain; charset=utf-8'],
])

function securityHeaders() {
  return {
    'content-security-policy':
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
      "connect-src 'self' ipc: http://ipc.localhost; " +
      "object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
  }
}

function requireObservedBranchName(body) {
  const value = body?.observedBranchName
  if (typeof value !== 'string' || !value.trim()) {
    throw teamError(400, 'BRANCH_OBSERVATION_REQUIRED', '任务快照写入必须上报本地真实 Git 分支')
  }
}

function sendJson(response, status, payload, headers = {}) {
  if (response.headersSent) {
    response.destroy()
    return
  }
  const source = payload == null ? '' : JSON.stringify(payload)
  const compressed =
    source.length >= 1024 &&
    /\bgzip\b/.test(String(response.req?.headers?.['accept-encoding'] || ''))
  const write = (body) => {
    response.writeHead(status, {
      ...securityHeaders(),
      'content-type': 'application/json; charset=utf-8',
      'content-length': body.length,
      ...(compressed
        ? {
            'content-encoding': 'gzip',
            vary: 'accept-encoding',
          }
        : {}),
      ...headers,
    })
    response.end(body)
  }
  if (!compressed) {
    write(Buffer.from(source))
    return
  }
  gzip(source, (error, body) => {
    if (error || response.destroyed) {
      response.destroy()
      return
    }
    try {
      write(body)
    } catch {
      response.destroy()
    }
  })
}

function sendNotModified(response, etag) {
  if (response.headersSent) {
    response.destroy()
    return
  }
  response.writeHead(304, {
    ...securityHeaders(),
    etag,
  })
  response.end()
}

function etagMatches(headerValue, etag) {
  const value = String(headerValue || '').trim()
  if (!value || !etag) return false
  const strip = (tag) => tag.trim().replace(/^W\//i, '')
  const expected = strip(etag)
  return value.split(',').some((item) => strip(item) === expected)
}

function clientIp(request, trustProxy) {
  if (trustProxy) {
    const forwarded = String(request.headers['x-forwarded-for'] || '')
      .split(',')[0]
      .trim()
    if (forwarded && forwarded.length <= 128) return forwarded
  }
  return String(request.socket.remoteAddress || '').slice(0, 128)
}

function requestOrigin(request) {
  return String(request.headers.origin || '')
}

function requestProtocol(request) {
  if (request.socket?.encrypted) return 'https:'
  const forwarded = String(request.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase()
  return forwarded === 'https' ? 'https:' : 'http:'
}

function hasSingleHostHeader(request) {
  if (!Array.isArray(request.rawHeaders)) return Boolean(request.headers.host)
  let count = 0
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (String(request.rawHeaders[index]).toLowerCase() === 'host') count += 1
  }
  return count === 1
}

function requestHostOrigin(request) {
  if (!hasSingleHostHeader(request)) return ''
  const host = String(request.headers.host || '')
    .trim()
    .toLowerCase()
  if (!host || /[\u0000-\u0020\u007f/?#\\,;%]/.test(host)) return ''
  try {
    const url = new URL(`${requestProtocol(request)}//${host}`)
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return ''
    return url.origin
  } catch {
    return ''
  }
}

function assertHost(request) {
  if (!requestHostOrigin(request)) {
    throw teamError(400, ERROR_CODES.INVALID_HOST, '请求 Host 无效')
  }
}

function assertJsonWrite(request) {
  const contentType = String(request.headers['content-type'] || '').toLowerCase()
  if (!/^application\/json\s*(?:;|$)/.test(contentType)) {
    throw teamError(415, ERROR_CODES.JSON_REQUIRED, '写请求必须使用 application/json')
  }
  const origin = requestOrigin(request)
  let actualOrigin = ''
  try {
    actualOrigin = origin ? new URL(origin).origin : ''
  } catch {
    actualOrigin = ''
  }
  const expectedOrigin = requestHostOrigin(request)
  if (!actualOrigin || !expectedOrigin || actualOrigin !== expectedOrigin) {
    throw teamError(403, ERROR_CODES.CSRF_REJECTED, '请求 Origin 校验失败')
  }
}

async function readJsonBody(request, maxBytes = MAX_JSON_BYTES) {
  const declared = Number(request.headers['content-length'])
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw teamError(
      413,
      ERROR_CODES.BODY_TOO_LARGE,
      `请求体超过 ${Math.floor(maxBytes / 1024)} KiB 限制`,
    )
  }
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > maxBytes) {
      throw teamError(
        413,
        ERROR_CODES.BODY_TOO_LARGE,
        `请求体超过 ${Math.floor(maxBytes / 1024)} KiB 限制`,
      )
    }
    chunks.push(chunk)
  }
  if (!size) return {}
  let value
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, '请求体不是合法 JSON')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, '请求体必须是 JSON 对象')
  }
  return value
}

function parseInteger(value, label, fallback = null) {
  if (value == null || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed)) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, `${label} 必须是整数`)
  }
  return parsed
}

function queryList(searchParams, name) {
  return searchParams
    .getAll(name)
    .flatMap((item) => String(item).split(','))
    .map((item) => item.trim())
    .filter(Boolean)
}

function queryScalar(searchParams, name) {
  const value = searchParams.get(name)
  return value == null ? undefined : value
}

function taskQueryInput(url) {
  const params = url.searchParams
  const input = {
    scope: queryScalar(params, 'scope'),
    q: queryScalar(params, 'q'),
    branch: queryScalar(params, 'branch'),
    priorities: queryList(params, 'priorities'),
    stages: queryList(params, 'stages'),
    tags: queryList(params, 'tags'),
    assignee: queryScalar(params, 'assignee'),
    dueWithinDays: queryScalar(params, 'dueWithinDays'),
    staleDays: queryScalar(params, 'staleDays'),
    blocked: queryScalar(params, 'blocked'),
    archived: queryScalar(params, 'archived'),
    preset: queryScalar(params, 'preset'),
    limit: queryScalar(params, 'limit'),
    cursor: queryScalar(params, 'cursor'),
    projectIds: queryList(params, 'projectIds'),
    teamId: queryScalar(params, 'teamId'),
  }
  for (const key of Object.keys(input)) {
    if (input[key] === undefined) delete input[key]
  }
  if (Array.isArray(input.projectIds) && input.projectIds.length === 0) {
    delete input.projectIds
  }
  return input
}

function pagePayload(page) {
  return {
    ...page,
    total_count: page.total,
    next_cursor: page.nextCursor,
    query_revision: page.queryRevision,
    query_day: page.queryDay,
  }
}

function statusEtag(status) {
  const version = JSON.stringify({
    queryRevision: status.queryRevision,
    queryDay: status.queryDay,
    assignments: status.assignments,
    projects: status.projects.map(({ agents: _agents, ...project }) => project),
    associationProjects: status.associationProjects || [],
  })
  return `"status-${crypto.createHash('sha256').update(version).digest('base64url').slice(0, 24)}"`
}

function projectCapabilities(role, { systemAdmin = false, teamAdmin = false } = {}) {
  const writable = roleCanWrite(role)
  const manager = systemAdmin || teamAdmin
  return {
    [CAPABILITIES.VIEW]: Boolean(role) || manager,
    [CAPABILITIES.WRITE_TASK]: writable,
    [CAPABILITIES.ACCEPT_TASK]: writable,
    [CAPABILITIES.MANAGE_MEMBERS]: manager || role === 'lead',
    [CAPABILITIES.MANAGE_AGENTS]: manager || role === 'lead',
    [CAPABILITIES.VIEW_AUDIT]: manager || role === 'lead',
    [CAPABILITIES.MANAGE_PROJECT]: manager,
    [CAPABILITIES.REFRESH_PROJECT]: manager || role === 'lead',
  }
}

function requireAdmin(actor) {
  if (!actor?.systemAdmin) {
    throw teamError(403, ERROR_CODES.FORBIDDEN, '只有系统管理员可以执行该操作')
  }
}

function requireTeamAdmin(db, actor, teamId = null) {
  if (actor?.systemAdmin) {
    return resolveTeamScope(db, actor, teamId)
  }
  const adminTeams = (actor?.teams || []).filter((team) => team.role === TEAM_ROLES.ADMIN)
  if (!adminTeams.length) {
    throw teamError(403, ERROR_CODES.FORBIDDEN, '只有团队管理员可以执行该操作')
  }
  const requested = String(teamId || '').trim()
  if (!requested) {
    if (adminTeams.length === 1) return adminTeams[0].id
    throw teamError(400, ERROR_CODES.INVALID_INPUT, '请选择管理团队')
  }
  if (requested === 'all') return null
  return resolveTeamScope(db, actor, requested, { adminOnly: true })
}

function manageableTeamIds(actor, teamId = null) {
  if (actor?.systemAdmin) return teamId ? [teamId] : null
  if (teamId) return [teamId]
  return (actor?.teams || [])
    .filter((team) => team.role === TEAM_ROLES.ADMIN)
    .map((team) => team.id)
}

function teamAssignmentsFromBody(db, userId, body) {
  const usesTeamIds = body.teamIds != null
  const raw = usesTeamIds ? body.teamIds : body.teams
  if (raw == null) return undefined
  if (!Array.isArray(raw)) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, '团队列表必须是数组')
  }
  const existing = new Map(
    (userId ? listUserTeams(db, userId) : []).map((team) => [team.id, team.role]),
  )
  return raw.map((item) => {
    if (typeof item === 'string') {
      const teamId = item.trim()
      return { teamId, role: existing.get(teamId) || TEAM_ROLES.MEMBER }
    }
    if (usesTeamIds) {
      throw teamError(400, ERROR_CODES.INVALID_INPUT, '团队 ID 必须是字符串')
    }
    const teamId = String(item?.teamId || item?.id || '').trim()
    return {
      ...item,
      teamId,
      role: item?.role || existing.get(teamId) || TEAM_ROLES.MEMBER,
    }
  })
}

function safeStaticPath(publicDir, pathname) {
  let requested
  try {
    requested = decodeURIComponent(pathname === '/' ? '/index.html' : pathname)
  } catch {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, '静态资源路径无效')
  }
  const root = path.resolve(publicDir)
  const filePath = path.resolve(root, `.${requested}`)
  if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
    throw teamError(403, ERROR_CODES.FORBIDDEN, '静态资源路径越界')
  }
  if (!STATIC_TYPES.has(path.extname(filePath).toLowerCase())) {
    throw teamError(404, ERROR_CODES.NOT_FOUND, '静态资源不存在')
  }
  return { filePath, root }
}

function serveStatic(request, response, url, publicDir) {
  if (!new Set(['GET', 'HEAD']).has(request.method)) {
    sendJson(
      response,
      405,
      {
        error: '静态资源只支持 GET 或 HEAD',
        code: ERROR_CODES.INVALID_INPUT,
      },
      { allow: 'GET, HEAD' },
    )
    return
  }
  const { filePath, root } = safeStaticPath(publicDir, url.pathname)
  let stat
  let realPath
  let realRoot
  try {
    realRoot = fs.realpathSync(root)
    realPath = fs.realpathSync(filePath)
    stat = fs.statSync(realPath)
  } catch {
    stat = null
  }
  if (realPath && realPath !== realRoot && !realPath.startsWith(`${realRoot}${path.sep}`)) {
    throw teamError(403, ERROR_CODES.FORBIDDEN, '静态资源路径越界')
  }
  if (!stat?.isFile()) {
    sendJson(response, 404, {
      error: '静态资源不存在',
      code: ERROR_CODES.NOT_FOUND,
    })
    return
  }
  const contentType = STATIC_TYPES.get(path.extname(realPath).toLowerCase())
  response.writeHead(200, {
    ...securityHeaders(),
    'content-type': contentType,
    'content-length': stat.size,
  })
  if (request.method === 'HEAD') {
    response.end()
    return
  }
  fs.createReadStream(realPath)
    .on('error', () => response.destroy())
    .pipe(response)
}

function runtimeProject(project, actor) {
  const teamAdmin = Boolean(
    actor?.systemAdmin ||
    actor?.teams?.some((team) => team.id === project.teamId && team.role === TEAM_ROLES.ADMIN),
  )
  const roles = (project.taskSpaces || []).map((taskSpace) => taskSpace.role).filter(Boolean)
  const role = roles.includes('lead')
    ? 'lead'
    : roles.includes('member')
      ? 'member'
      : roles.includes('team_admin')
        ? 'team_admin'
        : roles[0] || null
  return {
    id: project.id,
    teamId: project.teamId || null,
    teamName: project.teamName || null,
    name: project.name,
    syncStatus: project.syncStatus,
    syncBranch: project.taskSpaces?.[0]?.branchName || project.syncBranch || null,
    role,
    taskSpaces: project.taskSpaces || [],
    boardVersion: project.boardVersion || null,
    stale: Boolean(project.stale),
    lastError: project.lastError || null,
    capabilities: projectCapabilities(role, {
      systemAdmin: Boolean(actor?.systemAdmin),
      teamAdmin,
    }),
  }
}

function routeMatch(pathname, pattern) {
  const match = pattern.exec(pathname)
  if (!match) return null
  try {
    return match.slice(1).map((item) => decodeURIComponent(item))
  } catch {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, '请求路径编码无效')
  }
}

function createRequestHandler({
  config,
  db,
  boardService,
  taskSpaces,
  taskSnapshots,
  taskSpaceIndex,
  taskCommands,
  agentService,
  agentEvents,
  boardEvents,
  desktopAuth,
  publicDir,
  logger,
  isClosing,
}) {
  function readActor(request) {
    const cookies = parseCookieHeader(request.headers.cookie)
    const token = cookies.get(SESSION_COOKIE)
    const session = readSession(db, token)
    if (!session) return null
    return {
      userId: session.user.id,
      sessionId: session.sessionId,
      systemAdmin: session.user.systemAdmin,
      teams: session.teams,
      user: session.user,
      expiresAt: session.expiresAt,
    }
  }

  function runtimePayload(actor) {
    if (!actor) {
      return {
        mode: 'team',
        team: true,
        authenticated: false,
        user: null,
        projects: [],
        capabilities: {},
        allowLocalGitRemotes: Boolean(config.allowLocalGitRemotes),
      }
    }
    const projects = boardService.listProjects(actor)
    const teams = listTeamsForActor(db, actor, { activeOnly: true })
    return {
      mode: 'team',
      team: true,
      authenticated: true,
      user: actor.user,
      sessionExpiresAt: actor.expiresAt,
      systemAdmin: actor.systemAdmin,
      activeTeamId: null,
      activeTeam: null,
      teamRole: null,
      teams,
      allowLocalGitRemotes: Boolean(config.allowLocalGitRemotes),
      projects: projects.map((project) => runtimeProject(project, actor)),
      capabilities: {
        manageUsers: actor.systemAdmin,
        manageTeams: actor.systemAdmin,
        manageProjects: actor.systemAdmin || teams.some((team) => team.role === TEAM_ROLES.ADMIN),
        manageAgents: actor.systemAdmin || teams.some((team) => team.role === TEAM_ROLES.ADMIN),
        viewSystemAudit: actor.systemAdmin || teams.some((team) => team.role === TEAM_ROLES.ADMIN),
      },
    }
  }

  function requireActor(request) {
    const actor = readActor(request)
    if (!actor) {
      throw teamError(401, ERROR_CODES.AUTH_REQUIRED, '需要登录')
    }
    return actor
  }

  function templateIdentity(request) {
    const actor = readActor(request)
    if (actor) {
      return {
        userId: actor.userId,
        systemAdmin: actor.systemAdmin,
        mustChangePassword: Boolean(actor.user?.mustChangePassword),
      }
    }
    if (!/^Bearer\s+/i.test(String(request.headers.authorization || ''))) {
      throw teamError(401, ERROR_CODES.AUTH_REQUIRED, '需要登录')
    }
    const agent = agentService.authenticate(request)
    const user = db
      .prepare(`
      SELECT system_admin, status, must_change_password
      FROM user_account
      WHERE id = ?
    `)
      .get(agent.userId)
    if (!user || user.status !== 'active') {
      throw teamError(401, ERROR_CODES.AGENT_AUTH_REQUIRED, 'Agent 凭证无效或已撤销')
    }
    return {
      userId: agent.userId,
      systemAdmin: Boolean(user.system_admin),
      mustChangePassword: Boolean(user.must_change_password),
    }
  }

  async function handleWorkspaceTemplate(request, response, url) {
    const match = routeMatch(
      url.pathname,
      /^\/api\/teams\/([^/]+)\/workspace-template(?:\/(manifest))?$/,
    )
    if (!match) return false
    if (request.method !== 'GET' && request.method !== 'HEAD') return false
    const [teamId, manifestRoute] = match
    const identity = templateIdentity(request)
    if (identity.mustChangePassword) {
      throw teamError(
        403,
        ERROR_CODES.PASSWORD_CHANGE_REQUIRED,
        '首次登录或密码重置后必须先修改密码',
      )
    }
    authorizeWorkspaceTemplate(db, { teamId, ...identity })
    const template = readWorkspaceTemplate()
    const version = template.manifest.version
    const etag = manifestRoute === 'manifest' ? template.manifestEtag : template.etag
    if (etagMatches(request.headers['if-none-match'], etag)) {
      sendNotModified(response, etag)
      return true
    }
    if (manifestRoute === 'manifest') {
      sendJson(response, 200, publicWorkspaceTemplateManifest(template), {
        etag,
        'x-template-sha256': template.sha256,
        'x-template-version': version,
      })
      return true
    }
    response.writeHead(200, {
      ...securityHeaders(),
      'content-type': 'application/zip',
      'content-length': template.size,
      'content-disposition': `attachment; filename="workspace-template-${version}.zip"`,
      'cache-control': 'private, max-age=0, must-revalidate',
      'x-template-sha256': template.sha256,
      'x-template-version': version,
      etag,
    })
    if (request.method === 'HEAD') {
      response.end()
      return true
    }
    response.end(template.archive)
    return true
  }

  async function handleAgent(request, response, url) {
    const { pathname } = url
    if (pathname === '/api/agent/enroll' && request.method === 'POST') {
      const body = await readJsonBody(request)
      sendJson(
        response,
        201,
        agentService.enroll(body, {
          ip: clientIp(request, false),
        }),
      )
      return true
    }
    if (pathname === '/api/agent/enroll-desktop' && request.method === 'POST') {
      const body = await readJsonBody(request)
      // verify 与 consume 之间不 await，保证令牌在本进程中只可能被兑换一次。
      const record = desktopAuth.verify(body.token)
      const result = agentService.enrollDesktop(body, record)
      desktopAuth.consume(body.token)
      sendJson(response, 201, result)
      return true
    }
    if (!pathname.startsWith('/api/agent/')) return false

    const agent = agentService.authenticate(request)
    if (pathname === '/api/agent/heartbeat' && request.method === 'POST') {
      const body = await readJsonBody(request)
      sendJson(response, 200, agentService.heartbeat(agent, body))
      return true
    }
    if (pathname === '/api/agent/task-spaces/preflight' && request.method === 'POST') {
      const body = await readJsonBody(request)
      sendJson(response, 200, taskSpaces.preflight(agent.userId, body))
      return true
    }
    if (pathname === '/api/agent/task-spaces/resolve' && request.method === 'POST') {
      const body = await readJsonBody(request)
      sendJson(response, 200, taskSpaces.resolve(agent.userId, body))
      return true
    }
    if (pathname === '/api/agent/task-spaces/attach' && request.method === 'POST') {
      const body = await readJsonBody(request, MAX_LIVE_BATCH_BYTES)
      sendJson(response, 201, taskSpaces.attach(agent.userId, agent.id, body))
      return true
    }
    const detachMatch = routeMatch(pathname, /^\/api\/agent\/task-spaces\/([^/]+)\/detach$/)
    if (detachMatch && request.method === 'POST') {
      const body = await readJsonBody(request)
      sendJson(response, 200, taskSpaces.detachAgent(agent, detachMatch[0], body))
      return true
    }
    const snapshotMatch = routeMatch(pathname, /^\/api\/agent\/task-spaces\/([^/]+)\/snapshot$/)
    if (snapshotMatch && request.method === 'GET') {
      sendJson(
        response,
        200,
        taskSnapshots.snapshot(agent, snapshotMatch[0], {
          afterRevision: url.searchParams.get('afterRevision'),
        }),
      )
      return true
    }
    const filesMatch = routeMatch(pathname, /^\/api\/agent\/task-spaces\/([^/]+)\/files$/)
    if (filesMatch && request.method === 'GET') {
      sendJson(
        response,
        200,
        taskSnapshots.directorySnapshot(agent, filesMatch[0], url.searchParams.get('taskDir')),
      )
      return true
    }
    const preflightMatch = routeMatch(pathname, /^\/api\/agent\/task-spaces\/([^/]+)\/preflight$/)
    if (preflightMatch && request.method === 'POST') {
      const body = await readJsonBody(request, MAX_LIVE_BATCH_BYTES)
      sendJson(response, 200, taskSnapshots.preflight(agent, preflightMatch[0], body))
      return true
    }
    const ownershipMatch = routeMatch(
      pathname,
      /^\/api\/agent\/task-spaces\/([^/]+)\/task-ownership$/,
    )
    if (ownershipMatch && request.method === 'POST') {
      const body = await readJsonBody(request)
      sendJson(response, 200, taskSnapshots.taskOwnership(agent, ownershipMatch[0], body))
      return true
    }
    const changesMatch = routeMatch(pathname, /^\/api\/agent\/task-spaces\/([^/]+)\/changes$/)
    if (changesMatch && request.method === 'POST') {
      const body = await readJsonBody(request, MAX_LIVE_BATCH_BYTES)
      requireObservedBranchName(body)
      const result = taskSnapshots.applyChanges(agent, changesMatch[0], body)
      sendJson(response, result.status || 200, result)
      return true
    }
    const cursorMatch = routeMatch(pathname, /^\/api\/agent\/task-spaces\/([^/]+)\/cursor$/)
    if (cursorMatch && request.method === 'PUT') {
      const body = await readJsonBody(request)
      sendJson(response, 200, taskSnapshots.writeCursor(agent, cursorMatch[0], body))
      return true
    }
    const conflictsMatch = routeMatch(pathname, /^\/api\/agent\/task-spaces\/([^/]+)\/conflicts$/)
    if (conflictsMatch && request.method === 'GET') {
      sendJson(response, 200, {
        conflicts: taskSnapshots.listConflicts(agent, conflictsMatch[0]),
      })
      return true
    }
    const conflictResolveMatch = routeMatch(
      pathname,
      /^\/api\/agent\/task-spaces\/([^/]+)\/conflicts\/([^/]+)\/resolve$/,
    )
    if (conflictResolveMatch && request.method === 'POST') {
      const body = await readJsonBody(request, MAX_LIVE_BATCH_BYTES)
      if (body.action === 'overwrite-server') requireObservedBranchName(body)
      sendJson(
        response,
        200,
        taskSnapshots.resolveConflict(
          agent,
          conflictResolveMatch[0],
          conflictResolveMatch[1],
          body,
        ),
      )
      return true
    }
    if (pathname === '/api/agent/events' && request.method === 'GET') {
      agentEvents.open({
        agent,
        response,
      })
      return true
    }
    if (pathname === '/api/agent/commands' && request.method === 'POST') {
      throw teamError(
        410,
        ERROR_CODES.AGENT_LONG_POLL_REMOVED,
        '命令长轮询已移除，请升级 Agent 并使用 GET /api/agent/events',
      )
    }
    const startMatch = routeMatch(pathname, /^\/api\/agent\/commands\/([^/]+)\/start$/)
    if (startMatch && request.method === 'POST') {
      sendJson(response, 200, taskCommands.start(agent.id, startMatch[0]))
      return true
    }
    const resultMatch = routeMatch(pathname, /^\/api\/agent\/commands\/([^/]+)\/result$/)
    if (resultMatch && request.method === 'POST') {
      const body = await readJsonBody(request)
      sendJson(response, 200, taskCommands.complete(agent, resultMatch[0], body))
      return true
    }
    return false
  }

  async function handleAuth(request, response, url) {
    const { pathname } = url
    if (pathname === '/api/auth/register') {
      throw teamError(404, ERROR_CODES.NOT_FOUND, '接口不存在')
    }
    if (pathname === '/api/runtime' && request.method === 'GET') {
      sendJson(response, 200, runtimePayload(readActor(request)))
      return true
    }
    if (pathname === '/api/auth/me' && request.method === 'GET') {
      sendJson(response, 200, runtimePayload(requireActor(request)))
      return true
    }
    if (pathname === '/api/auth/login' && request.method === 'POST') {
      const body = await readJsonBody(request)
      const result = await login(db, {
        username: body.username,
        password: body.password,
        request,
        trustProxy: false,
        sessionTtlMs: config.sessionTtlMs,
      })
      sendJson(
        response,
        200,
        {
          user: result.user,
          expiresAt: result.expiresAt,
          mode: 'team',
        },
        {
          'set-cookie': sessionCookie(result.token, {
            cookieSecure: requestProtocol(request) === 'https:',
          }),
        },
      )
      return true
    }
    if (pathname === '/api/auth/logout' && request.method === 'POST') {
      const actor = readActor(request)
      if (actor) revokeSession(db, actor.sessionId)
      sendJson(
        response,
        200,
        { ok: true },
        {
          'set-cookie': clearSessionCookie({
            cookieSecure: requestProtocol(request) === 'https:',
          }),
        },
      )
      return true
    }
    if (pathname === '/api/auth/team' && request.method === 'POST') {
      requireActor(request)
      await readJsonBody(request)
      throw teamError(410, 'ACTIVE_TEAM_REMOVED', '活动团队已移除，请使用团队筛选切换展示范围')
    }
    if (pathname === '/api/auth/password' && request.method === 'POST') {
      const actor = requireActor(request)
      const body = await readJsonBody(request)
      await changePassword(db, {
        userId: actor.userId,
        currentPassword: body.currentPassword,
        newPassword: body.newPassword,
        currentSessionId: actor.sessionId,
      })
      sendJson(response, 200, {
        ok: true,
        user: { ...actor.user, mustChangePassword: false },
      })
      return true
    }
    return false
  }

  async function handleAdmin(request, response, url) {
    const { pathname } = url
    const actor = requireActor(request)

    if (pathname === '/api/admin/users' && request.method === 'GET') {
      const scope = requireTeamAdmin(db, actor, url.searchParams.get('teamId'))
      const adminTeamIds = manageableTeamIds(actor, scope)
      const memberIds = adminTeamIds
        ? new Set(
            adminTeamIds.flatMap((teamId) =>
              listTeamMembers(db, teamId).map((member) => member.userId),
            ),
          )
        : null
      const editableTeamIds = actor.systemAdmin ? null : adminTeamIds
      sendJson(response, 200, {
        users: listUsers(db)
          .filter((user) => !memberIds || memberIds.has(user.id))
          .map((user) => {
            const teams = listUserTeams(db, user.id)
            return {
              ...user,
              teams: editableTeamIds
                ? teams.filter((team) => editableTeamIds.includes(team.id))
                : teams,
            }
          }),
      })
      return true
    }
    if (pathname === '/api/admin/users' && request.method === 'POST') {
      requireAdmin(actor)
      const body = await readJsonBody(request)
      const teams = teamAssignmentsFromBody(db, null, body)
      if (teams != null) validateTeamAssignments(db, teams)
      const user = await createUser(db, {
        username: body.username,
        displayName: body.displayName,
        password: body.password,
        teams,
        systemAdmin: Boolean(body.systemAdmin),
        mustChangePassword: false,
        createdBy: actor.userId,
      })
      appendAuditEvent(db, {
        actorUserId: actor.userId,
        action: 'user_created',
        targetType: 'user',
        targetId: user.id,
        detail: { systemAdmin: user.systemAdmin },
      })
      sendJson(response, 201, {
        user: { ...user, teams: listUserTeams(db, user.id) },
      })
      return true
    }
    const userTeamsMatch = routeMatch(pathname, /^\/api\/admin\/users\/([^/]+)\/teams$/)
    if (userTeamsMatch && request.method === 'PUT') {
      requireAdmin(actor)
      const body = await readJsonBody(request)
      const teams = setUserTeams(db, {
        userId: userTeamsMatch[0],
        teams: body.teams,
        actorUserId: actor.userId,
      })
      sendJson(response, 200, { teams })
      return true
    }
    const teamMatch = routeMatch(pathname, /^\/api\/admin\/teams\/([^/]+)$/)
    if (teamMatch && request.method === 'GET') {
      requireAdmin(actor)
      const team = readTeam(db, teamMatch[0])
      if (!team) throw teamError(404, ERROR_CODES.NOT_FOUND, '团队不存在')
      sendJson(response, 200, {
        team: { ...team, members: listTeamMembers(db, team.id) },
      })
      return true
    }
    if (teamMatch && request.method === 'PATCH') {
      requireAdmin(actor)
      const body = await readJsonBody(request)
      sendJson(response, 200, {
        team: updateTeam(db, {
          teamId: teamMatch[0],
          updates: body,
          actorUserId: actor.userId,
        }),
      })
      return true
    }
    if (pathname === '/api/admin/teams' && request.method === 'GET') {
      requireAdmin(actor)
      sendJson(response, 200, { teams: listTeamsForActor(db, actor) })
      return true
    }
    if (pathname === '/api/admin/teams' && request.method === 'POST') {
      requireAdmin(actor)
      const body = await readJsonBody(request)
      sendJson(response, 201, {
        team: createTeam(db, {
          name: body.name,
          slug: body.slug,
          actorUserId: actor.userId,
        }),
      })
      return true
    }
    const userMatch = routeMatch(pathname, /^\/api\/admin\/users\/([^/]+)$/)
    if (userMatch && request.method === 'PATCH') {
      requireAdmin(actor)
      const body = await readJsonBody(request)
      const teams = teamAssignmentsFromBody(db, userMatch[0], body)
      if (teams != null) validateTeamAssignments(db, teams)
      const user = await updateUserAdmin(db, {
        userId: userMatch[0],
        updates: body,
        actorUserId: actor.userId,
      })
      if (teams != null) {
        setUserTeams(db, {
          userId: user.id,
          teams,
          actorUserId: actor.userId,
        })
      }
      sendJson(response, 200, {
        user: { ...user, teams: listUserTeams(db, user.id) },
      })
      return true
    }
    const passwordMatch = routeMatch(pathname, /^\/api\/admin\/users\/([^/]+)\/reset-password$/)
    if (passwordMatch && request.method === 'POST') {
      requireAdmin(actor)
      const body = await readJsonBody(request)
      const user = await resetUserPassword(db, {
        userId: passwordMatch[0],
        actorUserId: actor.userId,
        password: body.password,
      })
      sendJson(response, 200, { user })
      return true
    }
    if (pathname === '/api/admin/projects' && request.method === 'GET') {
      const teamId = requireTeamAdmin(db, actor, url.searchParams.get('teamId'))
      sendJson(response, 200, {
        projects: taskSpaces.listAll(actor, { teamId }),
      })
      return true
    }
    const projectAction = routeMatch(pathname, /^\/api\/admin\/projects\/([^/]+)\/disable$/)
    if (projectAction && request.method === 'POST') {
      const [projectId] = projectAction
      sendJson(response, 200, taskSpaces.disableProject(actor, projectId))
      return true
    }
    if (pathname === '/api/admin/agents' && request.method === 'GET') {
      const teamId = requireTeamAdmin(db, actor, url.searchParams.get('teamId'))
      sendJson(response, 200, {
        agents: agentService.listDevices(actor, { teamId }),
      })
      return true
    }
    if (pathname === '/api/admin/audit' && request.method === 'GET') {
      const requestedTeamId = String(url.searchParams.get('teamId') || '').trim()
      const teamId = requireTeamAdmin(db, actor, requestedTeamId)
      const events = listAuditEvents(db, {
        teamIds: manageableTeamIds(actor, teamId),
        limit: parseInteger(url.searchParams.get('limit'), 'limit', 100),
        beforeId: parseInteger(url.searchParams.get('beforeId'), 'beforeId', null),
      })
      sendJson(response, 200, { events })
      return true
    }
    const agentMatch = routeMatch(pathname, /^\/api\/admin\/agents\/([^/]+)\/revoke$/)
    if (agentMatch && request.method === 'POST') {
      const body = await readJsonBody(request)
      const teamId = requireTeamAdmin(db, actor, body.teamId)
      sendJson(
        response,
        200,
        agentService.revokeDevice(actor, agentMatch[0], {
          teamId,
        }),
      )
      return true
    }
    return false
  }

  async function handleProjects(request, response, url) {
    const { pathname } = url
    const actor = requireActor(request)
    const membersMatch = routeMatch(pathname, /^\/api\/projects\/([^/]+)\/members$/)
    if (membersMatch && request.method === 'GET') {
      sendJson(response, 200, {
        members: taskSpaces.listVisibleMembers(actor, membersMatch[0]),
      })
      return true
    }
    if (membersMatch && request.method === 'PUT') {
      const body = await readJsonBody(request)
      sendJson(response, 200, {
        member: taskSpaces.upsertMember(actor, {
          ...body,
          projectId: membersMatch[0],
        }),
      })
      return true
    }
    if (membersMatch && request.method === 'DELETE') {
      const userId = String(url.searchParams.get('userId') || '').trim()
      sendJson(response, 200, {
        members: taskSpaces.removeMember(actor, {
          projectId: membersMatch[0],
          userId,
        }),
      })
      return true
    }
    const auditMatch = routeMatch(pathname, /^\/api\/projects\/([^/]+)\/audit$/)
    if (auditMatch && request.method === 'GET') {
      const projectId = auditMatch[0]
      const project = taskSpaces.readProject(projectId, actor)
      if (!project) throw teamError(404, ERROR_CODES.NOT_FOUND, '项目不存在')
      const events = listAuditEvents(db, {
        projectId,
        limit: parseInteger(url.searchParams.get('limit'), 'limit', 100),
        beforeId: parseInteger(url.searchParams.get('beforeId'), 'beforeId', null),
      })
      sendJson(response, 200, { events })
      return true
    }
    const agentsMatch = routeMatch(pathname, /^\/api\/projects\/([^/]+)\/agents$/)
    if (agentsMatch && request.method === 'GET') {
      const project = taskSpaces.readProject(agentsMatch[0], actor)
      if (!project) throw teamError(404, ERROR_CODES.NOT_FOUND, '项目不存在')
      sendJson(response, 200, {
        agents: db
          .prepare(`
          SELECT b.*, a.device_name, a.platform, a.last_seen_at, a.status AS agent_status,
                 s.branch_name, u.username, u.display_name,
                 active.agent_id IS NOT NULL AS current_effective
          FROM sync_agent_binding b
          JOIN sync_task_space s ON s.id = b.task_space_id
          JOIN agent_device a ON a.id = b.agent_id
          JOIN user_account u ON u.id = a.user_id
          LEFT JOIN sync_active_agent active
            ON active.user_id = a.user_id AND active.agent_id = a.id
          WHERE s.project_id = ?
          ORDER BY b.created_at DESC
        `)
          .all(agentsMatch[0])
          .map((row) => ({
            id: row.id,
            agentId: row.agent_id,
            taskSpaceId: row.task_space_id,
            branchName: row.branch_name,
            userId: row.user_id,
            username: row.username,
            displayName: row.display_name,
            deviceName: row.device_name,
            platform: row.platform,
            status: row.sync_status,
            lastSeenAt: row.last_seen_at || null,
            current: Boolean(row.current_effective),
          })),
      })
      return true
    }
    const teamAccessMatch = routeMatch(pathname, /^\/api\/projects\/([^/]+)\/team-access$/)
    if (teamAccessMatch && request.method === 'GET') {
      sendJson(response, 200, {
        teams: taskSpaces.listTeamAccess(actor, teamAccessMatch[0]),
      })
      return true
    }
    if (teamAccessMatch && request.method === 'POST') {
      const body = await readJsonBody(request)
      sendJson(
        response,
        200,
        taskSpaces.inviteTeam(actor, teamAccessMatch[0], body.teamId, body.accessRole),
      )
      return true
    }
    if (teamAccessMatch && request.method === 'DELETE') {
      sendJson(
        response,
        200,
        taskSpaces.removeTeam(actor, teamAccessMatch[0], url.searchParams.get('teamId')),
      )
      return true
    }
    return false
  }

  async function handleTasks(request, response, url) {
    const { pathname } = url
    const actor = requireActor(request)

    if (pathname === '/api/tasks/query' && request.method === 'GET') {
      const queryInput = taskQueryInput(url)
      queryInput.taskSpaceId = url.searchParams.get('taskSpaceId')
      queryInput.ifNoneMatch = String(request.headers['if-none-match'] || '')
      const page = taskSpaceIndex.queryTasks(actor, queryInput)
      if (page.notModified) {
        sendNotModified(response, page.etag)
        return true
      }
      sendJson(response, 200, pagePayload(page), { etag: page.etag })
      return true
    }
    if (pathname === '/api/board' && request.method === 'GET') {
      const input = taskQueryInput(url)
      input.taskSpaceId = url.searchParams.get('taskSpaceId')
      const page = boardService.getBoard(actor, input)
      if (String(request.headers['if-none-match'] || '') === page.etag) {
        sendNotModified(response, page.etag)
        return true
      }
      sendJson(response, 200, pagePayload(page), { etag: page.etag })
      return true
    }
    if (pathname === '/api/board/settings' && request.method === 'GET') {
      sendJson(
        response,
        200,
        boardService.readSettings(actor, {
          teamId: url.searchParams.get('teamId'),
        }),
      )
      return true
    }
    if (pathname === '/api/board/settings' && request.method === 'PUT') {
      sendJson(response, 200, boardService.updateWipLimit(actor, await readJsonBody(request)))
      return true
    }
    if (pathname === '/api/saved-views' && request.method === 'GET') {
      sendJson(response, 200, {
        views: boardService.listSavedViews(actor, {
          teamId: url.searchParams.get('teamId'),
        }),
      })
      return true
    }
    if (pathname === '/api/saved-views' && request.method === 'POST') {
      sendJson(response, 201, boardService.createSavedView(actor, await readJsonBody(request)))
      return true
    }
    if (pathname === '/api/saved-views' && request.method === 'PUT') {
      sendJson(response, 200, boardService.updateSavedView(actor, await readJsonBody(request)))
      return true
    }
    if (pathname === '/api/saved-views' && request.method === 'DELETE') {
      sendJson(response, 200, boardService.deleteSavedView(actor, await readJsonBody(request)))
      return true
    }
    if (pathname === '/api/tasks/execution' && request.method === 'PUT') {
      sendJson(response, 200, await boardService.updatePlan(actor, await readJsonBody(request)))
      return true
    }
    if (pathname === '/api/tasks/stage' && request.method === 'PUT') {
      sendJson(response, 200, await boardService.setStage(actor, await readJsonBody(request)))
      return true
    }
    if (pathname === '/api/tasks/dependencies' && request.method === 'POST') {
      sendJson(
        response,
        201,
        await boardService.createDependency(actor, await readJsonBody(request)),
      )
      return true
    }
    if (pathname === '/api/tasks/dependencies' && request.method === 'DELETE') {
      sendJson(
        response,
        200,
        await boardService.resolveDependency(actor, await readJsonBody(request)),
      )
      return true
    }
    if (pathname === '/api/tasks/undo' && request.method === 'POST') {
      sendJson(response, 200, await boardService.undo(actor, await readJsonBody(request)))
      return true
    }
    if (pathname === '/api/assignments' && request.method === 'GET') {
      const result = boardService.listAssignments(actor, {
        state: url.searchParams.get('state'),
      })
      sendJson(response, 200, {
        ...result,
        tasks: result.assignments,
        items: result.assignments,
      })
      return true
    }
    if (pathname === '/api/tasks/accept' && request.method === 'POST') {
      const body = await readJsonBody(request)
      sendJson(response, 200, boardService.accept(actor, body))
      return true
    }
    if (pathname === '/api/tasks/assign' && request.method === 'POST') {
      const body = await readJsonBody(request)
      const result = taskCommands.enqueue(actor, { ...body, commandType: 'assign_task' })
      sendJson(response, result.statusCode, result)
      return true
    }
    if (pathname === '/api/tasks' && request.method === 'POST') {
      const body = await readJsonBody(request)
      const result = taskCommands.enqueue(actor, { ...body, commandType: 'create_task' })
      sendJson(response, result.statusCode, result)
      return true
    }
    if (pathname === '/api/tasks' && request.method === 'GET') {
      sendJson(
        response,
        200,
        await boardService.getTask(actor, {
          taskSpaceId: url.searchParams.get('taskSpaceId'),
          executionTaskKey: url.searchParams.get('executionTaskKey'),
          projectId: url.searchParams.get('projectId'),
          taskPath: url.searchParams.get('taskPath'),
        }),
      )
      return true
    }
    if (pathname === '/api/task' && request.method === 'POST') {
      sendJson(response, 200, await boardService.getTask(actor, await readJsonBody(request)))
      return true
    }
    const taskMatch = routeMatch(pathname, /^\/api\/tasks\/([^/]+)$/)
    if (taskMatch && request.method === 'GET') {
      sendJson(
        response,
        200,
        await boardService.getTask(actor, {
          taskSpaceId: url.searchParams.get('taskSpaceId'),
          executionTaskKey: taskMatch[0],
        }),
      )
      return true
    }
    const assigneeMatch = routeMatch(pathname, /^\/api\/task-spaces\/([^/]+)\/assignees$/)
    if (assigneeMatch && request.method === 'GET') {
      sendJson(response, 200, {
        assignees: boardService.assigneeCandidates(actor, assigneeMatch[0]),
      })
      return true
    }
    const listenersMatch = routeMatch(pathname, /^\/api\/task-spaces\/([^/]+)\/listeners$/)
    if (listenersMatch && request.method === 'GET') {
      sendJson(response, 200, taskSpaces.listenerDetails(actor, listenersMatch[0]))
      return true
    }
    if (pathname === '/api/task-operations' && request.method === 'GET') {
      sendJson(
        response,
        200,
        taskCommands.list(actor, {
          taskSpaceId: url.searchParams.get('taskSpaceId'),
        }),
      )
      return true
    }
    const operationMatch = routeMatch(pathname, /^\/api\/task-operations\/([^/]+)$/)
    if (operationMatch && request.method === 'GET') {
      sendJson(response, 200, taskCommands.get(actor, operationMatch[0]))
      return true
    }
    const retryMatch = routeMatch(pathname, /^\/api\/task-operations\/([^/]+)\/retry$/)
    if (retryMatch && request.method === 'POST') {
      await readJsonBody(request)
      sendJson(response, 200, taskCommands.retry(actor, retryMatch[0]))
      return true
    }
    const cancelMatch = routeMatch(pathname, /^\/api\/task-operations\/([^/]+)\/cancel$/)
    if (cancelMatch && request.method === 'POST') {
      await readJsonBody(request)
      sendJson(response, 200, taskCommands.cancel(actor, cancelMatch[0]))
      return true
    }
    return false
  }

  async function handleTeam(request, response, url) {
    const { pathname } = url
    const actor = requireActor(request)
    if (pathname === '/api/board/events' && request.method === 'GET') {
      const token = parseCookieHeader(request.headers.cookie).get(SESSION_COOKIE)
      const opened = boardEvents.open({
        response,
        authorize: () => {
          const session = readSession(db, token)
          return Boolean(session && session.sessionId === actor.sessionId)
        },
      })
      if (!opened) {
        throw teamError(401, ERROR_CODES.AUTH_REQUIRED, '会话已失效')
      }
      return true
    }
    if (pathname === '/api/team/projects' && request.method === 'GET') {
      sendJson(response, 200, {
        projects: taskSpaces.listReadable(actor, {
          teamId: url.searchParams.get('teamId'),
        }),
      })
      return true
    }
    if (
      (pathname === '/api/team/status' || pathname === '/api/status') &&
      request.method === 'GET'
    ) {
      const status = boardService.status(actor, { staleMs: config.agentStaleMs || 60_000 })
      const etag = statusEtag(status)
      if (String(request.headers['if-none-match'] || '') === etag) {
        sendNotModified(response, etag)
        return true
      }
      sendJson(response, 200, status, { etag })
      return true
    }
    if (pathname === '/api/teams' && request.method === 'GET') {
      sendJson(response, 200, {
        teams: listTeamsForActor(db, actor, { activeOnly: true }),
        activeTeamId: null,
      })
      return true
    }
    if (pathname === '/api/team/pairing-codes' && request.method === 'POST') {
      const body = await readJsonBody(request)
      sendJson(response, 201, agentService.createPairingCode(actor, body))
      return true
    }
    return false
  }

  async function handleDesktop(request, response, url, actor) {
    if (url.pathname !== '/api/desktop/enroll-tokens') return false
    if (request.method !== 'POST') return false
    const body = await readJsonBody(request)
    sendJson(response, 201, desktopAuth.issue(actor, body))
    return true
  }

  async function dispatch(request, response) {
    response.setHeader('x-request-id', crypto.randomUUID())
    assertHost(request)
    if (isClosing()) {
      throw teamError(503, ERROR_CODES.SERVICE_SHUTTING_DOWN, '服务正在关闭')
    }
    const url = new URL(request.url || '/', requestHostOrigin(request))
    const isAgent = url.pathname === '/api/agent/enroll' || url.pathname.startsWith('/api/agent/')
    if (isAgent) {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        const contentType = String(request.headers['content-type'] || '').toLowerCase()
        if (!/^application\/json\s*(?:;|$)/.test(contentType)) {
          throw teamError(415, ERROR_CODES.JSON_REQUIRED, 'Agent 写请求必须使用 application/json')
        }
      }
      if (await handleAgent(request, response, url)) return
      throw teamError(404, ERROR_CODES.NOT_FOUND, 'Agent 接口不存在')
    }

    if (url.pathname === '/api/health') {
      sendJson(response, 200, {
        status: 'ok',
        mode: 'team',
        processId: process.pid,
        serverStartedAt: serverStartedAt,
      })
      return
    }
    if (!url.pathname.startsWith('/api/')) {
      serveStatic(request, response, url, publicDir)
      return
    }
    if (url.pathname === '/api/auth/register') {
      throw teamError(404, ERROR_CODES.NOT_FOUND, '接口不存在')
    }
    if (WRITE_METHODS.has(request.method)) assertJsonWrite(request)
    if (await handleAuth(request, response, url)) return
    if (await handleWorkspaceTemplate(request, response, url)) return

    const actor = requireActor(request)
    if (
      actor.user.mustChangePassword &&
      !new Set(['/api/auth/password', '/api/auth/logout']).has(url.pathname)
    ) {
      throw teamError(
        403,
        ERROR_CODES.PASSWORD_CHANGE_REQUIRED,
        '首次登录或密码重置后必须先修改密码',
      )
    }
    // v1 只支持 standalone：team 模式不加载插件，管理端点保持可探测但为空。
    if (url.pathname === '/api/plugins' || url.pathname.startsWith('/api/plugins/')) {
      if (request.method === 'GET' && url.pathname === '/api/plugins') {
        sendJson(response, 200, { disabled: true, plugins: [], mode: 'team' })
        return
      }
      throw teamError(404, ERROR_CODES.NOT_FOUND, 'team 模式不加载插件')
    }
    if (await handleAdmin(request, response, url)) return
    if (await handleDesktop(request, response, url, actor)) return
    if (await handleProjects(request, response, url)) return
    if (await handleTeam(request, response, url)) return
    if (await handleTasks(request, response, url)) return
    throw teamError(404, ERROR_CODES.NOT_FOUND, '接口不存在')
  }

  let serverStartedAt = null
  return {
    async handle(request, response) {
      try {
        await dispatch(request, response)
      } catch (error) {
        const mapped = errorPayload(error)
        if (mapped.status >= 500) {
          logger.error('团队 HTTP 请求失败', {
            requestId: response.getHeader('x-request-id'),
            method: request.method,
            url: request.url,
            error: error instanceof Error ? error.message : String(error),
          })
        }
        sendJson(response, mapped.status, mapped.body)
      }
    },
    setStartedAt(value) {
      serverStartedAt = value
    },
  }
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen({ port, host, backlog: 1024 })
  })
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve()
      return
    }
    server.close(() => resolve())
    const timer = setTimeout(() => server.closeAllConnections?.(), 5_000)
    timer.unref?.()
  })
}

export function createRefreshScheduler({
  concurrency = DEFAULT_REFRESH_CONCURRENCY,
  refresh,
  logger = console,
}) {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new TypeError('refresh concurrency 必须是正整数')
  }
  if (typeof refresh !== 'function') {
    throw new TypeError('refresh 必须是函数')
  }
  const pending = new Map()
  const inFlight = new Map()
  let stopped = false

  function drain() {
    while (!stopped && inFlight.size < concurrency && pending.size) {
      const [projectId] = pending.keys()
      pending.delete(projectId)
      const operation = Promise.resolve()
        .then(() => refresh(projectId))
        .catch((error) => {
          const diagnostic = diagnosticError(error)
          logger.warn('团队项目定时拉取失败', {
            projectId,
            ...diagnostic,
            error: diagnostic.message,
          })
        })
        .finally(() => {
          inFlight.delete(projectId)
          drain()
        })
      inFlight.set(projectId, operation)
    }
  }

  return {
    enqueue(projectId) {
      if (stopped || pending.has(projectId) || inFlight.has(projectId)) {
        return false
      }
      pending.set(projectId, true)
      drain()
      return true
    },
    snapshot() {
      return {
        active: inFlight.size,
        queued: pending.size,
        projectIds: [...inFlight.keys()],
      }
    },
    async stop() {
      if (stopped) return
      stopped = true
      pending.clear()
      await Promise.allSettled([...inFlight.values()])
    },
  }
}

export async function createTeamRuntime({
  config,
  databaseFile = defaultDatabaseFile,
  dataDir = defaultDataDir,
  publicDir = defaultPublicDir,
  logger = console,
  requireAdmin = true,
  enablePolling = true,
  refreshConcurrency = DEFAULT_REFRESH_CONCURRENCY,
  scheduledRefresh = null,
  trellisRunner = undefined,
  desktopAuth = {},
  boardEventOptions = {},
}) {
  if (config?.mode !== 'team') {
    throw new Error('createTeamRuntime 只接受 team 配置')
  }
  const db = openDatabase({
    databaseFile,
    fallbackRepositories: [],
    importLegacyRepositories: false,
    legacyJsonImport: false,
    logger,
  })
  const taskSnapshotBackups = createTaskSnapshotBackupService({
    db,
    databaseFile,
    logger,
  })
  let closing = false
  const shutdown = new AbortController()

  try {
    if (requireAdmin && !hasActiveAdmin(db)) {
      throw teamError(
        503,
        ERROR_CODES.AUTH_REQUIRED,
        '团队模式尚无系统管理员，请先在本机运行 server/team/cli.js init-admin',
      )
    }
    const boardEvents = createBoardEventService(boardEventOptions)
    let taskCommands = null
    const commandsProxy = {
      available: (agentId) => taskCommands.available(agentId),
      markDelivered: (agentId, commandId) => taskCommands.markDelivered(agentId, commandId),
      staleLeases: (agentId) => taskCommands.staleLeases(agentId),
    }
    const agentEvents = createAgentEventStream({
      db,
      commands: commandsProxy,
      logger,
    })
    const agentService = createSyncAgentService({
      db,
      config,
      events: agentEvents,
    })
    const taskSpaces = createTaskSpaceService({
      db,
      config,
    })
    taskCommands = createTaskCommandService({
      db,
      taskSpaces,
      agents: agentService,
      events: agentEvents,
    })
    const taskSpaceIndex = createTaskSpaceIndex({
      db,
      stageIds: STAGE_IDS,
      taskSpaces,
      executionWipLimit: EXECUTION_WIP_LIMIT,
      onQueryRevisionChanged: (revision) => boardEvents.publish({ revision }),
      onProjected: ({ taskSpaceId, revision }) => {
        boardEvents.publish({ revision })
        agentEvents.notifyTaskSpaceChanged(taskSpaceId, revision)
      },
      logger,
    })
    const taskSnapshots = createTaskSnapshotService({
      db,
      taskSpaces,
      onRevisionCommitted: ({ taskSpaceId }) => {
        void taskSpaceIndex.enqueue(taskSpaceId)
      },
    })
    const desktopAuthService = createDesktopAuthService({ db, ...desktopAuth })
    const boardService = createGitlessBoardService({
      db,
      taskSpaces,
      taskSpaceIndex,
      agents: agentService,
      executionWipLimit: EXECUTION_WIP_LIMIT,
    })
    const requestHandler = createRequestHandler({
      config,
      db,
      boardService,
      taskSpaces,
      taskSnapshots,
      taskSpaceIndex,
      taskCommands,
      agentService,
      agentEvents,
      boardEvents,
      desktopAuth: desktopAuthService,
      publicDir,
      logger,
      isClosing: () => closing,
    })
    const server = http.createServer((request, response) => {
      requestHandler.handle(request, response)
    })
    // 长轮询和 3 秒轮询之间允许连接复用，避免 Windows 客户端复用已过期套接字。
    server.keepAliveTimeout = 65_000
    server.headersTimeout = 66_000
    server.on('connection', (socket) => socket.setNoDelay(true))
    server.on('clientError', (error, socket) => {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
      logger.warn('团队 HTTP 客户端连接错误', { error: error.message })
    })
    let started = false

    async function start() {
      if (started) return runtime
      try {
        await listen(server, config.port ?? 4317, config.bindHost || '0.0.0.0')
        started = true
        const address = server.address()
        const port = address && typeof address === 'object' ? address.port : config.port
        taskSnapshotBackups.start()
        requestHandler.setStartedAt(new Date().toISOString())
        logger.warn('team 模式不加载插件', {
          reason: 'v1 只支持 standalone；插件路由返回空列表',
          url: `http://${config.bindHost || '0.0.0.0'}:${port}`,
        })
        logger.info('Trellis Team Board 已启动', {
          url: `http://${config.bindHost || '0.0.0.0'}:${port}`,
          bindHost: config.bindHost || '0.0.0.0',
          port,
        })
        return runtime
      } catch (error) {
        closing = true
        shutdown.abort()
        boardEvents.close()
        agentEvents.close()
        taskSnapshotBackups.stop()
        await closeServer(server)
        await taskSpaceIndex.close().catch(() => {})
        db.close()
        throw error
      }
    }

    async function stop() {
      if (closing) return
      closing = true
      shutdown.abort()
      boardEvents.close()
      agentEvents.close()
      taskSnapshotBackups.stop()
      await closeServer(server)
      await taskSpaceIndex.close()
      db.close()
    }

    const runtime = {
      mode: 'team',
      config,
      db,
      server,
      services: {
        taskSpaces,
        taskSnapshots,
        taskSpaceIndex,
        taskCommands,
        agentService,
        agentEvents,
        boardEvents,
        boardService,
        taskSnapshotBackups,
      },
      start,
      stop,
      address() {
        return server.address()
      },
    }
    return runtime
  } catch (error) {
    db.close()
    throw error
  }
}

export { MAX_JSON_BYTES, MAX_LIVE_BATCH_BYTES, readJsonBody }
