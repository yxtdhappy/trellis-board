import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { withTransaction } from "../database.js";
import { slugifyTaskTitle, TASK_SLUG_PATTERN } from "../../shared/slug.js";
import { resolveTaskLocation } from "../task-location.js";
import { setPendingAssignmentInTransaction, readAssignment } from "./assignments.js";
import { appendAuditEvent } from "./audit.js";
import { ERROR_CODES, teamError } from "./errors.js";
import { readGitProject } from "./git-manager.js";
import { CAPABILITIES, authorizeProject } from "./permissions.js";
import { minimalEnvironment, runProcess } from "./process.js";
import {
  computeScriptTreeHash,
  precheckLifecycleHooks,
  resolveDeveloperWorkspace
} from "./toolchain.js";

const PRIORITIES = new Set(["P0", "P1", "P2", "P3"]);

function cleanText(value, label, max, { allowEmpty = false } = {}) {
  if (typeof value !== "string") {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, `${label}必须是字符串`);
  }
  const result = value.trim();
  if (!allowEmpty && !result) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, `${label}不能为空`);
  }
  if (Array.from(result).length > max || result.includes("\0")) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, `${label}不能超过 ${max} 个字符`);
  }
  return result;
}

function normalizeCreateInput(actor, projectId, input) {
  const title = cleanText(input.title, "任务标题", 200);
  if (title.startsWith("-")) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, "任务标题不能以 - 开头");
  }
  const description = cleanText(input.description, "任务描述", 3000);
  const priority = cleanText(input.priority || "P2", "优先级", 2);
  if (!PRIORITIES.has(priority)) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, "优先级只能是 P0、P1、P2、P3");
  }
  const requestedSlug = input.slug == null || input.slug === ""
    ? ""
    : cleanText(input.slug, "任务标识", 100).toLowerCase();
  const slug = requestedSlug || slugifyTaskTitle(title);
  if (!slug || !TASK_SLUG_PATTERN.test(slug)) {
    throw teamError(
      400,
      ERROR_CODES.INVALID_INPUT,
      "任务标识只能包含小写英文字母、数字和单个中划线"
    );
  }
  const packageName = input.packageName == null || input.packageName === ""
    ? null
    : cleanText(input.packageName, "包名", 100);
  if (packageName?.startsWith("-")) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, "包名不能以 - 开头");
  }
  return {
    projectId,
    title,
    description,
    priority,
    slug,
    packageName,
    assignee: String(input.assigneeUserId || input.assignee || "").trim(),
    actorUserId: actor.userId
  };
}

function normalizeIdempotencyKey(value) {
  const key = String(value || "").trim();
  if (!/^[A-Za-z0-9._:-]{8,200}$/.test(key)) {
    throw teamError(
      400,
      ERROR_CODES.INVALID_INPUT,
      "idempotencyKey 必须是 8 到 200 位安全字符"
    );
  }
  return key;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableValue(value[key])])
  );
}

function requestHash(value) {
  return crypto.createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex");
}

