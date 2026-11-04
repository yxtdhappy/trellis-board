import assert from "node:assert/strict";
import { fork } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { withTransaction } from "../server/database.js";
import {
  createSession,
  hashPassword,
  SESSION_COOKIE
} from "../server/team/auth.js";
import { AGENT_PROTOCOL_VERSION } from "../server/team/agents.js";
import { createTeamRuntime } from "../server/team/http.js";

const TARGETS = Object.freeze({
  accounts: 400,
  webSessions: 200,
  projects: 100,
  tasks: 10_000,
  agents: 400
});
const WEB_WAVES = 3;
const POLL_INTERVAL_MS = 3_000;
const AGENT_POLL_INTERVAL_MS = 15_000;
const PUBLIC_ORIGIN = "http://127.0.0.1:4317";
const PUBLIC_HOST = "127.0.0.1:4317";
const REQUEST_TIMEOUT_MS = 60_000;
const WEB_P95_LIMIT_MS = 500;
const AGENT_P95_LIMIT_MS = 60_000;
const SCRIPT_FILE = fileURLToPath(import.meta.url);
const SILENT_LOGGER = {
  info() {},
  warn() {},
  error() {}
};

function teamConfig() {
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

function padded(index, width = 3) {
  return String(index).padStart(width, "0");
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function rounded(value) {
  return Number(Number(value).toFixed(2));
}

function percentile(sorted, value) {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * value) - 1)];
}

function latencySummary(values) {
  if (!values.length) return { count: 0, p50: null, p95: null, p99: null, max: null };
  const sorted = [...values].sort((left, right) => left - right);
  return {
    count: sorted.length,
    p50: rounded(percentile(sorted, 0.5)),
    p95: rounded(percentile(sorted, 0.95)),
    p99: rounded(percentile(sorted, 0.99)),
    max: rounded(sorted.at(-1))
  };
}

function eventLoopSummary(histogram) {
  return {
    p50: rounded(histogram.percentile(50) / 1e6),
    p95: rounded(histogram.percentile(95) / 1e6),
    p99: rounded(histogram.percentile(99) / 1e6),
    max: rounded(histogram.max / 1e6)
  };
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function createHttpClient(runtime) {
  const address = runtime.address();
  const connections = new Set();

  function createConnection() {
    const connection = {
      agent: new http.Agent({
        keepAlive: true,
        maxSockets: 1,
        maxFreeSockets: 1,
        scheduling: "fifo"
      })
    };
    connections.add(connection);
    return connection;
  }

  function request(pathname, {
    method = "GET",
    body = null,
    cookie = null,
    agentCredential = null,
    connection,
    headers = {}
  } = {}) {
    if (!connection) throw new Error("容量请求缺少持久连接");
    const payload = body == null ? null : JSON.stringify(body);
    const startedAt = performance.now();
    return new Promise((resolve, reject) => {
      const requestHeaders = {
        host: PUBLIC_HOST,
        "accept-encoding": "gzip",
        ...headers
      };
      if (payload != null) {
        requestHeaders["content-type"] = "application/json";
        requestHeaders["content-length"] = Buffer.byteLength(payload);
      }
      if (cookie) requestHeaders.cookie = cookie;
      if (agentCredential) {
        requestHeaders.authorization = `Bearer ${agentCredential}`;
      }
      const request = http.request({
        hostname: "127.0.0.1",
        port: address.port,
        path: pathname,
        method,
        headers: requestHeaders,
        agent: connection.agent
      }, (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const raw = Buffer.concat(chunks);
          const text = (
            response.headers["content-encoding"] === "gzip"
              ? gunzipSync(raw)
              : raw
          ).toString("utf8");
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
            body: parsed,
            durationMs: performance.now() - startedAt
          });
        });
      });
      request.setTimeout(REQUEST_TIMEOUT_MS, () => {
        request.destroy(new Error(`请求超过 ${REQUEST_TIMEOUT_MS}ms`));
      });
      request.on("error", reject);
      if (payload != null) request.write(payload);
      request.end();
    });
  }

  return {
    request,
    createConnection,
    close() {
      connections.forEach((connection) => connection.agent.destroy());
    }
  };
}

