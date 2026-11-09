import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  AgentError,
  AGENT_ERROR_CODE,
  isPathInside,
  safeErrorMessage,
  validateBranchNameSyntax,
} from './protocol.js'
import { buildEnvironment, ProcessError, runProcess } from './process.js'

const LOCAL_TIMEOUT_MS = 30_000
const NETWORK_TIMEOUT_MS = 180_000
const FIXED_SSH_COMMAND = 'ssh -o BatchMode=yes -o StrictHostKeyChecking=yes'
const ALLOWED_GIT_OPERATIONS = new Set([
  'check-ref',
  'config-sparse',
  'show-toplevel',
  'current-branch',
  'head',
  'status',
  'remote-url',
  'fetch',
  'rev-list',
  'merge',
])
const FORBIDDEN_GIT_OPERATIONS = new Set([
  'checkout',
  'stash',
  'reset',
  'rebase',
  'push',
  'worktree',
  'switch',
  'restore',
  'clean',
])

export function assertGitOperationAllowed(operation) {
  if (FORBIDDEN_GIT_OPERATIONS.has(operation)) {
    throw new AgentError(AGENT_ERROR_CODE.GIT_FAILED, `Agent 禁止执行 Git ${operation}`, {
      terminal: true,
    })
  }
  if (!ALLOWED_GIT_OPERATIONS.has(operation)) {
    throw new AgentError(AGENT_ERROR_CODE.GIT_FAILED, 'Agent Git 操作不在白名单内')
  }
}

function canonicalGitEnvironment(extra = {}) {
  return buildEnvironment({
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'Never',
    GIT_ASKPASS: '',
    GIT_SSH_COMMAND: FIXED_SSH_COMMAND,
    ...extra,
  })
}

function sanitizeGitOutput(value, maxLength = 2_000) {
  return safeErrorMessage(new Error(String(value || ''))).slice(0, maxLength)
}

function gitArgs(operation, repoPath, options = {}) {
  assertGitOperationAllowed(operation)
  const hooksDir = path.resolve(options.hooksDir)
  const common = [
    '-C',
    repoPath,
    '-c',
    `core.hooksPath=${hooksDir}`,
    '-c',
    'core.autocrlf=false',
    '-c',
    'http.sslVerify=true',
    '-c',
    `core.sshCommand=${FIXED_SSH_COMMAND}`,
  ]
  switch (operation) {
    case 'check-ref':
      return [...common, 'check-ref-format', `refs/heads/${options.branchName}`]
    case 'config-sparse':
      return [...common, '-c', 'core.fsmonitor=false', 'config', '--bool', 'core.sparseCheckout']
    case 'show-toplevel':
      return [...common, '-c', 'core.fsmonitor=false', 'rev-parse', '--show-toplevel']
    case 'current-branch':
      return [...common, '-c', 'core.fsmonitor=false', 'branch', '--show-current']
    case 'head':
      return [...common, '-c', 'core.fsmonitor=false', 'rev-parse', '--verify', 'HEAD^{commit}']
    case 'status':
      return [
        ...common,
        '-c',
        'core.fsmonitor=false',
        'status',
        '--porcelain=v1',
        '--untracked-files=normal',
      ]
    case 'remote-url':
      return [...common, 'remote', 'get-url', 'origin']
    case 'fetch':
      return [...common, 'fetch', '--no-tags', 'origin', options.branchName]
    case 'rev-list':
      return [
        ...common,
        '-c',
        'core.fsmonitor=false',
        'rev-list',
        '--left-right',
        '--count',
        'HEAD...FETCH_HEAD',
      ]
    case 'merge':
      return [
        ...common,
        '-c',
        'core.fsmonitor=false',
        'merge',
        '--ff-only',
        '--no-overwrite-ignore',
        'FETCH_HEAD',
      ]
    default:
      throw new AgentError(AGENT_ERROR_CODE.GIT_FAILED, 'Agent Git 操作不在白名单内')
  }
}

