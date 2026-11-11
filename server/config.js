import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const serverDir = path.dirname(fileURLToPath(import.meta.url))
export const appDir = path.resolve(serverDir, '..')
export const legacyDataDir = path.join(appDir, 'data')

export function resolveBoardDataDir({
  platform = process.platform,
  env = process.env,
  homeDir = os.homedir(),
} = {}) {
  const platformPath = platform === 'win32' ? path.win32 : path.posix
  const override = String(env.TRELLIS_BOARD_DATA_DIR || '').trim()
  if (override) return platformPath.resolve(override)
  if (platform === 'win32') {
    const base =
      String(env.LOCALAPPDATA || '').trim() || platformPath.join(homeDir, 'AppData', 'Local')
    return platformPath.join(base, 'TrellisBoard', 'server')
  }
  if (platform === 'darwin') {
    return platformPath.join(homeDir, 'Library', 'Application Support', 'TrellisBoard', 'server')
  }
  const base =
    String(env.XDG_DATA_HOME || '').trim() || platformPath.join(homeDir, '.local', 'share')
  return platformPath.join(base, 'TrellisBoard', 'server')
}

export const dataDir = resolveBoardDataDir()
export const databaseFile = path.join(dataDir, 'board.sqlite')
export const metadataFile = path.join(dataDir, 'task-metadata.json')
export const scanCacheFile = path.join(dataDir, 'scan-cache.json')
export const stateFile = path.join(dataDir, 'board-state.json')
export const repositoriesFile = path.join(dataDir, 'repos.json')

export function normalizeRepositoryEntry(repo) {
  const rawPath = String(repo?.path || '').trim()
  if (!rawPath) throw new Error('仓库配置中存在缺少 path 的项目')
  const repoPath = path.resolve(rawPath)
  const basename = path.basename(repoPath)
  return {
    id: String(repo.id || basename).trim() || basename,
    name: String(repo.name || basename).trim() || basename,
    path: repoPath.replaceAll('\\', '/'),
  }
}

export function repositoryPathKey(repoPath) {
  const resolved = path.resolve(repoPath).replaceAll('\\', '/')
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function integerSetting(env, name, fallback, minimum, maximum) {
  const raw = env[name]
  if (raw == null || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} 必须是 ${minimum} 到 ${maximum} 的整数`)
  }
  return value
}

function booleanSetting(env, name, fallback) {
  const raw = env[name]
  if (raw == null || raw === '') return fallback
  if (raw === 'true' || raw === '1') return true
  if (raw === 'false' || raw === '0') return false
  throw new Error(`${name} 只能是 true 或 false`)
}

function isLoopbackHost(hostname) {
  const host = hostname.toLowerCase()
  return (
    host === 'localhost' || host === '::1' || host === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(host)
  )
}

export function parseTeamConfig(env = process.env) {
  const mode = String(env.TRELLIS_BOARD_MODE || 'standalone')
    .trim()
    .toLowerCase()
  if (!new Set(['standalone', 'team']).has(mode)) {
    throw new Error('TRELLIS_BOARD_MODE 只能是 standalone 或 team')
  }
  if (mode === 'standalone') {
    return {
      mode,
      port: integerSetting(env, 'PORT', 4317, 1, 65535),
      bindHost: String(env.TRELLIS_BOARD_BIND_HOST || '0.0.0.0').trim() || '0.0.0.0',
    }
  }

  const publicUrlValue = String(env.TRELLIS_TEAM_PUBLIC_URL || '').trim()
  if (!publicUrlValue) throw new Error('团队模式必须配置 TRELLIS_TEAM_PUBLIC_URL')
  let publicUrl
  try {
    publicUrl = new URL(publicUrlValue)
  } catch {
    throw new Error('TRELLIS_TEAM_PUBLIC_URL 不是合法 URL')
  }
  if (!new Set(['http:', 'https:']).has(publicUrl.protocol)) {
    throw new Error('TRELLIS_TEAM_PUBLIC_URL 只支持 HTTP 或 HTTPS')
  }
  if (
    publicUrl.username ||
    publicUrl.password ||
    publicUrl.search ||
    publicUrl.hash ||
    publicUrl.pathname !== '/'
  ) {
    throw new Error('TRELLIS_TEAM_PUBLIC_URL 不能包含 userinfo、query、hash 或根路径以外的路径')
  }
  if (!isLoopbackHost(publicUrl.hostname) && publicUrl.protocol !== 'https:') {
    throw new Error('非回环团队地址必须使用 HTTPS')
  }
  const cookieSecure = booleanSetting(
    env,
    'TRELLIS_TEAM_COOKIE_SECURE',
    publicUrl.protocol === 'https:',
  )
  if (!isLoopbackHost(publicUrl.hostname) && !cookieSecure) {
    throw new Error('非回环团队地址必须启用安全 Cookie')
  }
  return {
    mode,
    bindHost: String(env.TRELLIS_TEAM_BIND_HOST || '0.0.0.0').trim() || '0.0.0.0',
    port: integerSetting(env, 'TRELLIS_TEAM_PORT', 4317, 1, 65535),
    publicUrl,
    publicOrigin: publicUrl.origin,
    sessionTtlMs: integerSetting(
      env,
      'TRELLIS_TEAM_SESSION_TTL_MS',
      12 * 60 * 60 * 1000,
      60_000,
      30 * 24 * 60 * 60 * 1000,
    ),
    agentStaleMs: integerSetting(
      env,
      'TRELLIS_TEAM_AGENT_STALE_MS',
      60_000,
      5_000,
      24 * 60 * 60 * 1000,
    ),
    cookieSecure,
    trustProxy: booleanSetting(env, 'TRELLIS_TEAM_TRUST_PROXY', false),
    allowLocalGitRemotes: booleanSetting(env, 'TRELLIS_TEAM_ALLOW_LOCAL_GIT_REMOTES', false),
  }
}
