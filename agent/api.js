import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import {
  AgentApiError,
  AgentError,
  AGENT_ERROR_CODE,
  AGENT_PROTOCOL_VERSION,
  AGENT_VERSION,
  normalizeServerUrl,
  parseCommandsResponse,
  parseEnrollResponse,
  parseHeartbeatResponse,
  safeErrorMessage,
} from "./protocol.js";

const MAX_RESPONSE_BYTES = 1024 * 1024;

export async function loadCaFile(caFile) {
  if (caFile == null) {
    return null;
  }
  if (!path.isAbsolute(caFile)) {
    throw new AgentError(AGENT_ERROR_CODE.CA_FILE_INVALID, "CA 文件必须使用绝对路径");
  }
  let content;
  try {
    content = await fs.readFile(caFile, "utf8");
  } catch (error) {
    throw new AgentError(AGENT_ERROR_CODE.CA_FILE_INVALID, "无法读取 CA 文件", {
      cause: error,
    });
  }
  if (!content.includes("-----BEGIN CERTIFICATE-----")) {
    throw new AgentError(AGENT_ERROR_CODE.CA_FILE_INVALID, "CA 文件不包含 PEM 证书");
  }
  return content;
}

function parseRetryAfter(value) {
  if (typeof value !== "string") {
    return null;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, 300_000);
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, Math.min(date - Date.now(), 300_000)) : null;
}

function mapServerError(status, body, auth, retryAfterMs) {
  const serverCode = typeof body?.code === "string" ? body.code : null;
  const message = typeof body?.error === "string"
    ? body.error.slice(0, 500)
    : `Agent 服务返回 HTTP ${status}`;
  if (auth && (status === 401 || status === 403)) {
    return new AgentApiError(
      AGENT_ERROR_CODE.AUTH_REVOKED,
      "Agent 凭证已撤销或账号已禁用，请重新配对",
      { status, serverCode, terminal: true, retryAfterMs },
    );
  }
  if (status === 426 || serverCode === "AGENT_PROTOCOL_UNSUPPORTED") {
    return new AgentApiError(
      AGENT_ERROR_CODE.PROTOCOL_INCOMPATIBLE,
      message || "Agent 协议版本不兼容",
      { status, serverCode, terminal: true, retryAfterMs },
    );
  }
  const retryable = status === 408 || status === 425 || status === 429 || status >= 500;
  return new AgentApiError(AGENT_ERROR_CODE.HTTP_ERROR, message, {
    status,
    serverCode,
    retryable,
    retryAfterMs,
  });
}

function mapNetworkError(error) {
  if (error instanceof AgentError) {
    return error;
  }
  if (error?.name === "AbortError") {
    return new AgentError(AGENT_ERROR_CODE.NETWORK_ERROR, "Agent 请求已取消", {
      cause: error,
    });
  }
  const detail = safeErrorMessage(error);
  return new AgentError(
    AGENT_ERROR_CODE.NETWORK_ERROR,
    `无法连接 Agent 服务：${detail}`,
    { cause: error, retryable: true },
  );
}

export class AgentApiClient {
  constructor(options = {}) {
    this.serverUrl = normalizeServerUrl(options.serverUrl);
    this.credential = options.credential || null;
    this.ca = options.ca || null;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxResponseBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  }

  setCredential(credential) {
    this.credential = credential || null;
  }

  async enroll(input) {
    const payload = await this._requestJson("/api/agent/enroll", {
      method: "POST",
      auth: false,
      body: {
        protocolVersion: AGENT_PROTOCOL_VERSION,
        agentVersion: AGENT_VERSION,
        platform: "win32",
        ...input,
      },
    });
    return parseEnrollResponse(payload);
  }

  async heartbeat(input, options = {}) {
    const payload = await this._requestJson("/api/agent/heartbeat", {
      method: "POST",
      auth: true,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      body: {
        protocolVersion: AGENT_PROTOCOL_VERSION,
        agentVersion: AGENT_VERSION,
        platform: "win32",
        ...input,
      },
    });
    return parseHeartbeatResponse(payload);
  }

