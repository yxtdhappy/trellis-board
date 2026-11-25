import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  readJsonBody as readJsonBodyCommon,
  securityHeaders,
  sendJson as sendJsonCommon,
  serveStatic as serveStaticCommon,
} from '../../http-common.js'
import { DEFAULT_APP_NAME, normalizeAppName } from '../../config.js'
import { ERROR_CODES, teamError } from '../errors.js'
import { CAPABILITIES, roleCanWrite } from '../permissions.js'
import { TEAM_ROLES, listUserTeams, resolveTeamScope } from '../teams.js'
import { TASK_SNAPSHOT_MAX_TRANSPORT_BYTES } from '@trellis-board/shared/task-snapshot.js'

const httpDir = path.dirname(fileURLToPath(import.meta.url))
const serverDir = path.resolve(httpDir, '..')
export const appRoot = path.resolve(serverDir, '../../..')

export function readHostVersion() {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'))
    return String(manifest.version || '0.0.0')
  } catch {
    return '0.0.0'
  }
}

export const defaultPublicDir = path.resolve(serverDir, '../public')

export const MAX_JSON_BYTES = 64 * 1024

export const MAX_LIVE_BATCH_BYTES = TASK_SNAPSHOT_MAX_TRANSPORT_BYTES

export const MAX_OWNERSHIP_INBOX_BYTES = 512 * 1024

export const MAX_ARCHIVE_CREDENTIAL_BYTES = 160 * 1024

export const EXECUTION_WIP_LIMIT = 2

/**
 * Team 服务端不承载插件：插件只由客户端本机宿主负责。
 * 保留函数签名与 `features.pluginsEnabled` 字段，避免旧前端读取时崩溃。
 */
export function teamPluginsEnabled() {
  return false
}

export function requireObservedBranchName(body) {
  const value = body?.observedBranchName
  if (typeof value !== 'string' || !value.trim()) {
    throw teamError(400, 'BRANCH_OBSERVATION_REQUIRED', '任务快照写入必须上报本地真实 Git 分支')
  }
}

export function sendJson(response, status, payload, headers = {}) {
  sendJsonCommon(response, status, payload, { headers, gzip: true, security: true })
}

