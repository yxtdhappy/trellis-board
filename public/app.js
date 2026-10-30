import { renderMarkdown } from "./markdown.js";
import { formatArchiveTimestamp, sortArchivedTasks } from "./archive-sort.js";
import {
  normalizeTaskSlug,
  slugifyTaskTitle,
  TASK_SLUG_PATTERN
} from "./slug.js";

const STAGE_LANES = [
  { id: "planning", label: "规划", hint: "需求、调研、设计与上下文准备", indexes: [0, 1, 2, 3, 4] },
  { id: "review", label: "待放行", hint: "规划产物已备，尚未开始实现", indexes: [5] },
  { id: "implementation", label: "实现", hint: "正在写代码或补充检查", indexes: [6, 7] },
  { id: "verification", label: "验证", hint: "可选真实验证、规范回写", indexes: [8, 9] },
  { id: "closeout", label: "收尾", hint: "归档前：工作提交与归档", indexes: [10, 11] }
];

const ARTIFACT_DEFINITIONS = [
  { key: "prd", label: "PRD", hint: "需求、范围与验收标准" },
  { key: "design", label: "Design", hint: "技术设计与关键取舍" },
  { key: "implement", label: "Implement", hint: "实施计划与检查项" },
  { key: "implementationReport", label: "实施报告", hint: "实现结果与验证记录" },
  { key: "checkReport", label: "检查报告", hint: "质量检查与问题闭环" },
  { key: "e2eReport", label: "E2E 报告", hint: "真实环境端到端验证" }
];

const state = {
  board: null,
  view: "pipeline",
  projectId: "all",
  scope: "all",
  search: "",
  selectedTask: null,
  archiveProject: "all",
  archiveSearch: "",
  loading: false,
  pollTimer: null,
  status: null,
  selectedFolders: [],
  pickingFolders: false,
  addingProjects: false,
  createSlugManuallyEdited: false
};

const els = {
  projectList: document.querySelector("#project-list"),
  projectCount: document.querySelector("#project-count"),
  syncDot: document.querySelector("#sync-dot"),
  syncLabel: document.querySelector("#sync-label"),
  refresh: document.querySelector("#refresh-button"),
  error: document.querySelector("#error-banner"),
  pipeline: document.querySelector("#pipeline-board"),
  team: document.querySelector("#team-board"),
  archive: document.querySelector("#archive-board"),
  search: document.querySelector("#search-input"),
  archiveSearch: document.querySelector("#archive-search"),
  archiveProject: document.querySelector("#archive-project"),
  createButton: document.querySelector("#create-button"),
  manageProjectsButton: document.querySelector("#manage-projects-button"),
  taskDialog: document.querySelector("#task-dialog"),
  artifactDialog: document.querySelector("#artifact-dialog"),
  createDialog: document.querySelector("#create-dialog"),
  projectDialog: document.querySelector("#project-dialog"),
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
  metricTeamCaption: document.querySelector("#metric-team-caption")
};

const safe = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
})[char]);

const initials = (name) => (name || "?").slice(0, 2).toUpperCase();
const activeTasks = () => state.board?.tasks.filter((task) => !task.archived) || [];
const archivedTasks = () => state.board?.tasks.filter((task) => task.archived) || [];
const currentProject = () => state.board?.projects.find((project) => project.id === state.projectId);

