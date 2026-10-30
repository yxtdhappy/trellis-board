import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../server/database.js";
import {
  computeAttentionReasons,
  dueDateDistance,
  projectBoardExecution,
  projectTaskExecution
} from "../server/execution-projection.js";

const NOW = new Date("2026-10-30T09:00:00.000Z");

test("截止日期距离按本地日期计算并区分逾期和临近", () => {
  assert.equal(dueDateDistance("2026-10-30", NOW), 0);
  assert.equal(dueDateDistance("2026-11-02", NOW), 3);
  assert.equal(dueDateDistance("2026-10-28", NOW), -2);
  const task = {
    archived: false,
    priority: "P1",
    derivedStage: "check",
    executionIdentityValid: true
  };
  const execution = {
    dueDate: "2026-10-28",
    lastActivityAt: "2026-10-20T00:00:00.000Z",
    historyStatus: "tracking"
  };
  assert.deepEqual(
    computeAttentionReasons(task, execution, NOW),
    ["overdue", "priority", "stale", "checking"]
  );
});

test("身份冲突任务不投影共享扩展数据并显示冲突原因", () => {
  const task = {
    taskKey: "demo::a",
    executionTaskKey: "demo::same",
    executionIdentityValid: false,
    executionIdentityConflict: true,
    priority: "P0",
    derivedStage: "implement",
    archived: false
  };
  const execution = projectTaskExecution(task, {
    dueDate: "2026-11-01",
    milestone: "不应泄露",
    tags: ["shared"]
  }, NOW);
  assert.deepEqual(execution.tags, []);
  assert.equal(execution.milestone, "");
  assert.equal(execution.historyStatus, "missing");
  assert.equal(execution.attentionReasons.includes("identity_conflict"), true);
});

test("board 投影一次组合任务与保存视图", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-projection-"));
  const dataDir = path.join(root, "data");
  const db = openDatabase({
    databaseFile: path.join(dataDir, "board.sqlite"),
    legacyFiles: {
      repositoriesFile: path.join(dataDir, "repos.json"),
      metadataFile: path.join(dataDir, "task-metadata.json"),
      scanCacheFile: path.join(dataDir, "scan-cache.json"),
      stateFile: path.join(dataDir, "board-state.json")
    },
    fallbackRepositories: [],
    logger: { warn() {} }
  });
  try {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO task_execution(
        execution_task_key, due_date, milestone, created_at, updated_at
      ) VALUES ('demo::task', '2026-11-01', 'MVP', ?, ?)
    `).run(now, now);
    db.prepare(`
      INSERT INTO task_tag(execution_task_key, tag, created_at)
      VALUES ('demo::task', '后端', ?)
    `).run(now);
    const board = {
      generatedAt: now,
      projects: [],
      tasks: [{
        taskKey: "demo::.trellis/tasks/task",
        executionTaskKey: "demo::task",
        executionIdentityValid: true,
        projectId: "demo",
        projectName: "Demo",
        title: "Task",
        priority: "P1",
        derivedStage: "implement",
        archived: false
      }]
    };
    const savedViews = [{ id: "view", name: "视图", filter: { priorities: ["P1"] } }];
    const projected = projectBoardExecution(board, savedViews, db, NOW);
    assert.deepEqual(projected.savedViews, savedViews);
    assert.equal(projected.tasks[0].execution.dueDate, "2026-11-01");
    assert.equal(projected.tasks[0].execution.milestone, "MVP");
    assert.deepEqual(projected.tasks[0].execution.tags, ["后端"]);
    assert.equal(projected.tasks[0].execution.historyStatus, "missing");
    assert.equal(projected.tasks[0].execution.attentionReasons.includes("due_soon"), true);
    assert.equal(projected.tasks[0].execution.attentionReasons.includes("implementing"), true);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
