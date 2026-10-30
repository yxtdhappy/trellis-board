import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../server/database.js";
import {
  createExecutionStore,
  readExecutionDetail
} from "../server/execution-store.js";

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-execution-"));
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

function createStore(db) {
  return createExecutionStore({
    db,
    stageIds: ["prd", "design", "implement", "check"]
  });
}

function closeQuietly(db) {
  try {
    db?.close();
  } catch {
    // 数据库可能已在失败路径关闭。
  }
}

test("计划字段校验失败时不写入投影或事件", () => {
  const workspace = makeWorkspace();
  let db;
  try {
    db = openTestDatabase(workspace);
    const store = createStore(db);
    const invalidPlans = [
      null,
      [],
      { dueDate: "2026-02-30" },
      { milestone: "x".repeat(101) },
      { tags: [""] },
      { tags: Array.from({ length: 11 }, (_, index) => `tag-${index}`) }
    ];
    invalidPlans.forEach((plan) => {
      assert.throws(() => store.updatePlan("demo::task", plan, "dev"));
    });
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM task_execution").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM task_tag").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM task_event").get().count, 0);
  } finally {
    closeQuietly(db);
    fs.rmSync(workspace.root, { recursive: true, force: true });
  }
});

test("计划更新原子替换标签、追加事件且无变化不重复记录", () => {
  const workspace = makeWorkspace();
  let db;
  try {
    db = openTestDatabase(workspace);
    const store = createStore(db);
    const first = store.updatePlan("demo::task", {
      dueDate: "2026-11-03",
      milestone: "  MVP  ",
      tags: ["UX", "ux", "后端"]
    }, "dev");
    assert.equal(first.changed, true);
    assert.equal(first.plan.milestone, "MVP");
    assert.deepEqual(first.plan.tags, ["UX", "后端"]);
    assert.equal(typeof first.correlationId, "string");

    const detail = readExecutionDetail(db, "demo::task");
    assert.equal(detail.dueDate, "2026-11-03");
    assert.deepEqual(detail.tags, ["UX", "后端"]);
    assert.equal(detail.historyStatus, "tracking");
    assert.equal(detail.events.length, 1);
    assert.equal(detail.events[0].type, "task_plan_updated");
    assert.deepEqual(detail.events[0].payload.after.tags, ["UX", "后端"]);

    const unchanged = store.updatePlan("demo::task", {
      dueDate: "2026-11-03",
      milestone: "MVP",
      tags: ["UX", "后端"]
    }, "dev");
    assert.equal(unchanged.changed, false);
    assert.equal(unchanged.correlationId, null);
    assert.equal(readExecutionDetail(db, "demo::task").eventTotal, 1);
  } finally {
    closeQuietly(db);
    fs.rmSync(workspace.root, { recursive: true, force: true });
  }
});

test("事件写入失败会回滚计划字段和标签", () => {
  const workspace = makeWorkspace();
  let db;
  try {
    db = openTestDatabase(workspace);
    db.exec(`
      CREATE TRIGGER reject_task_event
      BEFORE INSERT ON task_event
      BEGIN
        SELECT RAISE(ABORT, 'forced event failure');
      END;
    `);
    const store = createStore(db);
    assert.throws(
      () => store.updatePlan("demo::task", {
        dueDate: "2026-11-03",
        milestone: "MVP",
        tags: ["UX"]
      }, "dev"),
      /forced event failure/
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM task_execution").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM task_tag").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM task_event").get().count, 0);
  } finally {
    closeQuietly(db);
    fs.rmSync(workspace.root, { recursive: true, force: true });
  }
});

test("保存视图可创建、更新、排序删除并拒绝未知筛选字段", () => {
  const workspace = makeWorkspace();
  let db;
  try {
    db = openTestDatabase(workspace);
    const store = createStore(db);
    const first = store.createSavedView({
      name: "本周后端",
      filter: {
        priorities: ["P1", "P1"],
        stages: ["implement", "check"],
        tags: ["后端"],
        dueWithinDays: 3,
        staleDays: 5
      }
    });
    const second = store.createSavedView({
      name: "检查中",
      filter: { stages: ["check"] }
    });
    assert.deepEqual(first.filter.priorities, ["P1"]);
    assert.deepEqual(store.listSavedViews().map((view) => view.name), ["本周后端", "检查中"]);
    const updated = store.updateSavedView({
      id: first.id,
      name: "本周交付",
      filter: { priorities: ["P0", "P1"] }
    });
    assert.equal(updated.name, "本周交付");
    const removed = store.deleteSavedView(second.id);
    assert.equal(removed.name, "检查中");
    assert.deepEqual(store.listSavedViews().map((view) => view.name), ["本周交付"]);
    assert.throws(
      () => store.createSavedView({
        name: "非法",
        filter: { priority: ["P1"] }
      }),
      /未知筛选字段/
    );
    assert.throws(
      () => store.createSavedView({
        name: "非法整数",
        filter: { dueWithinDays: true }
      }),
      /整数天/
    );
    assert.throws(
      () => store.createSavedView({
        name: "非法筛选",
        filter: []
      }),
      /筛选条件必须是对象/
    );
    assert.throws(() => store.createSavedView(null), /保存视图必须是对象/);
  } finally {
    closeQuietly(db);
    fs.rmSync(workspace.root, { recursive: true, force: true });
  }
});

