import fs from "node:fs";
import path from "node:path";
import { ERROR_CODES, teamError } from "./errors.js";
import { minimalEnvironment, runProcess } from "./process.js";
import {
  semanticLocalPathIdentityHash,
  semanticRemoteIdentityHash
} from "./remote-identity.js";

const RESERVED_BRANCHES = new Set([
  "HEAD",
  "FETCH_HEAD",
  "ORIG_HEAD",
  "MERGE_HEAD",
  "@"
]);
const SSH_COMMAND = "ssh -o BatchMode=yes -o StrictHostKeyChecking=yes";
const LOCAL_TIMEOUT = 30_000;
const REMOTE_TIMEOUT = 180_000;
const PUSH_TIMEOUT = 120_000;
const MAX_SAFE_REBASES = 3;

function isLoopback(hostname) {
  const host = String(hostname || "").toLowerCase();
  return host === "localhost" ||
    host === "::1" ||
    host === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(host);
}

export function validateSyncBranch(branch) {
  const value = String(branch || "").trim();
  if (
    !value ||
    value.length > 200 ||
    value.startsWith("-") ||
    value.startsWith("refs/") ||
    value.includes("\0") ||
    value.includes(" ") ||
    RESERVED_BRANCHES.has(value) ||
    /@\{-\d+\}/.test(value)
  ) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, "同步分支名无效");
  }
  return value;
}

