import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  clearScanCaches,
  linkTaskGroups,
  mergeTaskDetail,
  scanRepository,
  toTaskListItem,
  withManualStages
} from "../server/loader.js";

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-board-"));
  fs.mkdirSync(path.join(root, ".trellis", "tasks", "archive", "2026-10", "10-01-old"), { recursive: true });
  fs.mkdirSync(path.join(root, ".trellis", "tasks", "10-20-live"), { recursive: true });
  fs.mkdirSync(path.join(root, ".trellis", "workspace", "dev"), { recursive: true });
  fs.writeFileSync(path.join(root, ".trellis", ".developer"), "name=dev\n");
  fs.writeFileSync(path.join(root, ".trellis", "workspace", "dev", "index.md"), "# dev\n");
  fs.writeFileSync(path.join(root, ".trellis", "workspace", "dev", "journal-1.md"), "# session\n");
  const live = {
    id: "live",
    title: "Live task",
    status: "in_progress",
    assignee: "dev",
    creator: "dev",
    priority: "P1"
  };
  fs.writeFileSync(path.join(root, ".trellis", "tasks", "10-20-live", "task.json"), JSON.stringify(live));
  fs.writeFileSync(path.join(root, ".trellis", "tasks", "10-20-live", "prd.md"), "# Live\n\n## Requirements\n\n- Real requirement\n\n## Acceptance Criteria\n\n- [x] Done\n");
  fs.writeFileSync(path.join(root, ".trellis", "tasks", "10-20-live", "design.md"), "# Design\n");
  fs.writeFileSync(path.join(root, ".trellis", "tasks", "10-20-live", "implement.md"), "# Plan\n实现完成后执行真实浏览器验证。\n");
  fs.writeFileSync(
    path.join(root, ".trellis", "tasks", "10-20-live", "e2e-report.md"),
    "# E2E\n\n真实浏览器 E2E 已完成，API 与 UI 验证均通过。\n"
  );
  fs.mkdirSync(path.join(root, ".trellis", "tasks", "10-20-live", "research"));
  fs.writeFileSync(path.join(root, ".trellis", "tasks", "10-20-live", "research", "facts.md"), "# Facts\n");
  fs.writeFileSync(path.join(root, ".trellis", "tasks", "10-20-live", "implement.jsonl"), '{"file":"spec.md","reason":"x"}\n');
  fs.writeFileSync(path.join(root, ".trellis", "tasks", "10-20-live", "check.jsonl"), '{"file":"check.md","reason":"x"}\n');

  const archived = {
    id: "old",
    title: "Old task",
    status: "completed",
    assignee: "dev",
    creator: "dev",
    priority: "P2"
  };
  fs.writeFileSync(path.join(root, ".trellis", "tasks", "archive", "2026-10", "10-01-old", "task.json"), JSON.stringify(archived));
  fs.writeFileSync(path.join(root, ".trellis", "tasks", "archive", "2026-10", "10-01-old", "prd.md"), "# Old\n\n## Requirements\n\n- old\n\n## Acceptance Criteria\n\n- [ ] old check\n");

  fs.mkdirSync(path.join(root, ".trellis", "tasks", "archive", "nested", "nested-task"), { recursive: true });
  fs.writeFileSync(path.join(root, ".trellis", "tasks", "archive", "nested", "nested-task", "task.json"), JSON.stringify(archived));
  return root;
}

function resetLiveTaskForEvidence(root, prd, options = {}) {
  const liveDir = path.join(root, ".trellis", "tasks", "10-20-live");
  const removableFiles = [
    "design.md",
    "implement.md",
    "implementation-report.md",
    "check-report.md",
    "e2e-report.md",
    "implement.jsonl",
    "check.jsonl"
  ];
  removableFiles.forEach((fileName) => {
    fs.rmSync(path.join(liveDir, fileName), { force: true });
  });
  fs.rmSync(path.join(liveDir, "research"), { recursive: true, force: true });

  const taskPath = path.join(liveDir, "task.json");
  const task = JSON.parse(fs.readFileSync(taskPath, "utf8"));
  task.status = options.status || "in_progress";
  task.commit = null;
  task.relatedFiles = options.relatedFiles || [];
  fs.writeFileSync(taskPath, JSON.stringify(task));
  fs.writeFileSync(path.join(liveDir, "prd.md"), prd);
  return liveDir;
}

