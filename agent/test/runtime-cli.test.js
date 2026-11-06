import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { AgentRuntime } from "../index.js";
import { ConfigStore } from "../config-store.js";
import { runCli, CLI_EXIT_CODE } from "../cli.js";
import { createFileOnlyLogger, redactLogText } from "../logger.js";
import {
  AGENT_ERROR_CODE,
  AgentApiError,
  normalizeServerUrl,
} from "../protocol.js";

function git(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    shell: false,
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function createRepo() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-agent-cli-"));
  const remote = path.join(base, "remote.git");
  const seed = path.join(base, "seed");
  const local = path.join(base, "local");
  fs.mkdirSync(seed, { recursive: true });
  git(base, ["init", "--bare", "--initial-branch=main", remote]);
  git(seed, ["init", "-b", "main"]);
  git(seed, ["config", "user.email", "agent-test@example.invalid"]);
  git(seed, ["config", "user.name", "Agent Test"]);
  write(path.join(seed, ".trellis", "tasks", ".keep"), "tasks\n");
  write(path.join(seed, ".trellis", "workspace", ".keep"), "workspace\n");
  write(path.join(seed, "README.md"), "initial\n");
  git(seed, ["add", "."]);
  git(seed, ["commit", "-m", "initial"]);
  const remoteUrl = pathToFileURL(remote).href;
  git(seed, ["remote", "add", "origin", remoteUrl]);
  git(seed, ["push", "-u", "origin", "main"]);
  git(base, ["clone", remoteUrl, local]);
  git(local, ["config", "user.email", "agent-test@example.invalid"]);
  git(local, ["config", "user.name", "Agent Test"]);
  return { base, local, remoteUrl };
}

class MemoryCredentialStore {
  constructor() {
    this.credential = null;
  }

  async saveCredential(value) {
    this.credential = value;
  }

  async loadCredential() {
    if (!this.credential) {
      throw new AgentApiError(AGENT_ERROR_CODE.CREDENTIAL_MISSING, "missing");
    }
    return this.credential;
  }

  async selfTest() {
    return true;
  }
}

function ioCapture() {
  const stdout = [];
  const stderr = [];
  return {
    stdoutText: () => stdout.join(""),
    stderrText: () => stderr.join(""),
    io: {
      stdout: { write: (chunk) => stdout.push(String(chunk)) },
      stderr: { write: (chunk) => stderr.push(String(chunk)) },
    },
  };
}

function withEnrollServer(callback) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (request, response) => {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        response.setHeader("content-type", "application/json");
        if (request.url === "/api/agent/enroll") {
          response.end(JSON.stringify({
            agentId: "agent-cli-1",
            credential: "c".repeat(32),
            protocolVersion: 2,
          }));
          return;
        }
        response.statusCode = 404;
        response.end(JSON.stringify({ error: "not found" }));
      });
    });
    server.listen(0, "127.0.0.1", async () => {
      const address = server.address();
      try {
        await callback(`http://127.0.0.1:${address.port}`);
        resolve();
      } catch (error) {
        reject(error);
      } finally {
        await new Promise((done) => server.close(done));
      }
    });
  });
}

