import fs from 'node:fs'

export const LEGACY_IMPORT_KEY = 'legacy_json_imported_v1'

export const EXECUTION_EVENTS_STARTED_KEY = 'execution_events_started_at'

export function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

export function readLegacyJson(file, label, logger) {
  try {
    return {
      exists: true,
      value: JSON.parse(fs.readFileSync(file, 'utf8')),
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      logger.warn(`跳过无法读取的旧数据 ${label}: ${errorMessage(error)}`)
    }
    return { exists: error?.code !== 'ENOENT', value: null }
  }
}

export function readMeta(db, key) {
  return db.prepare('SELECT value FROM app_meta WHERE key = ?').get(key)?.value ?? null
}

export function writeMeta(db, key, value) {
  db.prepare(`
    INSERT INTO app_meta(key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `).run(key, String(value), new Date().toISOString())
}