async function warmConnections(client, seed) {
  const connections = [
    ...seed.sessions.map((session) => session.connection),
    ...seed.agents.map((agent) => agent.connection)
  ];
  const batchSize = 50;
  for (let offset = 0; offset < connections.length; offset += batchSize) {
    const responses = await Promise.all(
      connections.slice(offset, offset + batchSize).map((connection) => (
        client.request("/api/health", { connection })
      ))
    );
    responses.forEach((response) => {
      assert.equal(response.status, 200, `连接预热 HTTP ${response.status}`);
    });
  }
  return connections.length;
}

async function seedCapacity(runtime, root) {
  const startedAt = performance.now();
  const now = new Date();
  const nowIso = now.toISOString();
  const password = await hashPassword("Capacity-Password-123");
  const userIds = Array.from(
    { length: TARGETS.accounts },
    (_, index) => `capacity-user-${padded(index + 1)}`
  );
  const webUsers = userIds.slice(0, TARGETS.webSessions);
  const sessions = [];
  const agents = [];
  const projectsRoot = path.join(root, "projects");
  fs.mkdirSync(projectsRoot, { recursive: true });

  withTransaction(runtime.db, () => {
    const insertUser = runtime.db.prepare(`
      INSERT INTO user_account(
        id, username_key, username, display_name, password_hash,
        password_params_json, system_admin, status, must_change_password,
        password_changed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 0, ?, ?, ?)
    `);
    userIds.forEach((userId, index) => {
      const username = `capacity-user-${padded(index + 1)}`;
      insertUser.run(
        userId,
        username,
        username,
        `容量用户 ${index + 1}`,
        password.hash,
        password.paramsJson,
        index === 0 ? 1 : 0,
        nowIso,
        nowIso,
        nowIso
      );
    });

    const insertRepository = runtime.db.prepare(`
      INSERT INTO repositories(
        id, name, path, path_key, position, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertProject = runtime.db.prepare(`
      INSERT INTO team_project(
        repository_id, workspace_key, remote_url, remote_identity_hash,
        sync_branch, trusted_task_toolchain_sha256, sync_status,
        last_fetch_at, last_push_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'main', ?, 'current', ?, ?, ?, ?)
    `);
    const insertCache = runtime.db.prepare(`
      INSERT INTO project_scan_cache(
        project_id, schema_version, scanned_content_key,
        scanned_branch_sha, saved_at, board_json
      ) VALUES (?, 1, ?, ?, ?, '{"tasks":[]}')
    `);
    const insertMember = runtime.db.prepare(`
      INSERT INTO project_member(
        project_id, user_id, role, trellis_dev_id,
        created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertTask = runtime.db.prepare(`
      INSERT INTO team_task_index(
        project_id, task_key, execution_task_key, relative_dir, title,
        search_text, archived, priority, derived_stage, assignee_dev_id,
        assignee_user_id, due_date, last_activity_at, is_blocked,
        is_unblocked_ready, attention_flags_json, group_key, group_role,
        task_version, board_version, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, 0, ?, 'implement', ?, ?,
        NULL, ?, 0, ?, '[]', ?, 'parent', ?, ?, ?
      )
    `);

    for (let projectIndex = 1; projectIndex <= TARGETS.projects; projectIndex += 1) {
      const projectId = `capacity-project-${padded(projectIndex)}`;
      const projectName = `容量项目 ${projectIndex}`;
      const projectPath = path.join(projectsRoot, projectId);
      const remoteUrl = `https://example.invalid/capacity/${projectId}.git`;
      const boardVersion = `capacity-board-${padded(projectIndex)}`;
      fs.mkdirSync(projectPath, { recursive: true });
      insertRepository.run(
        projectId,
        projectName,
        projectPath.replaceAll("\\", "/"),
        projectPath.replaceAll("\\", "/").toLowerCase(),
        projectIndex - 1,
        nowIso,
        nowIso
      );
      insertProject.run(
        projectId,
        `capacity-workspace-${padded(projectIndex)}`,
        remoteUrl,
        sha256(remoteUrl),
        sha256(`verified:${projectId}`),
        nowIso,
        nowIso,
        nowIso,
        nowIso
      );
      insertCache.run(
        projectId,
        boardVersion,
        sha256(`branch:${projectId}`),
        nowIso
      );

      webUsers.forEach((userId, userIndex) => {
        insertMember.run(
          projectId,
          userId,
          userIndex === 0 ? "lead" : "member",
          `dev-${padded(userIndex + 1)}`,
          userIds[0],
          nowIso,
          nowIso
        );
      });

      for (let taskIndex = 1; taskIndex <= TARGETS.tasks / TARGETS.projects; taskIndex += 1) {
        const offset = (projectIndex - 1) * 100 + taskIndex;
        const taskId = padded(taskIndex, 4);
        const taskKey = `${projectId}::.trellis/tasks/task-${taskId}`;
        const executionTaskKey = `${projectId}::task-${taskId}`;
        const assigneeIndex = (offset - 1) % webUsers.length;
        const lastActivityAt = new Date(
          now.getTime() - offset * 1_000
        ).toISOString();
        insertTask.run(
          projectId,
          taskKey,
          executionTaskKey,
          `.trellis/tasks/task-${taskId}`,
          `容量任务 ${projectIndex}-${taskId}`,
          `容量任务 ${projectIndex}-${taskId}\n${projectId}\nimplement`,
          ["P0", "P1", "P2", "P3"][offset % 4],
          `dev-${padded(assigneeIndex + 1)}`,
          webUsers[assigneeIndex],
          lastActivityAt,
          offset % 2,
          taskKey,
          `capacity-task-${padded(projectIndex)}-${taskId}`,
          boardVersion,
          nowIso
        );
      }
    }

    const insertAgent = runtime.db.prepare(`
      INSERT INTO agent_device(
        id, user_id, device_name, platform, agent_version, protocol_version,
        credential_hash, status, last_seen_at, created_at
      ) VALUES (?, ?, ?, 'win32', '1.0.0', ?, ?, 'active', ?, ?)
    `);
    for (let index = 1; index <= TARGETS.agents; index += 1) {
      const agentId = `capacity-agent-${padded(index)}`;
      const credential = crypto.randomBytes(32).toString("base64url");
      const owner = webUsers[Math.floor((index - 1) / 2)];
      insertAgent.run(
        agentId,
        owner,
        `容量设备 ${index}`,
        AGENT_PROTOCOL_VERSION,
        sha256(credential),
        nowIso,
        nowIso
      );
      agents.push({
        agentId,
        credential,
        deviceName: `容量设备 ${index}`
      });
    }

    webUsers.forEach((userId) => {
      const session = createSession(runtime.db, {
        userId,
        request: {
          headers: {
            "user-agent": "trellis-team-capacity-check"
          }
        },
        ip: "127.0.0.1"
      });
      sessions.push({
        userId,
        cookie: `${SESSION_COOKIE}=${encodeURIComponent(session.token)}`,
        statusEtag: null,
        etag: null
      });
    });
  });

  const counts = {
    accounts: Number(runtime.db.prepare(
      "SELECT COUNT(*) AS count FROM user_account"
    ).get().count),
    webSessions: Number(runtime.db.prepare(
      "SELECT COUNT(*) AS count FROM user_session"
    ).get().count),
    projects: Number(runtime.db.prepare(
      "SELECT COUNT(*) AS count FROM team_project WHERE sync_status = 'current'"
    ).get().count),
    tasks: Number(runtime.db.prepare(
      "SELECT COUNT(*) AS count FROM team_task_index WHERE archived = 0"
    ).get().count),
    agents: Number(runtime.db.prepare(
      "SELECT COUNT(*) AS count FROM agent_device WHERE status = 'active'"
    ).get().count),
    memberships: Number(runtime.db.prepare(
      "SELECT COUNT(*) AS count FROM project_member"
    ).get().count),
    passwordVariants: Number(runtime.db.prepare(
      "SELECT COUNT(DISTINCT password_params_json) AS count FROM user_account"
    ).get().count)
  };
  assert.equal(counts.accounts, TARGETS.accounts, "账号数量不符合目标");
  assert.equal(counts.webSessions, TARGETS.webSessions, "Web 会话数量不符合目标");
  assert.equal(counts.projects, TARGETS.projects, "项目数量不符合目标");
  assert.equal(counts.tasks, TARGETS.tasks, "任务快照数量不符合目标");
  assert.equal(counts.agents, TARGETS.agents, "Agent 数量不符合目标");
  assert.equal(
    counts.memberships,
    TARGETS.webSessions * TARGETS.projects,
    "项目成员数量不符合预期"
  );
  assert.equal(counts.passwordVariants, 1, "账号未复用固定 scrypt 参数");
  assert.equal(
    Object.values(runtime.db.prepare("PRAGMA integrity_check").get())[0],
    "ok",
    "容量库完整性检查失败"
  );

  return {
    sessions,
    agents,
    counts,
    seedMs: performance.now() - startedAt
  };
}

function startMemorySampler() {
  const maximum = {
    rss: 0,
    heapUsed: 0,
    external: 0,
    samples: 0
  };
  const sample = () => {
    const memory = process.memoryUsage();
    maximum.rss = Math.max(maximum.rss, memory.rss);
    maximum.heapUsed = Math.max(maximum.heapUsed, memory.heapUsed);
    maximum.external = Math.max(maximum.external, memory.external);
    maximum.samples += 1;
  };
  sample();
  const timer = setInterval(sample, 20);
  timer.unref?.();
  return {
    stop() {
      clearInterval(timer);
      sample();
      return {
        maxRssMiB: rounded(maximum.rss / 1024 / 1024),
        maxHeapUsedMiB: rounded(maximum.heapUsed / 1024 / 1024),
        maxExternalMiB: rounded(maximum.external / 1024 / 1024),
        samples: maximum.samples
      };
    }
  };
}

function instrumentRuntime(runtime) {
  const counts = {
    status: 0,
    queryTasks: 0,
    heartbeat: 0
  };
  const timings = {
    status: [],
    queryTasks: [],
    heartbeat: []
  };
  const measure = (name, callback) => {
    const startedAt = performance.now();
    try {
      return callback();
    } finally {
      timings[name].push(performance.now() - startedAt);
    }
  };
  const originalStatus = runtime.services.boardService.status;
  const originalQueryTasks = runtime.services.taskIndex.queryTasks;
  const originalHeartbeat = runtime.services.agentService.heartbeat;
  runtime.services.boardService.status = function status(...args) {
    counts.status += 1;
    return measure("status", () => originalStatus.apply(this, args));
  };
  runtime.services.taskIndex.queryTasks = function queryTasks(...args) {
    counts.queryTasks += 1;
    return measure("queryTasks", () => originalQueryTasks.apply(this, args));
  };
  runtime.services.agentService.heartbeat = function heartbeat(...args) {
    counts.heartbeat += 1;
    return measure("heartbeat", () => originalHeartbeat.apply(this, args));
  };
  return { counts, timings };
}

async function runBaseline(client, seed) {
  const session = seed.sessions[0];
  const status = await client.request("/api/team/status", {
    cookie: session.cookie,
    connection: session.connection
  });
  assert.equal(status.status, 200, `基线状态请求 HTTP ${status.status}`);
  assert.equal(status.body?.projects?.length, TARGETS.projects);

  const tasks = await client.request("/api/tasks/query?limit=100", {
    cookie: session.cookie,
    connection: session.connection
  });
  assert.equal(tasks.status, 200, `基线任务查询 HTTP ${tasks.status}`);
  assert.equal(tasks.body?.tasks?.length, 100);
  assert.equal(tasks.body?.total, TARGETS.tasks);

  const agent = seed.agents[0];
  const heartbeat = await client.request("/api/agent/heartbeat", {
    method: "POST",
    agentCredential: agent.credential,
    connection: agent.connection,
    body: {
      agentId: agent.agentId,
      protocolVersion: AGENT_PROTOCOL_VERSION,
      agentVersion: "1.0.0",
      deviceName: agent.deviceName,
      bindings: []
    }
  });
  assert.equal(heartbeat.status, 200, `基线心跳 HTTP ${heartbeat.status}`);
  assert.equal(heartbeat.body?.compatible, true);
  return {
    statusMs: rounded(status.durationMs),
    tasksMs: rounded(tasks.durationMs),
    heartbeatMs: rounded(heartbeat.durationMs)
  };
}

async function runLoad(client, seed) {
  const failures = [];
  let failureCount = 0;
  let sqliteBusyErrors = 0;
  const failureCodes = {};
  const addFailure = (kind, wave, error) => {
    failureCount += 1;
    const message = error instanceof Error ? error.message : String(error);
    const code = error?.code || error?.name || "Error";
    failureCodes[code] = (failureCodes[code] || 0) + 1;
    if (/SQLITE_BUSY|database is locked/i.test(message)) sqliteBusyErrors += 1;
    if (failures.length < 12) {
      failures.push({
        kind,
        wave,
        error: message
      });
    }
  };
  const latency = {
    status: [],
    tasks: [],
    heartbeat: [],
    waves: []
  };
  let taskResponses = 0;
  let notModifiedResponses = 0;
  let etagEligibleResponses = 0;
  let statusResponses = 0;
  let notModifiedStatusResponses = 0;
  let statusEtagEligibleResponses = 0;

  async function statusOnce(session, wave) {
    const headers = {};
    if (session.statusEtag) {
      headers["if-none-match"] = session.statusEtag;
      statusEtagEligibleResponses += 1;
    }
    const response = await client.request("/api/team/status", {
      cookie: session.cookie,
      connection: session.connection,
      headers
    });
    if (session.statusEtag) {
      assert.equal(response.status, 304, `状态轮询 HTTP ${response.status}`);
      notModifiedStatusResponses += 1;
    } else {
      assert.equal(response.status, 200, `状态轮询 HTTP ${response.status}`);
      assert.equal(response.body?.projects?.length, TARGETS.projects);
      assert.ok(response.headers.etag, "团队状态缺少 ETag");
      session.statusEtag = response.headers.etag;
      session.queryDay = response.body?.queryDay;
      statusResponses += 1;
    }
    latency.status.push(response.durationMs);
  }

  async function tasksOnce(session, wave) {
    const headers = {};
    const reusableEtag = session.etag && session.queryDay === session.etagDay;
    if (reusableEtag) {
      headers["if-none-match"] = session.etag;
      etagEligibleResponses += 1;
    }
    const response = await client.request("/api/tasks/query?limit=100", {
      cookie: session.cookie,
      connection: session.connection,
      headers
    });
    if (reusableEtag) {
      assert.equal(response.status, 304, `任务轮询 HTTP ${response.status}`);
      notModifiedResponses += 1;
    } else {
      assert.equal(response.status, 200, `任务查询 HTTP ${response.status}`);
      assert.equal(response.body?.tasks?.length, 100);
      assert.equal(response.body?.total, TARGETS.tasks);
      assert.ok(response.headers.etag, "任务查询缺少 ETag");
      session.etag = response.headers.etag;
      session.etagDay = response.body?.queryDay;
      taskResponses += 1;
    }
    latency.tasks.push(response.durationMs);
  }

  async function webSessionOnce(session, wave) {
    await statusOnce(session, wave);
    await tasksOnce(session, wave);
  }

  async function heartbeatOnce(agent) {
    const response = await client.request("/api/agent/heartbeat", {
      method: "POST",
      agentCredential: agent.credential,
      connection: agent.connection,
      body: {
        agentId: agent.agentId,
        protocolVersion: AGENT_PROTOCOL_VERSION,
        agentVersion: "1.0.0",
        deviceName: agent.deviceName,
        bindings: []
      }
    });
    assert.equal(response.status, 200, `Agent 心跳 HTTP ${response.status}`);
    assert.equal(response.body?.compatible, true);
    assert.deepEqual(response.body?.bindings, []);
    latency.heartbeat.push(response.durationMs);
  }

  const memorySampler = startMemorySampler();
  const eventLoop = monitorEventLoopDelay({ resolution: 10 });
  eventLoop.enable();
  eventLoop.reset();
  const cpuStartedAt = process.cpuUsage();
  const loadStartedAt = performance.now();

  const webWaves = Array.from({ length: WEB_WAVES }, (_, wave) => {
    const waveStartedAt = performance.now();
    return Promise.all(
      seed.sessions.map((session, index) => (
        sleep(index * (POLL_INTERVAL_MS / TARGETS.webSessions) +
          wave * POLL_INTERVAL_MS)
          .then(() => webSessionOnce(session, wave))
          .catch((error) => addFailure("web", wave, error))
      ))
    ).then(() => {
      latency.waves[wave] = performance.now() - waveStartedAt;
    });
  });
  const agentRound = Promise.all(
    seed.agents.map((agent, index) => (
      sleep(index * (AGENT_POLL_INTERVAL_MS / TARGETS.agents))
        .then(() => heartbeatOnce(agent))
        .catch((error) => addFailure("agent", 0, error))
    ))
  );
  await Promise.all([...webWaves, agentRound]);

  const loadMs = performance.now() - loadStartedAt;
  const cpuUsage = process.cpuUsage(cpuStartedAt);
  eventLoop.disable();
  const memory = memorySampler.stop();
  return {
    failures,
    failureCount,
    failureCodes,
    sqliteBusyErrors,
    latency,
    memory,
    loadMs,
    eventLoop: eventLoopSummary(eventLoop),
    cpuMs: {
      user: rounded(cpuUsage.user / 1_000),
      system: rounded(cpuUsage.system / 1_000)
    },
    taskResponses,
    notModifiedResponses,
    etagEligibleResponses,
    statusResponses,
    notModifiedStatusResponses,
    statusEtagEligibleResponses
  };
}

function databaseSizes(databaseFile) {
  const size = (file) => fs.existsSync(file) ? fs.statSync(file).size : 0;
  return {
    databaseBytes: size(databaseFile),
    walBytes: size(`${databaseFile}-wal`),
    shmBytes: size(`${databaseFile}-shm`)
  };
}

function runSeparateLoadClient(runtime, seed) {
  const child = fork(SCRIPT_FILE, ["--client"], {
    stdio: ["ignore", "ignore", "inherit", "ipc"],
    serialization: "json"
  });
  return new Promise((resolve, reject) => {
    let settled = false;
    let ready = null;
    let calls = null;
    let memorySampler = null;
    let eventLoop = null;
    let cpuStartedAt = null;
    let loadStartedAt = null;
    const timeout = setTimeout(() => {
      fail(new Error("独立容量客户端超过 180 秒"));
    }, 180_000);

    function cleanup() {
      clearTimeout(timeout);
      eventLoop?.disable();
    }

    function fail(error) {
      if (settled) return;
      settled = true;
      cleanup();
      memorySampler?.stop();
      child.kill();
      reject(error);
    }

    child.on("error", fail);
    child.on("exit", (code, signal) => {
      if (!settled) {
        fail(new Error(`独立容量客户端提前退出：code=${code} signal=${signal}`));
      }
    });
    child.on("message", (message) => {
      if (message?.type === "ready") {
        ready = message;
        calls = instrumentRuntime(runtime);
        memorySampler = startMemorySampler();
        eventLoop = monitorEventLoopDelay({ resolution: 10 });
        eventLoop.enable();
        eventLoop.reset();
        cpuStartedAt = process.cpuUsage();
        loadStartedAt = performance.now();
        child.send({ type: "start" });
        return;
      }
      if (message?.type === "error") {
        fail(new Error(message.error?.stack || message.error?.message || "容量客户端失败"));
        return;
      }
      if (message?.type !== "result") return;
      settled = true;
      cleanup();
      const load = message.load;
      load.loadMs = rounded(performance.now() - loadStartedAt);
      load.eventLoop = eventLoopSummary(eventLoop);
      load.memory = memorySampler.stop();
      const cpuUsage = process.cpuUsage(cpuStartedAt);
      load.cpuMs = {
        user: rounded(cpuUsage.user / 1_000),
        system: rounded(cpuUsage.system / 1_000)
      };
      resolve({
        baselineMs: ready.baselineMs,
        establishedConnections: ready.establishedConnections,
        calls,
        load
      });
    });
    child.send({ type: "seed", seed, port: runtime.address().port }, (error) => {
      if (error) fail(error);
    });
  });
}

async function runClientChild() {
  const message = await new Promise((resolve) => process.once("message", resolve));
  if (message?.type !== "seed") throw new Error("容量客户端缺少 seed 输入");
  const client = createHttpClient({
    address: () => ({ port: message.port })
  });
  const seed = message.seed;
  seed.sessions.forEach((session) => {
    session.connection = client.createConnection();
  });
  seed.agents.forEach((agent) => {
    agent.connection = client.createConnection();
  });
  try {
    const baselineMs = await runBaseline(client, seed);
    const establishedConnections = await warmConnections(client, seed);
    process.send({
      type: "ready",
      baselineMs,
      establishedConnections
    });
    const start = await new Promise((resolve) => process.once("message", resolve));
    if (start?.type !== "start") throw new Error("容量客户端缺少启动信号");
    const load = await runLoad(client, seed);
    await new Promise((resolve, reject) => {
      process.send({ type: "result", load }, (error) => (
        error ? reject(error) : resolve()
      ));
    });
  } finally {
    client.close();
  }
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-team-capacity-"));
  const dataDir = path.join(root, "data");
  const databaseFile = path.join(dataDir, "board.sqlite");
  let runtime = null;
  let report = null;

  try {
    runtime = await createTeamRuntime({
      config: teamConfig(),
      databaseFile,
      dataDir,
      logger: SILENT_LOGGER,
      requireAdmin: false,
      enablePolling: false,
      refreshConcurrency: 4
    });
    await runtime.start();
    const seed = await seedCapacity(runtime, dataDir);
    const clientRun = await runSeparateLoadClient(runtime, seed);
    const baselineMs = clientRun.baselineMs;
    const establishedConnections = clientRun.establishedConnections;
    const calls = clientRun.calls;
    const load = clientRun.load;
    const expected = {
      status: TARGETS.webSessions * WEB_WAVES,
      queryTasks: TARGETS.webSessions * WEB_WAVES,
      heartbeat: TARGETS.agents
    };
    const latency = {
      status: latencySummary(load.latency.status),
      tasks: latencySummary(load.latency.tasks),
      heartbeat: latencySummary(load.latency.heartbeat),
      wavesMs: load.latency.waves.map(rounded)
    };
    const checks = {
      targetCounts: true,
      allHttpRequestsSucceeded: load.failureCount === 0,
      taskQueryReachedIndex: calls.counts.queryTasks > 0,
      expectedServiceCalls:
        calls.counts.status === expected.status &&
        calls.counts.queryTasks === expected.queryTasks &&
        calls.counts.heartbeat === expected.heartbeat,
      etagNotModified:
        load.taskResponses === TARGETS.webSessions &&
        load.notModifiedResponses === load.etagEligibleResponses,
      statusEtagNotModified:
        load.statusResponses === TARGETS.webSessions &&
        load.notModifiedStatusResponses === load.statusEtagEligibleResponses,
      webStatusP95: latency.status.p95 != null &&
        latency.status.p95 <= WEB_P95_LIMIT_MS,
      webTasksP95: latency.tasks.p95 != null &&
        latency.tasks.p95 <= WEB_P95_LIMIT_MS,
      agentHeartbeatP95: latency.heartbeat.p95 != null &&
        latency.heartbeat.p95 <= AGENT_P95_LIMIT_MS,
      noSqliteBusyErrors: load.sqliteBusyErrors === 0
    };
    const pass = Object.values(checks).every(Boolean);
    report = {
      run: "team-capacity",
      verdict: pass ? "PASS" : "FAIL",
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      targets: TARGETS,
      workload: {
        webWaves: WEB_WAVES,
        pollIntervalMs: POLL_INTERVAL_MS,
        agentPollIntervalMs: AGENT_POLL_INTERVAL_MS,
        schedule: "staggered",
        statusStartSpacingMs: rounded(POLL_INTERVAL_MS / TARGETS.webSessions),
        heartbeatStartSpacingMs: rounded(AGENT_POLL_INTERVAL_MS / TARGETS.agents),
        statusRequests: expected.status,
        taskRequests: expected.queryTasks,
        heartbeatRequests: expected.heartbeat,
        membershipsPerWebUser: TARGETS.projects
      },
      seeded: seed.counts,
      connections: {
        established: establishedConnections
      },
      serviceCalls: calls.counts,
      serviceLatencyMs: {
        status: latencySummary(calls.timings.status),
        queryTasks: latencySummary(calls.timings.queryTasks),
        heartbeat: latencySummary(calls.timings.heartbeat)
      },
      latencyMs: latency,
      baselineMs,
      eventLoopDelayMs: load.eventLoop,
      memory: load.memory,
      cpuMs: load.cpuMs,
      durationMs: {
        seed: rounded(seed.seedMs),
        load: rounded(load.loadMs)
      },
      database: databaseSizes(databaseFile),
      http: {
        failedRequests: load.failureCount,
        failureCodes: load.failureCodes,
        firstPageResponses: load.taskResponses,
        notModifiedResponses: load.notModifiedResponses,
        etagEligibleResponses: load.etagEligibleResponses,
        statusResponses: load.statusResponses,
        notModifiedStatusResponses: load.notModifiedStatusResponses,
        statusEtagEligibleResponses: load.statusEtagEligibleResponses,
        sqliteBusyErrors: load.sqliteBusyErrors,
        sampleErrors: load.failures
      },
      thresholdsMs: {
        webP95: WEB_P95_LIMIT_MS,
        agentHeartbeatP95: AGENT_P95_LIMIT_MS
      },
      checks
    };
  } catch (error) {
    report = {
      run: "team-capacity",
      verdict: "FAIL",
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      targets: TARGETS,
      error: {
        name: error?.name || "Error",
        code: error?.code || null,
        message: error instanceof Error ? error.message : String(error)
      }
    };
  } finally {
    if (runtime) {
      try {
        await runtime.stop();
      } catch (error) {
        report ||= {
          run: "team-capacity",
          verdict: "FAIL",
          targets: TARGETS
        };
        report.cleanupError = error instanceof Error ? error.message : String(error);
        report.verdict = "FAIL";
      }
    }
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      if (report) report.tempDirectoryRemoved = true;
    } catch (error) {
      report ||= {
        run: "team-capacity",
        verdict: "FAIL",
        targets: TARGETS
      };
      report.cleanupError = error instanceof Error ? error.message : String(error);
      report.verdict = "FAIL";
      report.tempDirectoryRemoved = false;
    }
  }

  console.log(JSON.stringify(report));
  const message = report.verdict === "PASS"
    ? "PASS：目标规模请求全部成功，Web p95 未超过 500ms。"
    : "FAIL：容量门槛未通过，查看 checks、latencyMs 和 http.sampleErrors。";
  console.log(`结论：${message}`);
  process.exitCode = report.verdict === "PASS" ? 0 : 1;
}

if (path.resolve(process.argv[1] || "") === path.resolve(SCRIPT_FILE)) {
  if (process.argv.includes("--client")) {
    await runClientChild();
  } else {
    await main();
  }
}
