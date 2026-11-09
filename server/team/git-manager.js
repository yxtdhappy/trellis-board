import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ERROR_CODES, teamError } from './errors.js'
import { minimalEnvironment, runProcess, sanitizeProcessOutput } from './process.js'
import { semanticLocalPathIdentityHash, semanticRemoteIdentityHash } from './remote-identity.js'

const RESERVED_BRANCHES = new Set(['HEAD', 'FETCH_HEAD', 'ORIG_HEAD', 'MERGE_HEAD', '@'])
const SSH_COMMAND = 'ssh -o BatchMode=yes -o StrictHostKeyChecking=yes'
const LOCAL_TIMEOUT = 30_000
const REMOTE_TIMEOUT = 180_000
const PUSH_TIMEOUT = 120_000
const PROBE_TIMEOUT = 30_000
const PROBE_OUTPUT_LIMIT = 1024 * 1024
const SSH_SCAN_OUTPUT_LIMIT = 256 * 1024
const MAX_SAFE_REBASES = 3
const PROBE_WINDOW_MS = 60_000
const PROBE_LIMIT_PER_WINDOW = 5
const PROBE_GLOBAL_CONCURRENCY = 4
const SSH_TRUST_TTL_MS = 5 * 60_000
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

export function createGitManager({ db, config, dataDir, credentialService, logger = console }) {
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
    const result = await runProcess('git', [...baseConfig(), ...args], {
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

  async function cloneProject(project, credential = null) {
    const target = path.join(projectsRoot, project.workspaceKey)
    if (fs.existsSync(target)) {
      throw teamError(409, ERROR_CODES.CONFLICT, '项目工作副本目录已存在')
    }
    const remote = normalizeGitRemote(project.remoteUrl, config)
    let result
    try {
      result = await withGitAuth(credential, remote, (auth) =>
        runGit(
          [
            'clone',
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
        ),
      )
    } catch (error) {
      if (fs.existsSync(target)) {
        fs.rmSync(target, { recursive: true, force: true })
      }
      throw remoteException(error, '克隆项目')
    }
    if (result.code !== 0) {
      if (fs.existsSync(target)) {
        // 只清理本次以全新 UUID 创建的目录。
        fs.rmSync(target, { recursive: true, force: true })
      }
      throw teamError(
        502,
        ERROR_CODES.GIT_REMOTE_FAILED,
        `无法克隆项目：${result.stderr.trim() || result.stdout.trim() || 'Git 失败'}`,
      )
    }
    return target
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
    return withProjectAuth(project, (auth) => fetchProjectWithAuth(project, auth))
  }

  async function fetchAndFastForward(project) {
    return withProjectAuth(project, async (auth) => {
      const cwd = await fetchProjectWithAuth(project, auth)
      const dirty = await runGit(['status', '--porcelain=v1', '--untracked-files=normal'], { cwd })
      const dirtyPaths = dirty.stdout.trim()
      if (dirtyPaths) {
        throw teamError(409, ERROR_CODES.PROJECT_REPAIR_REQUIRED, '项目工作副本存在未提交变更', {
          details: { dirtyPaths: dirtyPaths.split(/\r?\n/).slice(0, 50) },
        })
      }
      const merge = await runGit(['merge', '--ff-only', '--no-overwrite-ignore', 'FETCH_HEAD'], {
        cwd,
        allowFailure: true,
      })
      if (merge.code !== 0) {
        throw teamError(
          409,
          ERROR_CODES.PROJECT_REPAIR_REQUIRED,
          `无法快进同步：${merge.stderr.trim() || merge.stdout.trim() || 'Git 失败'}`,
        )
      }
      return cwd
    })
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
    return withProjectAuth(project, async (auth) => {
      const cwd = await assertProjectBranch(project)
      for (let attempt = 0; attempt <= MAX_SAFE_REBASES; attempt += 1) {
        const result = await runGit(
          ['push', '--porcelain', '--', project.remoteUrl, `HEAD:refs/heads/${project.syncBranch}`],
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
          const network = /timed out|could not resolve|connection|authentication|permission/i.test(
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
          allowFailure: true,
        })
        if (rebase.code !== 0) {
          await runGit(['rebase', '--abort'], { cwd, allowFailure: true })
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
    })
  }

  async function remoteContainsCommit(project, commitSha) {
    return withProjectAuth(project, async (auth) => {
      const cwd = await assertProjectBranch(project)
      await fetchProjectWithAuth(project, auth)
      const result = await runGit(['merge-base', '--is-ancestor', commitSha, 'FETCH_HEAD'], {
        cwd,
        allowFailure: true,
      })
      return result.code === 0
    })
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
      result = await runProcess(command, args, {
        cwd: projectsRoot,
        env: environment,
        timeoutMs: 15_000,
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

  async function probeRemote({ actor, remote, credential = null }) {
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
      return {
        remote: {
          url: remote.url,
          scheme: remote.scheme,
          host: remote.host,
        },
        recommendedName: name,
        defaultBranch: parsed.defaultBranch,
        branches: parsed.branches,
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
    cloneProject,
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
