import { renderMarkdown } from "./markdown.js";
import { formatArchiveTimestamp, sortArchivedTasks } from "./archive-sort.js";
import { escapeHtml, setMessage } from "./dom.js";
import { requestJson, redirectToLogin } from "./team-request.js";
import {
  assignableProjectMembers,
  assignmentVersion,
  buildTaskQuery,
  canManageProject,
  canWriteProject,
  isCompleteOperation,
  isRetryableOperation,
  normalizeAssignments,
  normalizeBoardPage,
  normalizeOperation,
  normalizeProjectMembers,
  normalizeRuntime,
  normalizeTaskPage,
  normalizeTeamProject,
  normalizeTeamProjects,
  normalizeTeamStatus,
  normalizeTeamTaskRow,
  normalizeUser,
  operationPollDelay,
  shouldReloadTasks,
  taskVersion
} from "./team-client.js";
import {
  normalizeTaskSlug,
  slugifyTaskTitle,
  TASK_SLUG_PATTERN
} from "./slug.js";
import {
  ATTENTION_REASON_LABELS,
  BUILTIN_VIEWS,
  FILTER_STAGES,
  dueDateDistance,
  findView,
  laneForStageIndex,
  normalizeTagsInput,
  taskMatchesView,
  taskTagNames
} from "./execution-filter.js";

const STAGE_LANES = [
  { id: "planning", label: "规划", hint: "需求、调研、设计与上下文准备" },
  { id: "review", label: "待放行", hint: "规划产物已备，尚未开始实现" },
  { id: "implementation", label: "实现", hint: "正在写代码" },
  { id: "verification", label: "检查 / 收尾", hint: "验证、规范回写与工作提交" }
];

const ARTIFACT_DEFINITIONS = [
  { key: "prd", label: "PRD", hint: "需求、范围与验收标准" },
  { key: "design", label: "Design", hint: "技术设计与关键取舍" },
  { key: "implement", label: "Implement", hint: "实施计划与检查项" },
  { key: "implementationReport", label: "实施报告", hint: "实现结果与验证记录" },
  { key: "checkReport", label: "检查报告", hint: "质量检查与问题闭环" },
  { key: "e2eReport", label: "E2E 报告", hint: "真实环境端到端验证" }
];

const TASK_COPY_LABEL = "复制任务名";
const TASK_COPIED_LABEL = "已复制";
const TEAM_POLL_MS = 3_000;
const TEAM_PAGE_SIZE = 100;
const TEAM_SYNC_LABELS = {
  provisioning: "待批准",
  current: "已同步",
  stale: "已过期",
  pending_push: "待发布",
  needs_repair: "需修复",
  disabled: "已停用",
  unknown: "状态未知"
};
const TEAM_OPERATION_LABELS = {
  prepared: "已准备",
  committed: "本地已提交",
  pending_push: "等待推送",
  pushed: "远端已接收",
  applied: "已应用",
  failed: "失败"
};

function initialTeamFilters() {
  return {
    projectIds: [],
    priorities: [],
    stages: [],
    tags: [],
    assignee: "",
    dueWithinDays: "",
    staleDays: "",
    blocked: "any",
    archived: false
  };
}

const state = {
  board: null,
  view: "pipeline",
  projectId: "all",
  scope: "all",
  search: "",
  executionView: "all",
  selectedTask: null,
  archiveProject: "all",
  archiveSearch: "",
  loading: false,
  pollTimer: null,
  status: null,
  selectedFolders: [],
  pickingFolders: false,
  addingProjects: false,
  createSlugManuallyEdited: false,
  editingExecutionTaskKey: null,
  savingExecution: false,
  savingView: false,
  savingDependency: false,
  savingWip: false,
  savingUndo: false,
  teamMode: false,
  runtime: null,
  user: null,
  teamProjects: [],
  teamStatus: null,
  teamPage: null,
  teamAssignments: [],
  teamLoading: false,
  teamFilterTimer: null,
  teamOperation: null,
  teamOperationTimer: null,
  teamOperationAttempt: 0,
  teamFilters: initialTeamFilters(),
  teamCursors: [null],
  teamPageIndex: 0,
  teamHasNext: false,
  teamEtag: null,
  teamStatusEtag: null,
  teamStatusLoading: false,
  teamInitialized: false,
  teamPollTimer: null,
  createIdempotencyKey: null,
  createSignature: null,
  assignIdempotencyKey: null
};

const els = {
  projectList: document.querySelector("#project-list"),
  projectCount: document.querySelector("#project-count"),
  syncDot: document.querySelector("#sync-dot"),
  syncLabel: document.querySelector("#sync-label"),
  refresh: document.querySelector("#refresh-button"),
  error: document.querySelector("#error-banner"),
  copyFeedback: document.querySelector("#copy-feedback"),
  pipeline: document.querySelector("#pipeline-board"),
  team: document.querySelector("#team-board"),
  archive: document.querySelector("#archive-board"),
  search: document.querySelector("#search-input"),
  archiveSearch: document.querySelector("#archive-search"),
  archiveProject: document.querySelector("#archive-project"),
  createButton: document.querySelector("#create-button"),
  manageProjectsButton: document.querySelector("#manage-projects-button"),
  taskDialog: document.querySelector("#task-dialog"),
  dialogCopyTask: document.querySelector("#dialog-copy-task"),
  dialogCopyFeedback: document.querySelector("#dialog-copy-feedback"),
  artifactDialog: document.querySelector("#artifact-dialog"),
  createDialog: document.querySelector("#create-dialog"),
  projectDialog: document.querySelector("#project-dialog"),
  executionDialog: document.querySelector("#execution-dialog"),
  viewDialog: document.querySelector("#view-dialog"),
  executionForm: document.querySelector("#execution-form"),
  viewForm: document.querySelector("#view-form"),
  executionMessage: document.querySelector("#execution-message"),
  viewMessage: document.querySelector("#view-message"),
  executionSubmit: document.querySelector("#execution-submit"),
  viewSubmit: document.querySelector("#view-submit"),
  executionViewList: document.querySelector("#execution-view-list"),
  executionViewSummary: document.querySelector("#execution-view-summary"),
  executionDateLabel: document.querySelector("#execution-date-label"),
  flowWipForm: document.querySelector("#flow-wip-form"),
  flowWipLimit: document.querySelector("#flow-wip-limit"),
  flowWipSubmit: document.querySelector("#flow-wip-submit"),
  flowWipMessage: document.querySelector("#flow-wip-message"),
  flowWipValue: document.querySelector("#flow-wip-value"),
  flowWipState: document.querySelector("#flow-wip-state"),
  flowBlockedValue: document.querySelector("#flow-blocked-value"),
  flowBlockedDuration: document.querySelector("#flow-blocked-duration"),
  flowReadyValue: document.querySelector("#flow-ready-value"),
  flowGapValue: document.querySelector("#flow-gap-value"),
  focusCard: document.querySelector("#focus-card"),
  attentionQueue: document.querySelector("#attention-queue"),
  attentionCount: document.querySelector("#attention-count"),
  kanbanSummary: document.querySelector("#kanban-summary"),
  projectForm: document.querySelector("#project-form"),
  projectManagerList: document.querySelector("#project-manager-list"),
  projectFormMessage: document.querySelector("#project-form-message"),
  projectSubmit: document.querySelector("#project-submit"),
  pickFoldersButton: document.querySelector("#pick-folders"),
  selectedFolders: document.querySelector("#selected-folders"),
  selectedFolderCount: document.querySelector("#selected-folder-count"),
  viewTitle: document.querySelector("#view-title"),
  viewEyebrow: document.querySelector("#view-eyebrow"),
  metricActive: document.querySelector("#metric-active"),
  metricActiveCaption: document.querySelector("#metric-active-caption"),
  metricArchive: document.querySelector("#metric-archive"),
  metricArchiveCaption: document.querySelector("#metric-archive-caption"),
  metricAttention: document.querySelector("#metric-attention"),
  metricTeam: document.querySelector("#metric-team"),
  metricTeamCaption: document.querySelector("#metric-team-caption"),
  workspace: document.querySelector("#workspace"),
  teamSession: document.querySelector("#team-session"),
  teamSessionName: document.querySelector("#team-session-name"),
  teamSessionMode: document.querySelector("#team-session-mode"),
  teamAdminLink: document.querySelector("#team-admin-link"),
  teamLogout: document.querySelector("#team-logout-button"),
  teamPassword: document.querySelector("#team-password-button"),
  teamAccount: document.querySelector("#team-account"),
  teamAccountAvatar: document.querySelector("#team-account-avatar"),
  teamAccountName: document.querySelector("#team-account-name"),
  teamAccountRole: document.querySelector("#team-account-role"),
  teamFeedback: document.querySelector("#team-feedback"),
  teamStatusBanner: document.querySelector("#team-status-banner"),
  teamQueryPanel: document.querySelector("#team-query-panel"),
  teamQueryList: document.querySelector("#team-query-list"),
  teamQuerySummary: document.querySelector("#team-query-summary"),
  teamQueryTotal: document.querySelector("#team-query-total"),
  teamFilterForm: document.querySelector("#team-filter-form"),
  teamFilterProject: document.querySelector("#team-filter-project"),
  teamFilterAssignee: document.querySelector("#team-filter-assignee"),
  teamFilterPriority: document.querySelector("#team-filter-priority"),
  teamFilterStage: document.querySelector("#team-filter-stage"),
  teamFilterTags: document.querySelector("#team-filter-tags"),
  teamFilterDue: document.querySelector("#team-filter-due"),
  teamFilterStale: document.querySelector("#team-filter-stale"),
  teamFilterBlocked: document.querySelector("#team-filter-blocked"),
  teamFilterArchived: document.querySelector("#team-filter-archived"),
  teamPagePrev: document.querySelector("#team-page-prev"),
  teamPageNext: document.querySelector("#team-page-next"),
  teamPageLabel: document.querySelector("#team-page-label"),
  assignmentNav: document.querySelector("#assignment-nav"),
  assignmentCount: document.querySelector("#assignment-count"),
  assignmentsDialog: document.querySelector("#assignments-dialog"),
  assignmentsList: document.querySelector("#assignments-list"),
  assignmentsMessage: document.querySelector("#assignments-message"),
  teamTaskActions: document.querySelector("#team-task-actions"),
  teamTaskVersion: document.querySelector("#team-task-version"),
  teamTaskAccept: document.querySelector("#team-task-accept"),
  teamOperationDialog: document.querySelector("#team-operation-dialog"),
  teamOperationTitle: document.querySelector("#team-operation-title"),
  teamOperationStatus: document.querySelector("#team-operation-status"),
  teamOperationId: document.querySelector("#team-operation-id"),
  teamOperationRetry: document.querySelector("#team-operation-retry"),
  passwordDialog: document.querySelector("#password-dialog"),
  passwordForm: document.querySelector("#password-form"),
  passwordMessage: document.querySelector("#password-message"),
  passwordSubmit: document.querySelector("#password-submit")
};

const taskCopyFeedbackTimers = new WeakMap();
const teamMemberLoads = new Map();

const safe = escapeHtml;

const initials = (name) => (name || "?").slice(0, 2).toUpperCase();
const activeTasks = () => state.board?.tasks.filter((task) =>
  !task.archived && (!state.teamMode || taskMatchesTeamFilters(task))
) || [];
const archivedTasks = () => state.board?.tasks.filter((task) => task.archived) || [];
const currentProject = () => state.board?.projects.find((project) => project.id === state.projectId);

function taskMatchesTeamFilters(task) {
  if (!state.teamMode) return true;
  const filters = state.teamFilters;
  if (filters.priorities.length && !filters.priorities.includes(task.priority)) return false;
  if (filters.stages.length && !filters.stages.includes(task.derivedStage)) return false;
  if (filters.assignee && task.assignee !== filters.assignee) return false;
  if (filters.blocked === "blocked" && !task.isBlocked) return false;
  if (filters.tags.length) {
    const tags = taskTagNames(task);
    if (!filters.tags.some((tag) => tags.includes(tag))) return false;
  }
  if (filters.dueWithinDays !== "") {
    const distance = dueDateDistance(task.execution?.dueDate || task.dueDate);
    if (distance == null || distance > Number(filters.dueWithinDays)) return false;
  }
  if (filters.staleDays !== "") {
    const stamp = task.execution?.lastActivityAt || task.lastActivityAt;
    const age = stamp ? (Date.now() - new Date(stamp).getTime()) / 86_400_000 : Infinity;
    if (age < Number(filters.staleDays)) return false;
  }
  if (filters.blocked === "unblocked" && task.isBlocked) return false;
  return true;
}

function currentExecutionView() {
  return findView(state.board?.savedViews || [], state.executionView);
}

function baseFilteredActiveTasks({ executionView = null } = {}) {
  const search = state.search.toLowerCase();
  const me = state.scope === "mine" ? myDeveloper() : null;
  const now = new Date();
  const matches = (task) => {
    const searchHit = !search || [
      task.title,
      task.description,
      task.assignee,
      task.projectName,
      task.projectId,
      task.execution?.milestone,
      ...taskTagNames(task)
    ]
      .some((value) => String(value || "").toLowerCase().includes(search));
    const projectHit = state.projectId === "all" || task.projectId === state.projectId;
    const ownerHit = state.scope !== "mine" || (me && task.assignee === me);
    const viewHit = !executionView || taskMatchesView(task, executionView, now);
    return searchHit && projectHit && ownerHit && viewHit;
  };
  const groups = groupActiveTasks(activeTasks());
  return groups.flatMap((group) => {
    const hitMembers = group.members.filter(matches);
    if (!hitMembers.length) return [];
    const includeParent = hitMembers.some((task) =>
      task.groupRole === "parent" || task.parentTaskKey === group.parent.taskKey
    );
    return includeParent ? group.members : hitMembers;
  });
}

function filteredActiveTasks() {
  return baseFilteredActiveTasks({ executionView: currentExecutionView() });
}

function groupActiveTasks(tasks) {
  const groups = new Map();
  tasks.forEach((task) => {
    const key = task.groupKey || task.taskKey;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(task);
  });
  return [...groups.entries()].map(([key, members]) => ({
    key,
    parent: members.find((task) => task.groupRole === "parent") || members[0],
    members: [...members].sort((a, b) => {
      if (a.groupRole !== b.groupRole) return a.groupRole === "parent" ? -1 : 1;
      return String(a.projectName).localeCompare(String(b.projectName), "zh-CN");
    })
  }));
}

function myDeveloper() {
  const project = currentProject();
  if (project?.developer) return project.developer;
  const developers = [...new Set((state.board?.projects || []).map((item) => item.developer).filter(Boolean))];
  return developers.length === 1 ? developers[0] : null;
}

function taskProgress(task) {
  const requiredStages = task.stages.filter((stage) => !stage.optional);
  const done = requiredStages.filter((stage) => stage.complete || stage.source === "manual").length;
  const total = requiredStages.length || task.stages.length;
  return { done, total, percent: total ? Math.round((done / total) * 100) : 0 };
}

function nextStage(task) {
  return task.stages.find((stage) => stage.id === task.derivedStage)
    || task.stages.find((stage) => !stage.complete)
    || task.stages[task.stages.length - 1];
}

const STAGE_SOURCE_LABELS = {
  "e2e-report": "E2E 报告",
  "check-report": "检查报告",
  "implementation-report": "实施报告",
  "prd-acceptance": "PRD 验收",
  "implement-plan": "实施计划",
  "task-json": "task.json",
  status: "任务状态",
  file: "任务文件",
  workspace: "工作区",
  archive: "归档目录",
  "archive-gap": "历史推断",
  "group-child": "子任务汇总",
  manual: "人工记录",
  report: "任务报告",
  missing: "无证据"
};

function stageSourceLabel(stage) {
  if (!stage.complete) return stage.optional ? "可选未记录" : "待确认";
  return STAGE_SOURCE_LABELS[stage.source] || stage.source || "有证据";
}

function laneForTask(task) {
  return laneForStageIndex(task, task.stages.findIndex((stage) => stage.id === task.derivedStage));
}

function isAttention(task) {
  if (task.archived) return false;
  return (task.execution?.attentionReasons || []).length > 0 ||
    task.groupRelationsValid === false;
}

function stageAdvice(task, stage) {
  if (stage.optional) {
    return task.archived
      ? "可选验证，未记录不影响归档历史"
      : "按任务风险决定是否执行，不影响进入收尾";
  }
  if (task.archived) return "归档后仅作历史证据，不参与当前推进";
  if (stage.complete) return "可以点击覆盖为人工确认";
  return "点击可记录人工完成；不会自动补齐前序阶段";
}

function stageName(task, stage) {
  return task.stages.find((item) => item.id === stage)?.label || stage;
}

function taskByKey(taskKey) {
  return state.board?.tasks.find((task) => task.taskKey === taskKey) ||
    state.teamPage?.tasks.find((task) => task.taskKey === taskKey) ||
    null;
}

function taskGroupMembers(task, tasks = activeTasks()) {
  const groupKey = task?.groupKey || task?.taskKey;
  if (!task || !groupKey) return [];
  return tasks.filter((candidate) =>
    (candidate.groupKey || candidate.taskKey) === groupKey
  );
}

function taskGroupParent(task) {
  if (task?.groupRole === "parent") return task;
  if (!task?.groupKey) return null;
  return taskGroupMembers(task, state.board?.tasks || [])
    .find((member) => member.groupRole === "parent") || null;
}

function taskGroupChildCount(task) {
  return taskGroupMembers(task)
    .filter((member) => member.groupRole === "child")
    .length;
}

function isGroupedChild(task) {
  return task?.groupRole === "child";
}

function dueLabel(dueDate, now = new Date()) {
  if (!dueDate) return "未设截止";
  const distance = dueDateDistance(dueDate, now);
  if (distance == null) return dueDate;
  if (distance < 0) return `逾期 ${Math.abs(distance)} 天`;
  if (distance === 0) return "今天截止";
  if (distance === 1) return "明天截止";
  if (distance <= 7) return `${distance} 天后截止`;
  return dueDate;
}

function formatShortDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("zh-CN", {
    month: "2-digit",
    day: "2-digit"
  });
}

function formatEventTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatDuration(milliseconds) {
  const value = Math.max(0, Number(milliseconds) || 0);
  const days = Math.floor(value / 86_400_000);
  if (days > 0) return `${days} 天`;
  const hours = Math.floor(value / 3_600_000);
  if (hours > 0) return `${hours} 小时`;
  return `${Math.max(1, Math.floor(value / 60_000))} 分钟`;
}

function formatMetricDuration(milliseconds) {
  if (milliseconds == null || !Number.isFinite(Number(milliseconds))) return "—";
  const value = Math.max(0, Number(milliseconds));
  if (value < 60_000) return "<1 分钟";
  const days = Math.floor(value / 86_400_000);
  const hours = Math.floor((value % 86_400_000) / 3_600_000);
  const minutes = Math.floor((value % 3_600_000) / 60_000);
  if (days) return `${days} 天${hours ? ` ${hours} 小时` : ""}`;
  if (hours) return `${hours} 小时${minutes ? ` ${minutes} 分钟` : ""}`;
  return `${minutes} 分钟`;
}

function attentionReasons(task) {
  return (task.execution?.attentionReasons || [])
    .map((reason) => ({ id: reason, label: ATTENTION_REASON_LABELS[reason] || reason }));
}

function attentionChips(task, limit = 3) {
  return attentionReasons(task)
    .slice(0, limit)
    .map((reason) => `<span class="attention-chip reason-${safe(reason.id)}">${safe(reason.label)}</span>`)
    .join("");
}

function tagChips(task, limit = 3) {
  const tags = taskTagNames(task);
  return [
    ...tags.slice(0, limit).map((tag) => `<span class="plan-tag">${safe(tag)}</span>`),
    tags.length > limit ? `<span class="plan-tag">+${tags.length - limit}</span>` : ""
  ].join("");
}

