import {
  readExecutionDetail,
  readExecutionEventsBatch,
  readExecutionMap,
  readTaskDependencies
} from "./execution-store.js";
import { buildTaskHistory } from "./execution-history.js";
import {
  computeExecutionMetrics,
  missingExecutionMetrics,
  summarizeExecutionMetrics
} from "./execution-metrics.js";

const DEFAULT_DUE_SOON_DAYS = 3;
const DEFAULT_STALE_DAYS = 5;
const DEFAULT_EXECUTION_WIP_LIMIT = 2;
const PLANNING_STAGES = new Set([
  "prd",
  "research",
  "design",
  "implementPlan",
  "context",
  "review"
]);
const CLOSEOUT_STAGES = new Set([
  "implement",
  "check",
  "e2e",
  "spec",
  "commit",
  "archive",
  "journal"
]);

function localDateParts(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate()
  };
}

function dateKey(parts) {
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function dateSerial(parts) {
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  return Math.floor(date.getTime() / 86_400_000);
}

export function dueDateDistance(dueDate, now = new Date()) {
  if (typeof dueDate !== "string") return null;
  const match = dueDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const today = localDateParts(now);
  if (!match || !today) return null;
  return dateSerial({
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3])
  }) - dateSerial(today);
}

function daysSince(value, now) {
  const timestamp = Date.parse(value || "");
  const nowTimestamp = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(timestamp) || !Number.isFinite(nowTimestamp)) return null;
  return Math.max(0, Math.floor((nowTimestamp - timestamp) / 86_400_000));
}

function executionSnapshot(task, snapshot) {
  return {
    dueDate: snapshot?.dueDate ?? null,
    milestone: snapshot?.milestone || "",
    tags: Array.isArray(snapshot?.tags) ? snapshot.tags : [],
    lastActivityAt: snapshot?.lastActivityAt || null,
    trackingStartedAt: snapshot?.trackingStartedAt || null,
    eventCount: Number(snapshot?.eventCount || 0),
    historyStatus: snapshot?.historyStatus === "tracking" ? "tracking" : "missing"
  };
}

function stageOf(task, id) {
  return Array.isArray(task?.stages)
    ? task.stages.find((stage) => stage.id === id) || null
    : null;
}

function acceptanceCounts(task) {
  const summary = task?.summary || {};
  let acceptanceCount = Number.isInteger(summary.prdAcceptanceCount)
    ? summary.prdAcceptanceCount
    : null;
  let checkedCount = Number.isInteger(summary.prdCheckedCount)
    ? summary.prdCheckedCount
    : null;
  if (acceptanceCount == null || checkedCount == null) {
    const match = String(stageOf(task, "prd")?.evidence || "")
      .match(/验收项\s*(\d+)\s*\/\s*(\d+)/);
    if (match) {
      checkedCount = Number(match[1]);
      acceptanceCount = Number(match[2]);
    }
  }
  return { acceptanceCount, checkedCount };
}

function normalizeWipLimit(value) {
  return Number.isInteger(value) && value >= 1 && value <= 9
    ? value
    : DEFAULT_EXECUTION_WIP_LIMIT;
}

function wipStateFor(task, implementationWip, implementationLimit) {
  if (task.archived || task.derivedStage !== "implement") return "normal";
  if (implementationWip > implementationLimit) return "over_limit";
  if (implementationWip === implementationLimit) return "at_limit";
  return "normal";
}

