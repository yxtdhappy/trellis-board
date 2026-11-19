import {
  metadataFile,
  normalizeRepositoryEntry,
  repositoriesFile,
  repositoryPathKey,
  scanCacheFile,
  stateFile,
} from './config.js'
import {
  LEGACY_IMPORT_KEY,
  errorMessage,
  readLegacyJson,
  readMeta,
  writeMeta,
} from './database-meta.js'
import { withTransaction } from './database-transaction.js'

export function importRepositories(db, legacyFile, fallbackRepositories, logger) {
  const legacy = readLegacyJson(legacyFile, 'repos.json', logger)
  let entries
  if (!legacy.exists) {
    entries = fallbackRepositories.map((repoPath) => ({ path: repoPath }))
  } else if (!legacy.value) {
    return
  } else if (!Array.isArray(legacy.value.repositories)) {
    logger.warn('跳过结构无效的旧数据 repos.json: 缺少 repositories 数组')
    return
  } else {
    entries = legacy.value.repositories
  }

  const now = new Date().toISOString()
  const insert = db.prepare(`
    INSERT OR IGNORE INTO repositories(
      id, name, path, path_key, position, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
  let position = 0
  entries.forEach((entry, sourceIndex) => {
    try {
      const repository = normalizeRepositoryEntry(entry)
      const result = insert.run(
        repository.id,
        repository.name,
        repository.path,
        repositoryPathKey(repository.path),
        position,
        now,
        now,
      )
      if (result.changes > 0) position += 1
    } catch (error) {
      logger.warn(`跳过无效的旧项目记录 repos.json[${sourceIndex}]: ${errorMessage(error)}`)
    }
  })
}

export function importManualStages(db, legacyFile, logger) {
  const legacy = readLegacyJson(legacyFile, 'task-metadata.json', logger)
  if (!legacy.value || typeof legacy.value.tasks !== 'object' || !legacy.value.tasks) return

  const now = new Date().toISOString()
  const insert = db.prepare(`
    INSERT OR IGNORE INTO task_stage(task_key, stage, updated_at)
    VALUES (?, ?, ?)
  `)
  for (const [taskKey, record] of Object.entries(legacy.value.tasks)) {
    const stage = String(record?.stage || '').trim()
    if (!taskKey || !stage) continue
    const updatedAt = typeof record?.updatedAt === 'string' ? record.updatedAt : now
    insert.run(taskKey, stage, updatedAt)
  }
}

export function importScanCache(db, legacyFile, logger) {
  const legacy = readLegacyJson(legacyFile, 'scan-cache.json', logger)
  const board = legacy.value?.board
  if (!board || typeof board !== 'object' || Array.isArray(board)) return
  const schemaVersion = Number(legacy.value.schemaVersion)
  if (!Number.isInteger(schemaVersion)) {
    logger.warn('跳过结构无效的旧数据 scan-cache.json: schemaVersion 不是整数')
    return
  }
  const savedAt =
    typeof legacy.value.savedAt === 'string' ? legacy.value.savedAt : new Date().toISOString()
  db.prepare(`
    INSERT INTO scan_cache(id, schema_version, saved_at, board_json)
    VALUES (1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      schema_version = excluded.schema_version,
      saved_at = excluded.saved_at,
      board_json = excluded.board_json
  `).run(schemaVersion, savedAt, JSON.stringify(board))
}

export function importBoardState(db, legacyFile, logger) {
  const legacy = readLegacyJson(legacyFile, 'board-state.json', logger)
  if (!legacy.value || Array.isArray(legacy.value) || typeof legacy.value !== 'object') return

  const now = new Date().toISOString()
  const insert = db.prepare(`
    INSERT OR IGNORE INTO board_state(key, value_json, updated_at)
    VALUES (?, ?, ?)
  `)
  for (const [key, value] of Object.entries(legacy.value)) {
    insert.run(key, JSON.stringify(value), now)
  }
}

export function importLegacyData(
  db,
  legacyFiles,
  fallbackRepositories,
  logger,
  importLegacyRepositories = true,
) {
  withTransaction(db, () => {
    if (readMeta(db, LEGACY_IMPORT_KEY) === '1') return
    if (importLegacyRepositories) {
      importRepositories(db, legacyFiles.repositoriesFile, fallbackRepositories, logger)
    }
    importManualStages(db, legacyFiles.metadataFile, logger)
    importScanCache(db, legacyFiles.scanCacheFile, logger)
    importBoardState(db, legacyFiles.stateFile, logger)
    writeMeta(db, LEGACY_IMPORT_KEY, 1)
  })
}
