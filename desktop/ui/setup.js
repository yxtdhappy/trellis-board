const statusElement = document.getElementById("status");
const setupPanel = document.getElementById("setup-panel");
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
const versionElement = document.getElementById("version");
const configPathElement = document.getElementById("config-path");

const invoke = window.__TAURI__?.core?.invoke;
const listen = window.__TAURI__?.event?.listen;

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

function defaultDeviceName() {
  return "Windows 桌面";
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
      setStatus("已注册，正在打开 Board…");
      window.location.replace(status.serverUrl);
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
    setStatus("注册成功，正在打开 Board…");
    window.location.replace(result.serverUrl);
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
    setStatus("注册成功，正在打开 Board…");
    window.location.replace(result.serverUrl);
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

readStatus();