function riskBadges(task) {
  const execution = task.execution || {};
  const dorCount = Number(execution.risk?.dorMissingCount || 0);
  const dodCount = Number(execution.risk?.dodMissingCount || 0);
  return [
    execution.isBlocked
      ? `<span class="risk-pill is-blocked">被 ${execution.blockedByCount || 0} 项阻断</span>`
      : "",
    execution.blocksCount
      ? `<span class="risk-pill">阻断 ${execution.blocksCount} 项</span>`
      : "",
    dorCount ? `<span class="risk-pill">DoR 缺 ${dorCount}</span>` : "",
    dodCount ? `<span class="risk-pill">DoD 缺 ${dodCount}</span>` : ""
  ].filter(Boolean).join("");
}

function planMetaMarkup(task) {
  const execution = task.execution || {};
  return `
    <div class="plan-meta">
      <span class="plan-due">${safe(dueLabel(execution.dueDate))}</span>
      ${execution.milestone ? `<span class="plan-milestone">${safe(execution.milestone)}</span>` : ""}
      ${tagChips(task)}
      ${riskBadges(task)}
    </div>`;
}

function processTape(task) {
  return `<ol class="process-tape" aria-label="任务 13 阶段证据">
    ${task.stages.map((stage) => {
      const current = stage.id === task.derivedStage;
      const stateClass = current
        ? "is-current"
        : stage.complete
          ? stage.source === "manual" ? "is-manual" : "is-done"
          : stage.optional ? "is-optional" : "";
      return `<li class="${stateClass}" ${current ? 'aria-current="step"' : ""}>
        <span>${String(stage.index).padStart(2, "0")}</span>
        <b>${safe(stage.label)}</b>
        <small>${current ? "NOW" : stage.complete ? (stage.source === "manual" ? "◇" : "●") : stage.optional ? "○" : "—"}</small>
      </li>`;
    }).join("")}
  </ol>`;
}

function executionReasonText(task) {
  const labels = attentionReasons(task).map((reason) => reason.label);
  if (labels.length) return `现在推进的理由：${labels.join("、")}。`;
  if (task.derivedStage === "review") return "规划产物已备，适合完成评审后进入实现。";
  if (task.derivedStage === "implement") return "任务已经进入实现，继续推进可以尽快进入检查。";
  if (task.derivedStage === "check") return "检查阶段待收口，完成验证后即可进入后续收尾。";
  return "当前没有额外注意力信号，可按流程继续推进。";
}

function recommendedTask(tasks) {
  const weights = {
    identity_conflict: 100,
    overdue: 90,
    blocked: 85,
    due_soon: 75,
    unblocked_ready: 65,
    priority: 60,
    checking: 50,
    implementing: 40,
    stale: 25
  };
  const priorityWeight = { P0: 18, P1: 10, P2: 4, P3: 0 };
  return [...tasks].sort((left, right) => {
    const score = (task) => (task.execution?.attentionReasons || [])
      .reduce((total, reason) => total + (weights[reason] || 0), 0) +
      (priorityWeight[task.priority] || 0);
    return score(right) - score(left) ||
      String(left.execution?.dueDate || "9999-99-99")
        .localeCompare(String(right.execution?.dueDate || "9999-99-99")) ||
      String(left.title).localeCompare(String(right.title), "zh-CN");
  })[0] || null;
}

function renderExecutionViews() {
  const savedViews = state.board?.savedViews || [];
  const available = [...BUILTIN_VIEWS, ...savedViews];
  if (!available.some((view) => view.id === state.executionView)) {
    state.executionView = "all";
  }
  const view = currentExecutionView();
  const visibleTasksByView = new Map(available.map((item) => [
    item.id,
    baseFilteredActiveTasks({ executionView: item })
  ]));
  els.executionViewList.innerHTML = available.map((item) => {
    const custom = !BUILTIN_VIEWS.some((builtin) => builtin.id === item.id);
    const count = visibleTasksByView.get(item.id).length;
    return `<span class="execution-view-item">
      <button class="execution-view-button ${state.executionView === item.id ? "is-active" : ""}" data-execution-view="${safe(item.id)}" type="button">
        ${safe(item.name)} <b>${count}</b>
      </button>
      ${custom ? `<button class="execution-view-delete" data-delete-view="${safe(item.id)}" type="button" aria-label="删除视图 ${safe(item.name)}">×</button>` : ""}
    </span>`;
  }).join("") + `
    <button id="new-view-button" class="execution-view-new" type="button">＋ 组合视图</button>`;
  const visibleTasks = visibleTasksByView.get(view.id);
  els.executionViewSummary.textContent = `${view.name} · ${visibleTasks.length} 项`;
  els.executionDateLabel.textContent = new Date().toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short"
  });
  els.executionViewList.querySelectorAll("[data-execution-view]").forEach((button) => {
    button.addEventListener("click", () => {
      state.executionView = button.dataset.executionView;
      renderAll();
      document.querySelector(`[data-execution-view="${CSS.escape(state.executionView)}"]`)?.focus();
    });
  });
  els.executionViewList.querySelectorAll("[data-delete-view]").forEach((button) => {
    button.addEventListener("click", () => deleteSavedView(button.dataset.deleteView));
  });
  document.querySelector("#new-view-button").addEventListener("click", openViewDialog);
}

function renderFlowSignals() {
  const tasks = baseFilteredActiveTasks();
  const implementationWip = Number.isInteger(state.board?.flow?.implementationWip)
    ? state.board.flow.implementationWip
    : tasks.filter((task) => task.derivedStage === "implement").length;
  const implementationLimit = Number(state.board?.flow?.implementationLimit || 2);
  const blocked = tasks.filter((task) => task.execution?.isBlocked);
  const unblockedReady = tasks.filter((task) => task.execution?.isUnblockedReady);
  const dorGapCount = tasks.filter((task) =>
    Number(task.execution?.risk?.dorMissingCount || 0) > 0
  ).length;
  const dodGapCount = tasks.filter((task) =>
    Number(task.execution?.risk?.dodMissingCount || 0) > 0
  ).length;
  const boardWideScope = state.projectId === "all" &&
    state.scope === "all" &&
    !state.search;
  const blockedDurationMs = boardWideScope
    ? Number(state.board?.flow?.blockedDurationMs || 0)
    : blocked.reduce(
      (total, task) => total + Number(task.execution?.blockedDurationMs || 0),
      0
    );
  const wipState = ["normal", "at_limit", "over_limit"].includes(
    state.board?.flow?.wipState
  )
    ? state.board.flow.wipState
    : implementationWip > implementationLimit
      ? "over_limit"
      : implementationWip === implementationLimit ? "at_limit" : "normal";
  els.flowWipValue.textContent = `${implementationWip} / ${implementationLimit}`;
  els.flowWipState.textContent = wipState === "over_limit"
    ? `超出软上限 ${implementationWip - implementationLimit} 项，仅提醒`
    : wipState === "at_limit"
      ? "已达到软上限，仅提醒，不阻止阶段确认"
      : "软限制，不影响阶段确认";
  els.flowBlockedValue.textContent = blocked.length;
  els.flowBlockedDuration.textContent = blocked.length
    ? `活动阻断累计 ${formatDuration(blockedDurationMs)}，查看队列`
    : "没有活动阻断";
  els.flowReadyValue.textContent = unblockedReady.length;
  els.flowGapValue.textContent = `${dorGapCount} / ${dodGapCount}`;
  if (document.activeElement !== els.flowWipLimit) {
    els.flowWipLimit.value = implementationLimit;
  }
}

function renderFocus() {
  const task = recommendedTask(filteredActiveTasks());
  if (!task) {
    els.focusCard.innerHTML = `<div class="focus-empty">
      <p class="panel-kicker">NEXT MOVE / 下一次动作</p>
      <h2>当前视图没有可推荐任务</h2>
      <p>调整项目、负责人、搜索或注意力视图，也可以创建一条新任务。</p>
    </div>`;
    return;
  }
  const execution = task.execution || {};
  els.focusCard.innerHTML = `
    <div class="focus-top">
      <p class="panel-kicker">NEXT MOVE / 下一次动作</p>
      <span class="priority-stamp ${safe(String(task.priority || "P2").toLowerCase())}">${safe(task.priority || "P2")}</span>
    </div>
    <h2>${safe(task.title)}</h2>
    <p class="focus-description">${safe(task.description || "没有任务描述")}</p>
    <div class="focus-meta">
      <span>${safe(task.projectName)}</span>
      <span>${safe(dueLabel(execution.dueDate))}</span>
      ${execution.milestone ? `<span>${safe(execution.milestone)}</span>` : ""}
      ${tagChips(task, 5)}
    </div>
    <div class="focus-reasons">
      ${attentionChips(task, 5) || `<span class="attention-chip">${safe(nextStage(task).label)}</span>`}
      <p>${safe(executionReasonText(task))}</p>
    </div>
    ${processTape(task)}
    <div class="focus-actions">
      <button class="primary-button" data-task="${safe(task.taskKey)}" type="button">打开任务详情</button>
      <button class="secondary-button" data-edit-execution="${safe(task.taskKey)}" type="button" ${canWriteTask(task) ? "" : "disabled"}>编辑计划字段</button>
      <span class="history-state">${execution.historyStatus === "tracking"
        ? `事件自 ${safe(formatShortDate(execution.trackingStartedAt))} 起追踪；旧历史缺失`
        : "历史缺失：尚未建立追踪基线"}</span>
    </div>`;
  bindTaskButtons(els.focusCard);
  bindExecutionActions(els.focusCard);
}

function attentionSortScore(task) {
  const weights = {
    identity_conflict: 100,
    overdue: 90,
    blocked: 85,
    due_soon: 75,
    unblocked_ready: 65,
    priority: 60,
    checking: 50,
    implementing: 40,
    stale: 25
  };
  return (task.execution?.attentionReasons || [])
    .reduce((total, reason) => total + (weights[reason] || 0), 0);
}

function renderAttentionQueue() {
  const tasks = baseFilteredActiveTasks()
    .filter(isAttention)
    .sort((left, right) => attentionSortScore(right) - attentionSortScore(left) ||
      String(left.execution?.dueDate || "9999-99-99")
        .localeCompare(String(right.execution?.dueDate || "9999-99-99")));
  els.attentionCount.textContent = tasks.length;
  els.attentionQueue.innerHTML = tasks.length
    ? tasks.slice(0, 6).map((task) => {
      const reasons = attentionReasons(task);
      const parent = isGroupedChild(task) ? taskGroupParent(task) : null;
      return `<button class="attention-item reason-${safe(reasons[0]?.id || "default")}" data-task="${safe(task.taskKey)}" type="button">
        <span class="attention-type">${safe(reasons[0]?.label || "需要关注")}</span>
        ${isGroupedChild(task) ? `<span class="attention-parent-path">
          <span class="attention-parent-branch" aria-hidden="true"></span>
          ${parent
            ? `<span class="attention-parent-label">父任务</span><span class="attention-parent-title" title="${safe(parent.title)}">${safe(parent.title)}</span>`
            : '<span class="attention-parent-title">组内子任务</span>'}
        </span>` : ""}
        <strong>${safe(task.title)}</strong>
        <small>${safe(task.projectName)} · ${safe(nextStage(task).label)} · ${safe(dueLabel(task.execution?.dueDate))}</small>
        <span class="attention-item-tags">${tagChips(task, 2)}</span>
      </button>`;
    }).join("")
    : `<div class="attention-empty">当前范围没有需要额外关注的任务。</div>`;
  bindTaskButtons(els.attentionQueue);
}

function renderMetrics() {
  const active = filteredActiveTasks();
  const scopedActive = baseFilteredActiveTasks();
  const archives = archivedTasks();
  const owners = new Set(scopedActive.map((task) => task.assignee).filter(Boolean));
  const attention = scopedActive.filter(isAttention);
  const view = currentExecutionView();
  els.metricActive.textContent = active.length;
  els.metricActiveCaption.textContent = state.executionView === "all"
    ? state.projectId === "all"
      ? "全部仓库中的进行中任务"
      : `${currentProject()?.name || state.projectId} 的进行中任务`
    : `${view.name} · 当前组合视图`;
  const scopedArchived = state.projectId === "all"
    ? archives.length
    : archives.filter((task) => task.projectId === state.projectId).length;
  els.metricArchive.textContent = scopedArchived;
  els.metricArchiveCaption.textContent = `${scopedActive.length} 个进行中 / 当前范围共 ${scopedActive.length + scopedArchived} 个`;
  els.metricAttention.textContent = attention.length;
  els.metricTeam.textContent = owners.size;
  els.metricTeamCaption.textContent = owners.size ? [...owners].join(" · ") : "暂无负责人";
}

function renderProjects() {
  const projects = state.teamMode
    ? state.teamProjects
    : state.board?.projects || [];
  els.projectCount.textContent = projects.length;
  const allCount = state.teamMode
    ? (state.teamPage?.total ?? projects.reduce((sum, project) => sum + project.activeCount, 0))
    : state.board?.tasks.length || 0;
  const all = `
    <button class="project-pill ${state.projectId === "all" ? "is-active" : ""}" data-project="all" type="button">
      <span class="marker"></span>
      <span class="name">${state.teamMode ? "全部授权项目" : "全部仓库"}</span>
      <span class="count">${allCount}</span>
    </button>`;
  const rows = projects.map((project, index) => `
    <button class="project-pill ${state.projectId === project.id ? "is-active" : ""}" ${state.teamMode ? `data-team-project-index="${index}"` : `data-project="${safe(project.id)}"`} type="button">
      <span class="marker"></span>
      <span class="name" title="${safe(project.name)} · ${safe(state.teamMode ? teamSyncLabel(project.syncStatus) : project.path)}">${safe(project.name)}</span>
      <span class="count">${escapeHtml(project.activeCount)}</span>
    </button>`).join("");
  els.projectList.innerHTML = all + rows;
  els.projectList.querySelectorAll("[data-project], [data-team-project-index]").forEach((button) => {
    button.addEventListener("click", () => {
      state.projectId = button.dataset.teamProjectIndex == null
        ? button.dataset.project
        : projects[Number(button.dataset.teamProjectIndex)]?.id;
      state.scope = "all";
      state.view = "pipeline";
      syncScopeButtons();
      if (state.teamMode) {
        void selectTeamProject(state.projectId);
      } else {
        renderAll();
      }
    });
  });
  if (state.teamMode) syncTeamVisibility();
}

function setProjectFormMessage(message, isError = false) {
  els.projectFormMessage.hidden = false;
  els.projectFormMessage.textContent = message;
  els.projectFormMessage.classList.toggle("is-error", isError);
}

function hideProjectFormMessage() {
  els.projectFormMessage.hidden = true;
  els.projectFormMessage.classList.remove("is-error");
}

function folderDisplayName(folderPath) {
  return String(folderPath || "").split(/[\\/]/).filter(Boolean).pop() || folderPath;
}

function folderPathKey(folderPath) {
  return String(folderPath || "").replaceAll("/", "\\").toLowerCase();
}

function renderSelectedProjectFolders() {
  const folders = state.selectedFolders;
  els.selectedFolderCount.textContent = folders.length
    ? `已选择 ${folders.length} 个文件夹`
    : "尚未选择";
  els.projectSubmit.disabled = !folders.length || state.pickingFolders || state.addingProjects;
  els.pickFoldersButton.disabled = state.pickingFolders || state.addingProjects;
  els.pickFoldersButton.textContent = state.pickingFolders ? "等待选择…" : "选择文件夹";

  if (!folders.length) {
    els.selectedFolders.innerHTML = `
      <div class="selected-folders-empty">
        点击“选择文件夹”，可在系统窗口中一次选中多个项目目录。
      </div>`;
    return;
  }

  els.selectedFolders.innerHTML = folders.map((folderPath, index) => `
    <div class="selected-folder-row">
      <span class="selected-folder-index">${String(index + 1).padStart(2, "0")}</span>
      <span class="selected-folder-copy">
        <strong>${safe(folderDisplayName(folderPath))}</strong>
        <small title="${safe(folderPath)}">${safe(folderPath)}</small>
      </span>
      <button type="button" data-remove-folder="${index}" aria-label="移除 ${safe(folderPath)}">×</button>
    </div>
  `).join("");
  els.selectedFolders.querySelectorAll("[data-remove-folder]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedFolders.splice(Number(button.dataset.removeFolder), 1);
      if (state.selectedFolders.length) {
        setProjectFormMessage(`待提交列表还有 ${state.selectedFolders.length} 个文件夹。`);
      } else {
        hideProjectFormMessage();
      }
      renderSelectedProjectFolders();
    });
  });
}

function renderProjectManager() {
  const projects = state.board?.projects || [];
  if (!projects.length) {
    els.projectManagerList.innerHTML = `
      <div class="managed-project-empty">
        <strong>看板还没有项目</strong>
        <span>点击上方“选择文件夹”，加入一个或多个已初始化 Trellis 的本地仓库。</span>
      </div>`;
    return;
  }
  els.projectManagerList.innerHTML = projects.map((project) => `
    <article class="managed-project">
      <div class="managed-project-main">
        <div class="managed-project-title">
          <strong>${safe(project.name)}</strong>
          ${project.developer ? `<span>@${safe(project.developer)}</span>` : ""}
        </div>
        <div class="managed-project-path" title="${safe(project.path)}">${safe(project.path)}</div>
        ${project.error ? `<div class="managed-project-error">扫描异常：${safe(project.error)}</div>` : ""}
      </div>
      <div class="managed-project-counts" aria-label="任务数量">
        <span><b>${project.activeCount || 0}</b> 进行中</span>
        <span><b>${project.archivedCount || 0}</b> 已归档</span>
      </div>
      <button class="project-remove-button" type="button" data-remove-project="${safe(project.id)}">
        移除
      </button>
    </article>
  `).join("");
  els.projectManagerList.querySelectorAll("[data-remove-project]").forEach((button) => {
    button.addEventListener("click", () => removeManagedProject(button));
  });
}

function openProjectDialog() {
  state.selectedFolders = [];
  state.pickingFolders = false;
  state.addingProjects = false;
  hideProjectFormMessage();
  renderSelectedProjectFolders();
  renderProjectManager();
  if (!els.projectDialog.open) els.projectDialog.showModal();
}

async function pickProjectFolders() {
  if (state.pickingFolders || state.addingProjects) return;
  state.pickingFolders = true;
  renderSelectedProjectFolders();
  setProjectFormMessage("请在弹出的 Windows 文件夹选择框中选择一个或多个目录。");
  try {
    const result = await api("/api/repositories/pick-folders", "POST");
    const existing = new Set(state.selectedFolders.map(folderPathKey));
    let added = 0;
    (result.paths || []).forEach((folderPath) => {
      const key = folderPathKey(folderPath);
      if (existing.has(key)) return;
      existing.add(key);
      state.selectedFolders.push(folderPath);
      added += 1;
    });
    if (added) {
      setProjectFormMessage(`已加入待提交列表：${added} 个文件夹。`);
    } else if (result.paths?.length) {
      setProjectFormMessage("所选文件夹已经在待提交列表中。");
    } else {
      setProjectFormMessage("未选择新的文件夹。");
    }
  } catch (error) {
    setProjectFormMessage(error.message, true);
  } finally {
    state.pickingFolders = false;
    renderSelectedProjectFolders();
  }
}

async function submitProject(event) {
  event.preventDefault();
  if (!state.selectedFolders.length || state.pickingFolders || state.addingProjects) return;

  state.addingProjects = true;
  renderSelectedProjectFolders();
  setProjectFormMessage(`正在校验 ${state.selectedFolders.length} 个项目、更新监听并重新扫描…`);
  try {
    const result = await api("/api/repositories", "POST", { paths: state.selectedFolders });
    const repositories = result.repositories || [result.repository].filter(Boolean);
    state.selectedFolders = [];
    state.projectId = repositories.length === 1 ? repositories[0].id : "all";
    state.scope = "all";
    state.view = "pipeline";
    const loaded = await loadBoard(false, true);
    if (!loaded) throw new Error("项目已加入，但看板刷新失败，请稍后重新扫描");
    renderProjectManager();
    setProjectFormMessage(
      repositories.length === 1
        ? `“${repositories[0].name}”已加入看板，文件监听也已更新。`
        : `已加入 ${repositories.length} 个项目，文件监听已更新为 ${state.board.projects.length} 个仓库。`
    );
  } catch (error) {
    setProjectFormMessage(error.message, true);
  } finally {
    state.addingProjects = false;
    renderSelectedProjectFolders();
  }
}

