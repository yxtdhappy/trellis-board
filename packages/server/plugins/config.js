import fs from 'node:fs'
import {
  defaultSecretsFile,
  inlineSecretFields,
  loadSecretsFile,
  resolveConfigReferences,
  summarizeSources,
} from './secrets.js'

const SENSITIVE_KEY_PATTERN = /(token|password|secret|apikey|api_key|credential)/i

export function nowIso() {
  return new Date().toISOString()
}

function redactValue(key, value) {
  if (SENSITIVE_KEY_PATTERN.test(key)) {
    if (value && typeof value === 'object') return redactConfig(value)
    return '***'
  }
  if (value && typeof value === 'object') {
    return Array.isArray(value)
      ? value.map((item) => (item && typeof item === 'object' ? redactConfig(item) : item))
      : redactConfig(value)
  }
  return value
}

export function redactConfig(config) {
  if (!config || typeof config !== 'object') return config
  const result = {}
  for (const [key, value] of Object.entries(config)) {
    result[key] = redactValue(key, value)
  }
  return result
}

/**
 * 生成与键序无关的配置签名，用于判断 reload 时配置是否真的变了。
 * 值里可能有 null（缺失的 secret/env 引用），必须与 undefined 区分开。
 */

export function configSignature(value) {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(configSignature).join(',')}]`
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${configSignature(value[key])}`)
    .join(',')}}`
}

export function loadPluginConfigFile(file, { env = process.env, secretsFile } = {}) {
  if (!fs.existsSync(file)) return { plugins: [], missing: [], warnings: [] }
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    throw new Error('plugins.json 不是合法 JSON')
  }
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.plugins)) {
    throw new Error('plugins.json 必须包含 plugins 数组')
  }
  const secrets = loadSecretsFile(
    secretsFile || env.TRELLIS_BOARD_SECRETS_FILE || defaultSecretsFile(file),
  )
  const warnings = secrets.warnings.map((warning) => ({ ...warning }))
  const missing = []
  const plugins = raw.plugins.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`plugins.json 第 ${index + 1} 项不是对象`)
    }
    const id = String(entry.id || '').trim()
    if (!id) throw new Error(`plugins.json 第 ${index + 1} 项缺少 id`)
    if (!/^[A-Za-z0-9._-]+$/.test(id)) {
      throw new Error(`插件 id 只能包含字母、数字、点、下划线与中划线: ${id}`)
    }
    const entryMissing = []
    const sources = {}
    const config = resolveConfigReferences(entry.config ?? {}, {
      env,
      refs: secrets.refs,
      missing: entryMissing,
      sources,
    })
    const inline = inlineSecretFields(sources)
    if (inline.length) {
      warnings.push({ kind: 'inline-secret', id, fields: inline })
    }
    missing.push({
      id,
      names: entryMissing.filter((name, at) => entryMissing.indexOf(name) === at),
    })
    const sortValue = entry.sort === undefined || entry.sort === null ? null : Number(entry.sort)
    if (sortValue !== null && !Number.isFinite(sortValue)) {
      throw new Error(`插件 ${id} 的 sort 必须是数字`)
    }
    return {
      id,
      module: String(entry.module || '').trim(),
      enabled: entry.enabled !== false,
      sort: sortValue,
      version: entry.version == null ? undefined : String(entry.version),
      command: entry.command ? String(entry.command) : null,
      args: Array.isArray(entry.args) ? entry.args.map(String) : null,
      config: config ?? {},
      configSource: summarizeSources(sources),
      allowMissingSecrets: entry.allowMissingSecrets === true,
    }
  })
  return { plugins, missing, warnings, secretsFile: secrets.file }
}