export function deriveTaskRisk(task, {
  implementationWip = 0,
  implementationLimit = DEFAULT_EXECUTION_WIP_LIMIT
} = {}) {
  const limit = normalizeWipLimit(implementationLimit);
  const summary = task?.summary || {};
  const dorMissing = [];
  const dodMissing = [];
  if (!task.archived && PLANNING_STAGES.has(task.derivedStage)) {
    const prdMeaningful = summary.prdMeaningful ??
      Boolean(stageOf(task, "prd")?.complete);
    const hasAcceptance = !Number.isInteger(summary.prdAcceptanceCount) ||
      summary.prdAcceptanceCount > 0;
    if (!prdMeaningful || !hasAcceptance) {
      dorMissing.push("PRD 的 Requirements 与 Acceptance Criteria");
    }
    const hasDesign = summary.hasDesign ?? Boolean(stageOf(task, "design")?.complete);
    const designMeaningful = summary.designMeaningful ?? hasDesign;
    if (!hasDesign || designMeaningful === false) {
      dorMissing.push("非骨架的 Design 文档");
    }
    const hasImplement = summary.hasImplement ?? Boolean(stageOf(task, "implementPlan")?.complete);
    if (!hasImplement) dorMissing.push("Implement 执行计划");
    const reviewStage = stageOf(task, "review");
    if (!reviewStage?.complete && reviewStage?.source !== "manual") {
      dorMissing.push("规划评审证据或人工检查点");
    }
  }
  if (task.archived || CLOSEOUT_STAGES.has(task.derivedStage)) {
    const implementStage = stageOf(task, "implement");
    const hasImplementationEvidence = summary.hasImplementationReport === true ||
      (implementStage?.complete && implementStage.source !== "archive-gap");
    if (!hasImplementationEvidence) {
      dodMissing.push("实施报告或等效实现证据");
    }
    const checkStage = stageOf(task, "check");
    const hasCheckEvidence = summary.hasCheckReport === true ||
      (checkStage?.complete && checkStage.source !== "archive-gap");
    if (!hasCheckEvidence) {
      dodMissing.push("检查报告或明确通过的检查证据");
    }
    const { acceptanceCount, checkedCount } = acceptanceCounts(task);
    if (acceptanceCount == null) {
      dodMissing.push("PRD 验收项状态");
    } else if (acceptanceCount === 0) {
      dodMissing.push("PRD 验收项");
    } else if (checkedCount !== acceptanceCount) {
      dodMissing.push(`PRD 验收项（${checkedCount}/${acceptanceCount} 已勾选）`);
    }
    if (!task.commit) dodMissing.push("工作提交 commit");
    if (!task.archived) dodMissing.push("归档记录");
  }
  return {
    wipState: wipStateFor(task, implementationWip, limit),
    dorMissing,
    dodMissing
  };
}

function emptyDependencySummary() {
  return {
    blockedByCount: 0,
    blocksCount: 0,
    blockedDurationMs: 0,
    isBlocked: false,
    isUnblockedReady: false
  };
}

function emptyRisk() {
  return {
    wipState: "normal",
    dorMissing: [],
    dodMissing: []
  };
}

function taskIndex(tasks) {
  const byKey = new Map();
  tasks.forEach((task) => {
    if (
      task.executionTaskKey &&
      task.executionIdentityValid !== false &&
      task.executionIdentityConflict !== true
    ) {
      byKey.set(task.executionTaskKey, task);
    }
  });
  return byKey;
}

function dependencyDuration(createdAt, endAt) {
  const created = Date.parse(createdAt || "");
  const end = endAt instanceof Date ? endAt.getTime() : new Date(endAt).getTime();
  if (!Number.isFinite(created) || !Number.isFinite(end)) return 0;
  return Math.max(0, end - created);
}

function dependencySummary(dependency, relatedKey, relatedTask, endAt) {
  return {
    id: dependency.id,
    taskKey: relatedTask?.taskKey || null,
    executionTaskKey: relatedKey,
    title: relatedTask?.title || "已不在看板中的任务",
    projectName: relatedTask?.projectName || "未知项目",
    reason: dependency.reason,
    createdBy: dependency.createdBy,
    createdAt: dependency.createdAt,
    resolvedAt: dependency.resolvedAt || null,
    durationMs: dependencyDuration(dependency.createdAt, endAt)
  };
}

