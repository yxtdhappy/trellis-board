const state = {
  defaults: null,
  tasks: [],
  runs: [],
  selected: null,
  timer: null,
  init: false,
  theme: "light",
};

let seq = 0;
const pending = new Map();

function post(message) {
  window.parent.postMessage(message, "*");
}

function rpc(path, method = "GET", body) {
  const id = `r${++seq}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    post({ type: "trellis:request", id, method, path, body });
  });
}

window.addEventListener("message", (event) => {
  const message = event.data;
  if (!message || typeof message !== "object") return;
  if (message.type === "trellis:init") {
    state.theme = message.theme === "dark" ? "dark" : "light";
    document.documentElement.dataset.theme = state.theme;
    if (!state.init) {
      state.init = true;
      void boot();
    }
  }
  if (message.type === "trellis:response") {
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.ok) entry.resolve(message.data);
    else entry.reject(new Error(message.data?.error || `HTTP ${message.status}`));
  }
  if (message.type === "trellis:event") {
    const name = message.event?.name;
    if (name === "scenario-copilot/run.finished" || name === "scenario-copilot/run.started") {
      void loadRuns();
      if (state.selected) void loadRun(state.selected);
    }
  }
});

post({ type: "trellis:ready" });

const $ = (id) => document.getElementById(id);

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "className") node.className = value;
    else if (key === "textContent") node.textContent = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else node.setAttribute(key, value);
  }
  for (const child of children) node.append(child);
  return node;
}

function formatTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}

function formatDuration(ms) {
  if (!Number.isFinite(Number(ms))) return "-";
  const seconds = Math.round(Number(ms) / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function setHint(message, tone = "warn") {
  const hint = $("hint");
  hint.textContent = message || "";
  hint.style.color = tone === "muted" ? "var(--muted)" : "";
}

function statusClass(status) {
  return ["running", "succeeded", "failed"].includes(status) ? status : "";
}

async function boot() {
  try {
    const [defaults, tasks, runs] = await Promise.all([rpc("/defaults"), rpc("/tasks"), rpc("/history")]);
    state.defaults = defaults;
    state.tasks = tasks.tasks || [];
    state.runs = runs.runs || [];
    $("org").value = defaults.orgName || "";
    $("no-run").checked = !defaults.hasCredentials;
    renderOutlines(defaults.outlines || [], defaults.defaultOutline);
    renderTasks();
    renderRuns();
    setHint(defaults.hasCredentials ? "已配置测试账号，可直接执行浏览器用例" : "未配置测试账号，默认仅生成与校验", "muted");
  } catch (error) {
    setHint(error.message);
  }
}

function renderTasks() {
  const select = $("task");
  select.replaceChildren();
  if (!state.tasks.length) {
    select.append(el("option", { value: "", textContent: "（没有可用的 Trellis 任务）" }));
    return;
  }
  const preferred = state.tasks.find((task) => !task.archived) || state.tasks[0];
  for (const task of state.tasks) {
    const label = `${task.archived ? "[归档] " : ""}${task.title}`;
    const option = el("option", { value: task.taskKey, textContent: label });
    if (task.taskKey === preferred.taskKey) option.selected = true;
    select.append(option);
  }
  applyTask(preferred.taskKey);
}

function selectedTask() {
  return state.tasks.find((task) => task.taskKey === $("task").value) || null;
}

function applyTask(taskKey) {
  const task = state.tasks.find((candidate) => candidate.taskKey === taskKey);
  if (!task) return;
  $("target").value = task.binding?.targetUrl || "";
  const outline = task.binding?.outline;
  if (outline && [...$("outline").options].some((option) => option.value === outline)) {
    $("outline").value = outline;
  }
  setHint(task.binding?.targetUrl ? "使用该任务已保存的测试地址" : "该任务尚未配置测试地址，请填写后下发", "muted");
}

function renderOutlines(outlines, defaultOutline) {
  const select = $("outline");
  select.replaceChildren();
  if (!outlines.length) {
    select.append(el("option", { value: "", textContent: "（插件 outlines 目录为空）" }));
    return;
  }
  for (const outline of outlines) {
    const option = el("option", { value: outline.name, textContent: outline.title });
    if (outline.name === defaultOutline) option.selected = true;
    select.append(option);
  }
}

function renderRuns() {
  const list = $("runs");
  list.replaceChildren();
  if (!state.runs.length) {
    list.append(el("li", { className: "empty", textContent: "还没有运行记录" }));
    return;
  }
  for (const run of state.runs) {
    const item = el("li", {
      className: `run${run.id === state.selected ? " active" : ""}`,
      dataset: { id: run.id },
      tabindex: "0",
    }, [
      el("div", { className: "run-title", textContent: run.outline }),
      el("div", { className: "run-meta" }, [
        el("span", { className: `pill ${statusClass(run.status)}`, textContent: run.status }),
        el("span", { textContent: `${formatTime(run.startedAt)} · ${formatDuration(run.durationMs)}` }),
      ]),
    ]);
    item.addEventListener("click", () => selectRun(run.id));
    item.addEventListener("keydown", (event) => {
      if (event.key === "Enter") selectRun(run.id);
    });
    list.append(item);
  }
}

async function loadRuns() {
  const data = await rpc("/history");
  state.runs = data.runs || [];
  renderRuns();
}

async function selectRun(id) {
  state.selected = id;
  renderRuns();
  await loadRun(id);
  startPolling();
}

async function loadRun(id) {
  try {
    const data = await rpc(`/run?id=${encodeURIComponent(id)}`);
    const run = data.run;
    renderDetail(run);
    $("status-pill").textContent = run.status;
    $("status-pill").className = `pill ${statusClass(run.status)}`;
  } catch (error) {
    setHint(error.message);
  }
}

function renderDetail(run) {
  $("detail-title").textContent = run.outline;
  const meta = $("detail-meta");
  meta.replaceChildren();
  const rows = [
    ["任务", run.taskTitle || run.taskKey || "-"],
    ["测试版本", run.testVersion || "-"],
    ["状态", run.status],
    ["地址", run.targetUrl],
    ["开始", formatTime(run.startedAt)],
    ["耗时", formatDuration(run.durationMs)],
    ["模式", run.noRun ? "仅生成/校验" : "生成 + 执行"],
    ["脚本", run.scriptPath || "-"],
  ];
  for (const [label, value] of rows) {
    meta.append(el("div", {}, [
      el("span", { textContent: `${label}：` }),
      el("code", { textContent: String(value) }),
    ]));
  }
  if (run.error) meta.append(el("div", { textContent: `错误：${run.error}` }));
  const logs = $("logs");
  const atBottom = logs.scrollTop + logs.clientHeight >= logs.scrollHeight - 40;
  logs.textContent = run.logs || "（暂无输出）";
  if (atBottom) logs.scrollTop = logs.scrollHeight;
  $("cancel").hidden = run.status !== "running";
}

function startPolling() {
  if (state.timer) clearInterval(state.timer);
  state.timer = setInterval(async () => {
    const current = state.runs.find((run) => run.id === state.selected);
    if (!current || current.status !== "running") {
      clearInterval(state.timer);
      state.timer = null;
      await loadRuns();
      return;
    }
    await loadRun(current.id).catch(() => {});
    await loadRuns().catch(() => {});
  }, 2500);
}

$("start").addEventListener("click", async () => {
  const button = $("start");
  button.disabled = true;
  setHint("正在启动 scenario-copilot…", "muted");
  try {
    const result = await rpc("/runs", "POST", {
      taskKey: $("task").value,
      outline: $("outline").value,
      targetUrl: $("target").value,
      username: $("username").value,
      password: $("password").value,
      orgName: $("org").value,
      noRun: $("no-run").checked,
    });
    state.selected = result.run.id;
    await loadRuns();
    await loadRun(result.run.id);
    startPolling();
    setHint(result.noRun ? "已启动：仅生成与覆盖率校验" : "已启动：生成并执行浏览器用例", "muted");
  } catch (error) {
    setHint(error.message);
  } finally {
    button.disabled = false;
  }
});

$("refresh").addEventListener("click", () => {
  void loadRuns();
  if (state.selected) void loadRun(state.selected);
});

$("task").addEventListener("change", () => applyTask($("task").value));

$("cancel").addEventListener("click", async () => {
  if (!state.selected) return;
  try {
    await rpc("/cancel", "POST", { id: state.selected });
    await loadRun(state.selected);
  } catch (error) {
    setHint(error.message);
  }
});
