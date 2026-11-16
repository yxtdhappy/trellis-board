import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const SECRETS_VERSION = 1
export const SECRETS_FILENAME = 'plugins.secrets.json'
export const SECRETS_KEY_FILENAME = 'plugins.secrets.key'
const ENC_PREFIX = 'enc:v1:'
const KEY_BYTES = 32
const SECRET_KEY_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/
const SECRET_REF_PATTERN = /^secret:([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)$/
const ENV_REF_PATTERN = /^env:([A-Za-z_][A-Za-z0-9_]*)$/
const INLINE_SENSITIVE_PATTERN =
  /(password|passwd|token|secret|api[_-]?key|private[_-]?key|authorization|cookie|credential)/i

export function defaultSecretsFile(configFile) {
  return path.join(path.dirname(configFile), SECRETS_FILENAME)
}

/** 加密密钥文件与 secrets 文件同目录；缺失时由写入方生成（0600）。 */
export function defaultSecretsKeyFile(secretsFile) {
  return path.join(path.dirname(secretsFile), SECRETS_KEY_FILENAME)
}

function parseJsonWithoutLeak(text, file) {
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${path.basename(file)} 不是合法 JSON`)
  }
}

function assertOwnerOnly(file) {
  if (process.platform === 'win32') return
  const mode = fs.statSync(file).mode & 0o777
  if (mode & 0o077) {
    throw new Error(
      `${path.basename(file)} 权限过宽（${mode.toString(8)}），请执行 chmod 600 ${file}`,
    )
  }
}

function readKeyFile(file) {
  if (!fs.existsSync(file)) return null
  assertOwnerOnly(file)
  const key = fs.readFileSync(file)
  if (key.length !== KEY_BYTES) {
    throw new Error(`${path.basename(file)} 必须是 ${KEY_BYTES} 字节`)
  }
  return key
}

function ensureKeyFile(file) {
  const existing = readKeyFile(file)
  if (existing) return existing
  fs.mkdirSync(path.dirname(file), { recursive: true })
  try {
    fs.writeFileSync(file, crypto.randomBytes(KEY_BYTES), { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
  }
  const created = readKeyFile(file)
  if (!created) throw new Error(`无法创建 ${path.basename(file)}`)
  return created
}

/** AES-256-GCM：enc:v1:<iv>:<tag>:<ciphertext>（均为 base64）。 */
export function encryptSecretValue(plaintext, keyFile) {
  const key = ensureKeyFile(keyFile)
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${ENC_PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`
}

export function decryptSecretValue(value, keyFile) {
  if (typeof value !== 'string' || !value.startsWith(ENC_PREFIX)) return value
  const [iv, tag, ciphertext] = value.slice(ENC_PREFIX.length).split(':')
  if (!iv || !tag || !ciphertext) {
    throw new Error('加密 secret 格式错误，应为 enc:v1:<iv>:<tag>:<ciphertext>')
  }
  const key = readKeyFile(keyFile)
  if (!key) {
    throw new Error(`缺少 ${path.basename(keyFile)}，无法解密 secrets 中的加密条目`)
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'), {
    authTagLength: 16,
  })
  decipher.setAuthTag(Buffer.from(tag, 'base64'))
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8')
}