function buildDependencyContext(tasks, dependencies, now) {
  const byKey = taskIndex(tasks);
  const blockedBy = new Map();
  const blocks = new Map();
  const resolvedBlockedBy = new Map();
  const resolvedBlocks = new Map();
  const blockedDurationByKey = new Map();
  const resolvedBlockedKeys = new Set();
  dependencies.forEach((dependency) => {
    if (dependency.resolvedAt) {
      resolvedBlockedKeys.add(dependency.blockedTaskKey);
      if (!resolvedBlockedBy.has(dependency.blockedTaskKey)) {
        resolvedBlockedBy.set(dependency.blockedTaskKey, []);
      }
      if (!resolvedBlocks.has(dependency.blockerTaskKey)) {
        resolvedBlocks.set(dependency.blockerTaskKey, []);
      }
      resolvedBlockedBy.get(dependency.blockedTaskKey).push(dependencySummary(
        dependency,
        dependency.blockerTaskKey,
        byKey.get(dependency.blockerTaskKey),
        dependency.resolvedAt
      ));
      resolvedBlocks.get(dependency.blockerTaskKey).push(dependencySummary(
        dependency,
        dependency.blockedTaskKey,
        byKey.get(dependency.blockedTaskKey),
        dependency.resolvedAt
      ));
      return;
    }
    blockedDurationByKey.set(
      dependency.blockedTaskKey,
      (blockedDurationByKey.get(dependency.blockedTaskKey) || 0) +
        dependencyDuration(dependency.createdAt, now)
    );
    if (!blockedBy.has(dependency.blockedTaskKey)) blockedBy.set(dependency.blockedTaskKey, []);
    if (!blocks.has(dependency.blockerTaskKey)) blocks.set(dependency.blockerTaskKey, []);
    blockedBy.get(dependency.blockedTaskKey).push(dependencySummary(
      dependency,
      dependency.blockerTaskKey,
      byKey.get(dependency.blockerTaskKey),
      now
    ));
    blocks.get(dependency.blockerTaskKey).push(dependencySummary(
      dependency,
      dependency.blockedTaskKey,
      byKey.get(dependency.blockedTaskKey),
      now
    ));
  });
  return {
    forTask(task) {
      if (
        !task.executionTaskKey ||
        task.executionIdentityValid === false ||
        task.executionIdentityConflict === true
      ) {
        return {
          summary: emptyDependencySummary(),
          blockedBy: [],
          blocks: [],
          resolvedBlockedBy: [],
          resolvedBlocks: []
        };
      }
      const blockedItems = blockedBy.get(task.executionTaskKey) || [];
      const blockItems = blocks.get(task.executionTaskKey) || [];
      const isBlocked = blockedItems.length > 0;
      const blockedDurationMs = blockedItems.reduce(
        (maximum, item) => Math.max(maximum, item.durationMs),
        0
      );
      return {
        summary: {
          blockedByCount: blockedItems.length,
          blocksCount: blockItems.length,
          blockedDurationMs,
          isBlocked,
          isUnblockedReady: !task.archived &&
            !isBlocked &&
            resolvedBlockedKeys.has(task.executionTaskKey)
        },
        blockedBy: blockedItems,
        blocks: blockItems,
        resolvedBlockedBy: resolvedBlockedBy.get(task.executionTaskKey) || [],
        resolvedBlocks: resolvedBlocks.get(task.executionTaskKey) || [],
        blockedDurationTotalMs: blockedDurationByKey.get(task.executionTaskKey) || 0
      };
    }
  };
}

function dependenciesByBlockedTask(dependencies) {
  const result = new Map();
  dependencies.forEach((dependency) => {
    if (!result.has(dependency.blockedTaskKey)) {
      result.set(dependency.blockedTaskKey, []);
    }
    result.get(dependency.blockedTaskKey).push(dependency);
  });
  return result;
}

