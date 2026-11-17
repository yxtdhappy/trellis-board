import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  normalizeSnapshotPath,
  normalizeSnapshotText,
  taskDirectoryFromPath,
} from '@trellis-board/shared/task-snapshot.js'
import { withTransaction } from '../database.js'
import { teamError } from './errors.js'
import { listTaskSnapshotBackupFiles } from './task-snapshot-backup.js'

export const ARCHIVE_SNAPSHOT_MAX_FILE_BYTES = 16 * 1024 * 1024
export const ARCHIVE_SNAPSHOT_MAX_BYTES = 512 * 1024 * 1024
export const ARCHIVE_TEXT_EXCERPT_CHARS = 40_000

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const OBJECT_ID = /^[a-f0-9]{40,64}$/i
const MANIFEST_VERSION = 1
const STAGING_TTL_MS = 24 * 60 * 60 * 1000
const DOWNLOAD_TIMEOUT_MS = 30_000
const MAX_CONCURRENT_DOWNLOADS = 4

const MIME_TYPES = new Map([
  ['.class', 'application/java-vm'],
  ['.csv', 'text/csv; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.doc', 'application/msword'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.gif', 'image/gif'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.jsonl', 'application/x-ndjson; charset=utf-8'],
  ['.java', 'text/plain; charset=utf-8'],
  ['.log', 'text/plain; charset=utf-8'],
  ['.md', 'text/markdown; charset=utf-8'],
  ['.pdf', 'application/pdf'],
  ['.pen', 'application/octet-stream'],
  ['.png', 'image/png'],
  ['.ps1', 'text/plain; charset=utf-8'],
  ['.sh', 'text/plain; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.wasm', 'application/wasm'],
  ['.webp', 'image/webp'],
  ['.xls', 'application/vnd.ms-excel'],
  ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['.xml', 'application/xml; charset=utf-8'],
  ['.yaml', 'application/yaml; charset=utf-8'],
  ['.yml', 'application/yaml; charset=utf-8'],
  ['.zip', 'application/zip'],
])

const TEXTUAL_MIME_TYPES = new Set([
  'application/json',
  'application/xml',
  'application/x-ndjson',
  'application/yaml',
  'text/javascript',
])

function textBuffer(value) {
  return Buffer.from(String(value), 'utf8')
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function safeSegment(value, label) {
  const segment = String(value || '')
  if (!SAFE_SEGMENT.test(segment)) throw new Error(`${label}格式无效`)
  return segment
}

function safeHead(value) {
  const head = String(value || '')
  if (!OBJECT_ID.test(head)) throw new Error('归档快照 HEAD 格式无效')
  return head
}

function inside(root, target) {
  const relative = path.relative(root, target)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function fsyncFile(file) {
  const descriptor = fs.openSync(file, 'r')
  try {
    fs.fsyncSync(descriptor)
  } catch (error) {
    // Windows 文件安全软件可能拒绝 fsync，已落盘写入仍按 rename 原子发布。
    if (!new Set(['EACCES', 'EBADF', 'EINVAL', 'EPERM']).has(error?.code)) throw error
  } finally {
    fs.closeSync(descriptor)
  }
}

function fsyncDirectory(directory) {
  try {
    const descriptor = fs.openSync(directory, 'r')
    try {
      fs.fsyncSync(descriptor)
    } finally {
      fs.closeSync(descriptor)
    }
  } catch (error) {
    if (!new Set(['EACCES', 'EBADF', 'EINVAL', 'EPERM']).has(error?.code)) throw error
  }
}

function safeErrorCode(error) {
  const code = String(error?.code || '').trim()
  return /^[A-Z0-9_:-]{2,100}$/.test(code) ? code : 'ARCHIVE_SNAPSHOT_CLEANUP_FAILED'
}

function mimeTypeFor(relativePath) {
  return (
    MIME_TYPES.get(path.posix.extname(relativePath).toLowerCase()) || 'application/octet-stream'
  )
}

export function isArchiveTextMimeType(mimeType) {
  const normalized = String(mimeType || '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase()
  return normalized.startsWith('text/') || TEXTUAL_MIME_TYPES.has(normalized)
}

function textProjection(relativePath, blob) {
  const mimeType = mimeTypeFor(relativePath)
  if (!isArchiveTextMimeType(mimeType)) return { mimeType, textExcerpt: null }
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(blob)
    const normalized = normalizeSnapshotText(decoded)
    return {
      mimeType,
      textExcerpt: Array.from(normalized).slice(0, ARCHIVE_TEXT_EXCERPT_CHARS).join(''),
    }
  } catch {
    return { mimeType: 'application/octet-stream', textExcerpt: null }
  }
}

function publicSnapshotFilePath(storageRoot, digest) {
  return `${storageRoot}/files/${digest}`
}

function snapshotDirectoryUsable(directory, taskSpaceId, sourceHead, expectedFileCount) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'))
    const storagePrefix = `${taskSpaceId}/heads/${sourceHead}/files/`
    return (
      manifest?.version === MANIFEST_VERSION &&
      manifest.taskSpaceId === taskSpaceId &&
      manifest.sourceHead === sourceHead &&
      Array.isArray(manifest.files) &&
      manifest.files.length === expectedFileCount &&
      manifest.files.every((file) => {
        if (typeof file.storageKey !== 'string' || !file.storageKey.startsWith(storagePrefix)) {
          return false
        }
        const relativePath = file.storageKey.slice(storagePrefix.length)
        if (!/^[a-f0-9]{64}$/i.test(relativePath)) {
          return false
        }
        try {
          const realFile = fs.realpathSync(path.join(directory, 'files', relativePath))
          return inside(directory, realFile)
        } catch {
          return false
        }
      })
    )
  } catch {
    return false
  }
}

