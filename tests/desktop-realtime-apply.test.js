import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ConfigStore } from "../agent/config-store.js";
import {
  AgentLiveSync,
  decidePendingLiveChange,
  restoreLiveBackup
} from "../agent/live-sync.js";

const silentLogger = { info() {}, warn() {}, error() {} };

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function fakeWatcher() {
  return {
    on() {},
    close() {}
  };
}

function setupRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-live-agent-"));
  const repoPath = path.join(root, "repo");
  const taskDir = path.join(repoPath, ".trellis", "tasks", "task-live");
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, "task.json"), "{\"title\":\"local\"}\n");
  return { root, repoPath, taskDir };
}

function binding(repoPath) {
  return {
    localId: "local-1",
    serverBindingId: "binding-1",
    projectId: "p-live",
    repoPath,
    branchName: "main",
    teamId: "t-live",
    readOnly: false,
    syncStatus: "approved",
    displayName: "repo",
    createdAt: new Date().toISOString(),
    allowFileRemote: false,
    localRepoKey: "b".repeat(64),
    remoteIdentityKey: "c".repeat(64),
    lastSyncedAt: null,
    lastHead: null,
    lastError: null,
    lastErrorCode: null
  };
}

function fakeApi(overrides = {}) {
  const calls = { uploads: [], preflights: [], cursors: [] };
  return {
    calls,
    api: {
      preflightLiveChanges: async (input) => {
        calls.preflights.push(input);
        return { requiresConfirmation: false };
      },
      uploadLiveChanges: async (input) => {
        calls.uploads.push(input);
        return { revision: calls.uploads.length };
      },
      fetchLiveFiles: async () => ({ revision: 0, files: [] }),
      writeLiveCursor: async (input) => {
        calls.cursors.push(input);
        return { ok: true };
      },
      ...overrides
    }
  };
}

async function persistConfig(store, local) {
  await store.saveConfig({
    schemaVersion: 1,
    revision: "a".repeat(32),
    serverUrl: "http://127.0.0.1:4317",
    agentId: "agent-live",
    deviceName: "live-device",
    username: "writer",
    teamId: null,
    teams: [{ id: "t-live", name: "实时团队", role: "member" }],
    protocolVersion: 2,
    agentVersion: "0.1.0",
    pairedAt: new Date().toISOString(),
    bindings: [local]
  });
}