function timelineMetricsOptions(timeline) {
  return {
    eventTotal: Number(timeline?.eventTotal || 0),
    eventLimit: Number(timeline?.eventLimit || 1000),
    eventTruncated: Boolean(timeline?.eventTruncated),
    eventWindowStartAt: timeline?.eventWindowStartAt || null
  };
}

function emptyExecutionDetail(limit) {
  return {
    dueDate: null,
    milestone: "",
    tags: [],
    planCreatedAt: null,
    planUpdatedAt: null,
    lastActivityAt: null,
    trackingStartedAt: null,
    eventCount: 0,
    historyStatus: "missing",
    events: [],
    eventTotal: 0,
    eventLimit: Math.min(1000, Math.max(1, Number(limit) || 200)),
    eventTruncated: false,
    eventWindowStartAt: null
  };
}

function metricsForTask(task, timeline, dependencies, now) {
  return computeExecutionMetrics({
    events: timeline?.events || [],
    dependencies,
    archived: Boolean(task.archived),
    archivedAt: task.archivedAt || null,
    now,
    ...timelineMetricsOptions(timeline)
  });
}

function riskSummary(risk) {
  return {
    wipState: risk.wipState,
    dorMissingCount: risk.dorMissing.length,
    dodMissingCount: risk.dodMissing.length
  };
}

export function computeAttentionReasons(task, execution, now = new Date()) {
  if (task.archived) return [];
  const reasons = [];
  if (task.executionIdentityValid === false || task.executionIdentityConflict) {
    reasons.push("identity_conflict");
  }
  if (execution?.isBlocked) reasons.push("blocked");
  if (execution?.isUnblockedReady) reasons.push("unblocked_ready");
  const distance = dueDateDistance(execution?.dueDate, now);
  if (distance != null && distance < 0) reasons.push("overdue");
  if (distance != null && distance >= 0 && distance <= DEFAULT_DUE_SOON_DAYS) {
    reasons.push("due_soon");
  }
  if (task.priority === "P0" || task.priority === "P1") reasons.push("priority");
  if (
    execution?.historyStatus === "tracking" &&
    daysSince(execution.lastActivityAt, now) >= DEFAULT_STALE_DAYS
  ) {
    reasons.push("stale");
  }
  if (task.derivedStage === "implement") reasons.push("implementing");
  if (task.derivedStage === "check") reasons.push("checking");
  return reasons;
}

export function projectTaskExecution(
  task,
  snapshot = null,
  now = new Date(),
  projection = {}
) {
  const conflict = task.executionIdentityValid === false || task.executionIdentityConflict;
  const base = conflict
    ? {
        dueDate: null,
        milestone: "",
        tags: [],
        lastActivityAt: null,
        trackingStartedAt: null,
        eventCount: 0,
        historyStatus: "missing"
      }
    : executionSnapshot(task, snapshot);
  const dependency = conflict
    ? emptyDependencySummary()
    : (projection.dependencySummary || emptyDependencySummary());
  const risk = conflict
    ? emptyRisk()
    : (projection.risk || emptyRisk());
  const metrics = projection.metricsSummary || summarizeExecutionMetrics(
    missingExecutionMetrics({
      reasons: [conflict ? "执行身份冲突，无法读取可信历史" : "尚未计算执行指标"]
    })
  );
  const execution = {
    ...base,
    ...dependency,
    risk: riskSummary(risk),
    metrics
  };
  return {
    ...execution,
    attentionReasons: computeAttentionReasons(task, execution, now)
  };
}

