import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { escapeHtml } from "../public/dom.js";
import {
  assignableProjectMembers,
  canWriteProject,
  buildTaskQuery,
  normalizeAuditEvent,
  normalizeAssignments,
  normalizeBoardPage,
  normalizeOperation,
  normalizeRuntime,
  normalizeTaskPage,
  normalizeTeamTaskRow,
  normalizeTeamStatus,
  redactSensitiveDetail,
  safeReturnTo,
  shouldReloadTasks
} from "../public/team-client.js";

const publicFile = (name) => fs.readFileSync(new URL(`../public/${name}`, import.meta.url), "utf8");

test("escapeHtml 转义所有 HTML 上下文危险字符", () => {
  assert.equal(escapeHtml(`<a title="'">&</a>`), "&lt;a title=&quot;&#39;&quot;&gt;&amp;&lt;/a&gt;");
});

test("团队页面不加载外部资源，也不在浏览器存储凭证", () => {
  for (const page of ["index.html", "login.html", "admin.html"]) {
    const html = publicFile(page);
    assert.doesNotMatch(html, /<(?:script|link)[^>]+(?:src|href)=["']https?:/i);
  }
  for (const script of ["app.js", "login.js", "admin.js", "team-request.js", "team-client.js"]) {
    assert.doesNotMatch(publicFile(script), /\b(?:localStorage|sessionStorage)\s*(?:\.|\[)/);
  }
});

test("团队主页面导入启动流程使用的 runtime 归一化函数", () => {
  const source = publicFile("app.js");
  assert.match(source, /import\s*\{[\s\S]*\bnormalizeRuntime\b[\s\S]*\}\s*from\s*"\.\/team-client\.js"/);
  assert.match(source, /const runtime = normalizeRuntime\(result\.data\)/);
});

test("团队查询参数保留服务端筛选并限制页大小", () => {
  const query = new URLSearchParams(buildTaskQuery({
    scope: "mine",
    projectIds: ["p1", "p2"],
    priorities: ["P0", "P1"],
    stages: ["implement"],
    tags: ["后端"],
    q: " 看板 ",
    blocked: "blocked",
    archived: true
  }, { limit: 500, cursor: "next token" }));
  assert.equal(query.get("scope"), "mine");
  assert.equal(query.get("projectIds"), "p1,p2");
  assert.equal(query.get("priorities"), "P0,P1");
  assert.equal(query.get("q"), "看板");
  assert.equal(query.get("limit"), "200");
  assert.equal(query.get("cursor"), "next token");
  assert.equal(query.get("blocked"), "blocked");
  assert.equal(query.get("archived"), "1");
});

test("任务页兼容驼峰和下划线响应", () => {
  const page = normalizeTaskPage({
    rows: [{ taskKey: "a" }],
    next_cursor: "c2",
    total_count: 12,
    query_revision: 7,
    query_day: "2026-11-03"
  });
  assert.equal(page.tasks[0].taskKey, "a");
  assert.equal(page.nextCursor, "c2");
  assert.equal(page.total, 12);
  assert.equal(page.queryRevision, 7);
  assert.equal(page.queryDay, "2026-11-03");
});

test("仅 queryRevision、queryDay 或当前项目 boardVersion 变化时重载", () => {
  const base = {
    queryRevision: 1,
    queryDay: "2026-11-03",
    boardVersions: { p1: 3, p2: 8 }
  };
  assert.equal(shouldReloadTasks(base, { ...base }, "p1"), false);
  assert.equal(shouldReloadTasks(base, { ...base, queryRevision: 2 }, "p1"), true);
  assert.equal(shouldReloadTasks(base, { ...base, queryDay: "2026-11-04" }, "p1"), true);
  assert.equal(shouldReloadTasks(base, { ...base, boardVersions: { p1: 4, p2: 8 } }, "p1"), true);
  assert.equal(shouldReloadTasks(base, { ...base, boardVersions: { p1: 3, p2: 9 } }, "p1"), false);
});

test("runtime 只在显式 team 模式启用团队界面", () => {
  const standalone = normalizeRuntime({ mode: "standalone" });
  assert.equal(standalone.team, false);
  const team = normalizeRuntime({
    mode: "team",
    user: {
      id: "u1",
      display_name: "张三",
      system_admin: true
    }
  });
  assert.equal(team.team, true);
  assert.equal(team.user.displayName, "张三");
  assert.equal(team.systemAdmin, true);
});

test("项目写能力同时受角色和同步状态约束", () => {
  assert.equal(canWriteProject({ role: "member", syncStatus: "current" }), true);
  assert.equal(canWriteProject({ role: "read_only", syncStatus: "current" }), false);
  assert.equal(canWriteProject({ role: "lead", syncStatus: "needs_repair" }), false);
});

test("团队任务详情不再整块禁用计划、阶段、依赖与撤销操作", () => {
  const app = publicFile("app.js");
  for (const name of [
    "bindExecutionActions",
    "bindUndoAction",
    "bindDependencyActions",
    "bindStageActions"
  ]) {
    const start = app.indexOf(`function ${name}(`);
    const end = app.indexOf("\nfunction ", start + 1);
    assert.notEqual(start, -1, name);
    assert.doesNotMatch(
      app.slice(start, end === -1 ? app.length : end),
      /if \(state\.teamMode\) return;/,
      name
    );
  }
  assert.match(app, /function canWriteTask\(task\)/);
});

test("团队负责人候选只包含 active 的 lead/member developer", () => {
  const members = assignableProjectMembers({
    members: [
      { user_id: "u1", role: "lead", status: "active", trellis_dev_id: "dev-lead" },
      { user_id: "u2", role: "member", status: "active", trellis_dev_id: "dev-member" },
      { user_id: "u3", role: "read_only", status: "active", trellis_dev_id: "dev-reader" },
      { user_id: "u4", role: "member", status: "disabled", trellis_dev_id: "dev-disabled" },
      { user_id: "u5", role: "member", status: "active", trellis_dev_id: "" }
    ]
  });
  assert.deepEqual(members.map((member) => member.trellisDevId), ["dev-lead", "dev-member"]);
});

test("assignment 兼容下划线响应并保留条件更新版本", () => {
  const rows = normalizeAssignments({
    assignments: [{
      execution_task_key: "p1::task",
      assignment_version: 3,
      assignment_state: "pending"
    }]
  });
  assert.equal(rows[0].executionTaskKey, "p1::task");
  assert.equal(rows[0].assignmentVersion, 3);
  assert.equal(rows[0].assignmentState, "pending");
});

test("团队查询行统一下划线字段，保留执行键与版本", () => {
  const row = normalizeTeamTaskRow({
    task_key: "p1::task",
    execution_task_key: "exec-1",
    task_version: 7,
    assignment_version: 2,
    project_id: "p1",
    project_name: "项目一",
    relative_dir: ".trellis/tasks/task",
    derived_stage: "implement",
    assignee_dev_id: "dev-a",
    attention_reasons: ["overdue"]
  });
  assert.equal(row.taskKey, "p1::task");
  assert.equal(row.executionTaskKey, "exec-1");
  assert.equal(row.taskVersion, 7);
  assert.equal(row.assignmentVersion, 2);
  assert.equal(row.derivedStage, "implement");
  assert.equal(row.assignee, "dev-a");
  assert.equal(row.dirName, "task");
});

test("单项目 board 分页从 pagePayload 顶层读取游标与版本", () => {
  const page = normalizeBoardPage({
    board: { projects: [], tasks: [{ taskKey: "p::one" }] },
    nextCursor: "next-page",
    total: 220,
    queryRevision: 9,
    queryDay: "2026-11-03"
  });
  assert.equal(page.nextCursor, "next-page");
  assert.equal(page.total, 220);
  assert.equal(page.queryRevision, 9);
  assert.equal(page.tasks[0].taskKey, "p::one");
});

test("审计详情渲染前再次隐藏敏感键", () => {
  assert.deepEqual(redactSensitiveDetail({
    action: "reset",
    temporaryPassword: "secret",
    nested: { agentToken: "secret", safe: "visible" }
  }), {
    action: "reset",
    temporaryPassword: "[已隐藏]",
    nested: { agentToken: "[已隐藏]", safe: "visible" }
  });
});

test("审计事件归一化后仍隐藏一次性凭证", () => {
  const event = normalizeAuditEvent({
    id: "7",
    action: "user_created",
    detail: { temporary_password: "secret", userId: "u1" }
  });
  assert.equal(event.id, 7);
  assert.equal(event.detail.temporary_password, "[已隐藏]");
  assert.equal(event.detail.userId, "u1");
});

test("团队状态读取 assignments.pending 并保留项目版本", () => {
  const status = normalizeTeamStatus({
    queryRevision: 4,
    assignments: { pending: 3 },
    projects: [{ id: "p1", boardVersion: "v1" }]
  });
  assert.equal(status.pendingAssignments, 3);
  assert.equal(status.boardVersions.p1, "v1");
});

test("团队状态轮询复用 ETag 并处理 304", () => {
  const source = publicFile("app.js");
  assert.match(source, /teamStatusEtag/);
  assert.match(source, /if \(result\.status === 304\) return true;/);
  assert.match(source, /"if-none-match": state\.teamStatusEtag/);
});

test("Git 操作同时兼容 commit sha 字段", () => {
  const operation = normalizeOperation({
    id: "op1",
    status: "pushed",
    local_commit_sha: "local",
    remote_commit_sha: "remote"
  });
  assert.equal(operation.localSha, "local");
  assert.equal(operation.remoteSha, "remote");
});

test("登录回跳只接受同源相对路径", () => {
  assert.equal(safeReturnTo("/admin.html?tab=projects"), "/admin.html?tab=projects");
  assert.equal(safeReturnTo("//example.com/steal"), "/");
  assert.equal(safeReturnTo("https://example.com/steal"), "/");
  assert.equal(safeReturnTo("/\\example.com"), "/");
  assert.equal(safeReturnTo("/login.html?returnTo=%2F"), "/");
});
