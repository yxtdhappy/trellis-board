const POLL_INTERVAL_MS = 5000;

const state = {
  plugins: [],
  disabled: false,
  loading: false,
  timer: null,
  activeId: null
};

let board = null;
let messageEl = null;
let logsDialog = null;
let logsPre = null;
let logsTitle = null;

function statusText(plugin) {
  if (plugin.status === "error" && plugin.lastError) return "错误";
  const map = {
    running: "运行中",
    starting: "启动中",
    stopped: "已停止",
    error: "错误",
    disabled: "已禁用",
    crashing: "反复崩溃"
  };
  return map[plugin.status] ?? plugin.status ?? "未知";
}

function statusClass(plugin) {
  if (plugin.status === "error" || plugin.status === "crashing") return "danger";
  if (plugin.status === "running") return "ok";
  if (plugin.status === "starting") return "warn";
  return "muted";
}

function showMessage(text, tone = "") {
  if (!messageEl) return;
  messageEl.textContent = text || "";
  messageEl.hidden = !text;
  messageEl.dataset.tone = tone;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { accept: "application/json", ...(options.body ? { "content-type": "application/json" } : {}) },
    ...options
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!response.ok) {
    throw new Error(payload?.error || `请求失败（${response.status}）`);
  }
  return payload;
}

function badge(text, tone = "") {
  const span = document.createElement("span");
  span.className = `plugin-badge${tone ? ` is-${tone}` : ""}`;
  span.textContent = text;
  return span;
}

function actionButton(label, onClick, { secondary = true, disabled = false } = {}) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = secondary ? "secondary-button small-button" : "primary-button small-button";
  button.textContent = label;
  button.disabled = disabled;
  button.addEventListener("click", onClick);
  return button;
}

function renderCard(plugin) {
  const card = document.createElement("article");
  card.className = "plugin-card";
  card.dataset.pluginId = plugin.id;

  const head = document.createElement("div");
  head.className = "plugin-card-head";
  const title = document.createElement("div");
  const name = document.createElement("h3");
  name.textContent = plugin.name || plugin.id;
  const id = document.createElement("p");
  id.className = "plugin-id";
  id.textContent = plugin.id;
  title.append(name, id);
  head.append(title, badge(statusText(plugin), statusClass(plugin)));
  card.append(head);

  const meta = document.createElement("div");
  meta.className = "plugin-meta";
  meta.append(badge(`v${plugin.version ?? "?"}`));
  meta.append(badge(`api ${plugin.apiVersion ?? "?"}`, "muted"));
  if (!plugin.compatible) meta.append(badge(plugin.reason || "不兼容", "danger"));
  if (plugin.pid) meta.append(badge(`pid ${plugin.pid}`, "muted"));
  if (plugin.restarts) meta.append(badge(`重启 ${plugin.restarts}`, "warn"));
  card.append(meta);

  if (plugin.rootPaths?.length) {
    const paths = document.createElement("p");
    paths.className = "plugin-paths";
    paths.textContent = `启动后占用：${plugin.rootPaths.join("，")}`;
    card.append(paths);
  }
  if (plugin.lastError) {
    const error = document.createElement("p");
    error.className = "plugin-error";
    error.textContent = plugin.lastError;
    card.append(error);
  }

  const actions = document.createElement("div");
  actions.className = "plugin-actions";
  const running = plugin.status === "running" || plugin.status === "starting";
  actions.append(
    actionButton(running ? "停止" : "启动", () => toggle(plugin, running), {
      disabled: state.loading || !plugin.compatible
    })
  );
  actions.append(
    actionButton("日志", () => openLogs(plugin))
  );
  card.append(actions);
  return card;
}

function render() {
  if (!board) return;
  board.textContent = "";
  if (state.disabled) {
    const notice = document.createElement("div");
    notice.className = "plugin-notice";
    notice.textContent = "插件机制已被 TRELLIS_PLUGINS_DISABLED=1 关闭。";
    board.append(notice);
    return;
  }
  if (!state.plugins.length) {
    const empty = document.createElement("div");
    empty.className = "plugin-notice";
    empty.textContent = "还没有加载任何插件。把插件目录放到 plugins/<id>/ 并写入 data/plugins.json 后刷新。";
    board.append(empty);
    return;
  }
  for (const plugin of state.plugins) board.append(renderCard(plugin));
}

async function load({ quiet = false } = {}) {
  if (!board) return;
  try {
    if (!quiet) showMessage("");
    const data = await api("/api/plugins");
    state.plugins = Array.isArray(data?.plugins) ? data.plugins : [];
    state.disabled = Boolean(data?.disabled);
    render();
  } catch (error) {
    showMessage(error.message, "danger");
  }
}

async function toggle(plugin, running) {
  state.loading = true;
  render();
  try {
    await api(`/api/plugins/${encodeURIComponent(plugin.id)}/${running ? "stop" : "start"}`, {
      method: "POST"
    });
    await load({ quiet: true });
    showMessage(running ? `已停止 ${plugin.id}` : `已启动 ${plugin.id}`, "ok");
  } catch (error) {
    showMessage(error.message, "danger");
  } finally {
    state.loading = false;
    render();
  }
}

async function openLogs(plugin) {
  if (!logsDialog) return;
  state.activeId = plugin.id;
  if (logsTitle) logsTitle.textContent = `${plugin.name || plugin.id} 日志`;
  if (logsPre) logsPre.textContent = "加载中…";
  if (!logsDialog.open) logsDialog.showModal();
  try {
    const data = await api(`/api/plugins/${encodeURIComponent(plugin.id)}/logs?tail=200`);
    const entries = Array.isArray(data?.entries) ? data.entries : [];
    if (logsPre) {
      logsPre.textContent = entries.length
        ? entries.map((entry) => {
            const time = entry.at ? new Date(entry.at).toLocaleTimeString() : "";
            const level = String(entry.level || "info").toUpperCase().padEnd(5);
            return `${time} ${level} ${entry.message || ""}${entry.fields && Object.keys(entry.fields).length ? ` ${JSON.stringify(entry.fields)}` : ""}`;
          }).join("\n")
        : "暂无日志";
    }
  } catch (error) {
    if (logsPre) logsPre.textContent = `读取日志失败：${error.message}`;
  }
}

export function stopPluginsPolling() {
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
}

export async function renderPlugins() {
  board ??= document.querySelector("#plugins-board");
  messageEl ??= document.querySelector("#plugins-message");
  if (!board) return;
  await load();
  if (!state.timer) {
    state.timer = setInterval(() => {
      const view = document.querySelector("#plugins-view");
      if (!view?.classList.contains("is-visible")) {
        stopPluginsPolling();
        return;
      }
      load({ quiet: true });
    }, POLL_INTERVAL_MS);
  }
}

function bindDialog() {
  logsDialog = document.querySelector("#plugin-logs-dialog");
  logsPre = document.querySelector("#plugin-logs");
  logsTitle = document.querySelector("#plugin-logs-title");
  if (!logsDialog) return;
  logsDialog.querySelectorAll("[data-close-plugin-logs]").forEach((button) => {
    button.addEventListener("click", () => logsDialog.close());
  });
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bindDialog, { once: true });
  } else {
    bindDialog();
  }
}
