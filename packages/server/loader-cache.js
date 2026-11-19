import fs from 'node:fs'
import path from 'node:path'
import { safeRead } from './loader-fs.js'
import { normalizePath } from './loader-groups.js'

const TASK_CACHE_FILES = [
  'task.json',
  'task.md',
  'prd.md',
  'design.md',
  'implement.md',
  'implementation-report.md',
  'check-report.md',
  'e2e-report.md',
  'implement.jsonl',
  'check.jsonl',
]
export const GIT_METADATA_CACHE_TTL_MS = 60_000
export const taskScanCache = new Map()
export const gitMetadataCache = new Map()

export function clearScanCaches({ tasks = true, gitMetadata = true } = {}) {
  if (tasks) taskScanCache.clear()
  if (gitMetadata) gitMetadataCache.clear()
}

export function countJsonlEntries(filePath) {
  return safeRead(filePath)
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.includes('"_example"'))
    .filter((line) => {
      try {
        return typeof JSON.parse(line).file === 'string'
      } catch {
        return false
      }
    }).length
}

export function readWorkspaceSummary(repoPath, assignee) {
  const indexFile = path.join(repoPath, '.trellis', 'workspace', assignee, 'index.md')
  const workspaceDir = path.dirname(indexFile)
  let journals = 0
  try {
    journals = fs.readdirSync(workspaceDir).filter((name) => /^journal-\d+\.md$/.test(name)).length
  } catch {
    // Missing workspace data is the normal state for tasks imported from another developer.
  }
  return {
    indexExists: fs.existsSync(indexFile),
    journals,
  }
}

export function taskWorkspaceMember(task) {
  return task.assignee || task.creator || 'unknown'
}

export function statSignature(filePath) {
  try {
    const stat = fs.statSync(filePath, { bigint: true })
    return `${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.ino}`
  } catch {
    return 'missing'
  }
}

export function modifiedAt(filePath) {
  try {
    return fs.statSync(filePath).mtime.toISOString()
  } catch {
    return null
  }
}

export function taskBaseSignature(project, taskDir) {
  let rootEntries = new Map()
  try {
    rootEntries = new Map(
      fs.readdirSync(taskDir, { withFileTypes: true }).map((entry) => [entry.name, entry]),
    )
  } catch {
    // A disappearing task is handled by the caller as a cache miss.
  }
  const parts = [
    `project=${project.id}:${project.name}`,
    ...TASK_CACHE_FILES.map((name) => {
      const entry = rootEntries.get(name)
      return entry?.isFile()
        ? `${name}=${statSignature(path.join(taskDir, name))}`
        : `${name}=missing`
    }),
  ]
  const researchDir = path.join(taskDir, 'research')
  let researchFiles = []
  if (rootEntries.get('research')?.isDirectory()) {
    try {
      researchFiles = fs
        .readdirSync(researchDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
        .map((entry) => entry.name)
        .sort((left, right) => left.localeCompare(right, 'en'))
        .map((name) => `${name}=${statSignature(path.join(researchDir, name))}`)
    } catch {
      // A disappearing research directory becomes a cache miss on the next event.
    }
  }
  parts.push(`research=${researchFiles.join(',')}`)
  return parts.join('|')
}

export function taskCacheKey(project, taskDir, includeContent) {
  const relativeDir = path.relative(project.path, taskDir).replaceAll('\\', '/')
  return `${normalizePath(project.path)}::${relativeDir}:${includeContent ? 'detail' : 'list'}`
}

export function forgetTaskCacheEntries(project, taskDir) {
  taskScanCache.delete(taskCacheKey(project, taskDir, false))
  taskScanCache.delete(taskCacheKey(project, taskDir, true))
}

export function workspaceSignature(repoPath, member) {
  const workspaceDir = path.join(repoPath, '.trellis', 'workspace', member)
  const indexSignature = statSignature(path.join(workspaceDir, 'index.md'))
  let journals = []
  try {
    journals = fs
      .readdirSync(workspaceDir)
      .filter((name) => /^journal-\d+\.md$/.test(name))
      .sort((left, right) => left.localeCompare(right, 'en'))
  } catch {
    // Missing workspace data is already represented by the missing index.
  }
  return `${indexSignature}:${journals.join(',')}`
}
