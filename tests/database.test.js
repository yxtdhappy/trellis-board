import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../server/database.js";
import { createPersistenceStore } from "../server/persistence.js";

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-database-"));
  const dataDir = path.join(root, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  return {
    root,
    databaseFile: path.join(dataDir, "board.sqlite"),
    legacyFiles: {
      repositoriesFile: path.join(dataDir, "repos.json"),
      metadataFile: path.join(dataDir, "task-metadata.json"),
      scanCacheFile: path.join(dataDir, "scan-cache.json"),
      stateFile: path.join(dataDir, "board-state.json")
    },
    warnings: []
  };
}

function openTestDatabase(workspace, options = {}) {
  return openDatabase({
    databaseFile: workspace.databaseFile,
    legacyFiles: workspace.legacyFiles,
    fallbackRepositories: [],
    logger: {
      warn(message) {
        workspace.warnings.push(message);
      }
    },
    ...options
  });
}

function closeQuietly(db) {
  try {
    db?.close();
  } catch {
    // 数据库可能已在失败路径关闭。
  }
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function createV1Database(workspace) {
  fs.mkdirSync(path.dirname(workspace.databaseFile), { recursive: true });
  const db = new DatabaseSync(workspace.databaseFile);
  db.exec(`
    CREATE TABLE app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE repositories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      path_key TEXT NOT NULL UNIQUE,
      position INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE task_stage (
      task_key TEXT PRIMARY KEY,
      stage TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE scan_cache (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      schema_version INTEGER NOT NULL,
      saved_at TEXT NOT NULL,
      board_json TEXT NOT NULL
    );
    CREATE TABLE board_state (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  db.prepare(`
    INSERT INTO app_meta(key, value, updated_at)
    VALUES ('schema_version', '1', ?)
  `).run(new Date().toISOString());
  db.close();
}

function v2TableSql(databaseFile) {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return db.prepare(`
      SELECT name, sql
      FROM sqlite_master
      WHERE type = 'table'
        AND name IN ('task_execution', 'task_tag', 'saved_view', 'task_event')
      ORDER BY name
    `).all().map((row) => ({ name: row.name, sql: row.sql }));
  } finally {
    db.close();
  }
}

test("新库直接创建 schema v2、扩展表和事件起点", () => {
  const workspace = makeWorkspace();
  let db;
  try {
    db = openTestDatabase(workspace);
    const tables = db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
      ORDER BY name
    `).all().map((row) => row.name);
    assert.deepEqual(tables, [
      "app_meta",
      "board_state",
      "repositories",
      "saved_view",
      "scan_cache",
      "sqlite_sequence",
      "task_event",
      "task_execution",
      "task_stage",
      "task_tag"
    ]);
    const meta = Object.fromEntries(
      db.prepare("SELECT key, value FROM app_meta").all()
        .map((row) => [row.key, row.value])
    );
    assert.equal(meta.schema_version, "2");
    assert.equal(meta.legacy_json_imported_v1, "1");
    assert.equal(Number.isNaN(Date.parse(meta.execution_events_started_at)), false);
    assert.equal(db.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
    assert.equal(db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
    assert.equal(db.prepare("PRAGMA busy_timeout").get().timeout, 5000);
    assert.equal(db.prepare("PRAGMA synchronous").get().synchronous, 1);
    assert.equal(fs.existsSync(workspace.databaseFile), true);
  } finally {
    closeQuietly(db);
    fs.rmSync(workspace.root, { recursive: true, force: true });
  }
});

test("v1 数据库在同一事务升级到 v2，并创建一次性备份", () => {
  const workspace = makeWorkspace();
  createV1Database(workspace);
  let db;
  try {
    db = openTestDatabase(workspace);
    assert.equal(
      db.prepare("SELECT value FROM app_meta WHERE key = 'schema_version'").get().value,
      "2"
    );
    const tables = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all().map((row) => row.name);
    assert.deepEqual(tables, [
      "app_meta",
      "board_state",
      "repositories",
      "saved_view",
      "scan_cache",
      "task_event",
      "task_execution",
      "task_stage",
      "task_tag"
    ]);
    assert.equal(fs.existsSync(`${workspace.databaseFile}.v1-backup`), true);
    const backup = new DatabaseSync(`${workspace.databaseFile}.v1-backup`, { readOnly: true });
    try {
      assert.equal(
        backup.prepare("SELECT value FROM app_meta WHERE key = 'schema_version'").get().value,
        "1"
      );
      assert.equal(
        backup.prepare(`
          SELECT COUNT(*) AS count
          FROM sqlite_master
          WHERE type = 'table' AND name = 'task_execution'
        `).get().count,
        0
      );
    } finally {
      backup.close();
    }
    const startedAt = db.prepare(`
      SELECT value FROM app_meta WHERE key = 'execution_events_started_at'
    `).get().value;
    db.close();
    db = null;

    db = openTestDatabase(workspace);
    assert.equal(
      db.prepare("SELECT value FROM app_meta WHERE key = 'execution_events_started_at'").get().value,
      startedAt
    );
    assert.equal(fs.existsSync(`${workspace.databaseFile}.v1-backup.1`), false);
  } finally {
    closeQuietly(db);
    fs.rmSync(workspace.root, { recursive: true, force: true });
  }
});

test("v2 新库与 v1 升级库的扩展表结构一致", () => {
  const fresh = makeWorkspace();
  const upgraded = makeWorkspace();
  let freshDb;
  let upgradedDb;
  try {
    freshDb = openTestDatabase(fresh);
    freshDb.close();
    freshDb = null;
    createV1Database(upgraded);
    upgradedDb = openTestDatabase(upgraded);
    assert.deepEqual(v2TableSql(fresh.databaseFile), v2TableSql(upgraded.databaseFile));
  } finally {
    closeQuietly(freshDb);
    closeQuietly(upgradedDb);
    fs.rmSync(fresh.root, { recursive: true, force: true });
    fs.rmSync(upgraded.root, { recursive: true, force: true });
  }
});

test("v1 到 v2 迁移失败会回滚新增表并保留版本 1", () => {
  const workspace = makeWorkspace();
  fs.mkdirSync(path.dirname(workspace.databaseFile), { recursive: true });
  const fixture = new DatabaseSync(workspace.databaseFile);
  fixture.exec(`
    CREATE TABLE app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO app_meta(key, value, updated_at)
    VALUES ('schema_version', '1', '2026-10-30T00:00:00.000Z');
    CREATE TABLE task_tag (
      execution_task_key TEXT PRIMARY KEY
    );
  `);
  fixture.close();

  try {
    assert.throws(
      () => openTestDatabase(workspace),
      /no such column: tag/
    );
    const db = new DatabaseSync(workspace.databaseFile, { readOnly: true });
    try {
      assert.equal(
        db.prepare("SELECT value FROM app_meta WHERE key = 'schema_version'").get().value,
        "1"
      );
      assert.equal(
        db.prepare(`
          SELECT COUNT(*) AS count
          FROM sqlite_master
          WHERE type = 'table' AND name = 'task_execution'
        `).get().count,
        0
      );
    } finally {
      db.close();
    }
    assert.equal(fs.existsSync(`${workspace.databaseFile}.v1-backup`), true);
  } finally {
    fs.rmSync(workspace.root, { recursive: true, force: true });
  }
});

test("旧 JSON 一次性导入 SQLite 且重复打开不会重复导入", () => {
  const workspace = makeWorkspace();
  const repositoryPath = path.join(workspace.root, "repos", "demo");
  fs.mkdirSync(path.join(repositoryPath, ".trellis"), { recursive: true });
  writeJson(workspace.legacyFiles.repositoriesFile, {
    repositories: [{ id: "demo", name: "演示项目", path: repositoryPath }]
  });
  writeJson(workspace.legacyFiles.metadataFile, {
    version: 1,
    tasks: {
      "demo/10-30-demo": {
        stage: "check",
        updatedAt: "2026-10-30T01:00:00.000Z"
      }
    }
  });
  writeJson(workspace.legacyFiles.scanCacheFile, {
    schemaVersion: 8,
    savedAt: "2026-10-30T02:00:00.000Z",
    board: { generatedAt: "2026-10-30T02:00:00.000Z", tasks: [] }
  });
  writeJson(workspace.legacyFiles.stateFile, {
    refreshQueued: false,
    lastWatchEvent: { relativePath: "tasks/demo" }
  });
  const legacyContents = Object.fromEntries(
    Object.entries(workspace.legacyFiles)
      .map(([key, file]) => [key, fs.readFileSync(file, "utf8")])
  );

  let db;
  try {
    db = openTestDatabase(workspace);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM repositories").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM task_stage").get().count, 1);
    const persistence = createPersistenceStore({ db });
    assert.deepEqual(persistence.readScanCache(8), {
      generatedAt: "2026-10-30T02:00:00.000Z",
      tasks: []
    });
    assert.deepEqual(persistence.readBoardState(), {
      refreshQueued: false,
      lastWatchEvent: { relativePath: "tasks/demo" }
    });
    const manualStage = db.prepare("SELECT stage, updated_at FROM task_stage").get();
    assert.equal(manualStage.stage, "check");
    assert.equal(manualStage.updated_at, "2026-10-30T01:00:00.000Z");
    db.close();
    db = null;

    db = openTestDatabase(workspace);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM repositories").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM task_stage").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM scan_cache").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM board_state").get().count, 2);
    for (const [key, contents] of Object.entries(legacyContents)) {
      assert.equal(fs.readFileSync(workspace.legacyFiles[key], "utf8"), contents);
    }
  } finally {
    closeQuietly(db);
    fs.rmSync(workspace.root, { recursive: true, force: true });
  }
});