async function runGit(operation, repoPath, options = {}) {
  const args = gitArgs(operation, repoPath, options)
  try {
    return await runProcess('git', args, {
      cwd: repoPath,
      env: canonicalGitEnvironment(options.env),
      timeoutMs: options.timeoutMs ?? LOCAL_TIMEOUT_MS,
      maxOutputBytes: 1_048_576,
    })
  } catch (error) {
    if (error instanceof ProcessError && error.timedOut) {
      throw new AgentError(AGENT_ERROR_CODE.GIT_TIMEOUT, 'Git 命令执行超时', {
        cause: error,
        retryable: true,
      })
    }
    throw new AgentError(AGENT_ERROR_CODE.GIT_FAILED, '无法执行本地 Git 命令', {
      cause: error,
    })
  }
}

function requireGitSuccess(result, code, message) {
  if (result.exitCode !== 0) {
    throw new AgentError(code, message, {
      cause: new ProcessError(message, {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      }),
    })
  }
  return result.stdout.trim()
}

function pathEquals(left, right) {
  const normalizedLeft = path.resolve(left)
  const normalizedRight = path.resolve(right)
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight
}

export function normalizeLocalRepoKey(realRepoPath) {
  let normalized = path.resolve(realRepoPath).replaceAll('\\', '/')
  if (process.platform === 'win32' && /^[A-Za-z]:/.test(normalized)) {
    normalized = normalized[0].toLowerCase() + normalized.slice(1)
  }
  while (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1)
  }
  return crypto.createHash('sha256').update(normalized).digest('hex')
}

function normalizeRepoPath(value) {
  return String(value || '')
    .replaceAll('\\', '/')
    .replace(/\/+/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
}

function normalizeHost(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
}

function buildRemoteIdentity(host, port, repoPath, defaultPort) {
  const numericPort = Number(port)
  const identity = {
    host: normalizeHost(host),
    port: numericPort === defaultPort ? 0 : numericPort,
    path: normalizeRepoPath(repoPath),
  }
  if (!identity.host || !Number.isInteger(identity.port) || identity.port < 0 || !identity.path) {
    throw new AgentError(AGENT_ERROR_CODE.REMOTE_INVALID, 'Git 远端格式无效')
  }
  return identity
}

function parseScpRemote(raw, allowFileRemote) {
  if (raw.includes('://')) {
    return null
  }
  if (allowFileRemote && !raw.includes('@')) {
    return null
  }
  const ipv6 = /^(?:[^@\s]+@)?\[([^\]]+)]:(.+)$/.exec(raw)
  const scp = /^(?:([^@\s]+)@)?([^:\s/]+):(.+)$/.exec(raw)
  if (!ipv6 && !scp) {
    return null
  }
  const host = ipv6 ? ipv6[1] : scp[2]
  const repoPath = ipv6 ? ipv6[2] : scp[3]
  if (!repoPath || repoPath.startsWith('-')) {
    throw new AgentError(AGENT_ERROR_CODE.REMOTE_INVALID, 'Git SSH 远端路径无效')
  }
  return buildRemoteIdentity(host, 22, repoPath, 22)
}

export function normalizeRemoteIdentity(rawValue, options = {}) {
  const raw = String(rawValue || '').trim()
  if (!raw || raw.length > 4_096 || raw.startsWith('-')) {
    throw new AgentError(AGENT_ERROR_CODE.REMOTE_INVALID, 'Git 远端地址无效')
  }
  if (/^[A-Za-z]:[\\/]/.test(raw)) {
    throw new AgentError(AGENT_ERROR_CODE.REMOTE_INVALID, 'Git origin 不能直接使用本地文件系统路径')
  }

  const scpIdentity = parseScpRemote(raw, options.allowFileRemote === true)
  if (scpIdentity) {
    return {
      ...scpIdentity,
      identityHash: crypto.createHash('sha256').update(JSON.stringify(scpIdentity)).digest('hex'),
    }
  }

  let url
  try {
    url = new URL(raw)
  } catch {
    throw new AgentError(AGENT_ERROR_CODE.REMOTE_INVALID, 'Git 远端地址格式无效')
  }
  if (url.search || url.hash) {
    throw new AgentError(AGENT_ERROR_CODE.REMOTE_INVALID, 'Git 远端不能包含查询或片段')
  }
  let identity
  if (url.protocol === 'https:') {
    if (url.username || url.password) {
      throw new AgentError(AGENT_ERROR_CODE.REMOTE_INVALID, 'HTTPS Git 远端不能包含账号或令牌')
    }
    identity = buildRemoteIdentity(url.hostname, url.port || 443, url.pathname, 443)
  } else if (url.protocol === 'ssh:') {
    if (url.password) {
      throw new AgentError(AGENT_ERROR_CODE.REMOTE_INVALID, 'SSH Git 远端不能包含密码')
    }
    identity = buildRemoteIdentity(url.hostname, url.port || 22, url.pathname, 22)
  } else if (url.protocol === 'file:' && options.allowFileRemote === true) {
    const filePath = decodeURIComponent(url.pathname)
    identity = buildRemoteIdentity('file', 0, filePath, 0)
  } else {
    throw new AgentError(
      AGENT_ERROR_CODE.REMOTE_INVALID,
      'Git 远端只允许 HTTPS、SSH 或受控测试的 file URL',
    )
  }
  return {
    ...identity,
    identityHash: crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex'),
  }
}