async function removeManagedProject(button) {
  const project = state.board?.projects.find((item) => item.id === button.dataset.removeProject);
  if (!project) return;
  const confirmed = window.confirm(
    `从看板移除“${project.name}”？\n\n只会修改看板白名单，不会删除项目目录、任务或归档文件。`
  );
  if (!confirmed) return;

  button.disabled = true;
  setProjectFormMessage(`正在从看板移除“${project.name}”…`);
  try {
    await api("/api/repositories", "DELETE", { id: project.id });
    if (state.projectId === project.id) state.projectId = "all";
    if (state.archiveProject === project.id) state.archiveProject = "all";
    const loaded = await loadBoard(false, true);
    if (!loaded) throw new Error("项目已移除，但看板刷新失败，请稍后重新扫描");
    renderProjectManager();
    setProjectFormMessage(`“${project.name}”已从看板移除，源文件保持不变。`);
  } catch (error) {
    button.disabled = false;
    setProjectFormMessage(error.message, true);
  }
}

function syncScopeButtons() {
  document.querySelectorAll(".segment").forEach((segment) => {
    segment.classList.toggle("is-active", segment.dataset.scope === state.scope);
  });
}

function renderPipeline() {
  const tasks = filteredActiveTasks();
  const groups = groupActiveTasks(tasks);
  const lanes = STAGE_LANES.map((lane) => {
    const laneGroups = groups.filter((group) => laneForTask(group.parent) === lane.id);
    return `
      <section class="lane">
        <header class="lane-head">
          <h3><span class="lane-index">${String(STAGE_LANES.indexOf(lane) + 1).padStart(2, "0")}</span>${lane.label}</h3>
          <span class="lane-count">${laneGroups.length}</span>
        </header>
        <div class="lane-body">
          ${laneGroups.length ? laneGroups.map(renderTaskFamily).join("") : `<div class="team-empty">${lane.hint} · 当前无任务</div>`}
        </div>
      </section>`;
  }).join("");
  els.pipeline.innerHTML = tasks.length ? lanes : emptyMarkup();
  const counts = STAGE_LANES.map((lane) =>
    groups.filter((group) => laneForTask(group.parent) === lane.id).length
  );
  els.kanbanSummary.innerHTML = STAGE_LANES
    .map((lane, index) => `<span>${safe(lane.label)} <b>${counts[index]}</b></span>`)
    .join("");
  bindTaskButtons(els.pipeline);
  bindExecutionActions(els.pipeline);
}

function executionEditButton(task, className = "task-edit-button") {
  const conflict = task.executionIdentityValid === false || task.executionIdentityConflict === true;
  const writable = canWriteTask(task);
  const disabled = task.archived || conflict || !writable;
  const message = task.archived
    ? "归档任务只读"
    : !writable
      ? "只读成员不能修改计划字段"
      : conflict
        ? "任务执行身份冲突，请修正 task.json id"
        : "编辑计划字段";
  return `<button class="${className}" data-edit-execution="${safe(task.taskKey)}" type="button" aria-label="${safe(message)}" title="${safe(message)}" ${disabled ? "disabled" : ""}>计划</button>`;
}

function renderTaskCard(task, extraClass = "") {
  const copyTaskKey = safe(task.taskKey);
  const copyTaskName = safe(task.dirName);
  return `<article class="task-card ${isAttention(task) ? "is-risk" : ""} ${extraClass}">
    <button class="task-card-open" data-task="${safe(task.taskKey)}" type="button" aria-label="打开任务 ${safe(task.title)}"></button>
    ${executionEditButton(task)}
    <div class="task-card-content">
      ${taskCardContent(task)}
      <button class="task-take-button task-card-take-button" data-copy-task="${copyTaskKey}" type="button" aria-label="${TASK_COPY_LABEL}：${copyTaskName}" title="复制任务名：${copyTaskName}">
        <span class="task-take-icon" aria-hidden="true">⧉</span>
        <span class="task-take-label">${TASK_COPY_LABEL}</span>
      </button>
    </div>
  </article>`;
}

function taskCardContent(task) {
  const progress = taskProgress(task);
  const next = nextStage(task);
  const relationRisk = task.groupRelationsValid === false
    ? `<span class="relation-risk" title="${safe((task.groupWarnings || []).join("；") || "任务关系需要修正")}">关系异常</span>`
    : "";
  return `
    <div class="task-card-top">
      <span class="task-project">${safe(task.projectName)}</span>
      <span class="task-badges">${relationRisk}<span class="priority ${safe(task.priority || "P2").toLowerCase()}">${safe(task.priority || "P2")}</span></span>
    </div>
    <h4>${safe(task.title)}</h4>
    ${planMetaMarkup(task)}
    <div class="mini-track" aria-label="已完成 ${progress.done}/${progress.total} 个必需阶段，E2E 为可选证据">
      ${task.stages.map((stage) => `<i class="${stage.complete ? (stage.source === "manual" ? "manual" : "done") : stage.optional ? "optional" : ""}" title="${safe(stage.label)}${stage.optional ? "（可选证据）" : ""} · ${safe(stage.evidence)}"></i>`).join("")}
    </div>
    <div class="task-attention-row">${attentionChips(task)}</div>
    <div class="task-card-foot">
      <span class="owner"><span class="avatar">${safe(initials(task.assignee))}</span>${safe(task.assignee || "未派发")}</span>
      <span>${safe(next.label)} · ${progress.percent}%</span>
    </div>`;
}

function renderTaskFamily(group) {
  if (group.members.length === 1) return renderTaskCard(group.parent);
  const parent = group.members.find((task) => task.groupRole === "parent");
  if (!parent) return group.members.map((task) => renderTaskCard(task)).join("");
  const children = group.members.filter((task) => task.taskKey !== parent.taskKey);
  return `
    <article class="task-family">
      <div class="family-kicker" title="父任务 · ${safe(parent.projectName)}">
        <span class="family-kicker-label">父任务 · ${safe(parent.projectName)}</span>
        <span class="family-child-count">${children.length} 个子任务</span>
      </div>
      ${renderTaskCard(parent, "is-family-parent")}
      <div class="family-children" aria-label="${safe(parent.title)} 的子任务">
        <p class="family-children-label">子任务</p>
        <div class="family-child-tree">
          ${children.map((task) => {
            const next = nextStage(task);
            const progress = taskProgress(task);
            return `<div class="family-child-row">
              <button class="family-child" data-task="${safe(task.taskKey)}" type="button">
                <span class="family-branch" aria-hidden="true"></span>
                <span class="family-child-copy">
                  <b>${safe(task.title)}</b>
                  <small>${safe(task.projectName)} · ${safe(task.status)}</small>
                </span>
                <span class="family-stage">${safe(next.label)} · ${progress.percent}%</span>
              </button>
              ${executionEditButton(task, "family-edit-button")}
            </div>`;
          }).join("")}
        </div>
      </div>
    </article>`;
}

function renderTeamTask(task, { child = false } = {}) {
  const next = nextStage(task);
  return `<div class="team-task ${child ? "team-subtask" : ""}">
    <button class="team-task-link" data-task="${safe(task.taskKey)}" type="button" title="${safe(task.title)}">
      <span class="team-task-title">${safe(task.title)}</span>
    </button>
    <span class="stage-chip">${safe(next.label)}</span>
    ${executionEditButton(task, "team-edit-button")}
    <small>${safe(task.projectName)} · ${safe(task.status)}</small>
  </div>`;
}

function renderTeamGroup(group) {
  const members = group.members;
  const localParent = members.find((task) => task.groupRole === "parent") || null;
  const parent = localParent || taskGroupParent(members[0]);
  const childCount = taskGroupChildCount(parent || members[0]);
  // loader 会给独立任务默认 groupRole=parent；只有真实多成员或活动子任务才进入组布局。
  const grouped = members.length > 1 || childCount > 0;
  if (!grouped) return renderTeamTask(members[0]);

  const children = parent
    ? members.filter((task) => task.taskKey !== parent.taskKey)
    : members;
  let header;
  if (localParent) {
    header = `
      <div class="team-group-kicker" title="父任务 · ${safe(localParent.projectName)}">
        <span class="team-group-kicker-label">父任务 · ${safe(localParent.projectName)}</span>
        <span class="team-child-count">${childCount} 个子任务</span>
      </div>
      ${renderTeamTask(localParent)}`;
  } else if (parent) {
    // 负责人筛选可能把父任务放在另一张卡；只展示父上下文，不伪造本地父行。
    header = `<div class="team-parent-context" title="父任务：${safe(parent.title)} · ${safe(parent.assignee || "未派发")}">
      <span class="team-parent-branch" aria-hidden="true"></span>
      <span class="team-parent-label">父任务：</span>
      <span class="team-parent-title">${safe(parent.title)}</span>
      <small>· ${safe(parent.assignee || "未派发")}</small>
    </div>`;
  } else {
    const projects = [...new Set(members.map((task) => task.projectName).filter(Boolean))];
    header = `<div class="team-group-kicker">
      <span class="team-group-kicker-label">组内子任务 · ${safe(projects.join(" / ") || "未归属项目")}</span>
      <span class="team-child-count">${children.length} 个子任务</span>
    </div>`;
  }

  return `<section class="team-group" aria-label="${safe(parent?.title ? `${parent.title} 的任务组` : "组内子任务")}">
    ${header}
    ${children.length ? `<div class="team-subtree" aria-label="${safe(parent?.title ? `${parent.title} 的子任务` : "组内子任务")}">
      ${children.map((task) => renderTeamTask(task, { child: true })).join("")}
    </div>` : ""}
  </section>`;
}

function renderTeam() {
  const tasks = baseFilteredActiveTasks();
  const grouped = new Map();
  tasks.forEach((task) => {
    const owner = task.assignee || "未派发";
    if (!grouped.has(owner)) grouped.set(owner, []);
    grouped.get(owner).push(task);
  });
  if (!grouped.size) {
    els.team.innerHTML = emptyMarkup("团队视图没有可展示的任务");
    return;
  }
  els.team.innerHTML = [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b, "zh-CN"))
    .map(([owner, ownerTasks]) => `
      <article class="team-card">
        <div class="team-card-head">
          <div class="team-person">
            <span class="avatar">${safe(initials(owner))}</span>
            <div><strong>${safe(owner)}</strong><small>${ownerTasks.length} 个进行中任务</small></div>
          </div>
          <div class="team-stat"><b>${ownerTasks.filter(isAttention).length}</b>需关注</div>
        </div>
        ${groupActiveTasks(ownerTasks).map(renderTeamGroup).join("")}
      </article>`).join("");
  bindTaskButtons(els.team);
  bindExecutionActions(els.team);
}

function renderArchive() {
  const search = state.archiveSearch.toLowerCase();
  const tasks = sortArchivedTasks(archivedTasks()
    .filter((task) => state.archiveProject === "all" || task.projectId === state.archiveProject)
    .filter((task) => {
      if (!search) return true;
      return [task.title, task.assignee, task.projectName, task.description]
        .some((value) => String(value || "").toLowerCase().includes(search));
    }));
  const visibleTasks = tasks.slice(0, 80);
  els.archive.innerHTML = tasks.length
    ? visibleTasks.map((task) => `
      <button class="archive-row" data-task="${safe(task.taskKey)}" type="button">
        <span>
          <span class="archive-title">${safe(task.title)}</span>
          <span class="archive-sub">${safe(task.projectName)} · ${taskProgress(task).percent}% 可证实</span>
        </span>
        <span class="archive-sub">${safe(task.description || "无描述")}</span>
        <span class="archive-owner">${safe(task.assignee || "未派发")}</span>
        <span class="archive-date">${safe(formatArchiveTimestamp(task))}</span>
      </button>`).join("") + (tasks.length > visibleTasks.length
      ? `<p class="archive-limit">当前显示最近 ${visibleTasks.length} 条，共 ${tasks.length} 条；继续输入关键词可缩小范围。</p>`
      : "")
    : emptyMarkup("没有符合筛选条件的归档任务");
  bindTaskButtons(els.archive);
}

function renderArchiveOptions() {
  const projects = state.board?.projects || [];
  els.archiveProject.innerHTML = `<option value="all">全部项目</option>` + projects
    .map((project) => `<option value="${safe(project.id)}">${safe(project.name)}</option>`)
    .join("");
  els.archiveProject.value = state.archiveProject;
}

function bindTaskButtons(root) {
  root.querySelectorAll("[data-task]").forEach((button) => {
    const open = (event) => {
      if (event.target.closest("[data-edit-execution]")) return;
      const task = state.board.tasks.find((candidate) => candidate.taskKey === button.dataset.task);
      if (task) openTask(task);
    };
    button.addEventListener("click", open);
    if (button.getAttribute("role") === "button") {
      button.addEventListener("keydown", (event) => {
        if (event.target !== button || !["Enter", " "].includes(event.key)) return;
        event.preventDefault();
        open(event);
      });
    }
  });
  bindTaskCopyButtons(root);
}

function bindTaskCopyButtons(root) {
  root.querySelectorAll("[data-copy-task]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const task = taskByKey(button.dataset.copyTask);
      if (task) void copyTaskDirName(task, button);
    });
  });
}

function setTaskCopyButtonState(button, copied, dirName) {
  const label = button.querySelector(".task-take-label");
  if (label) label.textContent = copied ? TASK_COPIED_LABEL : TASK_COPY_LABEL;
  button.classList.toggle("is-copied", copied);
  button.classList.remove("is-error");
  button.setAttribute(
    "aria-label",
    copied
      ? `已复制任务名 ${dirName}`
      : `${TASK_COPY_LABEL}：${dirName}`
  );
}

function announceTaskCopy(button, message) {
  const feedback = button.closest("#task-dialog") ? els.dialogCopyFeedback : els.copyFeedback;
  if (!feedback) return;
  feedback.textContent = "";
  window.requestAnimationFrame(() => {
    feedback.textContent = message;
  });
}

function scheduleTaskCopyButtonReset(button, dirName, delay = 1600) {
  const previousTimer = taskCopyFeedbackTimers.get(button);
  if (previousTimer) window.clearTimeout(previousTimer);
  taskCopyFeedbackTimers.set(button, window.setTimeout(() => {
    if (button.isConnected) setTaskCopyButtonState(button, false, dirName);
  }, delay));
}

async function writeClipboardText(text, container = document.body) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Clipboard API 被策略拒绝时继续使用页面内降级复制。
    }
  }
  const previousFocus = document.activeElement;
  const textarea = document.createElement("textarea");
  textarea.className = "clipboard-fallback";
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  container.append(textarea);
  try {
    textarea.focus({ preventScroll: true });
    textarea.select();
    if (!document.execCommand?.("copy")) {
      throw new Error("浏览器拒绝访问剪贴板");
    }
  } finally {
    textarea.remove();
    if (previousFocus instanceof HTMLElement) {
      previousFocus.focus({ preventScroll: true });
    }
  }
}

async function copyTaskDirName(task, button) {
  if (!task?.dirName) {
    showError("当前任务缺少任务名，无法复制");
    return;
  }
  try {
    await writeClipboardText(task.dirName, button.closest("dialog[open]") || document.body);
    setTaskCopyButtonState(button, true, task.dirName);
    announceTaskCopy(button, `已复制任务名：${task.dirName}`);
    scheduleTaskCopyButtonReset(button, task.dirName);
  } catch {
    const message = "复制任务名失败，请允许浏览器访问剪贴板后重试";
    const label = button.querySelector(".task-take-label");
    if (label) label.textContent = "复制失败";
    button.classList.remove("is-copied");
    button.classList.add("is-error");
    button.setAttribute("aria-label", message);
    announceTaskCopy(button, message);
    if (!button.closest("#task-dialog")) showError(message);
    button.focus({ preventScroll: true });
    scheduleTaskCopyButtonReset(button, task.dirName, 2200);
  }
}

function bindExecutionActions(root) {
  root.querySelectorAll("[data-edit-execution]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const key = button.dataset.editExecution;
      const task = state.selectedTask?.taskKey === key
        ? state.selectedTask
        : taskByKey(key);
      if (task && canWriteTask(task)) openExecutionDialog(task);
    });
  });
}

function setUndoMessage(root, message, isError = false) {
  const target = root.querySelector(".undo-message");
  if (!target) return;
  target.textContent = message;
  target.classList.toggle("is-error", isError);
}

function bindUndoAction(task) {
  if (!canWriteTask(task)) return;
  const root = document.querySelector("#detail-summary");
  const button = root.querySelector("[data-undo-operation]");
  if (!button) return;
  button.addEventListener("click", async () => {
    if (state.savingUndo || button.disabled) return;
    const label = button.dataset.undoLabel || "最近一次可逆操作";
    if (!window.confirm(
      `确认撤销“${label}”？\n\n原始事件会保留，系统将恢复修改前状态并追加补偿事件。`
    )) return;

    state.savingUndo = true;
    button.disabled = true;
    button.textContent = "正在撤销…";
    setUndoMessage(root, "正在校验当前状态并写入同一事务…");
    let operationWritten = false;
    try {
      await api("/api/tasks/undo", "POST", {
        projectId: task.projectId,
        taskPath: task.relativeDir
      });
      operationWritten = true;
      if (state.teamMode) {
        const loaded = await refreshTeamData({ quiet: true });
        if (!loaded) throw new Error("撤销已保存，但团队看板刷新失败");
        openTask({ ...task, artifacts: undefined });
        return;
      }
      state.board = await api("/api/board");
      updateSyncLabel();
      renderAll();
      const fresh = taskByKey(task.taskKey);
      if (!fresh) {
        els.taskDialog.close();
        return;
      }
      openTask(fresh);
    } catch (error) {
      setUndoMessage(root, error.message, true);
    } finally {
      state.savingUndo = false;
      if (button.isConnected) {
        button.disabled = operationWritten;
        button.textContent = operationWritten ? "已撤销 · 待刷新" : "撤销最近操作";
      }
    }
  });
}

function setDependencyMessage(root, message, isError = false) {
  const target = root.querySelector(".dependency-form-message") ||
    root.querySelector(".risk-dependency .dependency-empty");
  if (!target) {
    showError(message);
    return;
  }
  target.textContent = message;
  target.classList.toggle("is-error", isError);
}

async function reloadTaskAfterDependency(task) {
  const loaded = await loadBoard();
  if (!loaded) throw new Error("依赖已保存，但看板刷新失败");
  if (state.teamMode) {
    openTask({ ...task, artifacts: undefined });
    return;
  }
  const fresh = taskByKey(task.taskKey);
  if (!fresh) {
    els.taskDialog.close();
    return;
  }
  openTask(fresh);
}