test("清空已迁移项目后再次打开不会被默认项目回填", () => {
  const workspace = makeWorkspace();
  const repositoryPath = path.join(workspace.root, "repos", "demo");
  fs.mkdirSync(path.join(repositoryPath, ".trellis"), { recursive: true });
  writeJson(workspace.legacyFiles.repositoriesFile, {
    repositories: [{ id: "demo", name: "演示项目", path: repositoryPath }]
  });
  let db;
  try {
    db = openTestDatabase(workspace, {
      fallbackRepositories: [path.join(workspace.root, "should-not-import")]
    });
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM repositories").get().count, 1);
    db.prepare("DELETE FROM repositories").run();
    db.close();
    db = null;

    db = openTestDatabase(workspace, {
      fallbackRepositories: [path.join(workspace.root, "should-not-import")]
    });
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM repositories").get().count, 0);
  } finally {
    closeQuietly(db);
    fs.rmSync(workspace.root, { recursive: true, force: true });
  }
});

test("损坏的旧 JSON 会被跳过并保留原文件", () => {
  const workspace = makeWorkspace();
  const broken = "{这不是合法 JSON";
  for (const file of Object.values(workspace.legacyFiles)) {
    fs.writeFileSync(file, broken, "utf8");
  }
  let db;
  try {
    db = openTestDatabase(workspace);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM repositories").get().count, 0);
    assert.equal(
      db.prepare("SELECT value FROM app_meta WHERE key = 'legacy_json_imported_v1'").get().value,
      "1"
    );
    for (const file of Object.values(workspace.legacyFiles)) {
      assert.equal(fs.readFileSync(file, "utf8"), broken);
    }
    assert.deepEqual(
      workspace.warnings.map((message) => message.match(/data\/[^\s:]+\.json/)?.[0]).sort(),
      [
        "data/board-state.json",
        "data/repos.json",
        "data/scan-cache.json",
        "data/task-metadata.json"
      ]
    );
  } finally {
    closeQuietly(db);
    fs.rmSync(workspace.root, { recursive: true, force: true });
  }
});

test("不支持的数据库 schema 版本会拒绝启动", () => {
  const workspace = makeWorkspace();
  let db;
  try {
    db = openTestDatabase(workspace);
    db.prepare("UPDATE app_meta SET value = '999' WHERE key = 'schema_version'").run();
    db.close();
    db = null;
    assert.throws(
      () => openTestDatabase(workspace),
      /不支持的数据库 schema 版本: 999/
    );
  } finally {
    closeQuietly(db);
    fs.rmSync(workspace.root, { recursive: true, force: true });
  }
});
