import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { normalizeRemoteIdentity, syncRepository } from "../agent/git-sync.js";
import { AGENT_ERROR_CODE } from "../agent/protocol.js";
import { createUser } from "../server/team/auth.js";
import { createTeamRuntime } from "../server/team/http.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_ORIGIN = "http://127.0.0.1:4317";
const HOST = "127.0.0.1:4317";
const SILENT_LOGGER = {
  info() {},
  warn() {},
  error() {}
};

test("真实 Git 仓库完成团队任务创建、推送、接受和 Agent 快进同步", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-team-release-"));
  let runtime = null;
  t.after(async () => {
    if (runtime) await runtime.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const bare = path.join(root, "remote.git");
  const seed = path.join(root, "seed");
  const local = path.join(root, "local");
  const remoteUrl = pathToFileURL(bare).href;
  const hooksDir = path.join(root, "agent-hooks");
  const scriptsSource = path.join(REPO_ROOT, ".trellis", "scripts");
  const scriptsTarget = path.join(seed, ".trellis", "scripts");

  git(root, ["init", "--bare", "--initial-branch=dev", bare]);
  fs.mkdirSync(seed);
  git(seed, ["init", "--initial-branch=dev"]);
  git(seed, ["config", "user.name", "Release Test"]);
  git(seed, ["config", "user.email", "release-test@example.invalid"]);

  fs.cpSync(scriptsSource, scriptsTarget, {
    recursive: true,
    filter(source) {
      const segments = path.relative(scriptsSource, source).split(path.sep);
      return !segments.includes("__pycache__") && !/\.(?:pyc|pyo)$/i.test(source);
    }
  });
  write(
    path.join(seed, ".trellis", "config.yaml"),
    "session_auto_commit: false\n"
  );
  write(path.join(seed, ".trellis", "workspace", "alice", "index.md"), "# alice\n");
  write(path.join(seed, ".trellis", "workspace", "bob", "index.md"), "# bob\n");
  write(path.join(seed, ".trellis", "tasks", ".keep"), "tasks\n");
  write(path.join(seed, "README.md"), "release integration fixture\n");
  git(seed, ["add", "--", "."]);
  git(seed, ["commit", "-m", "seed release project"]);
  git(seed, ["remote", "add", "origin", remoteUrl]);
  git(seed, ["push", "-u", "origin", "dev"]);

  const initialHead = git(bare, ["rev-parse", "dev"]).stdout.trim();
  git(root, ["clone", "--branch", "dev", remoteUrl, local]);
  fs.mkdirSync(hooksDir, { recursive: true });

  runtime = await createTeamRuntime({
    config: {
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
      allowLocalGitRemotes: true
    },
    databaseFile: path.join(root, "data", "board.sqlite"),
    dataDir: path.join(root, "data"),
    logger: SILENT_LOGGER,
    requireAdmin: false,
    enablePolling: false
  });
  await runtime.start();

  await createUser(runtime.db, {
    username: "admin",
    displayName: "系统管理员",
    password: "Admin-Password-123",
    systemAdmin: true,
    mustChangePassword: false
  });
  const adminCookie = await login(runtime, "admin", "Admin-Password-123");
  const team = (await request(runtime, "/api/admin/teams", {
    method: "POST",
    cookie: adminCookie,
    body: { name: "Release Team", slug: "release-team" }
  })).body.team;

  const alice = await createUserThroughHttp(runtime, adminCookie, {
    username: "alice",
    displayName: "Alice",
    password: "Alice-Password-123"
  });
  const bob = await createUserThroughHttp(runtime, adminCookie, {
    username: "bob",
    displayName: "Bob",
    password: "Bob-Password-123"
  });
  for (const user of [alice, bob]) {
    const assigned = await request(runtime, `/api/admin/users/${user.id}/teams`, {
      method: "PUT",
      cookie: adminCookie,
      body: { teams: [{ teamId: team.id, role: "member" }] }
    });
    assert.equal(assigned.status, 200);
  }
  const aliceCookie = await login(runtime, "alice", "Alice-Password-123");
  const bobCookie = await login(runtime, "bob", "Bob-Password-123");

  const connected = await request(runtime, "/api/admin/projects", {
    method: "POST",
    cookie: adminCookie,
    body: {
      teamId: team.id,
      name: "Release integration",
      remoteUrl,
      syncBranch: "dev"
    }
  });
  assert.equal(connected.status, 201);
  const projectId = connected.body.project.id;
  assert.ok(projectId);

  const approved = await request(
    runtime,
    `/api/admin/projects/${projectId}/approve`,
    {
      method: "POST",
      cookie: adminCookie,
      body: {
        toolchainSha256: connected.body.approval.toolchainSha256,
        leadUserId: alice.id,
        leadTrellisDevId: "alice"
      }
    }
  );
  assert.equal(approved.status, 200);
  assert.equal(approved.body.project.syncStatus, "current");

  const member = await request(runtime, `/api/projects/${projectId}/members`, {
    method: "PUT",
    cookie: adminCookie,
    body: {
      userId: bob.id,
      role: "member",
      trellisDevId: "bob"
    }
  });
  assert.equal(member.status, 200);
  assert.deepEqual(
    member.body.members.map((item) => item.trellisDevId).sort(),
    ["alice", "bob"]
  );

  const created = await request(runtime, "/api/tasks", {
    method: "POST",
    cookie: aliceCookie,
    body: {
      projectId,
      title: "Release integration task",
      description: "Verify the real Git task publishing path.",
      priority: "P2",
      slug: "good",
      assigneeUserId: bob.id,
      idempotencyKey: "release-good-0001"
    }
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.status, "applied");
  const createdTaskDir = created.body.result?.relativeDir;
  assert.match(createdTaskDir, /^\.trellis\/tasks\/\d{2}-\d{2}-good$/);

  const remoteHead = git(bare, ["rev-parse", "dev"]).stdout.trim();
  assert.notEqual(remoteHead, initialHead);
  assert.equal(created.body.remoteCommitSha, remoteHead);

  const remoteTaskJson = JSON.parse(git(bare, [
    "show",
    `${remoteHead}:${createdTaskDir}/task.json`
  ]).stdout);
  assert.equal(remoteTaskJson.assignee, "bob");
  assert.equal(remoteTaskJson.branch, "dev");
  assert.equal(remoteTaskJson.base_branch, null);

  const commitMessage = git(bare, ["log", "-1", "--format=%B", remoteHead]).stdout;
  assert.match(commitMessage, /Trellis-Operation:\s+[0-9a-f-]{36}/i);
  assert.match(commitMessage, new RegExp(`Trellis-Operation:\\s+${created.body.id}`, "i"));

  const remotePaths = git(bare, [
    "ls-tree",
    "-r",
    "--name-only",
    remoteHead
  ]).stdout.trim().split(/\r?\n/).filter(Boolean);
  assert.equal(
    remotePaths.some((entry) =>
      entry.split("/").includes("__pycache__") || /\.(?:pyc|pyo)$/i.test(entry)
    ),
    false,
    "远端任务提交不能包含 Python 字节码缓存"
  );

  const assignments = await request(runtime, "/api/assignments?state=pending", {
    cookie: bobCookie
  });
  assert.equal(assignments.status, 200);
  assert.equal(assignments.body.tasks.length, 1);
  const pending = assignments.body.tasks[0];
  assert.equal(pending.assignment.state, "pending");
  assert.equal(pending.assignment.assignedUserId, bob.id);

  const accepted = await request(runtime, "/api/tasks/accept", {
    method: "POST",
    cookie: bobCookie,
    body: {
      executionTaskKey: pending.executionTaskKey,
      assignmentVersion: pending.assignmentVersion
    }
  });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.assignment.state, "accepted");

  const expectedRemoteIdentity = normalizeRemoteIdentity(remoteUrl, {
    allowFileRemote: true
  }).identityHash;
  const synced = await syncRepository({
    repoPath: local,
    branchName: "dev",
    hooksDir,
    expectedRemoteIdentity,
    allowFileRemote: true
  });
  assert.equal(synced.head, remoteHead);
  assert.equal(git(local, ["rev-parse", "HEAD"]).stdout.trim(), remoteHead);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(
      path.join(local, createdTaskDir, "task.json"),
      "utf8"
    )),
    remoteTaskJson
  );

  const dirtyFile = path.join(local, "agent-dirty.txt");
  write(dirtyFile, "keep this local change\n");
  await assert.rejects(
    () => syncRepository({
      repoPath: local,
      branchName: "dev",
      hooksDir,
      expectedRemoteIdentity,
      allowFileRemote: true
    }),
    (error) => error.code === AGENT_ERROR_CODE.LOCAL_DIRTY
  );
  assert.equal(fs.readFileSync(dirtyFile, "utf8"), "keep this local change\n");
  assert.equal(git(local, ["rev-parse", "HEAD"]).stdout.trim(), remoteHead);

  const reassigned = await request(runtime, "/api/tasks/assign", {
    method: "POST",
    cookie: aliceCookie,
    body: {
      executionTaskKey: created.body.result.executionTaskKey,
      assigneeUserId: alice.id,
      expectedTaskVersion: created.body.result.taskVersion,
      idempotencyKey: "release-reassign-0001"
    }
  });
  assert.equal(reassigned.status, 200, JSON.stringify(reassigned.body));
  const reassignedHead = git(bare, ["rev-parse", "dev"]).stdout.trim();
  assert.equal(reassigned.body.remoteCommitSha, reassignedHead);
  const reassignedTask = JSON.parse(git(bare, [
    "show",
    `${reassignedHead}:${createdTaskDir}/task.json`
  ]).stdout);
  assert.equal(reassignedTask.assignee, "alice");

  const stale = await request(runtime, "/api/tasks/assign", {
    method: "POST",
    cookie: aliceCookie,
    body: {
      executionTaskKey: created.body.result.executionTaskKey,
      assigneeUserId: bob.id,
      expectedTaskVersion: created.body.result.taskVersion,
      idempotencyKey: "release-stale-0001"
    }
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, "VERSION_CONFLICT");
  assert.equal(git(bare, ["rev-parse", "dev"]).stdout.trim(), reassignedHead);

  const rejectPush = path.join(bare, "hooks", "pre-receive");
  write(rejectPush, "#!/bin/sh\nexit 1\n");
  fs.chmodSync(rejectPush, 0o755);
  const failedPush = await request(runtime, "/api/tasks/assign", {
    method: "POST",
    cookie: aliceCookie,
    body: {
      executionTaskKey: created.body.result.executionTaskKey,
      assigneeUserId: bob.id,
      expectedTaskVersion: reassigned.body.result.taskVersion,
      idempotencyKey: "release-push-failure-0001"
    }
  });
  assert.equal(failedPush.status, 503);
  assert.equal(failedPush.body.code, "GIT_REMOTE_FAILED");
  assert.equal(failedPush.body.recoverable, true);
  const failedOperationId = failedPush.body.details?.operationId;
  assert.ok(failedOperationId);
  const pendingProjects = await request(runtime, "/api/team/projects", {
    cookie: aliceCookie
  });
  assert.equal(pendingProjects.status, 200);
  assert.equal(
    pendingProjects.body.projects.find((project) => project.id === projectId)?.syncStatus,
    "pending_push"
  );
  assert.equal(git(bare, ["rev-parse", "dev"]).stdout.trim(), reassignedHead);

  fs.rmSync(rejectPush, { force: true });
  const retried = await request(
    runtime,
    `/api/git-operations/${failedOperationId}/retry`,
    {
      method: "POST",
      cookie: aliceCookie,
      body: {}
    }
  );
  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  assert.equal(retried.body.operation.status, "applied");
  const recoveredHead = git(bare, ["rev-parse", "dev"]).stdout.trim();
  assert.notEqual(recoveredHead, reassignedHead);
  assert.equal(
    retried.body.operation.remoteCommitSha,
    recoveredHead,
    JSON.stringify(retried.body)
  );
  const recoveredTask = JSON.parse(git(bare, [
    "show",
    `${recoveredHead}:${createdTaskDir}/task.json`
  ]).stdout);
  assert.equal(recoveredTask.assignee, "bob");
});