function bindDependencyActions(task) {
  if (!canWriteTask(task)) return;
  const root = document.querySelector("#detail-summary");
  const form = root.querySelector("[data-dependency-form]");
  if (form) {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (state.savingDependency) return;
      const blockerKey = form.elements.blockerTaskKey.value;
      const blocker = taskByKey(blockerKey);
      const reason = form.elements.reason.value.trim();
      if (!blocker) {
        setDependencyMessage(root, "请选择当前看板中的阻断方任务", true);
        form.elements.blockerTaskKey.focus();
        return;
      }
      if (!reason) {
        setDependencyMessage(root, "阻断原因不能为空", true);
        form.elements.reason.focus();
        return;
      }
      if (Array.from(reason).length > 500) {
        setDependencyMessage(root, "阻断原因不能超过 500 个字符", true);
        form.elements.reason.focus();
        return;
      }
      state.savingDependency = true;
      const submit = form.querySelector(".dependency-submit");
      submit.disabled = true;
      submit.textContent = "正在创建…";
      setDependencyMessage(root, "正在写入依赖与事件；失败时不会留下部分数据。");
      try {
        await api("/api/tasks/dependencies", "POST", {
          blocked: {
            projectId: task.projectId,
            taskPath: task.relativeDir
          },
          blocker: {
            projectId: blocker.projectId,
            taskPath: blocker.relativeDir
          },
          reason
        });
        await reloadTaskAfterDependency(task);
      } catch (error) {
        setDependencyMessage(root, error.message, true);
        if (
          error.message.includes("循环") ||
          error.message.includes("已经存在") ||
          error.message.includes("身份冲突")
        ) {
          form.elements.blockerTaskKey.focus();
        } else {
          form.elements.reason.focus();
        }
      } finally {
        state.savingDependency = false;
        submit.disabled = false;
        submit.textContent = "创建依赖";
      }
    });
  }
  root.querySelectorAll("[data-resolve-dependency]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (state.savingDependency) return;
      state.savingDependency = true;
      const controls = [
        ...root.querySelectorAll("[data-resolve-dependency], [data-dependency-form] button")
      ];
      const disabledStates = controls.map((control) => ({
        control,
        disabled: control.disabled
      }));
      controls.forEach((control) => {
          control.disabled = true;
      });
      button.textContent = "正在解除…";
      setDependencyMessage(root, "正在解除依赖并保留历史记录…");
      try {
        await api("/api/tasks/dependencies", "DELETE", {
          id: button.dataset.resolveDependency
        });
        await reloadTaskAfterDependency(task);
      } catch (error) {
        setDependencyMessage(root, error.message, true);
        disabledStates.forEach(({ control, disabled }) => {
          control.disabled = disabled;
        });
        button.textContent = "解除依赖";
        button.focus();
      } finally {
        state.savingDependency = false;
      }
    });
  });
}

function setExecutionMessage(text, isError = false) {
  els.executionMessage.hidden = false;
  els.executionMessage.textContent = text;
  els.executionMessage.classList.toggle("is-error", isError);
}

function openExecutionDialog(task) {
  if (!task) return;
  if (task.archived) {
    showError("归档任务只读，不能修改计划字段");
    return;
  }
  if (task.executionIdentityValid === false || task.executionIdentityConflict === true) {
    showError("任务执行身份冲突，请修正 task.json id");
    return;
  }
  state.editingExecutionTaskKey = task.taskKey;
  document.querySelector("#execution-dialog-title").textContent = task.title;
  document.querySelector("#execution-due-date").value = task.execution?.dueDate || "";
  document.querySelector("#execution-milestone").value = task.execution?.milestone || "";
  document.querySelector("#execution-tags").value = taskTagNames(task).join(", ");
  els.executionMessage.hidden = true;
  els.executionMessage.classList.remove("is-error");
  els.executionSubmit.disabled = false;
  els.executionDialog.showModal();
  requestAnimationFrame(() => document.querySelector("#execution-due-date").focus());
}

async function submitExecution(event) {
  event.preventDefault();
  if (state.savingExecution) return;
  const task = state.selectedTask?.taskKey === state.editingExecutionTaskKey
    ? state.selectedTask
    : taskByKey(state.editingExecutionTaskKey);
  if (!task) {
    setExecutionMessage("任务已不在当前看板中，请重新扫描。", true);
    return;
  }
  let tags;
  try {
    tags = normalizeTagsInput(document.querySelector("#execution-tags").value, {
      rejectEmpty: true
    });
  } catch (error) {
    setExecutionMessage(error.message, true);
    document.querySelector("#execution-tags").focus();
    return;
  }
  const wasDetailOpen = els.taskDialog.open;
  state.savingExecution = true;
  els.executionSubmit.disabled = true;
  els.executionSubmit.textContent = "正在保存…";
  setExecutionMessage("正在写入看板 SQLite；目标仓库 task.json 不会变化。");
  try {
    await api("/api/tasks/execution", "PUT", {
      projectId: task.projectId,
      taskPath: task.relativeDir,
      dueDate: document.querySelector("#execution-due-date").value || null,
      milestone: document.querySelector("#execution-milestone").value,
      tags
    });
    const loaded = await loadBoard();
    if (!loaded) throw new Error("计划字段已保存，但看板刷新失败");
    els.executionDialog.close();
    if (wasDetailOpen) {
      if (state.teamMode) {
        openTask({ ...task, artifacts: undefined });
        return;
      }
      const fresh = taskByKey(task.taskKey);
      if (fresh) openTask(fresh);
    }
  } catch (error) {
    setExecutionMessage(error.message, true);
  } finally {
    state.savingExecution = false;
    els.executionSubmit.disabled = false;
    els.executionSubmit.textContent = "保存计划字段";
  }
}

function setFlowWipMessage(message, isError = false) {
  els.flowWipMessage.textContent = message;
  els.flowWipMessage.classList.toggle("is-error", isError);
}

async function submitFlowWip(event) {
  event.preventDefault();
  if (state.savingWip) return;
  const value = Number(els.flowWipLimit.value);
  if (!Number.isInteger(value) || value < 1 || value > 9) {
    setFlowWipMessage("WIP 软上限必须是 1 到 9 的整数", true);
    els.flowWipLimit.focus();
    return;
  }
  state.savingWip = true;
  els.flowWipSubmit.disabled = true;
  els.flowWipSubmit.textContent = "正在保存…";
  setFlowWipMessage("正在保存软上限；它不会阻止任何阶段操作。");
  try {
    await api("/api/board/settings", "PUT", { executionWipLimit: value });
    const loaded = await loadBoard();
    if (!loaded) throw new Error("软上限已保存，但看板刷新失败");
    setFlowWipMessage("已保存。达到或超出上限只会提醒。");
  } catch (error) {
    setFlowWipMessage(error.message, true);
  } finally {
    state.savingWip = false;
    els.flowWipSubmit.disabled = false;
    els.flowWipSubmit.textContent = "保存";
  }
}

function renderViewStageOptions() {
  document.querySelector("#view-stage-options").innerHTML = FILTER_STAGES.map((stage) => `
    <label><input type="checkbox" name="view-stage" value="${safe(stage.id)}" /> ${safe(stage.label)}</label>
  `).join("");
}

function setViewMessage(text, isError = false) {
  els.viewMessage.hidden = false;
  els.viewMessage.textContent = text;
  els.viewMessage.classList.toggle("is-error", isError);
}

function openViewDialog() {
  els.viewForm.reset();
  els.viewMessage.hidden = true;
  els.viewMessage.classList.remove("is-error");
  els.viewSubmit.disabled = false;
  els.viewDialog.showModal();
  requestAnimationFrame(() => document.querySelector("#view-name").focus());
}

function checkedValues(name) {
  return [...document.querySelectorAll(`input[name="${name}"]:checked`)]
    .map((input) => input.value);
}

function optionalInteger(input) {
  const value = input.value.trim();
  if (!value) return undefined;
  const number = Number(value);
  if (!Number.isInteger(number)) throw new Error(input.labels?.[0]?.textContent?.trim() || "请输入整数");
  return number;
}

async function submitView(event) {
  event.preventDefault();
  if (state.savingView) return;
  const name = document.querySelector("#view-name").value.trim();
  let tags;
  try {
    tags = normalizeTagsInput(document.querySelector("#view-tags").value);
  } catch (error) {
    setViewMessage(error.message, true);
    return;
  }
  const filter = {
    priorities: checkedValues("view-priority"),
    stages: checkedValues("view-stage"),
    tags
  };
  try {
    const dueWithinDays = optionalInteger(document.querySelector("#view-due-days"));
    const staleDays = optionalInteger(document.querySelector("#view-stale-days"));
    if (dueWithinDays !== undefined) filter.dueWithinDays = dueWithinDays;
    if (staleDays !== undefined) filter.staleDays = staleDays;
  } catch (error) {
    setViewMessage(error.message, true);
    return;
  }
  if (!name) {
    setViewMessage("视图名称不能为空", true);
    document.querySelector("#view-name").focus();
    return;
  }
  if (!filter.priorities.length) delete filter.priorities;
  if (!filter.stages.length) delete filter.stages;
  if (!filter.tags.length) delete filter.tags;
  const blocked = document.querySelector("#view-blocked").value;
  if (blocked !== "any") filter.blocked = blocked;
  if (!Object.keys(filter).length) {
    setViewMessage("至少勾选或填写一个筛选条件", true);
    return;
  }

  state.savingView = true;
  els.viewSubmit.disabled = true;
  els.viewSubmit.textContent = "正在保存…";
  setViewMessage("正在保存组合筛选条件…");
  try {
    const result = await api("/api/saved-views", "POST", { name, filter });
    els.viewDialog.close();
    state.executionView = result.view.id;
    await loadBoard();
  } catch (error) {
    setViewMessage(error.message, true);
  } finally {
    state.savingView = false;
    els.viewSubmit.disabled = false;
    els.viewSubmit.textContent = "保存组合视图";
  }
}

async function deleteSavedView(id) {
  const view = state.board?.savedViews?.find((candidate) => candidate.id === id);
  if (!view) return;
  if (!window.confirm(`删除组合视图“${view.name}”？内置视图不会被修改。`)) return;
  try {
    await api("/api/saved-views", "DELETE", { id });
    if (state.executionView === id) state.executionView = "all";
    await loadBoard();
  } catch (error) {
    showError(error.message);
  }
}

function emptyMarkup(message = "没有符合当前筛选的任务") {
  return `<div class="empty-state">
    <div class="empty-mark" aria-hidden="true">⌁</div>
    <strong>${safe(message)}</strong>
    <span>换一个项目、负责人或搜索词；也可以创建一条新任务。</span>
  </div>`;
}

function renderTaskLoading(task) {
  document.querySelector("#dialog-project").textContent = `${task.projectName || "团队项目"} / ${task.dirName || "任务"}`;
  document.querySelector("#dialog-title").textContent = task.title || "正在读取任务";
  document.querySelector("#dialog-meta").innerHTML = `
    <span>状态 <b>${safe(task.archived ? "已归档" : "进行中")}</b></span>
    <span>负责人 <b>${safe(task.assignee || "未派发")}</b></span>
    <span>项目 <b>${safe(task.projectName || "未知")}</b></span>
    <span>任务版本 <b>${safe(taskVersion(task) ?? "待读取")}</b></span>`;
  document.querySelector("#detail-summary").innerHTML = `<div class="task-loading">
    <strong>正在读取任务详情和产物…</strong>
    <span>团队接口会重新校验当前账号对项目的访问权限。</span>
  </div>`;
  document.querySelector("#stage-detail").innerHTML = "";
  document.querySelector("#assign-button").style.display = "none";
  document.querySelector(".assign-inline label").style.display = "none";
  document.querySelector("#assignee-input").style.display = "none";
  document.querySelector("#detail-edit-execution").hidden = true;
  renderSelectedTeamTaskActions(task);
}

function openTask(task) {
  state.selectedTask = task;
  document.querySelector("#task-dialog .dialog-body").scrollTop = 0;
  const content = loadTaskDetail(task).catch((error) => {
    showError(error.message);
    return null;
  });
  content.then(async (detail) => {
    if (!detail || !els.taskDialog.open || state.selectedTask?.taskKey !== task.taskKey) return;
    if (state.teamMode && detail.projectId) {
      await loadTeamProjectMembers(detail.projectId);
      if (!els.taskDialog.open || state.selectedTask?.taskKey !== task.taskKey) return;
    }
    state.selectedTask = detail;
    const project = state.board?.projects.find((candidate) => candidate.id === detail.projectId);
    if (project && Array.isArray(detail.projectMembers)) {
      project.members = detail.projectMembers;
    }
    renderTaskDetail(detail);
  });
  if (state.teamMode && !task.artifacts) {
    renderTaskLoading(task);
  } else {
    renderTaskDetail(task);
  }
  if (!els.taskDialog.open) els.taskDialog.showModal();
}

async function loadTaskDetail(task) {
  if (task.artifacts) return task;
  if (state.teamMode) {
    const key = task.executionTaskKey || task.taskKey;
    if (!key) throw new Error("任务缺少 executionTaskKey");
    const payload = await api(`/api/tasks/${encodeURIComponent(key)}`);
    return payload.task || payload;
  }
  return api("/api/task", "POST", {
    projectId: task.projectId,
    taskPath: task.relativeDir
  });
}

const EVENT_TYPE_LABELS = {
  tracking_started: "开始追踪",
  stage_observed: "扫描观察",
  stage_manual_confirmed: "人工确认阶段",
  task_plan_updated: "计划字段更新",
  dependency_created: "新增阻断依赖",
  dependency_resolved: "解除阻断依赖",
  operation_undone: "撤销操作"
};

const EVENT_SOURCE_LABELS = {
  user: "人工",
  scan: "扫描",
  system: "系统"
};

const METRIC_COMPLETENESS_LABELS = {
  missing: "历史缺失",
  partial: "部分覆盖",
  tracked: "证据完整"
};

function eventDescription(event) {
  const payload = event.payload || {};
  if (event.type === "tracking_started") {
    return `建立追踪基线；此前历史不补造。当前阶段 ${safe(payload.after?.derivedStage || "unknown")}`;
  }
  if (event.type === "stage_observed") {
    return `扫描观察：${safe(payload.before?.derivedStage || "unknown")} → ${safe(payload.after?.derivedStage || "unknown")}`;
  }
  if (event.type === "stage_manual_confirmed") {
    return `人工记录：${safe(payload.before?.stage || "无")} → ${safe(payload.after?.stage || "unknown")}`;
  }
  if (event.type === "task_plan_updated") {
    const beforeTags = payload.before?.tags || [];
    const afterTags = payload.after?.tags || [];
    return `截止 ${safe(payload.after?.dueDate || "空")}；里程碑 ${safe(payload.after?.milestone || "空")}；标签 ${beforeTags.length} → ${afterTags.length}`;
  }
  if (event.type === "dependency_created") {
    return `阻断方 ${safe(payload.blockerTaskKey)} → 被阻断 ${safe(payload.blockedTaskKey)}；原因：${safe(payload.reason)}`;
  }
  if (event.type === "dependency_resolved") {
    return `已解除 ${safe(payload.blockerTaskKey)} → ${safe(payload.blockedTaskKey)} 的阻断；原因：${safe(payload.reason)}`;
  }
  if (event.type === "operation_undone") {
    return `撤销了 ${safe(payload.targetLabel || payload.targetEventType || "最近操作")}；原事件与补偿事件均保留。`;
  }
  return safe(event.type);
}

function eventTechnicalMarkup(event) {
  let payload = "{}";
  try {
    payload = JSON.stringify(event.payload || {}, null, 2);
  } catch {
    payload = "事件附加信息无法序列化";
  }
  return `<details class="event-technical">
    <summary>技术详情</summary>
    <dl>
      <div><dt>事件</dt><dd>#${safe(event.id || "unknown")}</dd></div>
      <div><dt>操作组</dt><dd>${safe(event.correlationId || "未记录")}</dd></div>
      <div><dt>原始来源</dt><dd>${safe(event.source || "unknown")}</dd></div>
    </dl>
    <pre>${safe(payload)}</pre>
  </details>`;
}

function historyUndoMarkup(history, canEdit) {
  const undo = history.undo || {};
  const available = Boolean(undo.available) && canEdit;
  const status = available
    ? `可撤销：${undo.label || "最近一次可逆操作"}`
    : undo.disabledReason || "当前没有可撤销操作";
  return `<div class="history-undo">
    <p id="undo-operation-status">${safe(status)}</p>
    <button
      class="secondary-button small-button undo-button"
      type="button"
      data-undo-operation
      data-undo-label="${safe(undo.label || "最近一次可逆操作")}"
      ${available ? "" : "disabled"}
      ${undo.disabledReason ? `title="${safe(undo.disabledReason)}"` : ""}
      aria-describedby="undo-operation-status"
    >${available ? "撤销最近操作" : "暂不可撤销"}</button>
  </div>
  <p class="undo-message" aria-live="polite"></p>`;
}

function executionHistoryMarkup(task) {
  const execution = task.execution || {};
  const conflict = task.executionIdentityValid === false || task.executionIdentityConflict;
  const canEdit = !task.archived && !conflict;
  const history = execution.history || {
    events: Array.isArray(execution.events) ? execution.events : [],
    eventTotal: Number(execution.eventTotal || 0),
    eventLimit: Number(execution.eventLimit || 1000),
    truncated: Boolean(execution.eventTruncated),
    windowStartAt: execution.eventWindowStartAt || null,
    undo: {}
  };
  const events = Array.isArray(history.events) ? history.events : [];
  const historyError = execution.historyError || history.error || null;
  const total = Number(history.eventTotal || events.length);
  const limit = Number(history.eventLimit || 1000);
  return `<section class="execution-history" aria-labelledby="execution-history-title">
    <div class="insight-section-head">
      <div>
        <h3 id="execution-history-title">操作历史</h3>
        <p>按时间倒序；人工操作、扫描观察与系统基线分开标记。</p>
      </div>
      <span class="insight-count">${safe(events.length)} / ${safe(total)} 条</span>
    </div>
    ${historyError ? `<p class="insight-local-error" role="alert">历史增强信息读取失败：${safe(historyError)}。下方仍显示已读取的原始事件。</p>` : ""}
    ${historyUndoMarkup(history, canEdit)}
    <div class="event-timeline" role="region" tabindex="0" aria-label="任务事件时间线">
      ${events.length ? events.map((event) => `<article class="event-item event-source-${safe(["user", "scan", "system"].includes(event.source) ? event.source : "unknown")}">
        <time datetime="${safe(event.occurredAt)}">${safe(formatEventTime(event.occurredAt) || "时间未知")}</time>
        <div class="event-item-body">
          <div class="event-item-title">
            <strong>${safe(EVENT_TYPE_LABELS[event.type] || event.type)}</strong>
            <span class="event-source-label">${safe(EVENT_SOURCE_LABELS[event.source] || event.source || "未知来源")}</span>
          </div>
          <p>${eventDescription(event)}</p>
          <small>操作者 ${safe(event.actor || "system")} · 操作组 ${safe(String(event.correlationId || "").slice(0, 8) || "未记录")}</small>
          ${eventTechnicalMarkup(event)}
        </div>
      </article>`).join("") : `<p class="event-empty">尚无事件；下一次扫描会建立追踪基线。</p>`}
    </div>
    ${history.truncated || total > events.length
      ? `<p class="event-limit">仅显示最近 ${safe(events.length)} 条，共 ${safe(total)} 条；只有窗口内无法确认候选组时才禁用撤销。</p>`
      : `<p class="event-limit">事件窗口上限 ${safe(limit)} 条；本轮窗口未截断。</p>`}
  </section>`;
}

