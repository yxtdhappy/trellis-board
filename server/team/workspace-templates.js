import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readZipEntries } from '../../agent/zip.js'
import { ERROR_CODES, teamError } from './errors.js'

const serverDir = path.dirname(fileURLToPath(import.meta.url))

export const defaultWorkspaceTemplateDir = path.resolve(serverDir, '../templates/workspace')

const MANIFEST_FILE = 'manifest.json'
const ARCHIVE_FILE = 'workspace-template.zip'
const ARCHIVE_MANIFEST_FILE = 'template-manifest.json'
const SUPPORTED_SCHEMA_VERSIONS = new Set([1])
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const TOOL_PATTERN = /^\.[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

const templateCache = new Map()

function readJsonFile(file) {
  let source
  try {
    source = fs.readFileSync(file, 'utf8')
  } catch {
    throw new Error(`无法读取 workspace 模板清单: ${path.basename(file)}`)
  }
  try {
    return JSON.parse(source)
  } catch {
    throw new Error(`workspace 模板清单不是合法 JSON: ${path.basename(file)}`)
  }
}

function requireString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`workspace 模板清单缺少 ${label}`)
  }
  return value.trim()
}

function requireVersion(value, label) {
  const version = requireString(value, label)
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`workspace 模板清单 ${label} 格式无效`)
  }
  return version
}

function requireTools(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`workspace 模板清单 ${label} 必须是非空数组`)
  }
  const tools = []
  for (const item of value) {
    const tool = requireString(item, label)
    if (!TOOL_PATTERN.test(tool)) {
      throw new Error(`workspace 模板清单 ${label} 包含无效目录`)
    }
    if (tools.includes(tool)) {
      throw new Error(`workspace 模板清单 ${label} 不能重复`)
    }
    tools.push(tool)
  }
  return tools
}

function requireBaseFiles(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('workspace 模板清单 baseFiles 必须是非空数组')
  }
  const files = []
  for (const item of value) {
    const file = requireString(item, 'baseFiles')
    if (file.includes('/') || file.includes('\\') || file === '.' || file === '..') {
      throw new Error('workspace 模板清单 baseFiles 只能包含顶层路径')
    }
    if (!files.includes(file)) files.push(file)
  }
  return files
}

function requireFiles(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('workspace 模板清单 files 必须是对象')
  }
  const files = {}
  for (const [name, hash] of Object.entries(value)) {
    if (!name || name.startsWith('/') || name.includes('\\') || name.split('/').includes('..')) {
      throw new Error('workspace 模板清单 files 包含无效路径')
    }
    if (typeof hash !== 'string' || !SHA256_PATTERN.test(hash)) {
      throw new Error('workspace 模板清单 files 包含无效哈希')
    }
    files[name] = hash
  }
  if (Object.keys(files).length === 0) {
    throw new Error('workspace 模板清单 files 不能为空')
  }
  return files
}

function normalizeManifest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('workspace 模板清单不是对象')
  }
  const sha256 = requireString(raw.sha256, 'sha256').toLowerCase()
  if (!SHA256_PATTERN.test(sha256)) {
    throw new Error('workspace 模板清单 sha256 格式无效')
  }
  const tools = requireTools(raw.tools, 'tools')
  const defaultTools = requireTools(raw.defaultTools, 'defaultTools')
  if (defaultTools.some((tool) => !tools.includes(tool))) {
    throw new Error('workspace 模板清单 defaultTools 必须包含在 tools 中')
  }
  const files = requireFiles(raw.files)
  const baseFiles = requireBaseFiles(raw.baseFiles)
  const schemaVersion = raw.schemaVersion == null ? 1 : Number(raw.schemaVersion)
  if (!SUPPORTED_SCHEMA_VERSIONS.has(schemaVersion)) {
    throw new Error(`workspace 模板清单 schemaVersion 不受支持: ${raw.schemaVersion}`)
  }
  for (const item of [...baseFiles, ...tools]) {
    const present = Object.keys(files).some((name) => {
      const top = name.split('/')[0]
      return top === item
    })
    if (!present) {
      throw new Error(`workspace 模板归档缺少 ${item}`)
    }
  }
  return {
    schemaVersion,
    version: requireVersion(raw.version, 'version'),
    templateVersion: requireVersion(raw.templateVersion || raw.version, 'templateVersion'),
    cliVersion: raw.cliVersion == null ? null : requireVersion(raw.cliVersion, 'cliVersion'),
    projectVersion:
      raw.projectVersion == null ? null : requireVersion(raw.projectVersion, 'projectVersion'),
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : null,
    sha256,
    bytes: Number(raw.bytes) || 0,
    entryCount: Number(raw.entryCount) || 0,
    fileCount: Object.keys(files).length,
    defaultTools,
    tools,
    baseFiles,
    files,
  }
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

