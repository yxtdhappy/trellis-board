import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { AgentApiClient } from "../agent/api.js";
import { ConfigStore } from "../agent/config-store.js";
import { normalizeRemoteIdentity } from "../agent/git-sync.js";
import { AgentLiveSync } from "../agent/live-sync.js";
import { createUser } from "../server/team/auth.js";
import { createTeamRuntime } from "../server/team/http.js";
import { setUserTeams } from "../server/team/teams.js";

const PUBLIC_ORIGIN = "http://127.0.0.1:4317";
const HOST = "127.0.0.1:4317";
const PASSWORD = "Realtime-Password-123";
const SILENT_LOGGER = { info() {}, warn() {}, error() {} };

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
  origin = PUBLIC_ORIGIN
} = {}) {
  const address = runtime.address();
  const requestHost = runtime.testHost || HOST;
  const requestOrigin = runtime.testOrigin || PUBLIC_ORIGIN;
  const payload = body == null ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const headers = { host: requestHost };
    if (payload != null) {
      headers["content-type"] = "application/json";
      headers["content-length"] = Buffer.byteLength(payload);
    }
    if (origin != null && method !== "GET" && method !== "HEAD") {
      headers.origin = origin === PUBLIC_ORIGIN ? requestOrigin : origin;
    }
    if (cookie) headers.cookie = cookie;
    if (agentCredential) headers.authorization = `Bearer ${agentCredential}`;
    const req = http.request({
      hostname: "127.0.0.1",
      port: address.port,
      path: pathname,
      method,
      headers
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
        resolve({ status: response.statusCode, headers: response.headers, body: json });
      });
    });
    req.on("error", reject);
    if (payload != null) req.write(payload);
    req.end();
  });
}

function cookieOf(response) {
  return String((response.headers["set-cookie"] || [])[0] || "").split(";")[0];
}

async function login(runtime, username) {
  return request(runtime, "/api/auth/login", {
    method: "POST",
    body: { username, password: PASSWORD }
  });
}

async function makeUser(runtime, username, teamId, role, { systemAdmin = false } = {}) {
  const user = await createUser(runtime.db, {
    username,
    displayName: username,
    password: PASSWORD,
    systemAdmin,
    mustChangePassword: false
  });
  setUserTeams(runtime.db, {
    userId: user.id,
    teams: [{ teamId, role }]
  });
  return user;
}

function seedTeam(runtime) {
  const now = new Date().toISOString();
  runtime.db.prepare(`
    INSERT INTO team(id, name, slug, status, created_at, updated_at)
    VALUES ('t-live', '实时团队', 'live-team', 'active', ?, ?)
  `).run(now, now);
}

function seedProject(runtime, root, owner, writer) {
  const now = new Date().toISOString();
  const repoPath = path.join(root, "projects", "p-live");
  const taskDir = path.join(repoPath, ".trellis", "tasks", "task-live");
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(repoPath, ".trellis", ".developer"), "name=owner\n");
  fs.writeFileSync(path.join(taskDir, "prd.md"), "# 实时任务\n");
  const initial = {
    id: "task-live",
    title: "初始标题",
    description: "实时同步测试",
    status: "planning",
    priority: "P2",
    assignee: "owner",
    creator: "owner",
    created_at: now
  };
  fs.writeFileSync(path.join(taskDir, "task.json"), `${JSON.stringify(initial, null, 2)}\n`);
  runtime.db.prepare(`
    INSERT INTO repositories(id, name, path, path_key, position, created_at, updated_at)
    VALUES ('p-live', '实时项目', ?, ?, 0, ?, ?)
  `).run(repoPath, repoPath.toLowerCase(), now, now);
  runtime.db.prepare(`
    INSERT INTO team_project(
      repository_id, team_id, workspace_key, remote_url, remote_identity_hash,
      sync_branch, trusted_task_toolchain_sha256, sync_status, created_at, updated_at
    ) VALUES ('p-live', 't-live', 'live-workspace', 'https://example.com/live.git', ?,
      'main', ?, 'current', ?, ?)
  `).run("f".repeat(64), "a".repeat(64), now, now);
  const addMember = runtime.db.prepare(`
    INSERT INTO project_member(
      project_id, user_id, role, trellis_dev_id, created_by, created_at, updated_at
    ) VALUES ('p-live', ?, ?, ?, ?, ?, ?)
  `);
  addMember.run(owner.id, "lead", "owner", owner.id, now, now);
  addMember.run(writer.id, "member", "writer", owner.id, now, now);
  return { repoPath, taskDir, initial };
}

async function enroll(runtime, username) {
  const session = await login(runtime, username);
  const cookie = cookieOf(session);
  const token = await request(runtime, "/api/desktop/enroll-tokens", {
    method: "POST",
    cookie,
    body: { deviceName: `${username}-device` }
  });
  assert.equal(token.status, 201);
  const enrolled = await request(runtime, "/api/agent/enroll-desktop", {
    method: "POST",
    origin: null,
    body: {
      token: token.body.token,
      deviceName: `${username}-device`,
      platform: "win32",
      agentVersion: "0.1.0",
      protocolVersion: 2
    }
  });
  assert.equal(enrolled.status, 201);
  return { cookie, ...enrolled.body };
}