function filteredActiveTasks() {
  const search = state.search.toLowerCase();
  const me = state.scope === "mine" ? myDeveloper() : null;
  const matches = (task) => {
    const searchHit = !search || [task.title, task.description, task.assignee, task.projectName, task.projectId]
      .some((value) => String(value || "").toLowerCase().includes(search));
    const projectHit = state.projectId === "all" || task.projectId === state.projectId;
    const ownerHit = state.scope !== "mine" || (me && task.assignee === me);
    return searchHit && projectHit && ownerHit;
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

function laneForStageIndex(task, current) {
  if (task.archived) return null;
  if (current === -1) return null;
  if (current >= 10) return "closeout";
  if (current >= 8) return "verification";
  if (current >= 6) return "implementation";
  if (current === 5) return "review";
  return "planning";
}

function laneForTask(task) {
  return laneForStageIndex(task, task.stages.findIndex((stage) => stage.id === task.derivedStage));
}

function isAttention(task) {
  if (task.archived) return false;
  if (task.groupRelationsValid === false) return true;
  return ["review", "check"].includes(task.derivedStage);
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

function renderMetrics() {
  const active = filteredActiveTasks();
  const allActive = activeTasks();
  const archives = archivedTasks();
  const owners = new Set(active.map((task) => task.assignee).filter(Boolean));
  const attention = active.filter(isAttention);
  els.metricActive.textContent = active.length;
  els.metricActiveCaption.textContent = state.projectId === "all" ? "全部仓库中的进行中任务" : `${currentProject()?.name || state.projectId} 的进行中任务`;
  const scopedArchived = state.projectId === "all"
    ? archives.length
    : archives.filter((task) => task.projectId === state.projectId).length;
  els.metricArchive.textContent = scopedArchived;
  els.metricArchiveCaption.textContent = `${active.length} 个进行中 / 当前范围共 ${active.length + scopedArchived} 个`;
  els.metricAttention.textContent = attention.length;
  els.metricTeam.textContent = owners.size;
  els.metricTeamCaption.textContent = owners.size ? [...owners].join(" · ") : "暂无负责人";
}

function renderProjects() {
  const projects = state.board?.projects || [];
  els.projectCount.textContent = projects.length;
  const all = `
    <button class="project-pill ${state.projectId === "all" ? "is-active" : ""}" data-project="all" type="button">
      <span class="marker"></span>
      <span class="name">全部仓库</span>
      <span class="count">${state.board?.tasks.length || 0}</span>
    </button>`;
  const rows = projects.map((project) => `
    <button class="project-pill ${state.projectId === project.id ? "is-active" : ""}" data-project="${safe(project.id)}" type="button">
      <span class="marker"></span>
      <span class="name" title="${safe(project.name)} · ${safe(project.path)}">${safe(project.name)}</span>
      <span class="count">${project.activeCount}</span>
    </button>`).join("");
  els.projectList.innerHTML = all + rows;
  els.projectList.querySelectorAll("[data-project]").forEach((button) => {
    button.addEventListener("click", () => {
      state.projectId = button.dataset.project;
      state.scope = "all";
      state.view = "pipeline";
      syncScopeButtons();
      renderAll();
    });
  });
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
  bindTaskButtons(els.pipeline);
}

function renderTaskCard(task) {
  return `<button class="task-card ${isAttention(task) ? "is-risk" : ""}" data-task="${safe(task.taskKey)}" type="button">
    ${taskCardContent(task)}
  </button>`;
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
    <div class="mini-track" aria-label="已完成 ${progress.done}/${progress.total} 个必需阶段，E2E 为可选证据">
      ${task.stages.map((stage) => `<i class="${stage.complete ? (stage.source === "manual" ? "manual" : "done") : stage.optional ? "optional" : ""}" title="${safe(stage.label)}${stage.optional ? "（可选证据）" : ""} · ${safe(stage.evidence)}"></i>`).join("")}
    </div>
    <div class="task-card-foot">
      <span class="owner"><span class="avatar">${safe(initials(task.assignee))}</span>${safe(task.assignee || "未派发")}</span>
      <span>${safe(next.label)} · ${progress.percent}%</span>
    </div>`;
}

function renderTaskFamily(group) {
  if (group.members.length === 1) return renderTaskCard(group.parent);
  const children = group.members.filter((task) => task.taskKey !== group.parent.taskKey);
  const childProjects = [...new Set(children.map((task) => task.projectName))];
  return `
    <article class="task-family">
      <div class="family-kicker">
        <span>任务组 · ${safe(childProjects.join(" / "))}</span>
        <b title="${group.members.length} 个任务">${group.members.length}</b>
      </div>
      <button class="task-card is-family-parent ${isAttention(group.parent) ? "is-risk" : ""}" data-task="${safe(group.parent.taskKey)}" type="button">
        ${taskCardContent(group.parent)}
      </button>
      <div class="family-children" aria-label="子任务">
        <p>子任务 · ${children.length}</p>
        ${children.map((task) => {
          const next = nextStage(task);
          const progress = taskProgress(task);
          return `<button class="family-child" data-task="${safe(task.taskKey)}" type="button">
            <span class="family-branch" aria-hidden="true">└</span>
            <span class="family-child-copy">
              <b>${safe(task.title)}</b>
              <small>${safe(task.projectName)} · ${safe(task.status)}</small>
            </span>
            <span class="family-stage">${safe(next.label)} · ${progress.percent}%</span>
          </button>`;
        }).join("")}
      </div>
    </article>`;
}

function renderTeam() {
  const tasks = filteredActiveTasks();
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
        ${ownerTasks.map((task) => {
          const next = nextStage(task);
          return `<div class="team-task">
            <button data-task="${safe(task.taskKey)}" type="button" title="${safe(task.title)}">
              ${task.groupSize > 1 ? `<span class="group-role">${task.groupRole === "parent" ? "父" : "子"}</span>` : ""}${safe(task.title)}
            </button>
            <span class="stage-chip">${safe(next.label)}</span>
            <small>${safe(task.projectName)} · ${safe(task.status)}${task.groupSize > 1 ? ` · ${task.groupSize} 个任务一组` : ""}</small>
          </div>`;
        }).join("")}
      </article>`).join("");
  bindTaskButtons(els.team);
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
    button.addEventListener("click", () => {
      const task = state.board.tasks.find((candidate) => candidate.taskKey === button.dataset.task);
      if (task) openTask(task);
    });
  });
}