function executionMetricsMarkup(task) {
  const execution = task.execution || {};
  const metrics = execution.metrics || {};
  const completeness = ["missing", "partial", "tracked"].includes(metrics.completeness)
    ? metrics.completeness
    : "missing";
  const reasons = Array.isArray(metrics.missingReasons) ? metrics.missingReasons : [];
  const stageDurations = Array.isArray(metrics.stageDurations) ? metrics.stageDurations : [];
  const window = metrics.eventWindow || {};
  const observedSince = formatEventTime(metrics.observedSince);
  const maxStageDuration = Math.max(
    1,
    ...stageDurations.map((item) => Number(item.durationMs) || 0)
  );
  const blockedRatio = Number.isFinite(Number(metrics.blockedRatio))
    ? Math.round(Number(metrics.blockedRatio) * 1000) / 10
    : null;
  return `<section class="execution-metrics" aria-labelledby="execution-metrics-title">
    <div class="insight-section-head">
      <div>
        <h3 id="execution-metrics-title">执行指标</h3>
        <p>${observedSince ? `从 ${safe(observedSince)} 开始追踪，不补造启用前历史。` : "尚未建立可信追踪起点。"}</p>
      </div>
      <span class="metric-completeness is-${safe(completeness)}">${safe(METRIC_COMPLETENESS_LABELS[completeness])}</span>
    </div>
    ${execution.metricsError ? `<p class="insight-local-error" role="alert">指标计算失败：${safe(execution.metricsError)}</p>` : ""}
    ${reasons.length
      ? `<ul class="metric-reasons">${reasons.map((reason) => `<li>${safe(reason)}</li>`).join("")}</ul>`
      : ""}
    ${completeness === "missing"
      ? `<p class="metric-missing-note">证据不足，不展示可能误导的精确时长。${window.truncated ? "当前事件窗口也已截断。" : ""}</p>`
      : completeness === "partial"
        ? `<div class="metric-kpi-grid is-qualitative">
            <div>
              <small>Lead Time · 追踪后</small>
              <strong>${metrics.leadTimeOpen ? "追踪仍在进行" : "覆盖不完整"}</strong>
              <span>不显示精确时长</span>
            </div>
            <div>
              <small>Cycle Time · 实现到检查</small>
              <strong>${metrics.cycleTimeOpen ? "检查尚未完成" : "覆盖不完整"}</strong>
              <span>不以窗口补造完整耗时</span>
            </div>
            <div>
              <small>阶段停留</small>
              <strong>${stageDurations.length ? "仅部分节点" : "阶段节点不足"}</strong>
              <span>缺少可精确拆分区间</span>
            </div>
            <div>
              <small>阻断时间占比</small>
              <strong>${blockedRatio == null ? "无法计算" : "覆盖不完整"}</strong>
              <span>不显示估算占比</span>
            </div>
          </div>
          <p class="metric-partial-note">当前为部分覆盖，只展示状态，不把最近事件窗口换算成看似精确的历史。</p>`
        : `<div class="metric-kpi-grid">
          <div>
            <small>Lead Time · 追踪后</small>
            <strong>${safe(formatMetricDuration(metrics.leadTimeMs))}</strong>
            <span>${metrics.leadTimeOpen ? "仍在进行" : "已到归档终点"}</span>
          </div>
          <div>
            <small>Cycle Time · 实现到检查</small>
            <strong>${safe(formatMetricDuration(metrics.cycleTimeMs))}</strong>
            <span>${metrics.cycleTimeOpen ? "等待检查完成" : "检查节点已出现"}</span>
          </div>
          <div>
            <small>阶段回流</small>
            <strong>${safe(metrics.reworkCount || 0)} 次</strong>
            <span>按阶段索引逆序计数</span>
          </div>
          <div>
            <small>阻断时间占比</small>
            <strong>${blockedRatio == null ? "无法计算" : `${safe(blockedRatio)}%`}</strong>
            <span>${metrics.blockedTimeMs == null ? "缺少追踪窗口" : `累计 ${safe(formatMetricDuration(metrics.blockedTimeMs))}`}</span>
          </div>
        </div>
        ${blockedRatio == null ? "" : `<div class="metric-share" aria-label="阻断时间占比 ${safe(blockedRatio)}%">
          <div><span style="width:${Math.max(0, Math.min(100, blockedRatio))}%"></span></div>
          <small>阻断 ${safe(formatMetricDuration(metrics.blockedTimeMs))} / 观察 ${safe(formatMetricDuration(metrics.observedWindowMs))}</small>
        </div>`}
        ${stageDurations.length ? `<div class="metric-stage-list">
          <h4>阶段停留</h4>
          ${stageDurations.map((item) => {
            const duration = Number(item.durationMs);
            const width = Number.isFinite(duration)
              ? Math.max(3, Math.round((duration / maxStageDuration) * 100))
              : 0;
            return `<div class="metric-stage-row">
              <span>${safe(item.label || item.stageId)}</span>
              <div role="img" aria-label="${safe(item.label || item.stageId)}停留${item.open ? "进行中" : formatMetricDuration(item.durationMs)}">
                <i style="width:${width}%"></i>
              </div>
              <small>${item.open ? "进行中" : safe(formatMetricDuration(item.durationMs))}</small>
            </div>`;
          }).join("")}
        </div>` : ""}`}
    <p class="metric-window">事件窗口 ${safe(Number(window.total || 0))} 条${window.truncated ? `，仅取最近 ${safe(Number(window.limit || 1000))} 条` : ""}。指标可由事件集重建，不使用文件修改时间补值。</p>
  </section>`;
}

function blockerOptions(task) {
  const tasks = state.board?.tasks?.length
    ? state.board.tasks
    : state.teamPage?.tasks || [];
  return tasks
    .filter((candidate) =>
      !candidate.archived &&
      candidate.taskKey !== task.taskKey &&
      candidate.executionIdentityValid !== false &&
      candidate.executionIdentityConflict !== true
    )
    .sort((left, right) =>
      String(left.projectName).localeCompare(String(right.projectName), "zh-CN") ||
      String(left.title).localeCompare(String(right.title), "zh-CN")
    );
}

function dependencyItemsMarkup(items, relation, canEdit) {
  if (!items.length) {
    return `<p class="dependency-empty">${relation === "blocked"
      ? "当前没有活动阻断。"
      : "这个任务目前没有阻断其他任务。"}</p>`;
  }
  return `<div class="dependency-list">
    ${items.map((item) => `<article class="dependency-item">
      <div>
        <span class="dependency-direction">${safe(relation === "blocked" ? "阻断我" : "我阻断")}</span>
        <strong>${safe(item.title)}</strong>
        <small>${safe(item.projectName)} · ${safe(item.createdBy || "本机用户")} · 已持续 ${safe(formatDuration(item.durationMs))}</small>
      </div>
      <p>${safe(item.reason)}</p>
      <div class="dependency-item-foot">
        <time datetime="${safe(item.createdAt)}">${safe(formatEventTime(item.createdAt))}</time>
        <button class="text-button dependency-resolve-button" data-resolve-dependency="${safe(item.id)}" type="button" ${canEdit ? "" : "disabled"}>
          解除依赖
        </button>
      </div>
    </article>`).join("")}
  </div>`;
}

function resolvedDependencyItemsMarkup(items, relation) {
  return items.map((item) => `<article class="dependency-item is-resolved">
    <div>
      <span class="dependency-direction is-resolved">${safe(relation === "blocked" ? "已解除 · 曾阻断我" : "已解除 · 我曾阻断")}</span>
      <strong>${safe(item.title)}</strong>
      <small>${safe(item.projectName)} · 持续 ${safe(formatDuration(item.durationMs))} · ${safe(formatEventTime(item.resolvedAt))} 解除</small>
    </div>
    <p>${safe(item.reason)}</p>
    <div class="dependency-item-foot">
      <time datetime="${safe(item.createdAt)}">创建于 ${safe(formatEventTime(item.createdAt))}</time>
    </div>
  </article>`).join("");
}

function missingRiskMarkup(title, items) {
  return `<details class="risk-gap" ${items.length ? "" : "open"}>
    <summary>${safe(title)}：${items.length ? `缺 ${items.length} 项` : "已齐备"}</summary>
    ${items.length
      ? `<ul>${items.map((item) => `<li>${safe(item)}</li>`).join("")}</ul>`
      : '<p>当前没有派生缺口。</p>'}
  </details>`;
}

function riskDependencyMarkup(task) {
  const execution = task.execution || {};
  const risk = execution.risk || {};
  const conflict = task.executionIdentityValid === false || task.executionIdentityConflict;
  const canEdit = !task.archived && !conflict && canWriteTask(task);
  if (!Array.isArray(execution.blockedBy) || !Array.isArray(execution.blocks)) {
    return `<section class="risk-dependency">
      <h3>风险与依赖</h3>
      <p class="dependency-empty">依赖与 DoR/DoD 明细正在读取…</p>
    </section>`;
  }
  const candidates = blockerOptions(task);
  const blockedBy = execution.blockedBy;
  const blocks = execution.blocks;
  const resolvedBlockedBy = Array.isArray(execution.resolvedBlockedBy)
    ? execution.resolvedBlockedBy
    : [];
  const resolvedBlocks = Array.isArray(execution.resolvedBlocks)
    ? execution.resolvedBlocks
    : [];
  const stateText = execution.isBlocked
    ? `当前被 ${blockedBy.length} 项依赖阻断`
    : execution.isUnblockedReady
      ? "已有阻断解除，当前无活动阻断，可继续推进"
      : "当前没有活动阻断";
  const wipText = task.archived || task.derivedStage !== "implement"
    ? "当前阶段不计入实现中 WIP"
    : risk.wipState === "over_limit"
      ? "实现中 WIP 超出软上限"
      : risk.wipState === "at_limit"
        ? "实现中 WIP 达到软上限"
        : "实现中 WIP 在软上限内";
  return `<section class="risk-dependency">
    <div class="execution-detail-head">
      <h3>风险与依赖</h3>
      <span class="risk-state-text">${safe(stateText)} · ${safe(wipText)}</span>
    </div>
    <div class="dependency-columns">
      <div>
        <h4>Blocked by / 被谁阻断</h4>
        ${dependencyItemsMarkup(blockedBy, "blocked", canEdit)}
      </div>
      <div>
        <h4>Blocks / 阻断了谁</h4>
        ${dependencyItemsMarkup(blocks, "blocks", canEdit)}
      </div>
    </div>
    ${resolvedBlockedBy.length || resolvedBlocks.length ? `<details class="dependency-history">
      <summary>已解除依赖：曾被阻断 ${resolvedBlockedBy.length} 项 · 曾阻断其他任务 ${resolvedBlocks.length} 项</summary>
      <div class="dependency-history-grid">
        <div class="dependency-list">
          ${resolvedDependencyItemsMarkup(resolvedBlockedBy, "blocked")}
        </div>
        <div class="dependency-list">
          ${resolvedDependencyItemsMarkup(resolvedBlocks, "blocks")}
        </div>
      </div>
    </details>` : ""}
    ${canEdit ? `<form class="dependency-form" data-dependency-form>
      <label>
        <span>添加阻断方</span>
        <select name="blockerTaskKey" required ${candidates.length ? "" : "disabled"}>
          <option value="">${candidates.length ? "选择阻断本任务的任务" : "当前没有可选任务"}</option>
          ${candidates.map((candidate) => `<option value="${safe(candidate.taskKey)}">${safe(candidate.title)} · ${safe(candidate.projectName)}</option>`).join("")}
        </select>
      </label>
      <label class="dependency-reason-field">
        <span>阻断原因</span>
        <textarea name="reason" maxlength="500" required placeholder="说明为什么当前任务还不能继续，例如：等待计划字段模型确定"></textarea>
      </label>
      <button class="secondary-button dependency-submit" type="submit" ${candidates.length ? "" : "disabled"}>创建依赖</button>
      <span class="dependency-form-message" aria-live="polite"></span>
    </form>` : `<p class="dependency-empty">${task.archived
      ? "归档任务只读，不能新增或解除依赖。"
      : !canWriteTask(task)
        ? "只读成员不能新增或解除依赖。"
        : "执行身份冲突时不能修改依赖。"}</p>`}
    <div class="risk-gap-grid">
      ${missingRiskMarkup("DoR 缺口", Array.isArray(risk.dorMissing) ? risk.dorMissing : [])}
      ${missingRiskMarkup("DoD 缺口", Array.isArray(risk.dodMissing) ? risk.dodMissing : [])}
    </div>
    <p class="risk-disclaimer">DoR/DoD 只解释证据缺口，不阻止启动、检查、人工阶段确认或归档。</p>
  </section>`;
}

function executionDetailMarkup(task) {
  const execution = task.execution || {};
  const conflict = task.executionIdentityValid === false || task.executionIdentityConflict;
  const canEdit = !task.archived && !conflict && canWriteTask(task);
  const history = execution.historyStatus === "tracking"
    ? `追踪自 ${formatEventTime(execution.trackingStartedAt) || "未知时间"}；启用前的阶段历史缺失，不以文件修改时间补造。`
    : "历史缺失：尚未建立追踪基线。";
  return `<section class="execution-detail">
    <div class="execution-detail-head">
      <h3>计划与注意力</h3>
      <button class="secondary-button small-button" data-edit-execution="${safe(task.taskKey)}" type="button" ${canEdit ? "" : "disabled"}>
        编辑计划
      </button>
    </div>
    <div class="plan-value-grid">
      <div><small>截止</small><strong>${safe(dueLabel(execution.dueDate))}</strong></div>
      <div><small>里程碑</small><strong>${safe(execution.milestone || "未设置")}</strong></div>
      <div><small>标签</small><strong>${tagChips(task, 10) || "未设置"}</strong></div>
    </div>
    <div class="detail-attention-row">${attentionChips(task, 10) || '<span class="attention-chip">当前无注意力信号</span>'}</div>
    <p class="history-note">${safe(history)}</p>
    ${conflict ? '<p class="identity-conflict-note">执行身份冲突：同一 projectId 下存在重复 task.json id，扩展数据写入已禁用。</p>' : ""}
  </section>
  ${executionMetricsMarkup(task)}
  ${executionHistoryMarkup(task)}`;
}

function renderTaskDetail(task) {
  document.querySelector("#dialog-project").textContent = `${task.projectName} / ${task.dirName}`;
  document.querySelector("#dialog-title").textContent = task.title;
  const copyTaskButton = els.dialogCopyTask;
  const taskChanged = copyTaskButton.dataset.copyTask !== task.taskKey;
  copyTaskButton.dataset.copyTask = task.taskKey;
  copyTaskButton.disabled = !task.dirName;
  copyTaskButton.title = task.dirName ? `复制任务名：${task.dirName}` : "任务名缺失";
  if (taskChanged) {
    const previousTimer = taskCopyFeedbackTimers.get(copyTaskButton);
    if (previousTimer) window.clearTimeout(previousTimer);
    els.dialogCopyFeedback.textContent = "";
  }
  if (task.dirName) {
    if (taskChanged) setTaskCopyButtonState(copyTaskButton, false, task.dirName);
  } else {
    const label = copyTaskButton.querySelector(".task-take-label");
    if (label) label.textContent = "任务名缺失";
    copyTaskButton.classList.remove("is-copied", "is-error");
    copyTaskButton.setAttribute("aria-label", "任务名缺失，无法复制");
  }
  document.querySelector("#dialog-meta").innerHTML = `
    <span>状态 <b>${safe(task.status)}</b></span>
    <span>负责人 <b>${safe(task.assignee || "未派发")}</b></span>
    <span>创建 <b>${safe(task.createdAt || "未知")}</b></span>
    <span>分支 <b>${safe(task.branch || "未记录")}</b></span>
    <span>进度 <b>${taskProgress(task).percent}%</b></span>
    ${taskVersion(task) == null ? "" : `<span>任务版本 <b>v${safe(taskVersion(task))}</b></span>`}
    ${task.groupSize > 1 ? `<span>任务组 <b>${task.groupSize} 个${task.groupRole === "parent" ? " · 父任务" : " · 子任务"}</b></span>` : ""}`;
  const prdInfo = task.stages[0]?.evidence || "无 PRD 证据";
  const artifacts = task.artifacts || {};
  const availableArtifacts = ARTIFACT_DEFINITIONS
    .map((definition) => ({ ...definition, artifact: artifacts[definition.key] }))
    .filter((item) => item.artifact);
  const artifactMarkup = !task.artifacts
    ? `<p class="artifact-empty">任务产物正在读取…</p>`
    : availableArtifacts.length
      ? `<div class="artifact-launcher-list">
          ${availableArtifacts.map(({ key, label, hint, artifact }) => {
            const fileName = artifact.path.replaceAll("\\", "/").split("/").pop() || "Markdown";
            return `<button class="artifact-launcher" data-artifact-key="${key}" type="button">
              <span class="artifact-launcher-icon" aria-hidden="true">MD</span>
              <span class="artifact-launcher-copy">
                <b>${safe(label)}</b>
                <small>${safe(hint)} · ${safe(fileName)}${artifact.truncated ? " · 预览已截断" : ""}</small>
              </span>
              <span class="artifact-launcher-arrow" aria-hidden="true">↗</span>
            </button>`;
          }).join("")}
        </div>`
      : `<p class="artifact-empty">这个任务没有可读取的 Markdown 产物。</p>`;
  const groupTasks = (task.groupTaskKeys || [])
    .map((key) => state.board.tasks.find((candidate) => candidate.taskKey === key))
    .filter((candidate) => candidate && candidate.taskKey !== task.taskKey);
  const relationWarnings = [...new Set([
    ...(task.groupWarnings || []),
    ...(task.relationshipWarnings || []).map((warning) => warning.message)
  ].filter(Boolean))];
  const relationWarningBlock = relationWarnings.length
    ? `<div class="relation-warning-list">
        <strong>关系校验失败，阶段继承已暂停</strong>
        <ul>${relationWarnings.map((warning) => `<li>${safe(warning)}</li>`).join("")}</ul>
      </div>`
    : task.groupSize > 1
      ? `<p class="relation-valid">关系校验通过；此任务组共 ${task.groupSize} 个任务。</p>`
      : "";
  const relationBlock = task.groupSize > 1 || task.groupRelationsValid === false
    ? `<section><h3>任务关系</h3>
        ${task.groupSize > 1
          ? `<p>${task.groupRole === "parent" ? "这是父任务，子任务可跨仓库。" : "这是子任务，父任务负责汇总集成与验收。"}</p>`
          : "<p>没有建立可用的父子任务组。</p>"}
        ${relationWarningBlock}
        <div class="related-task-list">
          ${groupTasks.map((related) => `<button data-task="${safe(related.taskKey)}" type="button">
            <span>${related.groupRole === "parent" ? "父" : "子"}</span>
            <b>${safe(related.title)}</b>
            <small>${safe(related.projectName)} · ${safe(nextStage(related).label)}</small>
          </button>`).join("")}
        </div>
      </section>`
    : "";
  const currentStage = nextStage(task);
  const canWrite = canWriteTask(task);
  const keyStages = ["implement", "check", "e2e", "spec", "commit", "archive"]
    .map((id) => task.stages.find((stage) => stage.id === id))
    .filter(Boolean);
  const evidenceSummary = `<section><h3>状态依据</h3>
    <p><b>${safe(currentStage.label)}</b>：${safe(currentStage.evidence || "没有持久化证据，等待人工确认")}</p>
    <ul class="evidence-list">
      ${keyStages.map((stage) => `<li>
        <span>${safe(stage.label)}</span>
        <b>${safe(stageSourceLabel(stage))}</b>
        <small>${safe(stage.evidence || "无证据")}</small>
      </li>`).join("")}
    </ul>
  </section>`;
  document.querySelector("#detail-summary").innerHTML = `
    <section><h3>目标</h3><p>${safe(task.description || "没有任务描述")}</p></section>
    <section><h3>当前卡点</h3><p>${safe(currentStage.label)}：${safe(currentStage.evidence || "等待人工确认")}</p></section>
    ${executionDetailMarkup(task)}
    ${riskDependencyMarkup(task)}
    ${evidenceSummary}
    ${relationBlock}
    <section><h3>规划证据</h3><p>${safe(prdInfo)}</p></section>
    <section><h3>仓库上下文</h3><p>${safe(task.repoPath)}<br>${safe(task.relativeDir)}</p></section>
    <section><h3>任务产物</h3>${artifactMarkup}</section>
    <section><h3>写入边界</h3><p>任务状态来自 task.json，开发进度也会读取实施/检查报告；E2E 是可选的补充证据，不阻塞规范回写与收尾。归档后任务会同时变为 completed 并离开当前队列。</p></section>`;
  document.querySelector("#stage-detail").innerHTML = task.stages.map((stage) => `
    <button class="stage-row ${stage.complete ? (stage.source === "manual" ? "manual" : "done") : stage.optional ? "optional" : ""}" type="button" ${task.archived || !canWrite ? "disabled" : ""}>
      <span class="stage-number">${stage.index}</span>
      <div><strong>${safe(stage.label)}</strong><p>${safe(stage.evidence || "等待执行")}</p></div>
      <span class="stage-source ${stage.source === "manual" ? "manual-source" : ""}">${safe(stageSourceLabel(stage))}<br><small>${safe(stageAdvice(task, stage))}</small></span>
    </button>`).join("");
  bindTaskButtons(document.querySelector("#detail-summary"));
  bindArtifactButtons(document.querySelector("#detail-summary"));
  bindExecutionActions(document.querySelector("#detail-summary"));
  bindUndoAction(task);
  bindDependencyActions(task);
  bindStageActions(task);
  renderAssigneeOptions(task);
  const hideAssign = task.archived || !canWrite;
  document.querySelector("#assign-button").style.display = hideAssign ? "none" : "";
  document.querySelector(".assign-inline label").style.display = hideAssign ? "none" : "";
  document.querySelector("#assignee-input").style.display = hideAssign ? "none" : "";
  const detailEdit = document.querySelector("#detail-edit-execution");
  detailEdit.hidden = task.archived || !canWrite;
  detailEdit.disabled = !canWrite ||
    task.executionIdentityValid === false ||
    task.executionIdentityConflict === true;
  detailEdit.title = detailEdit.disabled
    ? "任务执行身份冲突，请修正 task.json id"
    : "编辑截止、里程碑和标签";
  renderSelectedTeamTaskActions(task);
}

