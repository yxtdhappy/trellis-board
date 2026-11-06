import path from "node:path";

export const AGENT_PROTOCOL_VERSION = 2;
export const AGENT_VERSION = "0.1.0";

export const COMMAND_TYPE = Object.freeze({
  SYNC_BRANCH: "sync_branch",
  REFRESH_STATUS: "refresh_status",
});

export const COMMAND_TYPES = new Set(Object.values(COMMAND_TYPE));

export const COMMAND_RESULT_STATUS = Object.freeze({
  SUCCEEDED: "succeeded",
  FAILED: "failed",
});

export const AGENT_ERROR_CODE = Object.freeze({
  AUTH_REVOKED: "AUTH_REVOKED",
  PROTOCOL_INCOMPATIBLE: "PROTOCOL_INCOMPATIBLE",
  AGENT_OUTDATED: "AGENT_OUTDATED",
  NETWORK_ERROR: "NETWORK_ERROR",
  HTTP_ERROR: "HTTP_ERROR",
  INVALID_RESPONSE: "INVALID_RESPONSE",
  CONFIG_MISSING: "CONFIG_MISSING",
  CONFIG_INVALID: "CONFIG_INVALID",
  CREDENTIAL_MISSING: "CREDENTIAL_MISSING",
  CREDENTIAL_CORRUPT: "CREDENTIAL_CORRUPT",
  DPAPI_UNAVAILABLE: "DPAPI_UNAVAILABLE",
  DPAPI_FAILED: "DPAPI_FAILED",
  LOCKED: "LOCKED",
  CA_FILE_INVALID: "CA_FILE_INVALID",
  REPO_NOT_FOUND: "REPO_NOT_FOUND",
  REPO_PATH_INVALID: "REPO_PATH_INVALID",
  NOT_GIT_REPOSITORY: "NOT_GIT_REPOSITORY",
  MISSING_TRELLIS: "MISSING_TRELLIS",
  SPARSE_CHECKOUT: "SPARSE_CHECKOUT",
  REMOTE_MISSING: "REMOTE_MISSING",
  REMOTE_INVALID: "REMOTE_INVALID",
  REMOTE_MISMATCH: "REMOTE_MISMATCH",
  BRANCH_INVALID: "BRANCH_INVALID",
  BRANCH_MISMATCH: "BRANCH_MISMATCH",
  DETACHED_HEAD: "DETACHED_HEAD",
  LOCAL_DIRTY: "LOCAL_DIRTY",
  LOCAL_AHEAD: "LOCAL_AHEAD",
  NO_FAST_FORWARD: "NO_FAST_FORWARD",
  REMOTE_UNREACHABLE: "REMOTE_UNREACHABLE",
  FETCH_FAILED: "FETCH_FAILED",
  MERGE_FAILED: "MERGE_FAILED",
  IGNORED_FILE_CONFLICT: "IGNORED_FILE_CONFLICT",
  GIT_TIMEOUT: "GIT_TIMEOUT",
  GIT_FAILED: "GIT_FAILED",
  COMMAND_INVALID: "COMMAND_INVALID",
  BINDING_UNKNOWN: "BINDING_UNKNOWN",
  BINDING_NOT_APPROVED: "BINDING_NOT_APPROVED",
});

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const RESERVED_BRANCH_NAMES = new Set([
  "HEAD",
  "FETCH_HEAD",
  "ORIG_HEAD",
  "MERGE_HEAD",
  "@",
]);

export class AgentError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "AgentError";
    this.code = code;
    this.retryable = options.retryable === true;
    this.terminal = options.terminal === true;
  }
}

export class AgentApiError extends AgentError {
  constructor(code, message, options = {}) {
    super(code, message, options);
    this.name = "AgentApiError";
    this.status = options.status ?? null;
    this.serverCode = options.serverCode ?? null;
    this.retryAfterMs = options.retryAfterMs ?? null;
  }
}

export function isLoopbackHostname(hostname) {
  const value = String(hostname || "").toLowerCase();
  return value === "localhost" || value === "127.0.0.1" || value === "::1" ||
    value === "[::1]";
}

export function normalizeServerUrl(input) {
  let url;
  try {
    url = new URL(String(input || "").trim());
  } catch {
    throw new AgentError(AGENT_ERROR_CODE.CONFIG_INVALID, "Agent 服务地址不是合法 URL");
  }

  if (url.username || url.password || url.search || url.hash) {
    throw new AgentError(AGENT_ERROR_CODE.CONFIG_INVALID, "Agent 服务地址不能包含账号、查询或片段");
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new AgentError(AGENT_ERROR_CODE.CONFIG_INVALID, "Agent 服务地址必须使用根路径");
  }
  if (url.protocol !== "https:" &&
      !(url.protocol === "http:" && isLoopbackHostname(url.hostname))) {
    throw new AgentError(AGENT_ERROR_CODE.CONFIG_INVALID, "Agent 服务必须使用 HTTPS；仅回环测试允许 HTTP");
  }
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    throw new AgentError(AGENT_ERROR_CODE.CONFIG_INVALID, "禁止关闭 Node TLS 证书校验");
  }
  return `${url.protocol}//${url.host}`;
}

