import { escapeHtml as safe, setMessage } from "./dom.js";
import { redirectToLogin, requestJson } from "./team-request.js";
import {
  adminCollection,
  canManageProject,
  normalizeAdminUser,
  normalizeAgentBinding,
  normalizeAgentDevice,
  normalizeAuditEvent,
  normalizeProjectMembers,
  normalizeRuntime,
  normalizeTeamProject
} from "./team-client.js";

const $ = (selector) => document.querySelector(selector);
const VIEW_META = {
  "project-access": ["项目协作", "维护项目成员、Agent 绑定和项目审计。"],
  users: ["用户账号", "创建账号、调整系统角色并重置一次性临时密码。"],
  projects: ["项目接入", "管理服务端项目工作副本、共享分支和工具链批准。"],
  agents: ["Agent 设备", "查看设备心跳、版本和撤销状态。"],
  audit: ["系统审计", "检查跨项目操作结果；敏感字段在渲染前再次隐藏。"]
};

const state = {
  runtime: null,
  user: null,
  isAdmin: false,
  view: null,
  projects: [],
  users: [],
  devices: [],
  accessProjectId: "",
  members: [],
  bindings: [],
  projectAudit: [],
  projectAuditBefore: null,
  systemAudit: [],
  systemAuditBefore: null,
  approval: null,
  editUserIndex: null
};

function formatError(error) {
  return error?.code ? `${error.message}（${error.code}）` : error?.message || "请求失败";
}

function handleUnauthorized(error) {
  if (error?.status !== 401) return false;
  if (error.code === "PASSWORD_CHANGE_REQUIRED") {
    window.location.replace("/");
  } else {
    redirectToLogin();
  }
  return true;
}

async function api(url, options) {
  try {
    return await requestJson(url, options);
  } catch (error) {
    handleUnauthorized(error);
    throw error;
  }
}

function showFeedback(message) {
  setMessage($("#admin-feedback"), message);
}

function showGlobalError(error) {
  if (handleUnauthorized(error)) return;
  setMessage($("#admin-error"), formatError(error), true);
}

function report(target, error) {
  if (handleUnauthorized(error)) return;
  setMessage(target, formatError(error), true);
}

function clear(target) {
  setMessage(target, "");
}

