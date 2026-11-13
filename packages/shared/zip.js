import { unzipSync } from 'fflate'

const MAX_ENTRIES = 10_000
const MAX_ENTRY_BYTES = 64 * 1024 * 1024
const MAX_TOTAL_BYTES = 256 * 1024 * 1024
const STORED = 0
const DEFLATE = 8
const AES = 99
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

export class ZipError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined)
    this.name = 'ZipError'
    this.code = options.code || 'ZIP_INVALID'
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

export function readZipEntries(
  buffer,
  {
    maxEntries = MAX_ENTRIES,
    maxEntryBytes = MAX_ENTRY_BYTES,
    maxTotalBytes = MAX_TOTAL_BYTES,
  } = {},
) {
  if (!Buffer.isBuffer(buffer)) throw new ZipError('ZIP 输入必须是 Buffer')
  const descriptors = new Map()
  const seen = new Set()
  let count = 0
  let totalBytes = 0
  let files
  try {
    files = unzipSync(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength), {
      filter(entry) {
        count += 1
        if (count > maxEntries) throw new ZipError('ZIP 条目数量超过限制')
        if (entry.compression === AES) throw new ZipError('ZIP 不支持加密条目')
        if (entry.compression !== STORED && entry.compression !== DEFLATE) {
          throw new ZipError('ZIP 使用了不支持的压缩方法')
        }
        if (entry.originalSize > maxEntryBytes) {
          throw new ZipError('ZIP 条目解压后超过大小限制')
        }
        totalBytes += entry.originalSize
        if (totalBytes > maxTotalBytes) throw new ZipError('ZIP 解压总量超过限制')
        const isDirectory = entry.name.endsWith('/')
        const name = validateArchivePath(entry.name, { directory: isDirectory })
        const key = name.toLowerCase()
        if (seen.has(key)) throw new ZipError('ZIP 包含重复条目')
        seen.add(key)
        descriptors.set(entry.name, { name, isDirectory, size: entry.originalSize })
        return true
      },
    })
  } catch (error) {
    if (error instanceof ZipError) throw error
    throw new ZipError('ZIP 解析失败', { cause: error })
  }
  return Object.entries(files).map(([rawName, data]) => {
    const descriptor = descriptors.get(rawName)
    if (!descriptor) throw new ZipError('ZIP 解析失败')
    const entryData = descriptor.isDirectory
      ? Buffer.alloc(0)
      : Buffer.from(data.buffer, data.byteOffset, data.byteLength)
    if (entryData.length !== descriptor.size) {
      throw new ZipError('ZIP 条目解压大小与声明不一致')
    }
    return { name: descriptor.name, isDirectory: descriptor.isDirectory, data: entryData }
  })
}