function emptyMarkup(message = "没有符合当前筛选的任务") {
  return `<div class="empty-state">
    <div class="empty-mark" aria-hidden="true">⌁</div>
    <strong>${safe(message)}</strong>
    <span>换一个项目、负责人或搜索词；也可以创建一条新任务。</span>
  </div>`;
}

function openTask(task) {
  state.selectedTask = task;
  document.querySelector("#task-dialog .dialog-body").scrollTop = 0;
  const content = loadTaskDetail(task).catch((error) => {
    showError(error.message);
    return null;
  });
  content.then((detail) => {
    if (!detail || !els.taskDialog.open || state.selectedTask?.taskKey !== task.taskKey) return;
    state.selectedTask = detail;
    const project = state.board?.projects.find((candidate) => candidate.id === detail.projectId);
    if (project && Array.isArray(detail.projectMembers)) {
      project.members = detail.projectMembers;
    }
    renderTaskDetail(detail);
  });
  renderTaskDetail(task);
  if (!els.taskDialog.open) els.taskDialog.showModal();
  bindStageActions(task);
}

async function loadTaskDetail(task) {
  if (task.artifacts) return task;
  return api("/api/task", "POST", {
    projectId: task.projectId,
    taskPath: task.relativeDir
  });
}

function renderTaskDetail(task) {
  document.querySelector("#dialog-project").textContent = `${task.projectName} / ${task.dirName}`;
  document.querySelector("#dialog-title").textContent = task.title;
  document.querySelector("#dialog-meta").innerHTML = `
    <span>状态 <b>${safe(task.status)}</b></span>
    <span>负责人 <b>${safe(task.assignee || "未派发")}</b></span>
    <span>创建 <b>${safe(task.createdAt || "未知")}</b></span>
    <span>分支 <b>${safe(task.branch || "未记录")}</b></span>
    <span>进度 <b>${taskProgress(task).percent}%</b></span>
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
    ${evidenceSummary}
    ${relationBlock}
    <section><h3>规划证据</h3><p>${safe(prdInfo)}</p></section>
    <section><h3>仓库上下文</h3><p>${safe(task.repoPath)}<br>${safe(task.relativeDir)}</p></section>
    <section><h3>任务产物</h3>${artifactMarkup}</section>
    <section><h3>写入边界</h3><p>任务状态来自 task.json，开发进度也会读取实施/检查报告；E2E 是可选的补充证据，不阻塞规范回写与收尾。归档后任务会同时变为 completed 并离开当前队列。</p></section>`;
  document.querySelector("#stage-detail").innerHTML = task.stages.map((stage) => `
    <div class="stage-row ${stage.complete ? (stage.source === "manual" ? "manual" : "done") : stage.optional ? "optional" : ""}">
      <span class="stage-number">${stage.index}</span>
      <div><strong>${safe(stage.label)}</strong><p>${safe(stage.evidence || "等待执行")}</p></div>
      <span class="stage-source ${stage.source === "manual" ? "manual-source" : ""}">${safe(stageSourceLabel(stage))}<br><small>${safe(stageAdvice(task, stage))}</small></span>
    </div>`).join("");
  bindTaskButtons(document.querySelector("#detail-summary"));
  bindArtifactButtons(document.querySelector("#detail-summary"));
  renderAssigneeOptions(task);
  document.querySelector("#assign-button").style.display = task.archived ? "none" : "";
  document.querySelector(".assign-inline label").style.display = task.archived ? "none" : "";
  document.querySelector("#assignee-input").style.display = task.archived ? "none" : "";
}

