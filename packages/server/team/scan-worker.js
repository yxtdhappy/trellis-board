import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parentPort } from 'node:worker_threads'
import { scanRepository } from '../loader.js'

const RETRY_DELAYS_MS = [10, 20, 50, 100, 200]
const TRANSIENT_FILE_LOCK_CODES = new Set(['EACCES', 'EBUSY', 'EPERM'])

function taskVersion(task) {
  const taskJsonPath = path.join(task.repoPath, task.relativeDir, 'task.json')
  return crypto.createHash('sha256').update(fs.readFileSync(taskJsonPath)).digest('hex')
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate)
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function assertNoSymlink(root, relativePath) {
  let current = root
  for (const part of relativePath.split('/')) {
    current = path.join(current, part)
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        throw new Error('实时物化路径不能经过符号链接')
      }
    } catch (error) {
      if (error?.code === 'ENOENT') return
      throw error
    }
  }
}

function retryFileOperation(callback) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return callback()
    } catch (error) {
      if (!TRANSIENT_FILE_LOCK_CODES.has(error?.code) || attempt >= RETRY_DELAYS_MS.length) {
        throw error
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RETRY_DELAYS_MS[attempt])
    }
  }
}

function copyLivePath(source, target) {
  const stat = fs.lstatSync(source)
  if (stat.isSymbolicLink()) throw new Error('实时物化不能复制符号链接')
  if (stat.isDirectory()) {
    fs.cpSync(source, target, {
      recursive: true,
      force: true,
      filter(current) {
        if (fs.lstatSync(current).isSymbolicLink()) {
          throw new Error('实时物化不能复制符号链接')
        }
        return true
      },
    })
    return
  }
  if (!stat.isFile()) return
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(source, target)
}

function copyLiveBase(sourceRoot, targetRoot) {
  fs.mkdirSync(targetRoot, { recursive: true })
  for (const relative of ['tasks', 'workspace', '.developer']) {
    const source = path.join(sourceRoot, relative)
    if (!fs.existsSync(source)) continue
    copyLivePath(source, path.join(targetRoot, relative))
  }
}

