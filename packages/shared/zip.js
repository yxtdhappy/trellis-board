import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const MAX_ENTRIES = 10_000
const MAX_ENTRY_BYTES = 64 * 1024 * 1024
const MAX_TOTAL_BYTES = 256 * 1024 * 1024
const UNIX_FILE_TYPE = 0o170000
const UNIX_DIRECTORY = 0o040000
const UNIX_REGULAR = 0o100000
const DOS_DIRECTORY = 0x10
const RESERVED_WINDOWS_NAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
])

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

export class ZipError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined)
    this.name = 'ZipError'
    this.code = options.code || 'ZIP_INVALID'
  }
}

function crc32(buffer) {
  let value = 0xffffffff
  for (const byte of buffer) {
    value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8)
  }
  return (value ^ 0xffffffff) >>> 0
}

function decodeName(buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    throw new ZipError('ZIP 条目名称不是合法 UTF-8')
  }
}

export function validateArchivePath(rawName, { directory = false } = {}) {
  const name = String(rawName || '')
  if (!name) throw new ZipError('ZIP 条目名称为空')
  if (name.includes('\0')) throw new ZipError('ZIP 条目名称包含空字符')
  if (name.includes('\\')) throw new ZipError('ZIP 条目名称包含反斜杠')
  if (name.startsWith('/') || name.startsWith('//')) {
    throw new ZipError('ZIP 条目名称不能是绝对路径')
  }
  if (/^[A-Za-z]:/.test(name)) throw new ZipError('ZIP 条目名称不能包含盘符')
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    throw new ZipError('ZIP 条目名称包含控制字符')
  }
  const normalized = directory && name.endsWith('/') ? name.slice(0, -1) : name
  const segments = normalized.split('/')
  if (segments.length === 0 || segments.some((segment) => segment === '')) {
    throw new ZipError('ZIP 条目路径包含空段')
  }
  for (const segment of segments) {
    if (segment === '.' || segment === '..') {
      throw new ZipError('ZIP 条目路径不能包含相对段')
    }
    if (segment.includes(':')) {
      throw new ZipError('ZIP 条目路径不能包含备用数据流')
    }
    if (segment.endsWith('.') || segment.endsWith(' ')) {
      throw new ZipError('ZIP 条目路径不能以点或空格结尾')
    }
    const base = segment.split('.')[0].toUpperCase()
    if (RESERVED_WINDOWS_NAMES.has(base)) {
      throw new ZipError('ZIP 条目路径使用了 Windows 保留名称')
    }
  }
  return normalized
}

function findEndOfCentralDirectory(buffer) {
  if (buffer.length < 22) throw new ZipError('ZIP 文件过短')
  const stop = Math.max(0, buffer.length - 22 - 0xffff)
  for (let offset = buffer.length - 22; offset >= stop; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) {
      return offset
    }
  }
  throw new ZipError('ZIP 缺少中央目录结束记录')
}

function readLocalHeader(buffer, entry) {
  if (entry.localOffset + 30 > buffer.length) {
    throw new ZipError('ZIP 本地文件头越界')
  }
  if (buffer.readUInt32LE(entry.localOffset) !== LOCAL_SIGNATURE) {
    throw new ZipError('ZIP 本地文件头签名无效')
  }
  const nameLength = buffer.readUInt16LE(entry.localOffset + 26)
  const extraLength = buffer.readUInt16LE(entry.localOffset + 28)
  const nameStart = entry.localOffset + 30
  const nameEnd = nameStart + nameLength
  const dataStart = nameEnd + extraLength
  const dataEnd = dataStart + entry.compressedSize
  if (nameEnd > buffer.length || dataEnd > buffer.length) {
    throw new ZipError('ZIP 条目数据越界')
  }
  const localName = decodeName(buffer.subarray(nameStart, nameEnd))
  if (localName !== entry.rawName) {
    throw new ZipError('ZIP 本地文件头名称与中央目录不一致')
  }
  return buffer.subarray(dataStart, dataEnd)
}

function inflateEntry(method, data, size) {
  if (size === 0 && data.length === 0) return Buffer.alloc(0)
  if (method === 0) return Buffer.from(data)
  if (method !== 8) throw new ZipError('ZIP 使用了不支持的压缩方法')
  try {
    return zlib.inflateRawSync(data, { maxOutputLength: Math.max(1, size) })
  } catch (error) {
    throw new ZipError('ZIP 条目解压失败', { cause: error })
  }
}

