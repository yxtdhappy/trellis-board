import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CLI_EXIT_CODE, runCli } from "../agent/cli.js";
import { WORKSPACE_ERROR_CODE, WorkspaceBootstrapError } from "../agent/workspace.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function captureIo() {
  const stdout = [];
  const stderr = [];
  return {
    io: {
      stdout: { write: (value) => stdout.push(String(value)) },
      stderr: { write: (value) => stderr.push(String(value)) },
    },
    stdout: () => stdout.join(""),
    stderr: () => stderr.join(""),
  };
}

function writeConfig(root, overrides = {}) {
  const config = {
    schemaVersion: 1,
    revision: "a".repeat(32),
    serverUrl: "http://127.0.0.1:4317",
    caFile: null,
    agentId: "agent-1",
    deviceName: "测试设备",
    username: "carol",
    teamId: null,
    teams: [{ id: "team-1", name: "团队一", role: "member" }],
    protocolVersion: 2,
    agentVersion: "0.2.0",
    pairedAt: "2026-11-05T00:00:00.000Z",
    bindings: [],
    ...overrides,
  };
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
  return config;
}

function workspaceResult(overrides = {}) {
  return {
    workspace: "demo",
    developer: "alice",
    templateVersion: "0.6.16-template-2",
    templateSha256: "b".repeat(64),
    source: "cache",
    tools: [".opencode", ".agents"],
    createdFiles: [".opencode/a", ".agents/a", ".trellis/.developer"],
    updatedFiles: [],
    skippedFiles: [".trellis/AGENTS.md", ".trellis/.template-hashes.json"],
    backupDir: null,
    developerSwitched: false,
    changed: true,
    ...overrides,
  };
}

test("workspace init 解析参数、调用 initializeWorkspace 并输出 JSON 摘要", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-workspace-cli-"));
  const workspacePath = path.join(root, "demo");
  fs.mkdirSync(workspacePath);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const output = captureIo();
  const code = await runCli(
    [
      "workspace",
      "init",
      "--path",
      workspacePath,
      "--tools",
      ".opencode,.agents,.codex",
      "--username",
      "alice",
      "--team",
      "team-9",
      "--json",
    ],
    {
      root: path.join(root, "agent"),
      io: output.io,
      workspaceInitializer: async (options) => {
        calls.push(options);
        return workspaceResult();
      },
    },
  );
  assert.equal(code, CLI_EXIT_CODE.OK);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].workspacePath, workspacePath);
  assert.equal(calls[0].username, "alice");
  assert.deepEqual(calls[0].tools, [".opencode", ".agents", ".codex"]);
  assert.equal(calls[0].teamId, "team-9");
  assert.equal(calls[0].serverUrl, null);
  const summary = JSON.parse(output.stdout().trim());
  assert.equal(summary.workspace, "demo");
  assert.equal(summary.developer, "alice");
  assert.equal(summary.templateVersion, "0.6.16-template-2");
  assert.equal(summary.source, "cache");
  assert.equal(summary.created, 3);
  assert.equal(summary.skipped, 2);
  assert.equal(summary.backupDir, null);
});

test("workspace init 从 config.json 读取用户名、团队和服务端", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-workspace-config-"));
  const workspacePath = path.join(root, "demo");
  fs.mkdirSync(workspacePath);
  writeConfig(path.join(root, "agent"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const output = captureIo();
  const code = await runCli(
    ["workspace", "init", "--path", workspacePath, "--json"],
    {
      root: path.join(root, "agent"),
      io: output.io,
      workspaceInitializer: async (options) => {
        calls.push(options);
        return workspaceResult({ developer: options.username });
      },
    },
  );
  assert.equal(code, CLI_EXIT_CODE.OK);
  assert.equal(calls[0].username, "carol");
  assert.equal(calls[0].teamId, "team-1");
  assert.equal(calls[0].serverUrl, "http://127.0.0.1:4317");
  assert.deepEqual(calls[0].tools, null);
});

test("workspace init 缺少显式团队时拒绝执行", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-workspace-team-"));
  const workspacePath = path.join(root, "demo");
  fs.mkdirSync(workspacePath);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const output = captureIo();
  const code = await runCli(
    ["workspace", "init", "--path", workspacePath, "--username", "alice"],
    {
      root: path.join(root, "agent"),
      io: output.io,
      workspaceInitializer: async () => {
        throw new Error("不应调用初始化器");
      },
    },
  );
  assert.equal(code, CLI_EXIT_CODE.USAGE);
  assert.match(output.stderr(), /--team/);
});

