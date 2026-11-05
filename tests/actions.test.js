import test from "node:test";
import assert from "node:assert/strict";

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
