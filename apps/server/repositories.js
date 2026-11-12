import fs from 'node:fs'
import path from 'node:path'
import { repositoryPathKey } from './config.js'
import { getDefaultDatabase, withTransaction } from './database.js'
import { purgeProjectExecutionData } from './execution-store.js'

function idBase(repoPath) {
  return (
    path
      .basename(repoPath)
      .normalize('NFKC')
      .replace(/[^\p{L}\p{N}._-]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase() || 'repository'
  )
}

function nextId(entries, repoPath) {
  const base = idBase(repoPath)
  const used = new Set(entries.map((repo) => repo.id.toLowerCase()))
  if (!used.has(base)) return base
  let suffix = 2
  while (used.has(`${base}-${suffix}`)) suffix += 1
  return `${base}-${suffix}`
}

function listStoredRepositories(db) {
  return db
    .prepare(`
    SELECT id, name, path
    FROM repositories
    ORDER BY position, rowid
  `)
    .all()
    .map((row) => ({
      id: row.id,
      name: row.name,
      path: row.path,
    }))
}

export function getRepositories(db = getDefaultDatabase()) {
  return listStoredRepositories(db).map((repository) => ({
    ...repository,
    path: path.resolve(repository.path),
  }))
}

export function createRepositoryStore({ db = getDefaultDatabase() } = {}) {
  const read = () => listStoredRepositories(db)

  function addMany(inputs = []) {
    if (!Array.isArray(inputs) || inputs.length === 0) {
      throw new Error('请至少选择一个项目文件夹')
    }

    const entries = read()
    const selectedPaths = new Set()
    const added = []

    for (const rawInput of inputs) {
      const input = typeof rawInput === 'string' ? { path: rawInput } : rawInput || {}
      const rawPath = String(input.path || '').trim()
      if (!rawPath) throw new Error('项目路径不能为空')

      const repoPath = path.resolve(rawPath)
      const key = repositoryPathKey(repoPath)
      const duplicatePath = entries.find((repo) => repositoryPathKey(repo.path) === key)
      if (duplicatePath) throw new Error(`该路径已在看板中：${duplicatePath.name}`)
      if (selectedPaths.has(key)) throw new Error(`本次选择包含重复路径：${repoPath}`)
      if (!fs.existsSync(repoPath) || !fs.statSync(repoPath).isDirectory()) {
        throw new Error(`项目目录不存在：${repoPath}`)
      }

      const trellisDir = path.join(repoPath, '.trellis')
      if (!fs.existsSync(trellisDir) || !fs.statSync(trellisDir).isDirectory()) {
        throw new Error(`目标目录尚未初始化 Trellis，缺少 .trellis 目录：${repoPath}`)
      }

      const basename = path.basename(repoPath)
      const repository = {
        id: nextId([...entries, ...added], repoPath),
        name: String(input.name || basename).trim() || basename,
        path: repoPath.replaceAll('\\', '/'),
      }
      selectedPaths.add(key)
      added.push(repository)
    }

    const now = new Date().toISOString()
    withTransaction(db, () => {
      const insert = db.prepare(`
        INSERT INTO repositories(
          id, name, path, path_key, position, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      added.forEach((repository, index) => {
        insert.run(
          repository.id,
          repository.name,
          repository.path,
          repositoryPathKey(repository.path),
          entries.length + index,
          now,
          now,
        )
      })
    })
    return added
  }

  return {
    list() {
      return read()
    },

    addMany,

    add(input = {}) {
      return addMany([input])[0]
    },

    remove(input = {}) {
      const id = String(input.id || '').trim()
      if (!id) throw new Error('缺少项目 ID')

      const entries = read()
      const index = entries.findIndex((repo) => repo.id === id)
      if (index < 0) throw new Error('项目不在看板中')

      const removed = entries[index]
      withTransaction(db, () => {
        const stagePrefix = `${id}/`
        // 人工阶段没有外键，移除项目时同步清理，避免同路径重加后继承旧阶段。
        db.prepare(`
          DELETE FROM task_stage
          WHERE substr(task_key, 1, ?) = ?
        `).run(stagePrefix.length, stagePrefix)
        purgeProjectExecutionData(db, id)
        db.prepare('DELETE FROM repositories WHERE id = ?').run(id)
        db.prepare(`
          UPDATE repositories
          SET position = position - 1, updated_at = ?
          WHERE position > ?
        `).run(new Date().toISOString(), index)
      })
      return removed
    },
  }
}
