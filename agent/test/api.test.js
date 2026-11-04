import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { AgentApiClient } from "../api.js";
import {
  AGENT_ERROR_CODE,
  AgentApiError,
} from "../protocol.js";

async function withServer(handler, callback) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    return await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

test("HTTP stub 验证配对、心跳、命令和 Bearer", async () => {
  const seen = [];
  await withServer(async (request, response) => {
    const body = await readBody(request);
    seen.push({ url: request.url, authorization: request.headers.authorization, body });
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/agent/enroll") {
      response.end(JSON.stringify({
        agentId: "agent-1",
        credential: "c".repeat(32),
        protocolVersion: 1,
      }));
      return;
    }
    if (request.url === "/api/agent/heartbeat") {
      response.end(JSON.stringify({
        protocolVersion: 1,
        compatible: true,
        bindings: [],
      }));
      return;
    }
    if (request.url === "/api/agent/commands") {
      response.end(JSON.stringify({
        commands: [{
          id: "command-1",
          bindingId: "binding-1",
          type: "refresh_status",
          payload: {
            protocolVersion: 1,
            projectId: "project-1",
            reason: "binding_approved",
          },
        }],
      }));
      return;
    }
    if (request.url === "/api/agent/commands/command-1/result") {
      response.end("{}");
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  }, async (serverUrl) => {
    const client = new AgentApiClient({ serverUrl });
    const enroll = await client.enroll({ pairingCode: "p".repeat(16), deviceName: "PC" });
    assert.equal(enroll.agentId, "agent-1");
    client.setCredential(enroll.credential);
    const heartbeat = await client.heartbeat({ agentId: enroll.agentId });
    assert.equal(heartbeat.compatible, true);
    const commands = await client.pollCommands({ agentId: enroll.agentId });
    assert.equal(commands[0].type, "refresh_status");
    await client.submitCommandResult("command-1", { status: "failed" });
  });
  assert.equal(seen.find((item) => item.url === "/api/agent/enroll").authorization, undefined);
  assert.equal(
    seen.find((item) => item.url === "/api/agent/commands").authorization,
    `Bearer ${"c".repeat(32)}`,
  );
  assert.equal(seen.some((item) => item.body.includes("pairingCode")), true);
});

test("401 作为不可重试的凭证撤销错误返回", async () => {
  await withServer(async (request, response) => {
    await readBody(request);
    response.statusCode = 401;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ error: "revoked" }));
  }, async (serverUrl) => {
    const client = new AgentApiClient({
      serverUrl,
      credential: "c".repeat(32),
    });
    await assert.rejects(
      () => client.heartbeat({ agentId: "agent-1" }),
      (error) => {
        assert.equal(error instanceof AgentApiError, true);
        assert.equal(error.code, AGENT_ERROR_CODE.AUTH_REVOKED);
        assert.equal(error.retryable, false);
        return true;
      },
    );
  });
});

test("426 和 429 保留协议及 Retry-After 信息", async () => {
  let calls = 0;
  await withServer(async (request, response) => {
    await readBody(request);
    calls += 1;
    response.statusCode = calls === 1 ? 426 : 429;
    response.setHeader("content-type", "application/json");
    response.setHeader("retry-after", "3");
    response.end(JSON.stringify({ error: "slow down", code: calls === 1 ? "AGENT_PROTOCOL_UNSUPPORTED" : "BUSY" }));
  }, async (serverUrl) => {
    const client = new AgentApiClient({
      serverUrl,
      credential: "c".repeat(32),
    });
    await assert.rejects(
      () => client.heartbeat({ agentId: "agent-1" }),
      (error) => error.code === AGENT_ERROR_CODE.PROTOCOL_INCOMPATIBLE,
    );
    await assert.rejects(
      () => client.heartbeat({ agentId: "agent-1" }),
      (error) => error.code === AGENT_ERROR_CODE.HTTP_ERROR &&
        error.retryable === true &&
        error.retryAfterMs === 3000,
    );
  });
});
