import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../server/database.js";
import {
  appendTaskEvent,
  createExecutionStore,
  readExecutionDetail,
  readExecutionEventsBatch,
  readTaskDependencies
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

test("依赖原因、自引用和重复活动边在写入前被拒绝", () => {
  const workspace = makeWorkspace();
  let db;
  try {
    db = openTestDatabase(workspace);
    const store = createStore(db);
    assert.throws(
      () => store.createDependency({
        blockedTaskKey: "demo::a",
        reason: "缺少阻断方"
      }),
      /缺少阻断方/
    );
    assert.throws(
      () => store.createDependency({
        blockerTaskKey: "demo::b",
        reason: "缺少被阻断方"
      }),
      /缺少被阻断/
    );
    assert.throws(
      () => store.createDependency({
        blockerTaskKey: "demo::a",
        blockedTaskKey: "demo::a",
        reason: "自引用"
      }),
      /不能阻断自身/
    );
    assert.throws(
      () => store.createDependency({
        blockerTaskKey: "demo::b",
        blockedTaskKey: "demo::a",
        reason: "   "
      }),
      /不能为空/
    );
    assert.throws(
      () => store.createDependency({
        blockerTaskKey: "demo::b",
        blockedTaskKey: "demo::a",
        reason: "x".repeat(501)
      }),
      /500/
    );

    store.createDependency({
      blockerTaskKey: "demo::b",
      blockedTaskKey: "demo::a",
      reason: "等待接口"
    }, "dev");
    assert.throws(
      () => store.createDependency({
        blockerTaskKey: "demo::b",
        blockedTaskKey: "demo::a",
        reason: "重复"
      }),
      /已经存在/
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM task_dependency").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM task_event").get().count, 1);
  } finally {
    closeQuietly(db);
    fs.rmSync(workspace.root, { recursive: true, force: true });
  }
});

test("二节点和三节点循环都基于活动依赖在事务内拒绝", () => {
  const workspace = makeWorkspace();
  let db;
  try {
    db = openTestDatabase(workspace);
    const store = createStore(db);
    store.createDependency({
      blockerTaskKey: "demo::b",
      blockedTaskKey: "demo::a",
      reason: "A 等待 B"
    });
    assert.throws(
      () => store.createDependency({
        blockerTaskKey: "demo::a",
        blockedTaskKey: "demo::b",
        reason: "B 等待 A"
      }),
      /依赖会形成循环/
    );

    store.createDependency({
      blockerTaskKey: "demo::c",
      blockedTaskKey: "demo::b",
      reason: "B 等待 C"
    });
    assert.throws(
      () => store.createDependency({
        blockerTaskKey: "demo::a",
        blockedTaskKey: "demo::c",
        reason: "C 等待 A",
        taskLabels: {
          "demo::a": "任务 A",
          "demo::b": "任务 B",
          "demo::c": "任务 C"
        }
      }),
      /任务 C → 任务 A → 任务 B → 任务 C/
    );
    assert.deepEqual(
      readTaskDependencies(db).map((dependency) => [
        dependency.blockerTaskKey,
        dependency.blockedTaskKey
      ]),
      [
        ["demo::b", "demo::a"],
        ["demo::c", "demo::b"]
      ]
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM task_event").get().count, 2);
  } finally {
    closeQuietly(db);
    fs.rmSync(workspace.root, { recursive: true, force: true });
  }
});

test("依赖事件失败会回滚依赖行", () => {
  const workspace = makeWorkspace();
  let db;
  try {
    db = openTestDatabase(workspace);
    db.exec(`
      CREATE TRIGGER reject_dependency_event
      BEFORE INSERT ON task_event
      WHEN NEW.event_type = 'dependency_created'
      BEGIN
        SELECT RAISE(ABORT, 'forced dependency event failure');
      END;
    `);
    const store = createStore(db);
    assert.throws(
      () => store.createDependency({
        blockerTaskKey: "demo::b",
        blockedTaskKey: "demo::a",
        reason: "等待接口"
      }),
      /forced dependency event failure/
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM task_dependency").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM task_event").get().count, 0);
  } finally {
    closeQuietly(db);
    fs.rmSync(workspace.root, { recursive: true, force: true });
  }
});

