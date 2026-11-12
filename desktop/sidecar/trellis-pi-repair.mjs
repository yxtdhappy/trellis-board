import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

function isPathInside(root, target) {
  const relative = path.relative(root, target)
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function resolveTemplateTarget(repoRoot, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath || relativePath.includes('\0')) {
    throw new Error(`Pi 模板路径无效：${String(relativePath)}`)
  }
  const normalized = relativePath.replaceAll('\\', '/')
  const target = path.resolve(repoRoot, ...normalized.split('/'))
  if (!isPathInside(repoRoot, target)) {
    throw new Error(`Pi 模板路径越界：${relativePath}`)
  }
  return target
}

function ensureDirectoryInside(repoRoot, directory) {
  let existing = directory
  while (true) {
    try {
      const real = fs.realpathSync.native(existing)
      if (real !== repoRoot && !isPathInside(repoRoot, real)) {
        throw new Error(`Pi 模板目录越界：${directory}`)
      }
      break
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      const parent = path.dirname(existing)
      if (parent === existing) throw error
      existing = parent
    }
  }
  fs.mkdirSync(directory, { recursive: true })
  const realDirectory = fs.realpathSync.native(directory)
  if (realDirectory !== repoRoot && !isPathInside(repoRoot, realDirectory)) {
    throw new Error(`Pi 模板目录越界：${directory}`)
  }
}

function rollback(createdFiles) {
  for (const file of createdFiles.reverse()) {
    try {
      fs.rmSync(file, { force: true })
    } catch {
      // 清理是尽力而为，原始写入错误更有诊断价值。
    }
  }
}

async function main() {
  const [, , runtimeRootArg, repoRootArg] = process.argv
  if (!runtimeRootArg || !repoRootArg) {
    throw new Error('缺少 Trellis runtime 或仓库根目录参数')
  }

  const runtimeRoot = path.resolve(runtimeRootArg)
  const repoRoot = fs.realpathSync.native(path.resolve(repoRootArg))
  const moduleFile = path.join(
    runtimeRoot,
    'node_modules',
    '@mindfoldhq',
    'trellis',
    'dist',
    'configurators',
    'index.js',
  )
  fs.accessSync(moduleFile, fs.constants.R_OK)
  const { collectPlatformTemplates } = await import(pathToFileURL(moduleFile).href)
  const templates = collectPlatformTemplates('pi')
  if (!(templates instanceof Map) || templates.size === 0) {
    throw new Error('Trellis 没有返回 Pi 模板')
  }

  const createdFiles = []
  const created = []
  const skipped = []
  try {
    for (const [relativePath, content] of templates) {
      if (typeof content !== 'string') {
        throw new Error(`Pi 模板内容无效：${relativePath}`)
      }
      const target = resolveTemplateTarget(repoRoot, relativePath)
      try {
        fs.lstatSync(target)
        skipped.push(relativePath)
        continue
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }

      ensureDirectoryInside(repoRoot, path.dirname(target))
      let descriptor
      let ownsTarget = false
      try {
        descriptor = fs.openSync(target, 'wx')
        ownsTarget = true
        createdFiles.push(target)
        fs.writeFileSync(descriptor, content, 'utf8')
        fs.closeSync(descriptor)
        descriptor = undefined
        created.push(relativePath)
      } catch (error) {
        if (descriptor !== undefined) {
          try {
            fs.closeSync(descriptor)
          } catch {
            // 原始写入错误优先。
          }
        }
        if (error.code === 'EEXIST' && !ownsTarget) {
          skipped.push(relativePath)
          continue
        }
        throw error
      }
    }
  } catch (error) {
    rollback(createdFiles)
    throw error
  }

  process.stdout.write(`${JSON.stringify({ created: created.length, skipped: skipped.length })}\n`)
}

try {
  await main()
} catch (error) {
  process.stderr.write(
    `Pi 模板补齐失败：${error instanceof Error ? error.message : String(error)}\n`,
  )
  process.exitCode = 1
}