export function projectBoardExecution(
  board,
  savedViews = [],
  db,
  now = new Date(),
  { executionWipLimit = DEFAULT_EXECUTION_WIP_LIMIT } = {}
) {
  const tasks = Array.isArray(board?.tasks) ? board.tasks : [];
  const limit = normalizeWipLimit(executionWipLimit);
  const implementationWip = tasks.filter((task) =>
    !task.archived &&
    task.executionIdentityValid !== false &&
    task.executionIdentityConflict !== true &&
    task.derivedStage === "implement"
  ).length;
  const validKeys = tasks
    .filter((task) => task.executionIdentityValid !== false && task.executionTaskKey)
    .map((task) => task.executionTaskKey);
  const snapshots = readExecutionMap(db, validKeys);
  const eventSets = readExecutionEventsBatch(db, validKeys, 1000);
  const allDependencies = readTaskDependencies(db);
  const dependencies = buildDependencyContext(tasks, allDependencies, now);
  const taskDependencies = dependenciesByBlockedTask(allDependencies);
  let activeBlockedDurationMs = 0;
  const projectedTasks = tasks.map((task) => {
    const dependency = dependencies.forTask(task);
    if (!task.archived && dependency.summary.isBlocked) {
      activeBlockedDurationMs += dependency.blockedDurationTotalMs;
    }
    const risk = deriveTaskRisk(task, { implementationWip, implementationLimit: limit });
    const timeline = eventSets.get(task.executionTaskKey) || {
      events: [],
      eventTotal: 0,
      eventLimit: 1000,
      eventTruncated: false,
      eventWindowStartAt: null
    };
    const metrics = task.executionIdentityValid === false || task.executionIdentityConflict
      ? missingExecutionMetrics({ reasons: ["执行身份冲突，无法读取可信历史"] })
      : metricsForTask(
          task,
          timeline,
          taskDependencies.get(task.executionTaskKey) || [],
          now
        );
    return {
      ...task,
      execution: projectTaskExecution(
        task,
        snapshots.get(task.executionTaskKey) || null,
        now,
        {
          dependencySummary: dependency.summary,
          risk,
          metricsSummary: summarizeExecutionMetrics(metrics)
        }
      )
    };
  });
  const flow = {
    implementationWip,
    implementationLimit: limit,
    wipState: implementationWip > limit
      ? "over_limit"
      : implementationWip === limit ? "at_limit" : "normal",
    blockedCount: projectedTasks.filter((task) =>
      !task.archived && task.execution.isBlocked
    ).length,
    unblockedReadyCount: projectedTasks.filter((task) =>
      task.execution.isUnblockedReady
    ).length,
    blockedDurationMs: activeBlockedDurationMs,
    dorGapCount: projectedTasks.filter((task) =>
      !task.archived && task.execution.risk.dorMissingCount > 0
    ).length,
    dodGapCount: projectedTasks.filter((task) =>
      !task.archived && task.execution.risk.dodMissingCount > 0
    ).length
  };
  return {
    ...board,
    tasks: projectedTasks,
    savedViews,
    flow
  };
}

