import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { appDir, dataDir, legacyDataDir, repositoryPathKey } from './config.js'

const LAYOUT_MARKER = '.layout-v1'

const RUNTIME_ENTRIES = [
  'board.sqlite',
  'board.sqlite-wal',
  'board.sqlite-shm',
  'git-credentials.key',
  'repos.json',
  'task-metadata.json',
  'scan-cache.json',
  'board-state.json',
  'plugins.json',
  'plugins.secrets.json',
  'plugins',
  'backups',
  'projects',
]
const GENERATED_ENTRIES = ['.git-auth', '.empty-git-hooks', '.empty-git-config']

function isInside(root, candidate) {
  const relative = path.relative(root, candidate)
  return (
    Boolean(relative) &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  )
}

function existingEntries(sourceDir) {
  return RUNTIME_ENTRIES.filter((name) => fs.existsSync(path.join(sourceDir, name)))
}

function copyRuntimeEntries(sourceDir, targetDir, entries) {
  for (const name of entries) {
    const source = path.join(sourceDir, name)
    if (fs.lstatSync(source).isSymbolicLink()) {
      throw new Error(`运行数据包含符号链接，拒绝迁移: ${name}`)
    }
    fs.cpSync(source, path.join(targetDir, name), {
      recursive: true,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
    })
  }
}

function backupDatabase(stagingDir, sourceDir, stamp) {
  const database = path.join(sourceDir, 'board.sqlite')
  if (!fs.existsSync(database)) return
  const backupDir = path.join(stagingDir, 'backups', `layout-v1-${stamp}`)
  fs.mkdirSync(backupDir, { recursive: true })
  for (const suffix of ['', '-wal', '-shm']) {
    const source = `${database}${suffix}`
    if (fs.existsSync(source)) {
      fs.copyFileSync(source, path.join(backupDir, `board.sqlite${suffix}`))
    }
  }
}

function databaseCounts(db) {
  return {
    repositories: Number(db.prepare('SELECT COUNT(*) AS count FROM repositories').get().count),
    projects: Number(db.prepare('SELECT COUNT(*) AS count FROM team_project').get().count),
  }
}

function assertDatabaseIntegrity(file) {
  if (!fs.existsSync(file)) return
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const rows = db.prepare('PRAGMA integrity_check').all()
    if (rows.length !== 1 || rows[0]?.integrity_check !== 'ok') {
      const details = rows.map((row) => String(row.integrity_check || '')).join('; ')
      throw new Error(`数据库完整性检查失败: ${details || '未知错误'}`)
    }
  } finally {
    db.close()
  }
}

function rebaseProjectPaths(stagingDir, sourceDir, targetDir) {
  const stagingDatabase = path.join(stagingDir, 'board.sqlite')
  if (!fs.existsSync(stagingDatabase)) return

  const sourceProjects = path.resolve(sourceDir, 'projects')
  const stagingProjects = path.resolve(stagingDir, 'projects')
  const targetProjects = path.resolve(targetDir, 'projects')
  const db = new DatabaseSync(stagingDatabase)
  try {
    db.exec('PRAGMA foreign_keys = ON')
    db.exec('PRAGMA busy_timeout = 5000')
    const beforeCounts = databaseCounts(db)
    const rows = db
      .prepare(`
        SELECT r.id, r.path, p.workspace_key
        FROM repositories r
        LEFT JOIN team_project p ON p.repository_id = r.id
      `)
      .all()
    const update = db.prepare(`
      UPDATE repositories
      SET path = ?, path_key = ?
      WHERE id = ?
    `)
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const row of rows) {
        const oldPath = path.resolve(String(row.path || ''))
        if (!isInside(sourceProjects, oldPath)) continue
        const workspaceKey = String(row.workspace_key || path.basename(oldPath)).trim()
        if (!workspaceKey || workspaceKey === '.' || workspaceKey === '..') {
          throw new Error(`无法确定迁移项目目录: ${oldPath}`)
        }
        const stagedPath = path.join(stagingProjects, workspaceKey)
        if (!fs.existsSync(stagedPath) || !fs.statSync(stagedPath).isDirectory()) {
          throw new Error(`迁移后的项目目录不存在: ${workspaceKey}`)
        }
        const migratedPath = path.join(targetProjects, workspaceKey)
        update.run(migratedPath.replaceAll('\\', '/'), repositoryPathKey(migratedPath), row.id)
      }
      db.exec('COMMIT')
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // 保留迁移失败原因。
      }
      throw error
    }

    const stagedCounts = databaseCounts(db)
    if (
      beforeCounts.repositories !== stagedCounts.repositories ||
      beforeCounts.projects !== stagedCounts.projects
    ) {
      throw new Error('数据库迁移后的项目计数不一致')
    }
    assertDatabaseIntegrity(stagingDatabase)
  } finally {
    db.close()
  }
}

