import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import {
  normalizeSnapshotPath,
  normalizeSnapshotText,
  snapshotSha256,
  TASK_SNAPSHOT_MAX_FILE_BYTES,
  taskDirectoryFromPath,
} from '@trellis-board/shared/task-snapshot.js'
import { validateGitBranchName } from '@trellis-board/shared/remote-identity.js'
import { teamError } from './errors.js'
import { minimalEnvironment, runProcess, sanitizeProcessOutput, terminateTree } from './process.js'

const CACHE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
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
const FETCH_TIMEOUT_MS = 180_000
const OBJECT_TIMEOUT_MS = 180_000
const MAX_ARCHIVE_FILES = 10_000
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024
const MAX_BLOB_BATCH_BYTES = 32 * TASK_SNAPSHOT_MAX_FILE_BYTES

function textOutput(result) {
  return `${result?.stderr || ''}\n${result?.stdout || ''}`.trim()
}

function filterUnsupported(output) {
  return /filtering not recognized|filter.*not recognized|ignoring filter|does not support.*partial clone|not our ref|unadvertised object|bad revision|did not send all necessary objects/i.test(
    output,
  )
}

function classifier(output) {
  if (filterUnsupported(output)) {
    return teamError(
      409,
      'ARCHIVE_GIT_FILTER_UNSUPPORTED',
      'Git 远端不支持 blob:none partial clone，已拒绝退化为全分支下载',
    )
  }
  if (/couldn't find remote ref|remote ref does not exist|not found.*refs\/heads/i.test(output)) {
    return teamError(404, 'ARCHIVE_BRANCH_MISSING', 'Git 远端不存在该任务空间的归档分支')
  }
  if (
    /authentication failed|permission denied|could not read username|access denied|terminal prompts disabled|publickey/i.test(
      output,
    )
  ) {
    return teamError(409, 'ARCHIVE_GIT_AUTH_FAILED', '归档 Git 认证失败，请检查只读凭据')
  }
  if (/host key verification failed|remote host identification has changed/i.test(output)) {
    return teamError(409, 'ARCHIVE_SSH_HOST_CHANGED', 'SSH 主机密钥已变化，必须重新配置凭据')
  }
  if (
    /could not resolve|connection (?:refused|timed out)|network is unreachable|operation timed out/i.test(
      output,
    )
  ) {
    return teamError(502, 'ARCHIVE_GIT_UNREACHABLE', '无法连接归档 Git 远端')
  }
  if (/repository not found|does not appear to be a git repository/i.test(output)) {
    return teamError(404, 'ARCHIVE_REPOSITORY_NOT_FOUND', 'Git 仓库不存在或凭据无权访问')
  }
  return teamError(502, 'ARCHIVE_GIT_FAILED', '归档 Git 操作失败')
}

function gitFailure(result) {
  const output = textOutput(result)
  const error = classifier(output)
  if (output) error.details = { output: sanitizeProcessOutput(output, { maxBytes: 2048 }) }
  return error
}

function parseBlobBatch(buffer, requestedOids) {
  const files = new Map()
  let offset = 0
  for (const requestedOid of requestedOids) {
    const headerEnd = buffer.indexOf(0x0a, offset)
    if (headerEnd < 0) throw new Error('git cat-file 返回了截断的对象头')
    const header = buffer.subarray(offset, headerEnd).toString('utf8')
    const fields = header.trim().split(/\s+/)
    if (fields.length !== 3) throw new Error('git cat-file 返回了无效的对象头')
    const [oid, type, sizeText] = fields
    const size = Number(sizeText)
    if (
      !/^[a-f0-9]{40,64}$/i.test(oid) ||
      type !== 'blob' ||
      !Number.isSafeInteger(size) ||
      size < 0
    ) {
      throw new Error('git cat-file 返回了不支持的归档对象')
    }
    if (size > TASK_SNAPSHOT_MAX_FILE_BYTES) {
      throw teamError(
        409,
        'ARCHIVE_FILE_TOO_LARGE',
        `Git 归档文件超过 ${TASK_SNAPSHOT_MAX_FILE_BYTES / 1024 / 1024} MiB`,
      )
    }
    if (!oid.endsWith(requestedOid) && !requestedOid.endsWith(oid)) {
      throw new Error('git cat-file 返回对象顺序与请求不一致')
    }
    const contentStart = headerEnd + 1
    const contentEnd = contentStart + size
    if (contentEnd >= buffer.length || buffer[contentEnd] !== 0x0a) {
      throw new Error('git cat-file 返回了截断的对象内容')
    }
    files.set(requestedOid, buffer.subarray(contentStart, contentEnd))
    offset = contentEnd + 1
  }
  if (offset !== buffer.length) throw new Error('git cat-file 返回了多余对象')
  return files
}