const VALID_UNCHECKED_PRD = [
  "# Stage evidence",
  "",
  "## Requirements",
  "",
  "- 修复实施阶段证据",
  "",
  "## Acceptance Criteria",
  "",
  "- [ ] 回归测试通过",
  ""
].join("\n");

test("扫描嵌套归档目录并使用文件证据推导阶段", () => {
  const root = makeRepo();
  try {
    const result = scanRepository({ id: "demo", name: "Demo", path: root }, { includeContent: true });
    assert.equal(result.error, null);
    assert.equal(result.tasks.length, 3);
    assert.equal(result.tasks.filter((task) => task.archived).length, 2);
    assert.equal(
      result.tasks
        .filter((task) => task.archived)
        .every((task) => Boolean(task.archivedAt)),
      true
    );
    const live = result.tasks.find((task) => !task.archived);
    assert.equal(live.projectId, "demo");
    assert.equal(live.derivedStage, "spec");
    assert.equal(live.stages.find((stage) => stage.id === "e2e").complete, true);
    assert.equal(live.stages.find((stage) => stage.id === "journal").complete, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("稳定执行身份在任务归档后保持不变", () => {
  const root = makeRepo();
  const project = { id: "identity-demo", name: "Identity Demo", path: root };
  try {
    clearScanCaches();
    const active = scanRepository(project);
    const live = active.tasks.find((task) => !task.archived);
    assert.equal(live.executionTaskKey, "identity-demo::live");
    assert.equal(live.executionIdentityValid, true);

    const source = path.join(root, ".trellis", "tasks", "10-20-live");
    const target = path.join(root, ".trellis", "tasks", "archive", "2026-10", "10-20-live");
    fs.renameSync(source, target);
    clearScanCaches();
    const archived = scanRepository(project);
    const moved = archived.tasks.find((task) => task.taskKey.endsWith("10-20-live"));
    assert.equal(moved.archived, true);
    assert.equal(moved.executionTaskKey, live.executionTaskKey);
    assert.equal(moved.executionIdentityValid, true);
  } finally {
    clearScanCaches();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("重复 task.json id 的任务仍可见但执行身份标记为冲突", () => {
  const root = makeRepo();
  const project = { id: "conflict-demo", name: "Conflict Demo", path: root };
  try {
    const duplicateDir = path.join(root, ".trellis", "tasks", "10-21-live-copy");
    fs.mkdirSync(duplicateDir);
    fs.writeFileSync(
      path.join(duplicateDir, "task.json"),
      JSON.stringify({ id: "live", title: "Duplicate", status: "planning" })
    );
    clearScanCaches();
    const result = scanRepository(project);
    const tasks = linkTaskGroups([result]).map(toTaskListItem);
    const duplicates = tasks.filter((task) => task.executionTaskKey === "conflict-demo::live");
    assert.equal(duplicates.length, 2);
    duplicates.forEach((task) => {
      assert.equal(task.executionIdentityValid, false);
      assert.equal(task.executionIdentityConflict, true);
    });
  } finally {
    clearScanCaches();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("列表投影保留轻量证据摘要并移除产物正文", () => {
  const root = makeRepo();
  const project = { id: "summary-demo", name: "Summary Demo", path: root };
  try {
    clearScanCaches();
    const result = scanRepository(project, { includeContent: true });
    const live = linkTaskGroups([result])
      .map(toTaskListItem)
      .find((task) => !task.archived);
    assert.equal(live.summary.hasPrd, true);
    assert.equal(live.summary.prdAcceptanceCount, 1);
    assert.equal(live.summary.prdCheckedCount, 1);
    assert.equal(live.summary.designMeaningful, false);
    assert.equal("artifacts" in live, false);
  } finally {
    clearScanCaches();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("未变化任务复用解析结果，只重算发生变化的单个任务", () => {
  const root = makeRepo();
  const project = { id: "cache-demo", name: "Cache Demo", path: root };
  try {
    clearScanCaches();
    const first = scanRepository(project);
    assert.equal(first.tasks.length, 3);
    assert.equal(first.stats.tasksParsed, 3);
    assert.equal(first.stats.tasksReused, 0);

    const unchanged = scanRepository(project);
    assert.equal(unchanged.stats.tasksParsed, 0);
    assert.equal(unchanged.stats.tasksReused, 3);

    fs.appendFileSync(
      path.join(root, ".trellis", "tasks", "10-20-live", "design.md"),
      "\n缓存命中后仍应读取本次新增的设计内容。\n"
    );
    const changed = scanRepository(project);
    assert.equal(changed.stats.tasksParsed, 1);
    assert.equal(changed.stats.tasksReused, 2);
    assert.equal(
      changed.tasks.find((task) => !task.archived).summary.hasDesign,
      true
    );
  } finally {
    clearScanCaches();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("工作区 journal 变化会使该成员的缓存任务重新计算阶段", () => {
  const root = makeRepo();
  const project = { id: "workspace-cache-demo", name: "Workspace Cache Demo", path: root };
  try {
    clearScanCaches();
    scanRepository(project);
    fs.writeFileSync(
      path.join(root, ".trellis", "workspace", "dev", "journal-2.md"),
      "# second session\n"
    );
    const changed = scanRepository(project);
    assert.equal(changed.stats.tasksParsed, 3);
    assert.equal(changed.stats.tasksReused, 0);
  } finally {
    clearScanCaches();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("项目元数据包含当前分支、本地分支和远程分支", () => {
  const root = makeRepo();
  try {
    const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
    git("init", "-b", "main");
    git("config", "user.email", "trellis-board@example.invalid");
    git("config", "user.name", "Trellis Board Test");
    git("add", ".");
    git("commit", "-m", "initial");
    git("branch", "feature/alpha");
    git("branch", "dev");
    git("checkout", "dev");
    git("update-ref", "refs/remotes/origin/release/3.0.0", "HEAD");

    const result = scanRepository({ id: "demo", name: "Demo", path: root });
    assert.equal(result.project.branch, "dev");
    assert.deepEqual(result.project.branches, ["dev", "feature/alpha", "main", "release/3.0.0"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("人工阶段只标记自身，不伪造前序完成", () => {
  const task = {
    stages: [
      { id: "prd", label: "需求", index: 1, complete: true, source: "file" },
      { id: "research", label: "调研", index: 2, complete: false, source: "missing" },
      { id: "design", label: "设计", index: 3, complete: false, source: "missing" }
    ],
    derivedStage: "research"
  };
  const updated = withManualStages(task, { stage: "design", updatedAt: "2026-10-26T00:00:00.000Z" });
  assert.equal(updated.stages[1].complete, false);
  assert.equal(updated.stages[2].complete, true);
  assert.equal(updated.stages[2].source, "manual");
  assert.match(updated.stages[2].evidence, /未自动补齐前序步骤/);
});

test("详情合并保留列表分组字段并让最新人工阶段覆盖缓存阶段", () => {
  const stageIds = [
    "prd",
    "research",
    "design",
    "implementPlan",
    "context",
    "review",
    "implement",
    "check"
  ];
  const task = {
    taskKey: "demo::.trellis/tasks/e2e-sqlite-test",
    artifacts: { check: { name: "check-report.md", content: "通过" } },
    summary: { summary: "最新磁盘摘要" },
    stages: stageIds.map((id, index) => ({
      id,
      label: id,
      index: index + 1,
      complete: false,
      source: "missing"
    })),
    manualStage: null,
    derivedStage: "prd"
  };
  const cachedListTask = {
    taskKey: task.taskKey,
    groupKey: "demo::.trellis/tasks/parent",
    groupRole: "child",
    groupTaskKeys: [task.taskKey, "demo::.trellis/tasks/parent"],
    stages: task.stages.map((stage) => ({ ...stage })),
    manualStage: null,
    derivedStage: "prd"
  };

  const merged = mergeTaskDetail(task, cachedListTask, {
    stage: "check",
    updatedAt: "2026-10-30T04:00:00.000Z"
  });

  assert.equal(merged.groupKey, cachedListTask.groupKey);
  assert.equal(merged.groupRole, "child");
  assert.deepEqual(merged.groupTaskKeys, cachedListTask.groupTaskKeys);
  assert.deepEqual(merged.artifacts, task.artifacts);
  assert.deepEqual(merged.summary, task.summary);
  assert.equal(merged.manualStage, "check");
  assert.equal(merged.stages[7].complete, true);
  assert.equal(merged.stages[7].source, "manual");
});

test("待执行的 E2E 不会被当成已完成证据", () => {
  const root = makeRepo();
  try {
    fs.rmSync(path.join(root, ".trellis", "tasks", "10-20-live", "e2e-report.md"));
    const implementPath = path.join(root, ".trellis", "tasks", "10-20-live", "implement.md");
    fs.writeFileSync(implementPath, "# Plan\nPlaywright E2E 尚未执行，等待用户确认。\n");
    const result = scanRepository({ id: "demo", name: "Demo", path: root }, { includeContent: true });
    const live = result.tasks.find((task) => !task.archived);
    assert.equal(live.stages.find((stage) => stage.id === "e2e").complete, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("实施计划里的 E2E 条件语句不会被当成执行结果", () => {
  const root = makeRepo();
  try {
    const liveDir = path.join(root, ".trellis", "tasks", "10-20-live");
    fs.rmSync(path.join(liveDir, "e2e-report.md"));
    fs.writeFileSync(
      path.join(liveDir, "implement.md"),
      "# Plan\n在后端契约和 API 实测通过后，再做真实浏览器 UI E2E。\n"
    );
    const result = scanRepository({ id: "demo", name: "Demo", path: root }, { includeContent: true });
    const live = result.tasks.find((task) => !task.archived);
    const e2e = live.stages.find((stage) => stage.id === "e2e");
    assert.equal(e2e.complete, false);
    assert.equal(e2e.source, "missing");
    assert.equal(e2e.optional, true);
    assert.equal(live.derivedStage, "spec");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("独立 E2E 报告可作为真实验证的完成证据", () => {
  const root = makeRepo();
  try {
    const liveDir = path.join(root, ".trellis", "tasks", "10-20-live");
    fs.writeFileSync(path.join(liveDir, "implement.md"), "# Plan\nPlaywright E2E 已完成，lint 通过。\n");
    fs.writeFileSync(
      path.join(liveDir, "e2e-report.md"),
      "# E2E\n\n真实浏览器 E2E 已完成，API 与 UI 验证均通过。\n"
    );
    const result = scanRepository({ id: "demo", name: "Demo", path: root }, { includeContent: true });
    const live = result.tasks.find((task) => !task.archived);
    const e2e = live.stages.find((stage) => stage.id === "e2e");
    assert.equal(e2e.complete, true);
    assert.equal(e2e.source, "e2e-report");
    assert.equal(live.summary.hasE2eReport, true);
    assert.equal(live.artifacts.e2eReport.content.includes("真实浏览器 E2E 已完成"), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("E2E 报告中的表格结论和通过符号可作为完成证据", () => {
  const root = makeRepo();
  try {
    const liveDir = path.join(root, ".trellis", "tasks", "10-20-live");
    fs.writeFileSync(
      path.join(liveDir, "e2e-report.md"),
      [
        "# 数据库端到端验证",
        "",
        "| 场景 | 结果 |",
        "| --- | --- |",
        "| Oracle 真机 | 通过 |",
        "| ClickHouse 页面 | ✅ |",
        ""
      ].join("\n")
    );
    const result = scanRepository({ id: "demo", name: "Demo", path: root }, { includeContent: true });
    const live = result.tasks.find((task) => !task.archived);
    const e2e = live.stages.find((stage) => stage.id === "e2e");
    assert.equal(e2e.complete, true);
    assert.equal(e2e.source, "e2e-report");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("planning 任务有实施报告时推导为实现与检查已完成", () => {
  const root = makeRepo();
  try {
    const liveDir = path.join(root, ".trellis", "tasks", "10-20-live");
    fs.rmSync(path.join(liveDir, "e2e-report.md"));
    const task = JSON.parse(fs.readFileSync(path.join(liveDir, "task.json"), "utf8"));
    task.status = "planning";
    task.parent = null;
    task.children = [];
    fs.writeFileSync(path.join(liveDir, "task.json"), JSON.stringify(task));
    fs.writeFileSync(path.join(liveDir, "research", "facts.md"), "# Facts\n");
    fs.writeFileSync(path.join(liveDir, "implement.md"), "# Plan\n实现与检查分别见报告。\n");
    fs.writeFileSync(
      path.join(liveDir, "implementation-report.md"),
      "# 实施报告\n覆盖真实需求，修改了代码。\n\n## 验证\nVitest 通过，99 tests passed。\n"
    );
    fs.writeFileSync(
      path.join(liveDir, "check-report.md"),
      "# 检查报告\n- TypeCheck：通过\n- 缺陷：未运行真实浏览器 E2E。\n"
    );
    const result = scanRepository({ id: "demo", name: "Demo", path: root }, { includeContent: true });
    const live = result.tasks.find((candidate) => !candidate.archived);
    assert.equal(live.stages.find((stage) => stage.id === "implement").complete, true);
    assert.equal(live.stages.find((stage) => stage.id === "check").complete, true);
    assert.equal(live.stages.find((stage) => stage.id === "e2e").complete, false);
    assert.equal(live.derivedStage, "spec");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("in_progress 只证明任务开始，不会单独完成实施与检查", () => {
  const root = makeRepo();
  try {
    resetLiveTaskForEvidence(root, VALID_UNCHECKED_PRD);
    const result = scanRepository({ id: "demo", name: "Demo", path: root }, { includeContent: true });
    const live = result.tasks.find((task) => !task.archived);
    assert.equal(live.derivedStage, "implement");
    assert.equal(live.stages.find((stage) => stage.id === "review").complete, true);
    assert.equal(live.stages.find((stage) => stage.id === "implement").complete, false);
    assert.equal(live.stages.find((stage) => stage.id === "check").complete, false);
  } finally {
    clearScanCaches();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("实施计划中的检查项只辅助检查完成，不能替代实施完成证据", () => {
  const root = makeRepo();
  try {
    const liveDir = resetLiveTaskForEvidence(root, VALID_UNCHECKED_PRD);
    fs.writeFileSync(
      path.join(liveDir, "implement.md"),
      "# 实施计划\n\n- [x] 执行回归测试\n"
    );

    let result = scanRepository({ id: "demo", name: "Demo", path: root }, { includeContent: true });
    let live = result.tasks.find((task) => !task.archived);
    assert.equal(live.stages.find((stage) => stage.id === "implement").complete, false);
    assert.equal(live.stages.find((stage) => stage.id === "check").complete, false);
    assert.match(live.stages.find((stage) => stage.id === "check").evidence, /缺少实施报告/);
    assert.equal(live.derivedStage, "implement");

    const taskPath = path.join(liveDir, "task.json");
    const task = JSON.parse(fs.readFileSync(taskPath, "utf8"));
    task.commit = "abc1234";
    fs.writeFileSync(taskPath, JSON.stringify(task));
    clearScanCaches();

    result = scanRepository({ id: "demo", name: "Demo", path: root }, { includeContent: true });
    live = result.tasks.find((candidate) => !candidate.archived);
    assert.equal(live.stages.find((stage) => stage.id === "implement").complete, true);
    assert.equal(live.stages.find((stage) => stage.id === "check").complete, true);
    assert.equal(live.stages.find((stage) => stage.id === "check").source, "implement-plan");
    assert.equal(live.derivedStage, "spec");
  } finally {
    clearScanCaches();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("验收勾选、提交和完成状态仍作为实施完成证据", () => {
  const root = makeRepo();
  try {
    const liveDir = resetLiveTaskForEvidence(root, VALID_UNCHECKED_PRD);
    const taskPath = path.join(liveDir, "task.json");
    let task = JSON.parse(fs.readFileSync(taskPath, "utf8"));
    task.commit = "abc1234";
    fs.writeFileSync(taskPath, JSON.stringify(task));

    let result = scanRepository({ id: "demo", name: "Demo", path: root }, { includeContent: true });
    let live = result.tasks.find((candidate) => !candidate.archived);
    assert.equal(live.stages.find((stage) => stage.id === "implement").complete, true);
    assert.equal(live.stages.find((stage) => stage.id === "check").complete, false);
    assert.equal(live.derivedStage, "check");

    resetLiveTaskForEvidence(root, VALID_UNCHECKED_PRD.replace("- [ ]", "- [x]"));
    clearScanCaches();
    result = scanRepository({ id: "demo", name: "Demo", path: root }, { includeContent: true });
    live = result.tasks.find((candidate) => !candidate.archived);
    assert.equal(live.stages.find((stage) => stage.id === "implement").complete, true);
    assert.equal(live.stages.find((stage) => stage.id === "check").complete, true);
    assert.equal(live.stages.find((stage) => stage.id === "check").source, "prd-acceptance");
    assert.equal(live.derivedStage, "spec");

    resetLiveTaskForEvidence(root, VALID_UNCHECKED_PRD, { status: "completed" });
    clearScanCaches();
    result = scanRepository({ id: "demo", name: "Demo", path: root }, { includeContent: true });
    live = result.tasks.find((candidate) => !candidate.archived);
    assert.equal(live.stages.find((stage) => stage.id === "implement").complete, true);
    assert.equal(live.stages.find((stage) => stage.id === "check").complete, true);
    assert.equal(live.stages.find((stage) => stage.id === "check").source, "status");
    assert.equal(live.derivedStage, "spec");
  } finally {
    clearScanCaches();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("默认 PRD 骨架不会因 in_progress 进入检查收尾泳道", () => {
  const root = makeRepo();
  try {
    resetLiveTaskForEvidence(
      root,
      "# Bootstrap Task\n\n## Status\n\n- [ ] Fill backend guidelines\n",
      { relatedFiles: [".trellis/spec/backend/"] }
    );
    const result = scanRepository({ id: "demo", name: "Demo", path: root }, { includeContent: true });
    const live = result.tasks.find((task) => !task.archived);
    assert.equal(["prd", "research", "design", "implementPlan", "context"].includes(live.derivedStage), true);
    assert.equal(live.stages.find((stage) => stage.id === "implement").complete, false);
    assert.equal(live.stages.find((stage) => stage.id === "check").complete, false);
  } finally {
    clearScanCaches();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("实施和检查报告仍会推进任务进入检查与收尾", () => {
  const root = makeRepo();
  try {
    const liveDir = resetLiveTaskForEvidence(root, VALID_UNCHECKED_PRD);
    fs.writeFileSync(
      path.join(liveDir, "implementation-report.md"),
      "# 实施报告\n\n代码修改已完成。\n"
    );
    let result = scanRepository({ id: "demo", name: "Demo", path: root }, { includeContent: true });
    let live = result.tasks.find((task) => !task.archived);
    assert.equal(live.stages.find((stage) => stage.id === "implement").complete, true);
    assert.equal(live.stages.find((stage) => stage.id === "check").complete, false);
    assert.equal(live.derivedStage, "check");

    fs.writeFileSync(
      path.join(liveDir, "check-report.md"),
      "# 检查报告\n\nnode --test tests/loader.test.js 通过。\n"
    );
    result = scanRepository({ id: "demo", name: "Demo", path: root }, { includeContent: true });
    live = result.tasks.find((task) => !task.archived);
    assert.equal(live.stages.find((stage) => stage.id === "implement").complete, true);
    assert.equal(live.stages.find((stage) => stage.id === "check").complete, true);
    assert.equal(live.stages.find((stage) => stage.id === "check").source, "check-report");
    assert.equal(live.derivedStage, "spec");
  } finally {
    clearScanCaches();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("completed 归档历史任务不会回退到检查之前", () => {
  const root = makeRepo();
  try {
    const result = scanRepository({ id: "demo", name: "Demo", path: root }, { includeContent: true });
    const archived = result.tasks.find((task) => task.archived && task.dirName === "10-01-old");
    const derivedIndex = archived.stages.findIndex((stage) => stage.id === archived.derivedStage);
    const archiveIndex = archived.stages.findIndex((stage) => stage.id === "archive");
    assert.equal(archived.stages.find((stage) => stage.id === "implement").complete, true);
    assert.equal(archived.stages.find((stage) => stage.id === "check").complete, true);
    assert.equal(derivedIndex >= archiveIndex, true);
  } finally {
    clearScanCaches();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("跨仓库父子任务会归组，父任务继承子任务各阶段进度", () => {
  const backend = makeRepo();
  const frontend = makeRepo();
  try {
    const backendParentDir = path.join(backend, ".trellis", "tasks", "10-30-parent");
    fs.mkdirSync(backendParentDir, { recursive: true });
    const frontendChildDir = path.join(frontend, ".trellis", "tasks", "10-30-frontend");
    fs.renameSync(path.join(frontend, ".trellis", "tasks", "10-20-live"), frontendChildDir);
    const backendChildDir = path.join(backend, ".trellis", "tasks", "10-30-backend");
    fs.renameSync(path.join(backend, ".trellis", "tasks", "10-20-live"), backendChildDir);
    const parent = {
      id: "parent",
      title: "父任务",
      status: "planning",
      assignee: "dev",
      creator: "dev",
      children: ["10-30-backend"],
      parent: null,
      meta: { frontendTask: frontendChildDir }
    };
    fs.writeFileSync(path.join(backendParentDir, "task.json"), JSON.stringify(parent));
    fs.writeFileSync(
      path.join(backendParentDir, "prd.md"),
      "# Parent\n\n## Requirements\n\n- requirement\n\n## Acceptance Criteria\n\n- [ ] E2E pending\n"
    );
    fs.writeFileSync(path.join(backendParentDir, "design.md"), "# Design\n");
    fs.writeFileSync(path.join(backendParentDir, "implement.md"), "# Plan\n");
    const backendChildPath = path.join(backendChildDir, "task.json");
    const backendChild = JSON.parse(fs.readFileSync(backendChildPath, "utf8"));
    backendChild.parent = "10-30-parent";
    backendChild.relatedFiles = [".trellis/spec/backend.md"];
    backendChild.commit = "def5678";
    fs.writeFileSync(backendChildPath, JSON.stringify(backendChild));
    const frontendChildPath = path.join(frontendChildDir, "task.json");
    const frontendChild = JSON.parse(fs.readFileSync(frontendChildPath, "utf8"));
    frontendChild.status = "in_progress";
    frontendChild.relatedFiles = [".trellis/spec/frontend.md"];
    frontendChild.commit = "abc1234";
    frontendChild.meta = {
      backendParentTask: backendParentDir
    };
    fs.writeFileSync(frontendChildPath, JSON.stringify(frontendChild));

    const results = [
      scanRepository({ id: "backend", name: "Backend", path: backend }),
      scanRepository({ id: "frontend", name: "Frontend", path: frontend })
    ];
    const tasks = linkTaskGroups(results).map(toTaskListItem);
    const linkedParent = tasks.find((task) => task.title === "父任务");
    assert.equal(linkedParent.groupSize, 3);
    assert.equal(linkedParent.groupRole, "parent");
    assert.equal(linkedParent.groupRelationsValid, true);
    assert.deepEqual(linkedParent.groupWarnings, []);
    assert.equal(linkedParent.derivedStage, "archive");
    assert.equal(linkedParent.stages.find((stage) => stage.id === "implement").source, "group-child");
    assert.equal(linkedParent.stages.find((stage) => stage.id === "e2e").source, "group-child");
    assert.equal(linkedParent.stages.find((stage) => stage.id === "spec").source, "group-child");
    assert.equal(linkedParent.stages.find((stage) => stage.id === "commit").source, "group-child");
    assert.equal(tasks.filter((task) => task.groupRole === "child").length, 2);
  } finally {
    fs.rmSync(backend, { recursive: true, force: true });
    fs.rmSync(frontend, { recursive: true, force: true });
  }
});

test("E2E 未记录时不会阻塞收尾", () => {
  const root = makeRepo();
  try {
    const liveDir = path.join(root, ".trellis", "tasks", "10-20-live");
    fs.rmSync(path.join(liveDir, "e2e-report.md"));
    const task = JSON.parse(fs.readFileSync(path.join(liveDir, "task.json"), "utf8"));
    task.relatedFiles = [".trellis/spec/backend.md"];
    fs.writeFileSync(path.join(liveDir, "task.json"), JSON.stringify(task));
    fs.writeFileSync(path.join(liveDir, "implement.md"), "# Plan\n实现完成，检查通过。\n");

    const result = scanRepository({ id: "demo", name: "Demo", path: root }, { includeContent: true });
    const live = result.tasks.find((candidate) => !candidate.archived);
    assert.equal(live.stages.find((stage) => stage.id === "e2e").complete, false);
    assert.equal(live.stages.find((stage) => stage.id === "spec").complete, true);
    assert.equal(live.derivedStage, "commit");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("归档任务只保留历史，不再落回收尾队列", () => {
  const root = makeRepo();
  try {
    const result = scanRepository({ id: "demo", name: "Demo", path: root }, { includeContent: true });
    const archived = result.tasks.find((task) => task.archived);
    const derivedIndex = archived.stages.findIndex((stage) => stage.id === archived.derivedStage);
    const archiveIndex = archived.stages.findIndex((stage) => stage.id === "archive");
    assert.equal(derivedIndex >= archiveIndex, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function groupedTask(taskKey, options = {}) {
  return {
    taskKey,
    projectId: options.projectId || "demo",
    projectName: options.projectName || "Demo",
    repoPath: options.repoPath || path.resolve("/repo"),
    dirName: options.dirName || taskKey,
    relativeDir: options.relativeDir || `.trellis/tasks/${taskKey}`,
    title: options.title || taskKey,
    status: "in_progress",
    createdAt: options.createdAt || "2026-10-27",
    parent: options.parent ?? null,
    children: options.children || [],
    meta: options.meta || {},
    relatedFiles: [],
    commit: null,
    archived: false,
    derivedStage: "e2e",
    stages: [
      {
        id: "e2e",
        label: "真实验证",
        index: 9,
        complete: false,
        source: "missing",
        evidence: null
      }
    ]
  };
}

test("同一子任务被多个父任务引用时报告关系冲突且停止汇总", () => {
  const tasks = linkTaskGroups([{
    tasks: [
      groupedTask("parent-a", { children: ["child"] }),
      groupedTask("parent-b", { children: ["child"] }),
      groupedTask("child")
    ]
  }]);
  const child = tasks.find((task) => task.taskKey === "child");
  assert.equal(child.groupSize, 3);
  assert.equal(child.groupRelationsValid, false);
  assert.equal(child.relationshipWarnings.some((warning) => warning.code === "RELATION_CONFLICT"), true);
  assert.equal(child.groupWarnings.some((warning) => warning.includes("2 个父任务")), true);
});

test("父子关系循环会阻止父任务阶段继承并暴露警告", () => {
  const tasks = linkTaskGroups([{
    tasks: [
      groupedTask("cycle-a", { children: ["cycle-b"] }),
      groupedTask("cycle-b", { children: ["cycle-a"] })
    ]
  }]);
  assert.equal(tasks.length, 2);
  tasks.forEach((task) => {
    assert.equal(task.groupSize, 2);
    assert.equal(task.groupRelationsValid, false);
    assert.equal(task.relationshipWarnings.some((warning) => warning.code === "RELATION_CYCLE"), true);
    assert.equal(task.stages[0].complete, false);
  });
});

test("普通 meta 路径不会建立父子关系", () => {
  const taskA = groupedTask("task-a", {
    meta: {
      siblingTasks: [".trellis/tasks/task-b"]
    }
  });
  const taskB = groupedTask("task-b");
  const tasks = linkTaskGroups([{ tasks: [taskA, taskB] }]);
  tasks.forEach((task) => {
    assert.equal(task.groupSize, 1);
    assert.equal(task.groupRelationsValid, true);
  });
});

test("归档前的跨仓绝对路径能唯一解析到归档任务", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-board-archive-ref-"));
  const otherRepo = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-board-archive-target-"));
  try {
    const tasksRoot = path.join(repo, ".trellis", "tasks");
    const archivedTasksRoot = path.join(otherRepo, ".trellis", "tasks", "archive", "2026-10");
    fs.mkdirSync(path.join(tasksRoot, "parent"), { recursive: true });
    fs.mkdirSync(path.join(archivedTasksRoot, "child"), { recursive: true });
    const stalePath = path.join(otherRepo, ".trellis", "tasks", "child");
    fs.writeFileSync(
      path.join(tasksRoot, "parent", "task.json"),
      JSON.stringify({ id: "parent", title: "Parent", children: [stalePath] })
    );
    fs.writeFileSync(
      path.join(archivedTasksRoot, "child", "task.json"),
      JSON.stringify({ id: "child", title: "Child", status: "completed", parent: stalePath })
    );
    const parentTask = groupedTask("parent", {
      projectId: "source",
      projectName: "Source",
      repoPath: repo,
      relativeDir: ".trellis/tasks/parent",
      children: [stalePath]
    });
    const childTask = groupedTask("child", {
      projectId: "target",
      projectName: "Target",
      repoPath: otherRepo,
      relativeDir: ".trellis/tasks/archive/2026-10/child"
    });
    const tasks = linkTaskGroups([{ tasks: [parentTask, childTask] }]);
    assert.equal(tasks.length, 2);
    tasks.forEach((task) => {
      assert.equal(task.groupSize, 2);
      assert.equal(task.groupRelationsValid, true);
      assert.equal(task.relationshipWarnings.length, 0);
    });
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(path.join(otherRepo), { recursive: true, force: true });
  }
});
