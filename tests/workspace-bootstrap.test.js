import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  WORKSPACE_ERROR_CODE,
  assertWorkspaceDirectory,
  downloadWorkspaceTemplate,
  initializeWorkspace,
  loadCachedWorkspaceTemplate,
  loadTemplateArchive
} from "../agent/workspace.js";
import { buildTemplateZip, buildZip } from "./helpers/zip-builder.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const REAL_ARCHIVE = path.join(
  REPO_ROOT,
  "server",
  "templates",
  "workspace",
  "workspace-template.zip"
);
const REAL_BUNDLE = loadTemplateArchive(REAL_ARCHIVE);
const SILENT_LOGGER = { info() {}, warn() {}, error() {} };
const FIXED_NOW = new Date("2026-11-06T12:00:00Z");
const USERNAME = "alice";
const CREDENTIAL = "a".repeat(32);

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(directory) {
  if (!directory) return;
  try {
    fs.chmodSync(directory, 0o755);
  } catch {
    // 只读场景恢复权限。
  }
  fs.rmSync(directory, { recursive: true, force: true });
}

function exists(...parts) {
  return fs.existsSync(path.join(...parts));
}

async function assertErrorCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code, `unexpected error code: ${error.code}`);
    return true;
  });
}

function templateResponse(archive, {
  sha = sha256(archive),
  version = REAL_BUNDLE.manifest.version,
  status = 200
} = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        const key = String(name).toLowerCase();
        if (key === "x-template-sha256") return sha;
        if (key === "x-template-version") return version;
        if (key === "content-length") return String(archive.length);
        return null;
      }
    },
    async arrayBuffer() {
      return archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength);
    },
    async json() {
      return { error: "模板接口失败" };
    }
  };
}

function readDeveloper(workspace) {
  return fs.readFileSync(
    path.join(workspace, ".trellis", ".developer"),
    "utf8"
  );
}

test("空目录初始化生成 .trellis/.opencode/.agents、developer 和模板哈希，不创建 .git", async () => {
  const workspace = tempDir("trellis-workspace-empty-");
  try {
    const result = await initializeWorkspace({
      workspacePath: workspace,
      username: USERNAME,
      bundle: REAL_BUNDLE,
      now: FIXED_NOW,
      logger: SILENT_LOGGER
    });
    assert.equal(result.developer, USERNAME);
    assert.equal(result.templateVersion, "0.6.16-template-1");
    assert.equal(result.templateSha256, REAL_BUNDLE.sha256);
    assert.equal(result.changed, true);
    assert.deepEqual(result.tools, [".opencode", ".agents"]);
    assert.ok(fs.readdirSync(path.join(workspace, ".trellis")).length > 0);
    assert.ok(fs.readdirSync(path.join(workspace, ".opencode")).length > 0);
    assert.ok(fs.readdirSync(path.join(workspace, ".agents")).length > 0);
    assert.equal(fs.existsSync(path.join(workspace, ".codex")), false);
    assert.equal(fs.existsSync(path.join(workspace, ".git")), false);
    assert.ok(exists(workspace, "AGENTS.md"));
    assert.match(readDeveloper(workspace), /^name=alice$/m);
    assert.ok(exists(workspace, ".trellis", "workspace", USERNAME, "journal-1.md"));
    assert.ok(exists(workspace, ".trellis", "workspace", USERNAME, "index.md"));
    assert.match(
      fs.readFileSync(
        path.join(workspace, ".trellis", "workspace", USERNAME, "journal-1.md"),
        "utf8"
      ),
      /^# Journal - alice \(Part 1\)/
    );
    const hashes = JSON.parse(
      fs.readFileSync(path.join(workspace, ".trellis", ".template-hashes.json"), "utf8")
    );
    assert.equal(hashes.templateVersion, REAL_BUNDLE.manifest.version);
    assert.equal(hashes.templateSha256, REAL_BUNDLE.sha256);
    assert.deepEqual(hashes.tools, [".opencode", ".agents"]);
    assert.match(hashes.files[".trellis/scripts/init_developer.py"], /^[a-f0-9]{64}$/);
    assert.ok(result.createdFiles.includes(".trellis/.developer"));
  } finally {
    cleanup(workspace);
  }
});

