import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { normalizeRemoteIdentity } from "../agent/git-sync.js";
import { createUser } from "../server/team/auth.js";
import { createTeamRuntime } from "../server/team/http.js";
import { setUserTeams } from "../server/team/teams.js";

const PUBLIC_ORIGIN = "http://127.0.0.1:4317";
const HOST = "127.0.0.1:4317";
const SILENT_LOGGER = { info() {}, warn() {}, error() {} };
const PASSWORD = "Isolation-Password-123";

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
  const payload = body == null ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const headers = { host: HOST };
    if (payload != null) {
      headers["content-type"] = "application/json";
      headers["content-length"] = Buffer.byteLength(payload);
    }
    if (origin != null && method !== "GET" && method !== "HEAD") headers.origin = origin;
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

async function makeUser(runtime, username, { systemAdmin = false, teams = [] } = {}) {
  const user = await createUser(runtime.db, {
    username,
    displayName: username,
    password: PASSWORD,
    systemAdmin,
    mustChangePassword: false
  });
  if (teams.length) {
    setUserTeams(runtime.db, { userId: user.id, teams });
  }
  return user;
}

function seedTeam(runtime, teamId, name = teamId) {
  const now = new Date().toISOString();
  runtime.db.prepare(`
    INSERT INTO team(id, name, slug, status, created_at, updated_at)
    VALUES (?, ?, ?, 'active', ?, ?)
  `).run(teamId, name, teamId, now, now);
}