function readArchiveFiles(archive) {
  let entries
  try {
    entries = readZipEntries(archive)
  } catch (error) {
    throw new Error(`workspace 模板归档无法解析: ${error.message}`)
  }
  const files = new Map()
  for (const entry of entries) {
    if (entry.isDirectory || entry.name === ARCHIVE_MANIFEST_FILE) continue
    files.set(entry.name, sha256(entry.data))
  }
  return { files, entryCount: entries.length }
}

function validateArchiveFiles(archive, manifest) {
  const { files, entryCount } = readArchiveFiles(archive)
  if (manifest.entryCount && manifest.entryCount !== entryCount) {
    throw new Error(
      `workspace 模板归档条目数与清单不一致: 清单 ${manifest.entryCount}，归档 ${entryCount}`,
    )
  }
  const expected = manifest.files
  const missing = Object.keys(expected).filter((name) => !files.has(name))
  const extra = [...files.keys()].filter((name) => !Object.hasOwn(expected, name))
  const mismatched = Object.keys(expected).filter(
    (name) => files.has(name) && files.get(name) !== expected[name],
  )
  const describe = (names) =>
    names.slice(0, 3).join(', ') + (names.length > 3 ? ` 等 ${names.length} 个` : '')
  if (missing.length) {
    throw new Error(`workspace 模板归档缺少清单文件: ${describe(missing)}`)
  }
  if (extra.length) {
    throw new Error(`workspace 模板归档包含清单外文件: ${describe(extra)}`)
  }
  if (mismatched.length) {
    throw new Error(`workspace 模板文件哈希与清单不一致: ${describe(mismatched)}`)
  }
}

function loadTemplate(rootDir) {
  const manifestPath = path.join(rootDir, MANIFEST_FILE)
  const archivePath = path.join(rootDir, ARCHIVE_FILE)
  const manifest = normalizeManifest(readJsonFile(manifestPath))
  let archive
  try {
    archive = fs.readFileSync(archivePath)
  } catch {
    throw new Error(`无法读取 workspace 模板归档: ${ARCHIVE_FILE}`)
  }
  const actual = sha256(archive)
  if (actual !== manifest.sha256) {
    throw new Error('workspace 模板归档 SHA-256 与清单不一致')
  }
  if (manifest.bytes && manifest.bytes !== archive.length) {
    throw new Error('workspace 模板归档大小与清单不一致')
  }
  validateArchiveFiles(archive, manifest)
  return Object.freeze({
    manifest,
    archive,
    sha256: actual,
    size: archive.length,
    etag: `"${actual}"`,
    manifestEtag: `"${actual}-manifest"`,
  })
}

export function readWorkspaceTemplate({ rootDir = defaultWorkspaceTemplateDir } = {}) {
  const key = path.resolve(rootDir)
  if (!templateCache.has(key)) {
    templateCache.set(key, loadTemplate(key))
  }
  return templateCache.get(key)
}

export function clearWorkspaceTemplateCache() {
  templateCache.clear()
}

export function publicWorkspaceTemplateManifest(template) {
  const { manifest } = template
  return {
    schemaVersion: manifest.schemaVersion,
    version: manifest.version,
    templateVersion: manifest.templateVersion,
    cliVersion: manifest.cliVersion,
    projectVersion: manifest.projectVersion,
    createdAt: manifest.createdAt,
    sha256: template.sha256,
    bytes: template.size,
    entryCount: manifest.entryCount,
    fileCount: manifest.fileCount,
    defaultTools: [...manifest.defaultTools],
    tools: [...manifest.tools],
    baseFiles: [...manifest.baseFiles],
    files: Object.keys(manifest.files).sort(),
  }
}

function forbidden(message) {
  return teamError(403, ERROR_CODES.FORBIDDEN, message)
}

export function authorizeWorkspaceTemplate(
  db,
  { teamId, userId = null, systemAdmin = false } = {},
) {
  const id = String(teamId || '').trim()
  if (!id) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, '缺少团队 ID')
  }
  if (!userId && !systemAdmin) {
    throw teamError(401, ERROR_CODES.AUTH_REQUIRED, '需要登录')
  }
  const team = db.prepare('SELECT id, status FROM team WHERE id = ?').get(id)
  if (!team) {
    throw teamError(404, ERROR_CODES.NOT_FOUND, '团队不存在')
  }
  if (systemAdmin) {
    if (team.status !== 'active') {
      throw forbidden('团队已停用')
    }
    return { teamId: id, role: 'admin', via: 'system_admin' }
  }
  const membership = db
    .prepare('SELECT role FROM team_member WHERE team_id = ? AND user_id = ?')
    .get(id, userId)
  if (!membership) {
    throw forbidden('无权下载该团队模板')
  }
  if (team.status !== 'active') {
    throw forbidden('团队已停用')
  }
  return { teamId: id, role: membership.role, via: 'member' }
}