function renderAssigneeOptions(task) {
  const project = state.board?.projects.find((candidate) => candidate.id === task.projectId);
  const members = [...new Set(
    task.projectMembers || project?.members || []
  )].sort((a, b) => a.localeCompare(b, "zh-CN"));
  const current = task.assignee || "";
  const select = document.querySelector("#assignee-input");
  select.innerHTML = [
    '<option value="">请选择负责人</option>',
    ...members.map((member) => `<option value="${safe(member)}">${safe(member)}</option>`),
    current && !members.includes(current)
      ? `<option value="${safe(current)}" disabled>${safe(current)}（当前负责人，不在成员列表）</option>`
      : ""
  ].join("");
  select.value = members.includes(current) ? current : "";
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
        await loadBoard();
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

async function api(url, method = "GET", body) {
  const response = await fetch(url, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `请求失败: ${response.status}`);
  return payload;
}

async function loadBoard(forceRefresh = false, quiet = false) {
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
  renderPipeline();
  renderTeam();
  renderArchiveOptions();
  renderArchive();
  renderView();
}

function openCreateDialog() {
  const select = document.querySelector("#create-project");
  select.innerHTML = (state.board?.projects || []).map((project) => `
    <option value="${safe(project.id)}">${safe(project.name)} · ${project.activeCount} 进行中</option>`).join("");
  if (state.projectId !== "all") select.value = state.projectId;
  updateCreateOptions();
  document.querySelector("#create-assignee").value = "";
  const title = document.querySelector("#create-title").value.trim();
  const slug = normalizeTaskSlug(document.querySelector("#create-slug").value);
  state.createSlugManuallyEdited = Boolean(slug && slug !== slugifyTaskTitle(title));
  document.querySelector("#create-message").hidden = true;
  els.createDialog.showModal();
}

function updateCreateOptions() {
  const projectId = document.querySelector("#create-project").value;
  const project = state.board?.projects.find((item) => item.id === projectId);
  const members = project?.members || [];
  document.querySelector("#create-assignee").innerHTML = [
    '<option value="">请选择负责人</option>',
    ...members.map((member) => `<option value="${safe(member)}">${safe(member)}</option>`)
  ].join("");
  const branchSelect = document.querySelector("#create-branch");
  const branches = project?.branches || [];
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
  const project = state.board.projects.find((item) => item.id === projectId);
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
    slug,
    baseBranch: document.querySelector("#create-branch").value || undefined
  };
  try {
    await api("/api/tasks", "POST", payload);
    setCreateMessage("任务已创建，状态保持 planning；请继续补齐 PRD 并完成规划评审。");
    document.querySelector("#create-title").value = "";
    document.querySelector("#create-description").value = "";
    slugInput.value = "";
    state.createSlugManuallyEdited = false;
    await loadBoard();
  } catch (error) {
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
  const members = state.selectedTask.projectMembers || project?.members || [];
  if (!members.includes(assignee)) {
    showError("负责人必须是当前项目的成员");
    return;
  }
  try {
    await api("/api/tasks/assign", "POST", {
      repositoryId: state.selectedTask.projectId,
      taskDir: state.selectedTask.relativeDir,
      assignee
    });
    els.taskDialog.close();
    await loadBoard();
  } catch (error) {
    showError(error.message);
  }
}

document.querySelectorAll(".nav-item").forEach((button) => {
  button.addEventListener("click", () => {
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
  });
});

els.search.addEventListener("input", () => {
  state.search = els.search.value.trim();
  renderMetrics();
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
els.createButton.addEventListener("click", openCreateDialog);
els.manageProjectsButton.addEventListener("click", openProjectDialog);
els.projectForm.addEventListener("submit", submitProject);
els.pickFoldersButton.addEventListener("click", pickProjectFolders);
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
document.querySelector("#assign-button").addEventListener("click", assignSelected);
document.querySelector("#assignee-input").addEventListener("change", updateAssignButtonState);
document.querySelector("#create-form").addEventListener("submit", submitCreate);
document.querySelector("#create-project").addEventListener("change", updateCreateOptions);
document.querySelector("#create-title").addEventListener("input", syncCreateSlugFromTitle);
document.querySelector("#create-slug").addEventListener("input", (event) => {
  state.createSlugManuallyEdited = Boolean(event.target.value.trim());
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") scheduleStatusPoll(0);
});

loadBoard();