export function normalizeGitRemote(remoteUrl, config) {
  const raw = String(remoteUrl || "").trim();
  if (
    !raw ||
    raw.length > 2048 ||
    raw.startsWith("-") ||
    /[\0\r\n]/.test(raw)
  ) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, "Git 远端地址无效");
  }

  if (/^https:\/\//i.test(raw) || /^ssh:\/\//i.test(raw)) {
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      throw teamError(400, ERROR_CODES.INVALID_INPUT, "Git 远端 URL 无效");
    }
    if (
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      (parsed.protocol === "https:" && parsed.username)
    ) {
      throw teamError(
        400,
        ERROR_CODES.INVALID_INPUT,
        "Git 远端不能包含凭证、query 或 fragment"
      );
    }
    const normalized = parsed.toString().replace(/\/+$/, "");
    return {
      url: normalized,
      identityHash: semanticRemoteIdentityHash(normalized)
    };
  }

  const scpMatch = raw.match(/^(?:([A-Za-z0-9._-]+)@)?([A-Za-z0-9.-]+):([^\\\s]+)$/);
  if (scpMatch && !/^[A-Za-z]:[\\/]/.test(raw) && !/^file:/i.test(raw)) {
    const normalized = `${scpMatch[1] ? `${scpMatch[1]}@` : ""}${scpMatch[2]}:${scpMatch[3]}`;
    return {
      url: normalized,
      identityHash: semanticRemoteIdentityHash(normalized)
    };
  }

  const canUseLocal = Boolean(config.allowLocalGitRemotes) &&
    isLoopback(config.publicUrl?.hostname);
  if (canUseLocal) {
    let localPath = raw;
    if (/^file:/i.test(raw)) {
      let parsed;
      try {
        parsed = new URL(raw);
      } catch {
        throw teamError(400, ERROR_CODES.INVALID_INPUT, "本地 Git 远端 URL 无效");
      }
      if (parsed.username || parsed.password || parsed.search || parsed.hash) {
        throw teamError(400, ERROR_CODES.INVALID_INPUT, "本地 Git 远端不能包含凭证");
      }
      localPath = decodeURIComponent(parsed.pathname);
      if (/^\/[A-Za-z]:\//.test(localPath)) localPath = localPath.slice(1);
    }
    const resolved = path.resolve(localPath);
    if (!fs.existsSync(resolved)) {
      throw teamError(400, ERROR_CODES.INVALID_INPUT, "本地 Git 远端不存在");
    }
    const normalized = resolved.replaceAll("\\", "/");
    return {
      url: normalized,
      identityHash: semanticLocalPathIdentityHash(normalized)
    };
  }

  throw teamError(
    400,
    ERROR_CODES.INVALID_INPUT,
    "生产环境 Git 远端只支持 HTTPS 或 SSH"
  );
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function projectFromRow(row) {
  return {
    id: row.repository_id,
    repositoryId: row.repository_id,
    name: row.repository_name,
    path: row.repository_path,
    workspaceKey: row.workspace_key,
    remoteUrl: row.remote_url,
    remoteIdentityHash: row.remote_identity_hash,
    syncBranch: row.sync_branch,
    trustedToolchainSha256: row.trusted_task_toolchain_sha256,
    syncStatus: row.sync_status,
    lastFetchAt: row.last_fetch_at,
    lastPushAt: row.last_push_at,
    lastError: row.last_error
  };
}

export function readGitProject(db, projectId) {
  const row = db.prepare(`
    SELECT
      p.*, r.name AS repository_name, r.path AS repository_path
    FROM team_project p
    JOIN repositories r ON r.id = p.repository_id
    WHERE p.repository_id = ?
  `).get(projectId);
  return row ? projectFromRow(row) : null;
}

export function createGitManager({
  db,
  config,
  dataDir
}) {
  const hooksDir = path.join(dataDir, ".empty-git-hooks");
  const projectsRoot = path.join(dataDir, "projects");
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.mkdirSync(projectsRoot, { recursive: true });
  const locks = new Map();

  function withProjectLock(projectId, callback) {
    const key = String(projectId || "");
    if (!key) return Promise.reject(new Error("缺少项目 ID"));
    const previous = locks.get(key) || Promise.resolve();
    const run = previous.catch(() => {}).then(callback);
    locks.set(key, run);
    run.finally(() => {
      if (locks.get(key) === run) locks.delete(key);
    }).catch(() => {});
    return run;
  }

  function gitEnvironment() {
    return minimalEnvironment({
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "Never",
      GIT_SSH_COMMAND: SSH_COMMAND,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      PYTHONUTF8: "1"
    });
  }

  function baseConfig(extra = []) {
    return [
      "-c", `core.hooksPath=${hooksDir}`,
      "-c", "core.autocrlf=false",
      "-c", "core.fsmonitor=false",
      "-c", "http.sslVerify=true",
      "-c", "commit.gpgsign=false",
      "-c", "credential.helper=",
      "-c", "protocol.ext.allow=never",
      "-c", `protocol.file.allow=${config.allowLocalGitRemotes ? "always" : "never"}`,
      "-c", "user.name=Trellis Team Service",
      "-c", "user.email=trellis-team@localhost",
      ...extra
    ];
  }

  async function runGit(args, {
    cwd = projectsRoot,
    timeoutMs = LOCAL_TIMEOUT,
    allowFailure = false
  } = {}) {
    return runProcess(
      "git",
      [...baseConfig(), ...args],
      {
        cwd,
        env: gitEnvironment(),
        timeoutMs,
        allowFailure
      }
    );
  }

  async function assertValidBranch(branch) {
    const value = validateSyncBranch(branch);
    const result = await runGit(
      ["check-ref-format", `refs/heads/${value}`],
      {
        cwd: projectsRoot,
        allowFailure: true
      }
    );
    if (result.code !== 0) {
      throw teamError(400, ERROR_CODES.INVALID_INPUT, "同步分支不符合 Git 引用格式");
    }
    return value;
  }

  async function cloneProject(project) {
    const target = path.join(projectsRoot, project.workspaceKey);
    if (fs.existsSync(target)) {
      throw teamError(409, ERROR_CODES.CONFLICT, "项目工作副本目录已存在");
    }
    const result = await runGit([
      "clone",
      `--branch=${project.syncBranch}`,
      "--single-branch",
      "--",
      project.remoteUrl,
      target
    ], {
      timeoutMs: REMOTE_TIMEOUT,
      allowFailure: true
    });
    if (result.code !== 0) {
      if (fs.existsSync(target)) {
        // 只清理本次以全新 UUID 创建的目录。
        fs.rmSync(target, { recursive: true, force: true });
      }
      throw teamError(
        502,
        ERROR_CODES.GIT_REMOTE_FAILED,
        `无法克隆项目：${result.stderr.trim() || result.stdout.trim() || "Git 失败"}`
      );
    }
    return target;
  }

  function assertProjectWorktree(project) {
    if (!project?.path) {
      throw teamError(409, ERROR_CODES.PROJECT_NOT_READY, "项目工作副本不存在");
    }
    const resolved = path.resolve(project.path);
    if (!isInside(projectsRoot, resolved) || !fs.existsSync(resolved)) {
      throw teamError(409, ERROR_CODES.PROJECT_REPAIR_REQUIRED, "项目工作副本路径无效");
    }
    const realRoot = fs.realpathSync(projectsRoot);
    const realProject = fs.realpathSync(resolved);
    if (!isInside(realRoot, realProject)) {
      throw teamError(409, ERROR_CODES.PROJECT_REPAIR_REQUIRED, "项目工作副本越界");
    }
    return realProject;
  }

  async function assertProjectBranch(project) {
    const cwd = assertProjectWorktree(project);
    const result = await runGit(
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      { cwd, allowFailure: true }
    );
    if (result.code !== 0 || result.stdout.trim() !== project.syncBranch) {
      throw teamError(
        409,
        ERROR_CODES.PROJECT_REPAIR_REQUIRED,
        "项目工作副本不在绑定的共享分支"
      );
    }
    return cwd;
  }

  async function assertClean(project) {
    const cwd = await assertProjectBranch(project);
    const result = await runGit(
      ["status", "--porcelain=v1", "--untracked-files=all"],
      { cwd }
    );
    const dirtyPaths = result.stdout.trim();
    if (dirtyPaths) {
      throw teamError(
        409,
        ERROR_CODES.PROJECT_REPAIR_REQUIRED,
        "项目工作副本存在未提交变更",
        { details: { dirtyPaths: dirtyPaths.split(/\r?\n/).slice(0, 50) } }
      );
    }
    return cwd;
  }

  async function fetchProject(project) {
    const cwd = await assertProjectBranch(project);
    const result = await runGit([
      "fetch",
      "--no-tags",
      "--",
      project.remoteUrl,
      `refs/heads/${project.syncBranch}`
    ], {
      cwd,
      timeoutMs: REMOTE_TIMEOUT,
      allowFailure: true
    });
    if (result.code !== 0) {
      throw teamError(
        502,
        ERROR_CODES.GIT_REMOTE_FAILED,
        `拉取远端失败：${result.stderr.trim() || result.stdout.trim() || "Git 失败"}`
      );
    }
    return cwd;
  }

  async function fetchAndFastForward(project) {
    const cwd = await fetchProject(project);
    const dirty = await runGit(
      ["status", "--porcelain=v1", "--untracked-files=all"],
      { cwd }
    );
    const dirtyPaths = dirty.stdout.trim();
    if (dirtyPaths) {
      throw teamError(
        409,
        ERROR_CODES.PROJECT_REPAIR_REQUIRED,
        "项目工作副本存在未提交变更",
        { details: { dirtyPaths: dirtyPaths.split(/\r?\n/).slice(0, 50) } }
      );
    }
    const merge = await runGit(
      ["merge", "--ff-only", "--no-overwrite-ignore", "FETCH_HEAD"],
      { cwd, allowFailure: true }
    );
    if (merge.code !== 0) {
      throw teamError(
        409,
        ERROR_CODES.PROJECT_REPAIR_REQUIRED,
        `无法快进同步：${merge.stderr.trim() || merge.stdout.trim() || "Git 失败"}`
      );
    }
    return cwd;
  }

  async function headSha(project) {
    const cwd = await assertProjectBranch(project);
    return (await runGit(["rev-parse", "HEAD"], { cwd })).stdout.trim();
  }

  function operationMessage(operation) {
    return {
      subject: `trellis(team): ${operation.operationType} ${operation.id}`,
      trailer: `Trellis-Operation: ${operation.id}`
    };
  }

  async function commitPaths(project, operation, relativePaths) {
    const cwd = await assertProjectBranch(project);
    const safePaths = relativePaths.map((value) => {
      const resolved = path.resolve(cwd, value);
      if (!isInside(cwd, resolved) || path.relative(cwd, resolved).startsWith(".git")) {
        throw teamError(400, ERROR_CODES.INVALID_INPUT, "提交路径无效");
      }
      return path.relative(cwd, resolved).replaceAll("\\", "/");
    });
    await runGit(["add", "--", ...safePaths], { cwd });
    const changed = await runGit(
      ["status", "--porcelain=v1", "--untracked-files=all"],
      { cwd }
    );
    const changedPaths = changed.stdout.split(/\r?\n/)
      .filter(Boolean)
      .map((line) => line.slice(3).replace(/^"|"$/g, "").replaceAll("\\", "/"));
    const expected = new Set(safePaths);
    const extra = changedPaths.filter((item) =>
      !safePaths.some((allowed) =>
        item === allowed ||
        item.startsWith(`${allowed}/`)
      )
    );
    if (extra.length) {
      throw teamError(
        409,
        ERROR_CODES.PROJECT_REPAIR_REQUIRED,
        `工作副本出现本次操作以外的变更：${extra.slice(0, 5).join(", ")}`
      );
    }
    const message = operationMessage(operation);
    await runGit(
      ["commit", "--no-gpg-sign", "-m", message.subject, "-m", message.trailer],
      { cwd }
    );
    return (await runGit(["rev-parse", "HEAD"], { cwd })).stdout.trim();
  }

  async function pushCommit(project, operation, localCommitSha) {
    const cwd = await assertProjectBranch(project);
    for (let attempt = 0; attempt <= MAX_SAFE_REBASES; attempt += 1) {
      const result = await runGit([
        "push",
        "--porcelain",
        "--",
        project.remoteUrl,
        `HEAD:refs/heads/${project.syncBranch}`
      ], {
        cwd,
        timeoutMs: PUSH_TIMEOUT,
        allowFailure: true
      });
      if (result.code === 0) {
        const remote = await runGit([
          "ls-remote",
          "--heads",
          "--",
          project.remoteUrl,
          `refs/heads/${project.syncBranch}`
        ], {
          cwd,
          timeoutMs: REMOTE_TIMEOUT
        });
        return {
          status: "pushed",
          remoteCommitSha: remote.stdout.trim().split(/\s+/)[0] || localCommitSha
        };
      }
      const nonFastForward = /non-fast-forward|fetch first/i.test(
        `${result.stderr}\n${result.stdout}`
      );
      if (!nonFastForward || attempt === MAX_SAFE_REBASES) {
        const network = /timed out|could not resolve|connection|authentication|permission/i
          .test(`${result.stderr}\n${result.stdout}`);
        throw teamError(
          network ? 502 : 503,
          ERROR_CODES.GIT_REMOTE_FAILED,
          "提交未能推送到远端，operation 已保留用于恢复",
          {
            recoverable: true,
            details: {
              operationId: operation.id,
              retryable: true
            }
          }
        );
      }
      await fetchProject(project);
      const rebase = await runGit(["rebase", "FETCH_HEAD"], {
        cwd,
        allowFailure: true
      });
      if (rebase.code !== 0) {
        await runGit(["rebase", "--abort"], { cwd, allowFailure: true });
        throw teamError(
          409,
          ERROR_CODES.PROJECT_REPAIR_REQUIRED,
          "远端分支发生冲突，项目需要管理员修复",
          {
            recoverable: true,
            details: { operationId: operation.id }
          }
        );
      }
      localCommitSha = (await runGit(["rev-parse", "HEAD"], { cwd })).stdout.trim();
    }
    throw teamError(503, ERROR_CODES.GIT_REMOTE_FAILED, "推送重试次数已用尽");
  }

  async function remoteContainsCommit(project, commitSha) {
    const cwd = await assertProjectBranch(project);
    await fetchProject(project);
    const result = await runGit(
      ["merge-base", "--is-ancestor", commitSha, "FETCH_HEAD"],
      { cwd, allowFailure: true }
    );
    return result.code === 0;
  }

  async function findOperationCommit(project, operationId) {
    const cwd = await assertProjectBranch(project);
    const result = await runGit([
      "log",
      "-1",
      "--format=%H",
      "--fixed-strings",
      `--grep=Trellis-Operation: ${operationId}`,
      "HEAD"
    ], { cwd });
    return result.stdout.trim() || null;
  }

  return {
    projectsRoot,
    withProjectLock,
    assertValidBranch,
    cloneProject,
    assertProjectWorktree,
    assertProjectBranch,
    assertClean,
    fetchProject,
    fetchAndFastForward,
    headSha,
    commitPaths,
    pushCommit,
    remoteContainsCommit,
    findOperationCommit,
    runGit
  };
}
