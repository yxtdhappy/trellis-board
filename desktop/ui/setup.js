const statusElement = document.getElementById("status");
const setupPanel = document.getElementById("setup-panel");
const workspacePanel = document.getElementById("workspace-panel");
const loadingPanel = document.getElementById("loading-panel");
const errorElement = document.getElementById("error");
const form = document.getElementById("setup-form");
const submitButton = document.getElementById("submit");
const openLoginButton = document.getElementById("open-login");
const serverUrlInput = document.getElementById("server-url");
const deviceNameInput = document.getElementById("device-name");
const enrollTokenInput = document.getElementById("enroll-token");
const pairingForm = document.getElementById("pairing-form");
const pairingSubmitButton = document.getElementById("pairing-submit");
const pairingCodeInput = document.getElementById("pairing-code");
const workspacePathInput = document.getElementById("workspace-path");
const pickWorkspaceButton = document.getElementById("pick-workspace");
const initWorkspaceButton = document.getElementById("init-workspace");
const openBoardButton = document.getElementById("open-board");
const workspaceResult = document.getElementById("workspace-result");
const workspaceError = document.getElementById("workspace-error");
const versionElement = document.getElementById("version");
const configPathElement = document.getElementById("config-path");

const invoke = window.__TAURI__?.core?.invoke;
const listen = window.__TAURI__?.event?.listen;
const WORKSPACE_TOOLS = [".opencode", ".agents"];
let boardServerUrl = null;

function setStatus(text) {
  statusElement.textContent = text;
}

function showError(message) {
  errorElement.textContent = message;
  errorElement.hidden = false;
}

function clearError() {
  errorElement.textContent = "";
  errorElement.hidden = true;
}

function showWorkspaceError(message) {
  workspaceError.textContent = message;
  workspaceError.hidden = false;
}

function clearWorkspaceError() {
  workspaceError.textContent = "";
  workspaceError.hidden = true;
}

function showWorkspaceResult(message) {
  workspaceResult.textContent = message;
  workspaceResult.hidden = false;
}

function defaultDeviceName() {
  return "Windows 桌面";
}

function showWorkspacePanel(serverUrl) {
  boardServerUrl = serverUrl || boardServerUrl;
  loadingPanel.hidden = true;
  setupPanel.hidden = true;
  workspacePanel.hidden = false;
  openBoardButton.hidden = !boardServerUrl;
  setStatus("请选择 workspace 并完成初始化。");
}

function resetButtons() {
  submitButton.disabled = false;
  submitButton.textContent = "用设备令牌注册并打开看板";
  pairingSubmitButton.disabled = false;
  pairingSubmitButton.textContent = "使用配对码注册";
}

async function readStatus() {
  if (!invoke) {
    loadingPanel.hidden = true;
    setupPanel.hidden = false;
    submitButton.disabled = true;
    setStatus("请在桌面客户端内打开此页面。");
    showError("未能连接到桌面客户端进程。");
    return;
  }
  try {
    const status = await invoke("app_status");
    versionElement.textContent = `v${status.version}`;
    configPathElement.textContent = `配置：${status.configPath}`;
    if (status.serverUrl) {
      showWorkspacePanel(status.serverUrl);
      return;
    }
    loadingPanel.hidden = true;
    setupPanel.hidden = false;
    deviceNameInput.value = deviceNameInput.value || defaultDeviceName();
    setStatus("尚未注册为桌面设备。");
  } catch (error) {
    loadingPanel.hidden = true;
    setStatus("无法读取本地配置。");
    showError(String(error));
  }
}

function readServerUrl() {
  const serverUrl = serverUrlInput.value.trim();
  if (!serverUrl) {
    showError("请先填写服务端地址。");
    return null;
  }
  return serverUrl;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!invoke) return;
  clearError();
  const serverUrl = readServerUrl();
  const deviceName = deviceNameInput.value.trim();
  const token = enrollTokenInput.value.trim();
  if (!serverUrl) return;
  if (!deviceName || token.length < 32) {
    showError("请完整填写设备名称和一次性设备令牌。");
    return;
  }
  submitButton.disabled = true;
  submitButton.textContent = "正在注册…";
  try {
    const result = await invoke("enroll_with_token", {
      serverUrl,
      deviceName,
      token,
    });
    enrollTokenInput.value = "";
    showWorkspacePanel(result.serverUrl);
    setStatus("注册成功，请选择 workspace 并完成初始化。");
  } catch (error) {
    showError(String(error));
    setStatus("设备注册失败。");
    resetButtons();
  }
});