test("重复初始化幂等，不重复追加 journal 或改写模板哈希", async () => {
  const workspace = tempDir("trellis-workspace-idempotent-");
  try {
    await initializeWorkspace({
      workspacePath: workspace,
      username: USERNAME,
      bundle: REAL_BUNDLE,
      now: FIXED_NOW,
      logger: SILENT_LOGGER
    });
    const journalFile = path.join(
      workspace,
      ".trellis",
      "workspace",
      USERNAME,
      "journal-1.md"
    );
    const hashesFile = path.join(workspace, ".trellis", ".template-hashes.json");
    const journal = fs.readFileSync(journalFile, "utf8");
    const hashes = fs.readFileSync(hashesFile, "utf8");

    const second = await initializeWorkspace({
      workspacePath: workspace,
      username: USERNAME,
      bundle: REAL_BUNDLE,
      now: FIXED_NOW,
      logger: SILENT_LOGGER
    });
    assert.deepEqual(second.createdFiles, []);
    assert.deepEqual(second.updatedFiles, []);
    assert.equal(second.changed, false);
    assert.equal(second.developerInitialized, false);
    assert.equal(fs.readFileSync(journalFile, "utf8"), journal);
    assert.equal(fs.readFileSync(hashesFile, "utf8"), hashes);
    assert.equal(fs.existsSync(path.join(workspace, ".git")), false);
  } finally {
    cleanup(workspace);
  }
});

test("已有 .trellis 只补齐缺失文件，保留用户文件与已有工具目录", async () => {
  const workspace = tempDir("trellis-workspace-existing-");
  try {
    fs.mkdirSync(path.join(workspace, ".trellis"), { recursive: true });
    fs.writeFileSync(path.join(workspace, ".trellis", "existing.txt"), "keep me\n");
    fs.mkdirSync(path.join(workspace, ".agents"), { recursive: true });
    fs.writeFileSync(path.join(workspace, ".agents", "custom.md"), "custom agents\n");
    fs.mkdirSync(path.join(workspace, ".opencode", "agents"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, ".opencode", "agents", "trellis-check.md"),
      "custom opencode\n"
    );
    fs.mkdirSync(path.join(workspace, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(workspace, ".codex", "custom.toml"), "custom codex\n");

    const result = await initializeWorkspace({
      workspacePath: workspace,
      username: USERNAME,
      bundle: REAL_BUNDLE,
      now: FIXED_NOW,
      logger: SILENT_LOGGER
    });
    assert.equal(
      fs.readFileSync(path.join(workspace, ".trellis", "existing.txt"), "utf8"),
      "keep me\n"
    );
    assert.equal(
      fs.readFileSync(path.join(workspace, ".agents", "custom.md"), "utf8"),
      "custom agents\n"
    );
    assert.equal(
      fs.readFileSync(path.join(workspace, ".opencode", "agents", "trellis-check.md"), "utf8"),
      "custom opencode\n"
    );
    assert.equal(
      fs.readFileSync(path.join(workspace, ".codex", "custom.toml"), "utf8"),
      "custom codex\n"
    );
    assert.ok(fs.readdirSync(path.join(workspace, ".opencode", "skills")).length > 0);
    assert.ok(result.skippedFiles.includes(".opencode/agents/trellis-check.md"));
    assert.ok(result.createdFiles.includes(".trellis/.developer"));
    assert.equal(fs.existsSync(path.join(workspace, ".git")), false);
  } finally {
    cleanup(workspace);
  }
});

test("按清单勾选可选工具，只生成所选目录", async () => {
  const workspace = tempDir("trellis-workspace-tools-");
  const narrow = tempDir("trellis-workspace-tools-narrow-");
  try {
    const result = await initializeWorkspace({
      workspacePath: workspace,
      username: USERNAME,
      bundle: REAL_BUNDLE,
      tools: [".opencode", ".agents", ".codex"],
      now: FIXED_NOW,
      logger: SILENT_LOGGER
    });
    assert.deepEqual(result.tools, [".opencode", ".agents", ".codex"]);
    assert.ok(fs.readdirSync(path.join(workspace, ".codex")).length > 0);
    assert.ok(result.createdFiles.includes(".codex/config.toml"));

    await initializeWorkspace({
      workspacePath: narrow,
      username: USERNAME,
      bundle: REAL_BUNDLE,
      tools: [".opencode"],
      now: FIXED_NOW,
      logger: SILENT_LOGGER
    });
    assert.ok(fs.readdirSync(path.join(narrow, ".opencode")).length > 0);
    assert.equal(fs.existsSync(path.join(narrow, ".agents")), false);
  } finally {
    cleanup(workspace);
    cleanup(narrow);
  }
});

test("developer 用户名不同默认中止且不写入模板文件", async () => {
  const workspace = tempDir("trellis-workspace-conflict-");
  try {
    fs.mkdirSync(path.join(workspace, ".trellis"), { recursive: true });
    const developerFile = path.join(workspace, ".trellis", ".developer");
    fs.writeFileSync(developerFile, "name=bob\ninitialized_at=2026-01-01T00:00:00\n");
    await assertErrorCode(initializeWorkspace({
      workspacePath: workspace,
      username: USERNAME,
      bundle: REAL_BUNDLE,
      now: FIXED_NOW,
      logger: SILENT_LOGGER
    }), WORKSPACE_ERROR_CODE.DEVELOPER_CONFLICT);
    assert.equal(fs.readFileSync(developerFile, "utf8"), "name=bob\ninitialized_at=2026-01-01T00:00:00\n");
    assert.equal(fs.existsSync(path.join(workspace, ".opencode")), false);
    assert.equal(fs.existsSync(path.join(workspace, ".agents")), false);
    assert.deepEqual(
      fs.readdirSync(workspace).filter((name) => name.startsWith(".trellis-backup-")),
      []
    );
  } finally {
    cleanup(workspace);
  }
});

test("显式确认后备份原 .developer 并切换为登录用户名", async () => {
  const workspace = tempDir("trellis-workspace-switch-");
  try {
    fs.mkdirSync(path.join(workspace, ".trellis"), { recursive: true });
    const oldContent = "name=bob\ninitialized_at=2026-01-01T00:00:00\n";
    fs.writeFileSync(path.join(workspace, ".trellis", ".developer"), oldContent);
    const result = await initializeWorkspace({
      workspacePath: workspace,
      username: USERNAME,
      bundle: REAL_BUNDLE,
      now: FIXED_NOW,
      logger: SILENT_LOGGER,
      confirmDeveloperSwitch: true
    });
    assert.equal(result.developerSwitched, true);
    assert.match(readDeveloper(workspace), /^name=alice$/m);
    assert.ok(result.backupDir?.startsWith(".trellis-backup-"));
    const backupFile = path.join(
      workspace,
      result.backupDir,
      ".trellis",
      ".developer"
    );
    assert.equal(fs.readFileSync(backupFile, "utf8"), oldContent);
    assert.ok(exists(workspace, ".trellis", "workspace", "bob", "journal-1.md") === false);
  } finally {
    cleanup(workspace);
  }
});

test("只读目录在写入前失败且不留半成品", async (t) => {
  if (process.platform === "win32") {
    t.skip("Windows 只读目录行为由 ACL 决定，Linux 验证覆盖");
    return;
  }
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    t.skip("root 不受目录权限限制");
    return;
  }
  const workspace = tempDir("trellis-workspace-readonly-");
  try {
    fs.chmodSync(workspace, 0o555);
    await assertErrorCode(initializeWorkspace({
      workspacePath: workspace,
      username: USERNAME,
      bundle: REAL_BUNDLE,
      now: FIXED_NOW,
      logger: SILENT_LOGGER
    }), WORKSPACE_ERROR_CODE.PATH_UNWRITABLE);
    assert.deepEqual(fs.readdirSync(workspace), []);
  } finally {
    cleanup(workspace);
  }
});

