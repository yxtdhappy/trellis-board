import test from "node:test";
import assert from "node:assert/strict";
import { createHarness, fixtureModule, startHttpServer, waitFor } from "./helpers/plugin-runtime.js";

async function request(baseUrl, pathname, { method = "GET", body, headers = {} } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, text, json, headers: response.headers };
}

function echoPlugin(extra = {}) {
  return {
    id: "echo",
    module: fixtureModule("echo"),
    enabled: true,
    config: { token: "fixture-token" },
    ...extra
  };
}

test("GET /api/plugins 返回版本、状态与脱敏配置", async () => {
  const harness = await createHarness({ plugins: [echoPlugin()] });
  const http = await startHttpServer(harness.runtime);
  try {
    const response = await request(http.baseUrl, "/api/plugins");
    assert.equal(response.status, 200);
    assert.equal(response.json.disabled, false);
    const plugin = response.json.plugins.find((item) => item.id === "echo");
    assert.equal(plugin.version, "1.0.0");
    assert.equal(plugin.apiVersion, 1);
    assert.equal(plugin.compatible, true);
    assert.equal(plugin.status, "running");
    assert.equal(plugin.config.token, "***");
  } finally {
    await http.close();
    await harness.cleanup();
  }
});

test("插件命名空间路由只落在 /api/plugins/<id>/ 下", async () => {
  const harness = await createHarness({ plugins: [echoPlugin()] });
  const http = await startHttpServer(harness.runtime);
  try {
    const echoed = await request(http.baseUrl, "/api/plugins/echo/echo");
    assert.equal(echoed.status, 200);
    assert.equal(echoed.json.plugin, "echo");

    const unknown = await request(http.baseUrl, "/api/plugins/nope/echo");
    assert.equal(unknown.status, 404);

    const core = await request(http.baseUrl, "/api/board");
    assert.equal(core.status, 404);
    assert.deepEqual(core.json, { error: "not found" });
  } finally {
    await http.close();
    await harness.cleanup();
  }
});

test("人工启停插件并写审计", async () => {
  const harness = await createHarness({ plugins: [echoPlugin()] });
  const http = await startHttpServer(harness.runtime);
  try {
    const stopped = await request(http.baseUrl, "/api/plugins/echo/stop", { method: "POST" });
    assert.equal(stopped.status, 200);
    assert.equal(stopped.json.plugin.status, "stopped");

    const started = await request(http.baseUrl, "/api/plugins/echo/start", { method: "POST" });
    assert.equal(started.status, 200);
    assert.equal(started.json.plugin.status, "running");

    const audit = await request(http.baseUrl, "/api/plugins/echo/audit");
    assert.equal(audit.status, 200);
    const kinds = audit.json.audit.map((entry) => entry.kind);
    assert.ok(kinds.includes("stopped"));
    assert.ok(kinds.includes("started"));
  } finally {
    await http.close();
    await harness.cleanup();
  }
});

test("logs 与 runs 查询可用", async () => {
  const harness = await createHarness({ plugins: [echoPlugin()] });
  const http = await startHttpServer(harness.runtime);
  try {
    const state = harness.supervisor.plugins.get("echo");
    harness.supervisor.writeLog(state, "info", "from-test", { n: 1 });
    const logs = await request(http.baseUrl, "/api/plugins/echo/logs?tail=10");
    assert.equal(logs.status, 200);
    assert.equal(logs.json.entries.at(-1).message, "from-test");

    harness.store.createRun({
      runId: "echo:repo::t:1",
      pluginId: "echo",
      taskKey: "repo::t",
      status: "completed"
    });
    const runs = await request(http.baseUrl, "/api/plugins/echo/runs?taskKey=repo%3A%3At");
    assert.equal(runs.status, 200);
    assert.equal(runs.json.runs.length, 1);
    assert.equal(runs.json.runs[0].runId, "echo:repo::t:1");
  } finally {
    await http.close();
    await harness.cleanup();
  }
});