function seedProject(runtime, root, {
  projectId,
  teamId,
  userId,
  role = "lead",
  developerId = "alice"
}) {
  const now = new Date().toISOString();
  const repositoryPath = path.join(root, "projects", projectId);
  fs.mkdirSync(repositoryPath, { recursive: true });
  runtime.db.prepare(`
    INSERT INTO repositories(id, name, path, path_key, position, created_at, updated_at)
    VALUES (?, ?, ?, ?, 0, ?, ?)
  `).run(projectId, projectId, repositoryPath, repositoryPath.toLowerCase(), now, now);
  runtime.db.prepare(`
    INSERT INTO team_project(
      repository_id, team_id, workspace_key, remote_url, remote_identity_hash,
      sync_branch, trusted_task_toolchain_sha256, sync_status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'main', ?, 'current', ?, ?)
  `).run(
    projectId,
    teamId,
    `${projectId}-workspace`,
    `https://example.com/${projectId}.git`,
    "f".repeat(64),
    "a".repeat(64),
    now,
    now
  );
  runtime.db.prepare(`
    INSERT INTO project_member(
      project_id, user_id, role, trellis_dev_id, created_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(projectId, userId, role, role === "read_only" ? null : developerId, userId, now, now);
}

function seedTasks(runtime, projectId, count) {
  const insert = runtime.db.prepare(`
    INSERT INTO team_task_index(
      project_id, task_key, execution_task_key, relative_dir, title,
      search_text, archived, priority, derived_stage, assignee_dev_id,
      assignee_user_id, due_date, last_activity_at, is_blocked,
      is_unblocked_ready, attention_flags_json, group_key, group_role,
      task_version, board_version, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, 0, 'P2', 'implement', 'alice',
      NULL, NULL, ?, 0, 1, '[]', ?, 'parent', ?, 'board-1', ?
    )
  `);
  for (let index = 1; index <= count; index += 1) {
    const taskKey = `${projectId}::.trellis/tasks/task-${index}`;
    const activity = new Date(Date.UTC(2026, 10, 3, 0, index, 0)).toISOString();
    insert.run(
      projectId,
      taskKey,
      `${projectId}::task-${index}`,
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

async function startRuntime(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-team-isolation-"));
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
  const admin = await makeUser(runtime, "sysadmin", { systemAdmin: true });
  const adminLogin = await login(runtime, "sysadmin");
  return { root, runtime, admin, adminCookie: cookieOf(adminLogin) };
}

test("团队 CRUD、活动团队切换与跨团队读写隔离", async (t) => {
  const { root, runtime, adminCookie } = await startRuntime(t);
  const teamA = (await request(runtime, "/api/admin/teams", {
    method: "POST",
    cookie: adminCookie,
    body: { name: "团队 A", slug: "team-a" }
  })).body.team;
  const teamB = (await request(runtime, "/api/admin/teams", {
    method: "POST",
    cookie: adminCookie,
    body: { name: "团队 B", slug: "team-b" }
  })).body.team;
  assert.ok(teamA.id && teamB.id);

  const both = await makeUser(runtime, "both", {
    teams: [
      { teamId: teamA.id, role: "member" },
      { teamId: teamB.id, role: "member" }
    ]
  });
  const outsider = await makeUser(runtime, "outsider", {
    teams: [{ teamId: teamB.id, role: "member" }]
  });
  await makeUser(runtime, "team-admin", {
    teams: [{ teamId: teamA.id, role: "admin" }]
  });
  seedProject(runtime, root, { projectId: "p-a", teamId: teamA.id, userId: both.id });
  seedProject(runtime, root, { projectId: "p-b", teamId: teamB.id, userId: both.id });
  seedTasks(runtime, "p-a", 2);
  seedTasks(runtime, "p-b", 2);

  const bothCookie = cookieOf(await login(runtime, "both"));
  const runtimeA = await request(runtime, "/api/runtime", { cookie: bothCookie });
  assert.equal(runtimeA.status, 200);
  assert.equal(runtimeA.body.activeTeamId, teamA.id);
  assert.deepEqual(runtimeA.body.teams.map((team) => team.id), [teamA.id, teamB.id]);
  const projectsA = await request(runtime, "/api/team/projects", { cookie: bothCookie });
  assert.deepEqual(projectsA.body.projects.map((project) => project.id), ["p-a"]);
  assert.equal((await request(runtime, "/api/projects/p-a/members", {
    method: "PUT",
    cookie: adminCookie,
    body: { userId: outsider.id, role: "member", trellisDevId: "outsider" }
  })).status, 400);
  assert.equal((await request(runtime, "/api/tasks/p-b::.trellis/tasks/task-1", {
    cookie: bothCookie
  })).status, 404);

  assert.equal((await request(runtime, "/api/board?projectId=p-b", {
    cookie: bothCookie
  })).status, 404);
  assert.equal((await request(runtime, "/api/tasks/query?projectIds=p-b", {
    cookie: bothCookie
  })).status, 403);
  assert.equal((await request(runtime, "/api/projects/p-b/members", {
    cookie: bothCookie
  })).status, 404);

  const savedA = await request(runtime, "/api/saved-views", {
    method: "POST",
    cookie: bothCookie,
    body: { name: "A 视图", filter: { blocked: "blocked" } }
  });
  assert.equal(savedA.status, 201);
  const switchedB = await request(runtime, "/api/auth/team", {
    method: "POST",
    cookie: bothCookie,
    body: { teamId: teamB.id }
  });
  assert.equal(switchedB.status, 200);
  assert.equal((await request(runtime, "/api/runtime", { cookie: bothCookie })).body.activeTeamId, teamB.id);
  assert.deepEqual(
    (await request(runtime, "/api/saved-views", { cookie: bothCookie })).body.views,
    []
  );
  assert.equal((await request(runtime, "/api/saved-views", {
    method: "PUT",
    cookie: bothCookie,
    body: { id: savedA.body.view.id, name: "越权改", filter: { blocked: "blocked" } }
  })).body.code, "INVALID_INPUT");

  assert.equal((await request(runtime, "/api/board/settings", {
    method: "PUT",
    cookie: bothCookie,
    body: { executionWipLimit: 5 }
  })).status, 200);

  const pageA = await request(runtime, "/api/tasks/query?limit=1&projectIds=p-b", {
    cookie: bothCookie
  });
  assert.equal(pageA.status, 200);
  assert.ok(pageA.body.nextCursor);
  await request(runtime, "/api/auth/team", {
    method: "POST",
    cookie: bothCookie,
    body: { teamId: teamA.id }
  });
  assert.equal((await request(runtime, "/api/board/settings", {
    method: "PUT",
    cookie: bothCookie,
    body: { executionWipLimit: 3 }
  })).status, 200);
  const crossCursor = await request(
    runtime,
    `/api/tasks/query?limit=1&cursor=${encodeURIComponent(pageA.body.nextCursor)}`,
    { cookie: bothCookie }
  );
  assert.equal(crossCursor.status, 409);
  assert.equal(crossCursor.body.code, "CURSOR_INVALID");
  assert.equal(crossCursor.body.recoverable, true);

  const adminCookieForTeam = cookieOf(await login(runtime, "team-admin"));
  const adminProjects = await request(runtime, "/api/admin/projects", {
    cookie: adminCookieForTeam
  });
  assert.equal(adminProjects.status, 200);
  assert.deepEqual(adminProjects.body.projects.map((project) => project.id), ["p-a"]);
  const teamUsers = await request(runtime, "/api/admin/users", {
    cookie: adminCookieForTeam
  });
  assert.equal(teamUsers.status, 200);
  assert.deepEqual(
    teamUsers.body.users.map((user) => user.username),
    ["both", "team-admin"]
  );
  assert.deepEqual(
    teamUsers.body.users.find((user) => user.username === "both").teams.map((team) => team.id),
    [teamA.id]
  );
  assert.equal((await request(runtime, "/api/admin/users", {
    cookie: bothCookie
  })).status, 403);
  assert.equal((await request(runtime, "/api/admin/teams", {
    method: "POST",
    cookie: adminCookieForTeam,
    body: { name: "越权团队" }
  })).status, 403);
  const teamAudit = await request(runtime, "/api/admin/audit", {
    cookie: adminCookieForTeam
  });
  assert.equal(teamAudit.status, 200);
  assert.ok(teamAudit.body.events.length > 0);
  assert.ok(teamAudit.body.events.every((event) => event.teamId === teamA.id));

  assert.equal((await request(runtime, "/api/auth/team", {
    method: "POST",
    cookie: adminCookieForTeam,
    body: { teamId: teamB.id }
  })).status, 403);
  assert.equal((await request(runtime, "/api/auth/team", {
    method: "POST",
    cookie: adminCookieForTeam,
    body: { teamId: "missing-team" }
  })).status, 403);
  assert.equal((await request(runtime, "/api/admin/projects", {
    method: "POST",
    cookie: adminCookieForTeam,
    body: {
      teamId: teamB.id,
      name: "越权项目",
      remoteUrl: "https://example.com/forbidden.git",
      syncBranch: "main"
    }
  })).status, 403);
  assert.equal((await request(runtime, "/api/admin/projects", {
    method: "POST",
    cookie: bothCookie,
    body: {
      teamId: teamA.id,
      name: "成员越权项目",
      remoteUrl: "https://example.com/member-forbidden.git",
      syncBranch: "main"
    }
  })).status, 403);

  const adminTeamA = await request(runtime, "/api/auth/team", {
    method: "POST",
    cookie: adminCookie,
    body: { teamId: teamA.id }
  });
  assert.equal(adminTeamA.status, 200);
  assert.equal(adminTeamA.body.activeTeamId, teamA.id);
  assert.deepEqual(
    (await request(runtime, "/api/admin/projects", { cookie: adminCookie }))
      .body.projects.map((project) => project.id),
    ["p-a"]
  );
  const adminAllTeams = await request(runtime, "/api/auth/team", {
    method: "POST",
    cookie: adminCookie,
    body: { teamId: "" }
  });
  assert.equal(adminAllTeams.status, 200);
  assert.equal(adminAllTeams.body.activeTeamId, null);

  const orphan = await request(runtime, "/api/admin/users", {
    method: "POST",
    cookie: adminCookie,
    body: {
      username: "orphan",
      displayName: "Orphan",
      password: "Orphan-Password-123",
      teams: [{ teamId: "missing-team", role: "member" }]
    }
  });
  assert.equal(orphan.status, 404);
  assert.equal((await request(runtime, "/api/admin/users", { cookie: adminCookie }))
    .body.users.some((user) => user.username === "orphan"), false);

  const allProjects = await request(runtime, "/api/admin/projects", {
    cookie: adminCookie
  });
  assert.deepEqual(
    allProjects.body.projects.map((project) => project.id).sort(),
    ["p-a", "p-b"]
  );
  const auditB = await request(runtime, `/api/admin/audit?teamId=${teamB.id}`, {
    cookie: adminCookie
  });
  assert.ok(auditB.body.events.every((event) => event.teamId === teamB.id));

  assert.equal(runtime.db.prepare(`
    SELECT COUNT(*) AS count FROM user_board_state WHERE user_id = ?
  `).get(both.id).count, 2);
  const removeB = await request(runtime, `/api/admin/users/${both.id}/teams`, {
    method: "PUT",
    cookie: adminCookie,
    body: { teams: [{ teamId: teamA.id, role: "member" }] }
  });
  assert.equal(removeB.status, 200);
  assert.equal((await request(runtime, "/api/auth/team", {
    method: "POST",
    cookie: bothCookie,
    body: { teamId: teamB.id }
  })).status, 403);
  const stateRows = runtime.db.prepare(`
    SELECT team_id FROM user_board_state WHERE user_id = ? ORDER BY team_id
  `).all(both.id);
  assert.deepEqual(stateRows.map((row) => row.team_id), [teamA.id]);
});

test("Agent 绑定、审计与团队成员移除按团队隔离并清理", async (t) => {
  const { root, runtime, adminCookie } = await startRuntime(t);
  seedTeam(runtime, "t1", "团队一");
  seedTeam(runtime, "t2", "团队二");
  const agentUser = await makeUser(runtime, "agent-user", {
    teams: [{ teamId: "t1", role: "member" }]
  });
  const teamAdmin = await makeUser(runtime, "t1-admin", {
    teams: [{ teamId: "t1", role: "admin" }]
  });
  const reader = await makeUser(runtime, "reader", {
    teams: [{ teamId: "t1", role: "member" }]
  });
  const otherAdmin = await makeUser(runtime, "t2-admin", {
    teams: [{ teamId: "t2", role: "admin" }]
  });
  seedProject(runtime, root, {
    projectId: "p1",
    teamId: "t1",
    userId: agentUser.id,
    role: "member",
    developerId: "bob"
  });
  const readerJoinedAt = new Date().toISOString();
  runtime.db.prepare(`
    INSERT INTO project_member(
      project_id, user_id, role, trellis_dev_id, created_by, created_at, updated_at
    ) VALUES ('p1', ?, 'read_only', NULL, ?, ?, ?)
  `).run(reader.id, reader.id, readerJoinedAt, readerJoinedAt);
  seedProject(runtime, root, {
    projectId: "p2",
    teamId: "t2",
    userId: otherAdmin.id
  });

  const agentCookie = cookieOf(await login(runtime, "agent-user"));
  const pairing = await request(runtime, "/api/team/pairing-codes", {
    method: "POST",
    cookie: agentCookie,
    body: {}
  });
  assert.equal(pairing.status, 201);
  assert.equal(pairing.body.teamId, "t1");
  const enrolled = await request(runtime, "/api/agent/enroll", {
    method: "POST",
    origin: null,
    body: {
      protocolVersion: 2,
      agentVersion: "1.0.0",
      platform: "win32",
      pairingCode: pairing.body.pairingCode,
      deviceName: "隔离测试设备"
    }
  });
  assert.equal(enrolled.status, 201);
  const heartbeat = await request(runtime, "/api/agent/heartbeat", {
    method: "POST",
    origin: null,
    agentCredential: enrolled.body.credential,
    body: {
      protocolVersion: 2,
      agentId: enrolled.body.agentId,
      agentVersion: "1.0.0",
      deviceName: "隔离测试设备",
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
  const bindingId = heartbeat.body.bindings[0].bindingId;
  assert.equal(
    runtime.db.prepare("SELECT team_id FROM agent_project_binding WHERE id = ?")
      .get(bindingId).team_id,
    "t1"
  );

  assert.equal((await request(runtime, "/api/agent/event-cursor?teamId=t1", {
    agentCredential: enrolled.body.credential
  })).status, 200);
  const savedCursor = await request(runtime, "/api/agent/event-cursor", {
    method: "PUT",
    agentCredential: enrolled.body.credential,
    body: { teamId: "t1", lastEventId: 7 }
  });
  assert.equal(savedCursor.status, 200);
  assert.equal(savedCursor.body.lastEventId, 7);
  assert.equal((await request(runtime, "/api/agent/event-cursor?teamId=t2", {
    agentCredential: enrolled.body.credential
  })).status, 403);

  assert.equal((await request(
    runtime,
    `/api/projects/p1/agents/${bindingId}/approve`,
    {
      method: "POST",
      cookie: cookieOf(await login(runtime, "t2-admin")),
      body: {}
    }
  )).status, 404);

  const approved = await request(
    runtime,
    `/api/projects/p1/agents/${bindingId}/approve`,
    {
      method: "POST",
      cookie: cookieOf(await login(runtime, "t1-admin")),
      body: {}
    }
  );
  assert.equal(approved.status, 200);
  const visibleMembers = await request(runtime, "/api/projects/p1/members", {
    cookie: cookieOf(await login(runtime, "t1-admin"))
  });
  assert.ok(visibleMembers.body.members.some((member) => member.username === "reader"));
  const teamAudit = await request(runtime, "/api/admin/audit", {
    cookie: cookieOf(await login(runtime, "t1-admin"))
  });
  assert.ok(teamAudit.body.events.some((event) => (
    event.action === "agent_binding_approved" && event.teamId === "t1"
  )));

  const removed = await request(runtime, `/api/admin/users/${agentUser.id}/teams`, {
    method: "PUT",
    cookie: adminCookie,
    body: { teams: [] }
  });
  assert.equal(removed.status, 200);
  assert.equal(runtime.db.prepare(`
    SELECT COUNT(*) AS count FROM team_member WHERE user_id = ?
  `).get(agentUser.id).count, 0);
  assert.equal(runtime.db.prepare(`
    SELECT COUNT(*) AS count FROM project_member WHERE user_id = ?
  `).get(agentUser.id).count, 0);
  assert.equal(runtime.db.prepare(`
    SELECT COUNT(*) AS count FROM agent_project_binding WHERE agent_id = ?
  `).get(enrolled.body.agentId).count, 0);
  assert.equal(runtime.db.prepare(`
    SELECT COUNT(*) AS count FROM agent_event_cursor WHERE agent_id = ?
  `).get(enrolled.body.agentId).count, 0);
  const sessionTeam = runtime.db.prepare(`
    SELECT active_team_id FROM user_session WHERE user_id = ?
  `).get(agentUser.id);
  assert.equal(sessionTeam.active_team_id, null);

  const removedAudit = await request(runtime, "/api/admin/audit?teamId=t1", {
    cookie: adminCookie
  });
  assert.ok(removedAudit.body.events.some((event) => (
    event.action === "team_member_removed" && event.targetId === agentUser.id
  )));
  assert.equal(runtime.db.prepare("SELECT COUNT(*) AS count FROM team_member WHERE user_id = ?")
    .get(teamAdmin.id).count, 1);
});
