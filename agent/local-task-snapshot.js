import fs from 'node:fs/promises'
import path from 'node:path'
import { TextDecoder } from 'node:util'
import {
  groupTaskSnapshotFiles,
  normalizeSnapshotText,
  snapshotSha256,
  TASK_SNAPSHOT_EXTENSIONS,
  validateSnapshotFile,
} from '../shared/task-snapshot.js'
import { AgentError, AGENT_ERROR_CODE } from './protocol.js'

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })
const ALL_FILE_GROUPS = {
  maxFiles: Number.POSITIVE_INFINITY,
  maxBytes: Number.POSITIVE_INFINITY,
}

function decodeUtf8(bytes) {
  try {
    return UTF8_DECODER.decode(bytes)
  } catch {
    throw new AgentError(AGENT_ERROR_CODE.INVALID_RESPONSE, '任务文件不是有效的 UTF-8 文本')
  }
}

function taskDirectoryFromRelative(relativePath) {
  const parts = String(relativePath || '')
    .replaceAll('\\', '/')
    .split('/')
  if (parts[0] !== '.trellis' || parts[1] !== 'tasks') return null
  if (parts[2] === 'archive') {
    if (parts.length < 6 || !/^\d{4}-\d{2}$/.test(parts[3])) return null
    return parts.slice(0, 5).join('/')
  }
  if (parts.length < 3) return null
  return parts.slice(0, 3).join('/')
}

export async function readLocalTaskSnapshotFiles(repoPath, taskDirs = null) {
  const tasksRoot = path.join(repoPath, '.trellis', 'tasks')
  let rootStat
  try {
    rootStat = await fs.lstat(tasksRoot)
  } catch {
    return []
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new AgentError(AGENT_ERROR_CODE.MISSING_TRELLIS, '.trellis/tasks 必须是真实目录')
  }
  const selectedDirs = taskDirs == null ? null : new Set([...taskDirs].map(String))
  const files = []

  async function walk(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        throw new AgentError(AGENT_ERROR_CODE.INVALID_RESPONSE, '任务目录不允许符号链接')
      }
      if (entry.isDirectory()) {
        await walk(absolute)
        continue
      }
      if (!entry.isFile()) continue
      if (
        !TASK_SNAPSHOT_EXTENSIONS.some((extension) => entry.name.toLowerCase().endsWith(extension))
      ) {
        continue
      }
      const relativePath = path.relative(repoPath, absolute).replaceAll('\\', '/')
      const taskDir = taskDirectoryFromRelative(relativePath)
      if (!taskDir || (selectedDirs && !selectedDirs.has(taskDir))) continue
      const content = normalizeSnapshotText(decodeUtf8(await fs.readFile(absolute)))
      files.push(
        validateSnapshotFile({
          path: `.trellis/${relativePath.slice('.trellis/'.length)}`,
          content,
          sha256: snapshotSha256(content),
        }),
      )
    }
  }

  await walk(tasksRoot)
  return files
}

export async function readLocalTaskSnapshotGroups(repoPath) {
  return groupTaskSnapshotFiles(await readLocalTaskSnapshotFiles(repoPath), ALL_FILE_GROUPS)
}