function renderAssigneeOptions(task) {
  const project = state.board?.projects.find((candidate) => candidate.id === task.projectId);
  const rawMembers = state.teamMode
    ? assignableProjectMembers(teamProject(task.projectId) || project || {})
    : [...new Set(task.projectMembers || project?.members || [])].map((member) => ({
      displayName: member,
      trellisDevId: member
    }));
  const members = rawMembers.sort((a, b) =>
    String(a.displayName || a.trellisDevId).localeCompare(String(b.displayName || b.trellisDevId), "zh-CN")
  );
  const current = task.assignee || "";
  const select = document.querySelector("#assignee-input");
  select.innerHTML = [
    '<option value="">请选择负责人</option>',
    ...members.map((member) => {
      const value = member.trellisDevId || member.username || member.displayName;
      return `<option value="${safe(value)}">${safe(member.displayName || member.username || value)}</option>`;
    }),
    current && !members.some((member) =>
      [member.trellisDevId, member.username, member.displayName].includes(current)
    )
      ? `<option value="${safe(current)}" disabled>${safe(current)}（当前负责人，不在成员列表）</option>`
      : ""
  ].join("");
  select.value = members.some((member) =>
    [member.trellisDevId, member.username, member.displayName].includes(current)
  ) ? current : "";
  select.disabled = members.length === 0;
  updateAssignButtonState();
}

function updateAssignButtonState() {
  const assignee = document.querySelector("#assignee-input").value;
  document.querySelector("#assign-button").disabled = !assignee;
}

function bindArtifactButtons(root) {
  root.querySelectorAll("[data-artifact-key]").forEach((button) => {
    button.addEventListener("click", () => openArtifact(button.dataset.artifactKey));
  });
}

function openArtifact(key) {
  const task = state.selectedTask;
  const definition = ARTIFACT_DEFINITIONS.find((item) => item.key === key);
  const artifact = task?.artifacts?.[key];
  if (!task || !definition || !artifact) return;

  document.querySelector("#artifact-project").textContent = `${task.projectName} / ${definition.label}`;
  document.querySelector("#artifact-title").textContent = task.title;
  document.querySelector("#artifact-path").textContent = artifact.path;
  document.querySelector("#artifact-meta").innerHTML = `
    <span>产物 <b>${safe(definition.label)}</b></span>
    <span>格式 <b>Markdown</b></span>
    <span>内容 <b>${artifact.truncated ? "已截断，仅显示前 40,000 字符" : "完整"}</b></span>
    <span>负责人 <b>${safe(task.assignee || "未派发")}</b></span>`;
  document.querySelector("#artifact-content").innerHTML = renderMarkdown(artifact.content)
    || `<p class="artifact-empty">Markdown 文件为空。</p>`;
  document.querySelector("#artifact-scroll").scrollTop = 0;
  if (!els.artifactDialog.open) els.artifactDialog.showModal();
}

function bindStageActions(task) {
  if (!canWriteTask(task)) return;
  document.querySelectorAll("#stage-detail .stage-row").forEach((row) => {
    row.addEventListener("click", async () => {
      if (task.archived) return;
      const stage = task.stages[Number(row.querySelector(".stage-number").textContent) - 1];
      if (!stage) return;
      try {
        await api("/api/tasks/stage", "PUT", {
          projectId: task.projectId,
          taskPath: task.relativeDir,
          stage: stage.id
        });
        const loaded = await loadBoard();
        if (!loaded) throw new Error("阶段已保存，但看板刷新失败");
        if (state.teamMode) {
          openTask({ ...task, artifacts: undefined });
          return;
        }
        const fresh = state.board.tasks.find((candidate) => candidate.taskKey === task.taskKey);
        if (fresh) openTask(fresh);
      } catch (error) {
        showError(error.message);
      }
    });
  });
}

function showError(message) {
  els.error.hidden = false;
  els.error.textContent = message;
}

function hideError() {
  els.error.hidden = true;
}

async function apiRequest(url, method = "GET", body, options = {}) {
  try {
    return await requestJson(url, {
      method,
      body,
      headers: options.headers
    });
  } catch (error) {
    if (state.teamMode && error.status === 401 && error.code !== "AUTH_FAILED") {
      redirectToLogin();
    }
    throw error;
  }
}

async function api(url, method = "GET", body, options = {}) {
  const result = await apiRequest(url, method, body, options);
  return result.status === 304 ? null : result.data;
}

async function loadBoard(forceRefresh = false, quiet = false) {
  if (state.teamMode) return refreshTeamData({ quiet });
  if (state.loading && !quiet) return;
  state.loading = true;
  if (!quiet) {
    els.refresh.disabled = true;
    els.syncDot.classList.remove("is-live");
    els.syncLabel.textContent = "正在扫描仓库…";
  }
  hideError();
  try {
    if (forceRefresh) {
      await api("/api/board/refresh/start", "POST");
    }
    state.board = await api("/api/board");
    updateSyncLabel();
    renderAll();
    return true;
  } catch (error) {
    els.syncLabel.textContent = "扫描失败";
    showError(error.message);
    return false;
  } finally {
    state.loading = false;
    if (!quiet) els.refresh.disabled = false;
    scheduleStatusPoll();
  }
}

function updateSyncLabel() {
  if (!state.board) return;
  if (state.teamMode) {
    const projects = state.teamProjects;
    const stale = projects.filter((project) =>
      ["stale", "pending_push", "needs_repair"].includes(project.syncStatus)
    );
    els.syncLabel.textContent = stale.length
      ? `${projects.length} 个授权项目 · ${stale.length} 个需关注`
      : `${projects.length} 个授权项目 · 每 3 秒检查同步状态`;
    els.syncDot.classList.toggle("is-live", stale.length === 0);
    els.syncDot.title = "团队模式由服务端项目工作副本统一同步";
    return;
  }
  const status = state.status;
  const watcher = status?.watcher || state.board.watcher;
  const isRefreshing = Boolean(status?.refreshRunning || state.board.refreshRunning);
  const isQueued = Boolean(status?.refreshQueued || state.board.refreshQueued);
  const stamp = state.board.generatedAt
    ? ` · ${new Date(state.board.generatedAt).toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit"
    })}`
    : "";
  const sourceLabel = state.board.source === "cache" ? "缓存" : "完整扫描";

  if (isRefreshing) {
    els.syncLabel.textContent = isQueued
      ? `文件继续变更 · 当前显示${sourceLabel}`
      : `正在更新 · 当前显示${sourceLabel}`;
  } else if (watcher?.enabled) {
    const eventPath = watcher.lastEvent?.relativePath
      ? ` · ${watcher.lastEvent.relativePath}`
      : "";
    els.syncLabel.textContent = `文件监听中 · ${state.board.projects.length} 个仓库${stamp}${eventPath}`;
  } else {
    els.syncLabel.textContent = `${sourceLabel} · ${state.board.projects.length} 个仓库${stamp}`;
  }
  els.syncDot.classList.toggle("is-live", !isRefreshing);
  els.syncDot.title = watcher?.lastEvent
    ? `最近变更：${watcher.lastEvent.relativePath || "未知路径"}`
    : "监听 .trellis/tasks、workspace 与 .developer";
}

function scheduleStatusPoll(delay = 750) {
  if (state.pollTimer) clearTimeout(state.pollTimer);
  state.pollTimer = setTimeout(async () => {
    let nextDelay = 750;
    try {
      const status = await api("/api/board/status");
      state.status = status;
      nextDelay = status.refreshRunning || status.refreshQueued ? 250 : 750;
      const hasNewBoard = status.lastRefreshAt &&
        status.lastRefreshAt !== state.board?.generatedAt;
      if (hasNewBoard) {
        const waitForLoad = async () => {
          if (!state.loading) return;
          await new Promise((resolve) => setTimeout(resolve, 150));
          return waitForLoad();
        };
        await waitForLoad();
        await loadBoard(false, true);
      } else {
        updateSyncLabel();
      }
    } catch (error) {
      nextDelay = 1500;
      els.syncDot.classList.remove("is-live");
      els.syncLabel.textContent = "状态检查失败";
      showError(error.message);
    } finally {
      scheduleStatusPoll(nextDelay);
    }
  }, delay);
}

function teamProjectForBoard(project = {}) {
  return {
    ...project,
    id: String(project.id ?? project.repositoryId ?? ""),
    name: project.name || project.id || "未命名项目",
    path: project.syncBranch ? `共享分支 ${project.syncBranch}` : "团队项目",
    developer: project.trellisDevId || "",
    activeCount: Number(project.activeCount ?? project.taskCount ?? 0),
    archivedCount: Number(project.archivedCount ?? 0),
    branches: Array.isArray(project.branches) ? project.branches : [],
    members: state.teamMode
      ? normalizeProjectMembers(project)
      : Array.isArray(project.members)
        ? project.members.filter((member) => typeof member === "string")
        : []
  };
}

function teamProject(projectId = state.projectId) {
  return state.teamProjects.find((project) => String(project.id) === String(projectId)) || null;
}

function canWriteTask(task) {
  if (!state.teamMode) return true;
  const project = teamProject(task?.projectId);
  return Boolean(project && canWriteProject(project));
}

async function loadTeamProjectMembers(projectId, { quiet = true } = {}) {
  if (!state.teamMode || !projectId) return [];
  const project = teamProject(projectId);
  if (!project) return [];
  if (project.membersAuthoritative) return assignableProjectMembers(project);
  if (!canManageProject(project)) return assignableProjectMembers(project);
  if (teamMemberLoads.has(projectId)) return teamMemberLoads.get(projectId);

  const request = apiRequest(`/api/projects/${encodeURIComponent(projectId)}/members`)
    .then((result) => {
      const members = normalizeProjectMembers(result.data);
      const current = teamProject(projectId);
      if (current) {
        current.members = members;
        current.membersAuthoritative = true;
      }
      const boardProject = state.board?.projects.find((item) =>
        String(item.id) === String(projectId)
      );
      if (boardProject) {
        boardProject.members = members;
        boardProject.membersAuthoritative = true;
      }
      renderTeamFilterOptions();
      return assignableProjectMembers({ members });
    })
    .catch((error) => {
      if (!quiet && error.status !== 403) showError(error.message);
      return [];
    })
    .finally(() => {
      teamMemberLoads.delete(projectId);
    });
  teamMemberLoads.set(projectId, request);
  return request;
}

function setTeamFeedback(message) {
  setMessage(els.teamFeedback, message, false);
}

function syncTeamVisibility() {
  const crossProject = !state.teamMode || state.projectId === "all";
  document.body.classList.toggle("mode-team", state.teamMode);
  document.querySelectorAll("[data-single-project-only]").forEach((section) => {
    section.hidden = state.teamMode && crossProject;
  });
  els.teamQueryPanel.hidden = !state.teamMode;
  els.teamQueryList.hidden = state.teamMode && !crossProject;
  const pagination = els.teamQueryPanel.querySelector(".team-pagination");
  if (pagination) pagination.hidden = state.teamMode && !crossProject;
  document.querySelector('[data-view="team"]').hidden = state.teamMode;
  document.querySelector('[data-view="archive"]').hidden = state.teamMode;
}

function applyTeamIdentity() {
  const user = state.user || state.runtime?.user;
  els.teamSession.hidden = !state.teamMode;
  els.teamAccount.hidden = !state.teamMode;
  els.teamSessionName.textContent = user?.displayName || user?.username || "团队账号";
  els.teamSessionMode.textContent = state.teamMode ? "团队模式 · Cookie 会话" : "";
  els.teamAccountName.textContent = user?.displayName || user?.username || "团队账号";
  els.teamAccountRole.textContent = user?.systemAdmin ? "系统管理员" : "团队成员";
  els.teamAccountAvatar.textContent = initials(user?.displayName || user?.username);
  els.teamAdminLink.hidden = !state.teamMode || !(
    user?.systemAdmin || state.teamProjects.some(canManageProject)
  );
  els.manageProjectsButton.hidden = state.teamMode;
  els.refresh.hidden = state.teamMode;
  els.createButton.hidden = state.teamMode && !state.teamProjects.some(canWriteProject);
  els.search.placeholder = state.teamMode
    ? "搜索团队任务、负责人或项目"
    : "搜索任务、负责人或仓库";
  const branchLabel = document.querySelector("#create-branch")?.closest("label");
  if (branchLabel) branchLabel.hidden = state.teamMode;
  syncTeamVisibility();
}

function teamSyncLabel(status) {
  return TEAM_SYNC_LABELS[status] || TEAM_SYNC_LABELS.unknown;
}

function renderTeamStatusBanner() {
  if (!state.teamMode) {
    els.teamStatusBanner.hidden = true;
    return;
  }
  const status = state.teamStatus;
  if (!status) {
    els.teamStatusBanner.hidden = false;
    els.teamStatusBanner.innerHTML = "<strong>正在读取团队同步状态…</strong>";
    return;
  }
  const projects = status.projects.length ? status.projects : state.teamProjects;
  const stale = projects.filter((project) => ["stale", "pending_push", "needs_repair"].includes(project.syncStatus));
  const errors = projects.filter((project) => project.lastError);
  const parts = [];
  if (stale.length) {
    parts.push(`${stale.length} 个项目需要同步关注：${stale.map((project) =>
      `${project.name}（${teamSyncLabel(project.syncStatus)}）`
    ).join("、")}`);
  }
  if (status.pendingAssignments) parts.push(`${status.pendingAssignments} 个任务待你接受`);
  if (errors.length && !stale.length) parts.push(`${errors.length} 个项目存在同步错误`);
  if (!parts.length) parts.push("所有授权项目同步正常");
  const stamp = status.updatedAt
    ? ` · ${new Date(status.updatedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`
    : "";
  els.teamStatusBanner.hidden = false;
  els.teamStatusBanner.classList.toggle("has-warning", Boolean(stale.length || errors.length));
  els.teamStatusBanner.innerHTML = `
    <strong>团队状态</strong>
    <span>${escapeHtml(parts.join("；"))}${escapeHtml(stamp)}</span>`;
}

function renderTeamFilterOptions(tasks = state.teamPage?.tasks || []) {
  if (!els.teamFilterProject) return;
  const currentProject = state.projectId;
  els.teamFilterProject.innerHTML = [
    '<option value="all">全部授权项目</option>',
    ...state.teamProjects.map((project) =>
      `<option value="${escapeHtml(project.id)}">${escapeHtml(project.name)} · ${escapeHtml(teamSyncLabel(project.syncStatus))}</option>`
    )
  ].join("");
  els.teamFilterProject.value = state.teamProjects.some((project) => project.id === currentProject)
    ? currentProject
    : "all";

  const assignees = new Map();
  for (const project of state.teamProjects) {
    for (const member of assignableProjectMembers(project)) {
      const id = member.trellisDevId || member.username || member.displayName;
      if (id) assignees.set(id, member.displayName || member.username || id);
    }
  }
  for (const task of tasks) {
    if (task.assigneeDevId) assignees.set(task.assigneeDevId, task.assignee || task.assigneeDevId);
  }
  const selectedAssignee = els.teamFilterAssignee.value || state.teamFilters.assignee;
  els.teamFilterAssignee.innerHTML = [
    '<option value="">全部负责人</option>',
    ...[...assignees.entries()].sort((a, b) => a[1].localeCompare(b[1], "zh-CN")).map(([id, name]) =>
      `<option value="${escapeHtml(id)}">${escapeHtml(name)}</option>`
    )
  ].join("");
  els.teamFilterAssignee.value = assignees.has(selectedAssignee) ? selectedAssignee : "";

  const selectedStage = els.teamFilterStage.value || state.teamFilters.stages[0] || "";
  els.teamFilterStage.innerHTML = [
    '<option value="">全部阶段</option>',
    ...FILTER_STAGES.map((stage) =>
      `<option value="${escapeHtml(stage.id)}">${escapeHtml(stage.label)}</option>`
    )
  ].join("");
  els.teamFilterStage.value = selectedStage;

  els.teamFilterTags.value = state.teamFilters.tags.join(",");
  els.teamFilterDue.value = state.teamFilters.dueWithinDays || "";
  els.teamFilterStale.value = state.teamFilters.staleDays || "";
  els.teamFilterBlocked.value = state.teamFilters.blocked || "any";
  els.teamFilterArchived.checked = Boolean(state.teamFilters.archived);
}

function readTeamFilters() {
  state.projectId = els.teamFilterProject.value || "all";
  state.teamFilters = {
    projectIds: state.projectId === "all" ? [] : [state.projectId],
    priorities: els.teamFilterPriority.value
      ? els.teamFilterPriority.value.split(",").map((value) => value.trim()).filter(Boolean)
      : [],
    stages: els.teamFilterStage.value ? [els.teamFilterStage.value] : [],
    tags: els.teamFilterTags.value.split(",").map((value) => value.trim()).filter(Boolean),
    assignee: els.teamFilterAssignee.value.trim(),
    dueWithinDays: els.teamFilterDue.value,
    staleDays: els.teamFilterStale.value,
    blocked: els.teamFilterBlocked.value,
    archived: els.teamFilterArchived.checked
  };
}

function teamQueryTaskMarkup(task) {
  const reasons = Array.isArray(task.attentionReasons) ? task.attentionReasons : [];
  const reasonMarkup = reasons.slice(0, 4).map((reason) =>
    `<span class="team-query-reason">${escapeHtml(ATTENTION_REASON_LABELS[reason] || reason)}</span>`
  ).join("");
  const assignment = task.assignmentVersion == null
    ? ""
    : `<span class="team-query-badge is-assignment">待接受 · v${escapeHtml(task.assignmentVersion)}</span>`;
  return `<article class="team-query-card">
    <button class="team-query-card-button" data-team-query-task-index="${escapeHtml(task._index)}" type="button">
      <span class="team-query-project">
        ${escapeHtml(task.projectName || "未命名项目")}
        <small>${escapeHtml(teamSyncLabel(task.projectSyncStatus))}</small>
      </span>
      <strong>${escapeHtml(task.title || task.executionTaskKey || "未命名任务")}</strong>
      <span class="team-query-meta">
        <span class="team-query-priority">${escapeHtml(task.priority || "未设优先级")}</span>
        <span>${escapeHtml(task.assignee || "未派发")}</span>
        <span>${escapeHtml(task.derivedStage || "阶段未知")}</span>
        ${task.dueDate ? `<span>截止 ${escapeHtml(task.dueDate)}</span>` : ""}
        ${task.lastActivityAt ? `<span>最近活动 ${escapeHtml(formatEventTime(task.lastActivityAt) || "未知")}</span>` : ""}
      </span>
      <span class="team-query-badges">
        ${task.isBlocked ? '<span class="team-query-badge is-blocked">被阻断</span>' : ""}
        ${task.isUnblockedReady ? '<span class="team-query-badge is-ready">阻断已解除</span>' : ""}
        ${task.stale ? '<span class="team-query-badge is-stale">数据可能过期</span>' : ""}
        ${assignment}
        ${reasonMarkup}
      </span>
    </button>
  </article>`;
}

