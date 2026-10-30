import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

test("初始化数据库会创建 schema v1 和迁移标记", () => {
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
      "scan_cache",
      "task_stage"
    ]);
    const meta = Object.fromEntries(
      db.prepare("SELECT key, value FROM app_meta").all()
        .map((row) => [row.key, row.value])
    );
    assert.equal(meta.schema_version, "1");
    assert.equal(meta.legacy_json_imported_v1, "1");
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
