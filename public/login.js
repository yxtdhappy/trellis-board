import { setMessage } from "./dom.js";
import { requestJson } from "./team-request.js";
import { normalizeRuntime, normalizeUser, safeReturnTo } from "./team-client.js";

const form = document.querySelector("#login-form");
const username = document.querySelector("#login-username");
const password = document.querySelector("#login-password");
const submit = document.querySelector("#login-submit");
const message = document.querySelector("#login-message");
const returnTo = safeReturnTo(new URLSearchParams(window.location.search).get("returnTo"));

function destination(user) {
  return user?.mustChangePassword ? "/" : returnTo;
}

async function boot() {
  try {
    const result = await requestJson("/api/runtime");
    const runtime = normalizeRuntime(result.data);
    if (!runtime.team) {
      window.location.replace("/");
      return;
    }
    if (runtime.authenticated && runtime.user) {
      window.location.replace(destination(runtime.user));
      return;
    }
    submit.disabled = false;
    submit.textContent = "登录";
    setMessage(message, "");
    username.focus();
  } catch (error) {
    if (error.status === 404) {
      window.location.replace("/");
      return;
    }
    setMessage(message, `无法读取登录状态：${error.message}`, true);
    submit.disabled = false;
    submit.textContent = "重试登录";
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  submit.disabled = true;
  submit.textContent = "正在登录…";
  setMessage(message, "");
  try {
    const result = await requestJson("/api/auth/login", {
      method: "POST",
      body: {
        username: username.value.trim(),
        password: password.value
      }
    });
    password.value = "";
    const user = normalizeUser(result.data?.user || result.data);
    window.location.replace(destination(user));
  } catch (error) {
    password.value = "";
    setMessage(message, error.message, true);
    submit.disabled = false;
    submit.textContent = "登录";
    password.focus();
  }
});

void boot();
