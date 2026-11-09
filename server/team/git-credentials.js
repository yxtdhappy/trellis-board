import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { withTransaction } from '../database.js'
import { appendAuditEvent } from './audit.js'
import { ERROR_CODES, teamError } from './errors.js'
import { resolveTeamScope } from './teams.js'

const AUTH_TYPES = new Set(['https_token', 'ssh_key'])
const KEY_FILE = 'git-credentials.key'

function cleanText(value, label, max, { required = true } = {}) {
  const text = String(value || '').trim()
  if (required && !text) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, `${label}不能为空`)
  }
  if (Array.from(text).length > max) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, `${label}不能超过 ${max} 个字符`)
  }
  if (text.includes('\0')) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, `${label}包含非法字符`)
  }
  if (/[\r\n]/.test(text)) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, `${label}不能包含换行`)
  }
  return text
}

function cleanSecret(value, label, max, { required = true, allowNewlines = false } = {}) {
  const text = String(value || '')
  if (required && !text.trim()) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, `${label}不能为空`)
  }
  if (Buffer.byteLength(text, 'utf8') > max) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, `${label}超过大小限制`)
  }
  if (text.includes('\0')) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, `${label}包含非法字符`)
  }
  if (!allowNewlines && /[\r\n]/.test(text)) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, `${label}不能包含换行`)
  }
  return text
}

export function normalizeCredentialHost(value) {
  const raw = String(value || '').trim()
  if (!raw || raw.length > 253 || raw.startsWith('-') || /[\/@\s?#]/.test(raw)) {
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

function authTypeForRemote(remote) {
  if (remote.scheme === 'https') return 'https_token'
  if (remote.scheme === 'ssh') return 'ssh_key'
  return null
}

function assertCredentialMatchesRemote(row, remote) {
  const expectedType = authTypeForRemote(remote)
  if (!expectedType || row.auth_type !== expectedType || row.host !== remote.host) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, 'Git 凭据与远端主机或认证类型不匹配')
  }
}

function credentialRow(db, credentialId) {
  return (
    db
      .prepare(`
    SELECT c.*, t.name AS team_name
    FROM git_credential c
    JOIN team t ON t.id = c.team_id
    WHERE c.id = ?
  `)
      .get(credentialId) || null
  )
}

function projectUsageRows(db, credentialIds) {
  const ids = [...new Set(credentialIds.filter(Boolean))]
  if (!ids.length) return []
  return db
    .prepare(`
    SELECT p.git_credential_id, p.repository_id, r.name
    FROM team_project p
    JOIN repositories r ON r.id = p.repository_id
    WHERE p.git_credential_id IN (${ids.map(() => '?').join(', ')})
    ORDER BY r.name COLLATE NOCASE
  `)
    .all(...ids)
}

function publicCredential(row, projects = []) {
  return {
    id: row.id,
    teamId: row.team_id,
    teamName: row.team_name || null,
    name: row.name,
    host: row.host,
    authType: row.auth_type,
    username: row.username || null,
    publicKeyFingerprint: row.public_key_fingerprint || null,
    projectCount: projects.length,
    projects: projects.map((project) => ({
      id: project.repository_id,
      name: project.name,
    })),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function manageableTeamIds(db, actor) {
  if (actor?.systemAdmin) {
    return db
      .prepare("SELECT id FROM team WHERE status = 'active' ORDER BY id")
      .all()
      .map((row) => row.id)
  }
  return [
    ...new Set(
      (actor?.teams || [])
        .filter((team) => team.role === 'admin' && team.status === 'active')
        .map((team) => team.id),
    ),
  ]
}

function requireCredentialManager(db, actor, teamId) {
  const id = String(teamId || '').trim()
  if (!id || id === 'all') {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, '请先选择目标团队')
  }
  return resolveTeamScope(db, actor, id, { adminOnly: true })
}

function payloadFromInput(input, authType, existing = null) {
  if (authType === 'https_token') {
    const token = cleanSecret(input.token, '访问令牌', 8192, {
      required: !existing,
    })
    if (!token && existing) return existing
    return { token }
  }

  const privateKey = cleanSecret(input.privateKey, 'SSH 私钥', 32 * 1024, {
    required: !existing,
    allowNewlines: true,
  })
  const passphrase =
    input.passphrase == null
      ? ''
      : cleanSecret(input.passphrase, 'SSH 私钥口令', 1024, { required: false })
  if (!privateKey && existing) {
    return passphrase ? { ...existing, passphrase } : existing
  }
  if (!/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(privateKey)) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, 'SSH 私钥格式无效')
  }
  return { privateKey, passphrase }
}

