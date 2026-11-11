import crypto from 'node:crypto'

export const TASK_SNAPSHOT_MAX_FILES = 64
export const TASK_SNAPSHOT_MAX_FILE_BYTES = 1024 * 1024
export const TASK_SNAPSHOT_MAX_BATCH_BYTES = 8 * 1024 * 1024
export const TASK_SNAPSHOT_EXTENSIONS = Object.freeze([
  '.json',
  '.jsonl',
  '.md',
  '.txt',
  '.yaml',
  '.yml',
])

export function normalizeSnapshotText(value) {
  return String(value ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
}

export function snapshotSha256(value) {
  return crypto.createHash('sha256').update(normalizeSnapshotText(value), 'utf8').digest('hex')
}

export function normalizeSnapshotPath(value) {
  const raw = String(value || '').trim()
  if (!raw || raw.includes('\0') || raw.includes('\\') || raw.startsWith('/')) {
    throw new Error('任务文件路径无效')
  }
  const normalized = raw.split('/').filter(Boolean).join('/')
  if (
    normalized !== raw ||
    normalized.split('/').some((part) => part === '.' || part === '..') ||
    !normalized.startsWith('.trellis/tasks/')
  ) {
    throw new Error('任务文件必须位于 .trellis/tasks 内')
  }
  const extension = TASK_SNAPSHOT_EXTENSIONS.find((item) => normalized.toLowerCase().endsWith(item))
  if (!extension) throw new Error('任务文件类型不受支持')
  return normalized
}

export function taskDirectoryFromPath(value) {
  const relativePath = normalizeSnapshotPath(value)
  const parts = relativePath.split('/')
  if (parts[2] === 'archive') {
    if (parts.length < 6 || !/^\d{4}-\d{2}$/.test(parts[3])) {
      throw new Error('归档任务目录格式无效')
    }
    return {
      taskDir: parts.slice(0, 5).join('/'),
      filePath: parts.slice(5).join('/'),
      archived: true,
      archiveMonth: parts[3],
    }
  }
  if (parts.length < 4 || parts[2] === 'archive') {
    throw new Error('任务目录格式无效')
  }
  return {
    taskDir: parts.slice(0, 3).join('/'),
    filePath: parts.slice(3).join('/'),
    archived: false,
    archiveMonth: null,
  }
}

export function validateSnapshotFile(file) {
  if (!file || typeof file !== 'object') throw new Error('任务文件记录无效')
  if (file.content != null && typeof file.content !== 'string') {
    throw new Error('任务文件内容必须是文本')
  }
  const relativePath = normalizeSnapshotPath(file.path)
  const content = file.content == null ? '' : String(file.content)
  const normalizedContent = normalizeSnapshotText(content)
  const bytes = Buffer.byteLength(normalizedContent, 'utf8')
  if (bytes > TASK_SNAPSHOT_MAX_FILE_BYTES) throw new Error('单个任务文件超过 1 MiB')
  if (content.includes('\0')) throw new Error('任务文件不能包含 NUL')
  const expectedSha256 = snapshotSha256(normalizedContent)
  const suppliedSha256 = file.sha256 == null ? null : String(file.sha256)
  if (suppliedSha256 != null) {
    if (!/^[a-f0-9]{64}$/.test(suppliedSha256)) throw new Error('任务文件摘要无效')
    if (suppliedSha256 !== expectedSha256) throw new Error('任务文件摘要与内容不一致')
  }
  const baseSha256 = file.baseSha256 == null ? null : String(file.baseSha256)
  if (baseSha256 != null && !/^[a-f0-9]{64}$/.test(baseSha256)) {
    throw new Error('任务文件基线摘要无效')
  }
  return {
    ...taskDirectoryFromPath(relativePath),
    path: relativePath,
    content: normalizedContent,
    sha256: expectedSha256,
    deleted: file.deleted === true,
    baseSha256,
  }
}

function parseTaskId(content) {
  try {
    const value = JSON.parse(content)
    return typeof value?.id === 'string' && value.id.trim() ? value.id.trim() : null
  } catch {
    return null
  }
}

export function groupTaskSnapshotFiles(
  files,
  { maxFiles = TASK_SNAPSHOT_MAX_FILES, maxBytes = TASK_SNAPSHOT_MAX_BATCH_BYTES } = {},
) {
  if (!Array.isArray(files) || files.length > maxFiles) {
    throw new Error('单批任务文件数量无效')
  }
  const grouped = new Map()
  const seenPaths = new Set()
  let totalBytes = 0
  for (const source of files) {
    const file = validateSnapshotFile(source)
    if (seenPaths.has(file.path)) throw new Error('任务文件路径不能重复')
    seenPaths.add(file.path)
    totalBytes += Buffer.byteLength(file.content, 'utf8')
    if (totalBytes > maxBytes) throw new Error('任务文件批次超过 8 MiB')
    const current = grouped.get(file.taskDir) || {
      taskDir: file.taskDir,
      archived: file.archived,
      archiveMonth: file.archiveMonth,
      files: [],
      taskId: null,
    }
    if (current.archived !== file.archived) throw new Error('同一批次不能混合活动与归档任务路径')
    current.files.push(file)
    if (file.filePath === 'task.json' && !file.deleted && !current.taskId) {
      current.taskId = parseTaskId(file.content)
    }
    grouped.set(file.taskDir, current)
  }
  return [...grouped.values()].map((group) => ({
    ...group,
    files: group.files.sort((left, right) => left.path.localeCompare(right.path, 'en')),
  }))
}

function fileMap(group) {
  return new Map(
    group.files.filter((file) => !file.deleted).map((file) => [file.path, file.sha256]),
  )
}

function sameFiles(left, right) {
  if (left.size !== right.size) return false
  for (const [path, sha] of left) {
    if (right.get(path) !== sha) return false
  }
  return true
}

export function classifyTaskSnapshots(localGroups, serverGroups) {
  const localGroupsByTaskId = new Map()
  const serverGroupsByTaskId = new Map()
  const localGroupsByDir = new Map()
  const serverGroupsByDir = new Map()
  const badLocalGroups = new Set()
  const badServerGroups = new Set()

  function indexGroups(groups, byTaskId, byDir, badGroups) {
    for (const group of groups || []) {
      byDir.set(group.taskDir, group)
      if (!group.taskId) {
        badGroups.add(group)
        continue
      }
      const matches = byTaskId.get(group.taskId) || []
      matches.push(group)
      byTaskId.set(group.taskId, matches)
    }
  }

  indexGroups(localGroups, localGroupsByTaskId, localGroupsByDir, badLocalGroups)
  indexGroups(serverGroups, serverGroupsByTaskId, serverGroupsByDir, badServerGroups)

  // 同一侧重复 task ID 无法唯一确定任务身份，两侧相关目录都交给用户审查。
  for (const taskId of new Set([...localGroupsByTaskId.keys(), ...serverGroupsByTaskId.keys()])) {
    const localMatches = localGroupsByTaskId.get(taskId) || []
    const serverMatches = serverGroupsByTaskId.get(taskId) || []
    if (localMatches.length < 2 && serverMatches.length < 2) continue
    for (const group of localMatches) badLocalGroups.add(group)
    for (const group of serverMatches) badServerGroups.add(group)
  }

  // 同一目录在两侧对应不同 task ID 时不能按“仅本地”或“仅服务端”自动处理。
  for (const [taskDir, localGroup] of localGroupsByDir) {
    const serverGroup = serverGroupsByDir.get(taskDir)
    if (serverGroup && localGroup.taskId !== serverGroup.taskId) {
      badLocalGroups.add(localGroup)
      badServerGroups.add(serverGroup)
    }
  }

  const invalid = []
  const pairedServerGroups = new Set()
  for (const localGroup of badLocalGroups) {
    const serverGroup = serverGroupsByDir.get(localGroup.taskDir)
    const pairedServer = serverGroup && badServerGroups.has(serverGroup) ? serverGroup : null
    invalid.push({
      type: 'invalid',
      taskId: null,
      taskDir: localGroup.taskDir,
      local: localGroup,
      ...(pairedServer ? { server: pairedServer } : {}),
    })
    if (pairedServer) pairedServerGroups.add(pairedServer)
  }
  for (const serverGroup of badServerGroups) {
    if (pairedServerGroups.has(serverGroup)) continue
    invalid.push({
      type: 'invalid',
      taskId: null,
      taskDir: serverGroup.taskDir,
      server: serverGroup,
    })
  }

  const local = new Map(
    (localGroups || [])
      .filter((group) => !badLocalGroups.has(group))
      .map((group) => [group.taskId || group.taskDir, group]),
  )
  const server = new Map(
    (serverGroups || [])
      .filter((group) => !badServerGroups.has(group))
      .map((group) => [group.taskId || group.taskDir, group]),
  )
  const keys = new Set([...local.keys(), ...server.keys()])
  return [
    ...invalid,
    ...[...keys].map((key) => {
      const localGroup = local.get(key) || null
      const serverGroup = server.get(key) || null
      if (localGroup && !serverGroup) {
        return { type: 'local-only', taskId: key, taskDir: localGroup.taskDir, local: localGroup }
      }
      if (!localGroup && serverGroup) {
        return {
          type: 'server-only',
          taskId: key,
          taskDir: serverGroup.taskDir,
          server: serverGroup,
        }
      }
      const localFiles = fileMap(localGroup)
      const serverFiles = fileMap(serverGroup)
      if (sameFiles(localFiles, serverFiles)) {
        return {
          type: 'same',
          taskId: key,
          taskDir: serverGroup.taskDir,
          local: localGroup,
          server: serverGroup,
        }
      }
      if (localGroup.taskDir !== serverGroup.taskDir) {
        return {
          type: 'move-delete-conflict',
          taskId: key,
          taskDir: serverGroup.taskDir,
          local: localGroup,
          server: serverGroup,
        }
      }
      return {
        type: 'content-conflict',
        taskId: key,
        taskDir: serverGroup.taskDir,
        local: localGroup,
        server: serverGroup,
      }
    }),
  ]
}
