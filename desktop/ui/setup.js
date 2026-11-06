const statusElement = document.getElementById("status");
const setupPanel = document.getElementById("setup-panel");
const loadingPanel = document.getElementById("loading-panel");
const errorElement = document.getElementById("error");
const form = document.getElementById("setup-form");
const submitButton = document.getElementById("submit");
const serverUrlInput = document.getElementById("server-url");
const deviceNameInput = document.getElementById("device-name");
const pairingCodeInput = document.getElementById("pairing-code");
const versionElement = document.getElementById("version");
const configPathElement = document.getElementById("config-path");

const invoke = window.__TAURI__?.core?.invoke;

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
    deviceNameInput.value = defaultDeviceName();
    setStatus("尚未注册为桌面设备。");
  } catch (error) {
    loadingPanel.hidden = true;
    setStatus("无法读取本地配置。");
    showError(String(error));
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!invoke) return;
  clearError();
  const serverUrl = serverUrlInput.value.trim();
  const deviceName = deviceNameInput.value.trim();
  const pairingCode = pairingCodeInput.value.trim();
  if (!serverUrl || !deviceName || pairingCode.length < 16) {
    showError("请完整填写服务端地址、设备名称和配对码。");
    return;
  }
  submitButton.disabled = true;
  submitButton.textContent = "正在注册…";
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
    submitButton.disabled = false;
    submitButton.textContent = "注册并打开看板";
  }
});

readStatus();