openLoginButton.addEventListener("click", async () => {
  if (!invoke) return;
  clearError();
  const serverUrl = readServerUrl();
  if (!serverUrl) return;
  try {
    await invoke("open_board_login", { serverUrl });
    setStatus("已在浏览器打开 Board；登录并生成设备令牌后回到这里粘贴。");
  } catch (error) {
    showError(String(error));
  }
});

pairingForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!invoke) return;
  clearError();
  const serverUrl = readServerUrl();
  const deviceName = deviceNameInput.value.trim();
  const pairingCode = pairingCodeInput.value.trim();
  if (!serverUrl) return;
  if (!deviceName || pairingCode.length < 16) {
    showError("请完整填写设备名称和配对码。");
    return;
  }
  pairingSubmitButton.disabled = true;
  pairingSubmitButton.textContent = "正在注册…";
  try {
    const result = await invoke("enroll_device", {
      serverUrl,
      deviceName,
      pairingCode,
    });
    pairingCodeInput.value = "";
    showWorkspacePanel(result.serverUrl);
  } catch (error) {
    showError(String(error));
    setStatus("设备注册失败。");
    resetButtons();
  }
});

if (listen) {
  listen("enroll-token", (event) => {
    const token = typeof event.payload === "string" ? event.payload : "";
    if (token) {
      setupPanel.hidden = false;
      loadingPanel.hidden = true;
      enrollTokenInput.value = token;
      setStatus("已从浏览器收到设备令牌，确认设备名称后注册。");
    }
  }).catch(() => {});
  listen("enroll-complete", () => {
    setStatus("注册成功，正在打开 Board…");
    void readStatus();
  }).catch(() => {});
  listen("enroll-failed", (event) => {
    showError(String(event.payload || "设备注册失败。"));
    setStatus("设备注册失败。");
    resetButtons();
  }).catch(() => {});
}

pickWorkspaceButton.addEventListener("click", async () => {
  if (!invoke) return;
  clearWorkspaceError();
  pickWorkspaceButton.disabled = true;
  try {
    const selected = await invoke("pick_workspace");
    if (selected) {
      workspacePathInput.value = selected;
      showWorkspaceResult("已选择目录，点击“初始化/修复”写入 Trellis 工作区。");
    }
  } catch (error) {
    showWorkspaceError(String(error));
  } finally {
    pickWorkspaceButton.disabled = false;
  }
});

initWorkspaceButton.addEventListener("click", async () => {
  if (!invoke) return;
  clearWorkspaceError();
  const path = workspacePathInput.value.trim();
  if (!path) {
    showWorkspaceError("请先选择或填写 workspace 目录。");
    return;
  }
  initWorkspaceButton.disabled = true;
  initWorkspaceButton.textContent = "正在初始化…";
  try {
    const result = await invoke("init_workspace", {
      path,
      tools: WORKSPACE_TOOLS,
    });
    const created = result.createdFiles?.length ?? 0;
    const skipped = result.skippedFiles?.length ?? 0;
    showWorkspaceResult(
      `初始化完成：developer=${result.developer}，模板=${result.templateVersion}` +
        `（${result.source || "unknown"}），创建 ${created}，跳过 ${skipped}。`,
    );
    setStatus("workspace 已初始化，可以打开看板。");
  } catch (error) {
    showWorkspaceError(String(error));
  } finally {
    initWorkspaceButton.disabled = false;
    initWorkspaceButton.textContent = "初始化/修复";
  }
});

openBoardButton.addEventListener("click", () => {
  if (boardServerUrl) {
    window.location.replace(boardServerUrl);
  }
});

readStatus();
