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

export function parseTeamConfig(env = process.env) {
  const mode = String(env.TRELLIS_BOARD_MODE || 'standalone')
    .trim()
    .toLowerCase()
  if (!new Set(['standalone', 'team']).has(mode)) {
    throw new Error('TRELLIS_BOARD_MODE 只能是 standalone 或 team')
  }
  const port = integerSetting(env, 'PORT', 4317, 1, 65535)
  const allowLocalGitRemotes = booleanSetting(
    env,
    'TRELLIS_BOARD_ALLOW_LOCAL_GIT_REMOTES',
    mode === 'standalone',
  )
  if (mode === 'standalone') {
    return {
      mode,
      port,
      bindHost: '0.0.0.0',
      allowLocalGitRemotes,
    }
  }

  return {
    mode,
    bindHost: '0.0.0.0',
    port,
    sessionTtlMs: 12 * 60 * 60 * 1000,
    agentStaleMs: 60_000,
    trustProxy: false,
    allowLocalGitRemotes,
  }
}
