import http from "node:http";
import https from "node:https";
import { AgentApiClient } from "../../agent/api.js";
import { ConfigStore, createConfigRevision } from "../../agent/config-store.js";
import {
  AgentError,
  AGENT_ERROR_CODE,
  AGENT_PROTOCOL_VERSION,
  AGENT_VERSION,
  normalizeServerUrl,
  safeErrorMessage,
  validatePairingCode,
} from "../../agent/protocol.js";

const SESSION_COOKIE = "trellis_team_session";
const MAX_RESPONSE_BYTES = 256 * 1024;
const AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,512}$/;
const ENROLL_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,512}$/;

export function validateDeviceName(value) {
  const name = String(value || "").trim();
  if (!name || Array.from(name).length > 80 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new AgentError(AGENT_ERROR_CODE.CONFIG_INVALID, "设备名格式无效");
  }
  return name;
}

export function validateSessionToken(value) {
  const token = String(value || "").trim();
  if (!SESSION_TOKEN_PATTERN.test(token)) {
    throw new AgentError(AGENT_ERROR_CODE.CONFIG_INVALID, "管理员会话 Cookie 格式无效");
  }
  return token;
}

export function validateAgentId(value) {
  const agentId = String(value || "").trim();
  if (!AGENT_ID_PATTERN.test(agentId)) {
    throw new AgentError(AGENT_ERROR_CODE.CONFIG_INVALID, "设备 ID 格式无效");
  }
  return agentId;
}

export function validateEnrollToken(value) {
  const token = String(value || "").trim();
  if (!ENROLL_TOKEN_PATTERN.test(token)) {
    throw new AgentError(AGENT_ERROR_CODE.CONFIG_INVALID, "设备令牌格式无效");
  }
  return token;
}

function mapEnrollError(error) {
  if (!(error instanceof AgentError)) return error;
  if (error.code === AGENT_ERROR_CODE.DESKTOP_TOKEN_INVALID) {
    return new AgentError(error.code, error.message, { cause: error, terminal: true });
  }
  if (error.code === AGENT_ERROR_CODE.NETWORK_ERROR) {
    return new AgentError(
      AGENT_ERROR_CODE.NETWORK_ERROR,
      "无法连接 Board 服务端，请检查网络后重试",
      { cause: error, retryable: true },
    );
  }
  return error;
}

function requireCredentialStore(store) {
  if (!store) {
    throw new AgentError(
      AGENT_ERROR_CODE.CONFIG_INVALID,
      "设备注册缺少凭证存储",
    );
  }
  return store;
}

async function completeDesktopEnrollment({
  enrolled,
  serverUrl,
  deviceName,
  store,
  credentialStore,
}) {
  if (enrolled.protocolVersion !== AGENT_PROTOCOL_VERSION) {
    throw new AgentError(
      AGENT_ERROR_CODE.PROTOCOL_INCOMPATIBLE,
      "服务端 Agent 协议版本与当前客户端不兼容",
    );
  }
  const config = {
    schemaVersion: 1,
    revision: createConfigRevision(),
    serverUrl,
    caFile: null,
    agentId: enrolled.agentId,
    deviceName,
    username: enrolled.username || null,
    teamId: enrolled.teamId || null,
    protocolVersion: AGENT_PROTOCOL_VERSION,
    agentVersion: AGENT_VERSION,
    pairedAt: new Date().toISOString(),
    bindings: [],
  };
  await store.updateConfig(async () => {
    await credentialStore.saveCredential(enrolled.credential);
    return config;
  }, { allowMissing: true });
  return {
    agentId: enrolled.agentId,
    deviceName,
    serverUrl,
    protocolVersion: enrolled.protocolVersion,
  };
}

/**
 * 桌面端默认注册路径：登录会话签发的一次性令牌换取设备凭证。
 */
