import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../server/database.js";
import { createRepositoryStore } from "../server/repositories.js";

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-repositories-"));
  const dataDir = path.join(root, "data");
  const repo = path.join(root, "repos", "demo");
  fs.mkdirSync(path.join(repo, ".trellis", "tasks"), { recursive: true });
  return {
    root,
    repo,
    databaseFile: path.join(dataDir, "board.sqlite"),
    legacyFiles: {
      repositoriesFile: path.join(dataDir, "repos.json"),
      metadataFile: path.join(dataDir, "task-metadata.json"),
      scanCacheFile: path.join(dataDir, "scan-cache.json"),
      stateFile: path.join(dataDir, "board-state.json")
    }
  };
}

function openWorkspace(workspace) {
  const db = openDatabase({
    databaseFile: workspace.databaseFile,
    legacyFiles: workspace.legacyFiles,
    fallbackRepositories: [],
    logger: { warn() {} }
  });
  return {
    db,
    store: createRepositoryStore({ db })
  };
}

function closeQuietly(db) {
  try {
    db?.close();
  } catch {
    // 数据库可能已在失败路径关闭。
  }
}

test("新增项目会写入 SQLite 并避免重复路径", () => {
  const workspace = makeWorkspace();
  let db;
  try {
    ({ db } = openWorkspace(workspace));
    const store = createRepositoryStore({ db });
    const added = store.add({ name: "演示项目", path: workspace.repo });
    assert.equal(added.id, "demo");
    assert.equal(added.name, "演示项目");
    assert.equal(store.list().length, 1);

    const saved = db.prepare("SELECT name, path FROM repositories").get();
    assert.equal(saved.name, "演示项目");
    assert.equal(saved.path.endsWith("/repos/demo"), true);
    assert.equal(fs.existsSync(workspace.legacyFiles.repositoriesFile), false);
    assert.throws(() => store.add({ name: "重复", path: workspace.repo }), /已在看板中/);
  } finally {
    closeQuietly(db);
    fs.rmSync(workspace.root, { recursive: true, force: true });
  }
});

test("新增项目会拒绝未初始化 Trellis 的目录", () => {
  const workspace = makeWorkspace();
  let db;
  try {
    const plainDir = path.join(workspace.root, "plain");
    fs.mkdirSync(plainDir);
    ({ db } = openWorkspace(workspace));
    const store = createRepositoryStore({ db });
    assert.throws(
      () => store.add({ name: "普通目录", path: plainDir }),
      /缺少 \.trellis 目录/
    );
    assert.equal(store.list().length, 0);
  } finally {
    closeQuietly(db);
    fs.rmSync(workspace.root, { recursive: true, force: true });
  }
});