export function sendNotModified(response, etag) {
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

export function etagMatches(headerValue, etag) {
  const value = String(headerValue || '').trim()
  if (!value || !etag) return false
  const strip = (tag) => tag.trim().replace(/^W\//i, '')
  const expected = strip(etag)
  return value.split(',').some((item) => strip(item) === expected)
}

export function clientIp(request, trustProxy) {
  if (trustProxy) {
    const forwarded = String(request.headers['x-forwarded-for'] || '')
      .split(',')[0]
      .trim()
    if (forwarded && forwarded.length <= 128) return forwarded
  }
  return String(request.socket.remoteAddress || '').slice(0, 128)
}

export function requestOrigin(request) {
  return String(request.headers.origin || '')
}

export function requestProtocol(request) {
  if (request.socket?.encrypted) return 'https:'
  const forwarded = String(request.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase()
  return forwarded === 'https' ? 'https:' : 'http:'
}

export function hasSingleHostHeader(request) {
  if (!Array.isArray(request.rawHeaders)) return Boolean(request.headers.host)
  let count = 0
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (String(request.rawHeaders[index]).toLowerCase() === 'host') count += 1
  }
  return count === 1
}

export function requestHostOrigin(request) {
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

export function assertHost(request) {
  if (!requestHostOrigin(request)) {
    throw teamError(400, ERROR_CODES.INVALID_HOST, '请求 Host 无效')
  }
}

export function assertJsonWrite(request) {
  // DELETE 常常不带 body（例如退出登录），此时没有 content-type 是合法的；
  // 只有真的带了 body 才要求 JSON。
  const hasBody =
    Number(request.headers['content-length'] || 0) > 0 ||
    Boolean(request.headers['transfer-encoding'])
  const requiresJson = request.method !== 'DELETE' || hasBody
  const contentType = String(request.headers['content-type'] || '').toLowerCase()
  if (requiresJson && !/^application\/json\s*(?:;|$)/.test(contentType)) {
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

export function readJsonBody(request, maxBytes = MAX_JSON_BYTES) {
  return readJsonBodyCommon(request, {
    maxBytes,
    errors: {
      tooLarge: (limit) =>
        teamError(
          413,
          ERROR_CODES.BODY_TOO_LARGE,
          `请求体超过 ${Math.floor(limit / 1024)} KiB 限制`,
        ),
      invalidJson: () => teamError(400, ERROR_CODES.INVALID_INPUT, '请求体不是合法 JSON'),
      notObject: () => teamError(400, ERROR_CODES.INVALID_INPUT, '请求体必须是 JSON 对象'),
    },
  })
}

export function parseInteger(value, label, fallback = null) {
  if (value == null || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed)) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, `${label} 必须是整数`)
  }
  return parsed
}

export function queryList(searchParams, name) {
  return searchParams
    .getAll(name)
    .flatMap((item) => String(item).split(','))
    .map((item) => item.trim())
    .filter(Boolean)
}

export function queryScalar(searchParams, name) {
  const value = searchParams.get(name)
  return value == null ? undefined : value
}

export function taskQueryInput(url) {
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

export function pagePayload(page) {
  return {
    ...page,
    total_count: page.total,
    next_cursor: page.nextCursor,
    query_revision: page.queryRevision,
    query_day: page.queryDay,
  }
}

export function statusEtag(status) {
  const version = JSON.stringify({
    queryRevision: status.queryRevision,
    archiveRevision: status.archiveRevision,
    queryDay: status.queryDay,
    assignments: status.assignments,
    projects: status.projects.map(({ agents: _agents, ...project }) => project),
    associationProjects: status.associationProjects || [],
  })
  return `"status-${crypto.createHash('sha256').update(version).digest('base64url').slice(0, 24)}"`
}

export function projectCapabilities(role, { systemAdmin = false, teamAdmin = false } = {}) {
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

export function requireAdmin(actor) {
  if (!actor?.systemAdmin) {
    throw teamError(403, ERROR_CODES.FORBIDDEN, '只有系统管理员可以执行该操作')
  }
}

export function archiveContentDisposition(name) {
  const value = String(name || 'archive-file')
  const fallback = value.replace(/[^\x20-\x7e]|["\\\r\n]/g, '_') || 'archive-file'
  const encoded = encodeURIComponent(value).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  )
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`
}

export function archiveContentType(value) {
  const contentType = String(value || '')
  return /^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+(?:; charset=utf-8)?$/.test(contentType)
    ? contentType
    : 'application/octet-stream'
}

export function requireTeamAdmin(db, actor, teamId = null) {
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

export function manageableTeamIds(actor, teamId = null) {
  if (actor?.systemAdmin) return teamId ? [teamId] : null
  if (teamId) return [teamId]
  return (actor?.teams || [])
    .filter((team) => team.role === TEAM_ROLES.ADMIN)
    .map((team) => team.id)
}

export function teamAssignmentsFromBody(db, userId, body) {
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

export const pluginUiDir = path.join(serverDir, '..', 'plugin-ui')

export function servePluginUi(request, response, url) {
  serveStaticCommon({
    request,
    response,
    pathname: url.pathname.slice('/plugin-ui'.length) || '/',
    publicDir: pluginUiDir,
    security: true,
    cacheControl: () => 'no-store',
    invalidPath: () => sendJson(response, 400, { error: '静态资源路径无效' }),
    methodNotAllowed: () =>
      sendJson(response, 405, { error: '静态资源只支持 GET 或 HEAD' }, { allow: 'GET, HEAD' }),
    forbidden: () => sendJson(response, 403, { error: '静态资源路径越界' }),
    notFound: () => sendJson(response, 404, { error: '静态资源不存在' }),
  })
}

function escapeHtml(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (char) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[char],
  )
}

function unescapeBasicHtml(value) {
  return String(value ?? '')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function injectOrReplaceHeadMeta(html, name, escapedContent) {
  const existingPattern = new RegExp(`<meta\\b[^>]*name=(["'])${escapeRegExp(name)}\\1[^>]*>`, 'i')
  const metaTag = `<meta name="${name}" content="${escapedContent}" />`
  if (existingPattern.test(html)) {
    return html.replace(existingPattern, () => metaTag)
  }
  if (/<\/head>/i.test(html)) {
    return html.replace(/<\/head>/i, () => `  ${metaTag}\n  </head>`)
  }
  return `${metaTag}\n${html}`
}

export function rewriteHtmlForBasePath(html, basePath) {
  if (!basePath) return html
  let rewritten = String(html).replace(
    /\b(href|src)=(["'])(?:\.\/|\/(?=(?:assets\/|favicon\.svg\b|theme-init\.js\b)))/g,
    `$1=$2${basePath}/`,
  )
  if (!/name=(["'])trellis-base-path\1/i.test(rewritten)) {
    const meta = `<meta name="trellis-base-path" content="${basePath}" />`
    if (/<\/head>/i.test(rewritten)) {
      rewritten = rewritten.replace(/<\/head>/i, `  ${meta}\n  </head>`)
    } else {
      rewritten = `${meta}\n${rewritten}`
    }
  }
  return rewritten
}

export function rewriteHtmlForAppName(html, appName = DEFAULT_APP_NAME) {
  const resolvedName = normalizeAppName(appName)
  const escapedName = escapeHtml(resolvedName)
  let rewritten = String(html)

  const existingMetaMatch = /<meta\b[^>]*name=(["'])trellis-app-name\1[^>]*>/i.exec(rewritten)
  const previousContentMatch = existingMetaMatch
    ? /\bcontent=(["'])([\s\S]*?)\1/i.exec(existingMetaMatch[0])
    : null
  const previousName = previousContentMatch ? unescapeBasicHtml(previousContentMatch[2]).trim() : ''

  const candidates = Array.from(
    new Set(
      [previousName, previousName ? escapeHtml(previousName) : '', '{{APP_NAME}}'].filter(Boolean),
    ),
  ).sort((left, right) => right.length - left.length)
  const brandPattern = new RegExp(candidates.map(escapeRegExp).join('|'), 'g')
  const replaceBrand = (segment) => segment.replace(brandPattern, () => escapedName)

  rewritten = rewritten.replace(
    /(<title\b[^>]*>)([\s\S]*?)(<\/title>)/i,
    (_, open, content, close) => `${open}${replaceBrand(content)}${close}`,
  )
  rewritten = rewritten.replace(/<meta\b[^>]*name=(["'])description\1[^>]*>/i, (tag) =>
    tag.replace(
      /(\bcontent=(["']))([\s\S]*?)(\2)/i,
      (_, prefix, quote, content, suffix) => `${prefix}${replaceBrand(content)}${suffix}`,
    ),
  )
  rewritten = rewritten.replace(
    /(<h1\b[^>]*\bid=(["'])opening\2[^>]*>)([\s\S]*?)(<\/h1>)/i,
    (_, open, _quote, content, close) => `${open}${replaceBrand(content)}${close}`,
  )
  rewritten = rewritten.replace(
    /(<p\b[^>]*\bid=(["'])hint\2[^>]*>)([\s\S]*?)(<\/p>)/i,
    (_, open, _quote, content, close) => `${open}${replaceBrand(content)}${close}`,
  )
  return injectOrReplaceHeadMeta(rewritten, 'trellis-app-name', escapedName)
}

export function rewriteHtmlForRuntime(html, { basePath = '', appName = DEFAULT_APP_NAME } = {}) {
  const withBase = rewriteHtmlForBasePath(html, basePath)
  return rewriteHtmlForAppName(withBase, appName)
}

export function serveStatic(
  request,
  response,
  url,
  publicDir,
  { basePath = '', appName = DEFAULT_APP_NAME } = {},
) {
  serveStaticCommon({
    request,
    response,
    pathname: url.pathname,
    publicDir,
    security: true,
    cacheControl: () => 'no-store',
    transformHtml: (html) => rewriteHtmlForRuntime(html, { basePath, appName }),
    invalidPath: () =>
      sendJson(response, 400, {
        error: '静态资源路径无效',
        code: ERROR_CODES.INVALID_INPUT,
      }),
    methodNotAllowed: () =>
      sendJson(
        response,
        405,
        { error: '静态资源只支持 GET 或 HEAD', code: ERROR_CODES.INVALID_INPUT },
        { allow: 'GET, HEAD' },
      ),
    forbidden: () =>
      sendJson(response, 403, {
        error: '静态资源路径越界',
        code: ERROR_CODES.FORBIDDEN,
      }),
    notFound: () =>
      sendJson(response, 404, {
        error: '静态资源不存在',
        code: ERROR_CODES.NOT_FOUND,
      }),
  })
}

export function runtimeProject(project, actor) {
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

export function routeMatch(pathname, pattern) {
  const match = pattern.exec(pathname)
  if (!match) return null
  try {
    return match.slice(1).map((item) => (item == null ? undefined : decodeURIComponent(item)))
  } catch {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, '请求路径编码无效')
  }
}

export function assertValidQueryEncoding(search) {
  try {
    decodeURIComponent(search)
  } catch {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, 'URL 查询编码无效')
  }
}