test("拒绝 zip slip 路径且不向目标目录外写入", async () => {
  const workspace = tempDir("trellis-workspace-zipslip-");
  try {
    const archive = buildTemplateZip({
      files: { "../evil.txt": "escaped\n" }
    });
    await assertErrorCode(initializeWorkspace({
      workspacePath: workspace,
      username: USERNAME,
      archive,
      now: FIXED_NOW,
      logger: SILENT_LOGGER
    }), WORKSPACE_ERROR_CODE.TEMPLATE_INVALID);
    assert.deepEqual(fs.readdirSync(workspace), []);
    assert.equal(fs.existsSync(path.join(path.dirname(workspace), "evil.txt")), false);
  } finally {
    cleanup(workspace);
  }
});

test("拒绝符号链接条目", async () => {
  const workspace = tempDir("trellis-workspace-symlink-");
  try {
    const manifest = {
      version: "test-template-1",
      defaultTools: [".opencode"],
      tools: [".opencode"],
      files: [".trellis", ".opencode"]
    };
    const archive = buildZip([
      { name: "template-manifest.json", data: JSON.stringify(manifest) },
      { name: ".trellis/scripts/init_developer.py", data: "print('test')\n" },
      { name: ".opencode/link", data: "/etc/passwd", mode: 0o120777 }
    ]);
    await assertErrorCode(initializeWorkspace({
      workspacePath: workspace,
      username: USERNAME,
      archive,
      now: FIXED_NOW,
      logger: SILENT_LOGGER
    }), WORKSPACE_ERROR_CODE.TEMPLATE_INVALID);
    assert.deepEqual(fs.readdirSync(workspace), []);
  } finally {
    cleanup(workspace);
  }
});

test("模板哈希不匹配时中止且不写入", async () => {
  const workspace = tempDir("trellis-workspace-hash-");
  try {
    await assertErrorCode(initializeWorkspace({
      workspacePath: workspace,
      username: USERNAME,
      archive: REAL_BUNDLE.archive,
      expectedSha256: "0".repeat(64),
      now: FIXED_NOW,
      logger: SILENT_LOGGER
    }), WORKSPACE_ERROR_CODE.TEMPLATE_HASH_MISMATCH);
    assert.deepEqual(fs.readdirSync(workspace), []);
  } finally {
    cleanup(workspace);
  }
});

