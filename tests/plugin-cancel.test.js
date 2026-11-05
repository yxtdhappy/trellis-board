import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHarness, startHttpServer, waitFor } from "./helpers/plugin-runtime.js";

test("宿主请求超时发送 request/cancel，插件中止处理", async () => {
  const trace = path.join(os.tmpdir(), `trellis-cancel-${process.pid}-${Date.now()}.txt`);
  const harness = await createHarness({
    plugins: [
      {
        id: "cancel-probe",
        module: "./tests/fixtures/plugins/cancel-probe/index.js",
        enabled: true,
        config: { env: { CANCEL_TRACE: trace } }
      }
    ],
    timeoutOverrides: { "http/request": 80 },
    hostVersion: "0.2.0"
  });
  const http = await startHttpServer(harness.runtime);
  try {
    const response = await fetch(`${http.baseUrl}/api/plugins/cancel-probe/slow`);
    assert.ok(response.status >= 500, `超时应返回错误，实际 ${response.status}`);
    assert.ok(await waitFor(() => fs.existsSync(trace), { timeoutMs: 3000 }));
    assert.equal(fs.readFileSync(trace, "utf8"), "cancelled");
  } finally {
    await http.close();
    await harness.cleanup();
    fs.rmSync(trace, { force: true });
  }
});