export function createGitCredentialService({ db, dataDir }) {
  const keyFile = path.join(dataDir, KEY_FILE)

  function readMasterKey({ create = false } = {}) {
    fs.mkdirSync(dataDir, { recursive: true })
    try {
      const key = fs.readFileSync(keyFile)
      if (key.length !== 32) {
        throw teamError(503, 'GIT_CREDENTIAL_DECRYPT_FAILED', 'Git 凭据主密钥格式无效')
      }
      return key
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      if (!create) {
        throw teamError(503, 'GIT_CREDENTIAL_KEY_MISSING', 'Git 凭据主密钥缺失，已有凭据无法解密')
      }
      const key = crypto.randomBytes(32)
      try {
        // shortcut: Windows 继承 data 目录 ACL，POSIX 使用 0600；跨平台密钥库不作为首版范围。
        fs.writeFileSync(keyFile, key, { flag: 'wx', mode: 0o600 })
        return key
      } catch (writeError) {
        if (writeError?.code === 'EEXIST') return readMasterKey({ create: false })
        throw writeError
      }
    }
  }

  function credentialAad({ id, teamId, host, authType, version = 1 }) {
    return Buffer.from(`git-credential:${id}:${version}:${teamId}:${host}:${authType}`, 'utf8')
  }

  function encryptSecret(id, value, metadata) {
    const hasRows =
      Number(db.prepare('SELECT COUNT(*) AS count FROM git_credential').get().count) > 0
    const key = readMasterKey({ create: !hasRows })
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(
      credentialAad({
        id,
        teamId: metadata.teamId,
        host: metadata.host,
        authType: metadata.authType,
      }),
    )
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
    return {
      version: 1,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    }
  }

  function decryptSecret(row) {
    const key = readMasterKey({ create: false })
    try {
      const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        key,
        Buffer.from(row.secret_iv, 'base64'),
      )
      decipher.setAAD(
        credentialAad({
          id: row.id,
          teamId: row.team_id,
          host: row.host,
          authType: row.auth_type,
          version: row.secret_version,
        }),
      )
      decipher.setAuthTag(Buffer.from(row.secret_tag, 'base64'))
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(row.secret_ciphertext, 'base64')),
        decipher.final(),
      ]).toString('utf8')
      return JSON.parse(plaintext)
    } catch {
      throw teamError(503, 'GIT_CREDENTIAL_DECRYPT_FAILED', 'Git 凭据无法解密，请检查或恢复主密钥')
    }
  }

  function list(actor, requestedTeamId = null) {
    const requested = String(requestedTeamId || '').trim()
    const teamIds =
      requested && requested !== 'all'
        ? [requireCredentialManager(db, actor, requested)]
        : manageableTeamIds(db, actor)
    if (!teamIds.length) return []
    const rows = db
      .prepare(`
      SELECT c.*, t.name AS team_name
      FROM git_credential c
      JOIN team t ON t.id = c.team_id
      WHERE c.team_id IN (${teamIds.map(() => '?').join(', ')})
      ORDER BY t.name COLLATE NOCASE, c.name COLLATE NOCASE
    `)
      .all(...teamIds)
    const usage = projectUsageRows(
      db,
      rows.map((row) => row.id),
    )
    const byCredential = new Map()
    for (const project of usage) {
      if (!byCredential.has(project.git_credential_id)) {
        byCredential.set(project.git_credential_id, [])
      }
      byCredential.get(project.git_credential_id).push(project)
    }
    return rows.map((row) => publicCredential(row, byCredential.get(row.id) || []))
  }

  function create(actor, input = {}) {
    const teamId = requireCredentialManager(db, actor, input.teamId)
    const name = cleanText(input.name, '凭据名称', 80)
    const host = normalizeCredentialHost(input.host)
    const authType = String(input.authType || '').trim()
    if (!AUTH_TYPES.has(authType)) {
      throw teamError(400, ERROR_CODES.INVALID_INPUT, 'Git 凭据类型无效')
    }
    const username =
      authType === 'https_token' ? cleanText(input.username, 'HTTPS 用户名', 200) : null
    const payload = payloadFromInput(input, authType)
    const id = crypto.randomUUID()
    const encrypted = encryptSecret(id, payload, {
      teamId,
      host,
      authType,
    })
    const now = new Date().toISOString()
    try {
      withTransaction(db, () => {
        db.prepare(`
          INSERT INTO git_credential(
            id, team_id, name, host, auth_type, username, public_key_fingerprint,
            secret_version, secret_iv, secret_tag, secret_ciphertext,
            created_by, updated_by, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id,
          teamId,
          name,
          host,
          authType,
          username,
          encrypted.version,
          encrypted.iv,
          encrypted.tag,
          encrypted.ciphertext,
          actor.userId,
          actor.userId,
          now,
          now,
        )
        appendAuditEvent(db, {
          actorUserId: actor.userId,
          teamId,
          action: 'git_credential_created',
          targetType: 'git_credential',
          targetId: id,
          detail: { name, host, authType },
        })
      })
    } catch (error) {
      if (/UNIQUE constraint failed/.test(String(error?.message))) {
        throw teamError(409, ERROR_CODES.CONFLICT, '同一团队内的凭据名称不能重复')
      }
      throw error
    }
    return publicCredential(credentialRow(db, id))
  }

  function update(actor, credentialId, input = {}) {
    const row = credentialRow(db, credentialId)
    if (!row) throw teamError(404, ERROR_CODES.NOT_FOUND, 'Git 凭据不存在')
    requireCredentialManager(db, actor, row.team_id)
    if (input.host != null && normalizeCredentialHost(input.host) !== row.host) {
      throw teamError(400, ERROR_CODES.INVALID_INPUT, 'Git 凭据主机创建后不能修改')
    }
    if (input.authType != null && input.authType !== row.auth_type) {
      throw teamError(400, ERROR_CODES.INVALID_INPUT, 'Git 凭据类型创建后不能修改')
    }
    const name = input.name == null ? row.name : cleanText(input.name, '凭据名称', 80)
    const username =
      row.auth_type === 'https_token'
        ? cleanText(input.username ?? row.username, 'HTTPS 用户名', 200)
        : null
    const existingPayload =
      input.token || input.privateKey || input.passphrase ? decryptSecret(row) : null
    const payload = existingPayload ? payloadFromInput(input, row.auth_type, existingPayload) : null
    const encrypted = payload
      ? encryptSecret(row.id, payload, {
          teamId: row.team_id,
          host: row.host,
          authType: row.auth_type,
        })
      : null
    const changedFields = [
      name !== row.name ? 'name' : null,
      username !== row.username ? 'username' : null,
      payload ? 'secret' : null,
    ].filter(Boolean)
    if (!changedFields.length) return publicCredential(row)
    const now = new Date().toISOString()
    try {
      withTransaction(db, () => {
        db.prepare(`
          UPDATE git_credential
          SET name = ?, username = ?,
              secret_version = COALESCE(?, secret_version),
              secret_iv = COALESCE(?, secret_iv),
              secret_tag = COALESCE(?, secret_tag),
              secret_ciphertext = COALESCE(?, secret_ciphertext),
              updated_by = ?, updated_at = ?
          WHERE id = ?
        `).run(
          name,
          username,
          encrypted?.version ?? null,
          encrypted?.iv ?? null,
          encrypted?.tag ?? null,
          encrypted?.ciphertext ?? null,
          actor.userId,
          now,
          row.id,
        )
        appendAuditEvent(db, {
          actorUserId: actor.userId,
          teamId: row.team_id,
          action: 'git_credential_updated',
          targetType: 'git_credential',
          targetId: row.id,
          detail: { name, host: row.host, authType: row.auth_type, changedFields },
        })
      })
    } catch (error) {
      if (/UNIQUE constraint failed/.test(String(error?.message))) {
        throw teamError(409, ERROR_CODES.CONFLICT, '同一团队内的凭据名称不能重复')
      }
      throw error
    }
    return publicCredential(credentialRow(db, row.id))
  }

  function remove(actor, credentialId) {
    const row = credentialRow(db, credentialId)
    if (!row) throw teamError(404, ERROR_CODES.NOT_FOUND, 'Git 凭据不存在')
    requireCredentialManager(db, actor, row.team_id)
    const projects = projectUsageRows(db, [row.id])
    if (projects.length) {
      throw teamError(409, 'GIT_CREDENTIAL_IN_USE', 'Git 凭据仍被项目引用，不能删除', {
        details: {
          projects: projects.map((project) => ({
            id: project.repository_id,
            name: project.name,
          })),
        },
      })
    }
    withTransaction(db, () => {
      db.prepare('DELETE FROM git_credential WHERE id = ?').run(row.id)
      appendAuditEvent(db, {
        actorUserId: actor.userId,
        teamId: row.team_id,
        action: 'git_credential_deleted',
        targetType: 'git_credential',
        targetId: row.id,
        detail: { name: row.name, host: row.host, authType: row.auth_type },
      })
    })
    return { ok: true }
  }

  function resolveForRemote(actor, { teamId, credentialId, remote }) {
    const id = String(credentialId || '').trim()
    if (!id) return null
    const row = credentialRow(db, id)
    if (!row) throw teamError(404, ERROR_CODES.NOT_FOUND, 'Git 凭据不存在')
    requireCredentialManager(db, actor, row.team_id)
    if (row.team_id !== teamId) {
      throw teamError(403, ERROR_CODES.FORBIDDEN, '项目不能使用其他团队的 Git 凭据')
    }
    assertCredentialMatchesRemote(row, remote)
    return {
      id: row.id,
      teamId: row.team_id,
      name: row.name,
      host: row.host,
      authType: row.auth_type,
      username: row.username,
      payload: decryptSecret(row),
    }
  }

  function resolveProjectCredential(project, remote) {
    if (!project?.credentialId) return null
    const row = credentialRow(db, project.credentialId)
    if (!row || row.team_id !== project.teamId) {
      throw teamError(409, 'GIT_CREDENTIAL_INVALID', '项目绑定的 Git 凭据无效')
    }
    assertCredentialMatchesRemote(row, remote)
    return {
      id: row.id,
      teamId: row.team_id,
      name: row.name,
      host: row.host,
      authType: row.auth_type,
      username: row.username,
      payload: decryptSecret(row),
    }
  }

  function listSshKnownHosts(teamId, host, port) {
    return db
      .prepare(`
      SELECT algorithm, key_base64, fingerprint_sha256, known_hosts_line
      FROM git_ssh_known_host
      WHERE team_id = ? AND host = ? AND port = ?
      ORDER BY algorithm
    `)
      .all(teamId, host, Number(port) || 22)
  }

  function trustSshHost(actor, { teamId, host, port, entries, replaced = false }) {
    requireCredentialManager(db, actor, teamId)
    const now = new Date().toISOString()
    withTransaction(db, () => {
      db.prepare(`
        DELETE FROM git_ssh_known_host
        WHERE team_id = ? AND host = ? AND port = ?
      `).run(teamId, host, port)
      const insert = db.prepare(`
        INSERT INTO git_ssh_known_host(
          team_id, host, port, algorithm, key_base64, fingerprint_sha256,
          known_hosts_line, trusted_by, trusted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      for (const entry of entries) {
        insert.run(
          teamId,
          host,
          port,
          entry.algorithm,
          entry.keyBase64,
          entry.fingerprintSha256,
          entry.knownHostsLine,
          actor.userId,
          now,
        )
      }
      appendAuditEvent(db, {
        actorUserId: actor.userId,
        teamId,
        action: replaced ? 'git_ssh_host_replaced' : 'git_ssh_host_trusted',
        targetType: 'git_ssh_host',
        targetId: `${host}:${port}`,
        detail: {
          host,
          port,
          fingerprints: entries.map((entry) => entry.fingerprintSha256),
        },
      })
    })
  }

  return {
    keyFile,
    list,
    create,
    update,
    remove,
    resolveForRemote,
    resolveProjectCredential,
    listSshKnownHosts,
    trustSshHost,
  }
}