test("公开根路径要求 Bearer token", async () => {
  const harness = await createHarness({ plugins: [echoPlugin()] });
  const http = await startHttpServer(harness.runtime);
  try {
    const ok = await request(http.baseUrl, "/fixtures/echo", {
      method: "POST",
      body: { x: 1 },
      headers: { authorization: "Bearer fixture-token" }
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.plugin, "echo");

    const denied = await request(http.baseUrl, "/fixtures/echo", {
      method: "POST",
      body: { x: 1 }
    });
    assert.equal(denied.status, 401);

    const wrong = await request(http.baseUrl, "/fixtures/echo", {
      method: "POST",
      body: { x: 1 },
      headers: { authorization: "Bearer nope" }
    });
    assert.equal(wrong.status, 403);
  } finally {
    await http.close();
    await harness.cleanup();
  }
});

test("未配置 token 的公开端点不挂载", async () => {
  const harness = await createHarness({
    plugins: [
      { id: "echo", module: fixtureModule("echo"), enabled: true, config: {} }
    ]
  });
  const http = await startHttpServer(harness.runtime);
  try {
    const response = await request(http.baseUrl, "/fixtures/echo", {
      method: "POST",
      body: { x: 1 }
    });
    assert.equal(response.status, 404);
    assert.match(response.json.error, /token/);
  } finally {
    await http.close();
    await harness.cleanup();
  }
});

test("根路径冲突时后加载者失败，先加载者保持可用", async () => {
  const harness = await createHarness({
    plugins: [
      echoPlugin(),
      { id: "root-dup", module: fixtureModule("root-dup"), enabled: true, config: { token: "t" } }
    ]
  });
  const http = await startHttpServer(harness.runtime);
  try {
    const echo = harness.supervisor.plugins.get("echo");
    const duplicate = harness.supervisor.plugins.get("root-dup");
    assert.equal(echo.status, "running");
    assert.equal(duplicate.status, "error");
    assert.match(duplicate.lastError, /根路径冲突/);
    const response = await request(http.baseUrl, "/fixtures/echo", {
      method: "POST",
      body: {},
      headers: { authorization: "Bearer fixture-token" }
    });
    assert.equal(response.json.plugin, "echo");
  } finally {
    await http.close();
    await harness.cleanup();
  }
});

test("插件不能抢占 /api 核心根路径", async () => {
  const harness = await createHarness({
    plugins: [
      { id: "core-root", module: fixtureModule("core-root"), enabled: true, config: { token: "t" } }
    ]
  });
  try {
    const state = harness.supervisor.plugins.get("core-root");
    assert.equal(state.status, "error");
    assert.match(state.lastError, /核心路由冲突/);
    assert.equal(harness.supervisor.findRootPlugin("/api/board"), null);
  } finally {
    await harness.cleanup();
  }
});

test("插件服务未运行时命名空间返回 503", async () => {
  const harness = await createHarness({ plugins: [echoPlugin()] });
  const http = await startHttpServer(harness.runtime);
  try {
    await harness.supervisor.stopPlugin("echo");
    const response = await request(http.baseUrl, "/api/plugins/echo/echo");
    assert.equal(response.status, 503);
    assert.equal(response.json.code, 1007);
  } finally {
    await http.close();
    await harness.cleanup();
  }
});

test("插件列表在 TRELLIS_PLUGINS_DISABLED=1 时为空", async () => {
  const harness = await createHarness({
    plugins: [echoPlugin()],
    env: { TRELLIS_PLUGINS_DISABLED: "1" }
  });
  try {
    assert.deepEqual(harness.runtime.list(), { disabled: true, plugins: [] });
    const started = await harness.runtime.start();
    assert.equal(started.disabled, true);
  } finally {
    await harness.cleanup();
  }
});

test("事件投递在插件重启后仍能送达", async () => {
  const harness = await createHarness({ plugins: [echoPlugin()] });
  try {
    await harness.supervisor.stopPlugin("echo");
    harness.runtime.publish("task.created", { taskKey: "repo::queued" });
    await harness.supervisor.startPlugin("echo");
    const delivered = await waitFor(
      () => harness.store.getState("echo", "last:task.created")?.taskKey === "repo::queued",
      { timeoutMs: 3000 }
    );
    assert.equal(delivered, true);
  } finally {
    await harness.cleanup();
  }
});
