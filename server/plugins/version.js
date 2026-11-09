/**
 * 版本与清单校验。
 *
 * 三条版本线互不替代：
 * - apiVersion：宿主↔插件协议版本（整数）
 * - version：插件自身 semver
 * - engines.board：插件声明可运行的宿主 semver 范围
 *
 * engines.board 只实现最小集合（>=、<=、^、~、精确、*，可用空格组合为 AND），
 * 不支持 `||` 与连字符区间；写法非法直接判为 invalid-manifest。
 */

const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

const PARTIAL_PATTERN = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/

export const MANIFEST_FAILURE_REASONS = Object.freeze([
  'invalid-manifest',
  'id-mismatch',
  'invalid-version',
  '1006',
  'board-too-old',
  'board-too-new',
  'pinned-mismatch',
])

export function parseSemver(value) {
  if (typeof value !== 'string') return null
  const match = SEMVER_PATTERN.exec(value.trim())
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  }
}

export function isValidSemver(value) {
  return parseSemver(value) !== null
}

function compareIdentifier(left, right) {
  const leftNumber = /^\d+$/.test(left)
  const rightNumber = /^\d+$/.test(right)
  if (leftNumber && rightNumber) return Number(left) - Number(right)
  if (leftNumber) return -1
  if (rightNumber) return 1
  return left < right ? -1 : left > right ? 1 : 0
}

export function compareSemver(left, right) {
  const a = typeof left === 'string' ? parseSemver(left) : left
  const b = typeof right === 'string' ? parseSemver(right) : right
  if (!a || !b) throw new Error('无法比较非 semver 版本')
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] - b[key]
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0
  if (a.prerelease.length === 0) return 1
  if (b.prerelease.length === 0) return -1
  const length = Math.max(a.prerelease.length, b.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const leftPart = a.prerelease[index]
    const rightPart = b.prerelease[index]
    if (leftPart === undefined) return -1
    if (rightPart === undefined) return 1
    const compared = compareIdentifier(leftPart, rightPart)
    if (compared !== 0) return compared
  }
  return 0
}

function parsePartial(value) {
  const match = PARTIAL_PATTERN.exec(value.trim())
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: match[2] === undefined ? null : Number(match[2]),
    patch: match[3] === undefined ? null : Number(match[3]),
  }
}

function upperBoundForCaret(partial) {
  const { major, minor, patch } = partial
  if (major > 0) return `${major + 1}.0.0`
  if ((minor ?? 0) > 0) return `0.${(minor ?? 0) + 1}.0`
  return `0.0.${(patch ?? 0) + 1}`
}

function upperBoundForTilde(partial) {
  const { major, minor } = partial
  if (minor === null) return `${major + 1}.0.0`
  return `${major}.${minor + 1}.0`
}

function lowerBoundForPartial(partial) {
  return `${partial.major}.${partial.minor ?? 0}.${partial.patch ?? 0}`
}

/**
 * 判断 version 是否满足 range。返回 { ok, reason }：
 * reason 为 board-too-old / board-too-new 时分别表示宿主版本低于下界 / 高于上界。
 */