test("下载哈希头不匹配时不写缓存也不初始化", async () => {
  const workspace = tempDir("trellis-workspace-download-hash-");
  const dataRoot = tempDir("trellis-agent-data-hash-");
  try {
    await assertErrorCode(downloadWorkspaceTemplate({
      serverUrl: "http://127.0.0.1:4317",
      teamId: "t1",
      agentCredential: CREDENTIAL,
      dataRoot,
      fetchImpl: async () => templateResponse(REAL_BUNDLE.archive, {
        sha: "0".repeat(64)
      })
    }), WORKSPACE_ERROR_CODE.TEMPLATE_HASH_MISMATCH);
    assert.equal(
      fs.existsSync(path.join(dataRoot, "templates", "workspace", "latest.json")),
      false
    );
  } finally {
    cleanup(workspace);
    cleanup(dataRoot);
  }
});

test("离线时回落到最近成功缓存并可初始化", async () => {
  const workspace = tempDir("trellis-workspace-offline-");
  const dataRoot = tempDir("trellis-agent-data-cache-");
  try {
    const downloaded = await downloadWorkspaceTemplate({
      serverUrl: "http://127.0.0.1:4317",
      teamId: "t1",
      agentCredential: CREDENTIAL,
      dataRoot,
      fetchImpl: async (url, options) => {
        assert.match(url, /\/api\/teams\/t1\/workspace-template$/);
        assert.equal(options.headers.authorization, `Bearer ${CREDENTIAL}`);
        return templateResponse(REAL_BUNDLE.archive);
      }
    });
    assert.equal(downloaded.source, "network");
    assert.equal(downloaded.sha256, REAL_BUNDLE.sha256);
    const cached = loadCachedWorkspaceTemplate({ dataRoot });
    assert.equal(cached.source, "cache");
    assert.equal(cached.sha256, REAL_BUNDLE.sha256);

    const result = await initializeWorkspace({
      workspacePath: workspace,
      username: USERNAME,
      serverUrl: "http://127.0.0.1:4317",
      teamId: "t1",
      agentCredential: CREDENTIAL,
      dataRoot,
      fetchImpl: async () => {
        throw new Error("offline");
      },
      now: FIXED_NOW,
      logger: SILENT_LOGGER
    });
    assert.equal(result.source, "cache");
    assert.ok(fs.readdirSync(path.join(workspace, ".opencode")).length > 0);
  } finally {
    cleanup(workspace);
    cleanup(dataRoot);
  }
});

test("无缓存且服务端不可达时中止且不留半成品", async () => {
  const workspace = tempDir("trellis-workspace-nocache-");
  const dataRoot = tempDir("trellis-agent-data-empty-");
  try {
    await assertErrorCode(initializeWorkspace({
      workspacePath: workspace,
      username: USERNAME,
      serverUrl: "http://127.0.0.1:4317",
      teamId: "t1",
      agentCredential: CREDENTIAL,
      dataRoot,
      fetchImpl: async () => {
        throw new Error("offline");
      },
      now: FIXED_NOW,
      logger: SILENT_LOGGER
    }), WORKSPACE_ERROR_CODE.TEMPLATE_UNAVAILABLE);
    assert.deepEqual(fs.readdirSync(workspace), []);
  } finally {
    cleanup(workspace);
    cleanup(dataRoot);
  }
});

test("拒绝根目录与符号链接 workspace 目标", async () => {
  await assertErrorCode(
    assertWorkspaceDirectory(path.parse(process.cwd()).root),
    WORKSPACE_ERROR_CODE.PATH_INVALID
  );
  await assertErrorCode(
    assertWorkspaceDirectory("relative/workspace"),
    WORKSPACE_ERROR_CODE.PATH_INVALID
  );
  if (process.platform === "win32") return;
  const real = tempDir("trellis-workspace-real-");
  const link = `${real}-link`;
  try {
    fs.symlinkSync(real, link, "dir");
    await assertErrorCode(
      assertWorkspaceDirectory(link),
      WORKSPACE_ERROR_CODE.PATH_INVALID
    );
  } finally {
    cleanup(link);
    cleanup(real);
  }
});

test("登录用户名不符合账号规则时拒绝初始化", async () => {
  const workspace = tempDir("trellis-workspace-username-");
  try {
    for (const username of ["ab", "../alice", "alice/bob", "alice bob"]) {
      await assertErrorCode(initializeWorkspace({
        workspacePath: workspace,
        username,
        bundle: REAL_BUNDLE,
        now: FIXED_NOW,
        logger: SILENT_LOGGER
      }), WORKSPACE_ERROR_CODE.USERNAME_INVALID);
    }
    assert.deepEqual(fs.readdirSync(workspace), []);
  } finally {
    cleanup(workspace);
  }
});