  async pollCommands(input = {}, options = {}) {
    const payload = await this._requestJson("/api/agent/commands", {
      method: "POST",
      auth: true,
      timeoutMs: options.timeoutMs ?? Math.max(this.timeoutMs, 50_000),
      signal: options.signal,
      body: {
        protocolVersion: AGENT_PROTOCOL_VERSION,
        agentVersion: AGENT_VERSION,
        waitMs: 25_000,
        ...input,
      },
    });
    return parseCommandsResponse(payload);
  }

  async submitCommandResult(commandId, result, options = {}) {
    const encodedId = encodeURIComponent(commandId);
    return this._requestJson(`/api/agent/commands/${encodedId}/result`, {
      method: "POST",
      auth: true,
      signal: options.signal,
      body: result,
    });
  }

  async health(options = {}) {
    return this._requestJson("/api/health", {
      method: "GET",
      auth: false,
      timeoutMs: options.timeoutMs ?? 10_000,
      signal: options.signal,
    });
  }

  async _requestJson(apiPath, options = {}) {
    if (!apiPath.startsWith("/api/")) {
      throw new AgentError(AGENT_ERROR_CODE.HTTP_ERROR, "Agent API 路径无效");
    }
    const auth = options.auth === true;
    if (auth && (!this.credential || this.credential.length < 32)) {
      throw new AgentError(
        AGENT_ERROR_CODE.CREDENTIAL_MISSING,
        "Agent 凭证不存在，请重新配对",
      );
    }
    const url = new URL(this.serverUrl + apiPath);
    const body = options.body == null ? null : Buffer.from(JSON.stringify(options.body), "utf8");
    const headers = {
      accept: "application/json",
      "user-agent": `trellis-board-agent/${AGENT_VERSION}`,
    };
    if (body) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(body.length);
    }
    if (auth) {
      headers.authorization = `Bearer ${this.credential}`;
    }

    const transport = url.protocol === "https:" ? https : http;
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer;
      const finish = (error, value) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        if (error) {
          reject(error);
        } else {
          resolve(value);
        }
      };

      const request = transport.request(url, {
        method: options.method || "GET",
        headers,
        ca: url.protocol === "https:" ? this.ca || undefined : undefined,
        rejectUnauthorized: true,
        agent: false,
      });
      const onAbort = () => {
        const error = new Error("request aborted");
        error.name = "AbortError";
        request.destroy(error);
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted) {
        onAbort();
      }

      timer = setTimeout(() => {
        const error = new Error("request timeout");
        error.name = "AbortError";
        request.destroy(error);
      }, timeoutMs);
      timer.unref?.();

      request.on("response", (response) => {
        const chunks = [];
        let byteLength = 0;
        response.on("data", (chunk) => {
          byteLength += chunk.length;
          if (byteLength > this.maxResponseBytes) {
            response.destroy();
            finish(
              new AgentError(
                AGENT_ERROR_CODE.INVALID_RESPONSE,
                "Agent 服务响应过大",
              ),
            );
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          if (settled) {
            return;
          }
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed = {};
          if (text.trim()) {
            try {
              parsed = JSON.parse(text);
            } catch {
              finish(
                new AgentError(
                  AGENT_ERROR_CODE.INVALID_RESPONSE,
                  "Agent 服务返回了无效 JSON",
                ),
              );
              return;
            }
          }
          const status = Number(response.statusCode || 0);
          if (status < 200 || status >= 300) {
            finish(
              mapServerError(
                status,
                parsed,
                auth,
                parseRetryAfter(response.headers["retry-after"]),
              ),
            );
            return;
          }
          finish(null, parsed);
        });
        response.on("error", (error) => finish(mapNetworkError(error)));
      });
      request.on("error", (error) => finish(mapNetworkError(error)));
      if (body) {
        request.write(body);
      }
      request.end();
    });
  }
}

export function credentialFingerprint(credential) {
  return crypto.createHash("sha256").update(String(credential || "")).digest("hex");
}
