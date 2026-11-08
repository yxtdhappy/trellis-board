import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CLI_EXIT_CODE, runCli } from "../agent/cli.js";
import { WORKSPACE_ERROR_CODE, WorkspaceBootstrapError } from "../agent/workspace.js";
import { runWorkspaceInit } from "../desktop/sidecar/workspace-init.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readText(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function readJson(relativePath) {
  return JSON.parse(readText(relativePath));
}

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

function seedTemplateCache(dataRoot, teamId) {
  const manifest = readJson("server/templates/workspace/manifest.json");
  const archive = fs.readFileSync(
    path.join(ROOT, "server/templates/workspace/workspace-template.zip"),
  );
  const sha256 = crypto.createHash("sha256").update(archive).digest("hex");
  const cacheDir = path.join(dataRoot, "templates", "workspace", teamId);
  const versionDir = path.join(cacheDir, sha256);
  fs.mkdirSync(versionDir, { recursive: true });
  fs.writeFileSync(path.join(versionDir, "template.zip"), archive);
  fs.writeFileSync(
    path.join(versionDir, "manifest.json"),
    `${JSON.stringify({ version: manifest.version, sha256 }, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(cacheDir, "latest.json"),
    `${JSON.stringify({ version: manifest.version, sha256 }, null, 2)}\n`,
  );
  return { manifest, sha256 };
}

test("sidecar workspace-init 用本地缓存真实初始化且不依赖网络", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-workspace-sidecar-"));
  const workspacePath = path.join(root, "workspace");
  const dataRoot = path.join(root, "agent");
  fs.mkdirSync(workspacePath);
  fs.mkdirSync(dataRoot);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { manifest, sha256 } = seedTemplateCache(dataRoot, "team-1");
  const tools = [".opencode", ".agents"];

  const result = await runWorkspaceInit({
    workspacePath,
    tools,
    username: "alice",
    teamId: "team-1",
    serverUrl: "http://127.0.0.1:1",
    dataRoot,
    agentCredential: "x".repeat(32),
    fetchImpl: async () => {
      throw new Error("network disabled");
    },
  });

  assert.equal(result.source, "cache");
  assert.equal(result.templateVersion, manifest.version);
  assert.equal(result.templateSha256, sha256);
  assert.equal(result.developer, "alice");
  assert.equal(
    fs.readFileSync(path.join(workspacePath, ".trellis", ".developer"), "utf8")
      .match(/^name=(.*)$/m)[1],
    "alice",
  );
  assert.ok(fs.existsSync(path.join(workspacePath, ".trellis", "workspace", "alice", "journal-1.md")));
  assert.ok(fs.existsSync(path.join(workspacePath, ".trellis", "workspace", "alice", "index.md")));
  for (const tool of tools) {
    assert.ok(fs.readdirSync(path.join(workspacePath, tool)).length > 0, `${tool} should be non-empty`);
  }
  assert.equal(fs.existsSync(path.join(workspacePath, ".git")), false);

  const second = await runWorkspaceInit({
    workspacePath,
    tools,
    username: "alice",
    teamId: "team-1",
    serverUrl: "http://127.0.0.1:1",
    dataRoot,
    agentCredential: "x".repeat(32),
    fetchImpl: async () => {
      throw new Error("network disabled");
    },
  });
  assert.equal(second.changed, false);
  assert.equal(second.createdFiles.length, 0);
});

test("sidecar workspace-init 在 developer 冲突时中止且不写模板", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-workspace-conflict-"));
  const workspacePath = path.join(root, "workspace");
  const dataRoot = path.join(root, "agent");
  fs.mkdirSync(path.join(workspacePath, ".trellis"), { recursive: true });
  fs.mkdirSync(dataRoot);
  fs.writeFileSync(path.join(workspacePath, ".trellis", ".developer"), "name=other\n");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  seedTemplateCache(dataRoot, "team-1");

  await assert.rejects(
    runWorkspaceInit({
      workspacePath,
      tools: [".opencode", ".agents"],
      username: "alice",
      teamId: "team-1",
      serverUrl: "http://127.0.0.1:1",
      dataRoot,
      agentCredential: "x".repeat(32),
      fetchImpl: async () => {
        throw new Error("network disabled");
      },
    }),
    (error) => error.code === WORKSPACE_ERROR_CODE.DEVELOPER_CONFLICT,
  );
  assert.equal(
    fs.readFileSync(path.join(workspacePath, ".trellis", ".developer"), "utf8"),
    "name=other\n",
  );
  assert.equal(fs.existsSync(path.join(workspacePath, ".opencode")), false);
  assert.equal(fs.existsSync(path.join(workspacePath, ".agents")), false);
});

test("sidecar 命令在未注册时返回结构化配置错误", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-workspace-sidecar-cli-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = spawnSync(
    process.execPath,
    ["desktop/sidecar/cli.js", "workspace-init", "--path", path.join(root, "workspace")],
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

test("CLI、UI、Tauri、capability 与 sidecar 都接入了 workspace 流程", () => {
  const cli = readText("agent/cli.js");
  assert.match(cli, /case "workspace":/);
  assert.match(cli, /commandWorkspaceInit/);
  assert.match(cli, /initializeWorkspace/);
  assert.match(cli, /WORKSPACE_CONFLICT/);
  assert.match(cli, /WORKSPACE_OFFLINE/);

  const sidecar = readText("desktop/sidecar/main.js");
  assert.match(sidecar, /runWorkspaceInit/);
  assert.match(sidecar, /case "workspace-init":/);
  assert.match(readText("desktop/sidecar/workspace-init.js"), /initializeWorkspace/);

  const html = readText("desktop/ui/index.html");
  assert.match(html, /id="workspace-panel"/);
  assert.match(html, /id="workspace-path"/);
  assert.match(html, /id="pick-workspace"/);
  assert.match(html, /id="init-workspace"/);
  assert.match(html, /id="workspace-result"/);
  assert.match(html, /id="workspace-error"/);
  const ui = readText("desktop/ui/setup.js");
  assert.match(ui, /invoke\("pick_workspace"\)/);
  assert.match(ui, /invoke\("init_workspace"/);
  assert.doesNotMatch(ui, /initializeWorkspace|child_process|require\(/);

  const main = readText("desktop/src-tauri/src/main.rs");
  assert.match(main, /async fn pick_workspace/);
  assert.match(main, /async fn init_workspace/);
  assert.match(main, /tauri_plugin_dialog::init\(\)/);
  assert.match(main, /DialogExt/);
  assert.match(main, /sidecar::workspace_init/);
  assert.match(readText("desktop/src-tauri/src/sidecar.rs"), /pub async fn workspace_init/);
  assert.match(readText("desktop/src-tauri/Cargo.toml"), /tauri-plugin-dialog = "2"/);

  const capability = readJson("desktop/src-tauri/capabilities/main.json");
  assert.equal(capability.remote, undefined);
  assert.ok(capability.permissions.includes("dialog:allow-open"));
  assert.ok(capability.permissions.includes("allow-pick-workspace"));
  assert.ok(capability.permissions.includes("allow-init-workspace"));
  assert.ok(!capability.permissions.includes("shell:allow-open"));
  for (const permission of capability.permissions) {
    assert.doesNotMatch(permission, /^shell:|^fs:|^http:|^process:/);
  }
  const config = readJson("desktop/src-tauri/tauri.conf.json");
  assert.deepEqual(config.app.security.capabilities, ["main"]);
  assert.doesNotMatch(config.app.security.csp, /unsafe-inline|unsafe-eval/);
});
