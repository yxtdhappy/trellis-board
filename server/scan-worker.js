import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { parentPort } from "node:worker_threads";
import { getDefaultDatabase } from "./database.js";
import {
  clearScanCaches,
  linkTaskGroups,
  refreshCachedTask,
  scanRepository,
  toTaskListItem,
  withManualStages
} from "./loader.js";
import { getManualRecords } from "./metadata.js";
import { getRepositories } from "./repositories.js";

let repositoryResults = new Map();
const database = getDefaultDatabase();

function stripArtifacts(task) {
  return { ...task, artifacts: undefined };
}

function normalizeEvents(events) {
  if (!Array.isArray(events)) return [];
  const seen = new Set();
  return events.filter((event) => {
    if (!event?.repositoryId) return false;
    const key = `${event.repositoryId}:${event.filePath || event.relativePath || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function resolveEventTaskDir(repository, event) {
  const tasksRoot = path.resolve(repository.path, ".trellis", "tasks");
  const eventPath = path.resolve(String(event.filePath || ""));
  if (!isInside(tasksRoot, eventPath)) return null;

  let current = eventPath;
  try {
    if (!fs.statSync(current).isDirectory()) current = path.dirname(current);
  } catch {
    current = path.dirname(current);
  }

  while (isInside(tasksRoot, current)) {
    if (fs.existsSync(path.join(current, "task.json"))) return current;
    current = path.dirname(current);
  }
  return null;
}

function mergeProjectMembers(result) {
  const current = result.project?.members || [];
  result.project = {
    ...result.project,
    members: [...new Set([
      ...current,
      ...result.tasks.map((task) => task.assignee || task.creator).filter(Boolean)
    ])].sort((left, right) => left.localeCompare(right, "zh-CN"))
  };
}

function applyTaskUpdates(repositoriesById, updates, stats) {
  const byRepository = new Map();
  for (const update of updates) {
    if (!byRepository.has(update.repositoryId)) byRepository.set(update.repositoryId, []);
    byRepository.get(update.repositoryId).push(update);
  }

  byRepository.forEach((repositoryUpdates, repositoryId) => {
    const repository = repositoriesById.get(repositoryId);
    const existing = repositoryResults.get(repositoryId);
    if (!repository || !existing) return;

    for (const update of repositoryUpdates) {
      const relativeDir = path.relative(repository.path, update.taskDir).replaceAll("\\", "/");
      const refreshed = refreshCachedTask(repository, update.taskDir, {
        archived: update.archived,
        includeContent: false
      });
      existing.tasks = existing.tasks.filter((task) => task.relativeDir !== relativeDir);
      if (refreshed) existing.tasks.unshift(refreshed);
      stats.tasksParsed += refreshed ? 1 : 0;
      stats.affectedTasks += 1;
    }
    mergeProjectMembers(existing);
  });
}

function scanRepositories(repositories, refreshRepositoryMetadata, stats) {
  for (const repository of repositories) {
    const result = scanRepository(repository, {
      includeContent: false,
      refreshRepositoryMetadata
    });
    repositoryResults.set(repository.id, result);
    stats.tasksParsed += result.stats?.tasksParsed || 0;
    stats.gitMetadataCacheHits += result.stats?.gitMetadataCacheHits || 0;
    stats.gitMetadataCacheMisses += result.stats?.gitMetadataCacheMisses || 0;
    stats.repositoriesScanned += 1;
  }
}

function planIncrementalScan(repositories, events) {
  const repositoriesById = new Map(repositories.map((repo) => [repo.id, repo]));
  const broadRepositoryIds = new Set();
  const taskUpdates = [];

  for (const event of normalizeEvents(events)) {
    const repository = repositoriesById.get(event.repositoryId);
    if (!repository) continue;
    const relativePath = String(event.relativePath || "").replaceAll("\\", "/");
    if (!relativePath.startsWith("tasks/")) {
      broadRepositoryIds.add(event.repositoryId);
      continue;
    }
    const taskDir = resolveEventTaskDir(repository, event);
    if (!taskDir) {
      broadRepositoryIds.add(event.repositoryId);
      continue;
    }
    const archiveRoot = path.resolve(repository.path, ".trellis", "tasks", "archive");
    taskUpdates.push({
      repositoryId: event.repositoryId,
      taskDir,
      archived: isInside(archiveRoot, taskDir)
    });
  }

  return {
    repositoriesById,
    broadRepositoryIds,
    taskUpdates
  };
}

function createBoard(repositories, stats) {
  const results = repositories
    .map((repository) => repositoryResults.get(repository.id))
    .filter(Boolean);
  const manualRecords = getManualRecords(database);
  const manualTasks = results.flatMap((result) =>
    result.tasks.map((task) =>
      withManualStages(
        stripArtifacts(task),
        manualRecords[`${task.projectId}/${task.relativeDir}`] || null
      )
    )
  );
  const tasks = linkTaskGroups([{ tasks: manualTasks }]).map(toTaskListItem);
  stats.tasks = results.reduce((total, result) => total + result.tasks.length, 0);
  stats.durationMs = 0;

  return {
    generatedAt: new Date().toISOString(),
    projects: results.map((result) => ({
      ...result.project,
      taskCount: result.tasks.length,
      activeCount: result.tasks.filter((task) => !task.archived).length,
      archivedCount: result.tasks.filter((task) => task.archived).length,
      error: result.error
    })),
    tasks,
    stages: [
      { id: "prd", label: "需求" },
      { id: "research", label: "调研" },
      { id: "design", label: "设计" },
      { id: "implementPlan", label: "实施计划" },
      { id: "context", label: "上下文编排" },
      { id: "review", label: "规划评审" },
      { id: "implement", label: "实现" },
      { id: "check", label: "检查" },
      { id: "e2e", label: "真实验证", optional: true },
      { id: "spec", label: "规范回写" },
      { id: "commit", label: "工作提交" },
      { id: "archive", label: "归档" },
      { id: "journal", label: "会话记录" }
    ]
  };
}

function scanBoard({
  refreshRepositoryMetadata = false,
  forceFull = false,
  events = []
} = {}) {
  const startedAt = performance.now();
  const stats = {
    tasks: 0,
    tasksParsed: 0,
    tasksReused: 0,
    affectedTasks: 0,
    repositoriesScanned: 0,
    gitMetadataCacheHits: 0,
    gitMetadataCacheMisses: 0,
    mode: "incremental"
  };
  if (refreshRepositoryMetadata) {
    clearScanCaches({ tasks: false, gitMetadata: true });
  }

  const repositories = getRepositories(database);
  const repositoryIds = new Set(repositories.map((repository) => repository.id));
  for (const repositoryId of repositoryResults.keys()) {
    if (!repositoryIds.has(repositoryId)) repositoryResults.delete(repositoryId);
  }

  const plan = planIncrementalScan(repositories, events);
  const missingRepositories = repositories.filter(
    (repository) => !repositoryResults.has(repository.id)
  );
  const repositoriesToScan = forceFull
    ? repositories
    : repositories.filter((repository) =>
      missingRepositories.includes(repository) ||
      plan.broadRepositoryIds.has(repository.id)
    );

  if (repositoriesToScan.length) {
    stats.mode = forceFull || missingRepositories.length ? "full" : "repository";
    scanRepositories(repositoriesToScan, refreshRepositoryMetadata, stats);
  }

  const taskUpdates = plan.taskUpdates.filter(
    (update) => !repositoriesToScan.some((repository) => repository.id === update.repositoryId)
  );
  if (taskUpdates.length) {
    stats.mode = repositoriesToScan.length ? "mixed" : "task";
    applyTaskUpdates(plan.repositoriesById, taskUpdates, stats);
  }

  const board = createBoard(repositories, stats);
  stats.tasksReused = Math.max(0, stats.tasks - stats.tasksParsed);
  stats.durationMs = Math.round((performance.now() - startedAt) * 10) / 10;
  stats.repositories = repositories.length;
  return { board, stats };
}

parentPort.on("message", (message) => {
  if (message?.type !== "scan") return;
  try {
    const result = scanBoard({
      refreshRepositoryMetadata: Boolean(message.refreshRepositoryMetadata),
      forceFull: Boolean(message.forceFull),
      events: message.events
    });
    parentPort.postMessage({
      type: "scan-result",
      id: message.id,
      ...result
    });
  } catch (error) {
    parentPort.postMessage({
      type: "scan-error",
      id: message.id,
      error: error instanceof Error ? error.message : String(error)
    });
  }
});