export function loadSecretsFile(file, { keyFile = null } = {}) {
  if (!file || !fs.existsSync(file)) {
    return { file, keyFile: keyFile || defaultSecretsKeyFile(file), refs: new Map(), warnings: [] }
  }
  assertOwnerOnly(file)
  const raw = parseJsonWithoutLeak(fs.readFileSync(file, 'utf8'), file)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${path.basename(file)} 顶层必须是对象`)
  }
  if (raw.version !== SECRETS_VERSION) {
    throw new Error(`${path.basename(file)} 缺少 version: ${SECRETS_VERSION}`)
  }
  if (!raw.refs || typeof raw.refs !== 'object' || Array.isArray(raw.refs)) {
    throw new Error(`${path.basename(file)} 缺少 refs 对象`)
  }
  const resolvedKeyFile = keyFile || defaultSecretsKeyFile(file)
  const refs = new Map()
  let encrypted = 0
  for (const [key, value] of Object.entries(raw.refs)) {
    if (!SECRET_KEY_PATTERN.test(key)) {
      throw new Error(`${path.basename(file)} 的 refs key 必须形如 scope/key: ${key}`)
    }
    if (typeof value !== 'string' || value === '') {
      throw new Error(`${path.basename(file)} 的 ${key} 必须是非空字符串`)
    }
    if (value.startsWith(ENC_PREFIX)) {
      encrypted += 1
      refs.set(key, decryptSecretValue(value, resolvedKeyFile))
      continue
    }
    refs.set(key, value)
  }
  const warnings = []
  const unknown = Object.keys(raw).filter((key) => key !== 'version' && key !== 'refs')
  if (unknown.length) {
    warnings.push({ kind: 'unknown-top-level', keys: unknown })
  }
  return { file, keyFile: resolvedKeyFile, refs, encrypted, warnings }
}

function readRawSecrets(file) {
  if (!fs.existsSync(file)) return { version: SECRETS_VERSION, refs: {} }
  const raw = parseJsonWithoutLeak(fs.readFileSync(file, 'utf8'), file)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${path.basename(file)} 顶层必须是对象`)
  }
  if (raw.version !== SECRETS_VERSION) {
    throw new Error(`${path.basename(file)} 缺少 version: ${SECRETS_VERSION}`)
  }
  if (!raw.refs || typeof raw.refs !== 'object' || Array.isArray(raw.refs)) {
    throw new Error(`${path.basename(file)} 缺少 refs 对象`)
  }
  return raw
}

function writeRawSecrets(file, raw) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(tmp, file)
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600)
}

/** 写入一条 secret（AES-256-GCM 加密后落盘，原子写 + 0600）。 */
export function writeSecretRef(file, key, plaintext, { keyFile = null } = {}) {
  if (!SECRET_KEY_PATTERN.test(String(key ?? ''))) {
    throw new Error(`secret key 必须形如 scope/key: ${key}`)
  }
  if (typeof plaintext !== 'string' || plaintext === '') {
    throw new Error('secret 值必须是非空字符串')
  }
  const raw = readRawSecrets(file)
  raw.refs[key] = encryptSecretValue(plaintext, keyFile || defaultSecretsKeyFile(file))
  writeRawSecrets(file, raw)
  return { key, encrypted: true }
}

export function deleteSecretRef(file, key) {
  if (!fs.existsSync(file)) return { key, deleted: false }
  const raw = readRawSecrets(file)
  if (!Object.hasOwn(raw.refs, key)) return { key, deleted: false }
  delete raw.refs[key]
  writeRawSecrets(file, raw)
  return { key, deleted: true }
}

function isSensitivePath(at) {
  const segment =
    String(at)
      .split('.')
      .at(-1)
      ?.replace(/\[\d+\]$/, '') ?? ''
  return INLINE_SENSITIVE_PATTERN.test(segment)
}

export function resolveConfigReferences(
  value,
  { env = process.env, refs = new Map(), missing = [], sources = {} } = {},
  at = '',
) {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    const secretMatch = SECRET_REF_PATTERN.exec(trimmed)
    if (secretMatch) {
      const key = secretMatch[1]
      if (!refs.has(key)) {
        missing.push(`secret:${key}`)
        return null
      }
      if (at) sources[at] = 'secret'
      return refs.get(key)
    }
    if (trimmed.startsWith('secret:')) {
      throw new Error('secret 引用格式错误，应为 secret:scope/key')
    }
    const envMatch = ENV_REF_PATTERN.exec(trimmed)
    if (envMatch) {
      const name = envMatch[1]
      if (at) sources[at] = 'env'
      const resolved = env[name]
      if (resolved == null || resolved === '') {
        missing.push(name)
        return null
      }
      return resolved
    }
    if (at && value !== '' && isSensitivePath(at)) {
      sources[at] = 'inline'
    }
    return value
  }
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      resolveConfigReferences(
        item,
        {
          env,
          refs,
          missing,
          sources,
        },
        at ? `${at}[${index}]` : `[${index}]`,
      ),
    )
  }
  if (value && typeof value === 'object') {
    const result = {}
    for (const [key, item] of Object.entries(value)) {
      result[key] = resolveConfigReferences(
        item,
        {
          env,
          refs,
          missing,
          sources,
        },
        at ? `${at}.${key}` : key,
      )
    }
    return result
  }
  return value
}

export function summarizeSources(sources) {
  const values = [...new Set(Object.values(sources))]
  if (!values.length) return 'none'
  if (values.length === 1) return values[0]
  return 'mixed'
}

export function inlineSecretFields(sources) {
  return Object.entries(sources)
    .filter(([, source]) => source === 'inline')
    .map(([field]) => field)
}
