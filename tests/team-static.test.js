import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createTeamRuntime } from "../server/team/http.js";

const PUBLIC_ORIGIN = "http://127.0.0.1:4319";
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

function get(runtime, pathname) {
  const address = runtime.address();
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port: address.port,
      path: pathname,
      method: "GET",
      headers: { host: "127.0.0.1:4319" }
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks)
      }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("团队模式静态资源能提供字体与外部主题脚本", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-team-static-"));
  const publicDir = path.join(root, "public");
  fs.mkdirSync(path.join(publicDir, "assets"), { recursive: true });
  fs.writeFileSync(path.join(publicDir, "index.html"), "<!doctype html><title>board</title>");
  fs.writeFileSync(path.join(publicDir, "theme-init.js"), "void 0;\n");
  fs.writeFileSync(path.join(publicDir, "assets", "inter-latin.woff2"), Buffer.from("wOF2", "ascii"));

  const runtime = await createTeamRuntime({
    config: testConfig(),
    databaseFile: path.join(root, "data", "board.sqlite"),
    dataDir: path.join(root, "data"),
    publicDir,
    logger: SILENT_LOGGER,
    requireAdmin: false,
    enablePolling: false
  });
  await runtime.start();
  t.after(async () => {
    await runtime.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const font = await get(runtime, "/assets/inter-latin.woff2");
  assert.equal(font.status, 200);
  assert.equal(font.headers["content-type"], "font/woff2");
  assert.equal(font.body.toString("ascii"), "wOF2");

  const script = await get(runtime, "/theme-init.js");
  assert.equal(script.status, 200);
  assert.match(String(script.headers["content-type"]), /text\/javascript/);
  assert.match(String(script.headers["content-security-policy"]), /script-src 'self'/);

  assert.equal((await get(runtime, "/assets/missing.woff2")).status, 404);
  assert.equal((await get(runtime, "/index.html")).status, 200);
});