export function satisfiesRange(range, version) {
  if (typeof range !== 'string' || !range.trim()) {
    return { ok: false, reason: 'invalid-manifest' }
  }
  const trimmed = range.trim()
  if (trimmed === '*') return { ok: true }
  if (trimmed.includes('||') || /\s-\s/.test(trimmed)) {
    return { ok: false, reason: 'invalid-manifest' }
  }
  const parsedVersion = parseSemver(version)
  if (!parsedVersion) return { ok: false, reason: 'invalid-version' }

  const atoms = trimmed.split(/\s+/).filter(Boolean)
  let tooOld = false
  let tooNew = false

  for (const atom of atoms) {
    const match = /^(>=|<=|>|<|\^|~|=)?\s*v?(.+)$/.exec(atom)
    if (!match) return { ok: false, reason: 'invalid-manifest' }
    const operator = match[1] || '='
    const partial = parsePartial(match[2])
    if (!partial) return { ok: false, reason: 'invalid-manifest' }
    const lower = lowerBoundForPartial(partial)
    const compared = compareSemver(parsedVersion, lower)

    if (operator === '>=') {
      if (compared < 0) tooOld = true
    } else if (operator === '<=') {
      if (compared > 0) tooNew = true
    } else if (operator === '>') {
      if (compared <= 0) tooOld = true
    } else if (operator === '<') {
      if (compared >= 0) tooNew = true
    } else if (operator === '^') {
      if (compared < 0) tooOld = true
      const upper = upperBoundForCaret(partial)
      if (compareSemver(parsedVersion, upper) >= 0) tooNew = true
    } else if (operator === '~') {
      if (compared < 0) tooOld = true
      const upper = upperBoundForTilde(partial)
      if (compareSemver(parsedVersion, upper) >= 0) tooNew = true
    } else if (compared !== 0) {
      if (compared < 0) tooOld = true
      else tooNew = true
    }
  }

  if (tooOld) return { ok: false, reason: 'board-too-old' }
  if (tooNew) return { ok: false, reason: 'board-too-new' }
  return { ok: true }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function stringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

export const DEFAULT_MANIFEST_FILENAME = 'plugin.json'

/**
 * 校验 plugin.json。返回 { ok: true, manifest } 或 { ok: false, reason }。
 * 校验顺序与失败标记见设计文档 8.6。
 */
export function validateManifest(
  raw,
  { configId, hostVersion, hostApiVersion, pinnedVersion } = {},
) {
  if (!isPlainObject(raw)) return { ok: false, reason: 'invalid-manifest' }
  if (
    typeof raw.id !== 'string' ||
    !raw.id.trim() ||
    typeof raw.name !== 'string' ||
    !raw.name.trim()
  ) {
    return { ok: false, reason: 'invalid-manifest' }
  }
  if (!Number.isInteger(raw.apiVersion)) {
    return { ok: false, reason: 'invalid-manifest' }
  }
  if (raw.permissions !== undefined && !stringArray(raw.permissions)) {
    return { ok: false, reason: 'invalid-manifest' }
  }
  if (raw.http !== undefined) {
    if (!isPlainObject(raw.http)) return { ok: false, reason: 'invalid-manifest' }
    const rootPaths = raw.http.rootPaths
    if (rootPaths !== undefined) {
      if (!stringArray(rootPaths)) return { ok: false, reason: 'invalid-manifest' }
      if (rootPaths.some((item) => !item.startsWith('/') || item.includes('*'))) {
        return { ok: false, reason: 'invalid-manifest' }
      }
    }
    const openPaths = raw.http.openPaths
    if (openPaths !== undefined) {
      if (!stringArray(openPaths)) return { ok: false, reason: 'invalid-manifest' }
      if (openPaths.some((item) => !item.startsWith('/') || item.includes('*'))) {
        return { ok: false, reason: 'invalid-manifest' }
      }
    }
  }
  if (raw.engines !== undefined) {
    if (!isPlainObject(raw.engines) || typeof raw.engines.board !== 'string') {
      return { ok: false, reason: 'invalid-manifest' }
    }
  }
  if (configId !== undefined && raw.id !== configId) {
    return { ok: false, reason: 'id-mismatch' }
  }
  if (!isValidSemver(raw.version)) return { ok: false, reason: 'invalid-version' }
  if (raw.apiVersion !== hostApiVersion) {
    return { ok: false, reason: '1006' }
  }
  if (raw.engines?.board !== undefined) {
    const satisfied = satisfiesRange(raw.engines.board, hostVersion)
    if (!satisfied.ok) return { ok: false, reason: satisfied.reason }
  }
  if (pinnedVersion !== undefined && pinnedVersion !== raw.version) {
    return { ok: false, reason: 'pinned-mismatch' }
  }
  return {
    ok: true,
    manifest: {
      id: raw.id,
      name: raw.name,
      version: raw.version,
      apiVersion: raw.apiVersion,
      engines: { board: raw.engines?.board ?? '*' },
      permissions: raw.permissions ?? [],
      http: { rootPaths: raw.http?.rootPaths ?? [], openPaths: raw.http?.openPaths ?? [] },
      entry: raw.entry,
    },
  }
}

export function manifestFailureMessage(reason, { manifest, hostVersion } = {}) {
  const version = manifest?.version ?? '?'
  const board = manifest?.engines?.board ?? '*'
  switch (reason) {
    case 'invalid-manifest':
      return '插件清单格式不合法'
    case 'id-mismatch':
      return '插件清单 id 与配置项不一致'
    case 'invalid-version':
      return `插件版本不是合法 semver: ${version}`
    case '1006':
      return `插件协议版本 ${manifest?.apiVersion ?? '?'} 与宿主不兼容`
    case 'board-too-old':
      return `插件 ${version} 需要宿主 ${board}，当前 ${hostVersion}`
    case 'board-too-new':
      return `插件 ${version} 要求的宿主上限 ${board} 已不满足，当前 ${hostVersion}`
    case 'pinned-mismatch':
      return `插件版本 ${version} 与配置钉住的版本不一致`
    default:
      return `插件不可用: ${reason}`
  }
}