test("解除依赖保留历史并允许之后重新创建同一活动边", () => {
  const workspace = makeWorkspace();
  let db;
  try {
    db = openTestDatabase(workspace);
    let store = createStore(db);
    const first = store.createDependency({
      blockerTaskKey: "demo::b",
      blockedTaskKey: "demo::a",
      reason: "等待接口"
    }, "dev");
    const resolved = store.resolveDependency(first.id, "dev");
    assert.equal(resolved.id, first.id);
    assert.equal(typeof resolved.resolvedAt, "string");
    db.close();
    db = openTestDatabase(workspace);
    store = createStore(db);
    const history = readTaskDependencies(db);
    assert.equal(history.length, 1);
    assert.equal(history[0].resolvedAt, resolved.resolvedAt);
    const detail = readExecutionDetail(db, "demo::a");
    assert.deepEqual(
      detail.events.map((event) => event.type),
      ["dependency_resolved", "dependency_created"]
    );
    assert.equal(detail.events[0].payload.before.status, "active");
    assert.equal(detail.events[0].payload.after.status, "resolved");

    const second = store.createDependency({
      blockerTaskKey: "demo::b",
      blockedTaskKey: "demo::a",
      reason: "重新阻断"
    }, "dev");
    assert.notEqual(second.id, first.id);
    assert.equal(readTaskDependencies(db).length, 2);
    assert.throws(() => store.resolveDependency(first.id, "dev"), /已经解除/);
  } finally {
    closeQuietly(db);
    fs.rmSync(workspace.root, { recursive: true, force: true });
  }
});

test("解除事件失败时依赖仍保持活动且不产生解除时间", () => {
  const workspace = makeWorkspace();
  let db;
  try {
    db = openTestDatabase(workspace);
    const store = createStore(db);
    const dependency = store.createDependency({
      blockerTaskKey: "demo::b",
      blockedTaskKey: "demo::a",
      reason: "等待接口"
    }, "dev");
    db.exec(`
      CREATE TRIGGER reject_resolve_event
      BEFORE INSERT ON task_event
      WHEN NEW.event_type = 'dependency_resolved'
      BEGIN
        SELECT RAISE(ABORT, 'forced resolve event failure');
      END;
    `);
    assert.throws(
      () => store.resolveDependency(dependency.id, "dev"),
      /forced resolve event failure/
    );
    const history = readTaskDependencies(db);
    assert.equal(history.length, 1);
    assert.equal(history[0].resolvedAt, null);
    assert.equal(readExecutionDetail(db, "demo::a").eventTotal, 1);
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
        staleDays: 5,
        blocked: "blocked"
      }
    });
    const second = store.createSavedView({
      name: "检查中",
      filter: { stages: ["check"] }
    });
    assert.deepEqual(first.filter.priorities, ["P1"]);
    assert.equal(first.filter.blocked, "blocked");
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
    assert.throws(
      () => store.createSavedView({
        name: "非法阻断",
        filter: { blocked: "maybe" }
      }),
      /阻断筛选/
    );
    assert.deepEqual(
      store.createSavedView({
        name: "旧视图兼容",
        filter: { blocked: "any", tags: ["旧"] }
      }).filter,
      { tags: ["旧"] }
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

test("批量事件读取按任务独立截断，并保持最近事件倒序", () => {
  const workspace = makeWorkspace();
  let db;
  try {
    db = openTestDatabase(workspace);
    const append = (key, index, type = "stage_observed") => appendTaskEvent(db, {
      executionTaskKey: key,
      eventType: type,
      source: type === "tracking_started" ? "system" : "scan",
      actor: "dev",
      correlationId: `${key}-${index}`,
      occurredAt: `2026-10-30T00:0${index}:00.000Z`,
      payload: type === "stage_observed"
        ? { after: { derivedStage: index % 2 ? "check" : "implement" } }
        : { after: { derivedStage: "implement" } }
    });
    append("demo::a", 0, "tracking_started");
    append("demo::a", 1);
    append("demo::a", 2);
    append("demo::a", 3);
    append("demo::b", 1);
    append("demo::b", 2);

    const batch = readExecutionEventsBatch(
      db,
      ["demo::a", "demo::b", "demo::a"],
      2
    );
    assert.equal(batch.size, 2);
    assert.equal(batch.get("demo::a").eventTotal, 4);
    assert.equal(batch.get("demo::a").eventLimit, 2);
    assert.equal(batch.get("demo::a").eventTruncated, true);
    assert.deepEqual(
      batch.get("demo::a").events.map((event) => event.occurredAt),
      ["2026-10-30T00:03:00.000Z", "2026-10-30T00:02:00.000Z"]
    );
    assert.equal(
      batch.get("demo::a").eventWindowStartAt,
      "2026-10-30T00:02:00.000Z"
    );
    assert.equal(batch.get("demo::b").eventTotal, 2);
    assert.equal(batch.get("demo::b").eventTruncated, false);

    const capped = readExecutionEventsBatch(db, ["demo::a"], 5000);
    assert.equal(capped.get("demo::a").eventLimit, 1000);
  } finally {
    closeQuietly(db);
    fs.rmSync(workspace.root, { recursive: true, force: true });
  }
});