function safeWrite(root, relativePath, content) {
  const target = path.resolve(root, ...relativePath.split('/'))
  if (!isInside(root, target)) throw new Error('实时文件写入路径越界')
  assertNoSymlink(root, relativePath)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  try {
    if (fs.lstatSync(target).isSymbolicLink()) {
      throw new Error('实时物化不能覆盖符号链接')
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const temp = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  fs.writeFileSync(temp, content, 'utf8')
  try {
    retryFileOperation(() => fs.renameSync(temp, target))
  } catch (error) {
    try {
      fs.unlinkSync(temp)
    } catch {
      // 清理失败不覆盖真实写入错误。
    }
    throw error
  }
}

function safeDelete(root, relativePath) {
  const target = path.resolve(root, ...relativePath.split('/'))
  if (!isInside(root, target)) throw new Error('实时文件删除路径越界')
  assertNoSymlink(root, relativePath)
  try {
    if (fs.lstatSync(target).isDirectory()) {
      throw new Error('实时删除不能作用于目录')
    }
    fs.unlinkSync(target)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

function applyLiveRows(root, rows) {
  for (const row of rows) {
    const relativePath = String(row?.relative_path || '')
    const normalized = path.posix.normalize(relativePath)
    if (
      normalized !== relativePath ||
      (relativePath !== '.trellis/.developer' &&
        !relativePath.startsWith('.trellis/tasks/') &&
        !relativePath.startsWith('.trellis/workspace/'))
    ) {
      throw new Error('实时物化文件路径无效')
    }
    const relative = relativePath.slice('.trellis/'.length)
    if (!relative || relative.includes('\0')) {
      throw new Error('实时物化文件路径无效')
    }
    if (row.deleted) safeDelete(root, relative)
    else safeWrite(root, relative, String(row.content_text ?? ''))
  }
}

function removeTreeWithRetry(target) {
  retryFileOperation(() => fs.rmSync(target, { recursive: true, force: true }))
}

function materializeLiveProject(project, rows) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-live-materialize-'))
  try {
    const liveRoot = path.join(tempRoot, '.trellis')
    copyLiveBase(path.join(project.path, '.trellis'), liveRoot)
    applyLiveRows(liveRoot, rows)
    const tempProject = { ...project, path: tempRoot }
    const result = scanRepository(tempProject, {
      includeContent: true,
      refreshRepositoryMetadata: true,
      metadataRepoPath: project.path,
      disableTaskCache: true,
    })
    const versions = new Map(
      result.tasks
        .filter((task) => task.executionIdentityValid !== false)
        .map((task) => [task.relativeDir, taskVersion(task)]),
    )
    return {
      ...result,
      project: { ...result.project, path: project.path },
      tasks: result.tasks.map((task) => ({
        ...task,
        repoPath: project.path,
        taskVersion: versions.get(task.relativeDir) || null,
      })),
    }
  } finally {
    try {
      removeTreeWithRetry(tempRoot)
    } catch {
      // 临时目录在工作区外，清理失败不能反向令已提交的实时批次失败。
    }
  }
}

function materializeSnapshotProject(project, rows) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-task-space-'))
  try {
    for (const row of rows) {
      if (row?.deleted) continue
      const relativePath = String(row?.relative_path || '')
      const normalized = path.posix.normalize(relativePath)
      if (
        normalized !== relativePath ||
        !relativePath.startsWith('.trellis/tasks/') ||
        relativePath.includes('\0')
      ) {
        throw new Error('任务快照文件路径无效')
      }
      const target = path.resolve(tempRoot, ...relativePath.split('/'))
      if (!isInside(tempRoot, target)) throw new Error('任务快照文件路径越界')
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, String(row.content_text ?? ''), 'utf8')
    }
    const versions = new Map(rows.map((row) => [row.relative_path, row.sha256]))
    const result = scanRepository(
      {
        ...project,
        path: tempRoot,
      },
      {
        includeContent: true,
        disableTaskCache: true,
        developer: null,
        members: Array.isArray(project.members) ? project.members : [],
        repositoryMetadata: {
          branch: project.branchName,
          branches: [project.branchName],
          head: null,
        },
        workspaceSummaryResolver: () => ({
          indexExists: false,
          journals: 0,
          lastJournal: null,
        }),
      },
    )
    return {
      ...result,
      project: {
        ...result.project,
        path: null,
        head: null,
        branch: project.branchName,
      },
      tasks: result.tasks.map((task) => ({
        ...task,
        repoPath: path.join(os.tmpdir(), 'trellis-task-space-snapshot', String(project.id)),
        taskVersion: versions.get(`${task.relativeDir}/task.json`) || null,
      })),
    }
  } finally {
    try {
      removeTreeWithRetry(tempRoot)
    } catch {
      // 临时目录清理失败不影响已经得到的扫描结果。
    }
  }
}

function contentTreeHash(repoPath) {
  const root = fs.realpathSync(repoPath)
  const digest = crypto.createHash('sha256')
  const ignored = new Set(['.git', '__pycache__'])

  function walk(current) {
    const entries = fs
      .readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name, 'en'))
    for (const entry of entries) {
      if (ignored.has(entry.name)) continue
      const fullPath = path.join(current, entry.name)
      const stat = fs.lstatSync(fullPath)
      const relative = path.relative(root, fullPath).replaceAll('\\', '/')
      if (stat.isSymbolicLink()) {
        digest.update(`L\0${relative}\n`)
        continue
      }
      if (entry.isDirectory()) {
        walk(fullPath)
        continue
      }
      if (!entry.isFile()) continue
      digest.update(`F\0${relative}\0${stat.size}\0`)
      if (stat.size <= 2 * 1024 * 1024) {
        digest.update(fs.readFileSync(fullPath))
      } else {
        digest.update(`${stat.mtimeMs}`)
      }
      digest.update('\n')
    }
  }

  for (const relative of ['.trellis/tasks', '.trellis/workspace', '.trellis/config.yaml']) {
    const target = path.join(root, relative)
    if (!fs.existsSync(target)) continue
    const stat = fs.lstatSync(target)
    if (stat.isSymbolicLink()) {
      digest.update(`L\0${relative}\n`)
    } else if (stat.isDirectory()) {
      walk(target)
    } else if (stat.isFile()) {
      digest.update(`F\0${relative}\0${stat.size}\0`)
      digest.update(fs.readFileSync(target))
      digest.update('\n')
    }
  }
  return digest.digest('hex')
}

parentPort.on('message', (message) => {
  if (
    message?.type !== 'scan' &&
    message?.type !== 'live-materialize' &&
    message?.type !== 'snapshot-materialize'
  ) {
    return
  }
  try {
    const project = message.project
    if (!project) throw new Error('扫描项目不存在')
    if (message.type === 'snapshot-materialize') {
      parentPort.postMessage({
        type: 'snapshot-materialize-result',
        id: message.id,
        revision: message.revision,
        scan: materializeSnapshotProject(project, Array.isArray(message.rows) ? message.rows : []),
      })
      return
    }
    if (message.type === 'live-materialize') {
      parentPort.postMessage({
        type: 'live-materialize-result',
        id: message.id,
        revision: message.revision,
        scan: materializeLiveProject(project, Array.isArray(message.rows) ? message.rows : []),
      })
      return
    }
    const result = scanRepository(project, {
      includeContent: false,
      refreshRepositoryMetadata: true,
    })
    const versions = new Map(
      result.tasks
        .filter((task) => task.executionIdentityValid !== false)
        .map((task) => [task.relativeDir, taskVersion(task)]),
    )
    parentPort.postMessage({
      type: 'scan-result',
      id: message.id,
      project: result.project,
      tasks: result.tasks.map((task) => ({
        ...task,
        taskVersion: versions.get(task.relativeDir) || null,
      })),
      error: result.error,
      contentKey: contentTreeHash(project.path),
    })
  } catch (error) {
    parentPort.postMessage({
      type: 'scan-error',
      id: message.id,
      error: error instanceof Error ? error.message : String(error),
    })
  }
})
