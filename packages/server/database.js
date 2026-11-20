import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  databaseFile as defaultDatabaseFile,
  metadataFile,
  repositoriesFile,
  scanCacheFile,
  stateFile,
} from './config.js'
import { BASE_SCHEMA_V1_SQL, DATABASE_SCHEMA_VERSION, tableExists } from './database-sql/index.js'
import {
  backupBeforeUpgrade,
  ensureV2Schema,
  ensureV3Schema,
  ensureV4Schema,
  ensureV5Schema,
  ensureV6Schema,
  ensureV7Schema,
  ensureV8Schema,
  ensureV9Schema,
  ensureV11Schema,
  ensureV12Schema,
  ensureV13Schema,
  ensureV14Schema,
  ensureV15Schema,
  ensureV16Schema,
  ensureV17Schema,
  ensureV18Schema,
} from './database-migrations.js'
import { importLegacyData } from './database-legacy-import.js'
import { readMeta, writeMeta } from './database-meta.js'
import { withTransaction } from './database-transaction.js'

export { DATABASE_SCHEMA_VERSION, withTransaction }

let defaultDatabase = null

function ensureSchema(db, { databaseFile } = {}) {
  const schemaVersion = tableExists(db, 'app_meta') ? readMeta(db, 'schema_version') : null
  const numericVersion = schemaVersion == null ? null : Number(schemaVersion)

  if (
    numericVersion !== null &&
    ![6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18].includes(numericVersion)
  ) {
    throw new Error(
      `不支持的数据库 schema 版本: ${schemaVersion}；本版本不做旧库迁移，请删除当前 board.sqlite 后重建`,
    )
  }
  if (numericVersion !== null && numericVersion >= 6 && numericVersion < DATABASE_SCHEMA_VERSION) {
    backupBeforeUpgrade(db, databaseFile)
  }

  withTransaction(db, () => {
    db.exec(BASE_SCHEMA_V1_SQL)
    ensureV2Schema(db, new Date().toISOString())
    ensureV3Schema(db)
    ensureV4Schema(db)
    ensureV5Schema(db)
    ensureV6Schema(db)
    ensureV7Schema(db)
    ensureV8Schema(db)
    ensureV9Schema(db)
    ensureV11Schema(db)
    ensureV12Schema(db)
    ensureV13Schema(db)
    ensureV14Schema(db)
    ensureV15Schema(db)
    ensureV16Schema(db)
    ensureV17Schema(db)
    ensureV18Schema(db)
    if (numericVersion == null || numericVersion < DATABASE_SCHEMA_VERSION) {
      writeMeta(db, 'schema_version', DATABASE_SCHEMA_VERSION)
    }
  })
}

export function openDatabase({
  databaseFile = defaultDatabaseFile,
  legacyFiles = {},
  fallbackRepositories = [],
  importLegacyRepositories = true,
  legacyJsonImport = true,
  logger = console,
} = {}) {
  if (databaseFile !== ':memory:') {
    fs.mkdirSync(path.dirname(databaseFile), { recursive: true })
  }

  const db = new DatabaseSync(databaseFile)
  try {
    // SQLite 内置 lower() 只折叠 ASCII，分支筛选需要与前端一致的 Unicode 小写语义。
    db.function('trellis_lower', { deterministic: true }, (value) =>
      String(value ?? '').toLowerCase(),
    )
    db.exec('PRAGMA foreign_keys = ON')
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = NORMAL')
    ensureSchema(db, { databaseFile })
    if (legacyJsonImport) {
      importLegacyData(
        db,
        {
          repositoriesFile,
          metadataFile,
          scanCacheFile,
          stateFile,
          ...legacyFiles,
        },
        fallbackRepositories,
        logger,
        importLegacyRepositories,
      )
    }
    return db
  } catch (error) {
    try {
      db.close()
    } catch {
      // 打开阶段失败时不再覆盖原始异常。
    }
    throw error
  }
}

export function getDefaultDatabase({ logger = console } = {}) {
  if (!defaultDatabase) {
    defaultDatabase = openDatabase({ logger })
  }
  return defaultDatabase
}
