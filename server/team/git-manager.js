import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  TRELLIS_AGENT_TOOLS,
  detectTrellisAgentTools,
  getTrellisAgentTool,
} from '../../shared/trellis-agent-tools.js'
import { ERROR_CODES, teamError } from './errors.js'
import {
  minimalEnvironment,
  runProcess,
  sanitizeProcessOutput,
  trellisEnvironment,
} from './process.js'
import { semanticLocalPathIdentityHash, semanticRemoteIdentityHash } from './remote-identity.js'

const RESERVED_BRANCHES = new Set(['HEAD', 'FETCH_HEAD', 'ORIG_HEAD', 'MERGE_HEAD', '@'])
const SSH_COMMAND = 'ssh -o BatchMode=yes -o StrictHostKeyChecking=yes'
const LOCAL_TIMEOUT = 60_000
const REMOTE_TIMEOUT = 210_000
const PUSH_TIMEOUT = 150_000
const PROBE_TIMEOUT = 60_000
const PROBE_OUTPUT_LIMIT = 1024 * 1024
const SSH_SCAN_OUTPUT_LIMIT = 256 * 1024
const MAX_SAFE_REBASES = 3
const PROBE_WINDOW_MS = 60_000
const PROBE_LIMIT_PER_WINDOW = 5
const PROBE_GLOBAL_CONCURRENCY = 4
const SSH_TRUST_TTL_MS = 5 * 60_000
const TRELLIS_INIT_TIMEOUT = 210_000
const TRELLIS_PUSH_RETRIES = 1
const AGENT_PRESENCE_PATHS = Object.freeze([
  ...new Set(TRELLIS_AGENT_TOOLS.flatMap((tool) => tool.presencePaths)),
])
const REMOTE_TREE_PATHS = Object.freeze([
  ...AGENT_PRESENCE_PATHS,
  '.trellis',
  'AGENTS.md',
  '.gitattributes',
])
const INITIALIZATION_CONTEXT_PATHS = Object.freeze([...AGENT_PRESENCE_PATHS, '.agents/skills'])
const INCREMENTAL_TRELLIS_METADATA = new Set([
  '.trellis/.template-hashes.json',
  '.trellis/.version',
])
const PROXY_ENV_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
]
const serverDir = path.dirname(fileURLToPath(import.meta.url))
const ASKPASS_HELPER = path.join(serverDir, 'git-askpass.js')
const DEFAULT_TRELLIS_CLI = path.join(
  path.resolve(serverDir, '..', '..'),
  'node_modules',
  '@mindfoldhq',
  'trellis',
  'bin',
  'trellis.js',
)

export function gitEnvironment(extra = {}) {
  const proxyEnvironment = {}
  for (const key of PROXY_ENV_KEYS) {
    if (process.env[key]) proxyEnvironment[key] = process.env[key]
  }
  return minimalEnvironment({
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'Never',
    GIT_SSH_COMMAND: SSH_COMMAND,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    PYTHONUTF8: '1',
    ...extra,
    ...proxyEnvironment,
  })
}

function isLoopback(hostname) {
  const host = String(hostname || '').toLowerCase()
  return (
    host === 'localhost' || host === '::1' || host === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(host)
  )
}

export function validateSyncBranch(branch) {
  const value = String(branch || '').trim()
  if (
    !value ||
    value.length > 200 ||
    value.startsWith('-') ||
    value.startsWith('refs/') ||
    value.includes('\0') ||
    value.includes(' ') ||
    /[\r\n\t]/.test(value) ||
    RESERVED_BRANCHES.has(value) ||
    /@\{-\d+\}/.test(value)
  ) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, '同步分支名无效')
  }
  return value
}

export function normalizeGitRemote(remoteUrl, config) {
  const raw = String(remoteUrl || '').trim()
  if (!raw || raw.length > 2048 || raw.startsWith('-') || /[\0\r\n]/.test(raw)) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, 'Git 远端地址无效')
  }

  if (/^https:\/\//i.test(raw) || /^ssh:\/\//i.test(raw)) {
    let parsed
    try {
      parsed = new URL(raw)
    } catch {
      throw teamError(400, ERROR_CODES.INVALID_INPUT, 'Git 远端 URL 无效')
    }
    if (
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      (parsed.protocol === 'https:' && parsed.username)
    ) {
      throw teamError(400, ERROR_CODES.INVALID_INPUT, 'Git 远端不能包含凭证、query 或 fragment')
    }
    const normalized = parsed.toString().replace(/\/+$/, '')
    let remotePath = parsed.pathname.replace(/^\/+/, '')
    try {
      remotePath = decodeURIComponent(remotePath)
    } catch {
      // 保留 URL 中的原始编码，后续 Git 仍会使用规范化 URL。
    }
    return {
      url: normalized,
      identityHash: semanticRemoteIdentityHash(normalized),
      scheme: parsed.protocol === 'https:' ? 'https' : 'ssh',
      host: parsed.hostname.toLowerCase(),
      port: Number(parsed.port) || (parsed.protocol === 'ssh:' ? 22 : null),
      path: remotePath,
    }
  }

  const scpMatch = raw.match(/^(?:([A-Za-z0-9._-]+)@)?([A-Za-z0-9.-]+):([^\\\s]+)$/)
  if (scpMatch && !/^[A-Za-z]:[\\/]/.test(raw) && !/^file:/i.test(raw)) {
    const normalized = `${scpMatch[1] ? `${scpMatch[1]}@` : ''}${scpMatch[2]}:${scpMatch[3]}`
    return {
      url: normalized,
      identityHash: semanticRemoteIdentityHash(normalized),
      scheme: 'ssh',
      host: scpMatch[2].toLowerCase(),
      port: 22,
      path: scpMatch[3],
    }
  }

  const canUseLocal = Boolean(config.allowLocalGitRemotes) && isLoopback(config.publicUrl?.hostname)
  if (canUseLocal) {
    let localPath = raw
    if (/^file:/i.test(raw)) {
      let parsed
      try {
        parsed = new URL(raw)
      } catch {
        throw teamError(400, ERROR_CODES.INVALID_INPUT, '本地 Git 远端 URL 无效')
      }
      if (parsed.username || parsed.password || parsed.search || parsed.hash) {
        throw teamError(400, ERROR_CODES.INVALID_INPUT, '本地 Git 远端不能包含凭证')
      }
      localPath = decodeURIComponent(parsed.pathname)
      if (/^\/[A-Za-z]:\//.test(localPath)) localPath = localPath.slice(1)
    }
    const resolved = path.resolve(localPath)
    if (!fs.existsSync(resolved)) {
      throw teamError(400, ERROR_CODES.INVALID_INPUT, '本地 Git 远端不存在')
    }
    const normalized = resolved.replaceAll('\\', '/')
    return {
      url: normalized,
      identityHash: semanticLocalPathIdentityHash(normalized),
      scheme: 'file',
      host: '',
      port: null,
      path: normalized,
    }
  }

  throw teamError(400, ERROR_CODES.INVALID_INPUT, '生产环境 Git 远端只支持 HTTPS 或 SSH')
}

export function recommendedProjectName(remote) {
  const raw = String(remote?.path || '')
    .replaceAll('\\', '/')
    .replace(/\/+$/, '')
  const segment = raw.split('/').filter(Boolean).at(-1) || ''
  const name = segment.replace(/\.git$/i, '').trim()
  return Array.from(name).slice(0, 80).join('')
}