async function bindRealtimeAgent(runtime, agent, localRepoKey = "b".repeat(64)) {
  const remoteIdentityKey = normalizeRemoteIdentity(
    "https://example.com/live.git"
  ).identityHash;
  return request(runtime, "/api/agent/heartbeat", {
    method: "POST",
    origin: null,
    agentCredential: agent.credential,
    body: {
      protocolVersion: 2,
      agentId: agent.agentId,
      agentVersion: "0.1.0",
      deviceName: "realtime-device",
      bindings: [{
        projectId: "p-live",
        localRepoKey,
        branchName: "main",
        remoteIdentityKey
      }]
    }
  });
}

function liveUpsert(relativePath, content) {
  return {
    path: relativePath,
    operation: "upsert",
    sha256: crypto.createHash("sha256").update(content).digest("hex"),
    content
  };
}

async function startRuntime(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-team-live-"));
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
  return { root, runtime };
}

async function freeLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return port;
}

async function startRuntimeWithRealOrigin(t) {
  const port = await freeLoopbackPort();
  const origin = `http://127.0.0.1:${port}`;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-team-live-e2e-"));
  const runtime = await createTeamRuntime({
    config: {
      ...testConfig(),
      port,
      publicUrl: new URL(origin),
      publicOrigin: origin
    },
    databaseFile: path.join(root, "data", "board.sqlite"),
    dataDir: path.join(root, "data"),
    logger: SILENT_LOGGER,
    requireAdmin: false,
    enablePolling: false
  });
  runtime.testOrigin = origin;
  runtime.testHost = `127.0.0.1:${port}`;
  await runtime.start();
  t.after(async () => {
    await runtime.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, runtime, origin };
}

async function waitForCondition(predicate, {
  timeoutMs = 8_000,
  intervalMs = 40
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw lastError || new Error("等待实时同步超时");
}

async function createLiveAgent({
  root,
  name,
  enrolled,
  binding,
  serverUrl,
  repoPath
}) {
  const store = new ConfigStore(path.join(root, `agent-${name}`));
  await store.ensureDirectories();
  const remoteIdentityKey = normalizeRemoteIdentity(
    "https://example.com/live.git"
  ).identityHash;
  const local = {
    localId: `local-${name}`,
    serverBindingId: binding.id,
    projectId: binding.projectId,
    repoPath,
    branchName: "main",
    teamId: binding.teamId,
    remoteIdentityKey,
    localRepoKey: binding.localRepoKey,
    displayName: name,
    createdAt: new Date().toISOString(),
    allowFileRemote: false,
    readOnly: false,
    syncStatus: "approved",
    lastSyncedAt: null,
    lastHead: null,
    lastError: null,
    lastErrorCode: null
  };
  const config = {
    schemaVersion: 1,
    revision: crypto.randomBytes(16).toString("hex"),
    serverUrl,
    agentId: enrolled.agentId,
    deviceName: `${name}-device`,
    username: name,
    teamId: null,
    teams: [{ id: binding.teamId, name: "实时团队", role: "member" }],
    protocolVersion: 2,
    agentVersion: "0.1.0",
    pairedAt: new Date().toISOString(),
    bindings: [local]
  };
  await store.saveConfig(config);
  const api = new AgentApiClient({
    serverUrl,
    credential: enrolled.credential
  });
  const sync = new AgentLiveSync({
    store,
    logger: SILENT_LOGGER,
    loadContext: async () => ({ config, api })
  });
  return { config, local, sync };
}

test("实时批次按文件版本广播，幂等重试不会重复写", async (t) => {
  const { root, runtime } = await startRuntime(t);
  seedTeam(runtime);
  const owner = await makeUser(runtime, "owner", "t-live", "member");
  const writer = await makeUser(runtime, "writer", "t-live", "member");
  const { repoPath, taskDir, initial } = seedProject(runtime, root, owner, writer);
  const project = {
    id: "p-live",
    name: "实时项目",
    path: repoPath,
    syncBranch: "main"
  };
  await runtime.services.taskIndex.scanAndIndexProject(project, { force: true });
  const writerAgent = await enroll(runtime, "writer");
  const ownerAgent = await enroll(runtime, "owner");
  const remoteIdentityKey = normalizeRemoteIdentity("https://example.com/live.git").identityHash;
  const ownerHeartbeat = await request(runtime, "/api/agent/heartbeat", {
    method: "POST",
    origin: null,
    agentCredential: ownerAgent.credential,
    body: {
      protocolVersion: 2,
      agentId: ownerAgent.agentId,
      agentVersion: "0.1.0",
      deviceName: "owner-device",
      bindings: [{
        projectId: "p-live",
        localRepoKey: "d".repeat(64),
        branchName: "main",
        remoteIdentityKey
      }]
    }
  });
  assert.equal(ownerHeartbeat.status, 200);
  assert.equal(ownerHeartbeat.body.bindings[0].status, "approved");
  const heartbeat = await request(runtime, "/api/agent/heartbeat", {
    method: "POST",
    origin: null,
    agentCredential: writerAgent.credential,
    body: {
      protocolVersion: 2,
      agentId: writerAgent.agentId,
      agentVersion: "0.1.0",
      deviceName: "writer-device",
      bindings: [{
        projectId: "p-live",
        localRepoKey: "b".repeat(64),
        branchName: "main",
        remoteIdentityKey
      }]
    }
  });
  assert.equal(heartbeat.status, 200);
  assert.equal(heartbeat.body.bindings[0].status, "approved");
  assert.equal(heartbeat.body.bindings[0].readOnly, false);

  const planWarning = await request(runtime, "/api/tasks/execution", {
    method: "PUT",
    cookie: writerAgent.cookie,
    body: {
      projectId: "p-live",
      taskPath: ".trellis/tasks/task-live",
      dueDate: null,
      milestone: "实时里程碑",
      tags: ["realtime"]
    }
  });
  assert.equal(planWarning.status, 409);
  assert.equal(planWarning.body.code, "ASSIGNEE_CONFIRMATION_REQUIRED");
  assert.equal(planWarning.body.details.assignee.username, "owner");
  const planContinued = await request(runtime, "/api/tasks/execution", {
    method: "PUT",
    cookie: writerAgent.cookie,
    body: {
      projectId: "p-live",
      taskPath: ".trellis/tasks/task-live",
      dueDate: null,
      milestone: "实时里程碑",
      tags: ["realtime"],
      assigneeDecision: {
        warningId: planWarning.body.details.warningId,
        action: "continue"
      }
    }
  });
  assert.equal(planContinued.status, 200);
  assert.equal(
    runtime.db.prepare(`
      SELECT COUNT(*) AS count FROM audit_event
      WHERE project_id = 'p-live'
        AND action = 'task_assignee_confirmation_continued'
    `).get().count,
    1
  );
  assert.equal(
    runtime.db.prepare(`
      SELECT COUNT(*) AS count FROM agent_event
      WHERE type = 'task.live.overridden' AND target_agent_id = ?
    `).get(ownerAgent.agentId).count,
    1
  );

  const nextTask = {
    ...initial,
    title: "实时标题",
    status: "in_progress"
  };
  const content = `${JSON.stringify(nextTask, null, 2)}\n`;
  const files = [{
    path: ".trellis/tasks/task-live/task.json",
    operation: "upsert",
    sha256: crypto.createHash("sha256").update(content).digest("hex"),
    content
  }];
  const batchId = "batch-live-0001";
  const preflight = await request(runtime, "/api/agent/live-changes/preflight", {
    method: "POST",
    origin: null,
    agentCredential: writerAgent.credential,
    body: { projectId: "p-live", files }
  });
  assert.equal(preflight.status, 200);
  assert.equal(preflight.body.requiresConfirmation, true);
  assert.equal(preflight.body.assignee.username, "owner");

  const applied = await request(runtime, "/api/agent/live-changes", {
    method: "POST",
    origin: null,
    agentCredential: writerAgent.credential,
    body: {
      projectId: "p-live",
      batchId,
      files,
      assigneeDecision: {
        warningId: preflight.body.warningId,
        action: "continue"
      }
    }
  });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.equal(applied.body.revision, 1);
  assert.equal(
    runtime.db.prepare(`
      SELECT COUNT(*) AS count FROM agent_event
      WHERE type = 'task.live.overridden' AND target_agent_id = ?
    `).get(ownerAgent.agentId).count,
    2
  );

  const replay = await request(runtime, "/api/agent/live-changes", {
    method: "POST",
    origin: null,
    agentCredential: writerAgent.credential,
    body: {
      projectId: "p-live",
      batchId,
      files,
      assigneeDecision: {
        warningId: preflight.body.warningId,
        action: "continue"
      }
    }
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.revision, 1);
  assert.equal(replay.body.replayed, true);
  const conflictingReplay = await request(runtime, "/api/agent/live-changes", {
    method: "POST",
    origin: null,
    agentCredential: writerAgent.credential,
    body: {
      projectId: "p-live",
      batchId,
      files: [{
        ...files[0],
        content: `${JSON.stringify({ ...nextTask, title: "不同内容" }, null, 2)}\n`,
        sha256: crypto.createHash("sha256").update(
          `${JSON.stringify({ ...nextTask, title: "不同内容" }, null, 2)}\n`
        ).digest("hex")
      }],
      assigneeDecision: {
        warningId: preflight.body.warningId,
        action: "continue"
      }
    }
  });
  assert.equal(conflictingReplay.status, 409);
  assert.equal(conflictingReplay.body.code, "IDEMPOTENCY_CONFLICT");

  const secondContent = "{\"id\":\"task-second\",\"title\":\"第二个任务\"}\n";
  const mixedTasks = await request(runtime, "/api/agent/live-changes", {
    method: "POST",
    origin: null,
    agentCredential: writerAgent.credential,
    body: {
      projectId: "p-live",
      batchId: "batch-mixed-tasks-0001",
      files: [
        files[0],
        {
          path: ".trellis/tasks/task-second/task.json",
          operation: "upsert",
          sha256: crypto.createHash("sha256").update(secondContent).digest("hex"),
          content: secondContent
        }
      ]
    }
  });
  assert.equal(mixedTasks.status, 400);
  assert.match(mixedTasks.body.error, /同一个任务/);

  const duplicatePaths = await request(runtime, "/api/agent/live-changes", {
    method: "POST",
    origin: null,
    agentCredential: writerAgent.credential,
    body: {
      projectId: "p-live",
      batchId: "batch-duplicate-path-0001",
      files: [files[0], files[0]]
    }
  });
  assert.equal(duplicatePaths.status, 400);
  assert.match(duplicatePaths.body.error, /重复/);

  const indexed = await request(runtime, "/api/tasks/query?teamId=t-live", {
    cookie: writerAgent.cookie
  });
  assert.equal(indexed.status, 200);
  const task = indexed.body.tasks.find((item) => item.taskKey === "p-live::.trellis/tasks/task-live");
  assert.ok(task, JSON.stringify(indexed.body));
  assert.equal(task.title, "实时标题");
  assert.ok(task.liveRevision >= 1);
  const detail = await request(runtime, "/api/task", {
    method: "POST",
    cookie: writerAgent.cookie,
    body: { executionTaskKey: task.executionTaskKey }
  });
  assert.equal(detail.status, 200, JSON.stringify(detail.body));
  assert.equal(detail.body.task.title, "实时标题");
  assert.equal(detail.body.task.artifacts.prd.content, "# 实时任务\n");
  const projectBoard = await request(runtime, "/api/board?projectId=p-live", {
    cookie: writerAgent.cookie
  });
  assert.equal(projectBoard.status, 200, JSON.stringify(projectBoard.body));
  assert.equal(
    projectBoard.body.tasks.find((item) => item.taskKey === task.taskKey).title,
    "实时标题"
  );

  const pull = await request(
    runtime,
    "/api/agent/live-files?projectId=p-live&afterRevision=0",
    { agentCredential: writerAgent.credential }
  );
  assert.equal(pull.status, 200);
  assert.equal(pull.body.revision, 1);
  assert.equal(pull.body.files[0].content, content);

  const revision = await request(runtime, "/api/team/live-revision?teamId=t-live", {
    cookie: writerAgent.cookie
  });
  assert.equal(revision.status, 200);
  assert.equal(revision.body.projects[0].revision, 1);
  assert.match(revision.body.revisionKey, /p-live:1/);
  assert.equal(
    fs.readFileSync(path.join(taskDir, "task.json"), "utf8"),
    `${JSON.stringify(initial, null, 2)}\n`
  );
  await runtime.services.taskIndex.scanAndIndexProject(project, { force: true });
  assert.equal(
    runtime.db.prepare(`
      SELECT title FROM team_task_index
      WHERE project_id = 'p-live' AND task_key = 'p-live::.trellis/tasks/task-live'
    `).get().title,
    "实时标题"
  );
  assert.equal(
    runtime.db.prepare(`
      SELECT COUNT(*) AS count FROM agent_event
      WHERE project_id = 'p-live' AND type = 'task.updated'
    `).get().count,
    0
  );

  const ownerPrd = "\ufeff# Owner 实时更新\n";
  const ownerPrdFiles = [{
    path: ".trellis/tasks/task-live/prd.md",
    operation: "upsert",
    sha256: crypto.createHash("sha256").update(ownerPrd).digest("hex"),
    content: ownerPrd
  }];
  const ownerPrdApplied = await request(runtime, "/api/agent/live-changes", {
    method: "POST",
    origin: null,
    agentCredential: ownerAgent.credential,
    body: {
      projectId: "p-live",
      batchId: "batch-owner-prd-0001",
      files: ownerPrdFiles
    }
  });
  assert.equal(ownerPrdApplied.status, 200, JSON.stringify(ownerPrdApplied.body));

  const ownerLatest = {
    ...nextTask,
    title: "Owner 最后写入",
    status: "in_review"
  };
  const ownerLatestContent = `${JSON.stringify(ownerLatest, null, 2)}\n`;
  const ownerTaskApplied = await request(runtime, "/api/agent/live-changes", {
    method: "POST",
    origin: null,
    agentCredential: ownerAgent.credential,
    body: {
      projectId: "p-live",
      batchId: "batch-owner-task-0001",
      files: [{
        path: ".trellis/tasks/task-live/task.json",
        operation: "upsert",
        sha256: crypto.createHash("sha256").update(ownerLatestContent).digest("hex"),
        content: ownerLatestContent
      }]
    }
  });
  assert.equal(ownerTaskApplied.status, 200, JSON.stringify(ownerTaskApplied.body));
  const latestFiles = await request(
    runtime,
    "/api/agent/live-files?projectId=p-live&afterRevision=0",
    { agentCredential: ownerAgent.credential }
  );
  assert.equal(latestFiles.status, 200);
  assert.equal(
    latestFiles.body.files.find((file) => file.path.endsWith("/prd.md")).content,
    ownerPrd
  );
  assert.equal(
    latestFiles.body.files.find((file) => file.path.endsWith("/task.json")).content,
    ownerLatestContent
  );

  const takeoverWarning = await request(runtime, "/api/tasks/execution", {
    method: "PUT",
    cookie: writerAgent.cookie,
    body: {
      projectId: "p-live",
      taskPath: ".trellis/tasks/task-live",
      dueDate: null,
      milestone: "接管后里程碑",
      tags: ["realtime"]
    }
  });
  assert.equal(takeoverWarning.status, 409);
  assert.equal(takeoverWarning.body.code, "ASSIGNEE_CONFIRMATION_REQUIRED");
  const takeover = await request(runtime, "/api/tasks/execution", {
    method: "PUT",
    cookie: writerAgent.cookie,
    body: {
      projectId: "p-live",
      taskPath: ".trellis/tasks/task-live",
      dueDate: null,
      milestone: "接管后里程碑",
      tags: ["realtime"],
      assigneeDecision: {
        warningId: takeoverWarning.body.details.warningId,
        action: "takeover"
      }
    }
  });
  assert.equal(takeover.status, 200);
  assert.equal(
    runtime.db.prepare(`
      SELECT COUNT(*) AS count FROM audit_event
      WHERE project_id = 'p-live'
        AND action IN ('task_assignee_confirmation_takeover', 'task_live_takeover')
    `).get().count,
    2
  );
  assert.equal(
    runtime.db.prepare(`
      SELECT assignee_user_id FROM team_task_index
      WHERE project_id = 'p-live' AND task_key = 'p-live::.trellis/tasks/task-live'
    `).get().assignee_user_id,
    writer.id
  );
  const canonical = runtime.db.prepare(`
    SELECT content_text FROM project_live_file
    WHERE project_id = 'p-live'
      AND relative_path = '.trellis/tasks/task-live/task.json'
  `).get().content_text;
  fs.writeFileSync(path.join(taskDir, "task.json"), canonical);
  fs.writeFileSync(path.join(taskDir, "prd.md"), ownerPrd);
  await runtime.services.taskIndex.scanAndIndexProject(project, { force: true });
  assert.equal(
    runtime.db.prepare(`
      SELECT COUNT(*) AS count FROM project_live_file WHERE project_id = 'p-live'
    `).get().count,
    0
  );
  assert.equal(
    runtime.db.prepare(`
      SELECT live_revision FROM team_task_index
      WHERE project_id = 'p-live'
    `).get().live_revision,
    0
  );
});

test("实时上报拒绝路径越界、无修改权限和未批准绑定", async (t) => {
  const { root, runtime } = await startRuntime(t);
  seedTeam(runtime);
  const owner = await makeUser(runtime, "owner2", "t-live", "member");
  const reader = await makeUser(
    runtime,
    "reader2",
    "t-live",
    "member",
    { systemAdmin: true }
  );
  seedProject(runtime, root, owner, reader);
  runtime.db.prepare(`
    UPDATE project_member
    SET role = 'read_only', trellis_dev_id = NULL
    WHERE project_id = 'p-live' AND user_id = ?
  `).run(reader.id);
  const agent = await enroll(runtime, "reader2");
  const remoteIdentityKey = normalizeRemoteIdentity("https://example.com/live.git").identityHash;
  const heartbeat = await request(runtime, "/api/agent/heartbeat", {
    method: "POST",
    origin: null,
    agentCredential: agent.credential,
    body: {
      protocolVersion: 2,
      agentId: agent.agentId,
      agentVersion: "0.1.0",
      deviceName: "reader-device",
      bindings: [{
        projectId: "p-live",
        localRepoKey: "c".repeat(64),
        branchName: "main",
        remoteIdentityKey
      }]
    }
  });
  assert.equal(heartbeat.body.bindings[0].readOnly, true);
  const files = [{
    path: "../outside.md",
    operation: "upsert",
    sha256: crypto.createHash("sha256").update("bad").digest("hex"),
    content: "bad"
  }];
  const denied = await request(runtime, "/api/agent/live-changes", {
    method: "POST",
    origin: null,
    agentCredential: agent.credential,
    body: { projectId: "p-live", batchId: "batch-reader-0001", files }
  });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, "FORBIDDEN");

  const readablePath = ".trellis/tasks/task-live/prd.md";
  const readableContent = "# 系统管理员也只读\n";
  const readonlyDenied = await request(runtime, "/api/agent/live-changes", {
    method: "POST",
    origin: null,
    agentCredential: agent.credential,
    body: {
      projectId: "p-live",
      batchId: "batch-readonly-admin-0001",
      files: [{
        path: readablePath,
        operation: "upsert",
        sha256: crypto.createHash("sha256").update(readableContent).digest("hex"),
        content: readableContent
      }]
    }
  });
  assert.equal(readonlyDenied.status, 403);
  assert.equal(readonlyDenied.body.code, "FORBIDDEN");
  assert.match(readonlyDenied.body.error, /只读/);

  const writer = await makeUser(runtime, "path-writer", "t-live", "member");
  const now = new Date().toISOString();
  runtime.db.prepare(`
    INSERT INTO project_member(
      project_id, user_id, role, trellis_dev_id, created_by, created_at, updated_at
    ) VALUES ('p-live', ?, 'member', 'path-writer', ?, ?, ?)
  `).run(writer.id, owner.id, now, now);
  const writerAgent = await enroll(runtime, "path-writer");
  const writerHeartbeat = await request(runtime, "/api/agent/heartbeat", {
    method: "POST",
    origin: null,
    agentCredential: writerAgent.credential,
    body: {
      protocolVersion: 2,
      agentId: writerAgent.agentId,
      agentVersion: "0.1.0",
      deviceName: "path-writer-device",
      bindings: [{
        projectId: "p-live",
        localRepoKey: "e".repeat(64),
        branchName: "main",
        remoteIdentityKey
      }]
    }
  });
  assert.equal(writerHeartbeat.status, 200);
  assert.equal(writerHeartbeat.body.bindings[0].status, "approved");

  const traversal = await request(runtime, "/api/agent/live-changes", {
    method: "POST",
    origin: null,
    agentCredential: writerAgent.credential,
    body: {
      projectId: "p-live",
      batchId: "batch-path-traversal-0001",
      files: [{
        path: "../outside.md",
        operation: "upsert",
        sha256: crypto.createHash("sha256").update("bad").digest("hex"),
        content: "bad"
      }]
    }
  });
  assert.equal(traversal.status, 400);
  assert.equal(traversal.body.code, "INVALID_INPUT");

  const oversized = "x".repeat(1024 * 1024 + 1);
  const tooLarge = await request(runtime, "/api/agent/live-changes", {
    method: "POST",
    origin: null,
    agentCredential: writerAgent.credential,
    body: {
      projectId: "p-live",
      batchId: "batch-oversized-file-0001",
      files: [{
        path: ".trellis/tasks/task-live/prd.md",
        operation: "upsert",
        sha256: crypto.createHash("sha256").update(oversized).digest("hex"),
        content: oversized
      }]
    }
  });
  assert.equal(tooLarge.status, 413);
  assert.equal(tooLarge.body.code, "BODY_TOO_LARGE");
});

test("clientSequence 防止同一 Agent 的乱序批次回退文件", async (t) => {
  const { root, runtime } = await startRuntime(t);
  seedTeam(runtime);
  const owner = await makeUser(runtime, "sequence-owner", "t-live", "member");
  const writer = await makeUser(runtime, "sequence-writer", "t-live", "member");
  const { repoPath } = seedProject(runtime, root, owner, writer);
  const project = {
    id: "p-live",
    name: "实时项目",
    path: repoPath,
    syncBranch: "main"
  };
  await runtime.services.taskIndex.scanAndIndexProject(project, { force: true });
  const agent = await enroll(runtime, "sequence-owner");
  const heartbeat = await bindRealtimeAgent(runtime, agent);
  assert.equal(heartbeat.status, 200);
  assert.equal(heartbeat.body.bindings[0].status, "approved");

  const newer = "{\"title\":\"sequence-newer\"}\n";
  const older = "{\"title\":\"sequence-older\"}\n";
  const newerFile = liveUpsert(".trellis/tasks/task-live/task.json", newer);
  const newerBatch = {
    projectId: "p-live",
    batchId: "batch-sequence-newer-0002",
    clientSequence: 2,
    files: [newerFile]
  };
  const applied = await request(runtime, "/api/agent/live-changes", {
    method: "POST",
    origin: null,
    agentCredential: agent.credential,
    body: newerBatch
  });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.equal(applied.body.revision, 1);

  const replayed = await request(runtime, "/api/agent/live-changes", {
    method: "POST",
    origin: null,
    agentCredential: agent.credential,
    body: newerBatch
  });
  assert.equal(replayed.status, 200, JSON.stringify(replayed.body));
  assert.equal(replayed.body.replayed, true);

  const hashConflict = await request(runtime, "/api/agent/live-changes", {
    method: "POST",
    origin: null,
    agentCredential: agent.credential,
    body: { ...newerBatch, clientSequence: 1 }
  });
  assert.equal(hashConflict.status, 409);
  assert.equal(hashConflict.body.code, "IDEMPOTENCY_CONFLICT");

  const stale = await request(runtime, "/api/agent/live-changes", {
    method: "POST",
    origin: null,
    agentCredential: agent.credential,
    body: {
      projectId: "p-live",
      batchId: "batch-sequence-older-0001",
      clientSequence: 1,
      files: [liveUpsert(".trellis/tasks/task-live/task.json", older)]
    }
  });
  assert.equal(stale.status, 200, JSON.stringify(stale.body));
  assert.equal(stale.body.stale, true);
  assert.equal(stale.body.revision, 1);
  assert.deepEqual(
    stale.body.skippedPaths,
    [".trellis/tasks/task-live/task.json"]
  );
  const latest = await request(
    runtime,
    "/api/agent/live-files?projectId=p-live&afterRevision=0",
    { agentCredential: agent.credential }
  );
  assert.equal(latest.status, 200);
  assert.equal(
    latest.body.files.find((file) => file.path.endsWith("/task.json")).content,
    newer
  );
});

test("实时覆盖只标记实际变化的任务", async (t) => {
  const { root, runtime } = await startRuntime(t);
  seedTeam(runtime);
  const owner = await makeUser(runtime, "marker-owner", "t-live", "member");
  const writer = await makeUser(runtime, "marker-writer", "t-live", "member");
  const { repoPath } = seedProject(runtime, root, owner, writer);
  const secondDir = path.join(repoPath, ".trellis", "tasks", "task-second");
  fs.mkdirSync(secondDir, { recursive: true });
  fs.writeFileSync(path.join(secondDir, "task.json"), `${JSON.stringify({
    id: "task-second",
    title: "第二个任务",
    description: "不应被标记",
    status: "planning",
    priority: "P2",
    assignee: "owner",
    creator: "owner",
    created_at: new Date().toISOString()
  }, null, 2)}\n`);
  const project = {
    id: "p-live",
    name: "实时项目",
    path: repoPath,
    syncBranch: "main"
  };
  await runtime.services.taskIndex.scanAndIndexProject(project, { force: true });
  const agent = await enroll(runtime, "marker-owner");
  const heartbeat = await bindRealtimeAgent(runtime, agent);
  assert.equal(heartbeat.status, 200);

  const content = "# 只改第一个任务\n";
  const applied = await request(runtime, "/api/agent/live-changes", {
    method: "POST",
    origin: null,
    agentCredential: agent.credential,
    body: {
      projectId: "p-live",
      batchId: "batch-marker-first-0001",
      clientSequence: 1,
      files: [liveUpsert(".trellis/tasks/task-live/prd.md", content)]
    }
  });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));

  const rows = runtime.db.prepare(`
    SELECT task_key, live_revision
    FROM team_task_index
    WHERE project_id = 'p-live'
    ORDER BY task_key
  `).all();
  const first = rows.find((row) => row.task_key.endsWith("/task-live"));
  const second = rows.find((row) => row.task_key.endsWith("/task-second"));
  assert.ok(first);
  assert.ok(second);
  assert.ok(Number(first.live_revision) > 0);
  assert.equal(Number(second.live_revision), 0);

  const query = await request(runtime, "/api/tasks/query?teamId=t-live", {
    cookie: agent.cookie
  });
  assert.equal(query.status, 200);
  assert.ok(
    query.body.tasks.find((task) => task.taskKey.endsWith("/task-live")).liveRevision > 0
  );
  assert.equal(
    query.body.tasks.find((task) => task.taskKey.endsWith("/task-second")).liveRevision,
    0
  );
});

