import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  databaseFile as defaultDatabaseFile,
  defaultRepositories,
  metadataFile,
  normalizeRepositoryEntry,
  repositoriesFile,
  repositoryPathKey,
  scanCacheFile,
  stateFile
} from "./config.js";

export const DATABASE_SCHEMA_VERSION = 1;

const LEGACY_IMPORT_KEY = "legacy_json_imported_v1";
let defaultDatabase = null;

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function readLegacyJson(file, label, logger) {
  try {
    return {
      exists: true,
      value: JSON.parse(fs.readFileSync(file, "utf8"))
    };
  } catch (error) {
    if (error?.code !== "ENOENT") {
      logger.warn(`跳过无法读取的旧数据 ${label}: ${errorMessage(error)}`);
    }
    return { exists: error?.code !== "ENOENT", value: null };
  }
}

function readMeta(db, key) {
  return db.prepare("SELECT value FROM app_meta WHERE key = ?").get(key)?.value ?? null;
}

function writeMeta(db, key, value) {
  db.prepare(`
    INSERT INTO app_meta(key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `).run(key, String(value), new Date().toISOString());
}

function ensureSchema(db) {
  withTransaction(db, () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS repositories (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        path_key TEXT NOT NULL UNIQUE,
        position INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS task_stage (
        task_key TEXT PRIMARY KEY,
        stage TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS scan_cache (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        schema_version INTEGER NOT NULL,
        saved_at TEXT NOT NULL,
        board_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS board_state (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    const schemaVersion = readMeta(db, "schema_version");
    if (schemaVersion == null) {
      writeMeta(db, "schema_version", DATABASE_SCHEMA_VERSION);
    } else if (Number(schemaVersion) !== DATABASE_SCHEMA_VERSION) {
      throw new Error(`不支持的数据库 schema 版本: ${schemaVersion}`);
    }
  });
}

function importRepositories(db, legacyFile, fallbackRepositories, logger) {
  const legacy = readLegacyJson(legacyFile, "data/repos.json", logger);
  let entries;
  if (!legacy.exists) {
    entries = fallbackRepositories.map((repoPath) => ({ path: repoPath }));
  } else if (!legacy.value) {
    return;
  } else if (!Array.isArray(legacy.value.repositories)) {
    logger.warn("跳过结构无效的旧数据 data/repos.json: 缺少 repositories 数组");
    return;
  } else {
    entries = legacy.value.repositories;
  }

  const now = new Date().toISOString();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO repositories(
      id, name, path, path_key, position, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  let position = 0;
  entries.forEach((entry, sourceIndex) => {
    try {
      const repository = normalizeRepositoryEntry(entry);
      const result = insert.run(
        repository.id,
        repository.name,
        repository.path,
        repositoryPathKey(repository.path),
        position,
        now,
        now
      );
      if (result.changes > 0) position += 1;
    } catch (error) {
      logger.warn(`跳过无效的旧项目记录 data/repos.json[${sourceIndex}]: ${errorMessage(error)}`);
    }
  });
}

function importManualStages(db, legacyFile, logger) {
  const legacy = readLegacyJson(legacyFile, "data/task-metadata.json", logger);
  if (!legacy.value || typeof legacy.value.tasks !== "object" || !legacy.value.tasks) return;

  const now = new Date().toISOString();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO task_stage(task_key, stage, updated_at)
    VALUES (?, ?, ?)
  `);
  for (const [taskKey, record] of Object.entries(legacy.value.tasks)) {
    const stage = String(record?.stage || "").trim();
    if (!taskKey || !stage) continue;
    const updatedAt = typeof record?.updatedAt === "string" ? record.updatedAt : now;
    insert.run(taskKey, stage, updatedAt);
  }
}

function importScanCache(db, legacyFile, logger) {
  const legacy = readLegacyJson(legacyFile, "data/scan-cache.json", logger);
  const board = legacy.value?.board;
  if (!board || typeof board !== "object" || Array.isArray(board)) return;
  const schemaVersion = Number(legacy.value.schemaVersion);
  if (!Number.isInteger(schemaVersion)) {
    logger.warn("跳过结构无效的旧数据 data/scan-cache.json: schemaVersion 不是整数");
    return;
  }
  const savedAt = typeof legacy.value.savedAt === "string"
    ? legacy.value.savedAt
    : new Date().toISOString();
  db.prepare(`
    INSERT INTO scan_cache(id, schema_version, saved_at, board_json)
    VALUES (1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      schema_version = excluded.schema_version,
      saved_at = excluded.saved_at,
      board_json = excluded.board_json
  `).run(schemaVersion, savedAt, JSON.stringify(board));
}

function importBoardState(db, legacyFile, logger) {
  const legacy = readLegacyJson(legacyFile, "data/board-state.json", logger);
  if (!legacy.value || Array.isArray(legacy.value) || typeof legacy.value !== "object") return;

  const now = new Date().toISOString();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO board_state(key, value_json, updated_at)
    VALUES (?, ?, ?)
  `);
  for (const [key, value] of Object.entries(legacy.value)) {
    insert.run(key, JSON.stringify(value), now);
  }
}

function importLegacyData(db, legacyFiles, fallbackRepositories, logger) {
  withTransaction(db, () => {
    if (readMeta(db, LEGACY_IMPORT_KEY) === "1") return;
    importRepositories(db, legacyFiles.repositoriesFile, fallbackRepositories, logger);
    importManualStages(db, legacyFiles.metadataFile, logger);
    importScanCache(db, legacyFiles.scanCacheFile, logger);
    importBoardState(db, legacyFiles.stateFile, logger);
    writeMeta(db, LEGACY_IMPORT_KEY, 1);
  });
}

export function withTransaction(db, callback) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = callback();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // 保留原始失败，避免回滚错误覆盖真正原因。
    }
    throw error;
  }
}

export function openDatabase({
  databaseFile = defaultDatabaseFile,
  legacyFiles = {},
  fallbackRepositories = defaultRepositories,
  logger = console
} = {}) {
  if (databaseFile !== ":memory:") {
    fs.mkdirSync(path.dirname(databaseFile), { recursive: true });
  }

  const db = new DatabaseSync(databaseFile);
  try {
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    ensureSchema(db);
    importLegacyData(db, {
      repositoriesFile,
      metadataFile,
      scanCacheFile,
      stateFile,
      ...legacyFiles
    }, fallbackRepositories, logger);
    return db;
  } catch (error) {
    try {
      db.close();
    } catch {
      // 打开阶段失败时不再覆盖原始异常。
    }
    throw error;
  }
}

export function getDefaultDatabase() {
  if (!defaultDatabase) {
    defaultDatabase = openDatabase();
  }
  return defaultDatabase;
}