function request(runtime, pathname, {
  method = "GET",
  body = null,
  cookie = null
} = {}) {
  const payload = body == null ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const requestHeaders = { host: HOST };
    if (payload != null) {
      requestHeaders["content-type"] = "application/json";
      requestHeaders["content-length"] = Buffer.byteLength(payload);
    }
    if (method !== "GET" && method !== "HEAD") {
      requestHeaders.origin = PUBLIC_ORIGIN;
    }
    if (cookie) requestHeaders.cookie = cookie;

    const req = http.request({
      hostname: "127.0.0.1",
      port: runtime.address().port,
      path: pathname,
      method,
      headers: requestHeaders
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed = null;
        if (text) {
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = text;
          }
        }
        resolve({
          status: response.statusCode,
          headers: response.headers,
          body: parsed
        });
      });
    });
    req.on("error", reject);
    if (payload != null) req.write(payload);
    req.end();
  });
}

async function login(runtime, username, password) {
  const response = await request(runtime, "/api/auth/login", {
    method: "POST",
    body: { username, password }
  });
  assert.equal(response.status, 200);
  return String((response.headers["set-cookie"] || [])[0] || "").split(";")[0];
}

async function createUserThroughHttp(runtime, adminCookie, user) {
  const response = await request(runtime, "/api/admin/users", {
    method: "POST",
    cookie: adminCookie,
    body: {
      ...user,
      systemAdmin: false,
      mustChangePassword: false
    }
  });
  assert.equal(response.status, 201);
  return response.body.user;
}

function git(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    shell: false,
    env: process.env
  });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} 失败：${result.stderr || result.stdout}`
    );
  }
  return result;
}

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}
