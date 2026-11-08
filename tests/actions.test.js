import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("创建任务会拒绝空标题", async () => {
  const { createTask } = await import("../server/actions.js");
  await assert.rejects(
    () => createTask({ repositoryId: "missing", title: "", description: "x", assignee: "dev" }),
    /任务标题不能为空/
  );
});

test("纯中文标题未填写标识时会给出明确提示", async () => {
  const { createTask } = await import("../server/actions.js");
  await assert.rejects(
    () => createTask({
      repositoryId: "missing",
      title: "补齐看板任务导出能力",
      description: "x",
      assignee: "dev"
    }),
    /请填写任务标识/
  );
});

test("无效任务标识会在调用 Trellis 前被拒绝", async () => {
  const { createTask } = await import("../server/actions.js");
  await assert.rejects(
    () => createTask({
      repositoryId: "missing",
      title: "补齐看板任务导出能力",
      description: "x",
      assignee: "dev",
      slug: "Board Export"
    }),
    /任务标识只能包含/
  );
});

test("大写任务编号标识会保留并继续后续校验", async () => {
  const { createTask } = await import("../server/actions.js");
  await assert.rejects(
    () => createTask({
      repositoryId: "missing",
      title: "大写编号任务",
      description: "x",
      assignee: "dev",
      slug: "T100001"
    }, { listRepositories: () => [] }),
    /仓库不在白名单中/
  );
});

test("英文标题可以自动生成任务标识并继续后续校验", async () => {
  const { createTask } = await import("../server/actions.js");
  await assert.rejects(
    () => createTask({
      repositoryId: "missing",
      title: "Fix DBXConnectionPool timeout",
      description: "x",
      assignee: "dev"
    }, { listRepositories: () => [] }),
    /仓库不在白名单中/
  );
});

test("个人版拒绝任意归档后代派发且非归档任务仍可更新", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-archive-assign-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.mkdirSync(path.join(root, ".trellis", "workspace", "bob"), { recursive: true });
  const { assignTask } = await import("../server/actions.js");
  const repositories = () => [{ id: "demo", name: "Demo", path: root }];
  const archivedPaths = [
    ".trellis/tasks/archive/2026-11/11-08-old",
    ".trellis/tasks/archive/..hidden"
  ];

  for (const relativeDir of archivedPaths) {
    const taskDir = path.join(root, relativeDir);
    const taskJsonPath = path.join(taskDir, "task.json");
    fs.mkdirSync(taskDir, { recursive: true });
    // 非法 JSON 证明归档校验发生在读取 task.json 之前。
    fs.writeFileSync(taskJsonPath, "{ invalid");
    await assert.rejects(
      () => assignTask({
        repositoryId: "demo",
        taskDir: relativeDir,
        assignee: "bob"
      }, { listRepositories: repositories }),
      /归档任务只读，不能更新派发/
    );
    assert.equal(fs.readFileSync(taskJsonPath, "utf8"), "{ invalid");
  }

  const activeDir = path.join(root, ".trellis", "tasks", "11-08-active");
  const activeTaskJsonPath = path.join(activeDir, "task.json");
  fs.mkdirSync(activeDir, { recursive: true });
  fs.writeFileSync(activeTaskJsonPath, `${JSON.stringify({
    id: "active",
    title: "进行中任务",
    status: "in_progress",
    assignee: "alice",
    creator: "alice"
  }, null, 2)}\n`);

  await assignTask({
    repositoryId: "demo",
    taskDir: ".trellis/tasks/11-08-active",
    assignee: "bob"
  }, { listRepositories: repositories });
  assert.equal(JSON.parse(fs.readFileSync(activeTaskJsonPath, "utf8")).assignee, "bob");
});