async function realDirectory(target, code, label) {
  let stat
  try {
    stat = await fs.lstat(target)
  } catch (error) {
    throw new AgentError(code, `${label}不存在`, { cause: error })
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new AgentError(code, `${label}必须是真实目录`)
  }
  return fs.realpath(target)
}

async function validateRepositoryRoot(repoPath, hooksDir) {
  if (typeof repoPath !== 'string' || !repoPath || repoPath.length > 4_096) {
    throw new AgentError(AGENT_ERROR_CODE.REPO_PATH_INVALID, '本地仓库路径无效')
  }
  const selected = path.resolve(repoPath)
  let selectedReal
  try {
    selectedReal = await fs.realpath(selected)
  } catch (error) {
    throw new AgentError(AGENT_ERROR_CODE.REPO_NOT_FOUND, '本地仓库目录不存在', {
      cause: error,
    })
  }
  const topResult = await runGit('show-toplevel', selectedReal, { hooksDir })
  if (topResult.exitCode !== 0) {
    throw new AgentError(AGENT_ERROR_CODE.NOT_GIT_REPOSITORY, '目录不是 Git 仓库根')
  }
  let topLevel
  try {
    topLevel = await fs.realpath(topResult.stdout.trim())
  } catch (error) {
    throw new AgentError(AGENT_ERROR_CODE.NOT_GIT_REPOSITORY, '无法解析 Git 仓库根', {
      cause: error,
    })
  }
  if (!pathEquals(selectedReal, topLevel)) {
    throw new AgentError(AGENT_ERROR_CODE.REPO_PATH_INVALID, '请选择 Git 仓库根目录，而不是子目录')
  }
  for (const relative of ['.trellis', '.trellis/tasks', '.trellis/workspace']) {
    const directory = await realDirectory(
      path.join(topLevel, ...relative.split('/')),
      AGENT_ERROR_CODE.MISSING_TRELLIS,
      relative,
    )
    if (!isPathInside(topLevel, directory)) {
      throw new AgentError(AGENT_ERROR_CODE.MISSING_TRELLIS, 'Trellis 工作区链接到了仓库外部')
    }
  }
  return { root: topLevel, localRepoKey: normalizeLocalRepoKey(topLevel) }
}

async function ensureHooksDirectory(hooksDir) {
  if (typeof hooksDir !== 'string' || !hooksDir) {
    throw new AgentError(AGENT_ERROR_CODE.GIT_FAILED, 'Agent hooks 目录无效')
  }
  let stat
  try {
    stat = await fs.lstat(hooksDir)
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw new AgentError(AGENT_ERROR_CODE.GIT_FAILED, '无法检查 Agent hooks 目录', {
        cause: error,
      })
    }
    await fs.mkdir(hooksDir, { recursive: true, mode: 0o700 })
    return
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new AgentError(AGENT_ERROR_CODE.GIT_FAILED, 'Agent hooks 目录必须是真实空目录')
  }
  const entries = await fs.readdir(hooksDir)
  if (entries.length > 0) {
    throw new AgentError(AGENT_ERROR_CODE.GIT_FAILED, 'Agent hooks 目录必须为空')
  }
}