function renderTeamQueryPage(page) {
  if (!page.tasks.length) {
    els.teamQueryList.innerHTML = `<div class="team-empty">
      <strong>没有符合筛选条件的分页结果</strong>
      <span>调整负责人、阶段或项目后再试；服务端按完整结果集计算筛选与总数。</span>
    </div>`;
    return;
  }
  const indexed = page.tasks.map((task, index) => ({ ...task, _index: index }));
  els.teamQueryList.innerHTML = indexed.map(teamQueryTaskMarkup).join("");
  els.teamQueryList.querySelectorAll("[data-team-query-task-index]").forEach((button) => {
    button.addEventListener("click", () => {
      const task = page.tasks[Number(button.dataset.teamQueryTaskIndex)];
      if (task) openTask(task);
    });
  });
}

function updateTeamPagination() {
  const page = state.teamPage;
  els.teamPagePrev.disabled = state.teamPageIndex <= 0 || state.teamLoading;
  els.teamPageNext.disabled = !state.teamHasNext || state.teamLoading;
  els.teamPageLabel.textContent = `第 ${state.teamPageIndex + 1} 页${page ? ` · 共 ${page.total} 条` : ""}`;
  els.teamQueryTotal.textContent = page ? `${page.total} 条` : "—";
}

async function loadTeamPage({ quiet = false, retryForbidden = true } = {}) {
  if (state.teamLoading) return false;
  state.teamLoading = true;
  hideError();
  if (!quiet) els.teamQuerySummary.textContent = "正在按筛选条件读取团队任务索引…";
  updateTeamPagination();
  try {
    const cursor = state.teamCursors[state.teamPageIndex] || null;
    const query = buildTaskQuery(
      { ...state.teamFilters, q: state.search },
      { limit: TEAM_PAGE_SIZE, cursor }
    );
    const headers = state.teamEtag ? { "if-none-match": state.teamEtag } : {};
    const result = await apiRequest(`/api/tasks/query?${query}`, "GET", undefined, { headers });
    if (result.status === 304) return true;
    const page = normalizeTaskPage(result.data);
    state.teamPage = page;
    state.teamEtag = result.etag || null;
    state.teamHasNext = Boolean(page.nextCursor);
    if (page.nextCursor) state.teamCursors[state.teamPageIndex + 1] = page.nextCursor;
    if (state.teamStatus) {
      state.teamStatus.queryRevision = page.queryRevision ?? state.teamStatus.queryRevision;
      state.teamStatus.queryDay = page.queryDay ?? state.teamStatus.queryDay;
    }
    renderTeamFilterOptions(page.tasks);
    renderTeamQueryPage(page);
    state.teamPageIndex = Math.max(0, state.teamPageIndex);
    updateTeamPagination();
    els.teamQuerySummary.textContent = page.total
      ? `跨项目混合排序 · 当前页 ${page.tasks.length} 条 · 服务端筛选后共 ${page.total} 条`
      : "当前筛选没有匹配任务";
    els.teamQueryTotal.textContent = `${page.total} 条`;
    els.teamQueryPanel.classList.remove("is-project-mode");
    state.projectId = "all";
    renderProjects();
    syncTeamVisibility();
    if (!quiet) setTeamFeedback(`已加载第 ${state.teamPageIndex + 1} 页团队任务`);
    return true;
  } catch (error) {
    if (error.status === 409 && error.code === "CURSOR_INVALID" && state.teamPageIndex > 0) {
      state.teamPageIndex = 0;
      state.teamCursors = [null];
      state.teamEtag = null;
      state.teamLoading = false;
      return loadTeamPage({ quiet });
    }
    if (error.status === 403 && retryForbidden && state.teamFilters.projectIds.length) {
      state.projectId = "all";
      state.teamFilters.projectIds = [];
      state.teamPageIndex = 0;
      state.teamCursors = [null];
      state.teamEtag = null;
      renderTeamFilterOptions();
      state.teamLoading = false;
      return loadTeamPage({ quiet, retryForbidden: false });
    }
    showError(error.message);
    els.teamQuerySummary.textContent = "团队任务读取失败";
    return false;
  } finally {
    state.teamLoading = false;
    updateTeamPagination();
  }
}

async function loadTeamProject(projectId = state.projectId) {
  if (!projectId || projectId === "all") return loadTeamPage();
  const selected = teamProject(projectId);
  if (!selected || state.teamLoading) return false;
  state.teamLoading = true;
  hideError();
  els.teamQuerySummary.textContent = `正在读取 ${selected.name} 的项目看板…`;
  try {
    let cursor = null;
    const seenCursors = new Set();
    let firstPage = null;
    let tasks = [];
    do {
      const query = new URLSearchParams({ projectId, limit: "200" });
      if (cursor) query.set("cursor", cursor);
      const result = await apiRequest(`/api/board?${query}`);
      const pageChunk = normalizeBoardPage(result.data);
      firstPage ||= pageChunk;
      tasks.push(...pageChunk.tasks);
      cursor = pageChunk.nextCursor;
      if (cursor) {
        if (seenCursors.has(cursor)) throw new Error("项目看板分页游标重复，已停止继续加载");
        seenCursors.add(cursor);
      }
    } while (cursor);
    const page = {
      ...firstPage,
      tasks: [...new Map(tasks.map((task) => [task.taskKey, task])).values()],
      nextCursor: null
    };
    const projectRows = (page.projects.length ? page.projects : [selected]).map((project) => {
      const merged = normalizeTeamProject({
        ...selected,
        ...project,
        members: project.members?.length ? project.members : selected.members
      });
      return {
        ...teamProjectForBoard(merged),
        ...project,
        members: project.members?.length
          ? project.members
          : teamProjectForBoard(merged).members
      };
    });
    if (!projectRows.some((project) => String(project.id) === String(projectId))) {
      projectRows.push(teamProjectForBoard(selected));
    }
    state.projectId = String(projectId);
    state.scope = "all";
    state.executionView = "all";
    state.board = {
      ...page,
      tasks: page.tasks,
      projects: projectRows,
      savedViews: page.savedViews || [],
      generatedAt: page.generatedAt || page.scannedAt || new Date().toISOString(),
      source: "team"
    };
    renderTeamFilterOptions(page.tasks);
    renderAll();
    els.teamQueryPanel.classList.add("is-project-mode");
    els.teamQuerySummary.textContent = `${selected.name} · 按任务组和流程阶段显示 · 当前 ${page.tasks.length} 条`;
    els.teamQueryTotal.textContent = `${page.tasks.length} 条`;
    syncTeamVisibility();
    setTeamFeedback(`已打开 ${selected.name}`);
    return true;
  } catch (error) {
    showError(error.message);
    els.teamQuerySummary.textContent = `${selected.name} 读取失败`;
    if (error.status === 403) {
      state.projectId = "all";
      state.teamFilters.projectIds = [];
      renderProjects();
      syncTeamVisibility();
    }
    return false;
  } finally {
    state.teamLoading = false;
  }
}

async function selectTeamProject(projectId) {
  state.projectId = String(projectId || "all");
  state.teamFilters.projectIds = state.projectId === "all" ? [] : [state.projectId];
  state.teamPageIndex = 0;
  state.teamCursors = [null];
  state.teamEtag = null;
  if (state.projectId === "all") {
    renderTeamFilterOptions();
    renderProjects();
    syncTeamVisibility();
    await loadTeamPage();
  } else {
    renderTeamFilterOptions();
    renderProjects();
    syncTeamVisibility();
    await loadTeamProject(state.projectId);
  }
}

async function refreshTeamData({ quiet = false } = {}) {
  if (state.projectId === "all") return loadTeamPage({ quiet });
  return loadTeamProject(state.projectId);
}

function updateAssignmentNav() {
  const count = state.teamAssignments.length || Number(state.teamStatus?.pendingAssignments || 0);
  els.assignmentNav.hidden = !state.teamMode;
  els.assignmentCount.textContent = String(count);
  els.assignmentNav.setAttribute("aria-label", `待我接受，${count} 个任务`);
}

async function loadTeamStatus() {
  if (!state.teamMode || state.teamStatusLoading) return false;
  state.teamStatusLoading = true;
  try {
    const headers = state.teamStatusEtag
      ? { "if-none-match": state.teamStatusEtag }
      : undefined;
    const result = await apiRequest("/api/team/status", "GET", undefined, { headers });
    if (result.status === 304) return true;
    state.teamStatusEtag = result.etag || null;
    const previous = state.teamStatus;
    const next = normalizeTeamStatus(result.data);
    state.teamStatus = next;
    if (next.projects.length) {
      state.teamProjects = next.projects.map((project) => {
        const current = teamProject(project.id);
        return current
          ? { ...current, ...project, members: project.members.length ? project.members : current.members }
          : project;
      });
      renderProjects();
      applyTeamIdentity();
    }
    renderTeamStatusBanner();
    updateAssignmentNav();
    if (previous && shouldReloadTasks(previous, next, state.projectId) && !state.teamLoading) {
      await refreshTeamData({ quiet: true });
    }
    if (previous && previous.pendingAssignments !== next.pendingAssignments) {
      await loadTeamAssignments({ quiet: true });
    }
    return true;
  } catch (error) {
    renderTeamStatusBanner();
    setTeamFeedback(`团队状态刷新失败：${error.message}`);
    return false;
  } finally {
    state.teamStatusLoading = false;
  }
}

function scheduleTeamStatusPoll(delay = TEAM_POLL_MS) {
  if (!state.teamMode) return;
  if (state.teamPollTimer) clearTimeout(state.teamPollTimer);
  state.teamPollTimer = setTimeout(async () => {
    if (document.visibilityState === "visible") await loadTeamStatus();
    scheduleTeamStatusPoll();
  }, delay);
}

function assignmentTask(row) {
  return normalizeTeamTaskRow(row?.task || row || {});
}

function renderTeamAssignments() {
  if (!state.teamAssignments.length) {
    els.assignmentsList.innerHTML = `<div class="assignments-empty">
      <strong>没有待接受任务</strong>
      <span>新委派到达后，这里会显示任务版本和接受条件。</span>
    </div>`;
    return;
  }
  els.assignmentsList.innerHTML = state.teamAssignments.map((row, index) => {
    const task = assignmentTask(row);
    return `<article class="assignment-row">
      <div>
        <span class="assignment-project">${escapeHtml(task.projectName || "未命名项目")}</span>
        <strong>${escapeHtml(task.title || task.executionTaskKey || "未命名任务")}</strong>
        <small>${escapeHtml(task.priority || "未设优先级")} · ${escapeHtml(task.derivedStage || "阶段未知")} · assignment v${escapeHtml(row.assignmentVersion ?? "未知")}</small>
      </div>
      <button class="primary-button small-button" data-accept-assignment-index="${index}" type="button" ${row.assignmentVersion == null ? "disabled" : ""}>
        接受任务
      </button>
    </article>`;
  }).join("");
  els.assignmentsList.querySelectorAll("[data-accept-assignment-index]").forEach((button) => {
    button.addEventListener("click", () => {
      const row = state.teamAssignments[Number(button.dataset.acceptAssignmentIndex)];
      if (row) void acceptTeamAssignment(row, button);
    });
  });
}

async function loadTeamAssignments({ quiet = false } = {}) {
  if (!state.teamMode) return false;
  try {
    const result = await apiRequest("/api/assignments?state=pending");
    state.teamAssignments = normalizeAssignments(result.data);
    renderTeamAssignments();
    updateAssignmentNav();
    if (!quiet) setMessage(els.assignmentsMessage, "");
    return true;
  } catch (error) {
    if (!quiet) setMessage(els.assignmentsMessage, error.message, true);
    return false;
  }
}

async function acceptTeamAssignment(row, button) {
  const version = row.assignmentVersion;
  if (version == null) {
    setMessage(els.assignmentsMessage, "服务端未返回 assignment 版本，请刷新后重试", true);
    return;
  }
  button.disabled = true;
  button.textContent = "正在接受…";
  setMessage(els.assignmentsMessage, "正在校验任务版本…");
  try {
    const result = await apiRequest("/api/tasks/accept", "POST", {
      executionTaskKey: row.executionTaskKey,
      assignmentVersion: version
    });
    const queued = result.data?.queuedBindings;
    const queuedCount = Array.isArray(queued) ? queued.length : Number(queued || 0);
    setMessage(
      els.assignmentsMessage,
      queuedCount
        ? `任务已接受，已为 ${queuedCount} 个 Agent 排队同步共享分支`
        : "任务已接受"
    );
    setTeamFeedback("任务已接受");
    await Promise.all([
      loadTeamAssignments({ quiet: true }),
      loadTeamStatus(),
      refreshTeamData({ quiet: true })
    ]);
  } catch (error) {
    setMessage(els.assignmentsMessage, error.message, true);
    if (button.isConnected) {
      button.disabled = false;
      button.textContent = "接受任务";
    }
  }
}

function assignmentForTask(task) {
  if (!task) return null;
  const assigned = state.teamAssignments.find((row) =>
    row.executionTaskKey === task.executionTaskKey ||
    row.executionTaskKey === task.taskKey
  );
  if (assigned) return assigned;
  const version = assignmentVersion(task);
  return version == null ? null : {
    executionTaskKey: task.executionTaskKey || task.taskKey,
    assignmentVersion: version,
    assignmentState: task.assignmentState || task.assignment?.state || "pending"
  };
}

function renderSelectedTeamTaskActions(task) {
  if (!state.teamMode || !task) {
    els.teamTaskActions.hidden = true;
    return;
  }
  const assignment = assignmentForTask(task);
  const version = taskVersion(task);
  els.teamTaskActions.hidden = !assignment && version == null;
  els.teamTaskVersion.textContent = [
    version == null ? "" : `任务 v${version}`,
    assignment?.assignmentVersion == null ? "" : `assignment v${assignment.assignmentVersion}`
  ].filter(Boolean).join(" · ");
  const pending = assignment && !["accepted", "completed"].includes(assignment.assignmentState);
  els.teamTaskAccept.hidden = !pending;
  els.teamTaskAccept.disabled = false;
  els.teamTaskAccept.textContent = "接受任务";
}

async function acceptSelectedAssignment() {
  const task = state.selectedTask;
  const assignment = assignmentForTask(task);
  if (!task || !assignment || assignment.assignmentVersion == null) {
    showError("当前任务没有可接受的 assignment 版本");
    return;
  }
  els.teamTaskAccept.disabled = true;
  els.teamTaskAccept.textContent = "正在接受…";
  try {
    const result = await apiRequest("/api/tasks/accept", "POST", {
      executionTaskKey: assignment.executionTaskKey,
      assignmentVersion: assignment.assignmentVersion
    });
    const queued = result.data?.queuedBindings;
    const queuedCount = Array.isArray(queued) ? queued.length : Number(queued || 0);
    setTeamFeedback(queuedCount ? `任务已接受，已排队 ${queuedCount} 个 Agent 同步` : "任务已接受");
    await Promise.all([
      loadTeamAssignments({ quiet: true }),
      loadTeamStatus(),
      refreshTeamData({ quiet: true })
    ]);
  } catch (error) {
    showError(error.message);
    renderSelectedTeamTaskActions(task);
  }
}

function operationStatusMarkup(operation) {
  const status = operation.status || "unknown";
  const label = TEAM_OPERATION_LABELS[status] || status;
  const result = operation.result || {};
  const taskLabel = result.taskKey || operation.taskKey || "当前任务";
  const explanations = {
    prepared: "服务端已准备写入，正在等待本地提交。",
    committed: "本地 Git 提交已完成，等待推送到共享分支。",
    pending_push: "本地提交已完成，但尚未发布到远端共享分支；此时不能视为成功。",
    pushed: "远端已接收提交，正在等待任务索引刷新。",
    applied: "任务写入已应用，项目看板可以刷新。",
    failed: "操作失败，服务端返回了可读错误。"
  };
  return `
    <div class="operation-summary is-${escapeHtml(status)}">
      <span class="operation-state">${escapeHtml(label)}</span>
      <strong>${escapeHtml(taskLabel)}</strong>
      <p>${escapeHtml(explanations[status] || "正在读取操作状态。")}</p>
    </div>
    <dl class="operation-details">
      <div><dt>操作</dt><dd>${escapeHtml(operation.operationType || "任务写入")}</dd></div>
      <div><dt>本地提交</dt><dd>${escapeHtml(operation.localSha || "尚未生成")}</dd></div>
      <div><dt>远端提交</dt><dd>${escapeHtml(operation.remoteSha || "尚未推送")}</dd></div>
      <div><dt>操作 ID</dt><dd>${escapeHtml(operation.id || "未知")}</dd></div>
    </dl>
    ${operation.error ? `<p class="operation-error" role="alert">${escapeHtml(operation.error)}</p>` : ""}`;
}

function renderTeamOperation() {
  const operation = state.teamOperation;
  if (!operation) return;
  els.teamOperationTitle.textContent = operation.operationType === "retry" ? "重试发布状态" : "发布状态";
  els.teamOperationStatus.innerHTML = operationStatusMarkup(operation);
  els.teamOperationId.textContent = operation.id ? `操作 ${operation.id}` : "操作状态待服务端返回";
  els.teamOperationRetry.hidden = !isRetryableOperation(operation);
  els.teamOperationRetry.disabled = false;
  els.teamOperationRetry.textContent = "重试发布";
}

async function pollTeamOperation() {
  if (!state.teamOperation?.id || !isRetryableOperation(state.teamOperation)) return;
  const operationId = state.teamOperation.id;
  const attempt = state.teamOperationAttempt;
  state.teamOperationAttempt += 1;
  state.teamOperationTimer = setTimeout(async () => {
    try {
      const result = await apiRequest(`/api/git-operations/${encodeURIComponent(operationId)}`);
      state.teamOperation = normalizeOperation(result.data);
      renderTeamOperation();
      if (isCompleteOperation(state.teamOperation)) {
        setTeamFeedback("发布已完成，任务索引正在刷新");
        await refreshTeamData({ quiet: true });
        await loadTeamStatus();
        return;
      }
      if (isRetryableOperation(state.teamOperation)) {
        pollTeamOperation();
      }
    } catch (error) {
      els.teamOperationStatus.insertAdjacentHTML(
        "beforeend",
        `<p class="operation-error" role="alert">${escapeHtml(error.message)}</p>`
      );
      state.teamOperationTimer = setTimeout(pollTeamOperation, operationPollDelay(attempt + 1, state.teamOperation?.status));
    }
  }, operationPollDelay(attempt, state.teamOperation.status));
}

function showTeamOperation(payload) {
  const operation = normalizeOperation(payload);
  if (!operation.id && !operation.status) return false;
  if (state.teamOperationTimer) clearTimeout(state.teamOperationTimer);
  state.teamOperation = operation;
  state.teamOperationAttempt = 0;
  renderTeamOperation();
  if (!els.teamOperationDialog.open) els.teamOperationDialog.showModal();
  pollTeamOperation();
  return true;
}

async function showOperationFromError(error) {
  const operationId = error?.details?.operationId;
  if (!operationId) return false;
  try {
    const result = await apiRequest(`/api/git-operations/${encodeURIComponent(operationId)}`);
    return showTeamOperation(result.data);
  } catch {
    return false;
  }
}

async function retryTeamOperation() {
  if (!state.teamOperation?.id) return;
  els.teamOperationRetry.disabled = true;
  els.teamOperationRetry.textContent = "正在重试…";
  try {
    const result = await apiRequest(
      `/api/git-operations/${encodeURIComponent(state.teamOperation.id)}/retry`,
      "POST",
      {}
    );
    state.teamOperation = normalizeOperation(result.data);
    state.teamOperationAttempt = 0;
    renderTeamOperation();
    pollTeamOperation();
  } catch (error) {
    els.teamOperationStatus.insertAdjacentHTML(
      "beforeend",
      `<p class="operation-error" role="alert">${escapeHtml(error.message)}</p>`
    );
    els.teamOperationRetry.disabled = false;
    els.teamOperationRetry.textContent = "重试发布";
  }
}

