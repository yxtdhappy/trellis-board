import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { normalizeRemoteIdentity } from "../agent/git-sync.js";
import { parseTeamConfig } from "../server/config.js";
import { openDatabase } from "../server/database.js";
import { createUser } from "../server/team/auth.js";
import { syncAssignmentsFromBoardInTransaction } from "../server/team/assignments.js";
import { diagnose, initFirstAdmin } from "../server/team/cli.js";
import { normalizeGitRemote } from "../server/team/git-manager.js";
import { createTeamRuntime } from "../server/team/http.js";
import { createProjectService } from "../server/team/projects.js";

const PUBLIC_ORIGIN = "http://127.0.0.1:4317";
const HOST = "127.0.0.1:4317";
const SILENT_LOGGER = {
  info() {},
  warn() {},
  error() {}
};

test("团队配置按公开地址默认安全 Cookie，并拒绝非回环不安全配置", () => {
  const local = parseTeamConfig({
    TRELLIS_BOARD_MODE: "team",
    TRELLIS_TEAM_PUBLIC_URL: "http://127.0.0.1:4317"
  });
  assert.equal(local.cookieSecure, false);

  const secure = parseTeamConfig({
    TRELLIS_BOARD_MODE: "team",
    TRELLIS_TEAM_PUBLIC_URL: "https://127.0.0.1:4317"
  });
  assert.equal(secure.cookieSecure, true);

  assert.throws(
    () => parseTeamConfig({
      TRELLIS_BOARD_MODE: "team",
      TRELLIS_TEAM_PUBLIC_URL: "http://board.example.com"
    }),
    /非回环团队地址必须使用 HTTPS/
  );
  assert.throws(
    () => parseTeamConfig({
      TRELLIS_BOARD_MODE: "team",
      TRELLIS_TEAM_PUBLIC_URL: "https://board.example.com",
      TRELLIS_TEAM_COOKIE_SECURE: "false"
    }),
    /非回环团队地址必须启用安全 Cookie/
  );
});

test("项目接入克隆后工具链失败会清理本次 UUID 工作副本", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-team-connect-"));
  const dataPath = path.join(root, "data");
  const db = openDatabase({
    databaseFile: path.join(dataPath, "board.sqlite"),
    fallbackRepositories: [],
    importLegacyRepositories: false,
    legacyJsonImport: false,
    logger: SILENT_LOGGER
  });
  t.after(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  let clonedTarget = null;
  const projectService = createProjectService({
    db,
    config: testConfig(),
    dataDir: dataPath,
    gitManager: {
      async assertValidBranch(branch) {
        return branch;
      },
      async cloneProject(project) {
        clonedTarget = path.join(dataPath, "projects", project.workspaceKey);
        fs.mkdirSync(clonedTarget, { recursive: true });
        fs.writeFileSync(path.join(clonedTarget, "README.md"), "clone");
        return clonedTarget;
      }
    },
    taskIndex: {
      incrementQueryRevision() {}
    }
  });
  await assert.rejects(
    projectService.connect(
      { userId: "11111111-1111-4111-8111-111111111111", systemAdmin: true },
      {
        name: "无效工具链项目",
        remoteUrl: "https://example.com/invalid-toolchain.git",
        syncBranch: "main"
      }
    ),
    (error) => error.code === "TOOLCHAIN_MISMATCH"
  );
  assert.equal(fs.existsSync(clonedTarget), false);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM repositories").get().count,
    0
  );
});

