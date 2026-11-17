import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { withTransaction } from '../database.js'
import { appendAuditEvent } from './audit.js'
import { ERROR_CODES, teamError } from './errors.js'
import {
  formatGitRemote,
  normalizeGitRemote,
} from '@trellis-board/shared/remote-identity.js'

const KEY_FILE = 'archive-git-credentials.key'
const MAX_SSH_KEY_BYTES = 32 * 1024
const MAX_TOKEN_BYTES = 8 * 1024
const MAX_KNOWN_HOSTS_BYTES = 64 * 1024
const ASKPASS_HELPER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'git-askpass.js')

function cleanText(value, label, maxLength, { required = true } = {}) {
  const text = String(value || '').trim()
  if (required && !text) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, `${label}不能为空`)
  }
  if (Array.from(text).length > maxLength) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, `${label}不能超过 ${maxLength} 个字符`)
  }
  if (text.includes('\0') || /[\r\n]/.test(text)) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, `${label}包含非法字符`)
  }
  return text
}

function cleanSecret(value, label, maxBytes, { allowNewlines = false, required = true } = {}) {
  const text = String(value || '')
  if (required && !text.trim()) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, `${label}不能为空`)
  }
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, `${label}超过大小限制`)
  }
  if (text.includes('\0') || (!allowNewlines && /[\r\n]/.test(text))) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, `${label}包含非法字符`)
  }
  return text
}

function normalizedHost(value) {
  const raw = String(value || '').trim()
  if (!raw || raw.length > 253 || raw.startsWith('-') || /[/@?#\s]/.test(raw)) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, 'Git 凭据主机无效')
  }
  let parsed
  try {
    parsed = new URL(`https://${raw}`)
  } catch {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, 'Git 凭据主机无效')
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, 'Git 凭据主机不能包含协议、端口或路径')
  }
  return parsed.hostname.toLowerCase()
}

function normalizedOrigin(input) {
  const scheme = String(input?.scheme || '')
    .trim()
    .toLowerCase()
  if (!new Set(['ssh', 'https']).has(scheme)) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, 'Git 凭据协议只能是 SSH 或 HTTPS')
  }
  const host = normalizedHost(input?.host)
  const fallbackPort = scheme === 'ssh' ? 22 : 443
  const port = input?.port == null || input.port === '' ? fallbackPort : Number(input.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, 'Git 凭据端口必须是 1 到 65535 的整数')
  }
  return { scheme, host, port, origin: `${scheme}://${host}:${port}` }
}

function authTypeForScheme(scheme) {
  return scheme === 'ssh' ? 'ssh_key' : 'https_token'
}

function fingerprintForKey(keyBase64) {
  return `SHA256:${crypto
    .createHash('sha256')
    .update(Buffer.from(keyBase64, 'base64'))
    .digest('base64')
    .replace(/=+$/, '')}`
}

function knownHostsEntryMatches(hostField, host, port) {
  const field = String(hostField || '').trim()
  if (!field || field.startsWith('|')) return false
  const expected = port === 22 ? host : `[${host}]:${port}`
  return field.split(',').some((item) => item.trim().toLowerCase() === expected.toLowerCase())
}

function parseKnownHosts(value, host, port) {
  const raw = String(value || '').trim()
  if (!raw) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, 'SSH 凭据必须配置 known_hosts')
  }
  if (Buffer.byteLength(raw, 'utf8') > MAX_KNOWN_HOSTS_BYTES) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, 'known_hosts 超过 64 KiB')
  }
  const lines = []
  const fingerprints = []
  for (const sourceLine of raw.split(/\r?\n/)) {
    const line = sourceLine.trim()
    if (!line || line.startsWith('#')) continue
    const fields = line.split(/\s+/)
    if (fields.length !== 3 || !knownHostsEntryMatches(fields[0], host, port)) continue
    const [, algorithm, keyBase64] = fields
    try {
      if (!Buffer.from(keyBase64, 'base64').length) continue
    } catch {
      continue
    }
    lines.push(`${fields[0]} ${algorithm} ${keyBase64}`)
    fingerprints.push({
      algorithm,
      fingerprint: fingerprintForKey(keyBase64),
    })
  }
  if (!lines.length) {
    throw teamError(
      400,
      ERROR_CODES.INVALID_INPUT,
      `known_hosts 没有匹配 ${port === 22 ? host : `[${host}]:${port}`} 的主机公钥`,
    )
  }
  return {
    text: `${[...new Set(lines)].join('\n')}\n`,
    fingerprints: fingerprints.filter(
      (entry, index, all) =>
        all.findIndex((item) => item.fingerprint === entry.fingerprint) === index,
    ),
  }
}