test("首次扫描只建立活动任务基线，后续真实阶段变化恰好记录一次", () => {
  const workspace = makeWorkspace();
  let db;
  try {
    db = openTestDatabase(workspace);
    const store = createStore(db);
    const firstTasks = [
      {
        executionTaskKey: "demo::active",
        executionIdentityValid: true,
        archived: false,
        derivedStage: "design"
      },
      {
        executionTaskKey: "demo::archived",
        executionIdentityValid: true,
        archived: true,
        derivedStage: "check"
      },
      {
        executionTaskKey: "demo::conflict",
        executionIdentityValid: false,
        archived: false,
        derivedStage: "implement"
      }
    ];
    const first = store.recordScanObservations({
      tasks: firstTasks,
      previousTasks: [],
      occurredAt: "2026-10-30T00:00:00.000Z"
    });
    assert.deepEqual(first, { baselines: 1, observations: 0 });
    assert.equal(readExecutionDetail(db, "demo::active").eventTotal, 1);
    assert.equal(readExecutionDetail(db, "demo::archived").eventTotal, 0);
    assert.equal(readExecutionDetail(db, "demo::conflict").eventTotal, 0);

    const unchanged = store.recordScanObservations({
      tasks: firstTasks,
      previousTasks: firstTasks,
      occurredAt: "2026-10-30T01:00:00.000Z"
    });
    assert.deepEqual(unchanged, { baselines: 0, observations: 0 });

    const changedTasks = firstTasks.map((task) =>
      task.executionTaskKey === "demo::active"
        ? { ...task, derivedStage: "implement" }
        : task
    );
    const changed = store.recordScanObservations({
      tasks: changedTasks,
      previousTasks: firstTasks,
      occurredAt: "2026-10-30T02:00:00.000Z"
    });
    assert.deepEqual(changed, { baselines: 0, observations: 1 });
    const detail = readExecutionDetail(db, "demo::active");
    assert.equal(detail.eventTotal, 2);
    assert.equal(detail.events[0].type, "stage_observed");
    assert.deepEqual(detail.events[0].payload.before, { derivedStage: "design" });
    assert.deepEqual(detail.events[0].payload.after, { derivedStage: "implement" });
  } finally {
    closeQuietly(db);
    fs.rmSync(workspace.root, { recursive: true, force: true });
  }
});

test("身份冲突清除后不会从冲突快照补造阶段变化", () => {
  const workspace = makeWorkspace();
  let db;
  try {
    db = openTestDatabase(workspace);
    const store = createStore(db);
    const active = {
      executionTaskKey: "demo::task",
      executionIdentityValid: true,
      archived: false,
      derivedStage: "design"
    };
    store.recordScanObservations({
      tasks: [active],
      previousTasks: [],
      occurredAt: "2026-10-30T00:00:00.000Z"
    });

    const conflictTasks = [
      { ...active, executionIdentityValid: false, executionIdentityConflict: true },
      {
        ...active,
        executionTaskKey: "demo::task",
        executionIdentityValid: false,
        executionIdentityConflict: true,
        derivedStage: "implement"
      }
    ];
    const unchanged = store.recordScanObservations({
      tasks: conflictTasks,
      previousTasks: [active],
      occurredAt: "2026-10-30T01:00:00.000Z"
    });
    assert.deepEqual(unchanged, { baselines: 0, observations: 0 });

    const resolved = store.recordScanObservations({
      tasks: [active],
      previousTasks: conflictTasks,
      occurredAt: "2026-10-30T02:00:00.000Z"
    });
    assert.deepEqual(resolved, { baselines: 0, observations: 0 });
    assert.equal(readExecutionDetail(db, "demo::task").eventTotal, 1);
  } finally {
    closeQuietly(db);
    fs.rmSync(workspace.root, { recursive: true, force: true });
  }
});

test("计划和保存视图在数据库重开后仍可读回", () => {
  const workspace = makeWorkspace();
  let db;
  try {
    db = openTestDatabase(workspace);
    const store = createStore(db);
    store.updatePlan("demo::task", {
      dueDate: "2026-12-01",
      milestone: "Release",
      tags: ["持久化"]
    }, "dev");
    store.createSavedView({
      name: "持久化视图",
      filter: { tags: ["持久化"] }
    });
    db.close();
    db = null;

    db = openTestDatabase(workspace);
    const reopened = createStore(db);
    const detail = readExecutionDetail(db, "demo::task");
    assert.equal(detail.dueDate, "2026-12-01");
    assert.equal(detail.milestone, "Release");
    assert.deepEqual(detail.tags, ["持久化"]);
    assert.deepEqual(reopened.listSavedViews().map((view) => view.name), ["持久化视图"]);
  } finally {
    closeQuietly(db);
    fs.rmSync(workspace.root, { recursive: true, force: true });
  }
});