test("首管理员 CLI 只初始化一次且不会导入本机默认仓库", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-team-cli-"));
  const databaseFile = path.join(root, "data", "board.sqlite");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const user = await initFirstAdmin({
    config: testConfig(),
    databaseFile,
    username: "first-admin",
    displayName: "首管理员",
    password: "Initial-Password-123"
  });
  assert.equal(user.systemAdmin, true);
  assert.equal(user.mustChangePassword, true);

  const db = openDatabase({
    databaseFile,
    fallbackRepositories: [],
    importLegacyRepositories: false,
    legacyJsonImport: false,
    logger: SILENT_LOGGER
  });
  try {
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM repositories").get().count,
      0
    );
  } finally {
    db.close();
  }
  const status = diagnose({ config: testConfig(), databaseFile });
  assert.equal(status.schemaVersion, "4");
  assert.equal(status.activeAdmin, true);
  assert.equal(status.integrity, "ok");
  await assert.rejects(
    initFirstAdmin({
      config: testConfig(),
      databaseFile,
      username: "second-admin",
      password: "Second-Password-123"
    }),
    /已有有效管理员/
  );
});

test("服务端 Git 远端身份哈希与 Windows Agent 的 HTTPS/SSH/file 语义一致", () => {
  const remotes = [
    "https://GitHub.com/Org/Repo.git",
    "https://GitHub.com:443/Org/Repo",
    "https://GitHub.com:8443/Org/Repo.git",
    "ssh://git@Example.COM:22/Org/Repo.git",
    "git@Example.COM:Org/Repo.git"
  ];
  for (const remote of remotes) {
    assert.equal(
      normalizeGitRemote(remote, testConfig()).identityHash,
      normalizeRemoteIdentity(remote).identityHash,
      remote
    );
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-remote-"));
  try {
    const localRemote = path.join(root, "Remote.git");
    fs.mkdirSync(localRemote);
    const localConfig = {
      ...testConfig(),
      allowLocalGitRemotes: true
    };
    const fileUrl = pathToFileURL(localRemote).href;
    const expected = normalizeRemoteIdentity(fileUrl, {
      allowFileRemote: true
    }).identityHash;
    assert.equal(
      normalizeGitRemote(localRemote, localConfig).identityHash,
      expected
    );
    assert.equal(
      normalizeGitRemote(fileUrl, localConfig).identityHash,
      expected
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function testConfig() {
  return {
    mode: "team",
    bindHost: "127.0.0.1",
    port: 0,
    publicUrl: new URL(PUBLIC_ORIGIN),
    publicOrigin: PUBLIC_ORIGIN,
    sessionTtlMs: 12 * 60 * 60 * 1000,
    agentStaleMs: 60_000,
    gitPollMs: 60_000,
    cookieSecure: false,
    trustProxy: false,
    allowLocalGitRemotes: false
  };
}

function request(runtime, pathname, {
  method = "GET",
  body = null,
  cookie = null,
  agentCredential = null,
  origin = PUBLIC_ORIGIN,
  contentType = "application/json",
  headers = {}
} = {}) {
  const address = runtime.address();
  const payload = body == null ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const requestHeaders = {
      host: HOST,
      ...headers
    };
    if (payload != null) {
      requestHeaders["content-type"] = contentType;
      requestHeaders["content-length"] = Buffer.byteLength(payload);
    }
    if (origin != null && method !== "GET" && method !== "HEAD") {
      requestHeaders.origin = origin;
    }
    if (cookie) requestHeaders.cookie = cookie;
    if (agentCredential) {
      requestHeaders.authorization = `Bearer ${agentCredential}`;
    }
    const req = http.request({
      hostname: "127.0.0.1",
      port: address.port,
      path: pathname,
      method,
      headers: requestHeaders
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        if (text) {
          try {
            json = JSON.parse(text);
          } catch {
            json = text;
          }
        }
        resolve({
          status: response.statusCode,
          headers: response.headers,
          body: json
        });
      });
    });
    req.on("error", reject);
    if (payload != null) req.write(payload);
    req.end();
  });
}

function sessionCookie(response) {
  const values = response.headers["set-cookie"] || [];
  return String(values[0] || "").split(";")[0];
}

async function login(runtime, password, username = "admin") {
  return request(runtime, "/api/auth/login", {
    method: "POST",
    body: { username, password }
  });
}

function seedProject(runtime, user, root) {
  const now = new Date().toISOString();
  const repositoryPath = path.join(root, "projects", "p1");
  fs.mkdirSync(repositoryPath, { recursive: true });
  runtime.db.prepare(`
    INSERT INTO repositories(id, name, path, path_key, position, created_at, updated_at)
    VALUES ('p1', '项目一', ?, ?, 0, ?, ?)
  `).run(repositoryPath, repositoryPath.toLowerCase(), now, now);
  runtime.db.prepare(`
    INSERT INTO team_project(
      repository_id, workspace_key, remote_url, remote_identity_hash,
      sync_branch, trusted_task_toolchain_sha256, sync_status, created_at, updated_at
    ) VALUES ('p1', 'p1-workspace', 'https://example.com/p1.git', ?,
      'main', ?, 'current', ?, ?)
  `).run("f".repeat(64), "a".repeat(64), now, now);
  runtime.db.prepare(`
    INSERT INTO project_member(
      project_id, user_id, role, trellis_dev_id, created_by, created_at, updated_at
    ) VALUES ('p1', ?, 'lead', 'alice', ?, ?, ?)
  `).run(user.id, user.id, now, now);
}

function seedIndexedTasks(runtime) {
  const repository = runtime.db.prepare(`
    SELECT path FROM repositories WHERE id = 'p1'
  `).get();
  const insert = runtime.db.prepare(`
    INSERT INTO team_task_index(
      project_id, task_key, execution_task_key, relative_dir, title,
      search_text, archived, priority, derived_stage, assignee_dev_id,
      assignee_user_id, due_date, last_activity_at, is_blocked,
      is_unblocked_ready, attention_flags_json, group_key, group_role,
      task_version, board_version, updated_at
    ) VALUES (
      'p1', ?, ?, ?, ?, ?, 0, 'P2', 'implement', 'alice',
      NULL, NULL, ?, 0, 1, '[]', ?, 'parent', ?, 'board-1', ?
    )
  `);
  for (let index = 1; index <= 3; index += 1) {
    const taskKey = `p1::.trellis/tasks/task-${index}`;
    const activity = new Date(Date.UTC(2026, 10, 3, 0, index, 0)).toISOString();
    const taskDir = path.join(repository.path, ".trellis", "tasks", `task-${index}`);
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, "task.json"), JSON.stringify({
      id: `task-${index}`,
      title: `任务 ${index}`,
      description: `团队任务 ${index}`,
      status: "in_progress",
      priority: "P2",
      assignee: index === 1 ? "alice" : "bob",
      creator: "alice",
      created_at: activity
    }));
    insert.run(
      taskKey,
      `p1::task-${index}`,
      `.trellis/tasks/task-${index}`,
      `任务 ${index}`,
      `任务 ${index}`,
      activity,
      taskKey,
      `version-${index}`,
      activity
    );
  }
  runtime.services.taskIndex.incrementQueryRevision();
}