function publicKnownHostFingerprints(text) {
  const result = []
  for (const line of String(text || '').split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/)
    if (fields.length !== 3) continue
    result.push({
      algorithm: fields[1],
      fingerprint: fingerprintForKey(fields[2]),
    })
  }
  return result
}

function publicCredential(row) {
  return {
    id: row.id,
    name: row.name,
    scheme: row.scheme,
    host: row.host,
    port: Number(row.port),
    origin: `${row.scheme}://${row.host}:${row.port}`,
    authType: row.auth_type,
    username: row.username || null,
    configured: true,
    publicKeyFingerprint: row.public_key_fingerprint || null,
    knownHostsConfigured: Boolean(String(row.known_hosts_text || '').trim()),
    knownHostsFingerprints: publicKnownHostFingerprints(row.known_hosts_text),
    secretVersion: Number(row.secret_version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function credentialPayload(input, authType, existing = null) {
  if (authType === 'https_token') {
    const token = cleanSecret(input?.token, 'HTTPS Token', MAX_TOKEN_BYTES, {
      required: !existing,
    })
    if (!token && existing) return existing
    return { token }
  }
  const privateKey = cleanSecret(input?.privateKey, 'SSH 私钥', MAX_SSH_KEY_BYTES, {
    allowNewlines: true,
    required: !existing,
  })
  if (!privateKey && existing) return existing
  if (!/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(privateKey)) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, 'SSH 私钥格式无效')
  }
  return { privateKey }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

export function archiveCredentialOrigin(remote) {
  const scheme = String(remote?.scheme || '')
  if (!new Set(['ssh', 'https']).has(scheme)) return null
  const port = Number(remote?.port) || (scheme === 'ssh' ? 22 : 443)
  return `${scheme}://${String(remote?.host || '').toLowerCase()}:${port}`
}

export function createArchiveGitCredentialService({ db, dataDir }) {
  const keyFile = path.join(dataDir, KEY_FILE)
  const authRoot = path.join(dataDir, '.archive-git-auth')
  fs.mkdirSync(dataDir, { recursive: true })
  fs.rmSync(authRoot, { recursive: true, force: true })
  fs.mkdirSync(authRoot, { recursive: true, mode: 0o700 })

  function readMasterKey({ create = false } = {}) {
    try {
      const key = fs.readFileSync(keyFile)
      if (key.length !== 32) {
        throw teamError(503, 'ARCHIVE_CREDENTIAL_KEY_INVALID', '归档 Git 凭据主密钥格式无效')
      }
      return key
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      if (!create) {
        throw teamError(
          503,
          'ARCHIVE_CREDENTIAL_KEY_MISSING',
          '归档 Git 凭据主密钥缺失，已有凭据无法解密',
        )
      }
      const key = crypto.randomBytes(32)
      try {
        fs.writeFileSync(keyFile, key, { flag: 'wx', mode: 0o600 })
        return key
      } catch (writeError) {
        if (writeError?.code === 'EEXIST') return readMasterKey({ create: false })
        throw writeError
      }
    }
  }

  function aad(row, version) {
    const origin = `${row.scheme}://${row.host}:${row.port}`
    return Buffer.from(
      `trellis-archive-credential:${row.id}:${origin}:${row.auth_type}:${version}`,
      'utf8',
    )
  }

  function encrypt(id, origin, authType, version, payload) {
    const hasCredentials =
      Number(db.prepare('SELECT COUNT(*) AS count FROM sync_archive_git_credential').get().count) >
      0
    const key = readMasterKey({ create: !hasCredentials })
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(
      aad(
        {
          id,
          scheme: origin.scheme,
          host: origin.host,
          port: origin.port,
          auth_type: authType,
        },
        version,
      ),
    )
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(payload), 'utf8'),
      cipher.final(),
    ])
    return {
      version,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    }
  }

  function decrypt(row) {
    const key = readMasterKey({ create: false })
    try {
      const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        key,
        Buffer.from(row.secret_iv, 'base64'),
      )
      decipher.setAAD(aad(row, row.secret_version))
      decipher.setAuthTag(Buffer.from(row.secret_tag, 'base64'))
      return JSON.parse(
        Buffer.concat([
          decipher.update(Buffer.from(row.secret_ciphertext, 'base64')),
          decipher.final(),
        ]).toString('utf8'),
      )
    } catch {
      throw teamError(
        503,
        'ARCHIVE_CREDENTIAL_DECRYPT_FAILED',
        '归档 Git 凭据无法解密，请检查或恢复主密钥',
      )
    }
  }

  function rowById(id) {
    return (
      db.prepare('SELECT * FROM sync_archive_git_credential WHERE id = ?').get(String(id || '')) ||
      null
    )
  }

  function list() {
    return db
      .prepare('SELECT * FROM sync_archive_git_credential ORDER BY scheme, host, port, name')
      .all()
      .map(publicCredential)
  }

  function create(actor, input = {}) {
    const origin = normalizedOrigin(input)
    const authType = authTypeForScheme(origin.scheme)
    if (input.authType != null && input.authType !== authType) {
      throw teamError(400, ERROR_CODES.INVALID_INPUT, '认证类型与远端协议不匹配')
    }
    const name =
      input.name == null || input.name === ''
        ? origin.origin
        : cleanText(input.name, '凭据名称', 100)
    const username =
      authType === 'https_token'
        ? cleanText(input.username || 'x-access-token', 'HTTPS 用户名', 200)
        : null
    const payload = credentialPayload(input, authType)
    const knownHosts =
      authType === 'ssh_key'
        ? parseKnownHosts(input.knownHostsText, origin.host, origin.port)
        : { text: null, fingerprints: [] }
    const id = crypto.randomUUID()
    const encrypted = encrypt(id, origin, authType, 1, payload)
    const now = new Date().toISOString()
    try {
      withTransaction(db, () => {
        db.prepare(`
          INSERT INTO sync_archive_git_credential(
            id, name, scheme, host, port, auth_type, username, secret_version,
            secret_iv, secret_tag, secret_ciphertext, public_key_fingerprint,
            known_hosts_text, created_by_user_id, updated_by_user_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)
        `).run(
          id,
          name,
          origin.scheme,
          origin.host,
          origin.port,
          authType,
          username,
          encrypted.version,
          encrypted.iv,
          encrypted.tag,
          encrypted.ciphertext,
          knownHosts.text,
          actor.userId,
          actor.userId,
          now,
          now,
        )
        appendAuditEvent(db, {
          actorUserId: actor.userId,
          action: 'archive_git_credential_created',
          targetType: 'archive_git_credential',
          targetId: id,
          detail: {
            origin: origin.origin,
            authType,
            knownHostsFingerprints: knownHosts.fingerprints,
          },
        })
      })
    } catch (error) {
      if (/UNIQUE constraint failed/.test(String(error?.message))) {
        throw teamError(409, ERROR_CODES.CONFLICT, '该远端来源已经配置了凭据')
      }
      throw error
    }
    return publicCredential(rowById(id))
  }

  function update(actor, credentialId, input = {}) {
    const row = rowById(credentialId)
    if (!row) throw teamError(404, ERROR_CODES.NOT_FOUND, '归档 Git 凭据不存在')
    if (
      input.scheme != null ||
      input.host != null ||
      input.port != null ||
      input.authType != null
    ) {
      if (input.authType != null && input.authType !== row.auth_type) {
        throw teamError(400, ERROR_CODES.INVALID_INPUT, '认证类型创建后不能修改')
      }
      const requestedScheme = String(input.scheme ?? row.scheme)
        .trim()
        .toLowerCase()
      if (input.scheme != null && authTypeForScheme(requestedScheme) !== row.auth_type) {
        throw teamError(400, ERROR_CODES.INVALID_INPUT, '凭据协议创建后不能修改')
      }
      const origin = normalizedOrigin({
        scheme: input.scheme ?? row.scheme,
        host: input.host ?? row.host,
        port: input.port ?? row.port,
      })
      if (
        origin.scheme !== row.scheme ||
        origin.host !== row.host ||
        Number(origin.port) !== Number(row.port)
      ) {
        throw teamError(400, ERROR_CODES.INVALID_INPUT, '凭据来源创建后不能修改')
      }
    }
    const name = input.name == null ? row.name : cleanText(input.name, '凭据名称', 100)
    const username =
      row.auth_type === 'https_token'
        ? cleanText(input.username ?? row.username ?? 'x-access-token', 'HTTPS 用户名', 200)
        : null
    const secretProvided =
      row.auth_type === 'ssh_key' ? input.privateKey != null : input.token != null
    const knownHostsProvided = row.auth_type === 'ssh_key' && input.knownHostsText != null
    if (!secretProvided && !knownHostsProvided && name === row.name && username === row.username) {
      return publicCredential(row)
    }
    const existing = secretProvided ? decrypt(row) : null
    const payload = secretProvided ? credentialPayload(input, row.auth_type, existing) : null
    const knownHosts = knownHostsProvided
      ? parseKnownHosts(input.knownHostsText, row.host, row.port)
      : {
          text: row.known_hosts_text,
          fingerprints: publicKnownHostFingerprints(row.known_hosts_text),
        }
    const version = secretProvided ? Number(row.secret_version) + 1 : Number(row.secret_version)
    const encrypted = payload
      ? encrypt(
          row.id,
          { scheme: row.scheme, host: row.host, port: row.port },
          row.auth_type,
          version,
          payload,
        )
      : null
    const now = new Date().toISOString()
    withTransaction(db, () => {
      db.prepare(`
        UPDATE sync_archive_git_credential
        SET name = ?, username = ?,
            secret_version = COALESCE(?, secret_version),
            secret_iv = COALESCE(?, secret_iv),
            secret_tag = COALESCE(?, secret_tag),
            secret_ciphertext = COALESCE(?, secret_ciphertext),
            known_hosts_text = ?,
            updated_by_user_id = ?, updated_at = ?
        WHERE id = ?
      `).run(
        name,
        username,
        encrypted?.version ?? null,
        encrypted?.iv ?? null,
        encrypted?.tag ?? null,
        encrypted?.ciphertext ?? null,
        knownHosts.text,
        actor.userId,
        now,
        row.id,
      )
      appendAuditEvent(db, {
        actorUserId: actor.userId,
        action: 'archive_git_credential_updated',
        targetType: 'archive_git_credential',
        targetId: row.id,
        detail: {
          origin: `${row.scheme}://${row.host}:${row.port}`,
          authType: row.auth_type,
          changedFields: [
            name !== row.name ? 'name' : null,
            username !== row.username ? 'username' : null,
            secretProvided ? 'secret' : null,
            knownHostsProvided ? 'knownHosts' : null,
          ].filter(Boolean),
          knownHostsFingerprints: knownHosts.fingerprints,
        },
      })
    })
    return publicCredential(rowById(row.id))
  }

  function remove(actor, credentialId) {
    const row = rowById(credentialId)
    if (!row) throw teamError(404, ERROR_CODES.NOT_FOUND, '归档 Git 凭据不存在')
    withTransaction(db, () => {
      db.prepare('DELETE FROM sync_archive_git_credential WHERE id = ?').run(row.id)
      appendAuditEvent(db, {
        actorUserId: actor.userId,
        action: 'archive_git_credential_deleted',
        targetType: 'archive_git_credential',
        targetId: row.id,
        detail: {
          origin: `${row.scheme}://${row.host}:${row.port}`,
          authType: row.auth_type,
        },
      })
    })
    return { ok: true }
  }

  function resolveForRemote(remoteUrl, options = {}) {
    const remote = normalizeGitRemote(remoteUrl, options)
    if (remote.scheme === 'file') {
      throw teamError(409, 'ARCHIVE_REMOTE_UNSUPPORTED', '归档同步不支持本地 file Git 远端')
    }
    const resolvedRemote = {
      ...remote,
      url: formatGitRemote(remote),
    }
    const origin = archiveCredentialOrigin(remote)
    const effectivePort = Number(remote.port) || (remote.scheme === 'ssh' ? 22 : 443)
    const row = db
      .prepare(`
        SELECT *
        FROM sync_archive_git_credential
        WHERE scheme = ? AND host = ? AND port = ?
      `)
      .get(remote.scheme, remote.host, effectivePort)
    if (!row) {
      if (remote.scheme === 'ssh') {
        throw teamError(
          409,
          'ARCHIVE_CREDENTIAL_MISSING',
          `SSH 远端 ${origin} 尚未配置归档只读凭据`,
        )
      }
      return { remote: resolvedRemote, origin, credential: null }
    }
    if (row.auth_type !== authTypeForScheme(remote.scheme)) {
      throw teamError(409, 'ARCHIVE_CREDENTIAL_INVALID', '归档 Git 凭据类型与远端不匹配')
    }
    return {
      remote: resolvedRemote,
      origin,
      credential: {
        id: row.id,
        name: row.name,
        scheme: row.scheme,
        host: row.host,
        port: Number(row.port),
        origin,
        authType: row.auth_type,
        username: row.username || null,
        knownHostsText: row.known_hosts_text || '',
        payload: decrypt(row),
      },
    }
  }

  function createAuthContext(credential) {
    if (!credential) return null
    const dir = fs.mkdtempSync(path.join(authRoot, 'run-'))
    const redact = [
      credential.payload?.token,
      credential.payload?.privateKey,
      credential.payload?.passphrase,
      dir,
    ].filter(Boolean)
    try {
      if (credential.authType === 'https_token') {
        const helperPath =
          process.platform === 'win32'
            ? path.join(dir, 'askpass.cmd')
            : path.join(dir, 'askpass.sh')
        const content =
          process.platform === 'win32'
            ? `@echo off\r\n"${process.execPath}" "${ASKPASS_HELPER}" %*\r\n`
            : `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(ASKPASS_HELPER)} "$@"\n`
        fs.writeFileSync(helperPath, content, { mode: 0o700, encoding: 'utf8' })
        if (process.platform !== 'win32') fs.chmodSync(helperPath, 0o700)
        return {
          dir,
          redact,
          env: {
            GIT_ASKPASS: helperPath,
            GIT_ASKPASS_REQUIRE: 'force',
            TRELLIS_GIT_USERNAME: credential.username || '',
            TRELLIS_GIT_SECRET: credential.payload?.token || '',
          },
          cleanup() {
            fs.rmSync(dir, { recursive: true, force: true })
          },
        }
      }
      const identityFile = path.join(dir, 'identity')
      const knownHostsFile = path.join(dir, 'known_hosts')
      const privateKey = String(credential.payload?.privateKey || '').trimEnd()
      if (!privateKey) {
        throw teamError(409, 'ARCHIVE_CREDENTIAL_INVALID', 'SSH 私钥为空')
      }
      if (!String(credential.knownHostsText || '').trim()) {
        throw teamError(409, 'ARCHIVE_SSH_HOST_UNTRUSTED', 'SSH 来源尚未配置 known_hosts')
      }
      fs.writeFileSync(identityFile, `${privateKey}\n`, { mode: 0o600, encoding: 'utf8' })
      fs.writeFileSync(knownHostsFile, credential.knownHostsText, {
        mode: 0o600,
        encoding: 'utf8',
      })
      if (process.platform !== 'win32') {
        fs.chmodSync(identityFile, 0o600)
        fs.chmodSync(knownHostsFile, 0o600)
      }
      const scriptPath =
        process.platform === 'win32' ? path.join(dir, 'ssh.cmd') : path.join(dir, 'ssh.sh')
      const quote = (value) => (process.platform === 'win32' ? `"${value}"` : shellQuote(value))
      const options = [
        '-o BatchMode=yes',
        '-o ConnectTimeout=15',
        '-o StrictHostKeyChecking=yes',
        `-o GlobalKnownHostsFile=${quote(path.join(dir, 'global_known_hosts'))}`,
        `-o UserKnownHostsFile=${quote(knownHostsFile)}`,
        '-o IdentitiesOnly=yes',
        `-o IdentityFile=${quote(identityFile)}`,
      ]
      fs.writeFileSync(path.join(dir, 'global_known_hosts'), '', {
        mode: 0o600,
        encoding: 'utf8',
      })
      const content =
        process.platform === 'win32'
          ? `@echo off\r\nssh ${options.join(' ')} %*\r\n`
          : `#!/bin/sh\nexec ssh ${options.join(' ')} "$@"\n`
      fs.writeFileSync(scriptPath, content, { mode: 0o700, encoding: 'utf8' })
      if (process.platform !== 'win32') fs.chmodSync(scriptPath, 0o700)
      return {
        dir,
        redact,
        env: {
          GIT_SSH_COMMAND:
            process.platform === 'win32' ? `"${scriptPath}"` : shellQuote(scriptPath),
          GIT_SSH_VARIANT: 'ssh',
        },
        cleanup() {
          fs.rmSync(dir, { recursive: true, force: true })
        },
      }
    } catch (error) {
      fs.rmSync(dir, { recursive: true, force: true })
      throw error
    }
  }

  async function withAuth(credential, callback) {
    const auth = createAuthContext(credential)
    try {
      return await callback(auth)
    } finally {
      auth?.cleanup()
    }
  }

  return {
    keyFile,
    list,
    create,
    update,
    remove,
    resolveForRemote,
    withAuth,
  }
}