async function validateBranch(repoPath, branchName, hooksDir) {
  const branch = validateBranchNameSyntax(branchName)
  const result = await runGit('check-ref', repoPath, { branchName: branch, hooksDir })
  if (result.exitCode !== 0) {
    throw new AgentError(AGENT_ERROR_CODE.BRANCH_INVALID, '同步分支不符合 Git 引用规则')
  }
  return branch
}

async function readRepositoryState(repoPath, hooksDir) {
  const statusResult = await runGit('status', repoPath, { hooksDir })
  if (statusResult.exitCode !== 0) {
    throw new AgentError(AGENT_ERROR_CODE.GIT_FAILED, '无法检查本地工作区状态')
  }
  const statusText = statusResult.stdout.trim()
  const branchResult = await runGit('current-branch', repoPath, { hooksDir })
  const currentBranch = branchResult.stdout.trim()
  if (branchResult.exitCode !== 0 || !currentBranch) {
    throw new AgentError(AGENT_ERROR_CODE.DETACHED_HEAD, '本地仓库处于 detached HEAD')
  }
  const sparseResult = await runGit('config-sparse', repoPath, { hooksDir })
  if (sparseResult.exitCode !== 0 && sparseResult.exitCode !== 1) {
    throw new AgentError(AGENT_ERROR_CODE.GIT_FAILED, '无法读取本地 sparse checkout 配置')
  }
  if (sparseResult.exitCode === 0 && sparseResult.stdout.trim().toLowerCase() === 'true') {
    throw new AgentError(
      AGENT_ERROR_CODE.SPARSE_CHECKOUT,
      '本地仓库启用了 sparse checkout，Agent 拒绝同步',
    )
  }
  const head = requireGitSuccess(
    await runGit('head', repoPath, { hooksDir }),
    AGENT_ERROR_CODE.GIT_FAILED,
    '无法读取本地 HEAD',
  )
  const remoteResult = await runGit('remote-url', repoPath, { hooksDir })
  if (remoteResult.exitCode !== 0 || !remoteResult.stdout.trim()) {
    throw new AgentError(AGENT_ERROR_CODE.REMOTE_MISSING, '本地仓库缺少 origin remote')
  }
  return {
    currentBranch,
    head,
    clean: statusText.length === 0,
    dirtySummary: sanitizeGitOutput(statusText, 500),
    remoteUrl: remoteResult.stdout.trim(),
  }
}

export async function inspectRepository({
  repoPath,
  branchName,
  hooksDir,
  expectedRemoteIdentity = null,
  allowFileRemote = false,
}) {
  await ensureHooksDirectory(hooksDir)
  const repo = await validateRepositoryRoot(repoPath, hooksDir)
  const branch = await validateBranch(repo.root, branchName, hooksDir)
  const state = await readRepositoryState(repo.root, hooksDir)
  const remote = normalizeRemoteIdentity(state.remoteUrl, { allowFileRemote })
  if (expectedRemoteIdentity && remote.identityHash !== expectedRemoteIdentity) {
    throw new AgentError(AGENT_ERROR_CODE.REMOTE_MISMATCH, '本地 origin 与绑定项目远端不一致')
  }
  if (state.currentBranch !== branch) {
    throw new AgentError(
      AGENT_ERROR_CODE.BRANCH_MISMATCH,
      `本地当前分支为 ${state.currentBranch || '未知'}，期望 ${branch}`,
    )
  }
  return {
    root: repo.root,
    localRepoKey: repo.localRepoKey,
    branchName: branch,
    currentBranch: state.currentBranch,
    head: state.head,
    clean: state.clean,
    dirtySummary: state.dirtySummary,
    remoteIdentityKey: remote.identityHash,
  }
}

