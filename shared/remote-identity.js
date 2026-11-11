import crypto from 'node:crypto'

const RESERVED_BRANCH_NAMES = new Set(['HEAD', 'FETCH_HEAD', 'ORIG_HEAD', 'MERGE_HEAD', '@'])

function normalizeHost(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
}

function normalizeRepoPath(value) {
  const normalized = String(value || '')
    .replaceAll('\\', '/')
    .replace(/\/+/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
  if (!normalized || normalized.split('/').includes('..')) {
    throw new Error('Git 远端仓库路径无效')
  }
  return normalized
}

function buildIdentity(host, port, repoPath, defaultPort, scheme) {
  const identity = {
    host: normalizeHost(host),
    port: Number(port) === defaultPort ? 0 : Number(port),
    path: normalizeRepoPath(repoPath),
  }
  if (
    !identity.host ||
    !Number.isInteger(identity.port) ||
    identity.port < 0 ||
    identity.port > 65535
  ) {
    throw new Error('Git 远端身份格式无效')
  }
  return {
    ...identity,
    scheme,
    canonical: `${identity.host}/${identity.path}`,
  }
}

function parseScpRemote(raw) {
  if (raw.includes('://')) return null
  const ipv6 = /^(?:[^@\s]+@)?\[([^\]]+)]:(.+)$/.exec(raw)
  const scp = /^(?:([^@\s]+)@)?([^:\s/]+):(.+)$/.exec(raw)
  if (!ipv6 && !scp) return null
  const host = ipv6 ? ipv6[1] : scp[2]
  const repoPath = ipv6 ? ipv6[2] : scp[3]
  if (!repoPath || repoPath.startsWith('-')) {
    throw new Error('Git SSH 远端路径无效')
  }
  return buildIdentity(host, 22, repoPath, 22, 'ssh')
}

export function normalizeGitRemote(rawValue, { allowFileRemote = false } = {}) {
  const raw = String(rawValue || '').trim()
  if (!raw || raw.length > 4096 || raw.startsWith('-')) {
    throw new Error('Git 远端地址无效')
  }
  if (/^[A-Za-z]:[\\/]/.test(raw)) {
    throw new Error('Git 远端不能直接使用本地文件系统路径')
  }
  const scp = parseScpRemote(raw)
  if (scp) return scp

  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Error('Git 远端地址格式无效')
  }
  if (url.search || url.hash) {
    throw new Error('Git 远端不能包含查询或片段')
  }
  if (url.protocol === 'https:') {
    return buildIdentity(url.hostname, url.port || 443, url.pathname, 443, 'https')
  }
  if (url.protocol === 'ssh:') {
    return buildIdentity(url.hostname, url.port || 22, url.pathname, 22, 'ssh')
  }
  if (url.protocol === 'file:' && allowFileRemote) {
    const filePath = decodeURIComponent(url.pathname)
    return buildIdentity('file', 0, filePath, 0, 'file')
  }
  throw new Error('Git 远端只允许 HTTPS、SSH 或受控测试的 file URL')
}

export function gitRemoteIdentityKey(rawValue, options) {
  const identity = normalizeGitRemote(rawValue, options)
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ host: identity.host, port: identity.port, path: identity.path }))
    .digest('hex')
}

export function formatGitRemote(identity) {
  if (!identity || typeof identity !== 'object') throw new Error('Git 远端身份无效')
  if (identity.scheme === 'file') return `file:///${identity.path}`
  const port = identity.port ? `:${identity.port}` : ''
  return `${identity.scheme || 'https'}://${identity.host}${port}/${identity.path}`
}

export function validateGitBranchName(value) {
  const branch = String(value || '')
  if (
    branch.length === 0 ||
    branch.length > 255 ||
    branch.startsWith('-') ||
    branch.startsWith('refs/') ||
    RESERVED_BRANCH_NAMES.has(branch) ||
    /[\u0000-\u0020\u007f~^:?*[\\]/.test(branch) ||
    branch.includes('..') ||
    branch.includes('@{') ||
    branch.startsWith('/') ||
    branch.endsWith('/') ||
    branch.endsWith('.') ||
    branch.endsWith('.lock') ||
    branch.includes('//')
  ) {
    throw new Error('Git 分支名称无效')
  }
  return branch
}