test("移除项目只修改数据库，不删除项目目录", () => {
  const workspace = makeWorkspace();
  let db;
  try {
    ({ db } = openWorkspace(workspace));
    const store = createRepositoryStore({ db });
    const added = store.add({ name: "演示项目", path: workspace.repo });
    const now = new Date().toISOString();
    const insertStage = db.prepare(
      "INSERT INTO task_stage(task_key, stage, updated_at) VALUES (?, ?, ?)"
    );
    insertStage.run("demo/.trellis/tasks/one", "check", now);
    insertStage.run("demo-2/.trellis/tasks/two", "spec", now);
    insertStage.run("other/.trellis/tasks/three", "check", now);
    const insertExecution = db.prepare(`
      INSERT INTO task_execution(
        execution_task_key, due_date, milestone, created_at, updated_at
      ) VALUES (?, NULL, '', ?, ?)
    `);
    insertExecution.run("demo::one", now, now);
    insertExecution.run("demo-2::two", now, now);
    insertExecution.run("other::three", now, now);
    const insertTag = db.prepare(`
      INSERT INTO task_tag(execution_task_key, tag, created_at)
      VALUES (?, ?, ?)
    `);
    insertTag.run("demo::one", "demo", now);
    insertTag.run("demo-2::two", "demo-2", now);
    insertTag.run("other::three", "other", now);
    const insertEvent = db.prepare(`
      INSERT INTO task_event(
        execution_task_key, event_type, source, actor, correlation_id,
        occurred_at, payload_json, reversible
      ) VALUES (?, 'tracking_started', 'system', 'system', ?, ?, '{}', 0)
    `);
    insertEvent.run("demo::one", "corr-1", now);
    insertEvent.run("demo-2::two", "corr-2", now);
    insertEvent.run("other::three", "corr-3", now);
    const insertDependency = db.prepare(`
      INSERT INTO task_dependency(
        id, blocker_task_key, blocked_task_key, reason, created_by,
        created_at, resolved_at
      ) VALUES (?, ?, ?, '清理测试', 'dev', ?, NULL)
    `);
    insertDependency.run("dep-blocker", "demo::one", "other::three", now);
    insertDependency.run("dep-blocked", "other::three", "demo::one", now);
    insertDependency.run("dep-keep", "demo-2::two", "other::three", now);
    db.prepare(`
      INSERT INTO saved_view(id, name, filter_json, position, created_at, updated_at)
      VALUES ('view-1', '保留视图', '{"priorities":["P1"]}', 0, ?, ?)
    `).run(now, now);
    const removed = store.remove({ id: added.id });
    assert.equal(removed.id, "demo");
    assert.equal(store.list().length, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM repositories").get().count, 0);
    assert.deepEqual(
      db.prepare("SELECT task_key FROM task_stage ORDER BY task_key").all()
        .map((row) => row.task_key),
      ["demo-2/.trellis/tasks/two", "other/.trellis/tasks/three"]
    );
    assert.deepEqual(
      db.prepare("SELECT execution_task_key FROM task_execution ORDER BY execution_task_key").all()
        .map((row) => row.execution_task_key),
      ["demo-2::two", "other::three"]
    );
    assert.deepEqual(
      db.prepare("SELECT execution_task_key FROM task_tag ORDER BY execution_task_key").all()
        .map((row) => row.execution_task_key),
      ["demo-2::two", "other::three"]
    );
    assert.deepEqual(
      db.prepare("SELECT execution_task_key FROM task_event ORDER BY execution_task_key").all()
        .map((row) => row.execution_task_key),
      ["demo-2::two", "other::three"]
    );
    assert.deepEqual(
      db.prepare("SELECT id FROM task_dependency ORDER BY id").all()
        .map((row) => row.id),
      ["dep-keep"]
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM saved_view").get().count, 1);
    assert.equal(fs.existsSync(workspace.repo), true);
    assert.equal(fs.existsSync(path.join(workspace.repo, ".trellis")), true);
  } finally {
    closeQuietly(db);
    fs.rmSync(workspace.root, { recursive: true, force: true });
  }
});

test("可以一次新增多个项目并自动使用文件夹名称", () => {
  const workspace = makeWorkspace();
  let db;
  try {
    const secondRepo = path.join(workspace.root, "repos", "second");
    fs.mkdirSync(path.join(secondRepo, ".trellis", "tasks"), { recursive: true });
    ({ db } = openWorkspace(workspace));
    const store = createRepositoryStore({ db });
    const added = store.addMany([{ path: workspace.repo }, { path: secondRepo }]);
    assert.deepEqual(added.map((repo) => repo.id), ["demo", "second"]);
    assert.deepEqual(added.map((repo) => repo.name), ["demo", "second"]);
    assert.equal(store.list().length, 2);
    assert.deepEqual(
      db.prepare("SELECT id, position FROM repositories ORDER BY position").all()
        .map((row) => [row.id, row.position]),
      [["demo", 0], ["second", 1]]
    );
  } finally {
    closeQuietly(db);
    fs.rmSync(workspace.root, { recursive: true, force: true });
  }
});

test("同名目录会生成不冲突的项目 ID", () => {
  const workspace = makeWorkspace();
  const duplicateNameRepo = path.join(workspace.root, "other", "demo");
  fs.mkdirSync(path.join(duplicateNameRepo, ".trellis"), { recursive: true });
  let db;
  try {
    ({ db } = openWorkspace(workspace));
    const store = createRepositoryStore({ db });
    const added = store.addMany([
      { path: workspace.repo },
      { path: duplicateNameRepo }
    ]);
    assert.deepEqual(added.map((repo) => repo.id), ["demo", "demo-2"]);
  } finally {
    closeQuietly(db);
    fs.rmSync(workspace.root, { recursive: true, force: true });
  }
});

test("旧数据中无效项目不会让新项目位置越过已有记录", () => {
  const workspace = makeWorkspace();
  const secondRepo = path.join(workspace.root, "repos", "second");
  const thirdRepo = path.join(workspace.root, "repos", "third");
  fs.mkdirSync(path.join(secondRepo, ".trellis"), { recursive: true });
  fs.mkdirSync(path.join(thirdRepo, ".trellis"), { recursive: true });
  fs.mkdirSync(path.dirname(workspace.legacyFiles.repositoriesFile), { recursive: true });
  fs.writeFileSync(workspace.legacyFiles.repositoriesFile, `${JSON.stringify({
    repositories: [
      { id: "demo", name: "演示项目", path: workspace.repo },
      { id: "invalid", name: "无效项目", path: "" },
      { id: "second", name: "第二个项目", path: secondRepo }
    ]
  }, null, 2)}\n`, "utf8");

  let db;
  try {
    ({ db } = openWorkspace(workspace));
    const store = createRepositoryStore({ db });
    store.add({ path: thirdRepo });
    assert.deepEqual(
      db.prepare("SELECT id, position FROM repositories ORDER BY position").all()
        .map((row) => [row.id, row.position]),
      [["demo", 0], ["second", 1], ["third", 2]]
    );
  } finally {
    closeQuietly(db);
    fs.rmSync(workspace.root, { recursive: true, force: true });
  }
});

test("批量新增中任一目录无效时不会写入部分项目", () => {
  const workspace = makeWorkspace();
  let db;
  try {
    const invalidRepo = path.join(workspace.root, "repos", "plain");
    fs.mkdirSync(invalidRepo, { recursive: true });
    ({ db } = openWorkspace(workspace));
    const store = createRepositoryStore({ db });
    assert.throws(
      () => store.addMany([{ path: workspace.repo }, { path: invalidRepo }]),
      /缺少 \.trellis 目录/
    );
    assert.equal(store.list().length, 0);
    assert.equal(fs.existsSync(workspace.legacyFiles.repositoriesFile), false);
  } finally {
    closeQuietly(db);
    fs.rmSync(workspace.root, { recursive: true, force: true });
  }
});

test("SQLite 写入失败会回滚整个项目批次", () => {
  const workspace = makeWorkspace();
  const secondRepo = path.join(workspace.root, "repos", "second");
  fs.mkdirSync(path.join(secondRepo, ".trellis", "tasks"), { recursive: true });
  let db;
  try {
    ({ db } = openWorkspace(workspace));
    db.exec(`
      CREATE TRIGGER reject_second_repository
      BEFORE INSERT ON repositories
      WHEN NEW.name = '失败项目'
      BEGIN
        SELECT RAISE(ABORT, 'forced repository failure');
      END;
    `);
    const store = createRepositoryStore({ db });
    assert.throws(
      () => store.addMany([
        { name: "正常项目", path: workspace.repo },
        { name: "失败项目", path: secondRepo }
      ]),
      /forced repository failure/
    );
    assert.equal(store.list().length, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM repositories").get().count, 0);
  } finally {
    closeQuietly(db);
    fs.rmSync(workspace.root, { recursive: true, force: true });
  }
});

test("移除项目会在同一事务中重排位置", () => {
  const workspace = makeWorkspace();
  const secondRepo = path.join(workspace.root, "repos", "second");
  const thirdRepo = path.join(workspace.root, "repos", "third");
  fs.mkdirSync(path.join(secondRepo, ".trellis"), { recursive: true });
  fs.mkdirSync(path.join(thirdRepo, ".trellis"), { recursive: true });
  let db;
  try {
    ({ db } = openWorkspace(workspace));
    const store = createRepositoryStore({ db });
    store.addMany([{ path: workspace.repo }, { path: secondRepo }, { path: thirdRepo }]);
    store.remove({ id: "second" });
    assert.deepEqual(
      db.prepare("SELECT id, position FROM repositories ORDER BY position").all()
        .map((row) => [row.id, row.position]),
      [["demo", 0], ["third", 1]]
    );
  } finally {
    closeQuietly(db);
    fs.rmSync(workspace.root, { recursive: true, force: true });
  }
});

test("依赖清理失败会回滚项目移除及全部执行扩展数据", () => {
  const workspace = makeWorkspace();
  let db;
  try {
    ({ db } = openWorkspace(workspace));
    const store = createRepositoryStore({ db });
    const added = store.add({ path: workspace.repo });
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO task_stage(task_key, stage, updated_at) VALUES (?, ?, ?)"
    ).run("demo/.trellis/tasks/one", "check", now);
    db.prepare(`
      INSERT INTO task_execution(
        execution_task_key, due_date, milestone, created_at, updated_at
      ) VALUES ('demo::one', NULL, '', ?, ?)
    `).run(now, now);
    db.prepare(`
      INSERT INTO task_tag(execution_task_key, tag, created_at)
      VALUES ('demo::one', 'demo', ?)
    `).run(now);
    db.prepare(`
      INSERT INTO task_event(
        execution_task_key, event_type, source, actor, correlation_id,
        occurred_at, payload_json, reversible
      ) VALUES ('demo::one', 'tracking_started', 'system', 'system', 'corr', ?, '{}', 0)
    `).run(now);
    db.prepare(`
      INSERT INTO task_dependency(
        id, blocker_task_key, blocked_task_key, reason, created_by,
        created_at, resolved_at
      ) VALUES ('dep', 'demo::one', 'other::two', '事务测试', 'dev', ?, NULL)
    `).run(now);
    db.exec(`
      CREATE TRIGGER reject_dependency_cleanup
      BEFORE DELETE ON task_dependency
      BEGIN
        SELECT RAISE(ABORT, 'forced dependency cleanup failure');
      END;
    `);

    assert.throws(
      () => store.remove({ id: added.id }),
      /forced dependency cleanup failure/
    );
    assert.equal(store.list().length, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM task_stage").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM task_execution").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM task_tag").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM task_event").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM task_dependency").get().count, 1);
  } finally {
    closeQuietly(db);
    fs.rmSync(workspace.root, { recursive: true, force: true });
  }
});
