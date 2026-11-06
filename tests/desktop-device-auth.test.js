import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createUser } from "../server/team/auth.js";
import { createTeamRuntime } from "../server/team/http.js";
import {
  enrollWithToken,
  validateEnrollToken
} from "../desktop/sidecar/desktop-device.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_ORIGIN = "http://127.0.0.1:4317";
const SILENT_LOGGER = { info() {}, warn() {}, error() {} };

function readText(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function readJson(relativePath) {
  return JSON.parse(readText(relativePath));
}

function testConfig(origin = PUBLIC_ORIGIN, port = 0) {
  return {
    mode: "team",
    bindHost: "127.0.0.1",
    port,
    publicUrl: new URL(origin),
    publicOrigin: origin,
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
  origin = undefined,
  contentType = "application/json",
  authorization = null
} = {}) {
  const address = runtime.address();
  const currentOrigin = runtime.testOrigin || PUBLIC_ORIGIN;
  const originUrl = new URL(currentOrigin);
  const payload = body == null ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const headers = { host: originUrl.host };
    if (payload != null) {
      headers["content-type"] = contentType;
      headers["content-length"] = Buffer.byteLength(payload);
    }
    const actualOrigin = origin === undefined ? currentOrigin : origin;
    if (method !== "GET" && method !== "HEAD" && actualOrigin !== null) {
      headers.origin = actualOrigin;
    }
    if (cookie) headers.cookie = cookie;
    if (authorization) headers.authorization = authorization;
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

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function startRuntime(t, { desktopAuth, users = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-desktop-auth-"));
  const port = await freePort();
  const serverUrl = `http://127.0.0.1:${port}`;
  const runtime = await createTeamRuntime({
    config: testConfig(serverUrl, port),
    databaseFile: path.join(root, "data", "board.sqlite"),
    dataDir: path.join(root, "data"),
    logger: SILENT_LOGGER,
    requireAdmin: false,
    enablePolling: false,
    ...(desktopAuth ? { desktopAuth } : {})
  });
  await runtime.start();
  runtime.testOrigin = serverUrl;
  t.after(async () => {
    await runtime.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const sysadmin = await createUser(runtime.db, {
    username: "sysadmin",
    displayName: "系统管理员",
    password: "Legacy-Password-123",
    systemAdmin: true,
    mustChangePassword: false
  });
  const created = new Map();
  for (const user of users) {
    const row = await createUser(runtime.db, {
      password: "Legacy-Password-123",
      mustChangePassword: false,
      ...user
    });
    created.set(user.username, row);
  }
  const login = await request(runtime, "/api/auth/login", {
    method: "POST",
    body: { username: "sysadmin", password: "Legacy-Password-123" }
  });
  assert.equal(login.status, 200);
  return {
    runtime,
    adminCookie: cookieOf(login),
    sysadminId: sysadmin.id,
    users: created,
    serverUrl
  };
}

async function login(runtime, username, password = "Legacy-Password-123") {
  const response = await request(runtime, "/api/auth/login", {
    method: "POST",
    body: { username, password }
  });
  assert.equal(response.status, 200);
  return cookieOf(response);
}

async function issueToken(runtime, cookie, body = {}) {
  return request(runtime, "/api/desktop/enroll-tokens", {
    method: "POST",
    cookie,
    body
  });
}

function redeem(runtime, token, overrides = {}) {
  return request(runtime, "/api/agent/enroll-desktop", {
    method: "POST",
    body: {
      token,
      deviceName: "Windows 桌面",
      platform: "win32",
      agentVersion: "0.1.0",
      protocolVersion: 2,
      ...overrides
    }
  });
}

async function withTempRoot(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("签发设备令牌要求登录会话、JSON 与同源 Origin", async (t) => {
  const { runtime, adminCookie } = await startRuntime(t);

  const anonymous = await request(runtime, "/api/desktop/enroll-tokens", {
    method: "POST",
    body: {}
  });
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.body.code, "AUTH_REQUIRED");

  const noOrigin = await request(runtime, "/api/desktop/enroll-tokens", {
    method: "POST",
    cookie: adminCookie,
    body: {},
    origin: null
  });
  assert.equal(noOrigin.status, 403);
  assert.equal(noOrigin.body.code, "CSRF_REJECTED");

  const wrongOrigin = await request(runtime, "/api/desktop/enroll-tokens", {
    method: "POST",
    cookie: adminCookie,
    body: {},
    origin: "https://evil.example.com"
  });
  assert.equal(wrongOrigin.status, 403);
  assert.equal(wrongOrigin.body.code, "CSRF_REJECTED");

  const signedIn = await issueToken(runtime, adminCookie, { deviceName: " 开发机 " });
  assert.equal(signedIn.status, 201);
  assert.match(signedIn.body.token, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(Date.parse(signedIn.body.expiresAt) > Date.now());
  assert.deepEqual(Object.keys(signedIn.body).sort(), ["expiresAt", "token"]);
});

test("设备令牌只能兑换一次并签发可用凭证", async (t) => {
  const { runtime, adminCookie, sysadminId } = await startRuntime(t);
  const issued = await issueToken(runtime, adminCookie, { deviceName: "开发机" });
  assert.equal(issued.status, 201);

  const enrolled = await redeem(runtime, issued.body.token);
  assert.equal(enrolled.status, 201);
  assert.match(enrolled.body.agentId, /^[A-Za-z0-9-]{8,64}$/);
  assert.match(enrolled.body.credential, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(enrolled.body.protocolVersion, 2);

  const device = runtime.db.prepare("SELECT * FROM agent_device WHERE id = ?")
    .get(enrolled.body.agentId);
  assert.equal(device.status, "active");
  assert.equal(device.user_id, sysadminId);
  assert.equal(device.device_name, "开发机");
  assert.notEqual(device.credential_hash, enrolled.body.credential);

  const audit = runtime.db.prepare(`
    SELECT action, detail_json FROM audit_event
    WHERE action = 'desktop_device_enrolled'
  `).get();
  assert.ok(audit, "缺少 desktop_device_enrolled 审计");
  const detail = JSON.parse(audit.detail_json);
  assert.equal(detail.deviceId, enrolled.body.agentId);
  assert.equal(detail.userId, sysadminId);
  assert.equal(detail.source, "desktop_enroll_token");

  const heartbeat = await request(runtime, "/api/agent/heartbeat", {
    method: "POST",
    body: {
      agentId: enrolled.body.agentId,
      protocolVersion: 2,
      agentVersion: "0.1.0",
      platform: "win32",
      deviceName: "开发机"
    },
    cookie: null,
    authorization: `Bearer ${enrolled.body.credential}`
  });
  assert.equal(heartbeat.status, 200);
  assert.equal(heartbeat.body.protocolVersion, 2);
  assert.equal(heartbeat.body.compatible, true);

  const devices = await request(runtime, "/api/admin/agents", { cookie: adminCookie });
  assert.equal(devices.status, 200);
  assert.ok(devices.body.agents.some((item) => item.id === enrolled.body.agentId));

  const replay = await redeem(runtime, issued.body.token);
  assert.equal(replay.status, 401);
  assert.equal(replay.body.code, "DESKTOP_TOKEN_INVALID");
  assert.match(replay.body.error, /已使用/);
});

test("过期令牌返回 401 且不创建设备", async (t) => {
  let clock = Date.now();
  const ttlMs = 60_000;
  const { runtime, adminCookie } = await startRuntime(t, {
    desktopAuth: { now: () => clock, ttlMs }
  });
  const issued = await issueToken(runtime, adminCookie);
  assert.equal(issued.status, 201);
  clock += ttlMs + 1;

  const expired = await redeem(runtime, issued.body.token);
  assert.equal(expired.status, 401);
  assert.equal(expired.body.code, "DESKTOP_TOKEN_INVALID");
  assert.match(expired.body.error, /已过期/);

  const count = runtime.db.prepare("SELECT COUNT(*) AS total FROM agent_device").get();
  assert.equal(count.total, 0);
});

test("无效、已撤销会话与禁用用户分别被拒绝", async (t) => {
  const { runtime, adminCookie, users } = await startRuntime(t, {
    users: [
      { username: "disabled-user", displayName: "禁用用户" },
      { username: "pending-user", displayName: "待改密用户", mustChangePassword: true }
    ]
  });

  const invalid = await redeem(runtime, "x".repeat(43));
  assert.equal(invalid.status, 401);
  assert.equal(invalid.body.code, "DESKTOP_TOKEN_INVALID");

  // 会话 Cookie 不能被当作令牌使用：兑换端点完全不读取 Cookie。
  const cookieOnly = await request(runtime, "/api/agent/enroll-desktop", {
    method: "POST",
    cookie: adminCookie,
    body: { protocolVersion: 2 }
  });
  assert.equal(cookieOnly.status, 401);
  assert.equal(cookieOnly.body.code, "DESKTOP_TOKEN_INVALID");

  const disabledCookie = await login(runtime, "disabled-user");
  const disabledIssued = await issueToken(runtime, disabledCookie);
  assert.equal(disabledIssued.status, 201);
  runtime.db.prepare("UPDATE user_account SET status = 'disabled' WHERE id = ?")
    .run(users.get("disabled-user").id);
  const disabled = await redeem(runtime, disabledIssued.body.token);
  assert.equal(disabled.status, 403);
  assert.equal(disabled.body.code, "FORBIDDEN");
  assert.match(disabled.body.error, /禁用/);

  const pendingCookie = await login(runtime, "pending-user");
  const pending = await issueToken(runtime, pendingCookie);
  assert.equal(pending.status, 403);
  assert.equal(pending.body.code, "PASSWORD_CHANGE_REQUIRED");

  const stillUsable = await issueToken(runtime, adminCookie);
  assert.equal(stillUsable.status, 201);
});

test("同一用户未使用的设备令牌上限为 5，已使用令牌不占额度", async (t) => {
  const { runtime, adminCookie } = await startRuntime(t);
  const tokens = [];
  for (let index = 0; index < 5; index += 1) {
    const response = await issueToken(runtime, adminCookie);
    assert.equal(response.status, 201);
    tokens.push(response.body.token);
  }
  const limited = await issueToken(runtime, adminCookie);
  assert.equal(limited.status, 429);
  assert.equal(limited.body.code, "RATE_LIMITED");

  const enrolled = await redeem(runtime, tokens[0]);
  assert.equal(enrolled.status, 201);
  const afterUse = await issueToken(runtime, adminCookie);
  assert.equal(afterUse.status, 201);

  const issuedEvents = runtime.db.prepare(`
    SELECT detail_json FROM audit_event WHERE action = 'desktop_enroll_token_issued'
  `).all();
  assert.equal(issuedEvents.length, 6);
  for (const event of issuedEvents) {
    assert.ok(!event.detail_json.includes(tokens[0]), "审计不得包含令牌明文");
    assert.doesNotMatch(event.detail_json, /[A-Za-z0-9_-]{43}/);
  }
  const deviceAudit = runtime.db.prepare(`
    SELECT detail_json FROM audit_event WHERE action = 'desktop_device_enrolled'
  `).get();
  assert.ok(!deviceAudit.detail_json.includes(enrolled.body.credential));
});

test("桌面端 enrollWithToken 走新端点并保留配对码兜底", async (t) => {
  const { runtime, adminCookie, serverUrl } = await startRuntime(t);
  const issued = await issueToken(runtime, adminCookie, { deviceName: "开发机" });
  assert.equal(issued.status, 201);

  const root = await withTempRoot(t, "trellis-enroll-token-");
  const saved = [];
  const credentialStore = {
    async saveCredential(credential) {
      saved.push(credential);
    }
  };
  const result = await enrollWithToken(issued.body.token, {
    serverUrl,
    deviceName: "开发机",
    root,
    credentialStore
  });
  assert.equal(result.protocolVersion, 2);
  assert.equal(result.serverUrl, serverUrl);
  assert.equal(saved.length, 1);
  const configText = fs.readFileSync(path.join(root, "config.json"), "utf8");
  const config = JSON.parse(configText);
  assert.equal(config.agentId, result.agentId);
  assert.equal(config.credential, undefined);
  assert.ok(!configText.includes(saved[0]), "凭证不得写入 config.json");
  assert.ok(!configText.includes(issued.body.token), "令牌不得写入 config.json");

  const replayRoot = await withTempRoot(t, "trellis-enroll-replay-");
  await assert.rejects(
    enrollWithToken(issued.body.token, {
      serverUrl,
      deviceName: "重放设备",
      root: replayRoot,
      credentialStore
    }),
    (error) => error.code === "DESKTOP_TOKEN_INVALID" && /已使用|已过期|无效/.test(error.message)
  );

  const offlinePort = await freePort();
  const offlineRoot = await withTempRoot(t, "trellis-enroll-offline-");
  await assert.rejects(
    enrollWithToken("a".repeat(43), {
      serverUrl: `http://127.0.0.1:${offlinePort}`,
      deviceName: "离线设备",
      root: offlineRoot,
      credentialStore
    }),
    (error) => error.code === "NETWORK_ERROR" && /无法连接 Board 服务端/.test(error.message)
  );

  assert.equal(validateEnrollToken(issued.body.token), issued.body.token);
  assert.throws(() => validateEnrollToken("short"), /设备令牌格式无效/);

  const sidecar = readText("desktop/sidecar/main.js");
  assert.match(sidecar, /"pairing-code": \{ flag: true \}/);
  assert.match(sidecar, /enrollWithToken/);
  assert.match(sidecar, /DESKTOP_TOKEN_INVALID/);
});

test("桌面 capability 只增加本地命令且不允许远程页面", () => {
  const capability = readJson("desktop/src-tauri/capabilities/main.json");
  assert.deepEqual(capability.windows, ["main"]);
  assert.equal(capability.remote, undefined);
  assert.deepEqual(capability.permissions.slice().sort(), [
    "allow-app-status",
    "allow-enroll-device",
    "allow-enroll-with-token",
    "allow-init-workspace",
    "allow-open-board-login",
    "allow-pick-workspace",
    "core:default",
    "dialog:allow-open"
  ]);
  for (const permission of capability.permissions) {
    if (permission === "dialog:allow-open") continue;
    assert.doesNotMatch(
      permission,
      /shell|fs:|http:|process:|updater:|dialog:|clipboard|global-shortcut|os:|path:|webview|window-state|autostart/i
    );
  }

  const custom = readText("desktop/src-tauri/permissions/desktop.toml");
  assert.match(custom, /commands\.allow = \["enroll_with_token"\]/);
  assert.match(custom, /commands\.allow = \["open_board_login"\]/);
  assert.match(custom, /commands\.allow = \["enroll_device"\]/);
  assert.match(custom, /commands\.allow = \["pick_workspace"\]/);
  assert.match(custom, /commands\.allow = \["init_workspace"\]/);
  assert.equal((custom.match(/\[\[permission\]\]/g) || []).length, 6);

  const main = readText("desktop/src-tauri/src/main.rs");
  assert.match(main, /enroll_with_token/);
  assert.match(main, /handle_enroll_links/);
  assert.match(main, /tauri::generate_handler!\[/);
  assert.match(main, /enroll_device/);
  assert.match(main, /open_board_login/);
  assert.match(main, /sidecar_plugin_enroll|sidecar::enroll\(/);
  assert.doesNotMatch(main, /open_devtools|devtools:\s*true/);

  const navigation = readText("desktop/src-tauri/src/navigation.rs");
  assert.match(navigation, /trellisboard/);
  assert.match(navigation, /parse_enroll_link/);
  assert.match(navigation, /"server"/);

  const ui = readText("desktop/ui/index.html");
  assert.match(ui, /id="enroll-token"/);
  assert.match(ui, /id="open-login"/);
  assert.match(ui, /id="pairing-code"/);
  const setup = readText("desktop/ui/setup.js");
  assert.match(setup, /invoke\("enroll_with_token"/);
  assert.match(setup, /invoke\("enroll_device"/);
  assert.match(setup, /invoke\("open_board_login"/);
  assert.match(setup, /listen\("enroll-token"/);

  const install = readText("desktop/install.ps1");
  assert.match(install, /\$ProtocolScheme = 'trellisboard'/);
  assert.match(install, /shell\\open\\command/);
  assert.match(install, /URL Protocol/);
  const uninstall = readText("desktop/uninstall.ps1");
  assert.match(uninstall, /Remove-Item -LiteralPath \$ProtocolKey/);

  const tauri = readJson("desktop/src-tauri/tauri.conf.json");
  assert.deepEqual(tauri.app.security.capabilities, ["main"]);
  assert.doesNotMatch(tauri.app.security.csp, /unsafe-eval|https:/);
});
