const form = document.getElementById("login-form");
const serverUrlInput = document.getElementById("server-url");
const usernameInput = document.getElementById("username");
const passwordInput = document.getElementById("password");
const submitButton = document.getElementById("submit");
const statusElement = document.getElementById("status");
const errorElement = document.getElementById("error");
const versionElement = document.getElementById("version");
const configPathElement = document.getElementById("config-path");

const invoke = window.__TAURI__?.core?.invoke;
let submitting = false;

function setStatus(text) {
  statusElement.textContent = text;
}

function clearError() {
  errorElement.textContent = "";
  errorElement.hidden = true;
}

function showError(error) {
  const message = error instanceof Error ? error.message : String(error || "登录失败");
  errorElement.textContent = message.replace(/^Error:\s*/i, "");
  errorElement.hidden = false;
}

function setSubmitting(value) {
  submitting = value;
  submitButton.disabled = value;
  submitButton.textContent = value ? "正在登录…" : "登录";
  for (const input of form.elements) {
    if (input instanceof HTMLInputElement) input.disabled = value;
  }
}

function validateInput() {
  const serverUrl = serverUrlInput.value.trim();
  const username = usernameInput.value.trim();
  const password = passwordInput.value;
  if (!serverUrl) return "请填写服务器地址。";
  try {
    const parsed = new URL(serverUrl);
    if (!["http:", "https:"].includes(parsed.protocol)) return "服务器地址必须使用 HTTP 或 HTTPS。";
  } catch {
    return "服务器地址格式无效。";
  }
  if (username.length < 3) return "请填写有效的登录名。";
  if (password.length < 6) return "密码至少需要 6 个字符。";
  return null;
}

async function readStatus() {
  if (!invoke) {
    setSubmitting(true);
    setStatus("请在 Trellis Board 桌面客户端中打开此页面。");
    showError("未能连接桌面客户端进程。");
    return;
  }
  try {
    const app = await invoke("app_status");
    versionElement.textContent = `v${app.version}`;
    configPathElement.textContent = app.configPath ? `配置：${app.configPath}` : "";
    if (app.serverUrl) serverUrlInput.value = app.serverUrl;
    setStatus("请输入账号密码登录。");
    (serverUrlInput.value ? usernameInput : serverUrlInput).focus();
  } catch (error) {
    setStatus("无法读取本地配置。");
    showError(error);
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (submitting || !invoke) return;
  clearError();
  const validationError = validateInput();
  if (validationError) {
    showError(validationError);
    return;
  }
  setSubmitting(true);
  setStatus("正在验证账号并建立设备会话…");
  try {
    await invoke("desktop_login", {
      serverUrl: serverUrlInput.value.trim(),
      username: usernameInput.value.trim(),
      password: passwordInput.value,
    });
    passwordInput.value = "";
    setStatus("登录成功，正在打开 Board…");
  } catch (error) {
    passwordInput.value = "";
    setSubmitting(false);
    setStatus("登录失败。");
    showError(error);
    passwordInput.focus();
  }
});

readStatus();