function openPasswordDialog(force = false) {
  els.passwordDialog.dataset.force = force ? "true" : "false";
  els.passwordForm.reset();
  setMessage(els.passwordMessage, "");
  document.querySelectorAll("[data-close-password]").forEach((button) => {
    button.hidden = force;
  });
  els.passwordDialog.showModal();
  document.querySelector("#password-current").focus();
}

async function submitPasswordChange(event) {
  event.preventDefault();
  const currentPassword = document.querySelector("#password-current").value;
  const newPassword = document.querySelector("#password-new").value;
  const confirmation = document.querySelector("#password-confirm").value;
  if (Array.from(newPassword).length < 12) {
    setMessage(els.passwordMessage, "新密码至少需要 12 个字符", true);
    document.querySelector("#password-new").focus();
    return;
  }
  if (newPassword !== confirmation) {
    setMessage(els.passwordMessage, "两次输入的新密码不一致", true);
    document.querySelector("#password-confirm").focus();
    return;
  }
  els.passwordSubmit.disabled = true;
  els.passwordSubmit.textContent = "正在修改…";
  setMessage(els.passwordMessage, "正在更新密码并撤销其他设备会话…");
  try {
    await apiRequest("/api/auth/password", "POST", { currentPassword, newPassword });
    const me = await apiRequest("/api/auth/me");
    state.user = normalizeUser(me.data);
    state.runtime.user = state.user;
    els.passwordForm.reset();
    els.passwordDialog.close();
    applyTeamIdentity();
    setTeamFeedback("密码已修改，当前会话保持登录");
    if (!state.teamInitialized) await initializeTeam(state.runtime);
  } catch (error) {
    setMessage(els.passwordMessage, error.message, true);
  } finally {
    els.passwordSubmit.disabled = false;
    els.passwordSubmit.textContent = "保存新密码";
  }
}

async function logoutTeam() {
  els.teamLogout.disabled = true;
  try {
    await apiRequest("/api/auth/logout", "POST", {});
  } catch {
    // 会话已失效时同样回登录页，避免把用户困在过期页面。
  } finally {
    window.location.assign("/login.html");
  }
}

async function initializeTeam(runtime) {
  state.teamMode = true;
  state.runtime = runtime;
  state.user = runtime.user || normalizeUser(runtime.raw?.user);
  state.projectId = "all";
  state.executionView = "all";
  state.teamProjects = runtime.projects;
  state.board = {
    tasks: [],
    projects: state.teamProjects.map(teamProjectForBoard),
    savedViews: [],
    generatedAt: new Date().toISOString(),
    source: "team"
  };
  applyTeamIdentity();
  renderProjects();
  renderTeamFilterOptions();
  renderTeamStatusBanner();
  updateAssignmentNav();
  if (state.user?.mustChangePassword) {
    openPasswordDialog(true);
    return;
  }
  try {
    const result = await apiRequest("/api/team/projects");
    state.teamProjects = normalizeTeamProjects(result.data);
  } catch (error) {
    if (!runtime.projects.length) {
      showError(error.message);
      state.teamProjects = [];
    } else {
      state.teamProjects = runtime.projects;
    }
  }
  state.board.projects = state.teamProjects.map(teamProjectForBoard);
  state.teamInitialized = true;
  applyTeamIdentity();
  renderProjects();
  renderTeamFilterOptions();
  renderTeamStatusBanner();
  updateAssignmentNav();
  await loadTeamStatus();
  await loadTeamAssignments();
  await loadTeamPage();
  updateSyncLabel();
  scheduleTeamStatusPoll();
  if (state.user?.mustChangePassword) openPasswordDialog(true);
}

function renderView() {
  document.querySelectorAll(".nav-item").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.view === state.view);
  });
  document.querySelectorAll(".content-view").forEach((view) => {
    view.classList.toggle("is-visible", view.id === `${state.view}-view`);
  });
  const copy = {
    pipeline: ["PERSONAL / CURRENT WORK", "把每个任务放回流程里"],
    team: ["TEAM / CAPACITY", "每个人都在推进什么"],
    archive: ["ARCHIVE / HISTORY", "归档后才离开当前队列"]
  };
  els.viewEyebrow.textContent = copy[state.view][0];
  els.viewTitle.textContent = copy[state.view][1];
}

function renderAll() {
  if (!state.board) return;
  renderProjects();
  renderMetrics();
  renderExecutionViews();
  renderFlowSignals();
  renderFocus();
  renderAttentionQueue();
  renderPipeline();
  renderTeam();
  renderArchiveOptions();
  renderArchive();
  renderView();
  syncTeamVisibility();
}

async function openCreateDialog() {
  const select = document.querySelector("#create-project");
  const projects = state.teamMode
    ? state.teamProjects.filter(canWriteProject)
    : state.board?.projects || [];
  if (!projects.length) {
    showError(state.teamMode
      ? "当前账号没有可创建任务的项目角色，或项目当前不可写"
      : "当前没有可用仓库");
    return;
  }
  select.innerHTML = projects.map((project) => `
    <option value="${safe(project.id)}">${safe(project.name)} · ${state.teamMode ? safe(teamSyncLabel(project.syncStatus)) : `${escapeHtml(project.activeCount)} 进行中`}</option>`).join("");
  if (state.projectId !== "all" && projects.some((project) => project.id === state.projectId)) {
    select.value = state.projectId;
  }
  document.querySelector("#create-assignee").value = "";
  const title = document.querySelector("#create-title").value.trim();
  const slug = normalizeTaskSlug(document.querySelector("#create-slug").value);
  state.createSlugManuallyEdited = Boolean(slug && slug !== slugifyTaskTitle(title));
  document.querySelector("#create-message").hidden = true;
  state.createSignature = null;
  state.createIdempotencyKey = null;
  els.createDialog.showModal();
  await updateCreateOptions();
}

async function updateCreateOptions() {
  const projectId = document.querySelector("#create-project").value;
  const project = state.teamMode
    ? teamProject(projectId)
    : state.board?.projects.find((item) => item.id === projectId);
  const assigneeSelect = document.querySelector("#create-assignee");
  const submit = document.querySelector("#create-submit");
  assigneeSelect.innerHTML = '<option value="">正在读取项目成员…</option>';
  assigneeSelect.disabled = true;
  submit.disabled = true;
  if (state.teamMode && project) await loadTeamProjectMembers(projectId);
  if (document.querySelector("#create-project").value !== projectId) return;
  const members = state.teamMode
    ? assignableProjectMembers(project || {})
    : (project?.members || []).map((member) => ({ displayName: member, trellisDevId: member }));
  assigneeSelect.innerHTML = [
    '<option value="">请选择负责人</option>',
    ...members.map((member) => {
      const value = member.trellisDevId || member.username || member.displayName;
      return `<option value="${safe(value)}">${safe(member.displayName || member.username || value)}</option>`;
    })
  ].join("");
  assigneeSelect.disabled = members.length === 0;
  submit.disabled = members.length === 0;
  if (state.teamMode && members.length === 0) {
    setCreateMessage(
      canManageProject(project)
        ? "当前项目没有可指派的 active 负责人；请先在管理页为 lead/member 配置 Trellis developer ID。"
        : "当前项目接口未返回可指派成员清单。需由服务端提供 active lead/member，前端不会猜测只读成员。",
      true
    );
  } else {
    document.querySelector("#create-message").hidden = true;
  }
  const branchSelect = document.querySelector("#create-branch");
  const branches = state.teamMode ? [] : project?.branches || [];
  branchSelect.innerHTML = [
    '<option value="">使用 Trellis 默认分支</option>',
    ...branches.map((branch) => `<option value="${safe(branch)}">${safe(branch)}</option>`)
  ].join("");
  branchSelect.value = project?.branch && branches.includes(project.branch) ? project.branch : "";
}

function setCreateMessage(text, isError = false) {
  const message = document.querySelector("#create-message");
  message.hidden = false;
  message.classList.toggle("is-error", isError);
  message.textContent = text;
}

function syncCreateSlugFromTitle() {
  if (state.createSlugManuallyEdited) return;
  const title = document.querySelector("#create-title").value;
  document.querySelector("#create-slug").value = slugifyTaskTitle(title);
}

async function submitCreate(event) {
  event.preventDefault();
  const message = document.querySelector("#create-message");
  message.hidden = true;
  const projectId = document.querySelector("#create-project").value;
  const project = state.teamMode
    ? teamProject(projectId)
    : state.board.projects.find((item) => item.id === projectId);
  if (!project) {
    setCreateMessage("请选择当前账号可写的项目", true);
    return;
  }
  if (state.teamMode && !canWriteProject(project)) {
    setCreateMessage("当前项目角色或同步状态不允许创建任务", true);
    return;
  }
  const title = document.querySelector("#create-title").value.trim();
  const slugInput = document.querySelector("#create-slug");
  const manualSlug = normalizeTaskSlug(slugInput.value);
  const slug = manualSlug || slugifyTaskTitle(title);
  if (!slug) {
    setCreateMessage("当前标题没有可用的英文标识。请填写任务标识，例如 board-task-export。", true);
    slugInput.focus();
    return;
  }
  if (!TASK_SLUG_PATTERN.test(slug)) {
    setCreateMessage("任务标识只能包含小写英文字母、数字和单个中划线，例如 board-task-export。", true);
    slugInput.focus();
    return;
  }
  slugInput.value = slug;
  const payload = {
    repositoryId: projectId,
    title,
    description: document.querySelector("#create-description").value,
    assignee: document.querySelector("#create-assignee").value,
    priority: document.querySelector("#create-priority").value,
    slug
  };
  if (!payload.assignee) {
    setCreateMessage("请选择项目成员作为负责人", true);
    return;
  }
  if (state.teamMode) {
    const signature = JSON.stringify(payload);
    if (state.createSignature !== signature || !state.createIdempotencyKey) {
      state.createSignature = signature;
      state.createIdempotencyKey = crypto.randomUUID();
    }
    payload.idempotencyKey = state.createIdempotencyKey;
  } else {
    payload.baseBranch = document.querySelector("#create-branch").value || undefined;
  }
  try {
    const result = await api("/api/tasks", "POST", payload);
    if (state.teamMode) {
      const operation = normalizeOperation(result?.operation || result);
      if (showTeamOperation(operation)) {
        els.createDialog.close();
        setTeamFeedback("任务写入已提交，正在跟踪 Git 发布状态");
      } else {
        setCreateMessage("任务已创建，状态保持 planning；请继续补齐 PRD 并完成规划评审。");
      }
    } else {
      setCreateMessage("任务已创建，状态保持 planning；请继续补齐 PRD 并完成规划评审。");
    }
    document.querySelector("#create-title").value = "";
    document.querySelector("#create-description").value = "";
    slugInput.value = "";
    state.createSlugManuallyEdited = false;
    state.createSignature = null;
    state.createIdempotencyKey = null;
    if (state.teamMode) {
      await refreshTeamData({ quiet: true });
    } else {
      await loadBoard();
    }
  } catch (error) {
    if (state.teamMode && await showOperationFromError(error)) {
      els.createDialog.close();
      setTeamFeedback("任务写入尚未发布；请查看操作状态或重试推送");
      return;
    }
    setCreateMessage(error.message, true);
  }
}

async function assignSelected() {
  if (!state.selectedTask) return;
  const assignee = document.querySelector("#assignee-input").value.trim();
  if (!assignee) {
    showError("请选择当前项目的成员");
    return;
  }
  const project = state.board?.projects.find((item) => item.id === state.selectedTask.projectId);
  const members = state.teamMode
    ? assignableProjectMembers(teamProject(state.selectedTask.projectId) || project || {})
    : (state.selectedTask.projectMembers || project?.members || []).map((member) => ({
      trellisDevId: member,
      displayName: member
    }));
  if (!members.some((member) =>
    (member.trellisDevId || member.username || member.displayName) === assignee
  )) {
    showError("负责人必须是当前项目的成员");
    return;
  }
  try {
    if (state.teamMode) {
      const expectedTaskVersion = taskVersion(state.selectedTask);
      if (expectedTaskVersion == null) {
        showError("服务端未返回 taskVersion，请刷新项目后重试");
        return;
      }
      const signature = `${state.selectedTask.executionTaskKey}:${assignee}:${expectedTaskVersion}`;
      if (state.assignIdempotencyKey?.signature !== signature) {
        state.assignIdempotencyKey = { signature, key: crypto.randomUUID() };
      }
      const result = await api("/api/tasks/assign", "POST", {
        executionTaskKey: state.selectedTask.executionTaskKey,
        assignee,
        expectedTaskVersion,
        idempotencyKey: state.assignIdempotencyKey.key
      });
      state.assignIdempotencyKey = null;
      if (showTeamOperation(result?.operation || result)) {
        els.taskDialog.close();
      } else {
        setTeamFeedback("负责人已更新");
        await refreshTeamData({ quiet: true });
        els.taskDialog.close();
      }
    } else {
      await api("/api/tasks/assign", "POST", {
        repositoryId: state.selectedTask.projectId,
        taskDir: state.selectedTask.relativeDir,
        assignee
      });
      els.taskDialog.close();
      await loadBoard();
    }
  } catch (error) {
    if (state.teamMode && await showOperationFromError(error)) {
      els.taskDialog.close();
      setTeamFeedback("委派尚未发布；请查看操作状态或重试推送");
      return;
    }
    showError(error.message);
  }
}

async function initializeApp() {
  renderViewStageOptions();
  try {
    const result = await requestJson("/api/runtime");
    const runtime = normalizeRuntime(result.data);
    state.runtime = runtime;
    if (runtime.team) {
      if (!runtime.authenticated || !runtime.user) {
        redirectToLogin();
        return;
      }
      await initializeTeam(runtime);
      return;
    }
  } catch (error) {
    if (error.status === 401) {
      redirectToLogin();
      return;
    }
    if (error.status !== 404) {
      showError(error.message);
      return;
    }
  }
  state.teamMode = false;
  applyTeamIdentity();
  await loadBoard();
}

document.querySelectorAll(".nav-item").forEach((button) => {
  button.addEventListener("click", () => {
    if (button.dataset.teamView === "assignments") {
      renderTeamAssignments();
      if (!els.assignmentsDialog.open) els.assignmentsDialog.showModal();
      return;
    }
    if (state.teamMode && button.dataset.view !== "pipeline") return;
    state.view = button.dataset.view;
    renderView();
  });
});

document.querySelectorAll(".segment").forEach((button) => {
  button.addEventListener("click", () => {
    state.scope = button.dataset.scope;
    document.querySelectorAll(".segment").forEach((segment) => {
      segment.classList.toggle("is-active", segment === button);
    });
    renderMetrics();
    renderPipeline();
    renderExecutionViews();
    renderFlowSignals();
    renderFocus();
    renderAttentionQueue();
  });
});

els.search.addEventListener("input", () => {
  state.search = els.search.value.trim();
  if (state.teamMode) {
    if (state.teamFilterTimer) clearTimeout(state.teamFilterTimer);
    state.teamFilterTimer = setTimeout(() => {
      if (state.projectId === "all") {
        state.teamPageIndex = 0;
        state.teamCursors = [null];
        state.teamEtag = null;
        void loadTeamPage();
      } else {
        renderAll();
      }
    }, 250);
    return;
  }
  renderMetrics();
  renderExecutionViews();
  renderFlowSignals();
  renderFocus();
  renderAttentionQueue();
  renderPipeline();
  renderTeam();
});

els.archiveSearch.addEventListener("input", () => {
  state.archiveSearch = els.archiveSearch.value.trim();
  renderArchive();
});

els.archiveProject.addEventListener("change", () => {
  state.archiveProject = els.archiveProject.value;
  renderArchive();
});

els.refresh.addEventListener("click", () => loadBoard(true));
els.createButton.addEventListener("click", () => void openCreateDialog());
els.manageProjectsButton.addEventListener("click", openProjectDialog);
els.projectForm.addEventListener("submit", submitProject);
els.flowWipForm.addEventListener("submit", submitFlowWip);
els.pickFoldersButton.addEventListener("click", pickProjectFolders);
document.querySelectorAll("[data-flow-view]").forEach((button) => {
  button.addEventListener("click", () => {
    state.executionView = button.dataset.flowView;
    renderAll();
    document.querySelector(`[data-execution-view="${CSS.escape(state.executionView)}"]`)?.focus();
  });
});
document.querySelectorAll("[data-close-dialog]").forEach((button) => {
  button.addEventListener("click", () => els.taskDialog.close());
});
document.querySelectorAll("[data-close-artifact]").forEach((button) => {
  button.addEventListener("click", () => els.artifactDialog.close());
});
document.querySelectorAll("[data-close-create]").forEach((button) => {
  button.addEventListener("click", () => els.createDialog.close());
});
document.querySelectorAll("[data-close-projects]").forEach((button) => {
  button.addEventListener("click", () => els.projectDialog.close());
});
document.querySelectorAll("[data-close-execution]").forEach((button) => {
  button.addEventListener("click", () => els.executionDialog.close());
});
document.querySelectorAll("[data-close-view]").forEach((button) => {
  button.addEventListener("click", () => els.viewDialog.close());
});
document.querySelector("#assign-button").addEventListener("click", assignSelected);
document.querySelector("#detail-edit-execution").addEventListener("click", () => {
  if (state.selectedTask) openExecutionDialog(state.selectedTask);
});
els.dialogCopyTask.addEventListener("click", () => {
  if (state.selectedTask) void copyTaskDirName(state.selectedTask, els.dialogCopyTask);
});
document.querySelector("#assignee-input").addEventListener("change", updateAssignButtonState);
document.querySelector("#create-form").addEventListener("submit", submitCreate);
els.executionForm.addEventListener("submit", submitExecution);
els.viewForm.addEventListener("submit", submitView);
document.querySelector("#create-project").addEventListener("change", () => void updateCreateOptions());
document.querySelector("#create-title").addEventListener("input", syncCreateSlugFromTitle);
document.querySelector("#create-slug").addEventListener("input", (event) => {
  state.createSlugManuallyEdited = Boolean(event.target.value.trim());
});
els.teamLogout.addEventListener("click", logoutTeam);
els.teamPassword.addEventListener("click", () => openPasswordDialog(false));
els.teamFilterForm.addEventListener("submit", (event) => {
  event.preventDefault();
  readTeamFilters();
  state.teamPageIndex = 0;
  state.teamCursors = [null];
  state.teamEtag = null;
  if (state.projectId === "all") {
    void loadTeamPage();
  } else {
    void loadTeamProject(state.projectId);
  }
});
els.teamFilterProject.addEventListener("change", () => {
  void selectTeamProject(els.teamFilterProject.value);
});
els.teamPagePrev.addEventListener("click", () => {
  if (state.teamPageIndex <= 0) return;
  state.teamPageIndex -= 1;
  state.teamEtag = null;
  void loadTeamPage();
});
els.teamPageNext.addEventListener("click", () => {
  if (!state.teamHasNext) return;
  state.teamPageIndex += 1;
  state.teamEtag = null;
  void loadTeamPage();
});
els.teamTaskAccept.addEventListener("click", acceptSelectedAssignment);
els.teamOperationRetry.addEventListener("click", retryTeamOperation);
els.passwordForm.addEventListener("submit", submitPasswordChange);
document.querySelectorAll("[data-close-assignments]").forEach((button) => {
  button.addEventListener("click", () => els.assignmentsDialog.close());
});
document.querySelectorAll("[data-close-team-operation]").forEach((button) => {
  button.addEventListener("click", () => {
    if (state.teamOperationTimer) clearTimeout(state.teamOperationTimer);
    els.teamOperationDialog.close();
  });
});
document.querySelectorAll("[data-close-password]").forEach((button) => {
  button.addEventListener("click", () => els.passwordDialog.close());
});
els.passwordDialog.addEventListener("cancel", (event) => {
  if (els.passwordDialog.dataset.force === "true") event.preventDefault();
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (state.teamMode) {
    void loadTeamStatus();
    scheduleTeamStatusPoll();
  } else {
    scheduleStatusPoll(0);
  }
});

void initializeApp();