test("未绑定 Agent 的原责任人可从浏览器读取覆盖通知", async (t) => {
  const { root, runtime } = await startRuntime(t);
  seedTeam(runtime);
  const owner = await makeUser(runtime, "notice-owner", "t-live", "member");
  const writer = await makeUser(runtime, "notice-writer", "t-live", "member");
  const { repoPath } = seedProject(runtime, root, owner, writer);
  const project = {
    id: "p-live",
    name: "实时项目",
    path: repoPath,
    syncBranch: "main"
  };
  await runtime.services.taskIndex.scanAndIndexProject(project, { force: true });
  const writerAgent = await enroll(runtime, "notice-writer");
  const heartbeat = await bindRealtimeAgent(runtime, writerAgent);
  assert.equal(heartbeat.status, 200);

  const files = [liveUpsert(
    ".trellis/tasks/task-live/prd.md",
    "# Writer 继续推进\n"
  )];
  const preflight = await request(runtime, "/api/agent/live-changes/preflight", {
    method: "POST",
    origin: null,
    agentCredential: writerAgent.credential,
    body: { projectId: "p-live", files }
  });
  assert.equal(preflight.status, 200, JSON.stringify(preflight.body));
  assert.equal(preflight.body.requiresConfirmation, true);
  const applied = await request(runtime, "/api/agent/live-changes", {
    method: "POST",
    origin: null,
    agentCredential: writerAgent.credential,
    body: {
      projectId: "p-live",
      batchId: "batch-browser-notice-0001",
      clientSequence: 1,
      files,
      assigneeDecision: {
        warningId: preflight.body.warningId,
        action: "continue"
      }
    }
  });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));

  const ownerLogin = await login(runtime, "notice-owner");
  const ownerCookie = cookieOf(ownerLogin);
  const browserRow = runtime.db.prepare(`
    SELECT target_agent_id, target_user_id
    FROM agent_event
    WHERE type = 'task.live.overridden'
      AND project_id = 'p-live'
      AND target_user_id = ?
      AND target_agent_id IS NULL
  `).get(owner.id);
  assert.ok(browserRow);

  const revision = await request(
    runtime,
    "/api/team/live-revision?teamId=t-live",
    { cookie: ownerCookie }
  );
  assert.equal(revision.status, 200, JSON.stringify(revision.body));
  const notice = revision.body.notifications.find((item) =>
    item.taskKey === "p-live::.trellis/tasks/task-live"
  );
  assert.ok(notice, JSON.stringify(revision.body));
  assert.equal(notice.taskTitle, "初始标题");
  assert.equal(notice.action, "continue");
  const writerRevision = await request(
    runtime,
    "/api/team/live-revision?teamId=t-live",
    { cookie: writerAgent.cookie }
  );
  assert.equal(writerRevision.status, 200);
  assert.equal(
    writerRevision.body.notifications.some((item) =>
      item.taskKey === "p-live::.trellis/tasks/task-live"
    ),
    false
  );
});