test("远端覆盖先备份，自触发事件被摘要抑制而真实修改继续上报", async (t) => {
  const { root, repoPath, taskDir } = setupRepo();
  const store = new ConfigStore(path.join(root, "agent"));
  await store.ensureDirectories();
  const local = binding(repoPath);
  await persistConfig(store, local);
  const remoteContent = "{\"title\":\"remote\"}\n";
  const controls = [];
  const fake = fakeApi({
    fetchLiveFiles: async () => ({
      revision: 3,
      files: [{
        path: ".trellis/tasks/task-live/task.json",
        operation: "upsert",
        revision: 3,
        sha256: sha256(remoteContent),
        content: remoteContent
      }]
    })
  });
  const sync = new AgentLiveSync({
    store,
    logger: silentLogger,
    emitControl: (event) => controls.push(event),
    watch: fakeWatcher,
    loadContext: async () => ({
      config: { bindings: [local] },
      api: fake.api
    })
  });
  await sync.start();
  t.after(() => {
    sync.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  await sync.pullProject("t-live", "p-live");
  assert.equal(
    fs.readFileSync(path.join(taskDir, "task.json"), "utf8"),
    remoteContent
  );
  assert.equal(controls[0].type, "remote_overwrite");
  const manifest = JSON.parse(fs.readFileSync(
    path.join(
      store.paths.liveBackupsDir,
      "p-live",
      controls[0].backupId,
      "manifest.json"
    ),
    "utf8"
  ));
  assert.equal(manifest.files.length, 1);

  await sync._handleWatcherEvents([{
    repositoryId: "p-live",
    trellisPath: ".trellis/tasks/task-live/task.json"
  }]);
  assert.equal(fake.calls.preflights.length, 0);

  const changed = "{\"title\":\"user-edit\"}\n";
  fs.writeFileSync(path.join(taskDir, "task.json"), changed);
  await sync._handleWatcherEvents([{
    repositoryId: "p-live",
    trellisPath: ".trellis/tasks/task-live/task.json"
  }]);
  assert.equal(fake.calls.uploads.length, 1);
  assert.equal(fake.calls.uploads[0].files[0].content, changed);
});

test("只读绑定只拉取服务端文件，不创建本地上传监听", async (t) => {
  const { root, repoPath, taskDir } = setupRepo();
  const store = new ConfigStore(path.join(root, "agent"));
  await store.ensureDirectories();
  const local = { ...binding(repoPath), readOnly: true };
  await persistConfig(store, local);
  const remoteContent = "{\"title\":\"readonly-remote\"}\n";
  const fake = fakeApi({
    fetchLiveFiles: async () => ({
      revision: 2,
      files: [{
        path: ".trellis/tasks/task-live/task.json",
        operation: "upsert",
        revision: 2,
        sha256: sha256(remoteContent),
        content: remoteContent
      }]
    })
  });
  const sync = new AgentLiveSync({
    store,
    logger: silentLogger,
    watch: fakeWatcher,
    loadContext: async () => ({
      config: { bindings: [local] },
      api: fake.api
    })
  });
  await sync.start();
  t.after(() => {
    sync.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  assert.deepEqual(sync.watcher.status().watchedRepositories, []);
  await sync.pullProject("t-live", "p-live");
  assert.equal(fs.readFileSync(path.join(taskDir, "task.json"), "utf8"), remoteContent);
  assert.equal(fake.calls.preflights.length, 0);
  assert.equal(fake.calls.uploads.length, 0);
});

test("客户端拒绝服务端返回 .trellis 白名单之外的路径", async (t) => {
  const { root, repoPath } = setupRepo();
  const store = new ConfigStore(path.join(root, "agent"));
  await store.ensureDirectories();
  const local = binding(repoPath);
  await persistConfig(store, local);
  const fake = fakeApi({
    fetchLiveFiles: async () => ({
      revision: 1,
      files: [{
        path: ".git/config",
        operation: "upsert",
        revision: 1,
        sha256: sha256("bad\n"),
        content: "bad\n"
      }]
    })
  });
  const sync = new AgentLiveSync({
    store,
    logger: silentLogger,
    watch: fakeWatcher,
    loadContext: async () => ({
      config: { bindings: [local] },
      api: fake.api
    })
  });
  await sync.start();
  t.after(() => {
    sync.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  await assert.rejects(
    () => sync.pullProject("t-live", "p-live"),
    /路径越界/
  );
  assert.equal(fs.existsSync(path.join(repoPath, ".git", "config")), false);
});

test("同一项目变化按任务拆分批次", async (t) => {
  const { root, repoPath, taskDir } = setupRepo();
  const secondDir = path.join(repoPath, ".trellis", "tasks", "task-second");
  fs.mkdirSync(secondDir, { recursive: true });
  fs.writeFileSync(path.join(secondDir, "task.json"), "{\"title\":\"second\"}\n");
  const store = new ConfigStore(path.join(root, "agent"));
  await store.ensureDirectories();
  const local = binding(repoPath);
  await persistConfig(store, local);
  const fake = fakeApi();
  const sync = new AgentLiveSync({
    store,
    logger: silentLogger,
    watch: fakeWatcher,
    loadContext: async () => ({
      config: { bindings: [local] },
      api: fake.api
    })
  });
  await sync.start();
  t.after(() => {
    sync.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  fs.writeFileSync(path.join(taskDir, "task.json"), "{\"title\":\"first\"}\n");
  await sync._handleWatcherEvents([
    { repositoryId: "p-live", trellisPath: ".trellis/tasks/task-live/task.json" },
    { repositoryId: "p-live", trellisPath: ".trellis/tasks/task-second/task.json" }
  ]);
  assert.equal(fake.calls.preflights.length, 2);
  assert.equal(fake.calls.uploads.length, 2);
  for (const upload of fake.calls.uploads) {
    const taskRoots = new Set(upload.files.map((file) =>
      taskKeysForTest(upload.projectId, file.path)
    ));
    assert.equal(taskRoots.size, 1);
  }
});

test("同一项目 watcher 批次严格串行，旧内容不会晚于新内容上传", async (t) => {
  const { root, repoPath, taskDir } = setupRepo();
  const store = new ConfigStore(path.join(root, "agent"));
  await store.ensureDirectories();
  const local = binding(repoPath);
  await persistConfig(store, local);
  const uploads = [];
  let releaseFirst;
  let firstStarted;
  const started = new Promise((resolve) => {
    firstStarted = resolve;
  });
  const fake = fakeApi({
    uploadLiveChanges: async (input) => {
      uploads.push(input);
      if (uploads.length === 1) {
        firstStarted();
        await new Promise((resolve) => {
          releaseFirst = resolve;
        });
      }
      return { revision: uploads.length };
    }
  });
  const sync = new AgentLiveSync({
    store,
    logger: silentLogger,
    watch: fakeWatcher,
    loadContext: async () => ({
      config: { bindings: [local] },
      api: fake.api
    })
  });
  await sync.start();
  t.after(() => {
    sync.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const firstContent = "{\"title\":\"first-write\"}\n";
  const secondContent = "{\"title\":\"second-write\"}\n";
  fs.writeFileSync(path.join(taskDir, "task.json"), firstContent);
  const first = sync._handleWatcherEvents([{
    repositoryId: "p-live",
    trellisPath: ".trellis/tasks/task-live/task.json"
  }]);
  await started;
  fs.writeFileSync(path.join(taskDir, "task.json"), secondContent);
  const second = sync._handleWatcherEvents([{
    repositoryId: "p-live",
    trellisPath: ".trellis/tasks/task-live/task.json"
  }]);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(uploads.length, 1);
  releaseFirst();
  await Promise.all([first, second]);
  assert.equal(uploads.length, 2);
  assert.equal(uploads[0].files[0].content, firstContent);
  assert.equal(uploads[1].files[0].content, secondContent);
});

test("网络失败后使用原 batchId 重试上传", async (t) => {
  const { root, repoPath, taskDir } = setupRepo();
  const store = new ConfigStore(path.join(root, "agent"));
  await store.ensureDirectories();
  const local = binding(repoPath);
  await persistConfig(store, local);
  const uploads = [];
  const fake = fakeApi({
    uploadLiveChanges: async (input) => {
      uploads.push(input);
      if (uploads.length === 1) throw new Error("network down");
      return { revision: 7 };
    }
  });
  const sync = new AgentLiveSync({
    store,
    logger: silentLogger,
    watch: fakeWatcher,
    loadContext: async () => ({
      config: { bindings: [local] },
      api: fake.api
    })
  });
  await sync.start();
  t.after(() => {
    sync.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  fs.writeFileSync(path.join(taskDir, "task.json"), "{\"title\":\"offline\"}\n");
  await sync._handleWatcherEvents([{
    repositoryId: "p-live",
    trellisPath: ".trellis/tasks/task-live/task.json"
  }]);
  assert.equal(uploads.length, 1);
  const pendingNames = fs.readdirSync(store.paths.pendingLiveDir);
  assert.equal(pendingNames.length, 1);
  const originalUnlink = fsPromises.unlink;
  let injectedUnlinkFailure = false;
  fsPromises.unlink = async (file) => {
    if (!injectedUnlinkFailure && String(file).endsWith(`${uploads[0].batchId}.json`)) {
      injectedUnlinkFailure = true;
      const error = new Error("模拟 Windows 文件占用");
      error.code = "EBUSY";
      throw error;
    }
    return originalUnlink(file);
  };
  t.after(() => {
    fsPromises.unlink = originalUnlink;
  });
  await sync.retryPendingUploads();
  assert.equal(uploads.length, 2);
  assert.equal(uploads[1].batchId, uploads[0].batchId);
  assert.equal(injectedUnlinkFailure, true);
  assert.equal(fs.readdirSync(store.paths.pendingLiveDir).length, 0);
});

function taskKeysForTest(projectId, filePath) {
  const relative = String(filePath).startsWith(".trellis/tasks/")
    ? String(filePath).slice(".trellis/tasks/".length).split("/")[0]
    : "";
  return relative ? `${projectId}::.trellis/tasks/${relative}` : null;
}

test("责任人警告持久化为待确认批次，继续推进时携带确认结果上传", async (t) => {
  const { root, repoPath, taskDir } = setupRepo();
  const store = new ConfigStore(path.join(root, "agent"));
  await store.ensureDirectories();
  const local = binding(repoPath);
  await persistConfig(store, local);
  const controls = [];
  const fake = fakeApi({
    preflightLiveChanges: async () => ({
      requiresConfirmation: true,
      warningId: "warning-live-1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      assignee: { username: "owner", displayName: "Owner" },
      task: {
        taskKey: "p-live::.trellis/tasks/task-live",
        title: "任务"
      }
    })
  });
  const sync = new AgentLiveSync({
    store,
    logger: silentLogger,
    emitControl: (event) => controls.push(event),
    watch: fakeWatcher,
    loadContext: async () => ({
      config: { bindings: [local] },
      api: fake.api
    })
  });
  await sync.start();
  t.after(() => {
    sync.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  fs.writeFileSync(path.join(taskDir, "task.json"), "{\"title\":\"changed\"}\n");
  await sync._handleWatcherEvents([{
    repositoryId: "p-live",
    trellisPath: ".trellis/tasks/task-live/task.json"
  }]);
  assert.equal(controls[0].type, "assignment_warning");
  assert.equal(fake.calls.uploads.length, 0);
  await sync._emitPendingDecisions();
  assert.equal(controls.length, 2);
  assert.equal(controls[1].pendingId, controls[0].pendingId);

  const decisionApi = {
    preflightLiveChanges: async () => ({
      requiresConfirmation: true,
      warningId: "warning-refreshed"
    }),
    uploadLiveChanges: async (input) => {
      fake.calls.uploads.push(input);
      return { revision: 4 };
    },
    fetchLiveFiles: async () => ({ revision: 0, files: [] }),
    writeLiveCursor: async () => ({ ok: true })
  };
  const result = await decidePendingLiveChange({
    store,
    credentialStore: {
      loadCredential: async () => "a".repeat(43)
    },
    apiClientFactory: () => decisionApi,
    pendingId: controls[0].pendingId,
    action: "continue"
  });
  assert.equal(result.revision, 4);
  assert.equal(fake.calls.uploads[0].assigneeDecision.action, "continue");
  assert.equal(fake.calls.uploads[0].assigneeDecision.warningId, "warning-refreshed");
  assert.equal(
    fs.existsSync(path.join(
      store.paths.pendingLiveDir,
      `${controls[0].pendingId}.json`
    )),
    false
  );
});

test("一键复原把备份作为新的实时批次上传", async (t) => {
  const { root, repoPath } = setupRepo();
  const store = new ConfigStore(path.join(root, "agent"));
  await store.ensureDirectories();
  const local = binding(repoPath);
  await persistConfig(store, local);
  const backupId = "backup-live-1";
  const backupRoot = path.join(store.paths.liveBackupsDir, "p-live", backupId);
  fs.mkdirSync(path.join(backupRoot, "files", "tasks", "task-live"), { recursive: true });
  const restored = "{\"title\":\"restored\"}\n";
  fs.writeFileSync(
    path.join(backupRoot, "files", "tasks", "task-live", "task.json"),
    restored
  );
  fs.writeFileSync(path.join(backupRoot, "manifest.json"), JSON.stringify({
    schemaVersion: 1,
    backupId,
    projectId: "p-live",
    revision: 3,
    files: [{
      path: ".trellis/tasks/task-live/task.json",
      existedLocally: true
    }]
  }));
  const uploads = [];
  const result = await restoreLiveBackup({
    store,
    credentialStore: {
      loadCredential: async () => "a".repeat(43)
    },
    apiClientFactory: () => ({
      preflightLiveChanges: async () => ({ requiresConfirmation: false }),
      uploadLiveChanges: async (input) => {
        uploads.push(input);
        return { revision: 5 };
      }
    }),
    backupId
  });
  assert.equal(result.revision, 5);
  assert.equal(uploads[0].files[0].content, restored);
  assert.equal(uploads[0].batchId.length > 8, true);
  assert.equal(
    fs.readFileSync(path.join(repoPath, ".trellis", "tasks", "task-live", "task.json"), "utf8"),
    restored
  );
  assert.equal(fs.existsSync(store.paths.liveSuppressionFile), true);
  const restoredManifest = JSON.parse(fs.readFileSync(
    path.join(backupRoot, "manifest.json"),
    "utf8"
  ));
  assert.equal(restoredManifest.restoreRevision, 5);
  assert.ok(restoredManifest.restoredAt);
});