export function assertSafeId(value, fieldName = "ID", code = AGENT_ERROR_CODE.INVALID_RESPONSE) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new AgentError(code, `${fieldName} 格式无效`);
  }
  return value;
}

export function validateBranchNameSyntax(value) {
  const branch = String(value || "");
  if (
    branch.length === 0 ||
    branch.length > 255 ||
    branch.startsWith("-") ||
    branch.startsWith("refs/") ||
    RESERVED_BRANCH_NAMES.has(branch) ||
    /[\u0000-\u0020\u007f~^:?*[\\]/.test(branch) ||
    branch.includes("..") ||
    branch.includes("@{" ) ||
    branch.startsWith("/") ||
    branch.endsWith("/") ||
    branch.endsWith(".") ||
    branch.endsWith(".lock") ||
    branch.includes("//")
  ) {
    throw new AgentError(
      AGENT_ERROR_CODE.BRANCH_INVALID,
      "同步分支格式无效",
    );
  }
  return branch;
}

export function validatePairingCode(value) {
  if (
    typeof value !== "string" ||
    value.length < 16 ||
    value.length > 512 ||
    !/^[A-Za-z0-9._~+/-]+={0,2}$/.test(value)
  ) {
    throw new AgentError(
      AGENT_ERROR_CODE.CONFIG_INVALID,
      "配对码格式无效",
    );
  }
  return value;
}

export function compareVersions(left, right) {
  const a = SEMVER.exec(String(left || ""));
  const b = SEMVER.exec(String(right || ""));
  if (!a || !b) {
    return null;
  }
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(a[index]) - Number(b[index]);
    if (difference !== 0) {
      return difference < 0 ? -1 : 1;
    }
  }
  return 0;
}

export function parseEnrollResponse(payload) {
  if (!payload || typeof payload !== "object") {
    throw new AgentError(AGENT_ERROR_CODE.INVALID_RESPONSE, "配对响应不是对象");
  }
  const body = payload.data && typeof payload.data === "object"
    ? { ...payload, ...payload.data }
    : payload;
  const agentId = assertSafeId(body.agentId ?? body.deviceId, "设备 ID");
  const credential = body.credential ?? body.agentCredential;
  if (typeof credential !== "string" || credential.length < 32 || /\s/.test(credential)) {
    throw new AgentError(AGENT_ERROR_CODE.INVALID_RESPONSE, "配对响应缺少有效 Agent 凭证");
  }
  const username = body.username == null ? null : String(body.username).trim();
  if (username !== null && !/^[A-Za-z0-9._-]{3,64}$/.test(username)) {
    throw new AgentError(AGENT_ERROR_CODE.INVALID_RESPONSE, "配对响应包含无效用户名");
  }
  const teamId = body.teamId == null ? null : assertSafeId(body.teamId, "团队 ID");
  return {
    agentId,
    credential,
    protocolVersion: body.protocolVersion ?? AGENT_PROTOCOL_VERSION,
    username: username || null,
    teamId,
  };
}

function normalizeServerBinding(value) {
  if (!value || typeof value !== "object") {
    throw new AgentError(AGENT_ERROR_CODE.INVALID_RESPONSE, "心跳响应包含无效绑定");
  }
  const id = assertSafeId(value.id ?? value.bindingId, "绑定 ID");
  const projectId = assertSafeId(value.projectId, "项目 ID");
  const localRepoKey = String(value.localRepoKey || "");
  if (!/^[a-f0-9]{64}$/.test(localRepoKey)) {
    throw new AgentError(AGENT_ERROR_CODE.INVALID_RESPONSE, "心跳响应包含无效本地仓库标识");
  }
  const allowedStatuses = new Set(["pending", "approved", "rejected", "revoked"]);
  const status = String(value.status || "pending");
  if (!allowedStatuses.has(status)) {
    throw new AgentError(AGENT_ERROR_CODE.INVALID_RESPONSE, "心跳响应包含未知绑定状态");
  }
  return {
    id,
    projectId,
    teamId: value.teamId == null ? null : assertSafeId(value.teamId, "团队 ID"),
    localRepoKey,
    status,
    branchName: typeof value.branchName === "string" ? value.branchName : null,
    errorCode: typeof value.errorCode === "string" ? value.errorCode : null,
    error: typeof value.error === "string" ? value.error.slice(0, 500) : null,
  };
}

