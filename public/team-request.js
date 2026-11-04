export class ApiError extends Error {
  constructor(message, {
    status = 0,
    code = null,
    details = null,
    recoverable = false,
    payload = null
  } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.recoverable = recoverable;
    this.payload = payload;
  }
}

async function responsePayload(response) {
  if (response.status === 204 || response.status === 304) return null;
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("json")) {
    const text = await response.text();
    return text ? { error: text.slice(0, 500) } : null;
  }
  return response.json().catch(() => null);
}

export async function requestJson(url, {
  method = "GET",
  body,
  headers = {}
} = {}) {
  const verb = String(method || "GET").toUpperCase();
  const write = !["GET", "HEAD"].includes(verb);
  const requestHeaders = new Headers(headers);
  if (write) requestHeaders.set("content-type", "application/json");
  let response;
  try {
    response = await fetch(url, {
      method: verb,
      headers: requestHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
      cache: "no-store"
    });
  } catch {
    throw new ApiError("无法连接团队服务，请检查网络或服务状态");
  }

  const payload = await responsePayload(response);
  if (!response.ok) {
    throw new ApiError(
      payload?.error || `请求失败 (${response.status})`,
      {
        status: response.status,
        code: payload?.code || null,
        details: payload?.details || null,
        recoverable: Boolean(payload?.recoverable),
        payload
      }
    );
  }
  return {
    data: payload,
    status: response.status,
    etag: response.headers.get("etag")
  };
}

export function redirectToLogin() {
  const returnTo = `${window.location.pathname}${window.location.search}`;
  const target = `/login.html?returnTo=${encodeURIComponent(returnTo)}`;
  if (window.location.pathname !== "/login.html") window.location.assign(target);
}