function parseTaskId(content) {
  try {
    const value = JSON.parse(content)
    return typeof value?.id === 'string' && value.id.trim() ? value.id.trim() : null
  } catch {
    return null
  }
}

export function createArchiveGitStore({
  dataDir,
  config,
  credentials,
  runProcessImpl = runProcess,
  logger = console,
}) {
  const gitRoot = path.join(dataDir, 'archive-git')
  const hooksDir = path.join(dataDir, '.archive-empty-git-hooks')
  const emptyConfigFile = path.join(dataDir, '.archive-empty-git-config')
  fs.mkdirSync(gitRoot, { recursive: true })
  fs.mkdirSync(hooksDir, { recursive: true })
  fs.writeFileSync(emptyConfigFile, '', 'utf8')

  function cacheDirectory(taskSpaceId) {
    const id = String(taskSpaceId || '')
    if (!CACHE_ID.test(id)) throw new Error('任务空间 ID 不能用于归档 Git 缓存')
    return path.join(gitRoot, `${id}.git`)
  }

  function baseConfig() {
    return [
      '-c',
      `core.hooksPath=${hooksDir}`,
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.autocrlf=false',
      '-c',
      'http.sslVerify=true',
      '-c',
      'credential.helper=',
      '-c',
      'protocol.ext.allow=never',
      '-c',
      `protocol.file.allow=${config?.allowLocalGitRemotes ? 'always' : 'never'}`,
      '-c',
      'gc.auto=0',
      '-c',
      'maintenance.auto=false',
    ]
  }

  function environment(auth = null) {
    const proxy = {}
    for (const key of PROXY_ENV_KEYS) {
      if (process.env[key]) proxy[key] = process.env[key]
    }
    return minimalEnvironment({
      GIT_CONFIG_GLOBAL: emptyConfigFile,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'Never',
      GIT_NO_LAZY_FETCH: '1',
      ...(auth?.env || {}),
      ...proxy,
    })
  }

  async function runGit(
    args,
    {
      cwd = gitRoot,
      timeoutMs = 60_000,
      allowFailure = false,
      auth = null,
      maxOutputBytes,
      signal = null,
    } = {},
  ) {
    return runProcessImpl('git', [...baseConfig(), ...args], {
      cwd,
      env: environment(auth),
      timeoutMs,
      allowFailure,
      maxOutputBytes,
      redact: auth?.redact || [],
      signal,
    })
  }

  function requireSuccess(result, operation) {
    if (result.code !== 0) throw gitFailure(result)
    if (filterUnsupported(textOutput(result))) throw gitFailure(result)
    return result
  }

  async function ensureCache(taskSpaceId, remoteUrl, auth, signal) {
    const cwd = cacheDirectory(taskSpaceId)
    if (!fs.existsSync(path.join(cwd, 'HEAD'))) {
      fs.mkdirSync(cwd, { recursive: true })
      requireSuccess(
        await runGit(['init', '--bare', '--quiet', cwd], {
          cwd: gitRoot,
          auth,
          signal,
        }),
        '初始化归档 Git 缓存',
      )
    }
    const settings = [
      ['remote.origin.url', remoteUrl],
      ['remote.origin.promisor', 'true'],
      ['remote.origin.partialclonefilter', 'blob:none'],
      ['extensions.partialClone', 'origin'],
      ['core.hooksPath', hooksDir],
      ['core.fsmonitor', 'false'],
      ['credential.helper', ''],
      ['gc.auto', '0'],
      ['maintenance.auto', 'false'],
    ]
    for (const [key, value] of settings) {
      requireSuccess(
        await runGit(['config', '--local', key, value], {
          cwd,
          auth,
          signal,
        }),
        '配置归档 Git 缓存',
      )
    }
    return cwd
  }

  async function fetchBranch({ taskSpaceId, remoteUrl, branchName, auth, signal }) {
    const branch = validateGitBranchName(branchName)
    const cwd = await ensureCache(taskSpaceId, remoteUrl, auth, signal)
    const fetched = await runGit(
      [
        'fetch',
        '--depth=1',
        '--filter=blob:none',
        '--no-tags',
        '--force',
        '--no-write-fetch-head',
        'origin',
        `+refs/heads/${branch}:refs/heads/trellis-archive`,
      ],
      {
        cwd,
        timeoutMs: FETCH_TIMEOUT_MS,
        allowFailure: true,
        auth,
        signal,
      },
    )
    requireSuccess(fetched, '拉取归档分支')
    const head = (
      await runGit(['rev-parse', 'refs/heads/trellis-archive'], {
        cwd,
        auth,
        signal,
      })
    ).stdout.trim()
    if (!/^[a-f0-9]{40,64}$/i.test(head)) {
      throw teamError(502, 'ARCHIVE_GIT_HEAD_INVALID', '归档分支 HEAD 格式无效')
    }
    return { cwd, head }
  }

  async function listTree(cwd, head, auth, signal) {
    const result = await runGit(
      ['ls-tree', '-r', '-z', head, '--', '.trellis/tasks/archive'],
      {
        cwd,
        timeoutMs: OBJECT_TIMEOUT_MS,
        auth,
        signal,
        maxOutputBytes: 16 * 1024 * 1024,
      },
    )
    if (result.truncated) {
      throw teamError(409, 'ARCHIVE_TREE_TOO_LARGE', '归档目录清单超过 16 MiB')
    }
    const entries = []
    const seen = new Set()
    for (const record of result.stdout.split('\0').filter(Boolean)) {
      const tab = record.indexOf('\t')
      if (tab < 0) throw new Error('Git 归档 tree 记录格式无效')
      const metadata = record.slice(0, tab).trim().split(/\s+/)
      const relativePath = record.slice(tab + 1)
      if (metadata.length !== 3) throw new Error('Git 归档 tree 元数据无效')
      const [mode, type, oid] = metadata
      if (!new Set(['100644', '100755']).has(mode) || type !== 'blob') {
        throw teamError(
          409,
          'ARCHIVE_ENTRY_UNSUPPORTED',
          `归档目录包含不支持的 Git 条目: ${relativePath}`,
        )
      }
      const normalized = normalizeSnapshotPath(relativePath)
      const directory = taskDirectoryFromPath(normalized)
      if (!directory.archived) {
        throw teamError(409, 'ARCHIVE_PATH_INVALID', 'Git 归档导入出现了非归档任务路径')
      }
      if (!/^[a-f0-9]{40,64}$/i.test(oid)) throw new Error('Git 归档对象 ID 无效')
      if (seen.has(normalized)) throw new Error('Git 归档路径重复')
      seen.add(normalized)
      entries.push({ relativePath: normalized, oid, size: null, directory })
    }
    if (entries.length > MAX_ARCHIVE_FILES) {
      throw teamError(409, 'ARCHIVE_TREE_TOO_LARGE', `归档文件数超过上限 ${MAX_ARCHIVE_FILES}`)
    }
    return entries
  }

  async function readBlobBatch(cwd, requestedOids, maxBytes, auth, signal) {
    return new Promise((resolve, reject) => {
      const child = spawn('git', [...baseConfig(), 'cat-file', '--batch'], {
        cwd,
        env: environment(auth),
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      const stdout = []
      const stderr = []
      let stdoutBytes = 0
      let settled = false
      let timer = null
      let abortListener = null
      const cleanup = () => {
        if (timer) clearTimeout(timer)
        if (signal && abortListener) signal.removeEventListener('abort', abortListener)
      }
      const fail = (error) => {
        if (settled) return
        settled = true
        cleanup()
        void terminateTree(child).then(
          () => reject(error),
          () => reject(error),
        )
      }
      timer = setTimeout(() => fail(new Error('读取 Git 归档对象超时')), OBJECT_TIMEOUT_MS)
      if (signal) {
        abortListener = () => fail(new Error('读取 Git 归档对象已取消'))
        signal.addEventListener('abort', abortListener, { once: true })
        if (signal.aborted) abortListener()
      }
      child.stdout.on('data', (chunk) => {
        stdoutBytes += chunk.length
        if (stdoutBytes > maxBytes + 64 * 1024) {
          fail(new Error('Git 归档对象输出超过限制'))
          return
        }
        stdout.push(chunk)
      })
      child.stderr.on('data', (chunk) => stderr.push(chunk))
      child.once('error', (error) => fail(error))
      child.once('close', (code) => {
        if (settled) return
        settled = true
        cleanup()
        if (code !== 0) {
          const output = sanitizeProcessOutput(Buffer.concat(stderr).toString('utf8'), {
            maxBytes: 2048,
            redact: auth?.redact || [],
          })
          reject(classifier(output))
          return
        }
        try {
          resolve(parseBlobBatch(Buffer.concat(stdout), requestedOids))
        } catch (error) {
          reject(error)
        }
      })
      child.stdin.end(`${requestedOids.join('\n')}\n`)
    })
  }

  async function prefetchBlobs(cwd, remoteUrl, oids, auth, signal) {
    const requested = [...new Set(oids)]
    if (!requested.length) return
    await new Promise((resolve, reject) => {
      const child = spawn(
        'git',
        [
          ...baseConfig(),
          'fetch-pack',
          '--stdin',
          '--no-progress',
          remoteUrl,
        ],
        {
          cwd,
          env: environment(auth),
          shell: false,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      )
      const stdout = []
      const stderr = []
      let outputBytes = 0
      let settled = false
      let timer = null
      let abortListener = null
      const cleanup = () => {
        if (timer) clearTimeout(timer)
        if (signal && abortListener) signal.removeEventListener('abort', abortListener)
      }
      const fail = (error) => {
        if (settled) return
        settled = true
        cleanup()
        void terminateTree(child).then(
          () => reject(error),
          () => reject(error),
        )
      }
      timer = setTimeout(() => fail(new Error('批量拉取 Git 归档对象超时')), OBJECT_TIMEOUT_MS)
      if (signal) {
        abortListener = () => fail(new Error('批量拉取 Git 归档对象已取消'))
        signal.addEventListener('abort', abortListener, { once: true })
        if (signal.aborted) abortListener()
      }
      const collect = (target) => (chunk) => {
        outputBytes += chunk.length
        if (outputBytes > 1024 * 1024) {
          fail(new Error('批量拉取 Git 归档对象输出超过限制'))
          return
        }
        target.push(chunk)
      }
      child.stdout.on('data', collect(stdout))
      child.stderr.on('data', collect(stderr))
      child.stdin.on('error', () => {})
      child.once('error', (error) => fail(error))
      child.once('close', (code) => {
        if (settled) return
        settled = true
        cleanup()
        if (code !== 0) {
          const output = [
            Buffer.concat(stderr).toString('utf8'),
            Buffer.concat(stdout).toString('utf8'),
          ]
            .filter(Boolean)
            .join('\n')
          const sanitized = sanitizeProcessOutput(output, {
            maxBytes: 2048,
            redact: auth?.redact || [],
          })
          const error = classifier(sanitized)
          if (sanitized) error.details = { output: sanitized }
          reject(error)
          return
        }
        resolve()
      })
      child.stdin.end(`${requested.join('\n')}\n`)
    })
  }

  async function readObjects(cwd, remoteUrl, entries, auth, signal, onBlob) {
    await prefetchBlobs(
      cwd,
      remoteUrl,
      entries.map((entry) => entry.oid),
      auth,
      signal,
    )
    const batchSize = 32
    for (let index = 0; index < entries.length; index += batchSize) {
      const batch = entries.slice(index, index + batchSize)
      const output = await readBlobBatch(
        cwd,
        batch.map((entry) => entry.oid),
        MAX_BLOB_BATCH_BYTES,
        auth,
        signal,
      )
      for (const entry of batch) {
        const blob = output.get(entry.oid)
        if (!blob) throw new Error('Git 未返回归档对象内容')
        onBlob(entry, blob)
      }
    }
  }

  async function readSnapshot({
    taskSpaceId,
    project,
    taskSpace,
    knownHead = null,
    signal = null,
  }) {
    const branchName = validateGitBranchName(taskSpace.branch_name)
    const resolved = credentials.resolveForRemote(project.remote_url, {
      allowFileRemote: Boolean(config?.allowLocalGitRemotes),
    })
    const startedAt = Date.now()
    return credentials.withAuth(resolved.credential, async (auth) => {
      const fetchedAt = Date.now()
      let cwd
      let head
      try {
        ({ cwd, head } = await fetchBranch({
          taskSpaceId,
          remoteUrl: resolved.remote.url,
          branchName,
          auth,
          signal,
        }))
      } catch (error) {
        if (error && typeof error === 'object') error.archivePhase = 'fetch'
        throw error
      }
      if (knownHead && head === knownHead) {
        return {
          remote: resolved.remote,
          credentialId: resolved.credential?.id || null,
          origin: resolved.origin,
          branchName,
          head,
          files: null,
          skipped: true,
          metrics: {
            fetchMs: fetchedAt - startedAt,
            readMs: 0,
            totalMs: Date.now() - startedAt,
          },
        }
      }
      let tree
      try {
        tree = await listTree(cwd, head, auth, signal)
      } catch (error) {
        if (error && typeof error === 'object') error.archivePhase = 'import'
        throw error
      }
      const decoder = new TextDecoder('utf-8', { fatal: true })
      const files = []
      let byteCount = 0
      const collectBlob = (entry, blob) => {
        let decoded
        try {
          decoded = decoder.decode(blob)
        } catch {
          throw teamError(
            409,
            'ARCHIVE_FILE_NOT_UTF8',
            `归档文件不是严格 UTF-8: ${entry.relativePath}`,
          )
        }
        const content = normalizeSnapshotText(decoded)
        byteCount += Buffer.byteLength(content, 'utf8')
        if (byteCount > MAX_ARCHIVE_BYTES) {
          throw teamError(
            409,
            'ARCHIVE_TREE_TOO_LARGE',
            `归档正文总量超过 ${MAX_ARCHIVE_BYTES / 1024 / 1024} MiB`,
          )
        }
        files.push({
          relativePath: entry.relativePath,
          blobOid: entry.oid,
          sha256: snapshotSha256(content),
          content,
          taskDir: entry.directory.taskDir,
          taskId:
            entry.relativePath === `${entry.directory.taskDir}/task.json`
              ? parseTaskId(content)
              : null,
        })
      }
      try {
        await readObjects(
          cwd,
          resolved.remote.url,
          tree,
          auth,
          signal,
          collectBlob,
        )
      } catch (error) {
        if (error && typeof error === 'object') error.archivePhase = 'import'
        throw error
      }
      return {
        remote: resolved.remote,
        credentialId: resolved.credential?.id || null,
        origin: resolved.origin,
        branchName,
        head,
        files,
        fileCount: files.length,
        byteCount,
        skipped: false,
        metrics: {
          fetchMs: fetchedAt - startedAt,
          readMs: Date.now() - fetchedAt,
          totalMs: Date.now() - startedAt,
        },
      }
    })
  }

  async function testCredential({ credential, remoteUrl, branchName, signal = null }) {
    const branch = validateGitBranchName(branchName)
    return credentials.withAuth(credential, async (auth) => {
      const result = await runGit(
        ['ls-remote', '--heads', '--', remoteUrl, `refs/heads/${branch}`],
        {
          cwd: gitRoot,
          timeoutMs: 60_000,
          allowFailure: true,
          auth,
          signal,
        },
      )
      requireSuccess(result, '测试归档 Git 凭据')
      return {
        ok: true,
        branchFound: Boolean(result.stdout.trim()),
      }
    })
  }

  return {
    gitRoot,
    cacheDirectory,
    readSnapshot,
    testCredential,
  }
}