test("workspace init 从 .trellis/.developer 回退用户名", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-workspace-developer-"));
  const workspacePath = path.join(root, "demo");
  fs.mkdirSync(path.join(workspacePath, ".trellis"), { recursive: true });
  fs.writeFileSync(path.join(workspacePath, ".trellis", ".developer"), "name=bob\n");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const output = captureIo();
  const code = await runCli(
    ["workspace", "init", "--path", workspacePath, "--team", "team-1"],
    {
      root: path.join(root, "agent"),
      io: output.io,
      workspaceInitializer: async (options) => {
        calls.push(options);
        return workspaceResult({ developer: options.username });
      },
    },
  );
  assert.equal(code, CLI_EXIT_CODE.OK);
  assert.equal(calls[0].username, "bob");
  assert.match(output.stdout(), /developer：bob/);
  assert.match(output.stdout(), /模板：0\.6\.16-template-2（cache）/);
});

test("workspace init 用退出码区分冲突、权限和离线无缓存", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-workspace-exit-"));
  fs.mkdirSync(path.join(root, "demo"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cases = [
    [WORKSPACE_ERROR_CODE.DEVELOPER_CONFLICT, CLI_EXIT_CODE.WORKSPACE_CONFLICT],
    [WORKSPACE_ERROR_CODE.PATH_INVALID, CLI_EXIT_CODE.WORKSPACE_PERMISSION],
    [WORKSPACE_ERROR_CODE.PATH_UNWRITABLE, CLI_EXIT_CODE.WORKSPACE_PERMISSION],
    [WORKSPACE_ERROR_CODE.USERNAME_INVALID, CLI_EXIT_CODE.WORKSPACE_PERMISSION],
    [WORKSPACE_ERROR_CODE.TEMPLATE_UNAVAILABLE, CLI_EXIT_CODE.WORKSPACE_OFFLINE],
    [WORKSPACE_ERROR_CODE.TEMPLATE_HASH_MISMATCH, CLI_EXIT_CODE.WORKSPACE_TEMPLATE],
  ];
  for (const [workspaceCode, expected] of cases) {
    const output = captureIo();
    const code = await runCli(
      [
        "workspace",
        "init",
        "--path",
        path.join(root, "demo"),
        "--team",
        "team-1",
        "--username",
        "alice",
      ],
      {
        root: path.join(root, "agent"),
        io: output.io,
        workspaceInitializer: async () => {
          throw new WorkspaceBootstrapError(workspaceCode, "失败");
        },
      },
    );
    assert.equal(code, expected, workspaceCode);
    assert.match(output.stderr(), /失败/);
  }
});

test("workspace status 只读报告 developer、模板版本和工具目录", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-workspace-status-"));
  const workspacePath = path.join(root, "demo");
  fs.mkdirSync(path.join(workspacePath, ".trellis"), { recursive: true });
  fs.mkdirSync(path.join(workspacePath, ".opencode"), { recursive: true });
  fs.writeFileSync(path.join(workspacePath, ".opencode", "config.json"), "{}\n");
  fs.writeFileSync(path.join(workspacePath, ".trellis", ".developer"), "name=alice\n");
  fs.writeFileSync(
    path.join(workspacePath, ".trellis", ".template-hashes.json"),
    `${JSON.stringify({ templateVersion: "0.6.16-template-2" })}\n`,
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const output = captureIo();
  const code = await runCli(
    ["workspace", "status", "--path", workspacePath, "--json"],
    { io: output.io },
  );
  assert.equal(code, CLI_EXIT_CODE.OK);
  const status = JSON.parse(output.stdout().trim());
  assert.equal(status.initialized, true);
  assert.equal(status.developer, "alice");
  assert.equal(status.templateVersion, "0.6.16-template-2");
  assert.equal(status.tools[".opencode"], "present");
  assert.equal(status.tools[".agents"], "missing");

  const missing = captureIo();
  assert.equal(
    await runCli(["workspace", "status", "--path", path.join(root, "missing")], {
      io: missing.io,
    }),
    CLI_EXIT_CODE.WORKSPACE_PERMISSION,
  );
});

test("sidecar 命令在未注册时返回结构化配置错误", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-workspace-sidecar-cli-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = spawnSync(
    process.execPath,
    ["desktop/sidecar/cli.js", "associations"],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, TRELLIS_AGENT_ROOT: root },
    },
  );
  assert.equal(result.status, 3, result.stderr);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, false);
  assert.match(payload.error, /尚未配对|配置/);
});