export function parseHeartbeatResponse(payload) {
  if (!payload || typeof payload !== "object") {
    throw new AgentError(AGENT_ERROR_CODE.INVALID_RESPONSE, "心跳响应不是对象");
  }
  const body = payload.data && typeof payload.data === "object"
    ? { ...payload, ...payload.data }
    : payload;
  const protocolVersion = Number(
    body.protocolVersion ?? body.serverProtocolVersion ?? body.device?.protocolVersion,
  );
  if (!Number.isInteger(protocolVersion) || protocolVersion < 1) {
    throw new AgentError(AGENT_ERROR_CODE.INVALID_RESPONSE, "心跳响应缺少协议版本");
  }
  const rawBindings = body.bindings ?? [];
  if (!Array.isArray(rawBindings)) {
    throw new AgentError(AGENT_ERROR_CODE.INVALID_RESPONSE, "心跳响应绑定列表无效");
  }
  return {
    protocolVersion,
    compatible:
      body.compatible !== false &&
      body.protocolVersionCompatible !== false &&
      protocolVersion === AGENT_PROTOCOL_VERSION,
    minimumAgentVersion:
      typeof (body.minimumAgentVersion ?? body.minimumVersion) === "string"
        ? body.minimumAgentVersion ?? body.minimumVersion
        : null,
    bindings: rawBindings.map(normalizeServerBinding),
  };
}

export function validateCommand(value) {
  if (!value || typeof value !== "object") {
    throw new AgentError(AGENT_ERROR_CODE.COMMAND_INVALID, "服务端返回了无效命令");
  }
  const id = assertSafeId(value.id, "命令 ID", AGENT_ERROR_CODE.COMMAND_INVALID);
  const bindingId = assertSafeId(
    value.bindingId,
    "绑定 ID",
    AGENT_ERROR_CODE.COMMAND_INVALID,
  );
  const type = String(value.type || "");
  if (!COMMAND_TYPES.has(type)) {
    throw new AgentError(AGENT_ERROR_CODE.COMMAND_INVALID, "服务端返回了未授权命令类型");
  }
  const payload = value.payload ?? {};
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new AgentError(AGENT_ERROR_CODE.COMMAND_INVALID, "命令载荷格式无效");
  }
  const allowedKeys = new Set(["projectId", "branchName", "protocolVersion", "reason"]);
  for (const key of Object.keys(payload)) {
    if (!allowedKeys.has(key)) {
      throw new AgentError(AGENT_ERROR_CODE.COMMAND_INVALID, "命令载荷包含未允许字段");
    }
  }
  if (payload.projectId != null) {
    assertSafeId(payload.projectId, "项目 ID", AGENT_ERROR_CODE.COMMAND_INVALID);
  }
  if (payload.branchName != null && typeof payload.branchName !== "string") {
    throw new AgentError(AGENT_ERROR_CODE.COMMAND_INVALID, "命令分支格式无效");
  }
  if (
    payload.protocolVersion != null &&
    (!Number.isInteger(payload.protocolVersion) ||
      payload.protocolVersion !== AGENT_PROTOCOL_VERSION)
  ) {
    throw new AgentError(AGENT_ERROR_CODE.COMMAND_INVALID, "命令协议版本格式无效");
  }
  if (
    payload.reason != null &&
    (typeof payload.reason !== "string" || payload.reason.length > 100)
  ) {
    throw new AgentError(AGENT_ERROR_CODE.COMMAND_INVALID, "命令原因格式无效");
  }
  return { id, bindingId, type, payload };
}

export function buildCommandResult(status, result = null, error = null) {
  if (!Object.values(COMMAND_RESULT_STATUS).includes(status)) {
    throw new AgentError(AGENT_ERROR_CODE.COMMAND_INVALID, "命令结果状态无效");
  }
  return {
    protocolVersion: AGENT_PROTOCOL_VERSION,
    agentVersion: AGENT_VERSION,
    status,
    result,
    error: error
      ? `${typeof error.code === "string" ? error.code : AGENT_ERROR_CODE.GIT_FAILED}: ${
        safeErrorMessage(error)
      }`
      : null,
  };
}

export function safeErrorMessage(error) {
  if (!error) {
    return "未知错误";
  }
  const fallback = "Agent 操作失败";
  const message = typeof error.message === "string" ? error.message : fallback;
  return message
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/((?:https?|ssh):\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, "$1[REDACTED]@")
    .replace(
      /\b(password|pairingCode|credential|token)\b(\s*[=:]\s*|"\s*:\s*")[^\s,;"'}]+/gi,
      "$1=[REDACTED]",
    )
    .replace(/\b[A-Za-z]:[\\/][^\s"'<>|]+/g, "[本地路径]")
    .replace(/\\\\[^\\\s]+\\[^\s"'<>|]+/g, "[本地路径]")
    .slice(0, 500);
}

export function isAuthenticationError(error) {
  return error instanceof AgentError &&
    (error.code === AGENT_ERROR_CODE.AUTH_REVOKED ||
      (error instanceof AgentApiError && (error.status === 401 || error.status === 403)));
}

export function isPathInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