function formatTime(value) {
  if (!value) return "从未";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

function statusTone(status) {
  if (["current", "active", "approved", "success", "pushed", "applied"].includes(status)) {
    return "success";
  }
  if (["stale", "pending_push", "pending", "provisioning", "warning"].includes(status)) {
    return "warning";
  }
  if (["needs_repair", "failed", "error", "rejected", "revoked", "disabled"].includes(status)) {
    return "danger";
  }
  return "neutral";
}

function badge(value) {
  return `<span class="status-pill tone-${statusTone(value)}">${safe(value || "unknown")}</span>`;
}

function emptyRow(message) {
  return `<div class="admin-empty">${safe(message)}</div>`;
}

function managedProjects() {
  if (state.isAdmin) return state.projects;
  return state.runtime?.projects.filter(canManageProject) || [];
}

function projectOptions() {
  const projects = managedProjects();
  const seen = new Set();
  return projects.filter((project) => {
    if (!project.id || seen.has(project.id)) return false;
    seen.add(project.id);
    return true;
  }).sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
}

function updateIdentity() {
  const user = state.user;
  $("#admin-name").textContent = user?.displayName || user?.username || "团队账号";
  $("#admin-role").textContent = state.isAdmin ? "系统管理员" : "项目负责人";
  $("#admin-avatar").textContent = (user?.displayName || user?.username || "?").slice(0, 1);
}

function configureNavigation() {
  const adminViews = ["users", "projects", "agents", "audit"];
  for (const button of document.querySelectorAll("[data-admin-view]")) {
    if (adminViews.includes(button.dataset.adminView)) button.hidden = !state.isAdmin;
  }
}

function setView(view) {
  if (!VIEW_META[view]) return;
  state.view = view;
  const [title, subtitle] = VIEW_META[view];
  $("#admin-title").textContent = title;
  $("#admin-subtitle").textContent = subtitle;
  for (const button of document.querySelectorAll("[data-admin-view]")) {
    const active = button.dataset.adminView === view;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-current", active ? "page" : "false");
  }
  for (const section of document.querySelectorAll(".admin-view")) {
    section.hidden = section.id !== `${view}-view`;
  }
  if (view === "users") void loadUsers();
  if (view === "projects") void loadProjects();
  if (view === "agents") void loadDevices();
  if (view === "audit") void loadSystemAudit(true);
  if (view === "project-access") void refreshAccessProjectOptions();
}

async function loadUsers({ quiet = false } = {}) {
  try {
    const result = await api("/api/admin/users");
    state.users = adminCollection(result.data, "users").map(normalizeAdminUser);
    renderUsers();
    if (!quiet) clear($("#users-message"));
    return state.users;
  } catch (error) {
    report($("#users-message"), error);
    return [];
  }
}

async function loadProjects({ quiet = false } = {}) {
  try {
    const result = await api("/api/admin/projects");
    state.projects = adminCollection(result.data, "projects").map(normalizeTeamProject);
    renderProjects();
    await refreshAccessProjectOptions();
    if (!quiet) clear($("#projects-message"));
    return state.projects;
  } catch (error) {
    report($("#projects-message"), error);
    return [];
  }
}

async function loadDevices({ quiet = false } = {}) {
  if (!state.isAdmin) return [];
  try {
    const result = await api("/api/admin/agents");
    state.devices = adminCollection(result.data, "agents").map(normalizeAgentDevice);
    renderDevices();
    if (!quiet) clear($("#agents-message"));
    return state.devices;
  } catch (error) {
    report($("#agents-message"), error);
    return [];
  }
}

async function refreshAccessProjectOptions() {
  const projects = projectOptions();
  const select = $("#access-project");
  const selected = state.accessProjectId;
  select.innerHTML = [
    '<option value="">请选择项目</option>',
    ...projects.map((project) =>
      `<option value="${safe(project.id)}">${safe(project.name)} · ${safe(project.syncStatus)}</option>`
    )
  ].join("");
  if (projects.some((project) => project.id === selected)) {
    select.value = selected;
  } else {
    state.accessProjectId = "";
    $("#access-refresh").disabled = true;
    renderMembers();
    renderBindings();
    renderAudit(state.projectAudit, $("#project-audit-list"), "请选择一个有管理权限的项目。");
  }
}

function renderUsers() {
  const container = $("#users-list");
  if (!state.users.length) {
    container.innerHTML = emptyRow("暂无用户账号。");
    return;
  }
  container.innerHTML = state.users.map((user, index) => `
    <article class="admin-row">
      <div class="admin-row-main">
        <div class="admin-row-title">
          <strong>${safe(user.displayName || user.username)}</strong>
          ${badge(user.status)}
          ${user.systemAdmin ? '<span class="status-pill tone-info">系统管理员</span>' : ""}
          ${user.mustChangePassword ? '<span class="status-pill tone-warning">待改密</span>' : ""}
        </div>
        <p><code>${safe(user.username)}</code> · ID <code>${safe(user.id)}</code></p>
        <p>最近改密 ${safe(formatTime(user.passwordChangedAt))} · 创建 ${safe(formatTime(user.createdAt))}</p>
      </div>
      <div class="admin-row-actions">
        <button class="secondary-button small-button" type="button" data-user-action="edit" data-index="${index}">编辑</button>
        <button class="secondary-button small-button" type="button" data-user-action="reset" data-index="${index}">重置密码</button>
        <button class="${user.status === "active" ? "danger-button" : "secondary-button"} small-button" type="button" data-user-action="toggle" data-index="${index}">
          ${user.status === "active" ? "停用" : "启用"}
        </button>
      </div>
    </article>
  `).join("");
}

function renderProjects() {
  const container = $("#projects-list");
  if (!state.projects.length) {
    container.innerHTML = emptyRow("尚未接入团队项目。");
    return;
  }
  container.innerHTML = state.projects.map((project, index) => {
    const canApprove = project.syncStatus === "provisioning" || !project.scriptsSha256;
    const canRepair = project.syncStatus === "needs_repair";
    const canRefresh = !["disabled", "provisioning"].includes(project.syncStatus);
    const canDisable = project.syncStatus !== "disabled";
    return `
      <article class="admin-row project-admin-row">
        <div class="admin-row-main">
          <div class="admin-row-title">
            <strong>${safe(project.name)}</strong>
            ${badge(project.syncStatus)}
            ${project.stale ? '<span class="status-pill tone-warning">需要关注</span>' : ""}
          </div>
          <p><code>${safe(project.id)}</code> · 共享分支 <code>${safe(project.syncBranch || "未配置")}</code></p>
          <p>工具链摘要 <code class="hash-value">${safe(project.scriptsSha256 || "尚未批准")}</code></p>
          <p>hooks 状态 ${safe(project.hooksStatus || "核心项目接口暂未暴露 hooks 状态")}</p>
          <p>最近 fetch ${safe(formatTime(project.lastFetchAt))} · push ${safe(formatTime(project.lastPushAt))}</p>
          ${project.lastError ? `<p class="inline-error">${safe(project.lastError)}</p>` : ""}
        </div>
        <div class="admin-row-actions">
          ${canApprove ? `<button class="primary-button small-button" type="button" data-project-action="approve" data-index="${index}">批准接入</button>` : ""}
          ${canRefresh ? `<button class="secondary-button small-button" type="button" data-project-action="refresh" data-index="${index}">刷新 Git</button>` : ""}
          ${canRepair ? `<button class="secondary-button small-button" type="button" data-project-action="repair" data-index="${index}">尝试修复</button>` : ""}
          ${canDisable ? `<button class="danger-button small-button" type="button" data-project-action="disable" data-index="${index}">停用项目</button>` : ""}
        </div>
      </article>
    `;
  }).join("");
}

async function editUser(index) {
  const user = state.users[index];
  if (!user) return;
  state.editUserIndex = index;
  $("#edit-user-name").value = user.displayName || user.username;
  $("#edit-user-status").value = user.status === "disabled" ? "disabled" : "active";
  $("#edit-user-admin").checked = Boolean(user.systemAdmin);
  clear($("#user-edit-message"));
  $("#user-edit-dialog").showModal();
  $("#edit-user-name").focus();
}

function openUserEditFor(index) {
  void editUser(index);
}

async function toggleUser(index) {
  const user = state.users[index];
  if (!user) return;
  const status = user.status === "active" ? "disabled" : "active";
  if (!window.confirm(`${status === "disabled" ? "停用" : "启用"}账号 ${user.username}？`)) return;
  try {
    const result = await api(`/api/admin/users/${encodeURIComponent(user.id)}`, {
      method: "PATCH",
      body: { status }
    });
    const updated = normalizeAdminUser(result.data?.user || result.data);
    state.users[index] = updated;
    renderUsers();
    showFeedback(`账号 ${updated.username} 已${status === "active" ? "启用" : "停用"}。`);
  } catch (error) {
    report($("#users-message"), error);
  }
}

async function resetPassword(index) {
  const user = state.users[index];
  if (!user || !window.confirm(`重置 ${user.username} 的密码？该账号全部会话会立即失效。`)) return;
  try {
    const result = await api(
      `/api/admin/users/${encodeURIComponent(user.id)}/reset-password`,
      { method: "POST", body: {} }
    );
    showSecret(
      "临时密码",
      `${user.username} 必须使用此密码登录并立即修改；关闭后无法再次查看。`,
      result.data?.temporaryPassword
    );
    await loadUsers({ quiet: true });
  } catch (error) {
    report($("#users-message"), error);
  }
}

function showSecret(title, description, value) {
  if (!value) {
    setMessage($("#admin-error"), "服务端没有返回一次性凭证，请重新执行操作。", true);
    return;
  }
  $("#secret-title").textContent = title;
  $("#secret-description").textContent = description;
  $("#secret-value").textContent = value;
  $("#copy-secret").textContent = "复制";
  $("#secret-dialog").showModal();
  $("#copy-secret").focus();
}

async function openApproval(project, approval = null) {
  if (!state.isAdmin) return;
  if (!state.users.length) await loadUsers({ quiet: true });
  const sha256 = approval?.toolchainSha256 || project.scriptsSha256;
  if (!sha256) {
    setMessage($("#projects-message"), "项目没有可批准的工具链摘要，请重新连接或修复项目。", true);
    return;
  }
  state.approval = { project, sha256 };
  $("#approval-project").textContent =
    `${project.name || project.id} · ${project.syncBranch || "共享分支未返回"}`;
  $("#approval-hash").textContent = sha256;
  const files = Array.isArray(approval?.files) ? approval.files : [];
  $("#approval-files").innerHTML = files.length
    ? `<p>已扫描脚本文件</p><ul>${files.map((file) => `<li><code>${safe(file)}</code></li>`).join("")}</ul>`
    : '<p class="form-hint">当前列表未返回文件清单；批准前请核对摘要来源。</p>';
  const users = state.users.filter((user) => user.status === "active");
  $("#approval-lead").innerHTML = users.length
    ? users.map((user) =>
      `<option value="${safe(user.id)}">${safe(user.displayName || user.username)}（${safe(user.username)}）</option>`
    ).join("")
    : '<option value="">没有 active 用户</option>';
  $("#approval-dev-id").value = "";
  clear($("#approval-message"));
  $("#approval-submit").disabled = users.length === 0;
  $("#approval-dialog").showModal();
  $("#approval-dev-id").focus();
}

async function runProjectAction(index, action) {
  const project = state.projects[index];
  if (!project) return;
  if (action === "approve") {
    await openApproval(project);
    return;
  }
  if (action === "disable" && !window.confirm(`停用项目 ${project.name}？相关 Agent 绑定会被删除。`)) {
    return;
  }
  if (action === "repair" && !window.confirm(`对 ${project.name} 执行受控修复？`)) return;
  try {
    if (action === "refresh") {
      await api(`/api/projects/${encodeURIComponent(project.id)}/refresh`, {
        method: "POST",
        body: { force: false }
      });
      showFeedback(`项目 ${project.name} 已刷新。`);
    } else if (action === "repair") {
      await api(`/api/admin/projects/${encodeURIComponent(project.id)}/repair`, {
        method: "POST",
        body: {}
      });
      showFeedback(`项目 ${project.name} 已执行修复检查。`);
    } else if (action === "disable") {
      await api(`/api/admin/projects/${encodeURIComponent(project.id)}/disable`, {
        method: "POST",
        body: {}
      });
      showFeedback(`项目 ${project.name} 已停用。`);
    }
    await loadProjects({ quiet: true });
  } catch (error) {
    report($("#projects-message"), error);
  }
}

async function loadAccessProject(projectId) {
  state.accessProjectId = projectId || "";
  state.members = [];
  state.bindings = [];
  state.projectAudit = [];
  state.projectAuditBefore = null;
  renderMembers();
  renderBindings();
  renderAudit(state.projectAudit, $("#project-audit-list"), "正在读取项目审计…");
  $("#access-refresh").disabled = !projectId;
  clear($("#access-message"));
  clear($("#bindings-message"));
  if (!projectId) return;
  const encoded = encodeURIComponent(projectId);
  const [members, bindings, audit] = await Promise.allSettled([
    api(`/api/projects/${encoded}/members`),
    api(`/api/projects/${encoded}/agents`),
    api(`/api/projects/${encoded}/audit?limit=100`)
  ]);
  if (state.accessProjectId !== projectId) return;
  if (members.status === "fulfilled") {
    state.members = normalizeProjectMembers(members.value.data);
    renderMembers();
  } else {
    report($("#access-message"), members.reason);
  }
  if (bindings.status === "fulfilled") {
    state.bindings = adminCollection(bindings.value.data, "agents").map(normalizeAgentBinding);
    renderBindings();
  } else {
    report($("#bindings-message"), bindings.reason);
  }
  if (audit.status === "fulfilled") {
    state.projectAudit = adminCollection(audit.value.data, "events").map(normalizeAuditEvent);
    state.projectAuditBefore = state.projectAudit.at(-1)?.id || null;
    renderAudit(state.projectAudit, $("#project-audit-list"));
  } else {
    renderAudit([], $("#project-audit-list"), formatError(audit.reason));
  }
}

function renderMembers() {
  $("#members-count").textContent = String(state.members.length);
  const container = $("#members-list");
  if (!state.accessProjectId) {
    container.innerHTML = emptyRow("先选择项目。");
    return;
  }
  if (!state.members.length) {
    container.innerHTML = emptyRow("项目还没有成员。");
    return;
  }
  container.innerHTML = state.members.map((member, index) => `
    <article class="admin-row compact-row">
      <div class="admin-row-main">
        <div class="admin-row-title">
          <strong>${safe(member.displayName || member.username || member.userId)}</strong>
          ${badge(member.role)}
          ${badge(member.status)}
        </div>
        <p>用户 <code>${safe(member.userId || "未知")}</code> · developer <code>${safe(member.trellisDevId || "未配置")}</code></p>
      </div>
      <div class="admin-row-actions">
        <button class="secondary-button small-button" type="button" data-member-action="edit" data-index="${index}">编辑</button>
        <button class="danger-button small-button" type="button" data-member-action="remove" data-index="${index}">移除</button>
      </div>
    </article>
  `).join("");
}

function renderBindings() {
  $("#bindings-count").textContent = String(state.bindings.length);
  const container = $("#bindings-list");
  if (!state.accessProjectId) {
    container.innerHTML = emptyRow("先选择项目。");
    return;
  }
  if (!state.bindings.length) {
    container.innerHTML = emptyRow("暂无 Agent 绑定。");
    return;
  }
  container.innerHTML = state.bindings.map((binding, index) => {
    const actions = [];
    if (binding.status === "pending") {
      actions.push(`<button class="primary-button small-button" type="button" data-binding-action="approve" data-index="${index}">确认</button>`);
      actions.push(`<button class="danger-button small-button" type="button" data-binding-action="reject" data-index="${index}">拒绝</button>`);
    } else if (binding.status === "approved") {
      actions.push(`<button class="danger-button small-button" type="button" data-binding-action="revoke" data-index="${index}">撤销</button>`);
    }
    return `
      <article class="admin-row compact-row">
        <div class="admin-row-main">
          <div class="admin-row-title">
            <strong>${safe(binding.deviceName || binding.agentId)}</strong>
            ${badge(binding.status)}
            ${binding.agentStatus ? badge(binding.agentStatus) : ""}
          </div>
          <p>所有者 ${safe(binding.ownerDisplayName || binding.ownerUsername || "未知")} · 分支 <code>${safe(binding.branchName || "未返回")}</code></p>
          <p>仓库 <code>${safe(binding.displayName || binding.localRepoKey || "未返回")}</code></p>
          <p>最近心跳 ${safe(formatTime(binding.lastSeenAt))} · 同步 ${safe(formatTime(binding.lastSyncedAt))}</p>
          ${binding.lastError ? `<p class="inline-error">${safe(binding.lastError)}</p>` : ""}
        </div>
        <div class="admin-row-actions">${actions.join("")}</div>
      </article>
    `;
  }).join("");
}

async function saveMember(event) {
  event.preventDefault();
  const projectId = state.accessProjectId;
  if (!projectId) {
    setMessage($("#access-message"), "先选择项目。", true);
    return;
  }
  const role = $("#member-role").value;
  const userId = $("#member-user-id").value.trim();
  const developerId = role === "read_only" ? null : $("#member-dev-id").value.trim() || null;
  try {
    const result = await api(`/api/projects/${encodeURIComponent(projectId)}/members`, {
      method: "PUT",
      body: { userId, role, trellisDevId: developerId }
    });
    state.members = normalizeProjectMembers(result.data);
    renderMembers();
    $("#member-user-id").value = "";
    $("#member-dev-id").value = "";
    setMessage($("#access-message"), "项目成员已保存。");
  } catch (error) {
    report($("#access-message"), error);
  }
}

async function editMember(index) {
  const member = state.members[index];
  if (!member) return;
  $("#member-user-id").value = member.userId || "";
  $("#member-role").value = member.role || "member";
  $("#member-dev-id").value = member.trellisDevId || "";
  syncMemberDeveloperField();
  $("#member-user-id").focus();
}

async function removeMember(index) {
  const member = state.members[index];
  if (!member || !window.confirm(`从项目移除 ${member.displayName || member.username}？`)) return;
  try {
    const result = await api(
      `/api/projects/${encodeURIComponent(state.accessProjectId)}/members?userId=${encodeURIComponent(member.userId)}`,
      { method: "DELETE" }
    );
    state.members = normalizeProjectMembers(result.data);
    renderMembers();
    setMessage($("#access-message"), "项目成员已移除。");
  } catch (error) {
    report($("#access-message"), error);
  }
}

function syncMemberDeveloperField() {
  const readOnly = $("#member-role").value === "read_only";
  $("#member-dev-id").disabled = readOnly;
  $("#member-dev-id").required = !readOnly;
}

async function bindingAction(index, action) {
  const binding = state.bindings[index];
  if (!binding) return;
  if (action !== "approve" && !window.confirm(`确认对 Agent 绑定执行“${action}”？`)) return;
  try {
    const result = await api(
      `/api/projects/${encodeURIComponent(state.accessProjectId)}/agents/${encodeURIComponent(binding.id)}/${action}`,
      { method: "POST", body: {} }
    );
    const queued = result.data?.commandQueued ? "，同步命令已排队" : "";
    await loadAccessProject(state.accessProjectId);
    setMessage($("#bindings-message"), `绑定状态已更新${queued}。`);
  } catch (error) {
    report($("#bindings-message"), error);
  }
}

function renderAudit(events, container, emptyMessage = "暂无审计事件。") {
  if (!events.length) {
    container.innerHTML = emptyRow(emptyMessage);
    return;
  }
  container.innerHTML = events.map((event) => `
    <article class="audit-event">
      <div class="audit-event-head">
        <strong>${safe(event.action || "unknown")}</strong>
        ${badge(event.result)}
        <time>${safe(formatTime(event.occurredAt))}</time>
      </div>
      <p>目标 ${safe(event.targetType || "unknown")} <code>${safe(event.targetId || "-")}</code> · 项目 <code>${safe(event.projectId || "全局")}</code></p>
      <p>操作者 ${safe(event.actorUserId || event.actorAgentId || "system")} · 关联 ID <code>${safe(event.correlationId || "-")}</code></p>
      <pre>${safe(JSON.stringify(event.detail || {}, null, 2))}</pre>
    </article>
  `).join("");
}

async function loadProjectAudit(reset = true) {
  const projectId = state.accessProjectId;
  if (!projectId) return;
  const before = reset ? "" : state.projectAuditBefore ? `&beforeId=${state.projectAuditBefore}` : "";
  try {
    const result = await api(`/api/projects/${encodeURIComponent(projectId)}/audit?limit=100${before}`);
    const events = adminCollection(result.data, "events").map(normalizeAuditEvent);
    state.projectAudit = reset ? events : [...state.projectAudit, ...events];
    state.projectAuditBefore = state.projectAudit.at(-1)?.id || null;
    renderAudit(state.projectAudit, $("#project-audit-list"));
    $("#project-audit-more").hidden = events.length < 100;
  } catch (error) {
    renderAudit([], $("#project-audit-list"), formatError(error));
  }
}

async function loadSystemAudit(reset = true) {
  if (!state.isAdmin) return;
  const before = reset ? "" : state.systemAuditBefore ? `&beforeId=${state.systemAuditBefore}` : "";
  try {
    const result = await api(`/api/admin/audit?limit=100${before}`);
    const events = adminCollection(result.data, "events").map(normalizeAuditEvent);
    state.systemAudit = reset ? events : [...state.systemAudit, ...events];
    state.systemAuditBefore = state.systemAudit.at(-1)?.id || null;
    renderAudit(state.systemAudit, $("#audit-list"));
    $("#audit-more").hidden = events.length < 100;
    clear($("#audit-message"));
  } catch (error) {
    if (error.status === 404) {
      state.systemAudit = [];
      renderAudit([], $("#audit-list"), "核心服务尚未提供 /api/admin/audit；项目审计仍可从“项目协作”查看。");
      $("#audit-more").hidden = true;
      return;
    }
    report($("#audit-message"), error);
  }
}

function renderDevices() {
  const container = $("#agents-list");
  if (!state.devices.length) {
    container.innerHTML = emptyRow("暂无已注册 Agent。");
    return;
  }
  container.innerHTML = state.devices.map((device, index) => `
    <article class="admin-row">
      <div class="admin-row-main">
        <div class="admin-row-title">
          <strong>${safe(device.deviceName)}</strong>
          ${badge(device.status)}
        </div>
        <p>所有者 ${safe(device.displayName || device.username || "未知")} · ${safe(device.platform || "平台未知")}</p>
        <p>Agent ${safe(device.agentVersion || "未知版本")} · 协议 v${safe(device.protocolVersion)} · 最近心跳 ${safe(formatTime(device.lastSeenAt))}</p>
        <p>设备 ID <code>${safe(device.id)}</code> · 创建 ${safe(formatTime(device.createdAt))}</p>
      </div>
      <div class="admin-row-actions">
        ${device.status !== "revoked" ? `<button class="danger-button small-button" type="button" data-device-action="revoke" data-index="${index}">撤销设备</button>` : `<span class="status-pill tone-danger">已撤销 ${safe(formatTime(device.revokedAt))}</span>`}
      </div>
    </article>
  `).join("");
}

async function revokeDevice(index) {
  const device = state.devices[index];
  if (!device || !window.confirm(`撤销 Agent 设备 ${device.deviceName}？相关绑定和待执行命令会失效。`)) return;
  try {
    await api(`/api/admin/agents/${encodeURIComponent(device.id)}/revoke`, {
      method: "POST",
      body: {}
    });
    setMessage($("#agents-message"), "Agent 设备已撤销。");
    await loadDevices({ quiet: true });
  } catch (error) {
    report($("#agents-message"), error);
  }
}

async function createPairingCode() {
  try {
    const result = await api("/api/team/pairing-codes", {
      method: "POST",
      body: {}
    });
    const expiresAt = result.data?.expiresAt;
    showSecret(
      "Agent 配对码",
      expiresAt ? `仅显示一次，有效期至 ${formatTime(expiresAt)}。` : "仅显示一次，请立即完成 Agent 配对。",
      result.data?.pairingCode
    );
  } catch (error) {
    report(state.view === "agents" ? $("#agents-message") : $("#bindings-message"), error);
  }
}

async function logout() {
  try {
    await api("/api/auth/logout", { method: "POST", body: {} });
  } catch {
    // 即使服务端会话已失效，也回到登录页。
  }
  window.location.replace("/login.html");
}

async function submitCreateUser(event) {
  event.preventDefault();
  const submit = event.submitter || event.currentTarget.querySelector("button[type=submit]");
  submit.disabled = true;
  clear($("#users-message"));
  try {
    const result = await api("/api/admin/users", {
      method: "POST",
      body: {
        username: $("#user-username").value.trim(),
        displayName: $("#user-display-name").value.trim(),
        systemAdmin: $("#user-system-admin").checked,
        mustChangePassword: true
      }
    });
    $("#user-create-form").reset();
    showSecret(
      "用户临时密码",
      `${result.data?.user?.username || "新用户"} 首次登录后必须修改密码；关闭后无法再次查看。`,
      result.data?.temporaryPassword
    );
    await loadUsers({ quiet: true });
  } catch (error) {
    report($("#users-message"), error);
  } finally {
    submit.disabled = false;
  }
}

async function submitUserEdit(event) {
  event.preventDefault();
  const user = state.users[state.editUserIndex];
  if (!user) return;
  const submit = $("#user-edit-submit");
  submit.disabled = true;
  clear($("#user-edit-message"));
  try {
    const result = await api(`/api/admin/users/${encodeURIComponent(user.id)}`, {
      method: "PATCH",
      body: {
        displayName: $("#edit-user-name").value.trim(),
        status: $("#edit-user-status").value,
        systemAdmin: $("#edit-user-admin").checked
      }
    });
    state.users[state.editUserIndex] = normalizeAdminUser(result.data?.user || result.data);
    renderUsers();
    $("#user-edit-dialog").close();
    showFeedback(`账号 ${user.username} 已更新。`);
  } catch (error) {
    report($("#user-edit-message"), error);
  } finally {
    submit.disabled = false;
  }
}

async function submitProjectCreate(event) {
  event.preventDefault();
  const submit = event.submitter || event.currentTarget.querySelector("button[type=submit]");
  submit.disabled = true;
  clear($("#projects-message"));
  try {
    const result = await api("/api/admin/projects", {
      method: "POST",
      body: {
        name: $("#project-name").value.trim(),
        syncBranch: $("#project-branch").value.trim(),
        remoteUrl: $("#project-remote").value,
        repositoryId: $("#project-repository-id").value.trim() || undefined
      }
    });
    const project = normalizeTeamProject(result.data?.project || {});
    $("#project-create-form").reset();
    await loadProjects({ quiet: true });
    await openApproval(project, result.data?.approval);
  } catch (error) {
    report($("#projects-message"), error);
  } finally {
    submit.disabled = false;
  }
}

async function submitApproval(event) {
  event.preventDefault();
  if (!state.approval) return;
  const submit = $("#approval-submit");
  submit.disabled = true;
  clear($("#approval-message"));
  try {
    await api(`/api/admin/projects/${encodeURIComponent(state.approval.project.id)}/approve`, {
      method: "POST",
      body: {
        toolchainSha256: state.approval.sha256,
        leadUserId: $("#approval-lead").value,
        leadTrellisDevId: $("#approval-dev-id").value.trim()
      }
    });
    $("#approval-dialog").close();
    state.approval = null;
    showFeedback("项目工具链已批准，首个负责人已配置。");
    await loadProjects({ quiet: true });
  } catch (error) {
    report($("#approval-message"), error);
  } finally {
    submit.disabled = false;
  }
}

async function boot() {
  try {
    const result = await api("/api/runtime");
    const runtime = normalizeRuntime(result.data);
    if (!runtime.team) {
      window.location.replace("/");
      return;
    }
    if (!runtime.authenticated || !runtime.user) {
      redirectToLogin();
      return;
    }
    if (runtime.user.mustChangePassword) {
      window.location.replace("/");
      return;
    }
    state.runtime = runtime;
    state.user = runtime.user;
    state.isAdmin = runtime.systemAdmin;
    updateIdentity();
    configureNavigation();
    const canManage = state.isAdmin || runtime.projects.some(canManageProject);
    $("#admin-loading").hidden = true;
    if (!canManage) {
      $("#admin-denied").hidden = false;
      return;
    }
    $("#project-access-view").hidden = false;
    if (state.isAdmin) {
      await Promise.allSettled([loadUsers({ quiet: true }), loadProjects({ quiet: true })]);
    }
    await refreshAccessProjectOptions();
    setView("project-access");
  } catch (error) {
    $("#admin-loading").hidden = true;
    showGlobalError(error);
  }
}

document.querySelectorAll("[data-admin-view]").forEach((button) => {
  button.addEventListener("click", () => setView(button.dataset.adminView));
});

$("#access-project").addEventListener("change", (event) => {
  void loadAccessProject(event.target.value);
});
$("#access-refresh").addEventListener("click", () => {
  if (state.accessProjectId) void loadAccessProject(state.accessProjectId);
});
$("#member-role").addEventListener("change", syncMemberDeveloperField);
$("#member-form").addEventListener("submit", saveMember);
$("#members-list").addEventListener("click", (event) => {
  const button = event.target.closest("[data-member-action]");
  if (!button) return;
  const index = Number(button.dataset.index);
  if (button.dataset.memberAction === "edit") void editMember(index);
  if (button.dataset.memberAction === "remove") void removeMember(index);
});
$("#bindings-list").addEventListener("click", (event) => {
  const button = event.target.closest("[data-binding-action]");
  if (button) void bindingAction(Number(button.dataset.index), button.dataset.bindingAction);
});
$("#create-pairing-code").addEventListener("click", createPairingCode);
$("#admin-create-pairing-code").addEventListener("click", createPairingCode);
$("#project-audit-more").addEventListener("click", () => void loadProjectAudit(false));
$("#users-list").addEventListener("click", (event) => {
  const button = event.target.closest("[data-user-action]");
  if (!button) return;
  const index = Number(button.dataset.index);
  if (button.dataset.userAction === "edit") openUserEditFor(index);
  if (button.dataset.userAction === "reset") void resetPassword(index);
  if (button.dataset.userAction === "toggle") void toggleUser(index);
});
$("#projects-list").addEventListener("click", (event) => {
  const button = event.target.closest("[data-project-action]");
  if (button) void runProjectAction(Number(button.dataset.index), button.dataset.projectAction);
});
$("#agents-list").addEventListener("click", (event) => {
  const button = event.target.closest("[data-device-action]");
  if (button && button.dataset.deviceAction === "revoke") void revokeDevice(Number(button.dataset.index));
});
$("#user-create-form").addEventListener("submit", submitCreateUser);
$("#user-edit-form").addEventListener("submit", submitUserEdit);
$("#project-create-form").addEventListener("submit", submitProjectCreate);
$("#approval-form").addEventListener("submit", submitApproval);
$("#projects-refresh").addEventListener("click", () => void loadProjects());
$("#audit-refresh").addEventListener("click", () => void loadSystemAudit(true));
$("#audit-more").addEventListener("click", () => void loadSystemAudit(false));
$("#admin-logout").addEventListener("click", logout);
$("#copy-secret").addEventListener("click", async (event) => {
  const value = $("#secret-value").textContent;
  try {
    await navigator.clipboard.writeText(value);
    event.currentTarget.textContent = "已复制";
  } catch {
    event.currentTarget.textContent = "请手动复制";
  }
});

document.querySelectorAll("[data-close-secret]").forEach((button) => {
  button.addEventListener("click", () => $("#secret-dialog").close());
});
document.querySelectorAll("[data-close-approval]").forEach((button) => {
  button.addEventListener("click", () => $("#approval-dialog").close());
});
document.querySelectorAll("[data-close-user-edit]").forEach((button) => {
  button.addEventListener("click", () => $("#user-edit-dialog").close());
});
$("#secret-dialog").addEventListener("close", () => {
  $("#secret-value").textContent = "";
  $("#secret-description").textContent = "";
  $("#copy-secret").textContent = "复制";
});

void boot();
