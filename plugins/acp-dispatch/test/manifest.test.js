import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createHarness, startHttpServer } from "../../../tests/helpers/plugin-runtime.js";

const ID = "acp-dispatch";
const MODULE = fileURLToPath(new URL("../index.js", import.meta.url));

test("acp-dispatch 通过真实清单校验与握手", async () => {
  const harness = await createHarness({
    plugins: [{ id: ID, module: MODULE, enabled: true, config: {} }],
    hostVersion: "0.2.0"
  });
  const http = await startHttpServer(harness.runtime);
  try {
    const state = harness.supervisor.plugins.get(ID);
    assert.equal(state.status, "running", `${ID} 未运行: ${state.lastError}`);
    assert.equal(state.manifest.id, ID);
    assert.equal(state.manifest.apiVersion, 1);
    assert.match(state.manifest.version, /^\d+\.\d+\.\d+/);
    assert.ok(state.manifest.permissions.length > 0, `${ID} 没有声明权限`);

    const payload = await fetch(`${http.baseUrl}/api/plugins`).then((response) => response.json());
    const plugin = payload.plugins.find((item) => item.id === ID);
    assert.ok(plugin, `${ID} 不在插件列表`);
    assert.equal(plugin.compatible, true);
    assert.equal(plugin.status, "running");
    assert.equal(plugin.apiVersion, 1);
    assert.match(plugin.version, /^\d+\.\d+\.\d+/);
  } finally {
    await http.close();
    await harness.cleanup();
  }
});
