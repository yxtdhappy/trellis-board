import crypto from 'node:crypto'

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
    throw new Error('Git 远端身份格式无效')
  }
  return identity
}

function parseScpRemote(raw, allowFileRemote) {
  if (raw.includes('://')) return null
  if (allowFileRemote && !raw.includes('@')) return null
  const ipv6 = /^(?:[^@\s]+@)?\[([^\]]+)]:(.+)$/.exec(raw)
  const scp = /^(?:([^@\s]+)@)?([^:\s/]+):(.+)$/.exec(raw)
  if (!ipv6 && !scp) return null
  const host = ipv6 ? ipv6[1] : scp[2]
  const repoPath = ipv6 ? ipv6[2] : scp[3]
  if (!repoPath || repoPath.startsWith('-')) {
    throw new Error('Git SSH 远端路径无效')
  }
  return buildRemoteIdentity(host, 22, repoPath, 22)
}

export function semanticRemoteIdentity(rawValue, { allowFileRemote = false } = {}) {
  const raw = String(rawValue || '').trim()
  if (!raw || raw.length > 4096 || raw.startsWith('-')) {
    throw new Error('Git 远端地址无效')
  }
  if (/^[A-Za-z]:[\\/]/.test(raw)) {
    throw new Error('Git 远端不能直接使用本地文件系统路径')
  }
  const scpIdentity = parseScpRemote(raw, allowFileRemote)
  if (scpIdentity) return scpIdentity

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
    if (url.username || url.password) {
      throw new Error('HTTPS Git 远端不能包含账号或令牌')
    }
    return buildRemoteIdentity(url.hostname, url.port || 443, url.pathname, 443)
  }
  if (url.protocol === 'ssh:') {
    if (url.password) {
      throw new Error('SSH Git 远端不能包含密码')
    }
    return buildRemoteIdentity(url.hostname, url.port || 22, url.pathname, 22)
  }
  if (url.protocol === 'file:' && allowFileRemote) {
    return buildRemoteIdentity('file', 0, decodeURIComponent(url.pathname), 0)
  }
  throw new Error('Git 远端只允许 HTTPS、SSH 或受控测试的 file URL')
}

export function semanticRemoteIdentityHash(rawValue, options) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(semanticRemoteIdentity(rawValue, options)))
    .digest('hex')
}

export function semanticLocalPathIdentityHash(localPath) {
  const identity = buildRemoteIdentity('file', 0, localPath, 0)
  return crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex')
}