function classifyFetchFailure(result) {
  const text = `${result.stderr}\n${result.stdout}`
  if (/couldn't find remote ref|remote ref does not exist/i.test(text)) {
    return new AgentError(AGENT_ERROR_CODE.FETCH_FAILED, '远端同步分支不存在')
  }
  if (
    /could not resolve|connection refused|unable to access|permission denied|authentication failed|could not read from remote repository|does not appear to be a git repository|no such file or directory|timed out/i.test(
      text,
    )
  ) {
    return new AgentError(
      AGENT_ERROR_CODE.REMOTE_UNREACHABLE,
      '无法访问 Git 远端，请检查网络和凭据',
      { retryable: true },
    )
  }
  return new AgentError(
    AGENT_ERROR_CODE.FETCH_FAILED,
    `Git fetch 失败：${sanitizeGitOutput(text, 500)}`,
  )
}

function classifyMergeFailure(result) {
  const text = `${result.stderr}\n${result.stdout}`
  if (
    /untracked working tree files would be overwritten|would be overwritten by merge/i.test(text)
  ) {
    return new AgentError(
      AGENT_ERROR_CODE.IGNORED_FILE_CONFLICT,
      '远端文件会覆盖本地 ignored 或未跟踪文件，已拒绝同步',
    )
  }
  if (/not possible to fast-forward|diverging branches|non-fast-forward/i.test(text)) {
    return new AgentError(AGENT_ERROR_CODE.NO_FAST_FORWARD, '本地分支无法安全 fast-forward')
  }
  if (/local changes|would be overwritten|Merge with strategy/i.test(text)) {
    return new AgentError(AGENT_ERROR_CODE.LOCAL_DIRTY, '本地工作区不干净，已拒绝合并')
  }
  return new AgentError(
    AGENT_ERROR_CODE.MERGE_FAILED,
    `Git fast-forward 合并失败：${sanitizeGitOutput(text, 500)}`,
  )
}

export async function syncRepository(options) {
  const before = await inspectRepository(options)
  if (!before.clean) {
    const summary = before.dirtySummary || '未知变更'
    throw new AgentError(
      AGENT_ERROR_CODE.LOCAL_DIRTY,
      `本地工作区存在未提交或未跟踪文件：${summary}`,
    )
  }

  const fetchResult = await runGit('fetch', before.root, {
    branchName: before.branchName,
    hooksDir: options.hooksDir,
    timeoutMs: NETWORK_TIMEOUT_MS,
  })
  if (fetchResult.exitCode !== 0) {
    throw classifyFetchFailure(fetchResult)
  }

  const countsResult = await runGit('rev-list', before.root, {
    hooksDir: options.hooksDir,
  })
  if (countsResult.exitCode !== 0) {
    throw new AgentError(AGENT_ERROR_CODE.GIT_FAILED, '无法比较本地与远端提交')
  }
  const counts = countsResult.stdout.trim().split(/\s+/).map(Number)
  if (counts.length !== 2 || !counts.every(Number.isInteger)) {
    throw new AgentError(AGENT_ERROR_CODE.INVALID_RESPONSE, 'Git 提交计数输出无效')
  }
  const [localAhead, remoteAhead] = counts
  if (localAhead > 0) {
    throw new AgentError(
      AGENT_ERROR_CODE.LOCAL_AHEAD,
      '本地存在未推送提交或已与远端分叉，Agent 拒绝同步',
    )
  }

  if (remoteAhead > 0) {
    const mergeResult = await runGit('merge', before.root, {
      hooksDir: options.hooksDir,
      timeoutMs: NETWORK_TIMEOUT_MS,
    })
    if (mergeResult.exitCode !== 0) {
      throw classifyMergeFailure(mergeResult)
    }
  }

  const after = await inspectRepository(options)
  if (!after.clean) {
    throw new AgentError(
      AGENT_ERROR_CODE.LOCAL_DIRTY,
      '同步后本地工作区出现未提交变化，请检查 Git 配置',
    )
  }
  return {
    ...after,
    syncedAt: new Date().toISOString(),
    remoteAhead,
    localAhead,
  }
}

export function formatBindingHealth(error) {
  return {
    errorCode: error instanceof AgentError ? error.code : AGENT_ERROR_CODE.GIT_FAILED,
    error: safeErrorMessage(error).slice(0, 500),
  }
}

export const GIT_ARGUMENT_CONTRACT = Object.freeze({
  allowed: [...ALLOWED_GIT_OPERATIONS].sort(),
  forbidden: [...FORBIDDEN_GIT_OPERATIONS].sort(),
})