export async function enrollWithToken(token, deviceInfo = {}) {
  const enrollToken = validateEnrollToken(token);
  const serverUrl = normalizeServerUrl(deviceInfo.serverUrl);
  const deviceName = validateDeviceName(deviceInfo.deviceName);
  const store = deviceInfo.store || new ConfigStore(deviceInfo.root, {
    secureDirectory: deviceInfo.secureDirectory !== false,
  });
  await store.ensureDirectories();
  if (!deviceInfo.replace) {
    const existing = await store.readConfig();
    if (existing) {
      throw new AgentError(
        AGENT_ERROR_CODE.CONFIG_INVALID,
        "当前安装已经注册设备；如需更换账号，请显式选择重新注册",
      );
    }
  }
  const credentialStore = requireCredentialStore(deviceInfo.credentialStore);
  const api = deviceInfo.apiClient || new AgentApiClient({ serverUrl });
  let enrolled;
  try {
    enrolled = await api.enrollWithToken({ token: enrollToken, deviceName });
  } catch (error) {
    throw mapEnrollError(error);
  }
  return completeDesktopEnrollment({
    enrolled,
    serverUrl,
    deviceName,
    store,
    credentialStore,
  });
}

export async function enrollDesktopDevice(options = {}) {
  const serverUrl = normalizeServerUrl(options.serverUrl);
  const pairingCode = validatePairingCode(options.pairingCode);
  const deviceName = validateDeviceName(options.deviceName);
  const store = options.store || new ConfigStore(options.root, {
    secureDirectory: options.secureDirectory !== false,
  });
  await store.ensureDirectories();
  if (!options.replace) {
    const existing = await store.readConfig();
    if (existing) {
      throw new AgentError(
        AGENT_ERROR_CODE.CONFIG_INVALID,
        "当前安装已经注册设备；如需更换账号，请显式选择重新注册",
      );
    }
  }
  const credentialStore = requireCredentialStore(options.credentialStore);
  const api = options.apiClient || new AgentApiClient({ serverUrl });
  const enrolled = await api.enroll({ pairingCode, deviceName });
  return completeDesktopEnrollment({
    enrolled,
    serverUrl,
    deviceName,
    store,
    credentialStore,
  });
}

function requestJson(url, { method, headers, body, timeoutMs = 30_000 }) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const payload = body == null ? null : Buffer.from(JSON.stringify(body), "utf8");
    const request = transport.request(
      url,
      {
        method,
        timeout: timeoutMs,
        headers: {
          accept: "application/json",
          ...(payload
            ? {
                "content-type": "application/json",
                "content-length": String(payload.length),
              }
            : {}),
          ...headers,
        },
      },
      (response) => {
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            request.destroy(new Error("设备撤销响应过大"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed = null;
          if (text) {
            try {
              parsed = JSON.parse(text);
            } catch {
              parsed = null;
            }
          }
          resolve({ status: response.statusCode, body: parsed, text });
        });
      },
    );
    request.on("timeout", () => {
      request.destroy(new Error("设备撤销请求超时"));
    });
    request.on("error", reject);
    if (payload) request.write(payload);
    request.end();
  });
}

export async function revokeDesktopDevice(options = {}) {
  const serverUrl = normalizeServerUrl(options.serverUrl);
  const agentId = validateAgentId(options.agentId);
  const sessionToken = validateSessionToken(options.sessionCookie);
  let url;
  try {
    url = new URL(`${serverUrl}/api/admin/agents/${encodeURIComponent(agentId)}/revoke`);
  } catch (error) {
    throw new AgentError(AGENT_ERROR_CODE.INVALID_RESPONSE, "服务端地址无法解析", { cause: error });
  }
  const response = await requestJson(url, {
    method: "POST",
    headers: {
      origin: serverUrl,
      cookie: `${SESSION_COOKIE}=${encodeURIComponent(sessionToken)}`,
    },
    body: {},
    timeoutMs: options.timeoutMs,
  });
  if (response.status !== 200) {
    const message = typeof response.body?.error === "string"
      ? response.body.error.slice(0, 500)
      : `设备撤销失败：HTTP ${response.status}`;
    throw new AgentError(AGENT_ERROR_CODE.HTTP_ERROR, message);
  }
  return {
    revoked: response.body?.revoked === true,
    agentId: response.body?.agentId || agentId,
  };
}

export async function readAgentIdentity(root) {
  const store = new ConfigStore(root);
  try {
    const config = await store.readConfig({ allowMissing: false });
    return { agentId: config.agentId, serverUrl: config.serverUrl };
  } catch (error) {
    throw new AgentError(
      AGENT_ERROR_CODE.CONFIG_MISSING,
      `无法读取设备配置：${safeErrorMessage(error)}`,
    );
  }
}