function installStaging(stagingDir, targetDir) {
  if (fs.existsSync(targetDir)) {
    const entries = fs.readdirSync(targetDir)
    if (entries.some((name) => name !== LAYOUT_MARKER)) {
      throw new Error(`目标数据目录非空: ${targetDir}`)
    }
    if (entries.includes(LAYOUT_MARKER)) {
      fs.rmSync(path.join(targetDir, LAYOUT_MARKER), { force: false })
    }
    fs.rmdirSync(targetDir)
  }
  fs.renameSync(stagingDir, targetDir)
}

function removeMigratedSource(sourceDir, entries) {
  for (const name of [...entries, ...GENERATED_ENTRIES]) {
    const target = path.join(sourceDir, name)
    if (!isInside(sourceDir, target)) continue
    fs.rmSync(target, { recursive: true, force: true })
  }
  try {
    fs.rmdirSync(sourceDir)
  } catch (error) {
    if (error?.code !== 'ENOTEMPTY' && error?.code !== 'ENOENT') throw error
  }
}

export function migrateLegacyRuntimeData({
  sourceDir = legacyDataDir,
  targetDir = dataDir,
  appRoot = appDir,
} = {}) {
  const source = path.resolve(sourceDir)
  const target = path.resolve(targetDir)
  const sourceRoot = path.resolve(appRoot)
  if (source === target) return { migrated: false, entries: [] }
  const sourceWorkspace = path.dirname(source)
  if (
    target === sourceRoot ||
    isInside(sourceRoot, target) ||
    target === sourceWorkspace ||
    isInside(sourceWorkspace, target)
  ) {
    throw new Error('TRELLIS_BOARD_DATA_DIR 必须位于源码工作树之外')
  }

  fs.mkdirSync(path.dirname(target), { recursive: true })
  const targetDatabase = path.join(target, 'board.sqlite')
  if (fs.existsSync(targetDatabase)) {
    const remaining = existingEntries(source)
    if (remaining.length) {
      throw new Error(`目标数据目录已有数据库，旧运行数据未自动合并: ${remaining.join(', ')}`)
    }
    return { migrated: false, entries: [] }
  }
  if (fs.existsSync(target)) {
    if (!fs.statSync(target).isDirectory()) throw new Error(`目标数据路径不是目录: ${target}`)
    const entries = fs.readdirSync(target)
    if (entries.some((name) => name !== LAYOUT_MARKER)) {
      throw new Error(`目标数据目录非空: ${target}`)
    }
  }

  const entries = existingEntries(source)
  if (!entries.length) {
    fs.mkdirSync(target, { recursive: true })
    const marker = path.join(target, LAYOUT_MARKER)
    if (!fs.existsSync(marker)) {
      fs.writeFileSync(marker, `${new Date().toISOString()}\n`, 'utf8')
    }
    removeMigratedSource(source, [])
    return { migrated: false, entries: [] }
  }

  const staging = fs.mkdtempSync(path.join(path.dirname(target), '.trellis-board-data-'))
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    copyRuntimeEntries(source, staging, entries)
    backupDatabase(staging, source, stamp)
    rebaseProjectPaths(staging, source, target)
    fs.writeFileSync(path.join(staging, LAYOUT_MARKER), `${new Date().toISOString()}\n`, 'utf8')
    installStaging(staging, target)
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    throw error
  }

  removeMigratedSource(source, entries)
  return { migrated: true, entries }
}
