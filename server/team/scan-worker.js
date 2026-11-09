import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { parentPort } from 'node:worker_threads'
import { scanRepository } from '../loader.js'

function taskVersion(task) {
  const taskJsonPath = path.join(task.repoPath, task.relativeDir, 'task.json')
  return crypto.createHash('sha256').update(fs.readFileSync(taskJsonPath)).digest('hex')
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
  if (message?.type !== 'scan') return
  try {
    const project = message.project
    if (!project) throw new Error('扫描项目不存在')
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