test("两个真实 Agent watcher 完成 Board 与本地文件同步，P95 不超过 3 秒", {
  timeout: 120_000
}, async (t) => {
  const { root, runtime, origin } = await startRuntimeWithRealOrigin(t);
  seedTeam(runtime);
  const owner = await makeUser(runtime, "sync-owner", "t-live", "member");
  const writer = await makeUser(runtime, "sync-writer", "t-live", "member");
  const { repoPath: canonicalRepo, taskDir: canonicalTaskDir } = seedProject(
    runtime,
    root,
    owner,
    writer
  );
  await runtime.services.taskIndex.scanAndIndexProject({
    id: "p-live",
    name: "实时项目",
    path: canonicalRepo,
    syncBranch: "main"
  }, { force: true });

  const ownerAgent = await enroll(runtime, "sync-owner");
  const writerAgent = await enroll(runtime, "sync-writer");
  const ownerKey = "1".repeat(64);
  const writerKey = "2".repeat(64);
  const ownerHeartbeat = await bindRealtimeAgent(runtime, ownerAgent, ownerKey);
  const writerHeartbeat = await bindRealtimeAgent(runtime, writerAgent, writerKey);
  assert.equal(ownerHeartbeat.status, 200, JSON.stringify(ownerHeartbeat.body));
  assert.equal(writerHeartbeat.status, 200, JSON.stringify(writerHeartbeat.body));
  const ownerBinding = ownerHeartbeat.body.bindings[0];
  const writerBinding = writerHeartbeat.body.bindings[0];
  assert.equal(ownerBinding.status, "approved");
  assert.equal(writerBinding.status, "approved");

  const ownerRepo = path.join(root, "client-owner", "repo");
  const writerRepo = path.join(root, "client-writer", "repo");
  fs.mkdirSync(ownerRepo, { recursive: true });
  fs.mkdirSync(writerRepo, { recursive: true });
  fs.cpSync(path.join(canonicalRepo, ".trellis"), path.join(ownerRepo, ".trellis"), {
    recursive: true
  });
  fs.cpSync(path.join(canonicalRepo, ".trellis"), path.join(writerRepo, ".trellis"), {
    recursive: true
  });

  const ownerClient = await createLiveAgent({
    root,
    name: "sync-owner",
    enrolled: ownerAgent,
    binding: ownerBinding,
    serverUrl: origin,
    repoPath: ownerRepo
  });
  const writerClient = await createLiveAgent({
    root,
    name: "sync-writer",
    enrolled: writerAgent,
    binding: writerBinding,
    serverUrl: origin,
    repoPath: writerRepo
  });
  await ownerClient.sync.start();
  await writerClient.sync.start();

  const streamAbort = new AbortController();
  let streamError = null;
  const streamPromise = new AgentApiClient({
    serverUrl: origin,
    credential: writerAgent.credential
  }).streamEvents({
    teamId: "t-live"
  }, {
    signal: streamAbort.signal,
    idleTimeoutMs: 60_000,
    onEvent: async (event) => {
      if (
        event.type === "live.changed" &&
        event.data?.projectId === "p-live"
      ) {
        await writerClient.sync.pullProject("t-live", "p-live");
      }
    }
  }).catch((error) => {
    if (!streamAbort.signal.aborted) streamError = error;
  });

  try {
    const ownerTaskPath = path.join(
      ownerRepo,
      ".trellis",
      "tasks",
      "task-live",
      "task.json"
    );
    const writerTaskPath = path.join(
      writerRepo,
      ".trellis",
      "tasks",
      "task-live",
      "task.json"
    );
    const samples = [];
    for (let index = 0; index < 20; index += 1) {
      const title = `实时同步-${index}-${crypto.randomUUID()}`;
      const taskJson = JSON.parse(fs.readFileSync(ownerTaskPath, "utf8"));
      fs.writeFileSync(ownerTaskPath, `${JSON.stringify({
        ...taskJson,
        title
      }, null, 2)}\n`);
      const startedAt = performance.now();
      await waitForCondition(async () => {
        if (streamError) throw streamError;
        const local = JSON.parse(fs.readFileSync(writerTaskPath, "utf8"));
        if (local.title !== title) return false;
        const detail = await request(runtime, "/api/task", {
          method: "POST",
          cookie: writerAgent.cookie,
          body: {
            projectId: "p-live",
            taskPath: ".trellis/tasks/task-live"
          }
        });
        return detail.status === 200 && detail.body?.task?.title === title;
      }, { timeoutMs: 8_000, intervalMs: 40 });
      samples.push(performance.now() - startedAt);
    }

    const sorted = [...samples].sort((left, right) => left - right);
    const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
    t.diagnostic(
      `实时同步 20 次样本 P95=${p95.toFixed(0)}ms ` +
      `max=${Math.max(...samples).toFixed(0)}ms`
    );
    assert.ok(p95 <= 3_000, `P95=${p95.toFixed(0)}ms samples=${samples.map(
      (value) => value.toFixed(0)
    ).join(",")}`);
    assert.equal(
      fs.readFileSync(
        path.join(canonicalTaskDir, "task.json"),
        "utf8"
      ).includes("初始标题"),
      true,
      "团队服务端不应直接写入 Git 工作副本"
    );
  } finally {
    ownerClient.sync.stop();
    writerClient.sync.stop();
    streamAbort.abort();
    await streamPromise.catch(() => {});
  }
});

