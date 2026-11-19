import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { listDirectories, safeRead } from './loader-fs.js'
import { GIT_METADATA_CACHE_TTL_MS, gitMetadataCache, statSignature } from './loader-cache.js'
import { normalizePath } from './loader-groups.js'

export function latestCommit(repoPath) {
  try {
    const headFile = path.join(repoPath, '.git', 'HEAD')
    return safeRead(headFile).trim() || null
  } catch {
    return null
  }
}

export function readDeveloper(repoPath) {
  const raw = safeRead(path.join(repoPath, '.trellis', '.developer'))
  const match = raw.match(/name=(.+)/)
  return match ? match[1].trim() : null
}

export function readMembers(repoPath) {
  return listDirectories(path.join(repoPath, '.trellis', 'workspace')).map((dir) =>
    path.basename(dir),
  )
}

function readGitHead(repoPath) {
  try {
    const head = safeRead(path.join(repoPath, '.git', 'HEAD')).trim()
    return head.startsWith('ref: refs/heads/') ? head.slice('ref: refs/heads/'.length) : 'detached'
  } catch {
    return null
  }
}

function gitMetadataSignature(repoPath) {
  const gitDir = path.join(repoPath, '.git')
  return [
    statSignature(path.join(gitDir, 'HEAD')),
    statSignature(path.join(gitDir, 'packed-refs')),
    statSignature(path.join(gitDir, 'refs', 'heads')),
    statSignature(path.join(gitDir, 'refs', 'remotes')),
  ].join('|')
}

export function readCachedGitMetadata(repoPath, options, stats) {
  const cacheKey = normalizePath(repoPath)
  const signature = gitMetadataSignature(repoPath)
  const cached = gitMetadataCache.get(cacheKey)
  if (
    !options.refreshRepositoryMetadata &&
    cached &&
    cached.signature === signature &&
    Date.now() - cached.readAt < GIT_METADATA_CACHE_TTL_MS
  ) {
    stats.gitMetadataCacheHits += 1
    return cached.value
  }

  stats.gitMetadataCacheMisses += 1
  const value = readGitMetadata(repoPath)
  gitMetadataCache.set(cacheKey, {
    signature,
    readAt: Date.now(),
    value,
  })
  return value
}

function readGitMetadata(repoPath) {
  const localBranches = []
  const remoteBranches = []
  let branch = null

  try {
    const output = execFileSync(
      'git',
      [
        'for-each-ref',
        '--format=%(refname)%09%(refname:short)%09%(HEAD)',
        'refs/heads',
        'refs/remotes',
      ],
      {
        cwd: repoPath,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      },
    ).trim()

    for (const line of output.split(/\r?\n/)) {
      const [refName, shortName, head = ''] = line.split('\t')
      if (!refName || !shortName) continue
      if (refName.startsWith('refs/heads/')) {
        localBranches.push(shortName)
        if (head.trim() === '*') branch = shortName
      } else if (refName.startsWith('refs/remotes/')) {
        const remotePath = refName.slice('refs/remotes/'.length)
        const separator = remotePath.indexOf('/')
        if (separator <= 0) continue
        const remoteBranch = remotePath.slice(separator + 1)
        if (remoteBranch && remoteBranch !== 'HEAD') remoteBranches.push(remoteBranch)
      }
    }
  } catch {
    // Non-Git projects and environments without Git still render with no branch choices.
  }

  if (!branch) branch = readGitHead(repoPath)
  const compare = (left, right) => left.localeCompare(right, 'en')
  const branches = [
    ...new Set(
      [branch, ...localBranches.sort(compare), ...remoteBranches.sort(compare)].filter(Boolean),
    ),
  ]
  return { branch, branches }
}