export function projectTaskDetailExecution(
  task,
  db,
  now = new Date(),
  limit = 200,
  {
    boardTasks = [task],
    executionWipLimit = DEFAULT_EXECUTION_WIP_LIMIT
  } = {}
) {
  const allTasks = Array.isArray(boardTasks) ? [...boardTasks] : [];
  if (!allTasks.some((candidate) => candidate.taskKey === task.taskKey)) {
    allTasks.push(task);
  }
  const implementationLimit = normalizeWipLimit(executionWipLimit);
  const implementationWip = allTasks.filter((candidate) =>
    !candidate.archived &&
    candidate.executionIdentityValid !== false &&
    candidate.executionIdentityConflict !== true &&
    candidate.derivedStage === "implement"
  ).length;
  const allDependencies = readTaskDependencies(db);
  const dependencyContext = buildDependencyContext(allTasks, allDependencies, now);
  const dependency = dependencyContext.forTask(task);
  if (task.executionIdentityValid === false || task.executionIdentityConflict) {
    const conflictMetrics = missingExecutionMetrics({
      reasons: ["执行身份冲突，无法读取可信历史"]
    });
    return {
      ...task,
      execution: {
        ...projectTaskExecution(task, null, now),
        blockedBy: [],
        blocks: [],
        resolvedBlockedBy: [],
        resolvedBlocks: [],
        risk: {
          ...riskSummary(emptyRisk()),
          dorMissing: [],
          dodMissing: []
        },
        history: {
          events: [],
          eventTotal: 0,
          eventLimit: limit,
          truncated: false,
          windowStartAt: null,
          undo: {
            available: false,
            targetCorrelationId: null,
            targetEventIds: [],
            eventType: null,
            occurredAt: null,
            label: null,
            disabledReason: "任务执行身份冲突，无法安全撤销"
          },
          error: null
        },
        metrics: conflictMetrics,
        historyError: null,
        metricsError: null,
        events: [],
        eventTotal: 0,
        eventLimit: limit,
        eventTruncated: false,
        eventWindowStartAt: null
      }
    };
  }
  let detail;
  let historyError = null;
  try {
    detail = readExecutionDetail(db, task.executionTaskKey, limit);
  } catch (error) {
    historyError = error instanceof Error ? error.message : String(error);
    detail = emptyExecutionDetail(limit);
  }
  let history = null;
  if (!historyError) {
    try {
      history = buildTaskHistory({
        db,
        executionTaskKey: task.executionTaskKey,
        events: detail.events,
        eventTotal: detail.eventTotal,
        eventLimit: detail.eventLimit,
        eventTruncated: detail.eventTruncated,
        eventWindowStartAt: detail.eventWindowStartAt,
        archived: Boolean(task.archived),
        identityValid: true,
        limit
      });
    } catch (error) {
      historyError = error instanceof Error ? error.message : String(error);
    }
  }
  if (!history) {
    history = {
      events: detail.events,
      eventTotal: detail.eventTotal,
      eventLimit: detail.eventLimit,
      truncated: Boolean(detail.eventTruncated),
      windowStartAt: detail.eventWindowStartAt,
      undo: {
        available: false,
        targetCorrelationId: null,
        targetEventIds: [],
        eventType: null,
        occurredAt: null,
        label: null,
        disabledReason: "历史撤销状态读取失败"
      },
      error: historyError
    };
  }
  const taskDependencies = allDependencies.filter((dependency) =>
    dependency.blockedTaskKey === task.executionTaskKey
  );
  let metrics = null;
  let metricsError = historyError && detail.events.length === 0
    ? historyError
    : null;
  if (!metricsError) {
    try {
      metrics = metricsForTask(task, detail, taskDependencies, now);
    } catch (error) {
      metricsError = error instanceof Error ? error.message : String(error);
    }
  }
  if (!metrics) {
    metrics = missingExecutionMetrics({
      reasons: [metricsError || "指标计算失败"],
      observedSince: detail.trackingStartedAt,
      ...timelineMetricsOptions(detail)
    });
  }
  const risk = deriveTaskRisk(task, {
    implementationWip,
    implementationLimit
  });
  return {
    ...task,
    execution: {
      ...projectTaskExecution(task, detail, now, {
        dependencySummary: dependency.summary,
        risk
      }),
      blockedBy: dependency.blockedBy,
      blocks: dependency.blocks,
      resolvedBlockedBy: dependency.resolvedBlockedBy,
      resolvedBlocks: dependency.resolvedBlocks,
      risk: {
        ...riskSummary(risk),
        dorMissing: risk.dorMissing,
        dodMissing: risk.dodMissing
      },
      history,
      metrics,
      historyError,
      metricsError,
      events: history.events,
      eventTotal: history.eventTotal,
      eventLimit: history.eventLimit,
      eventTruncated: history.truncated,
      eventWindowStartAt: history.windowStartAt
    }
  };
}

export function todayLabel(now = new Date()) {
  const parts = localDateParts(now);
  return parts ? dateKey(parts) : null;
}

export {
  DEFAULT_DUE_SOON_DAYS,
  DEFAULT_EXECUTION_WIP_LIMIT,
  DEFAULT_STALE_DAYS
};