test("CLI 配对和绑定不把凭证或绝对路径写入配置输出", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-agent-root-"));
  const repo = createRepo();
  const output = ioCapture();
  const store = new ConfigStore(root, { secureDirectory: false });
  const credentials = new MemoryCredentialStore();
  try {
    await withEnrollServer(async (serverUrl) => {
      const pairingCode = "p".repeat(16);
      const pairCode = await runCli([
        "pair",
        "--server",
        normalizeServerUrl(serverUrl),
        "--name",
        "Test PC",
        "--json",
      ], {
        store,
        io: output.io,
        credentialStore: credentials,
        readSecret: async () => pairingCode,
      });
      assert.equal(pairCode, CLI_EXIT_CODE.OK);
      assert.equal(output.stdoutText().includes(credentials.credential), false);
      const config = await store.readConfig();
      assert.equal(config.agentId, "agent-cli-1");
      assert.equal(JSON.stringify(config).includes(credentials.credential), false);

      const bindCode = await runCli([
        "bind",
        "--project",
        "project-1",
        "--path",
        repo.local,
        "--branch",
        "main",
        "--json",
      ], { store, io: output.io, credentialStore: credentials });
      assert.equal(bindCode, CLI_EXIT_CODE.OK, output.stderrText());
      const bound = await store.readConfig();
      assert.equal(bound.bindings.length, 1);
      assert.equal(bound.bindings[0].projectId, "project-1");
      assert.equal(bound.bindings[0].repoPath, repo.local);
      assert.equal(bound.bindings[0].localRepoKey.length, 64);
      assert.equal(output.stdoutText().includes(repo.local), false);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(repo.base, { recursive: true, force: true });
  }
});

test("CLI 参数校验和未配对诊断返回稳定退出码", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-agent-root-"));
  const output = ioCapture();
  const store = new ConfigStore(root, { secureDirectory: false });
  try {
    const invalid = await runCli(["pair", "--code", "not-allowed"], {
      store,
      io: output.io,
    });
    assert.equal(invalid, CLI_EXIT_CODE.USAGE);
    const bind = await runCli([
      "bind",
      "--project",
      "project-1",
      "--path",
      root,
      "--branch",
      "main",
    ], { store, io: output.io });
    assert.equal(bind, CLI_EXIT_CODE.CONFIG);
    const unbind = await runCli(["unbind", "--project", "project-1"], {
      store,
      io: output.io,
    });
    assert.equal(unbind, CLI_EXIT_CODE.CONFIG);
    const diagnose = await runCli(["diagnose", "--offline", "--json"], {
      store,
      io: output.io,
    });
    assert.equal(diagnose, CLI_EXIT_CODE.CHECK_FAILED);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function makeBinding(repoPath) {
  return {
    localId: "local-1",
    serverBindingId: "binding-1",
    projectId: "project-1",
    teamId: "team-1",
    repoPath,
    branchName: "main",
    remoteIdentityKey: "a".repeat(64),
    localRepoKey: "b".repeat(64),
    displayName: "local",
    createdAt: "2026-11-03T00:00:00.000Z",
    allowFileRemote: true,
    syncStatus: "approved",
    lastSyncedAt: null,
    lastHead: null,
    lastError: null,
    lastErrorCode: null,
  };
}

function makeConfig(repoPath) {
  return {
    schemaVersion: 1,
    revision: "c".repeat(32),
    serverUrl: "http://127.0.0.1:4317",
    caFile: null,
    agentId: "agent-runtime-1",
    deviceName: "Runtime Test",
    protocolVersion: 2,
    agentVersion: "0.1.0",
    pairedAt: "2026-11-03T00:00:00.000Z",
    bindings: [makeBinding(repoPath)],
  };
}

test("主循环领取白名单命令并上报结果，不发送仓库绝对路径", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-agent-runtime-"));
  const repoPath = path.join(root, "repo");
  fs.mkdirSync(repoPath, { recursive: true });
  const store = new ConfigStore(root, { secureDirectory: false });
  const logger = createFileOnlyLogger({ logsDir: store.paths.logsDir });
  const credentials = { loadCredential: async () => "c".repeat(32) };
  const controller = new AbortController();
  const calls = { heartbeats: 0, streams: 0, results: [] };
  const api = {
    heartbeat: async () => {
      calls.heartbeats += 1;
      return { protocolVersion: 2, compatible: true, bindings: [] };
    },
    streamEvents: async (input, options) => {
      calls.streams += 1;
      assert.equal(input.teamId, "team-1");
      options.onOpen?.({ status: 200, headers: {} });
      if (calls.streams === 1) {
        await options.onEvent({
          id: "1",
          type: "command",
          data: {
            payload: {
              command: {
                id: "command-1",
                bindingId: "binding-1",
                type: "refresh_status",
                payload: { protocolVersion: 2, projectId: "project-1", branchName: "main" },
              },
            },
          },
        });
      }
      await new Promise((resolve) => {
        if (options.signal.aborted) resolve();
        else options.signal.addEventListener("abort", resolve, { once: true });
      });
      return { reason: "closed" };
    },
    submitCommandResult: async (id, result) => {
      calls.results.push({ id, result });
      controller.abort();
    },
  };
  try {
    await store.saveConfig(makeConfig(repoPath));
    const runtime = new AgentRuntime({
      store,
      credentialStore: credentials,
      logger,
      apiFactory: () => api,
      inspectRepository: async () => ({
        root: repoPath,
        localRepoKey: "b".repeat(64),
        branchName: "main",
        currentBranch: "main",
        head: "d".repeat(40),
        clean: true,
        dirtySummary: "",
        remoteIdentityKey: "a".repeat(64),
      }),
      heartbeatMs: 10,
      eventReconcileMs: 5,
      signal: controller.signal,
    });
    const result = await runtime.run();
    assert.equal(result.exitCode, 0);
    assert.equal(calls.results.length, 1);
    assert.equal(calls.results[0].result.result.clean, true);
    assert.equal(JSON.stringify(calls.results[0]).includes(repoPath), false);
    const config = await store.readConfig();
    assert.equal(config.bindings[0].lastHead, "d".repeat(40));
  } finally {
    await logger.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("401 撤销停止主循环且保留本地配置", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-agent-runtime-"));
  const repoPath = path.join(root, "repo");
  fs.mkdirSync(repoPath, { recursive: true });
  const store = new ConfigStore(root, { secureDirectory: false });
  const logger = createFileOnlyLogger({ logsDir: store.paths.logsDir });
  const controller = new AbortController();
  const api = {
    heartbeat: async () => {
      throw new AgentApiError(AGENT_ERROR_CODE.AUTH_REVOKED, "revoked", { status: 401 });
    },
    streamEvents: async () => ({ reason: "closed" }),
  };
  try {
    await store.saveConfig(makeConfig(repoPath));
    const runtime = new AgentRuntime({
      store,
      credentialStore: { loadCredential: async () => "c".repeat(32) },
      logger,
      apiFactory: () => api,
      inspectRepository: async () => { throw new Error("must not inspect"); },
      heartbeatMs: 10,
      eventReconcileMs: 5,
      signal: controller.signal,
    });
    const result = await runtime.run();
    assert.equal(result.authRevoked, true);
    assert.equal((await store.readConfig()).agentId, "agent-runtime-1");
  } finally {
    await logger.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("协议不兼容只保留心跳并关闭命令领取", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-agent-runtime-"));
  const repoPath = path.join(root, "repo");
  fs.mkdirSync(repoPath, { recursive: true });
  const store = new ConfigStore(root, { secureDirectory: false });
  const logger = createFileOnlyLogger({ logsDir: store.paths.logsDir });
  try {
    await store.saveConfig(makeConfig(repoPath));
    const runtime = new AgentRuntime({
      store,
      credentialStore: { loadCredential: async () => "c".repeat(32) },
      logger,
      apiFactory: () => ({
        heartbeat: async () => ({ protocolVersion: 2, compatible: false, bindings: [] }),
      }),
      heartbeatMs: 10,
      eventReconcileMs: 5,
    });
    await runtime.heartbeatOnce();
    assert.equal(runtime.pollEnabled, false);
  } finally {
    await logger.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("日志脱敏覆盖 Bearer、令牌和 Windows 路径", () => {
  const text = redactLogText(
    "Bearer abc.def token=secret D:\\Users\\me\\repo\\\\server\\share",
  );
  assert.equal(text.includes("abc.def"), false);
  assert.equal(text.includes("secret"), false);
  assert.equal(text.includes("D:\\Users"), false);
});