function seedPollingProjects(runtime, root, count) {
  const now = new Date().toISOString();
  for (let index = 0; index < count; index += 1) {
    const projectId = `poll-${index}`;
    const repositoryPath = path.join(root, "projects", projectId);
    fs.mkdirSync(repositoryPath, { recursive: true });
    runtime.db.prepare(`
      INSERT INTO repositories(id, name, path, path_key, position, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      projectId,
      projectId,
      repositoryPath,
      repositoryPath.toLowerCase(),
      index,
      now,
      now
    );
    runtime.db.prepare(`
      INSERT INTO team_project(
        repository_id, workspace_key, remote_url, remote_identity_hash,
        sync_branch, trusted_task_toolchain_sha256, sync_status, created_at, updated_at
      ) VALUES (?, ?, 'https://example.com/project.git', ?,
        'main', ?, 'current', ?, ?)
    `).run(
      projectId,
      `${projectId}-workspace`,
      "f".repeat(64),
      "a".repeat(64),
      now,
      now
    );
  }
}

test("团队 HTTP 鉴权、改密保留当前会话、CSRF、游标与 Agent 协议", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-team-core-"));
  const runtime = await createTeamRuntime({
    config: testConfig(),
    databaseFile: path.join(root, "data", "board.sqlite"),
    dataDir: path.join(root, "data"),
    logger: SILENT_LOGGER,
    requireAdmin: false,
    enablePolling: false
  });
  await runtime.start();
  t.after(async () => {
    await runtime.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  assert.equal(
    runtime.db.prepare("SELECT COUNT(*) AS count FROM repositories").get().count,
    0,
    "team 空库不能导入本机默认仓库"
  );

  const user = await createUser(runtime.db, {
    username: "admin",
    displayName: "管理员",
    password: "Admin-Password-123",
    systemAdmin: true,
    mustChangePassword: false
  });

  const unauthenticated = await request(runtime, "/api/tasks/query");
  assert.equal(unauthenticated.status, 401);
  assert.equal(unauthenticated.body.code, "AUTH_REQUIRED");

  const missingOrigin = await request(runtime, "/api/auth/login", {
    method: "POST",
    body: { username: "admin", password: "Admin-Password-123" },
    origin: null
  });
  assert.equal(missingOrigin.status, 403);
  assert.equal(missingOrigin.body.code, "CSRF_REJECTED");

  const firstLogin = await login(runtime, "Admin-Password-123");
  assert.equal(firstLogin.status, 200);
  const firstCookie = sessionCookie(firstLogin);
  assert.match(String(firstLogin.headers["set-cookie"]), /HttpOnly/);
  assert.match(String(firstLogin.headers["set-cookie"]), /SameSite=Strict/);
  assert.equal(firstLogin.body.user.mustChangePassword, false);

  const emptyPage = await request(runtime, "/api/tasks/query", {
    cookie: firstCookie
  });
  assert.equal(emptyPage.status, 200);
  assert.deepEqual(emptyPage.body.tasks, []);
  assert.equal(emptyPage.body.total, 0);

  seedProject(runtime, user, root);
  seedIndexedTasks(runtime);

  const readOnlyUser = await createUser(runtime.db, {
    username: "reader",
    displayName: "只读成员",
    password: "Reader-Password-123",
    systemAdmin: false,
    mustChangePassword: false
  });
  const now = new Date().toISOString();
  runtime.db.prepare(`
    INSERT INTO project_member(
      project_id, user_id, role, trellis_dev_id, created_by, created_at, updated_at
    ) VALUES ('p1', ?, 'read_only', NULL, ?, ?, ?)
  `).run(readOnlyUser.id, user.id, now, now);
  const memberUser = await createUser(runtime.db, {
    username: "member",
    displayName: "项目成员",
    password: "Member-Password-123",
    systemAdmin: false,
    mustChangePassword: false
  });
  runtime.db.prepare(`
    INSERT INTO project_member(
      project_id, user_id, role, trellis_dev_id, created_by, created_at, updated_at
    ) VALUES ('p1', ?, 'member', 'bob', ?, ?, ?)
  `).run(memberUser.id, user.id, now, now);
  const memberLogin = await login(runtime, "Member-Password-123", "member");
  const memberCookie = sessionCookie(memberLogin);
  const memberProjects = await request(runtime, "/api/team/projects", {
    cookie: memberCookie
  });
  assert.equal(memberProjects.status, 200);
  assert.deepEqual(
    memberProjects.body.projects[0].validAssignees.map((member) => member.trellisDevId),
    ["alice", "bob"]
  );
  const memberCandidates = await request(runtime, "/api/projects/p1/members", {
    cookie: memberCookie
  });
  assert.equal(memberCandidates.status, 200);
  assert.deepEqual(
    memberCandidates.body.members.map((member) => member.trellisDevId),
    ["alice", "bob"]
  );
  const readOnlyLogin = await login(runtime, "Reader-Password-123", "reader");
  const readOnlyCookie = sessionCookie(readOnlyLogin);
  assert.equal((await request(runtime, "/api/board?projectId=p1", {
    cookie: readOnlyCookie
  })).status, 200);
  const readOnlyWrite = await request(runtime, "/api/tasks", {
    method: "POST",
    cookie: readOnlyCookie,
    body: {
      projectId: "p1",
      title: "只读成员不能创建",
      description: "权限测试",
      idempotencyKey: "reader-write-0001"
    }
  });
  assert.equal(readOnlyWrite.status, 403);
  const readOnlyMembers = await request(runtime, "/api/projects/p1/members", {
    cookie: readOnlyCookie
  });
  assert.equal(readOnlyMembers.status, 200);
  assert.deepEqual(
    readOnlyMembers.body.members.map((member) => member.trellisDevId),
    ["alice", "bob"]
  );
  const readOnlyMemberWrite = await request(runtime, "/api/projects/p1/members", {
    method: "PUT",
    cookie: readOnlyCookie,
    body: {
      userId: memberUser.id,
      role: "member",
      trellisDevId: "bob"
    }
  });
  assert.equal(readOnlyMemberWrite.status, 403);
  const readOnlyPlanWrite = await request(runtime, "/api/tasks/execution", {
    method: "PUT",
    cookie: readOnlyCookie,
    body: {
      projectId: "p1",
      taskPath: ".trellis/tasks/task-1",
      dueDate: "2026-11-30",
      milestone: "只读写入",
      tags: ["禁止"]
    }
  });
  assert.equal(readOnlyPlanWrite.status, 403);

  const memberPlan = await request(runtime, "/api/tasks/execution", {
    method: "PUT",
    cookie: memberCookie,
    body: {
      projectId: "p1",
      taskPath: ".trellis/tasks/task-1",
      dueDate: "2026-11-20",
      milestone: "成员计划",
      tags: ["协作"]
    }
  });
  assert.equal(memberPlan.status, 200);
  const adminPlan = await request(runtime, "/api/tasks/execution", {
    method: "PUT",
    cookie: firstCookie,
    body: {
      projectId: "p1",
      taskPath: ".trellis/tasks/task-1",
      dueDate: "2026-12-01",
      milestone: "负责人计划",
      tags: ["协作", "交付"]
    }
  });
  assert.equal(adminPlan.status, 200);
  const adminUndo = await request(runtime, "/api/tasks/undo", {
    method: "POST",
    cookie: firstCookie,
    body: { projectId: "p1", taskPath: ".trellis/tasks/task-1" }
  });
  assert.equal(adminUndo.status, 200);
  const taskAfterAdminUndo = await request(runtime, "/api/tasks/p1::task-1", {
    cookie: memberCookie
  });
  assert.equal(taskAfterAdminUndo.status, 200);
  assert.equal(taskAfterAdminUndo.body.task.execution.dueDate, "2026-11-20");
  assert.equal(taskAfterAdminUndo.body.task.execution.milestone, "成员计划");
  assert.equal(
    runtime.db.prepare(`
      SELECT actor_user_id
      FROM task_event
      WHERE execution_task_key = 'p1::task-1'
        AND event_type = 'task_plan_updated'
      ORDER BY occurred_at, rowid
      LIMIT 1
    `).get().actor_user_id,
    memberUser.id
  );

  const memberStage = await request(runtime, "/api/tasks/stage", {
    method: "PUT",
    cookie: memberCookie,
    body: {
      projectId: "p1",
      taskPath: ".trellis/tasks/task-1",
      stage: "check"
    }
  });
  assert.equal(memberStage.status, 200);
  assert.equal(
    runtime.db.prepare(`
      SELECT actor_user_id
      FROM task_event
      WHERE execution_task_key = 'p1::task-1'
        AND event_type = 'stage_manual_confirmed'
    `).get().actor_user_id,
    memberUser.id
  );

  const dependency = await request(runtime, "/api/tasks/dependencies", {
    method: "POST",
    cookie: memberCookie,
    body: {
      blocked: { projectId: "p1", taskPath: ".trellis/tasks/task-1" },
      blocker: { projectId: "p1", taskPath: ".trellis/tasks/task-2" },
      reason: "等待任务二"
    }
  });
  assert.equal(dependency.status, 201);
  const resolved = await request(runtime, "/api/tasks/dependencies", {
    method: "DELETE",
    cookie: memberCookie,
    body: { id: dependency.body.dependency.id }
  });
  assert.equal(resolved.status, 200);

  const memberView = await request(runtime, "/api/saved-views", {
    method: "POST",
    cookie: memberCookie,
    body: { name: "成员视图", filter: { stages: ["implement"] } }
  });
  assert.equal(memberView.status, 201);
  const adminView = await request(runtime, "/api/saved-views", {
    method: "POST",
    cookie: firstCookie,
    body: { name: "负责人视图", filter: { tags: ["交付"] } }
  });
  assert.equal(adminView.status, 201);
  assert.deepEqual(
    (await request(runtime, "/api/saved-views", { cookie: memberCookie }))
      .body.views.map((view) => view.name),
    ["成员视图"]
  );
  assert.deepEqual(
    (await request(runtime, "/api/saved-views", { cookie: firstCookie }))
      .body.views.map((view) => view.name),
    ["负责人视图"]
  );
  assert.equal((await request(runtime, "/api/saved-views", {
    method: "DELETE",
    cookie: firstCookie,
    body: { id: memberView.body.view.id }
  })).status, 400);

  const memberWip = await request(runtime, "/api/board/settings", {
    method: "PUT",
    cookie: memberCookie,
    body: { executionWipLimit: 4 }
  });
  assert.equal(memberWip.status, 200);
  assert.equal(memberWip.body.executionWipLimit, 4);
  assert.equal(
    runtime.db.prepare(`
      SELECT COUNT(*) AS count
      FROM audit_event
      WHERE project_id = 'p1'
        AND action IN (
          'task_plan_updated',
          'task_stage_updated',
          'dependency_created',
          'dependency_resolved',
          'task_operation_undone'
        )
    `).get().count >= 5,
    true
  );
  assert.equal((await request(runtime, "/api/admin/users", {
    cookie: readOnlyCookie
  })).status, 403);
  assert.equal((await request(runtime, "/api/admin/audit", {
    cookie: readOnlyCookie
  })).status, 403);

  const firstPage = await request(
    runtime,
    "/api/tasks/query?projectIds=p1&limit=1",
    { cookie: firstCookie }
  );
  assert.equal(firstPage.status, 200);
  assert.equal(firstPage.body.tasks.length, 1);
  assert.ok(firstPage.body.nextCursor);

  const secondPage = await request(
    runtime,
    `/api/tasks/query?projectIds=p1&limit=1&cursor=${encodeURIComponent(firstPage.body.nextCursor)}`,
    { cookie: firstCookie }
  );
  assert.equal(secondPage.status, 200);
  assert.equal(secondPage.body.tasks.length, 1);
  assert.notEqual(secondPage.body.tasks[0].taskKey, firstPage.body.tasks[0].taskKey);

  const badCursor = await request(
    runtime,
    `/api/tasks/query?projectIds=p1&limit=1&q=other&cursor=${encodeURIComponent(firstPage.body.nextCursor)}`,
    { cookie: firstCookie }
  );
  assert.equal(badCursor.status, 409);
  assert.equal(badCursor.body.code, "CURSOR_INVALID");

  const forbiddenProject = await request(
    runtime,
    "/api/tasks/query?projectIds=p2",
    { cookie: firstCookie }
  );
  assert.equal(forbiddenProject.status, 403);

  const notModified = await request(
    runtime,
    "/api/tasks/query?projectIds=p1&limit=1",
    {
      cookie: firstCookie,
      headers: { "if-none-match": firstPage.body.etag }
    }
  );
  assert.equal(notModified.status, 304);

  const statusFirst = await request(runtime, "/api/team/status", {
    cookie: firstCookie
  });
  assert.equal(statusFirst.status, 200);
  assert.ok(statusFirst.headers.etag);
  const statusNotModified = await request(runtime, "/api/team/status", {
    cookie: firstCookie,
    headers: { "if-none-match": statusFirst.headers.etag }
  });
  assert.equal(statusNotModified.status, 304);

  const boardWithoutProject = await request(runtime, "/api/board", {
    cookie: firstCookie
  });
  assert.equal(boardWithoutProject.status, 400);

  const csrfWrite = await request(runtime, "/api/tasks", {
    method: "POST",
    cookie: firstCookie,
    origin: null,
    body: {
      projectId: "p1",
      title: "不应创建",
      description: "CSRF 测试",
      idempotencyKey: "csrf-test-0001"
    }
  });
  assert.equal(csrfWrite.status, 403);
  assert.equal(csrfWrite.body.code, "CSRF_REJECTED");

  const wrongContentType = await request(runtime, "/api/tasks", {
    method: "POST",
    cookie: firstCookie,
    contentType: "application/jsonp",
    body: {
      projectId: "p1",
      title: "不应创建",
      description: "Content-Type 测试",
      idempotencyKey: "content-type-0001"
    }
  });
  assert.equal(wrongContentType.status, 415);
  assert.equal(wrongContentType.body.code, "JSON_REQUIRED");

  const secondLogin = await login(runtime, "Admin-Password-123");
  assert.equal(secondLogin.status, 200);
  const secondCookie = sessionCookie(secondLogin);
  const changed = await request(runtime, "/api/auth/password", {
    method: "POST",
    cookie: firstCookie,
    body: {
      currentPassword: "Admin-Password-123",
      newPassword: "Admin-Password-456"
    }
  });
  assert.equal(changed.status, 200);
  assert.equal((await request(runtime, "/api/auth/me", {
    cookie: firstCookie
  })).status, 200);
  assert.equal((await request(runtime, "/api/auth/me", {
    cookie: secondCookie
  })).status, 401);

  syncAssignmentsFromBoardInTransaction(runtime.db, "p1", {
    tasks: [{
      executionTaskKey: "p1::external-task",
      assignee: "alice",
      taskVersion: "external-version"
    }]
  });
  const externalAssignment = runtime.db.prepare(`
    SELECT assigned_user_id, state, base_task_version
    FROM task_assignment
    WHERE execution_task_key = 'p1::external-task'
  `).get();
  assert.deepEqual({ ...externalAssignment }, {
    assigned_user_id: user.id,
    state: "pending",
    base_task_version: "external-version"
  });

  const pairing = await request(runtime, "/api/team/pairing-codes", {
    method: "POST",
    cookie: firstCookie,
    body: {}
  });
  assert.equal(pairing.status, 201);
  const enrolled = await request(runtime, "/api/agent/enroll", {
    method: "POST",
    origin: null,
    body: {
      protocolVersion: 1,
      agentVersion: "1.0.0",
      platform: "win32",
      pairingCode: pairing.body.pairingCode,
      deviceName: "测试设备"
    }
  });
  assert.equal(enrolled.status, 201);

  const heartbeat = await request(runtime, "/api/agent/heartbeat", {
    method: "POST",
    origin: null,
    agentCredential: enrolled.body.credential,
    body: {
      protocolVersion: 1,
      agentId: enrolled.body.agentId,
      deviceName: "测试设备",
      agentVersion: "1.0.0",
      bindings: [{
        projectId: "p1",
        localRepoKey: "b".repeat(64),
        branchName: "main",
        remoteIdentityKey: normalizeRemoteIdentity(
          "https://example.com/p1.git"
        ).identityHash
      }]
    }
  });
  assert.equal(heartbeat.status, 200);
  assert.equal(heartbeat.body.bindings[0].status, "pending");
  const bindingId = heartbeat.body.bindings[0].bindingId;
  assert.equal(
    runtime.db.prepare(`
      SELECT remote_identity_hash
      FROM team_project
      WHERE repository_id = 'p1'
    `).get().remote_identity_hash,
    normalizeRemoteIdentity("https://example.com/p1.git").identityHash
  );

  const approved = await request(
    runtime,
    `/api/projects/p1/agents/${bindingId}/approve`,
    {
      method: "POST",
      cookie: firstCookie,
      body: {}
    }
  );
  assert.equal(approved.status, 200);
  const adminAudit = await request(runtime, "/api/admin/audit", {
    cookie: firstCookie
  });
  assert.equal(adminAudit.status, 200);
  assert.ok(adminAudit.body.events.some((event) => event.action === "agent_binding_approved"));

  const commands = await request(runtime, "/api/agent/commands", {
    method: "POST",
    origin: null,
    agentCredential: enrolled.body.credential,
    body: {
      protocolVersion: 1,
      agentId: enrolled.body.agentId,
      agentVersion: "1.0.0",
      waitMs: 0
    }
  });
  assert.equal(commands.status, 200);
  assert.equal(commands.body.commands.length, 1);
  const command = commands.body.commands[0];
  assert.equal(command.type, "sync_branch");
  assert.deepEqual(
    Object.keys(command.payload).sort(),
    ["branchName", "projectId", "protocolVersion"]
  );

  const result = await request(
    runtime,
    `/api/agent/commands/${command.id}/result`,
    {
      method: "POST",
      origin: null,
      agentCredential: enrolled.body.credential,
      body: {
        protocolVersion: 1,
        agentVersion: "1.0.0",
        status: "failed",
        result: {},
        error: { code: "SYNC_FAILED", message: "git failed" }
      }
    }
  );
  assert.equal(result.status, 200);
  const storedResult = runtime.db.prepare(`
    SELECT result_json FROM agent_command WHERE id = ?
  `).get(command.id).result_json;
  assert.match(storedResult, /"errorCode":"SYNC_FAILED"/);
  assert.match(storedResult, /"error":"git failed"/);
  assert.doesNotMatch(storedResult, /\[object Object\]/);
});

test("团队定时刷新对多个到期项目保持全局并发上限和项目去重", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-team-poll-"));
  const released = [];
  const calls = [];
  const runtime = await createTeamRuntime({
    config: testConfig(),
    databaseFile: path.join(root, "data", "board.sqlite"),
    dataDir: path.join(root, "data"),
    logger: SILENT_LOGGER,
    requireAdmin: false,
    enablePolling: false,
    refreshConcurrency: 4,
    scheduledRefresh(projectId) {
      calls.push(projectId);
      return new Promise((resolve) => released.push(resolve));
    }
  });
  t.after(async () => {
    for (const resolve of released.splice(0)) resolve();
    await new Promise((resolve) => setImmediate(resolve));
    await runtime.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  seedPollingProjects(runtime, root, 6);
  assert.deepEqual(runtime.polling.tick(), {
    active: 4,
    queued: 2,
    projectIds: runtime.polling.snapshot().projectIds
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 4);
  assert.equal(runtime.polling.snapshot().active, 4);

  runtime.polling.tick();
  assert.equal(runtime.polling.snapshot().active, 4);
  assert.equal(runtime.polling.snapshot().queued, 2);
  assert.equal(calls.length, 4, "同一项目不能在已有任务时重复入队");

  for (const resolve of released.splice(0)) resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 6);
  assert.equal(runtime.polling.snapshot().active, 2);
  assert.equal(runtime.polling.snapshot().queued, 0);

  for (const resolve of released.splice(0)) resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtime.polling.snapshot().active, 0);
  assert.equal(calls.length, 6);
});
