import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../server/database.js";
import {
  getManualRecord,
  getManualRecords,
  setManualStage
} from "../server/metadata.js";

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-metadata-"));
  const dataDir = path.join(root, "data");
  return {
    root,
    databaseFile: path.join(dataDir, "board.sqlite"),
    legacyFiles: {
      repositoriesFile: path.join(dataDir, "repos.json"),
      metadataFile: path.join(dataDir, "task-metadata.json"),
      scanCacheFile: path.join(dataDir, "scan-cache.json"),
      stateFile: path.join(dataDir, "board-state.json")
    }
  };
}

function openTestDatabase(workspace) {
  return openDatabase({
    databaseFile: workspace.databaseFile,
    legacyFiles: workspace.legacyFiles,
    fallbackRepositories: [],
    logger: { warn() {} }
  });
}

test("人工阶段写入 SQLite 并在重开后保持可见", () => {
  const workspace = makeWorkspace();
  let db;
  try {
    db = openTestDatabase(workspace);
    const saved = setManualStage("demo", "10-30-demo", "check", db);
    assert.equal(saved.stage, "check");
    assert.equal(getManualRecord("demo", "10-30-demo", db).stage, "check");
    assert.deepEqual(
      Object.keys(getManualRecords(db)),
      ["demo/10-30-demo"]
    );
    assert.equal(fs.existsSync(workspace.legacyFiles.metadataFile), false);
    db.close();
    db = null;

    db = openTestDatabase(workspace);
    assert.equal(getManualRecord("demo", "10-30-demo", db).stage, "check");
  } finally {
    try {
      db?.close();
    } catch {
      // 忽略已关闭连接。
    }
    fs.rmSync(workspace.root, { recursive: true, force: true });
  }
});

test("更新人工阶段会原子覆盖原记录", () => {
  const workspace = makeWorkspace();
  let db;
  try {
    db = openTestDatabase(workspace);
    setManualStage("demo", "10-30-demo", "design", db);
    setManualStage("demo", "10-30-demo", "implement", db);
    assert.equal(getManualRecord("demo", "10-30-demo", db).stage, "implement");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM task_stage").get().count, 1);
  } finally {
    try {
      db?.close();
    } catch {
      // 忽略已关闭连接。
    }
    fs.rmSync(workspace.root, { recursive: true, force: true });
  }
});

test("未知人工阶段不会写入数据库", () => {
  const workspace = makeWorkspace();
  let db;
  try {
    db = openTestDatabase(workspace);
    assert.throws(
      () => setManualStage("demo", "10-30-demo", "unknown", db),
      /未知阶段/
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM task_stage").get().count, 0);
  } finally {
    try {
      db?.close();
    } catch {
      // 忽略已关闭连接。
    }
    fs.rmSync(workspace.root, { recursive: true, force: true });
  }
});