export async function runTrellisInitializer({
  cwd,
  agentTools,
  leadTrellisDevId,
  cliPath = DEFAULT_TRELLIS_CLI,
}) {
  if (!fs.existsSync(cliPath)) {
    throw teamError(
      503,
      ERROR_CODES.GIT_UNAVAILABLE,
      '服务端缺少固定的 Trellis CLI，请先安装项目依赖',
    )
  }
  const flags = agentTools.map((id) => {
    const tool = getTrellisAgentTool(id)
    if (!tool) throw teamError(400, ERROR_CODES.INVALID_INPUT, `不支持的 Agent 工具: ${id}`)
    return tool.flag
  })
  const result = await runProcess(
    process.execPath,
    [cliPath, 'init', '-y', '--skip-existing', ...flags, '-u', leadTrellisDevId],
    {
      cwd,
      env: trellisEnvironment({ CI: '1', PYTHONDONTWRITEBYTECODE: '1' }),
      timeoutMs: TRELLIS_INIT_TIMEOUT,
      allowFailure: true,
      maxOutputBytes: 2 * 1024 * 1024,
    },
  )
  return result
}

function redactLocalPaths(value) {
  return String(value || '')
    .replace(/[A-Za-z]:\\(?:[^\\\s"'<>]+\\)*[^\\\s"'<>]*/g, '[local-path]')
    .replace(/\/(?:Users|home|root|tmp|private|var\/folders)\/[^\s"'<>]+/g, '[local-path]')
}

export function sshScanFailureDetails(result) {
  return {
    code: result?.code ?? null,
    signal: result?.signal ?? null,
    stderr: redactLocalPaths(sanitizeProcessOutput(result?.stderr, { maxBytes: 2048 })).trim(),
    stdoutBytes: Buffer.byteLength(String(result?.stdout || ''), 'utf8'),
    environmentKeys: Array.isArray(result?.environmentKeys) ? result.environmentKeys : [],
    gitConfigGlobalIsolated: result?.gitConfigGlobalIsolated === true,
  }
}

export function sshScanEnvironment({
  platform = process.platform,
  programData = process.env.PROGRAMDATA,
} = {}) {
  return minimalEnvironment(platform === 'win32' && programData ? { PROGRAMDATA: programData } : {})
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate)
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function removeEmptyDirectoryTree(target) {
  if (!fs.existsSync(target) || !fs.lstatSync(target).isDirectory()) return false
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    if (entry.isDirectory()) removeEmptyDirectoryTree(path.join(target, entry.name))
  }
  if (fs.readdirSync(target).length) return false
  fs.rmdirSync(target)
  return true
}

function projectFromRow(row) {
  return {
    id: row.repository_id,
    repositoryId: row.repository_id,
    name: row.repository_name,
    path: row.repository_path,
    workspaceKey: row.workspace_key,
    remoteUrl: row.remote_url,
    remoteIdentityHash: row.remote_identity_hash,
    teamId: row.team_id,
    credentialId: row.git_credential_id || null,
    syncBranch: row.sync_branch,
    trustedToolchainSha256: row.trusted_task_toolchain_sha256,
    syncStatus: row.sync_status,
    lastFetchAt: row.last_fetch_at,
    lastPushAt: row.last_push_at,
    lastError: row.last_error,
  }
}

export function readGitProject(db, projectId) {
  const row = db
    .prepare(`
    SELECT
      p.*, r.name AS repository_name, r.path AS repository_path
    FROM team_project p
    JOIN repositories r ON r.id = p.repository_id
    WHERE p.repository_id = ?
  `)
    .get(projectId)
  return row ? projectFromRow(row) : null
}

export function createGitManager({
  db,
  config,
  dataDir,
  credentialService,
  logger = console,
  trellisRunner = runTrellisInitializer,
  runProcessImpl = runProcess,
}) {
  const hooksDir = path.join(dataDir, '.empty-git-hooks')
  const projectsRoot = path.join(dataDir, 'projects')
  const authRoot = path.join(dataDir, '.git-auth')
  const emptyConfigFile = path.join(dataDir, '.empty-git-config')
  fs.mkdirSync(hooksDir, { recursive: true })
  fs.mkdirSync(projectsRoot, { recursive: true })
  fs.writeFileSync(emptyConfigFile, '', 'utf8')
  // 崩溃遗留的认证目录可能含明文私钥，启动时整目录重建。
  fs.rmSync(authRoot, { recursive: true, force: true })
  fs.mkdirSync(authRoot, { recursive: true, mode: 0o700 })
  const locks = new Map()
  const probeWindows = new Map()
  const probeInFlight = new Set()
  const sshChallenges = new Map()
  let globalProbeCount = 0

  function withProjectLock(projectId, callback) {
    const key = String(projectId || '')
    if (!key) return Promise.reject(new Error('缺少项目 ID'))
    const previous = locks.get(key) || Promise.resolve()
    const run = previous.catch(() => {}).then(callback)
    locks.set(key, run)
    run
      .finally(() => {
        if (locks.get(key) === run) locks.delete(key)
      })
      .catch(() => {})
    return run
  }

  function baseConfig(extra = []) {
    return [
      '-c',
      `core.hooksPath=${hooksDir}`,
      '-c',
      'core.autocrlf=false',
      '-c',
      'core.fsmonitor=false',
      '-c',
      'http.sslVerify=true',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'credential.helper=',
      '-c',
      'protocol.ext.allow=never',
      '-c',
      `protocol.file.allow=${config.allowLocalGitRemotes ? 'always' : 'never'}`,
      '-c',
      'user.name=Trellis Team Service',
      '-c',
      'user.email=trellis-team@localhost',
      ...extra,
    ]
  }

  async function runGit(
    args,
    {
      cwd = projectsRoot,
      timeoutMs = LOCAL_TIMEOUT,
      allowFailure = false,
      auth = null,
      maxOutputBytes = undefined,
    } = {},
  ) {
    const env = gitEnvironment({
      GIT_CONFIG_GLOBAL: emptyConfigFile,
      ...(auth?.env || {}),
    })
    const result = await runProcessImpl('git', [...baseConfig(), ...args], {
      cwd,
      env,
      timeoutMs,
      allowFailure,
      maxOutputBytes,
      redact: auth?.redact || [],
    })
    result.environmentKeys = Object.keys(env).sort()
    result.gitConfigGlobalIsolated = env.GIT_CONFIG_GLOBAL === emptyConfigFile
    return result
  }

  async function setSparsePaths(cwd, paths, { auth = null } = {}) {
    const init = await runGit(['sparse-checkout', 'init', '--no-cone'], {
      cwd,
      allowFailure: true,
      auth,
    })
    if (init.code !== 0) {
      const output = sanitizeProcessOutput(init.stderr || init.stdout || 'Git 返回非零退出码', {
        maxBytes: 2048,
        redact: auth?.redact || [],
      }).trim()
      throw teamError(503, 'GIT_SPARSE_CHECKOUT_FAILED', `无法初始化项目稀疏检出：${output}`)
    }
    const set = await runGit(['sparse-checkout', 'set', '--', ...paths], {
      cwd,
      timeoutMs: REMOTE_TIMEOUT,
      allowFailure: true,
      auth,
    })
    if (set.code !== 0) {
      const output = sanitizeProcessOutput(set.stderr || set.stdout || 'Git 返回非零退出码', {
        maxBytes: 2048,
        redact: auth?.redact || [],
      }).trim()
      throw teamError(503, 'GIT_SPARSE_CHECKOUT_FAILED', `无法设置项目稀疏检出：${output}`)
    }
    const update = await runGit(['read-tree', '-mu', 'HEAD'], {
      cwd,
      timeoutMs: REMOTE_TIMEOUT,
      allowFailure: true,
      auth,
    })
    if (update.code !== 0) {
      const output = sanitizeProcessOutput(update.stderr || update.stdout || 'Git 返回非零退出码', {
        maxBytes: 2048,
        redact: auth?.redact || [],
      }).trim()
      throw teamError(503, 'GIT_SPARSE_CHECKOUT_FAILED', `无法收敛项目工作副本：${output}`)
    }
  }

  async function applyTrellisSparse(cwd, { requireTrellis = true, auth = null } = {}) {
    await setSparsePaths(cwd, ['.trellis/'], { auth })
    for (const entry of fs.readdirSync(cwd, { withFileTypes: true })) {
      if (entry.name !== '.git' && entry.name !== '.trellis' && entry.isDirectory()) {
        removeEmptyDirectoryTree(path.join(cwd, entry.name))
      }
    }
    const entries = fs
      .readdirSync(cwd, { withFileTypes: true })
      .filter((entry) => entry.name !== '.git')
    const unexpected = entries
      .filter((entry) => entry.name !== '.trellis')
      .map((entry) => entry.name)
    if (
      requireTrellis &&
      (!entries.some((entry) => entry.name === '.trellis' && entry.isDirectory()) ||
        unexpected.length)
    ) {
      throw teamError(
        503,
        'GIT_SPARSE_CHECKOUT_FAILED',
        `稀疏检出后仍有非 .trellis 文件: ${unexpected.join(', ')}`,
      )
    }
    if (!requireTrellis && unexpected.length) {
      throw teamError(
        503,
        'GIT_SPARSE_CHECKOUT_FAILED',
        `稀疏检出初始化后出现业务文件: ${unexpected.join(', ')}`,
      )
    }
  }

  async function checkoutInitializationContext(cwd, { auth = null } = {}) {
    await setSparsePaths(
      cwd,
      ['.trellis/', 'AGENTS.md', '.gitattributes', ...INITIALIZATION_CONTEXT_PATHS],
      { auth },
    )
  }

  function manifestPaths(manifest) {
    if (
      !manifest ||
      typeof manifest !== 'object' ||
      !manifest.hashes ||
      typeof manifest.hashes !== 'object'
    ) {
      return []
    }
    return Object.keys(manifest.hashes)
  }

  function parseManifestPaths(content) {
    try {
      return manifestPaths(JSON.parse(content))
    } catch {
      return []
    }
  }

  function readWorkingManifestPaths(cwd) {
    try {
      return parseManifestPaths(
        fs.readFileSync(path.join(cwd, '.trellis', '.template-hashes.json'), 'utf8'),
      )
    } catch {
      return []
    }
  }

  async function readRemoteManifestPaths(cwd, options = {}) {
    const result = await runGit(['show', 'HEAD:.trellis/.template-hashes.json'], {
      cwd,
      timeoutMs: REMOTE_TIMEOUT,
      allowFailure: true,
      maxOutputBytes: 4 * 1024 * 1024,
      ...options,
    })
    if (result.code !== 0 || result.truncated) return []
    return parseManifestPaths(result.stdout)
  }

  async function readRemoteTree(cwd, options = {}) {
    const remoteOptions = {
      timeoutMs: REMOTE_TIMEOUT,
      ...options,
    }
    const result = await runGit(
      ['ls-tree', '-r', '--name-only', '-z', 'HEAD', '--', ...REMOTE_TREE_PATHS],
      {
        cwd,
        allowFailure: true,
        maxOutputBytes: 4 * 1024 * 1024,
        ...remoteOptions,
      },
    )
    if (result.code !== 0) {
      throw teamError(502, ERROR_CODES.GIT_REMOTE_FAILED, '无法读取远端 Agent 初始化目录')
    }
    if (result.truncated) {
      throw teamError(422, 'GIT_REMOTE_OUTPUT_TOO_LARGE', 'Agent 初始化目录超出识别限制')
    }
    const treePaths = result.stdout.split('\0').filter(Boolean)
    // Agent 目录可能被项目 .gitignore 排除，模板清单是可提交的第二证据源。
    const detectedPaths = [...treePaths, ...(await readRemoteManifestPaths(cwd, remoteOptions))]
    return {
      existingAgentTools: detectTrellisAgentTools(detectedPaths),
      hasTrellis: treePaths.some(
        (treePath) => treePath === '.trellis' || treePath.startsWith('.trellis/'),
      ),
    }
  }

  async function readWorkingTreeAgentTools(cwd) {
    const result = await runGit(
      [
        'ls-files',
        '--cached',
        '--others',
        '--exclude-standard',
        '-z',
        '--',
        ...AGENT_PRESENCE_PATHS,
      ],
      { cwd, maxOutputBytes: 4 * 1024 * 1024 },
    )
    if (result.truncated) {
      throw teamError(409, 'TRELLIS_INIT_INVALID', 'Agent 初始化目录超出校验限制')
    }
    return detectTrellisAgentTools([
      ...result.stdout.split('\0').filter(Boolean),
      ...readWorkingManifestPaths(cwd),
    ])
  }

  function readInitializationManifest(cwd) {
    const manifestFile = path.join(cwd, '.trellis', '.template-hashes.json')
    if (!fs.existsSync(manifestFile)) {
      throw teamError(409, 'TRELLIS_INIT_INVALID', 'Trellis 初始化未生成模板清单')
    }
    let manifest
    try {
      manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
    } catch {
      throw teamError(409, 'TRELLIS_INIT_INVALID', 'Trellis 初始化模板清单不是合法 JSON')
    }
    if (
      !manifest ||
      typeof manifest !== 'object' ||
      !manifest.hashes ||
      typeof manifest.hashes !== 'object'
    ) {
      throw teamError(409, 'TRELLIS_INIT_INVALID', 'Trellis 初始化模板清单格式无效')
    }
    return new Set(
      manifestPaths(manifest).filter((item) => {
        const normalized = String(item || '').replaceAll('\\', '/')
        return (
          normalized &&
          !normalized.split('/').includes('..') &&
          !normalized.startsWith('/') &&
          !normalized.startsWith('.git/')
        )
      }),
    )
  }

  async function changedPaths(cwd) {
    const result = await runGit(['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
      cwd,
    })
    return result.stdout
      .split('\0')
      .filter(Boolean)
      .map((entry) => entry.slice(3).replaceAll('\\', '/'))
      .filter(Boolean)
  }

  async function cleanGeneratedAgentPaths(cwd) {
    const result = await runGit(['clean', '-fdx', '--', ...AGENT_PRESENCE_PATHS], {
      cwd,
      allowFailure: true,
    })
    if (result.code !== 0) {
      throw teamError(
        503,
        'TRELLIS_INIT_FAILED',
        `无法清理初始化产生的 Agent 文件：${sanitizeProcessOutput(
          result.stderr || result.stdout || 'Git 返回非零退出码',
          { maxBytes: 2048 },
        ).trim()}`,
      )
    }
  }

  async function validateInitialization(
    cwd,
    leadTrellisDevId,
    { existingTrellis = false, gitattributesBefore = null } = {},
  ) {
    const required = [
      '.trellis/scripts/task.py',
      '.trellis/workflow.md',
      `.trellis/workspace/${leadTrellisDevId}`,
    ]
    for (const relativePath of required) {
      const target = path.resolve(cwd, relativePath)
      if (!isInside(path.resolve(cwd), target) || !fs.existsSync(target)) {
        throw teamError(409, 'TRELLIS_INIT_INVALID', `Trellis 初始化缺少 ${relativePath}`)
      }
    }

    const changed = await changedPaths(cwd)
    if (!changed.length) {
      throw teamError(409, 'TRELLIS_INIT_INVALID', 'Trellis 初始化没有产生可提交文件')
    }
    const manifestPaths = readInitializationManifest(cwd)
    const forbidden = changed.filter((relativePath) => {
      const normalized = relativePath.replaceAll('\\', '/')
      if (
        normalized.startsWith('/') ||
        normalized.split('/').includes('..') ||
        normalized === '.git' ||
        normalized.startsWith('.git/')
      ) {
        return true
      }
      return !(
        normalized.startsWith('.trellis/') ||
        normalized === '.gitattributes' ||
        manifestPaths.has(normalized)
      )
    })
    if (forbidden.length) {
      throw teamError(
        409,
        'TRELLIS_INIT_INVALID',
        `Trellis 初始化产生未授权文件: ${forbidden.slice(0, 5).join(', ')}`,
      )
    }

    const existing = await runGit(
      ['ls-tree', '-r', '--name-only', '-z', 'HEAD', '--', ...changed],
      { cwd, maxOutputBytes: 4 * 1024 * 1024 },
    )
    const overwritten = existing.stdout
      .split('\0')
      .filter(Boolean)
      .filter(
        (relativePath) =>
          !(existingTrellis && INCREMENTAL_TRELLIS_METADATA.has(relativePath)) &&
          !(
            relativePath === '.gitattributes' &&
            gitattributesBefore !== null &&
            fs
              .readFileSync(path.join(cwd, '.gitattributes'), 'utf8')
              .startsWith(gitattributesBefore)
          ),
      )
    if (overwritten.length) {
      throw teamError(
        409,
        'TRELLIS_INIT_CONFLICT',
        `自动初始化会覆盖远端已有文件: ${overwritten.slice(0, 5).join(', ')}`,
      )
    }
    return changed
  }

  async function commitInitialization(cwd, relativePaths) {
    const add = await runGit(['add', '--sparse', '--', ...relativePaths], {
      cwd,
      allowFailure: true,
    })
    if (add.code !== 0) {
      throw teamError(
        503,
        'TRELLIS_INIT_FAILED',
        `无法暂存 Trellis 初始化文件：${sanitizeProcessOutput(
          add.stderr || add.stdout || 'Git 返回非零退出码',
          { maxBytes: 2048 },
        ).trim()}`,
      )
    }
    const commit = await runGit(
      ['commit', '--no-gpg-sign', '-m', 'trellis(team): initialize Trellis workspace'],
      { cwd, allowFailure: true },
    )
    if (commit.code !== 0) {
      throw teamError(
        503,
        'TRELLIS_INIT_FAILED',
        `无法提交 Trellis 初始化文件：${sanitizeProcessOutput(
          commit.stderr || commit.stdout || 'Git 返回非零退出码',
          { maxBytes: 2048 },
        ).trim()}`,
      )
    }
    return (await runGit(['rev-parse', 'HEAD'], { cwd })).stdout.trim()
  }

  async function pushInitialization(project, cwd, auth) {
    let localCommitSha = (await runGit(['rev-parse', 'HEAD'], { cwd })).stdout.trim()
    for (let attempt = 0; attempt <= TRELLIS_PUSH_RETRIES; attempt += 1) {
      const pushed = await runGit(
        ['push', '--porcelain', '--', project.remoteUrl, `HEAD:refs/heads/${project.syncBranch}`],
        {
          cwd,
          timeoutMs: PUSH_TIMEOUT,
          allowFailure: true,
          auth,
        },
      )
      if (pushed.code === 0) {
        const remote = await runGit(
          ['ls-remote', '--heads', '--', project.remoteUrl, `refs/heads/${project.syncBranch}`],
          {
            cwd,
            timeoutMs: REMOTE_TIMEOUT,
            auth,
          },
        )
        return remote.stdout.trim().split(/\s+/)[0] || localCommitSha
      }

      const nonFastForward = /non-fast-forward|fetch first/i.test(
        `${pushed.stderr}\n${pushed.stdout}`,
      )
      if (!nonFastForward || attempt === TRELLIS_PUSH_RETRIES) {
        throw teamError(
          503,
          ERROR_CODES.GIT_REMOTE_FAILED,
          'Trellis 初始化提交未能推送到共享分支',
          {
            recoverable: true,
            details: { projectId: project.id, branch: project.syncBranch },
          },
        )
      }
      const fetched = await runGit(
        ['fetch', '--no-tags', '--', project.remoteUrl, `refs/heads/${project.syncBranch}`],
        {
          cwd,
          timeoutMs: REMOTE_TIMEOUT,
          allowFailure: true,
          auth,
        },
      )
      if (fetched.code !== 0) {
        throw teamError(502, ERROR_CODES.GIT_REMOTE_FAILED, '拉取初始化后的远端分支失败')
      }
      const rebased = await runGit(['rebase', 'FETCH_HEAD'], {
        cwd,
        timeoutMs: REMOTE_TIMEOUT,
        allowFailure: true,
        auth,
      })
      if (rebased.code !== 0) {
        await runGit(['rebase', '--abort'], {
          cwd,
          timeoutMs: REMOTE_TIMEOUT,
          allowFailure: true,
          auth,
        })
        throw teamError(
          409,
          ERROR_CODES.PROJECT_REPAIR_REQUIRED,
          '远端分支在初始化期间发生变化，请重新接入',
          { recoverable: true },
        )
      }
      localCommitSha = (await runGit(['rev-parse', 'HEAD'], { cwd })).stdout.trim()
    }
    throw teamError(503, ERROR_CODES.GIT_REMOTE_FAILED, 'Trellis 初始化推送重试次数已用尽')
  }

  function shellQuote(value) {
    return `'${String(value).replaceAll("'", "'\\''")}'`
  }

  function writeAskpass(dir) {
    const helperPath =
      process.platform === 'win32' ? path.join(dir, 'askpass.cmd') : path.join(dir, 'askpass.sh')
    const content =
      process.platform === 'win32'
        ? `@echo off\r\n"${process.execPath}" "${ASKPASS_HELPER}" %*\r\n`
        : `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(ASKPASS_HELPER)} "$@"\n`
    fs.writeFileSync(helperPath, content, {
      mode: 0o700,
      encoding: 'utf8',
    })
    if (process.platform !== 'win32') fs.chmodSync(helperPath, 0o700)
    return helperPath
  }

  function writeSshWrapper(dir, { identityFile, knownHostsFile, passphrase }) {
    const wrapperPath =
      process.platform === 'win32' ? path.join(dir, 'ssh.cmd') : path.join(dir, 'ssh.sh')
    const sshConfigFile = path.join(dir, 'ssh_config')
    const globalKnownHostsFile = path.join(dir, 'global_known_hosts')
    fs.writeFileSync(sshConfigFile, '', { mode: 0o600, encoding: 'utf8' })
    fs.writeFileSync(globalKnownHostsFile, '', { mode: 0o600, encoding: 'utf8' })
    const quotePath = (value) => (process.platform === 'win32' ? `"${value}"` : shellQuote(value))
    const options = [
      '-o BatchMode=yes',
      '-o ConnectTimeout=15',
      '-o StrictHostKeyChecking=yes',
      `-o GlobalKnownHostsFile=${quotePath(globalKnownHostsFile)}`,
      `-o UserKnownHostsFile=${quotePath(knownHostsFile)}`,
      '-o IdentitiesOnly=yes',
      `-o IdentityFile=${quotePath(identityFile)}`,
    ]
    if (passphrase) options[0] = '-o BatchMode=no'
    const content =
      process.platform === 'win32'
        ? `@echo off\r\nssh -F ${quotePath(sshConfigFile)} ${options.join(' ')} %*\r\n`
        : `#!/bin/sh\nexec ssh -F ${shellQuote(sshConfigFile)} ${options.join(' ')} "$@"\n`
    fs.writeFileSync(wrapperPath, content, {
      mode: 0o700,
      encoding: 'utf8',
    })
    if (process.platform !== 'win32') fs.chmodSync(wrapperPath, 0o700)
    return wrapperPath
  }

  async function createAuthContext(credential, remote) {
    if (!credential) return null
    const dir = fs.mkdtempSync(path.join(authRoot, 'run-'))
    const askpass = writeAskpass(dir)
    const redact = [
      credential.payload?.token,
      credential.payload?.privateKey,
      credential.payload?.passphrase,
    ].filter(Boolean)
    try {
      if (credential.authType === 'https_token') {
        return {
          dir,
          redact,
          env: {
            GIT_ASKPASS: askpass,
            GIT_ASKPASS_REQUIRE: 'force',
            TRELLIS_GIT_USERNAME: credential.username || '',
            TRELLIS_GIT_SECRET: credential.payload?.token || '',
          },
          cleanup() {
            fs.rmSync(dir, { recursive: true, force: true })
          },
        }
      }
      if (credential.authType !== 'ssh_key' || remote.scheme !== 'ssh') {
        throw teamError(400, ERROR_CODES.INVALID_INPUT, 'SSH 凭据不能用于当前远端')
      }
      const knownHosts = credentialService.listSshKnownHosts(
        credential.teamId,
        remote.host,
        remote.port || 22,
      )
      if (!knownHosts.length) {
        throw teamError(409, 'SSH_HOST_UNTRUSTED', 'SSH 主机尚未信任，请先识别远端并确认主机指纹')
      }
      const identityFile = path.join(dir, 'identity')
      const knownHostsFile = path.join(dir, 'known_hosts')
      const privateKey = String(credential.payload?.privateKey || '')
      if (!privateKey) {
        throw teamError(409, 'GIT_CREDENTIAL_INVALID', 'SSH 私钥为空')
      }
      fs.writeFileSync(identityFile, `${privateKey.replace(/\s+$/, '')}\n`, {
        mode: 0o600,
        encoding: 'utf8',
      })
      if (process.platform !== 'win32') fs.chmodSync(identityFile, 0o600)
      fs.writeFileSync(
        knownHostsFile,
        `${knownHosts.map((entry) => entry.known_hosts_line).join('\n')}\n`,
        { mode: 0o600, encoding: 'utf8' },
      )
      const passphrase = String(credential.payload?.passphrase || '')
      const sshWrapper = writeSshWrapper(dir, {
        identityFile,
        knownHostsFile,
        passphrase,
      })
      const env = {
        GIT_SSH_COMMAND: process.platform === 'win32' ? `"${sshWrapper}"` : shellQuote(sshWrapper),
        GIT_SSH_VARIANT: 'ssh',
      }
      if (passphrase) {
        env.SSH_ASKPASS = askpass
        env.SSH_ASKPASS_REQUIRE = 'force'
        env.DISPLAY = 'TrellisBoard'
        env.TRELLIS_GIT_SECRET = passphrase
      }
      return {
        dir,
        redact,
        env,
        cleanup() {
          fs.rmSync(dir, { recursive: true, force: true })
        },
      }
    } catch (error) {
      fs.rmSync(dir, { recursive: true, force: true })
      throw error
    }
  }

  async function withGitAuth(credential, remote, callback) {
    const auth = await createAuthContext(credential, remote)
    try {
      return await callback(auth)
    } finally {
      auth?.cleanup()
    }
  }

  function withProjectAuth(project, callback) {
    const remote = normalizeGitRemote(project.remoteUrl, config)
    const credential = credentialService
      ? credentialService.resolveProjectCredential(project, remote)
      : null
    return withGitAuth(credential, remote, callback)
  }

  async function mapRemoteOperationFailure(operation, callback) {
    try {
      return await callback()
    } catch (error) {
      throw remoteException(error, operation)
    }
  }

  async function assertValidBranch(branch) {
    const value = validateSyncBranch(branch)
    const result = await runGit(['check-ref-format', `refs/heads/${value}`], {
      cwd: projectsRoot,
      allowFailure: true,
    })
    if (result.code !== 0) {
      throw teamError(400, ERROR_CODES.INVALID_INPUT, '同步分支不符合 Git 引用格式')
    }
    return value
  }

  async function cloneForTeam(project, credential, { agentTools, leadTrellisDevId }) {
    if (!Array.isArray(agentTools) || !agentTools.length) {
      throw teamError(400, ERROR_CODES.INVALID_INPUT, 'Agent 工具必须至少选择一项')
    }
    const target = path.join(projectsRoot, project.workspaceKey)
    if (fs.existsSync(target)) {
      throw teamError(409, ERROR_CODES.CONFLICT, '项目工作副本目录已存在')
    }
    const remote = normalizeGitRemote(project.remoteUrl, config)
    try {
      return await withGitAuth(credential, remote, async (auth) => {
        const cloned = await runGit(
          [
            'clone',
            '--filter=blob:none',
            '--no-checkout',
            `--branch=${project.syncBranch}`,
            '--single-branch',
            '--',
            project.remoteUrl,
            target,
          ],
          {
            timeoutMs: REMOTE_TIMEOUT,
            allowFailure: true,
            auth,
          },
        )
        if (cloned.code !== 0) {
          throw teamError(
            502,
            ERROR_CODES.GIT_REMOTE_FAILED,
            `无法克隆项目：${cloned.stderr.trim() || cloned.stdout.trim() || 'Git 失败'}`,
          )
        }

        await applyTrellisSparse(target, { requireTrellis: false, auth })
        const checkout = await runGit(['checkout', project.syncBranch], {
          cwd: target,
          timeoutMs: REMOTE_TIMEOUT,
          allowFailure: true,
          auth,
        })
        if (checkout.code !== 0) {
          throw teamError(
            503,
            'GIT_SPARSE_CHECKOUT_FAILED',
            `无法检出共享分支：${checkout.stderr.trim() || checkout.stdout.trim() || 'Git 失败'}`,
          )
        }
        await applyTrellisSparse(target, { requireTrellis: false, auth })

        const remoteTree = await readRemoteTree(target, { auth })
        const newTools = agentTools.filter(
          (toolId) => !remoteTree.existingAgentTools.includes(toolId),
        )
        if (remoteTree.hasTrellis && !newTools.length) {
          await applyTrellisSparse(target, { auth })
          return {
            target,
            initialized: false,
            initializedPaths: [],
            existingAgentTools: remoteTree.existingAgentTools,
            initializedAgentTools: [],
            hasTrellis: true,
            remoteCommitSha: (await runGit(['rev-parse', 'HEAD'], { cwd: target })).stdout.trim(),
          }
        }

        await checkoutInitializationContext(target, { auth })
        const gitattributesFile = path.join(target, '.gitattributes')
        const gitattributesBefore = fs.existsSync(gitattributesFile)
          ? fs.readFileSync(gitattributesFile, 'utf8')
          : null
        let initializedResult
        try {
          initializedResult = await trellisRunner({
            cwd: target,
            agentTools: remoteTree.hasTrellis ? newTools : agentTools,
            leadTrellisDevId,
          })
        } catch (error) {
          if (error?.name === 'TeamError') throw error
          throw teamError(
            503,
            'TRELLIS_INIT_FAILED',
            `Trellis 自动初始化失败：${sanitizeProcessOutput(error?.message || error, {
              maxBytes: 2048,
            })}`,
          )
        }
        if (initializedResult?.code !== 0) {
          throw teamError(
            503,
            'TRELLIS_INIT_FAILED',
            `Trellis 自动初始化失败：${sanitizeProcessOutput(
              initializedResult?.stderr || initializedResult?.stdout || 'CLI 返回非零退出码',
              { maxBytes: 2048 },
            ).trim()}`,
          )
        }

        const generatedTools = await readWorkingTreeAgentTools(target)
        const missingTools = newTools.filter((toolId) => !generatedTools.includes(toolId))
        if (missingTools.length) {
          throw teamError(
            409,
            'TRELLIS_INIT_INVALID',
            `Trellis 初始化未生成 Agent 目录: ${missingTools.join(', ')}`,
          )
        }

        const initializedPaths = await validateInitialization(target, leadTrellisDevId, {
          existingTrellis: remoteTree.hasTrellis,
          gitattributesBefore,
        })
        await commitInitialization(target, initializedPaths)
        await cleanGeneratedAgentPaths(target)
        await applyTrellisSparse(target, { auth })
        const remoteCommitSha = await pushInitialization(project, target, auth)
        await applyTrellisSparse(target, { auth })
        return {
          target,
          initialized: true,
          initializedPaths,
          existingAgentTools: remoteTree.existingAgentTools,
          initializedAgentTools: newTools,
          hasTrellis: true,
          remoteCommitSha,
        }
      })
    } catch (error) {
      try {
        if (fs.existsSync(target)) {
          fs.rmSync(target, {
            recursive: true,
            force: true,
            maxRetries: 5,
            retryDelay: 100,
          })
        }
      } catch (cleanupError) {
        try {
          logger?.warn?.('克隆失败后清理项目工作副本失败', {
            projectId: project.id,
            workspaceKey: project.workspaceKey,
            teamId: project.teamId,
            syncBranch: project.syncBranch,
            remoteIdentityHash: remote.identityHash,
            error: error?.message || String(error),
            cleanupError: cleanupError?.message || String(cleanupError),
          })
        } catch {
          // 日志失败不能覆盖原始克隆错误。
        }
      }
      throw remoteException(error, '克隆项目')
    }
  }

  async function ensureSparseTrellis(project) {
    return mapRemoteOperationFailure('转换项目稀疏检出', async () => {
      await assertClean(project)
      const cwd = assertProjectWorktree(project)
      await withProjectAuth(project, (auth) => applyTrellisSparse(cwd, { auth }))
      return cwd
    })
  }

  function assertProjectWorktree(project) {
    if (!project?.path) {
      throw teamError(409, ERROR_CODES.PROJECT_NOT_READY, '项目工作副本不存在')
    }
    const resolved = path.resolve(project.path)
    if (!isInside(projectsRoot, resolved) || !fs.existsSync(resolved)) {
      throw teamError(409, ERROR_CODES.PROJECT_REPAIR_REQUIRED, '项目工作副本路径无效')
    }
    const realRoot = fs.realpathSync(projectsRoot)
    const realProject = fs.realpathSync(resolved)
    if (!isInside(realRoot, realProject)) {
      throw teamError(409, ERROR_CODES.PROJECT_REPAIR_REQUIRED, '项目工作副本越界')
    }
    return realProject
  }

  async function assertProjectBranch(project) {
    const cwd = assertProjectWorktree(project)
    const result = await runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], {
      cwd,
      allowFailure: true,
    })
    if (result.code !== 0 || result.stdout.trim() !== project.syncBranch) {
      throw teamError(409, ERROR_CODES.PROJECT_REPAIR_REQUIRED, '项目工作副本不在绑定的共享分支')
    }
    return cwd
  }

  async function assertClean(project) {
    const cwd = await assertProjectBranch(project)
    const result = await runGit(['status', '--porcelain=v1', '--untracked-files=all'], { cwd })
    const dirtyPaths = result.stdout.trim()
    if (dirtyPaths) {
      throw teamError(409, ERROR_CODES.PROJECT_REPAIR_REQUIRED, '项目工作副本存在未提交变更', {
        details: { dirtyPaths: dirtyPaths.split(/\r?\n/).slice(0, 50) },
      })
    }
    return cwd
  }

  async function fetchProjectWithAuth(project, auth) {
    const cwd = await assertProjectBranch(project)
    const result = await runGit(
      ['fetch', '--no-tags', '--', project.remoteUrl, `refs/heads/${project.syncBranch}`],
      {
        cwd,
        timeoutMs: REMOTE_TIMEOUT,
        allowFailure: true,
        auth,
      },
    )
    if (result.code !== 0) {
      throw teamError(
        502,
        ERROR_CODES.GIT_REMOTE_FAILED,
        `拉取远端失败：${result.stderr.trim() || result.stdout.trim() || 'Git 失败'}`,
      )
    }
    return cwd
  }

  async function fetchProject(project) {
    return mapRemoteOperationFailure('拉取项目', () =>
      withProjectAuth(project, (auth) => fetchProjectWithAuth(project, auth)),
    )
  }

  async function fetchAndFastForward(project) {
    return mapRemoteOperationFailure('同步项目', () =>
      withProjectAuth(project, async (auth) => {
        const cwd = await fetchProjectWithAuth(project, auth)
        const dirty = await runGit(['status', '--porcelain=v1', '--untracked-files=normal'], {
          cwd,
        })
        const dirtyPaths = dirty.stdout.trim()
        if (dirtyPaths) {
          throw teamError(409, ERROR_CODES.PROJECT_REPAIR_REQUIRED, '项目工作副本存在未提交变更', {
            details: { dirtyPaths: dirtyPaths.split(/\r?\n/).slice(0, 50) },
          })
        }
        const merge = await runGit(['merge', '--ff-only', '--no-overwrite-ignore', 'FETCH_HEAD'], {
          cwd,
          timeoutMs: REMOTE_TIMEOUT,
          allowFailure: true,
          auth,
        })
        if (merge.code !== 0) {
          throw teamError(
            409,
            ERROR_CODES.PROJECT_REPAIR_REQUIRED,
            `无法快进同步：${merge.stderr.trim() || merge.stdout.trim() || 'Git 失败'}`,
          )
        }
        return cwd
      }),
    )
  }

  async function headSha(project) {
    const cwd = await assertProjectBranch(project)
    return (await runGit(['rev-parse', 'HEAD'], { cwd })).stdout.trim()
  }

  function operationMessage(operation) {
    return {
      subject: `trellis(team): ${operation.operationType} ${operation.id}`,
      trailer: `Trellis-Operation: ${operation.id}`,
    }
  }

  async function commitPaths(project, operation, relativePaths) {
    const cwd = await assertProjectBranch(project)
    const safePaths = relativePaths.map((value) => {
      const resolved = path.resolve(cwd, value)
      if (!isInside(cwd, resolved) || path.relative(cwd, resolved).startsWith('.git')) {
        throw teamError(400, ERROR_CODES.INVALID_INPUT, '提交路径无效')
      }
      return path.relative(cwd, resolved).replaceAll('\\', '/')
    })
    await runGit(['add', '--', ...safePaths], { cwd })
    const changed = await runGit(['status', '--porcelain=v1', '--untracked-files=all'], { cwd })
    const changedPaths = changed.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => line.slice(3).replace(/^"|"$/g, '').replaceAll('\\', '/'))
    const expected = new Set(safePaths)
    const extra = changedPaths.filter(
      (item) => !safePaths.some((allowed) => item === allowed || item.startsWith(`${allowed}/`)),
    )
    if (extra.length) {
      throw teamError(
        409,
        ERROR_CODES.PROJECT_REPAIR_REQUIRED,
        `工作副本出现本次操作以外的变更：${extra.slice(0, 5).join(', ')}`,
      )
    }
    const message = operationMessage(operation)
    await runGit(['commit', '--no-gpg-sign', '-m', message.subject, '-m', message.trailer], { cwd })
    return (await runGit(['rev-parse', 'HEAD'], { cwd })).stdout.trim()
  }

  async function pushCommit(project, operation, localCommitSha) {
    return mapRemoteOperationFailure('推送项目', () =>
      withProjectAuth(project, async (auth) => {
        const cwd = await assertProjectBranch(project)
        for (let attempt = 0; attempt <= MAX_SAFE_REBASES; attempt += 1) {
          const result = await runGit(
            [
              'push',
              '--porcelain',
              '--',
              project.remoteUrl,
              `HEAD:refs/heads/${project.syncBranch}`,
            ],
            {
              cwd,
              timeoutMs: PUSH_TIMEOUT,
              allowFailure: true,
              auth,
            },
          )
          if (result.code === 0) {
            const remote = await runGit(
              ['ls-remote', '--heads', '--', project.remoteUrl, `refs/heads/${project.syncBranch}`],
              {
                cwd,
                timeoutMs: REMOTE_TIMEOUT,
                auth,
              },
            )
            return {
              status: 'pushed',
              remoteCommitSha: remote.stdout.trim().split(/\s+/)[0] || localCommitSha,
            }
          }
          const nonFastForward = /non-fast-forward|fetch first/i.test(
            `${result.stderr}\n${result.stdout}`,
          )
          if (!nonFastForward || attempt === MAX_SAFE_REBASES) {
            const network =
              /timed out|could not resolve|connection|authentication|permission/i.test(
                `${result.stderr}\n${result.stdout}`,
              )
            throw teamError(
              network ? 502 : 503,
              ERROR_CODES.GIT_REMOTE_FAILED,
              '提交未能推送到远端，operation 已保留用于恢复',
              {
                recoverable: true,
                details: {
                  operationId: operation.id,
                  retryable: true,
                },
              },
            )
          }
          await fetchProjectWithAuth(project, auth)
          const rebase = await runGit(['rebase', 'FETCH_HEAD'], {
            cwd,
            timeoutMs: REMOTE_TIMEOUT,
            allowFailure: true,
            auth,
          })
          if (rebase.code !== 0) {
            await runGit(['rebase', '--abort'], {
              cwd,
              timeoutMs: REMOTE_TIMEOUT,
              allowFailure: true,
              auth,
            })
            throw teamError(
              409,
              ERROR_CODES.PROJECT_REPAIR_REQUIRED,
              '远端分支发生冲突，项目需要管理员修复',
              {
                recoverable: true,
                details: { operationId: operation.id },
              },
            )
          }
          localCommitSha = (await runGit(['rev-parse', 'HEAD'], { cwd })).stdout.trim()
        }
        throw teamError(503, ERROR_CODES.GIT_REMOTE_FAILED, '推送重试次数已用尽')
      }),
    )
  }

  async function remoteContainsCommit(project, commitSha) {
    return mapRemoteOperationFailure('检查远端提交', () =>
      withProjectAuth(project, async (auth) => {
        const cwd = await assertProjectBranch(project)
        await fetchProjectWithAuth(project, auth)
        const result = await runGit(['merge-base', '--is-ancestor', commitSha, 'FETCH_HEAD'], {
          cwd,
          allowFailure: true,
        })
        return result.code === 0
      }),
    )
  }

  function parseRemoteHeads(output) {
    const branches = new Set()
    let defaultBranch = null
    for (const line of String(output || '').split(/\r?\n/)) {
      const symref = /^ref:\s+refs\/heads\/(.+)\tHEAD$/.exec(line)
      if (symref) {
        defaultBranch = symref[1]
        continue
      }
      const ref = /^[a-f0-9]+\trefs\/heads\/(.+)$/i.exec(line)
      if (ref) branches.add(ref[1])
    }
    const sorted = [...branches].sort((left, right) => left.localeCompare(right, 'en'))
    return {
      branches: sorted,
      defaultBranch: sorted.includes(defaultBranch) ? defaultBranch : null,
    }
  }

  function classifyProbeFailure(result) {
    const text = `${result.stderr}\n${result.stdout}`
    if (
      /authentication failed|permission denied|could not read username|access denied|terminal prompts disabled/i.test(
        text,
      )
    ) {
      return teamError(502, 'GIT_AUTH_FAILED', 'Git 远端认证失败，请检查凭据')
    }
    if (/repository not found|does not appear to be a git repository|not found/i.test(text)) {
      return teamError(404, 'GIT_REPOSITORY_NOT_FOUND', 'Git 仓库不存在或当前凭据无权访问')
    }
    if (/host key verification failed|remote host identification has changed/i.test(text)) {
      return teamError(409, 'SSH_HOST_CHANGED', 'SSH 主机密钥已变化，必须重新确认')
    }
    if (
      /timed out|could not resolve|connection refused|connection timed out|network is unreachable/i.test(
        text,
      )
    ) {
      return teamError(502, 'GIT_REMOTE_UNREACHABLE', '无法连接 Git 远端，请检查网络或地址')
    }
    return teamError(502, ERROR_CODES.GIT_REMOTE_FAILED, '读取 Git 远端失败')
  }

  function remoteException(error, operation) {
    if (error?.name === 'TeamError') return error
    const message = String(error?.message || '')
    if (/执行超过|timed out|ETIMEDOUT/i.test(message)) {
      return teamError(504, 'GIT_REMOTE_TIMEOUT', `${operation}超时，请检查网络或远端状态`)
    }
    if (/ENOENT/i.test(message)) {
      return teamError(503, ERROR_CODES.GIT_UNAVAILABLE, '服务端缺少 Git 或 SSH 命令')
    }
    return teamError(502, ERROR_CODES.GIT_REMOTE_FAILED, `${operation}失败`)
  }

  function beginProbe(actor) {
    const userId = String(actor?.userId || '')
    if (!userId) throw teamError(401, ERROR_CODES.AUTH_REQUIRED, '需要登录')
    const now = Date.now()
    for (const [challengeId, challenge] of sshChallenges) {
      if (challenge.expiresAt < now) sshChallenges.delete(challengeId)
    }
    const recent = (probeWindows.get(userId) || []).filter((at) => now - at < PROBE_WINDOW_MS)
    if (probeInFlight.has(userId) || globalProbeCount >= PROBE_GLOBAL_CONCURRENCY) {
      throw teamError(429, 'GIT_REMOTE_PROBE_RATE_LIMITED', '远端识别请求过于频繁，请稍后重试')
    }
    if (recent.length >= PROBE_LIMIT_PER_WINDOW) {
      throw teamError(429, 'GIT_REMOTE_PROBE_RATE_LIMITED', '远端识别请求过于频繁，请稍后重试')
    }
    recent.push(now)
    probeWindows.set(userId, recent)
    probeInFlight.add(userId)
    globalProbeCount += 1
    return () => {
      probeInFlight.delete(userId)
      globalProbeCount = Math.max(0, globalProbeCount - 1)
    }
  }

  function fingerprintForKey(keyBase64) {
    return `SHA256:${crypto
      .createHash('sha256')
      .update(Buffer.from(keyBase64, 'base64'))
      .digest('base64')
      .replace(/=+$/, '')}`
  }

  async function scanSshHost(remote) {
    if (!remote?.host || String(remote.host).startsWith('-')) {
      throw teamError(400, ERROR_CODES.INVALID_INPUT, 'SSH 主机地址无效')
    }
    const port = Number(remote.port) || 22
    const command = 'ssh-keyscan'
    const args = ['-T', '10']
    if (port !== 22) args.push('-p', String(port))
    args.push(remote.host)
    const environment = sshScanEnvironment()
    let result
    try {
      result = await runProcessImpl(command, args, {
        cwd: projectsRoot,
        env: environment,
        timeoutMs: 45_000,
        allowFailure: true,
        maxOutputBytes: SSH_SCAN_OUTPUT_LIMIT,
      })
    } catch (error) {
      logger?.warn?.('SSH 主机公钥扫描进程失败', {
        host: remote.host,
        port,
        command,
        error: redactLocalPaths(
          sanitizeProcessOutput(error?.message || error, {
            maxBytes: 2048,
          }),
        ),
        environmentKeys: Object.keys(environment).sort(),
      })
      throw teamError(502, 'SSH_HOST_UNREACHABLE', '无法读取 SSH 主机公钥')
    }
    result.environmentKeys = Object.keys(environment).sort()
    if (result.truncated) {
      throw teamError(422, 'SSH_HOST_KEY_TOO_LARGE', 'SSH 主机公钥输出超过限制')
    }
    const entries = []
    const seen = new Set()
    for (const line of result.stdout.split(/\r?\n/)) {
      const fields = line.trim().split(/\s+/)
      if (fields.length !== 3 || fields[0].startsWith('#')) continue
      const [hostField, algorithm, keyBase64] = fields
      if (!algorithm || !keyBase64) continue
      const key = `${algorithm}\0${keyBase64}`
      if (seen.has(key)) continue
      seen.add(key)
      entries.push({
        algorithm,
        keyBase64,
        fingerprintSha256: fingerprintForKey(keyBase64),
        knownHostsLine: `${hostField} ${algorithm} ${keyBase64}`,
      })
    }
    if (!entries.length) {
      logger?.warn?.('SSH 主机公钥扫描失败', {
        host: remote.host,
        port,
        command,
        ...sshScanFailureDetails(result),
      })
      throw teamError(502, 'SSH_HOST_UNREACHABLE', '无法读取 SSH 主机公钥')
    }
    return entries
  }

  function sshKeys(entries) {
    return entries
      .map((entry) => `${entry.algorithm}\0${entry.keyBase64}`)
      .sort()
      .join('\n')
  }

  function ensureSshTrust(actor, credential, remote) {
    const port = Number(remote.port) || 22
    return scanSshHost(remote).then((entries) => {
      const existing = credentialService.listSshKnownHosts(credential.teamId, remote.host, port)
      if (
        existing.length &&
        sshKeys(
          existing.map((entry) => ({
            algorithm: entry.algorithm,
            keyBase64: entry.key_base64,
          })),
        ) === sshKeys(entries)
      ) {
        return
      }
      const challengeId = crypto.randomBytes(24).toString('base64url')
      const replaced = existing.length > 0
      sshChallenges.set(challengeId, {
        actorUserId: actor.userId,
        teamId: credential.teamId,
        credentialId: credential.id,
        host: remote.host,
        port,
        entries,
        replaced,
        expiresAt: Date.now() + SSH_TRUST_TTL_MS,
      })
      throw teamError(
        409,
        replaced ? 'SSH_HOST_CHANGED' : 'SSH_HOST_UNTRUSTED',
        replaced ? 'SSH 主机密钥已变化，请确认新指纹' : 'SSH 主机尚未信任，请确认主机指纹',
        {
          details: {
            challengeId,
            host: remote.host,
            port,
            replaced,
            keys: entries.map((entry) => ({
              algorithm: entry.algorithm,
              fingerprint: entry.fingerprintSha256,
            })),
          },
        },
      )
    })
  }

  function confirmSshHost(actor, challengeId) {
    const id = String(challengeId || '').trim()
    const challenge = sshChallenges.get(id)
    if (!challenge || challenge.expiresAt < Date.now()) {
      sshChallenges.delete(id)
      throw teamError(409, 'SSH_TRUST_CHALLENGE_EXPIRED', 'SSH 主机指纹确认已过期，请重新识别')
    }
    if (challenge.actorUserId !== actor?.userId) {
      throw teamError(403, ERROR_CODES.FORBIDDEN, 'SSH 主机指纹确认不属于当前账号')
    }
    credentialService.trustSshHost(actor, challenge)
    sshChallenges.delete(id)
    return {
      host: challenge.host,
      port: challenge.port,
      replaced: challenge.replaced,
      keys: challenge.entries.map((entry) => ({
        algorithm: entry.algorithm,
        fingerprint: entry.fingerprintSha256,
      })),
    }
  }

  async function probeRemote({ actor, remote, credential = null, branch = null }) {
    const release = beginProbe(actor)
    try {
      if (credential?.authType === 'ssh_key') {
        await ensureSshTrust(actor, credential, remote)
      }
      const result = await withGitAuth(credential, remote, (auth) =>
        runGit(['ls-remote', '--symref', '--', remote.url], {
          timeoutMs: PROBE_TIMEOUT,
          allowFailure: true,
          auth,
          maxOutputBytes: PROBE_OUTPUT_LIMIT,
        }),
      )
      if (result.truncated) {
        throw teamError(422, 'GIT_REMOTE_OUTPUT_TOO_LARGE', 'Git 远端引用过多，超出识别限制')
      }
      if (result.code !== 0) {
        logger?.warn?.('Git 远端探测失败', {
          scheme: remote.scheme,
          host: remote.host,
          port: remote.port,
          command: 'git ls-remote',
          ...sshScanFailureDetails(result),
        })
        throw classifyProbeFailure(result)
      }
      const parsed = parseRemoteHeads(result.stdout)
      if (!parsed.branches.length) {
        throw teamError(422, 'GIT_REMOTE_NO_HEADS', 'Git 远端没有可选择的共享分支')
      }
      const name = recommendedProjectName(remote)
      if (!name) {
        throw teamError(400, ERROR_CODES.INVALID_INPUT, '无法从 Git 远端推导项目名称')
      }
      const requestedBranch = String(branch || '').trim()
      const selectedBranch = requestedBranch
        ? validateSyncBranch(requestedBranch)
        : parsed.defaultBranch
      if (selectedBranch && !parsed.branches.includes(selectedBranch)) {
        throw teamError(400, ERROR_CODES.INVALID_INPUT, `Git 远端不存在共享分支: ${selectedBranch}`)
      }

      let tree = { existingAgentTools: [], hasTrellis: false }
      if (selectedBranch) {
        const probeDir = fs.mkdtempSync(path.join(projectsRoot, '.probe-'))
        try {
          await withGitAuth(credential, remote, async (auth) => {
            const cloned = await runGit(
              [
                'clone',
                '--filter=blob:none',
                '--no-checkout',
                '--depth=1',
                '--single-branch',
                `--branch=${selectedBranch}`,
                '--',
                remote.url,
                probeDir,
              ],
              {
                timeoutMs: REMOTE_TIMEOUT,
                allowFailure: true,
                auth,
              },
            )
            if (cloned.code !== 0) {
              logger?.warn?.('Git 分支目录探测失败', {
                scheme: remote.scheme,
                host: remote.host,
                port: remote.port,
                command: 'git clone --filter=blob:none',
                branch: selectedBranch,
                ...sshScanFailureDetails(cloned),
              })
              throw classifyProbeFailure(cloned)
            }
            tree = await readRemoteTree(probeDir, { auth })
          })
        } finally {
          fs.rmSync(probeDir, { recursive: true, force: true })
        }
      }
      return {
        remote: {
          url: remote.url,
          scheme: remote.scheme,
          host: remote.host,
        },
        recommendedName: name,
        defaultBranch: parsed.defaultBranch,
        branches: parsed.branches,
        branch: selectedBranch,
        existingAgentTools: tree.existingAgentTools,
        hasTrellis: tree.hasTrellis,
        credential: credential
          ? {
              id: credential.id,
              name: credential.name,
              host: credential.host,
              authType: credential.authType,
            }
          : null,
      }
    } catch (error) {
      throw remoteException(error, '远端识别')
    } finally {
      release()
    }
  }

  async function findOperationCommit(project, operationId) {
    const cwd = await assertProjectBranch(project)
    const result = await runGit(
      [
        'log',
        '-1',
        '--format=%H',
        '--fixed-strings',
        `--grep=Trellis-Operation: ${operationId}`,
        'HEAD',
      ],
      { cwd },
    )
    return result.stdout.trim() || null
  }

  return {
    projectsRoot,
    withProjectLock,
    assertValidBranch,
    cloneForTeam,
    ensureSparseTrellis,
    assertProjectWorktree,
    assertProjectBranch,
    assertClean,
    fetchProject,
    fetchAndFastForward,
    headSha,
    commitPaths,
    pushCommit,
    remoteContainsCommit,
    probeRemote,
    confirmSshHost,
    findOperationCommit,
    runGit,
  }
}