function fileVersion(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function operationObject(row) {
  if (!row) return null;
  let result = {};
  try {
    result = JSON.parse(row.result_json);
  } catch {
    // 损坏结果不泄露内部路径，只保留操作状态。
  }
  return {
    id: row.id,
    projectId: row.project_id,
    actorUserId: row.actor_user_id,
    operationType: row.operation_type,
    status: row.status,
    baseTaskVersion: row.base_task_version || null,
    result,
    error: row.error_message || null,
    localCommitSha: row.local_commit_sha || null,
    remoteCommitSha: row.remote_commit_sha || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function readOperation(db, operationId) {
  return db.prepare("SELECT * FROM git_operation WHERE id = ?").get(operationId) || null;
}

function updateOperation(db, operationId, {
  status,
  result = undefined,
  error = undefined,
  localCommitSha = undefined,
  remoteCommitSha = undefined
}) {
  const current = readOperation(db, operationId);
  if (!current) throw teamError(404, ERROR_CODES.NOT_FOUND, "Git 操作不存在");
  db.prepare(`
    UPDATE git_operation
    SET status = ?, result_json = ?, error_message = ?,
        local_commit_sha = ?, remote_commit_sha = ?, updated_at = ?
    WHERE id = ?
  `).run(
    status ?? current.status,
    result === undefined ? current.result_json : JSON.stringify(result),
    error === undefined ? current.error_message : error,
    localCommitSha === undefined ? current.local_commit_sha : localCommitSha,
    remoteCommitSha === undefined ? current.remote_commit_sha : remoteCommitSha,
    new Date().toISOString(),
    operationId
  );
}

function setProjectStatus(db, projectId, status, error = null) {
  db.prepare(`
    UPDATE team_project
    SET sync_status = ?, last_error = ?, updated_at = ?
    WHERE repository_id = ?
  `).run(status, error == null ? null : String(error).slice(0, 1000), new Date().toISOString(), projectId);
}

export function createTaskWriteService({
  db,
  gitManager,
  projectService,
  taskIndex
}) {
  function findProjectForInput(actor, projectId) {
    authorizeProject(actor, projectId, CAPABILITIES.WRITE_TASK, { db });
    const project = readGitProject(db, projectId);
    if (!project) throw teamError(404, ERROR_CODES.NOT_FOUND, "项目不存在");
    return project;
  }

  function resolveAssignee(projectId, value, { allowReadOnly = false } = {}) {
    const input = String(value || "").trim();
    if (!input) throw teamError(400, ERROR_CODES.INVALID_INPUT, "缺少负责人");
    const member = db.prepare(`
      SELECT
        m.user_id, m.role, m.trellis_dev_id,
        u.username, u.display_name, u.status
      FROM project_member m
      JOIN user_account u ON u.id = m.user_id
      WHERE m.project_id = ?
        AND (m.user_id = ? OR m.trellis_dev_id = ? COLLATE NOCASE)
      ORDER BY CASE WHEN m.user_id = ? THEN 0 ELSE 1 END
      LIMIT 1
    `).get(projectId, input, input, input);
    if (!member || member.status !== "active") {
      throw teamError(400, ERROR_CODES.INVALID_INPUT, "负责人不是项目有效成员");
    }
    if (!allowReadOnly && member.role === "read_only") {
      throw teamError(400, ERROR_CODES.INVALID_INPUT, "只读成员不能成为任务负责人");
    }
    if (!member.trellis_dev_id) {
      throw teamError(400, ERROR_CODES.INVALID_INPUT, "负责人尚未映射 Trellis developer ID");
    }
    return member;
  }

  function assertTrustedToolchain(project) {
    const toolchain = computeScriptTreeHash(project.path);
    if (toolchain.sha256 !== project.trustedToolchainSha256) {
      setProjectStatus(db, project.id, "stale", "工具链摘要发生变化");
      taskIndex.incrementQueryRevision();
      throw teamError(
        409,
        ERROR_CODES.TOOLCHAIN_MISMATCH,
        "项目工具链摘要已变化，管理员重新批准前不能写任务"
      );
    }
    return toolchain;
  }

  async function runTaskPython(project, developerId, args) {
    const script = path.join(project.path, ".trellis", "scripts", "task.py");
    if (!fs.existsSync(script)) {
      throw teamError(409, ERROR_CODES.TOOLCHAIN_MISMATCH, "项目缺少 task.py");
    }
    await precheckLifecycleHooks(project.path);
    return runProcess("python", ["-B", script, ...args], {
      cwd: project.path,
      env: minimalEnvironment({
        PYTHONUTF8: "1",
        TRELLIS_DEVELOPER: developerId
      }),
      timeoutMs: 120_000
    });
  }

  function taskDirectories(repoPath) {
    const root = path.join(repoPath, ".trellis", "tasks");
    if (!fs.existsSync(root)) return new Set();
    return new Set(
      fs.readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name !== "archive")
        .map((entry) => entry.name)
    );
  }

  function cleanupCreatedTask(tasksRoot, before, after) {
    const created = [...after].filter((name) => !before.has(name));
    if (created.length !== 1) return null;
    const target = path.join(tasksRoot, created[0]);
    const relative = path.relative(tasksRoot, target);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
    fs.rmSync(target, { recursive: true, force: true });
    return path.join(".trellis", "tasks", created[0]).replaceAll("\\", "/");
  }

  function atomicWriteJson(filePath, value) {
    const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    try {
      fs.renameSync(temporary, filePath);
    } catch (error) {
      try {
        fs.unlinkSync(temporary);
      } catch {
        // 临时文件可能已被重命名。
      }
      throw error;
    }
  }

  function insertPreparedOperation({
    actor,
    projectId,
    operationType,
    idempotencyKey,
    hash,
    baseTaskVersion,
    result
  }) {
    const existing = db.prepare(`
      SELECT *
      FROM git_operation
      WHERE actor_user_id = ? AND project_id = ?
        AND operation_type = ? AND idempotency_key = ?
    `).get(actor.userId, projectId, operationType, idempotencyKey);
    if (existing) {
      if (existing.request_hash !== hash) {
        throw teamError(
          409,
          ERROR_CODES.IDEMPOTENCY_CONFLICT,
          "同一 idempotencyKey 已用于不同请求"
        );
      }
      return { operation: existing, replay: true };
    }
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO git_operation(
        id, project_id, actor_user_id, operation_type, idempotency_key,
        request_hash, status, base_task_version, result_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'prepared', ?, ?, ?, ?)
    `).run(
      id,
      projectId,
      actor.userId,
      operationType,
      idempotencyKey,
      hash,
      baseTaskVersion,
      JSON.stringify(result),
      now,
      now
    );
    return { operation: readOperation(db, id), replay: false };
  }

  function replayOperation(operation) {
    const value = operationObject(operation);
    if (operation.status === "applied") {
      return { statusCode: 200, ...value };
    }
    if (["prepared", "committed", "pending_push", "pushed"].includes(operation.status)) {
      return { statusCode: 202, ...value, pending: true };
    }
    throw teamError(
      502,
      ERROR_CODES.GIT_REMOTE_FAILED,
      operation.error_message || "此前任务写入失败，请使用新的幂等键重试",
      { details: { operationId: operation.id } }
    );
  }

  function ensurePendingAssignmentInTransaction({
    projectId,
    executionTaskKey,
    assignedUserId,
    assignedBy,
    taskVersion
  }) {
    const current = readAssignment(db, executionTaskKey);
    if (
      current &&
      current.assignedUserId === assignedUserId &&
      current.baseTaskVersion === taskVersion
    ) {
      return current;
    }
    return setPendingAssignmentInTransaction(db, {
      projectId,
      executionTaskKey,
      assignedUserId,
      assignedBy,
      baseTaskVersion: taskVersion
    });
  }

  async function applyOperation(operation) {
    if (operation.status === "applied") return operationObject(operation);
    const project = readGitProject(db, operation.project_id);
    if (!project) throw teamError(404, ERROR_CODES.NOT_FOUND, "项目不存在");
    let result = {};
    try {
      result = JSON.parse(operation.result_json);
    } catch {
      throw teamError(409, ERROR_CODES.PROJECT_REPAIR_REQUIRED, "Git 操作结果损坏");
    }
    let scan;
    try {
      scan = await taskIndex.scanAndIndexProject(project, {
        branchSha: operation.remote_commit_sha || operation.local_commit_sha,
        force: true
      });
    } catch (error) {
      setProjectStatus(db, project.id, "needs_repair", error.message);
      taskIndex.incrementQueryRevision();
      throw teamError(
        503,
        ERROR_CODES.PROJECT_REPAIR_REQUIRED,
        "Git 已推送，但看板索引刷新失败，需要管理员修复",
        { recoverable: true, details: { operationId: operation.id } }
      );
    }
    const relativeDir = result.relativeDir;
    let task = null;
    if (relativeDir) {
      task = (scan.board.tasks || []).find((candidate) =>
        candidate.relativeDir === relativeDir
      ) || null;
    } else if (result.executionTaskKey) {
      task = (scan.board.tasks || []).find((candidate) =>
        candidate.executionTaskKey === result.executionTaskKey
      ) || null;
    }
    if (!task?.executionTaskKey) {
      setProjectStatus(
        db,
        project.id,
        "needs_repair",
        "Git 已推送，但无法在新索引中定位任务"
      );
      taskIndex.incrementQueryRevision();
      throw teamError(
        503,
        ERROR_CODES.PROJECT_REPAIR_REQUIRED,
        "Git 已推送，但无法在新索引中定位任务",
        { recoverable: true, details: { operationId: operation.id } }
      );
    }
    const assignedUserId = result.assignedUserId ||
      db.prepare(`
        SELECT m.user_id
        FROM project_member m
        WHERE m.project_id = ? AND m.trellis_dev_id = ? COLLATE NOCASE
      `).get(project.id, task.assignee)?.user_id;
    if (!assignedUserId) {
      setProjectStatus(
        db,
        project.id,
        "needs_repair",
        "任务的负责人映射已不存在"
      );
      taskIndex.incrementQueryRevision();
      throw teamError(409, ERROR_CODES.PROJECT_REPAIR_REQUIRED, "任务的负责人映射已不存在");
    }
    withTransaction(db, () => {
      ensurePendingAssignmentInTransaction({
        projectId: project.id,
        executionTaskKey: task.executionTaskKey,
        assignedUserId,
        assignedBy: operation.actor_user_id,
        taskVersion: task.taskVersion
      });
      db.prepare(`
        UPDATE team_project
        SET sync_status = 'current', last_push_at = ?, last_error = NULL, updated_at = ?
        WHERE repository_id = ?
      `).run(new Date().toISOString(), new Date().toISOString(), project.id);
      updateOperation(db, operation.id, {
        status: "applied",
        result: {
          ...result,
          executionTaskKey: task.executionTaskKey,
          taskVersion: task.taskVersion,
          assignedUserId,
          assignmentVersion: readAssignment(db, task.executionTaskKey)?.version || null
        },
        error: null
      });
      appendAuditEvent(db, {
        actorUserId: operation.actor_user_id,
        projectId: project.id,
        action: `${operation.operation_type}_applied`,
        targetType: "task",
        targetId: task.executionTaskKey,
        detail: {
          operationId: operation.id,
          taskVersion: task.taskVersion
        }
      });
    });
    return operationObject(readOperation(db, operation.id));
  }

  async function recoverOperationUnlocked(operation) {
    if (operation.status === "applied") return operation;
    const project = readGitProject(db, operation.project_id);
    if (!project) throw teamError(404, ERROR_CODES.NOT_FOUND, "项目不存在");
    let commit = operation.local_commit_sha ||
      await gitManager.findOperationCommit(project, operation.id);
    if (!commit) {
      if (operation.status === "prepared") {
        const clean = await gitManager.runGit(
          ["status", "--porcelain=v1", "--untracked-files=all"],
          { cwd: project.path, allowFailure: true }
        );
        if (clean.code === 0 && !clean.stdout.trim()) {
          updateOperation(db, operation.id, {
            status: "failed",
            error: "操作在修改工作副本前中断"
          });
          return readOperation(db, operation.id);
        }
      }
      setProjectStatus(db, project.id, "needs_repair", "存在无法归属的本地变更");
      taskIndex.incrementQueryRevision();
      throw teamError(
        409,
        ERROR_CODES.PROJECT_REPAIR_REQUIRED,
        "存在无法归属的 Git 操作，需要管理员修复",
        { details: { operationId: operation.id } }
      );
    }
    if (!operation.local_commit_sha) {
      updateOperation(db, operation.id, {
        status: "committed",
        localCommitSha: commit
      });
    }
    const remoteContains = await gitManager.remoteContainsCommit(project, commit);
    if (!remoteContains) {
      try {
        const pushed = await gitManager.pushCommit(project, operation, commit);
        commit = await gitManager.headSha(project);
        updateOperation(db, operation.id, {
          status: "pushed",
          localCommitSha: commit,
          remoteCommitSha: pushed.remoteCommitSha,
          error: null
        });
      } catch (error) {
        updateOperation(db, operation.id, {
          status: "pending_push",
          error: String(error.message || "push 失败").slice(0, 1000)
        });
        setProjectStatus(db, project.id, "pending_push", error.message);
        taskIndex.incrementQueryRevision();
        throw error;
      }
    } else {
      updateOperation(db, operation.id, {
        status: "pushed",
        localCommitSha: commit,
        remoteCommitSha: commit,
        error: null
      });
    }
    return applyOperation(readOperation(db, operation.id));
  }

  async function recoverProjectUnlocked(projectId) {
    const project = readGitProject(db, projectId);
    if (!project || project.syncStatus === "needs_repair") return false;
    const operations = db.prepare(`
      SELECT *
      FROM git_operation
      WHERE project_id = ?
        AND status IN ('prepared', 'committed', 'pending_push', 'pushed')
      ORDER BY created_at, id
    `).all(projectId);
    for (const operation of operations) {
      try {
        await recoverOperationUnlocked(operation);
      } catch {
        return false;
      }
    }
    return true;
  }

  async function executeCreate(actor, project, input, idempotencyKey) {
    const normalized = normalizeCreateInput(actor, project.id, input);
    const assignee = resolveAssignee(project.id, normalized.assignee);
    const actorMember = resolveAssignee(project.id, actor.userId);
    assertTrustedToolchain(project);
    await precheckLifecycleHooks(project.path);
    resolveDeveloperWorkspace(project.path, assignee.trellis_dev_id);
    resolveDeveloperWorkspace(project.path, actorMember.trellis_dev_id);
    await gitManager.fetchAndFastForward(project);
    await gitManager.assertClean(project);

    const hash = requestHash({
      operation: "create_task",
      projectId: project.id,
      title: normalized.title,
      description: normalized.description,
      priority: normalized.priority,
      slug: normalized.slug,
      packageName: normalized.packageName,
      assigneeUserId: assignee.user_id
    });
    const prepared = insertPreparedOperation({
      actor,
      projectId: project.id,
      operationType: "create_task",
      idempotencyKey,
      hash,
      baseTaskVersion: null,
      result: {
        projectId: project.id,
        assignedUserId: assignee.user_id,
        relativeDir: null
      }
    });
    if (prepared.replay) return replayOperation(prepared.operation);
    const operation = prepared.operation;
    const tasksRoot = path.join(project.path, ".trellis", "tasks");
    const before = taskDirectories(project.path);
    let createdRelativeDir = null;
    try {
      const args = [
        "create",
        normalized.title,
        `--description=${normalized.description}`,
        `--assignee=${assignee.trellis_dev_id}`,
        `--priority=${normalized.priority}`,
        `--slug=${normalized.slug}`,
        "--no-start",
        `--base-branch=${project.syncBranch}`
      ];
      if (normalized.packageName) args.push(`--package=${normalized.packageName}`);
      const pythonResult = await runTaskPython(
        project,
        actorMember.trellis_dev_id,
        args
      );
      const after = taskDirectories(project.path);
      const created = [...after].filter((name) => !before.has(name));
      if (created.length !== 1) {
        throw teamError(
          409,
          ERROR_CODES.PROJECT_REPAIR_REQUIRED,
          "task.py 未返回唯一的新任务目录"
        );
      }
      createdRelativeDir = path.join(".trellis", "tasks", created[0]).replaceAll("\\", "/");
      const taskJsonPath = path.join(project.path, createdRelativeDir, "task.json");
      if (!fs.existsSync(taskJsonPath)) {
        throw teamError(409, ERROR_CODES.PROJECT_REPAIR_REQUIRED, "task.py 未生成 task.json");
      }
      const taskData = JSON.parse(fs.readFileSync(taskJsonPath, "utf8"));
      taskData.branch = project.syncBranch;
      taskData.base_branch = null;
      atomicWriteJson(taskJsonPath, taskData);
      const changeResult = await gitManager.runGit(
        ["status", "--porcelain=v1", "--untracked-files=all"],
        { cwd: project.path }
      );
      const changedPaths = changeResult.stdout.split(/\r?\n/)
        .filter(Boolean)
        .map((line) => line.slice(3).replace(/^"|"$/g, "").replaceAll("\\", "/"));
      if (
        !changedPaths.length ||
        changedPaths.some((item) =>
          item !== createdRelativeDir && !item.startsWith(`${createdRelativeDir}/`)
        )
      ) {
        throw teamError(
          409,
          ERROR_CODES.PROJECT_REPAIR_REQUIRED,
          "task.py 产生了预期之外的工作副本变更"
        );
      }
      const localCommitSha = await gitManager.commitPaths(
        project,
        operationObject(operation),
        [createdRelativeDir]
      );
      updateOperation(db, operation.id, {
        status: "committed",
        result: {
          projectId: project.id,
          assignedUserId: assignee.user_id,
          relativeDir: createdRelativeDir
        },
        localCommitSha
      });
      let pushed;
      try {
        pushed = await gitManager.pushCommit(
          project,
          operationObject(readOperation(db, operation.id)),
          localCommitSha
        );
      } catch (error) {
        updateOperation(db, operation.id, {
          status: "pending_push",
          error: String(error.message || "push 失败").slice(0, 1000)
        });
        setProjectStatus(db, project.id, "pending_push", error.message);
        taskIndex.incrementQueryRevision();
        throw error;
      }
      updateOperation(db, operation.id, {
        status: "pushed",
        remoteCommitSha: pushed.remoteCommitSha,
        localCommitSha: await gitManager.headSha(project)
      });
      return {
        statusCode: 201,
        ...(await applyOperation(readOperation(db, operation.id)))
      };
    } catch (error) {
      if (readOperation(db, operation.id)?.status === "prepared") {
        const after = taskDirectories(project.path);
        const status = await gitManager.runGit(
          ["status", "--porcelain=v1", "--untracked-files=all"],
          { cwd: project.path, allowFailure: true }
        );
        if (status.code === 0 && !status.stdout.trim()) {
          updateOperation(db, operation.id, {
            status: "failed",
            error: String(error.message || "创建任务失败").slice(0, 1000)
          });
        } else {
          if (after.size === before.size + 1) {
            cleanupCreatedTask(tasksRoot, before, after);
          }
          const afterCleanup = await gitManager.runGit(
            ["status", "--porcelain=v1", "--untracked-files=all"],
            { cwd: project.path, allowFailure: true }
          );
          if (afterCleanup.code === 0 && !afterCleanup.stdout.trim()) {
            updateOperation(db, operation.id, {
              status: "failed",
              error: String(error.message || "创建任务失败").slice(0, 1000)
            });
          } else {
            updateOperation(db, operation.id, {
              status: "pending_push",
              error: String(error.message || "创建任务失败").slice(0, 1000)
            });
            setProjectStatus(db, project.id, "needs_repair", error.message);
            taskIndex.incrementQueryRevision();
          }
        }
      }
      throw error;
    }
  }

  async function executeAssign(actor, project, input, idempotencyKey) {
    const executionTaskKey = String(input.executionTaskKey || "").trim();
    if (!executionTaskKey.startsWith(`${project.id}::`)) {
      throw teamError(400, ERROR_CODES.INVALID_INPUT, "任务执行身份不属于当前项目");
    }
    const expectedTaskVersion = String(input.expectedTaskVersion || "").trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(expectedTaskVersion)) {
      throw teamError(400, ERROR_CODES.INVALID_INPUT, "expectedTaskVersion 无效");
    }
    const assignee = resolveAssignee(project.id, input.assigneeUserId || input.assignee);
    const actorMember = resolveAssignee(project.id, actor.userId);
    assertTrustedToolchain(project);
    await precheckLifecycleHooks(project.path);
    resolveDeveloperWorkspace(project.path, assignee.trellis_dev_id);
    await gitManager.fetchAndFastForward(project);
    await gitManager.assertClean(project);
    const cached = taskIndex.readProjectScanCache(project.id);
    const indexedTask = db.prepare(`
      SELECT relative_dir
      FROM team_task_index
      WHERE project_id = ? AND execution_task_key = ?
    `).get(project.id, executionTaskKey);
    const taskPath = String(input.taskPath || indexedTask?.relative_dir || "").trim();
    if (!taskPath) {
      throw teamError(404, ERROR_CODES.NOT_FOUND, "团队索引中未找到任务");
    }
    const projectForResolver = {
      id: project.id,
      name: project.name,
      path: project.path
    };
    const resolved = resolveTaskLocation({
      projectId: project.id,
      taskPath
    }, {
      repositories: [projectForResolver],
      currentBoard: cached?.board || null,
      db
    });
    if (resolved.identityConflict || resolved.task.executionTaskKey !== executionTaskKey) {
      throw teamError(409, ERROR_CODES.CONFLICT, "任务执行身份冲突，请刷新后重试");
    }
    const taskJsonPath = path.join(project.path, resolved.task.relativeDir, "task.json");
    if (fileVersion(taskJsonPath) !== expectedTaskVersion || resolved.task.archived) {
      throw teamError(
        409,
        ERROR_CODES.VERSION_CONFLICT,
        "任务版本已变化或已归档，请刷新后重试"
      );
    }
    const hash = requestHash({
      operation: "assign_task",
      projectId: project.id,
      executionTaskKey,
      assigneeUserId: assignee.user_id,
      expectedTaskVersion
    });
    const prepared = insertPreparedOperation({
      actor,
      projectId: project.id,
      operationType: "assign_task",
      idempotencyKey,
      hash,
      baseTaskVersion: expectedTaskVersion,
      result: {
        projectId: project.id,
        executionTaskKey,
        relativeDir: resolved.task.relativeDir,
        assignedUserId: assignee.user_id
      }
    });
    if (prepared.replay) return replayOperation(prepared.operation);
    const operation = prepared.operation;
    try {
      const taskData = JSON.parse(fs.readFileSync(taskJsonPath, "utf8"));
      taskData.assignee = assignee.trellis_dev_id;
      atomicWriteJson(taskJsonPath, taskData);
      const localCommitSha = await gitManager.commitPaths(
        project,
        operationObject(operation),
        [path.posix.join(resolved.task.relativeDir, "task.json")]
      );
      updateOperation(db, operation.id, {
        status: "committed",
        localCommitSha
      });
      let pushed;
      try {
        pushed = await gitManager.pushCommit(
          project,
          operationObject(readOperation(db, operation.id)),
          localCommitSha
        );
      } catch (error) {
        updateOperation(db, operation.id, {
          status: "pending_push",
          error: String(error.message || "push 失败").slice(0, 1000)
        });
        setProjectStatus(db, project.id, "pending_push", error.message);
        taskIndex.incrementQueryRevision();
        throw error;
      }
      updateOperation(db, operation.id, {
        status: "pushed",
        remoteCommitSha: pushed.remoteCommitSha,
        localCommitSha: await gitManager.headSha(project)
      });
      return {
        statusCode: 200,
        ...(await applyOperation(readOperation(db, operation.id)))
      };
    } catch (error) {
      if (readOperation(db, operation.id)?.status === "prepared") {
        const currentVersion = fs.existsSync(taskJsonPath)
          ? fileVersion(taskJsonPath)
          : null;
        if (currentVersion === expectedTaskVersion) {
          updateOperation(db, operation.id, {
            status: "failed",
            error: String(error.message || "委派失败").slice(0, 1000)
          });
        } else {
          updateOperation(db, operation.id, {
            status: "pending_push",
            error: String(error.message || "委派失败").slice(0, 1000)
          });
          setProjectStatus(db, project.id, "needs_repair", error.message);
          taskIndex.incrementQueryRevision();
        }
      }
      throw error;
    }
  }

  async function createTask(actor, input = {}) {
    const projectId = String(input.projectId || input.repositoryId || "").trim();
    const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
    const project = findProjectForInput(actor, projectId);
    return gitManager.withProjectLock(projectId, async () => {
      if (!(await recoverProjectUnlocked(projectId))) {
        throw teamError(
          503,
          ERROR_CODES.GIT_REMOTE_FAILED,
          "项目存在尚未恢复的 Git 操作",
          { recoverable: true }
        );
      }
      return executeCreate(actor, project, input, idempotencyKey);
    });
  }

  async function assignTask(actor, input = {}) {
    const executionTaskKey = String(input.executionTaskKey || "").trim();
    const projectId = executionTaskKey.split("::")[0];
    const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
    const project = findProjectForInput(actor, projectId);
    return gitManager.withProjectLock(projectId, async () => {
      if (!(await recoverProjectUnlocked(projectId))) {
        throw teamError(
          503,
          ERROR_CODES.GIT_REMOTE_FAILED,
          "项目存在尚未恢复的 Git 操作",
          { recoverable: true }
        );
      }
      return executeAssign(actor, project, input, idempotencyKey);
    });
  }

  async function retry(actor, operationId) {
    const operation = readOperation(db, String(operationId || "").trim());
    if (!operation) throw teamError(404, ERROR_CODES.NOT_FOUND, "Git 操作不存在");
    const access = authorizeProject(
      actor,
      operation.project_id,
      CAPABILITIES.VIEW,
      { db }
    );
    if (!new Set(["lead", "member"]).has(access.role)) {
      throw teamError(403, ERROR_CODES.FORBIDDEN, "只有项目写成员可以重试 Git 操作");
    }
    const project = readGitProject(db, operation.project_id);
    if (!project) throw teamError(404, ERROR_CODES.NOT_FOUND, "项目不存在");
    if (project.syncStatus === "needs_repair") {
      throw teamError(
        409,
        ERROR_CODES.PROJECT_REPAIR_REQUIRED,
        "项目需要管理员修复，普通重试不能绕过"
      );
    }
    if (!["prepared", "committed", "pending_push"].includes(operation.status)) {
      throw teamError(409, ERROR_CODES.CONFLICT, "当前 Git 操作不需要重试");
    }
    return gitManager.withProjectLock(operation.project_id, async () => {
      const recovered = await recoverOperationUnlocked(
        readOperation(db, operation.id)
      );
      return recovered;
    });
  }

  function get(actor, operationId) {
    const operation = readOperation(db, String(operationId || "").trim());
    if (!operation) throw teamError(404, ERROR_CODES.NOT_FOUND, "Git 操作不存在");
    if (actor.systemAdmin) return operationObject(operation);
    const access = authorizeProject(actor, operation.project_id, CAPABILITIES.VIEW, { db });
    if (
      operation.actor_user_id !== actor.userId &&
      access.role !== "lead"
    ) {
      throw teamError(403, ERROR_CODES.FORBIDDEN, "无权查看该 Git 操作");
    }
    return operationObject(operation);
  }

  async function recoverProject(projectId) {
    return gitManager.withProjectLock(projectId, () => recoverProjectUnlocked(projectId));
  }

  return {
    createTask,
    assignTask,
    retry,
    get,
    recoverProject,
    recoverProjectUnlocked
  };
}