export function readZipEntries(
  buffer,
  {
    maxEntries = MAX_ENTRIES,
    maxEntryBytes = MAX_ENTRY_BYTES,
    maxTotalBytes = MAX_TOTAL_BYTES,
  } = {},
) {
  if (!Buffer.isBuffer(buffer)) throw new ZipError('ZIP 输入必须是 Buffer')
  const eocd = findEndOfCentralDirectory(buffer)
  const diskNumber = buffer.readUInt16LE(eocd + 4)
  const centralDisk = buffer.readUInt16LE(eocd + 6)
  const entryCount = buffer.readUInt16LE(eocd + 10)
  const centralSize = buffer.readUInt32LE(eocd + 12)
  const centralOffset = buffer.readUInt32LE(eocd + 16)
  if (diskNumber !== 0 || centralDisk !== 0) {
    throw new ZipError('ZIP 不支持分卷归档')
  }
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new ZipError('ZIP 不支持 ZIP64 归档')
  }
  if (entryCount > maxEntries) throw new ZipError('ZIP 条目数量超过限制')
  if (centralOffset + centralSize > buffer.length) {
    throw new ZipError('ZIP 中央目录越界')
  }

  const entries = []
  const seen = new Set()
  let totalBytes = 0
  let offset = centralOffset
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw new ZipError('ZIP 中央目录条目无效')
    }
    const madeBy = buffer.readUInt16LE(offset + 4)
    const flags = buffer.readUInt16LE(offset + 8)
    const method = buffer.readUInt16LE(offset + 10)
    const expectedCrc = buffer.readUInt32LE(offset + 16)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const uncompressedSize = buffer.readUInt32LE(offset + 24)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const diskStart = buffer.readUInt16LE(offset + 34)
    const externalAttributes = buffer.readUInt32LE(offset + 38)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const next = offset + 46 + nameLength + extraLength + commentLength
    if (next > buffer.length) throw new ZipError('ZIP 中央目录条目越界')
    if (flags & 0x1 || flags & 0x40) throw new ZipError('ZIP 不支持加密条目')
    if (diskStart !== 0) throw new ZipError('ZIP 不支持跨卷条目')
    if (uncompressedSize > maxEntryBytes) {
      throw new ZipError('ZIP 条目解压后超过大小限制')
    }
    totalBytes += uncompressedSize
    if (totalBytes > maxTotalBytes) {
      throw new ZipError('ZIP 解压总量超过限制')
    }

    const rawName = decodeName(buffer.subarray(offset + 46, offset + 46 + nameLength))
    const mode = (externalAttributes >>> 16) & 0xffff
    const fileType = mode & UNIX_FILE_TYPE
    if (fileType && fileType !== UNIX_REGULAR && fileType !== UNIX_DIRECTORY) {
      throw new ZipError('ZIP 条目不是普通文件或目录')
    }
    const isDirectory =
      rawName.endsWith('/') ||
      fileType === UNIX_DIRECTORY ||
      Boolean(externalAttributes & DOS_DIRECTORY)
    const name = validateArchivePath(rawName, { directory: isDirectory })
    const key = name.toLowerCase()
    if (seen.has(key)) throw new ZipError('ZIP 包含重复条目')
    seen.add(key)

    let data = Buffer.alloc(0)
    if (!isDirectory) {
      const compressed = readLocalHeader(buffer, {
        localOffset,
        compressedSize,
        rawName,
      })
      data = inflateEntry(method, compressed, uncompressedSize)
      if (data.length !== uncompressedSize) {
        throw new ZipError('ZIP 条目解压大小与声明不一致')
      }
      if (crc32(data) !== expectedCrc) {
        throw new ZipError('ZIP 条目 CRC-32 校验失败')
      }
    }

    entries.push({
      name,
      isDirectory,
      data,
      mode: mode & 0o777,
    })
    offset = next
  }
  return entries
}

export function extractZipEntries(entries, destination) {
  const root = path.resolve(destination)
  fs.mkdirSync(root, { recursive: true })
  const written = []
  for (const entry of entries) {
    const target = path.join(root, ...entry.name.split('/'))
    const relative = path.relative(root, target)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new ZipError('ZIP 条目路径逃逸目标目录')
    }
    if (entry.isDirectory) {
      fs.mkdirSync(target, { recursive: true })
      continue
    }
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, entry.data, {
      flag: 'wx',
      mode: 0o644,
    })
    written.push(entry.name)
  }
  return written
}