export function createArchiveSnapshotStore({
  db,
  dataDir,
  databaseFile = null,
  logger = console,
  stagingTtlMs = STAGING_TTL_MS,
}) {
  if (!db) throw new Error('归档快照存储缺少数据库')
  if (!dataDir) throw new Error('归档快照存储缺少数据目录')
  const root = path.join(dataDir, 'archive-snapshots')
  fs.mkdirSync(root, { recursive: true })
  const activeRoots = new Map()
  const activeStaging = new Set()
  let activeDownloads = 0

  function taskSpaceDirectory(taskSpaceId) {
    return path.join(root, safeSegment(taskSpaceId, '任务空间 ID'))
  }

  function storagePath(storageKey) {
    const key = String(storageKey || '')
    const parts = key.split('/')
    if (
      !key ||
      key.includes('\0') ||
      key.includes('\\') ||
      path.posix.isAbsolute(key) ||
      parts.some((part) => !part || part === '.' || part === '..')
    ) {
      throw teamError(503, 'ARCHIVE_LOCAL_FILE_UNAVAILABLE', '归档本地文件不可用')
    }
    const target = path.resolve(root, ...parts)
    const relative = path.relative(root, target)
    if (!inside(root, target) || relative.split(path.sep).some((part) => part === '..')) {
      throw teamError(503, 'ARCHIVE_LOCAL_FILE_UNAVAILABLE', '归档本地文件不可用')
    }
    return target
  }

  function removeInsideRoot(target) {
    const resolved = path.resolve(target)
    if (!inside(root, resolved)) throw new Error('拒绝删除归档快照根目录之外的内容')
    fs.rmSync(resolved, { recursive: true, force: true })
  }

  function backupReferences() {
    const referenced = new Set()
    for (const backupFile of listTaskSnapshotBackupFiles(databaseFile)) {
      let backup = null
      try {
        backup = new DatabaseSync(backupFile, { readOnly: true })
        const hasSnapshots = backup
          .prepare(`
            SELECT 1
            FROM sqlite_master
            WHERE type = 'table' AND name = 'sync_archive_snapshot'
          `)
          .get()
        if (!hasSnapshots) continue
        for (const row of backup
          .prepare(`
            SELECT storage_root
            FROM sync_archive_snapshot
            WHERE storage_root IS NOT NULL AND storage_root <> ''
          `)
          .all()) {
          if (row.storage_root) {
            storagePath(row.storage_root)
            referenced.add(row.storage_root)
          }
        }
      } catch {
        throw teamError(
          503,
          'ARCHIVE_SNAPSHOT_BACKUP_SCAN_FAILED',
          '归档数据库备份引用不可读，已跳过快照清理',
        )
      } finally {
        backup?.close()
      }
    }
    return referenced
  }

  function createStaging(taskSpaceId, attemptId) {
    const id = safeSegment(taskSpaceId, '任务空间 ID')
    const attempt = safeSegment(attemptId, '同步尝试 ID')
    const directory = path.join(root, id, 'staging', attempt)
    if (fs.existsSync(directory)) removeInsideRoot(directory)
    fs.mkdirSync(path.join(directory, 'files'), { recursive: true })
    activeStaging.add(directory)
    let byteCount = 0

    function writeBlob(entry, blob) {
      const relativePath = normalizeSnapshotPath(entry?.relativePath, {
        allowUnsupportedExtension: true,
      })
      const directoryInfo = taskDirectoryFromPath(relativePath, {
        allowUnsupportedExtension: true,
      })
      if (!directoryInfo.archived) throw new Error('归档快照路径必须位于 archive 目录')
      if (!Buffer.isBuffer(blob)) throw new Error('归档文件内容必须是二进制 Buffer')
      if (blob.length > ARCHIVE_SNAPSHOT_MAX_FILE_BYTES) {
        throw teamError(
          409,
          'ARCHIVE_FILE_TOO_LARGE',
          `Git 归档文件超过 ${ARCHIVE_SNAPSHOT_MAX_FILE_BYTES / 1024 / 1024} MiB`,
        )
      }
      byteCount += blob.length
      if (byteCount > ARCHIVE_SNAPSHOT_MAX_BYTES) {
        throw teamError(
          409,
          'ARCHIVE_TREE_TOO_LARGE',
          `归档文件总量超过 ${ARCHIVE_SNAPSHOT_MAX_BYTES / 1024 / 1024} MiB`,
        )
      }
      const digest = sha256(blob)
      const file = path.join(directory, 'files', digest)
      if (!fs.existsSync(file)) {
        try {
          fs.writeFileSync(file, blob, { flag: 'wx' })
        } catch (error) {
          if (error?.code !== 'EEXIST') throw error
        }
        fsyncFile(file)
      }
      return {
        ...entry,
        relativePath,
        sha256: digest,
        sizeBytes: blob.length,
        ...textProjection(relativePath, blob),
      }
    }

    return {
      taskSpaceId: id,
      attemptId: attempt,
      directory,
      writeBlob,
      cancel() {
        activeStaging.delete(directory)
        if (fs.existsSync(directory)) removeInsideRoot(directory)
      },
    }
  }

  function publish({ staging, head, files }) {
    if (!staging?.directory || !inside(root, path.resolve(staging.directory))) {
      throw new Error('归档快照 staging 目录无效')
    }
    const taskSpaceId = safeSegment(staging.taskSpaceId, '任务空间 ID')
    const sourceHead = safeHead(head)
    if (!Array.isArray(files)) throw new Error('归档快照文件清单无效')
    const storageRoot = `${taskSpaceId}/heads/${sourceHead}`
    const manifest = {
      version: MANIFEST_VERSION,
      taskSpaceId,
      sourceHead,
      files: files
        .map((file) => ({
          relativePath: file.relativePath,
          blobOid: file.blobOid,
          sha256: file.sha256,
          sizeBytes: file.sizeBytes,
          mimeType: file.mimeType,
          storageKey: publicSnapshotFilePath(storageRoot, file.sha256),
        }))
        .sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en')),
    }
    const manifestBytes = textBuffer(`${JSON.stringify(manifest)}\n`)
    const manifestSha256 = sha256(manifestBytes)
    const stagingManifest = path.join(staging.directory, 'manifest.json')
    fs.writeFileSync(stagingManifest, manifestBytes)
    fsyncFile(stagingManifest)
    fsyncDirectory(path.join(staging.directory, 'files'))
    fsyncDirectory(staging.directory)

    const destination = path.join(root, taskSpaceId, 'heads', sourceHead)
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    if (
      !fs.existsSync(destination) ||
      !snapshotDirectoryUsable(destination, taskSpaceId, sourceHead, manifest.files.length)
    ) {
      const previous = fs.existsSync(destination)
        ? `${destination}.replace-${crypto.randomUUID()}`
        : null
      if (previous) fs.renameSync(destination, previous)
      try {
        fs.renameSync(staging.directory, destination)
      } catch (error) {
        if (previous && !fs.existsSync(destination)) fs.renameSync(previous, destination)
        throw error
      }
      activeStaging.delete(staging.directory)
      if (previous) removeInsideRoot(previous)
      fsyncDirectory(path.dirname(destination))
    } else {
      removeInsideRoot(staging.directory)
      activeStaging.delete(staging.directory)
    }
    activeRoots.set(storageRoot, Number(activeRoots.get(storageRoot) || 0) + 1)
    let released = false
    return {
      taskSpaceId,
      sourceHead,
      storageRoot,
      storageKeyPrefix: storageRoot,
      fileCount: manifest.files.length,
      byteCount: manifest.files.reduce((sum, file) => sum + Number(file.sizeBytes || 0), 0),
      manifestSha256,
      files: manifest.files,
      release() {
        if (released) return
        released = true
        const count = Number(activeRoots.get(storageRoot) || 0)
        if (count <= 1) activeRoots.delete(storageRoot)
        else activeRoots.set(storageRoot, count - 1)
      },
    }
  }

  function snapshotUsable(snapshot) {
    if (!snapshot?.storage_root || !snapshot?.source_head) return false
    try {
      const directory = storagePath(snapshot.storage_root)
      const manifestFile = path.join(directory, 'manifest.json')
      const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
      const storagePrefix = `${snapshot.storage_root}/files/`
      return (
        manifest?.version === MANIFEST_VERSION &&
        manifest.taskSpaceId === snapshot.task_space_id &&
        manifest.sourceHead === snapshot.source_head &&
        Array.isArray(manifest.files) &&
        manifest.files.length === Number(snapshot.file_count) &&
        manifest.files.every(
          (file) =>
            typeof file.storageKey === 'string' &&
            file.storageKey.startsWith(storagePrefix) &&
            /^[a-f0-9]{64}$/i.test(file.storageKey.slice(storagePrefix.length)) &&
            fs.existsSync(storagePath(file.storageKey)),
        )
      )
    } catch {
      return false
    }
  }

  function readText(storageKey) {
    const file = storagePath(storageKey)
    let realFile
    try {
      realFile = fs.realpathSync(file)
    } catch {
      throw teamError(503, 'ARCHIVE_LOCAL_FILE_UNAVAILABLE', '归档本地文件不可用')
    }
    if (!inside(root, realFile)) {
      throw teamError(503, 'ARCHIVE_LOCAL_FILE_UNAVAILABLE', '归档本地文件不可用')
    }
    try {
      return normalizeSnapshotText(fs.readFileSync(realFile, 'utf8'))
    } catch {
      throw teamError(503, 'ARCHIVE_LOCAL_FILE_UNAVAILABLE', '归档本地文件不可用')
    }
  }

  async function readDownload(fileRow) {
    if (activeDownloads >= MAX_CONCURRENT_DOWNLOADS) {
      throw teamError(503, 'ARCHIVE_DOWNLOAD_BUSY', '归档文件下载繁忙，请稍后重试', {
        recoverable: true,
      })
    }
    activeDownloads += 1
    let timer = null
    try {
      const file = storagePath(fileRow.storage_key)
      const realFile = fs.realpathSync(file)
      if (!inside(root, realFile)) {
        throw teamError(503, 'ARCHIVE_LOCAL_FILE_UNAVAILABLE', '归档本地文件不可用')
      }
      const buffer = await Promise.race([
        fs.promises.readFile(realFile),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(teamError(503, 'ARCHIVE_DOWNLOAD_TIMEOUT', '归档文件读取超时')),
            DOWNLOAD_TIMEOUT_MS,
          )
          timer.unref?.()
        }),
      ])
      if (buffer.length !== Number(fileRow.size_bytes) || sha256(buffer) !== fileRow.sha256) {
        throw teamError(503, 'ARCHIVE_LOCAL_FILE_UNAVAILABLE', '归档本地文件校验失败')
      }
      return buffer
    } catch (error) {
      if (error?.status && error?.code) throw error
      throw teamError(503, 'ARCHIVE_LOCAL_FILE_UNAVAILABLE', '归档本地文件不可用')
    } finally {
      if (timer) clearTimeout(timer)
      activeDownloads = Math.max(0, activeDownloads - 1)
    }
  }

  function cleanup() {
    const now = Date.now()
    const backupReferenced = backupReferences()
    const taskSpaces = db
      .prepare(`
        SELECT id, archive_snapshot_id, archive_candidate_snapshot_id
        FROM sync_task_space
      `)
      .all()
    const pointersByTaskSpace = new Map(
      taskSpaces.map((row) => [
        row.id,
        {
          active: row.archive_snapshot_id || null,
          candidate: row.archive_candidate_snapshot_id || null,
        },
      ]),
    )
    const snapshotRows = db
      .prepare(`
        SELECT id, task_space_id, storage_root
        FROM sync_archive_snapshot
      `)
      .all()
    const snapshotsById = new Map(snapshotRows.map((row) => [row.id, row]))
    const keepSnapshotIds = new Set()
    for (const [taskSpaceId, pointers] of pointersByTaskSpace) {
      for (const snapshotId of [pointers.active, pointers.candidate].filter(Boolean)) {
        const snapshot = snapshotsById.get(snapshotId)
        if (!snapshot || snapshot.task_space_id !== taskSpaceId) {
          throw teamError(
            503,
            'ARCHIVE_SNAPSHOT_REFERENCE_INVALID',
            '归档快照引用无效，已跳过快照清理',
          )
        }
        keepSnapshotIds.add(snapshotId)
      }
    }
    for (const row of db
      .prepare(`
        SELECT DISTINCT task_space_id, snapshot_id
        FROM sync_archive_file
        WHERE snapshot_id IS NOT NULL
      `)
      .all()) {
      const snapshot = snapshotsById.get(row.snapshot_id)
      if (
        !snapshot ||
        snapshot.task_space_id !== row.task_space_id ||
        !keepSnapshotIds.has(row.snapshot_id)
      ) {
        throw teamError(
          503,
          'ARCHIVE_SNAPSHOT_REFERENCE_INVALID',
          '归档当前文件引用无效，已跳过快照清理',
        )
      }
    }
    const historyRows = db
      .prepare(`
        SELECT id, task_space_id, snapshot_id
        FROM sync_archive_file_history
      `)
      .all()
    const removeHistoryIds = []
    for (const row of historyRows) {
      const snapshot = row.snapshot_id ? snapshotsById.get(row.snapshot_id) : null
      if (row.snapshot_id && (!snapshot || snapshot.task_space_id !== row.task_space_id)) {
        throw teamError(
          503,
          'ARCHIVE_SNAPSHOT_REFERENCE_INVALID',
          '归档历史文件引用无效，已跳过快照清理',
        )
      }
      const pointers = pointersByTaskSpace.get(row.task_space_id)
      const keepLegacy = !row.snapshot_id && pointers && !pointers.active
      if (!keepLegacy && !keepSnapshotIds.has(row.snapshot_id)) removeHistoryIds.push(row.id)
    }
    const removeSnapshotIds = snapshotRows
      .filter((row) => !keepSnapshotIds.has(row.id))
      .map((row) => row.id)
    if (removeHistoryIds.length || removeSnapshotIds.length) {
      withTransaction(db, () => {
        const removeHistory = db.prepare('DELETE FROM sync_archive_file_history WHERE id = ?')
        for (const id of removeHistoryIds) removeHistory.run(id)
        const removeSnapshot = db.prepare('DELETE FROM sync_archive_snapshot WHERE id = ?')
        for (const id of removeSnapshotIds) removeSnapshot.run(id)
      })
    }
    const referenced = new Set(
      [
        ...backupReferenced,
        ...activeRoots.keys(),
        ...snapshotRows.filter((row) => keepSnapshotIds.has(row.id)).map((row) => row.storage_root),
      ].filter(Boolean),
    )
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const taskDirectory = path.join(root, entry.name)
      const stagingRoot = path.join(taskDirectory, 'staging')
      if (fs.existsSync(stagingRoot)) {
        for (const attempt of fs.readdirSync(stagingRoot, { withFileTypes: true })) {
          if (!attempt.isDirectory()) continue
          const directory = path.join(stagingRoot, attempt.name)
          if (activeStaging.has(directory)) continue
          try {
            if (now - fs.statSync(directory).mtimeMs > stagingTtlMs) removeInsideRoot(directory)
          } catch (error) {
            logger.warn?.('归档快照 staging 清理失败', {
              taskSpaceId: entry.name,
              errorCode: safeErrorCode(error),
            })
          }
        }
      }
      const headsRoot = path.join(taskDirectory, 'heads')
      if (fs.existsSync(headsRoot)) {
        for (const head of fs.readdirSync(headsRoot, { withFileTypes: true })) {
          if (!head.isDirectory()) continue
          const storageRoot = `${entry.name}/heads/${head.name}`
          if (referenced.has(storageRoot)) continue
          try {
            removeInsideRoot(path.join(headsRoot, head.name))
          } catch (error) {
            logger.warn?.('归档快照旧版本清理失败', {
              taskSpaceId: entry.name,
              errorCode: safeErrorCode(error),
            })
          }
        }
      }
      const hasReferences = [...referenced].some((item) => item.startsWith(`${entry.name}/`))
      const stagingEntries = fs.existsSync(stagingRoot)
        ? fs.readdirSync(stagingRoot, { withFileTypes: true })
        : []
      const headsEntries = fs.existsSync(headsRoot)
        ? fs.readdirSync(headsRoot, { withFileTypes: true })
        : []
      if (!hasReferences && !stagingEntries.length && !headsEntries.length) {
        try {
          removeInsideRoot(taskDirectory)
        } catch (error) {
          logger.warn?.('归档快照目录清理失败', {
            taskSpaceId: entry.name,
            errorCode: safeErrorCode(error),
          })
        }
      }
    }
    return {
      removedSnapshotRows: removeSnapshotIds.length,
      removedHistoryRows: removeHistoryIds.length,
      referenced: referenced.size,
    }
  }

  return {
    root,
    createStaging,
    publish,
    snapshotUsable,
    readText,
    readDownload,
    cleanup,
  }
}
