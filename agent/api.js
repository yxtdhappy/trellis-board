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

  async streamEvents(input = {}, options = {}) {
    if (!this.credential || this.credential.length < 32) {
      throw new AgentError(
        AGENT_ERROR_CODE.CREDENTIAL_MISSING,
        "Agent 凭证不存在，请重新配对",
      );
    }
    const teamId = String(input.teamId || "").trim();
    if (!teamId) {
      throw new AgentError(AGENT_ERROR_CODE.COMMAND_INVALID, "事件流缺少团队 ID");
    }
    const url = new URL(`${this.serverUrl}/api/agent/events`);
    url.searchParams.set("teamId", teamId);
    const headers = {
      accept: "text/event-stream",
      "cache-control": "no-cache",
      "user-agent": `trellis-board-agent/${AGENT_VERSION}`,
      authorization: `Bearer ${this.credential}`,
    };
    if (input.lastEventId != null) {
      headers["last-event-id"] = String(input.lastEventId);
    }
    const transport = url.protocol === "https:" ? https : http;
    const idleTimeoutMs = options.idleTimeoutMs ?? 60_000;
    return new Promise((resolve, reject) => {
      let settled = false;
      let idleTimer;
      let buffer = "";
      const decoder = new TextDecoder();
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(idleTimer);
        options.signal?.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else resolve(value);
      };
      const fail = (error) => {
        request.destroy();
        finish(error);
      };
      const resetIdle = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          fail(new AgentError(
            AGENT_ERROR_CODE.NETWORK_ERROR,
            "事件流长时间无数据，准备重连",
            { retryable: true },
          ));
        }, idleTimeoutMs);
        idleTimer.unref?.();
      };
      const dispatch = async (block) => {
        let id = null;
        let event = "message";
        let retry = null;
        const dataLines = [];
        for (const line of block.split("\n")) {
          if (!line || line.startsWith(":")) continue;
          const colon = line.indexOf(":");
          const field = colon === -1 ? line : line.slice(0, colon);
          let value = colon === -1 ? "" : line.slice(colon + 1);
          if (value.startsWith(" ")) value = value.slice(1);
          if (field === "id") id = value;
          else if (field === "event") event = value || "message";
          else if (field === "retry") retry = Number(value);
          else if (field === "data") dataLines.push(value);
        }
        if (!dataLines.length) return;
        const raw = dataLines.join("\n");
        let data = raw;
        try {
          data = JSON.parse(raw);
        } catch {
          // 保留原始数据，交给调用方记录。
        }
        await options.onEvent?.({
          id: id == null ? null : id,
          type: event,
          data,
          retryMs: Number.isFinite(retry) && retry >= 0 ? retry : null,
        });
      };
      const request = transport.request(url, {
        method: "GET",
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
      if (options.signal?.aborted) onAbort();
      resetIdle();
      request.on("response", (response) => {
        if (response.statusCode !== 200) {
          const chunks = [];
          let size = 0;
          response.on("data", (chunk) => {
            size += chunk.length;
            if (size <= 64 * 1024) chunks.push(chunk);
          });
          response.on("end", () => {
            let body = null;
            try {
              body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            } catch {
              body = null;
            }
            finish(mapServerError(
              response.statusCode,
              body,
              true,
              parseRetryAfter(response.headers["retry-after"]),
            ));
          });
          return;
        }
        const contentType = String(response.headers["content-type"] || "");
        if (!contentType.includes("text/event-stream")) {
          fail(new AgentError(
            AGENT_ERROR_CODE.INVALID_RESPONSE,
            "事件流响应类型无效",
          ));
          return;
        }
        options.onOpen?.({ status: response.statusCode, headers: response.headers });
        response.on("data", (chunk) => {
          resetIdle();
          buffer += decoder.decode(chunk, { stream: true });
          let boundary = buffer.indexOf("\n\n");
          while (boundary !== -1) {
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            dispatch(block).catch((error) => {
              fail(error instanceof AgentError
                ? error
                : new AgentError(AGENT_ERROR_CODE.NETWORK_ERROR, safeErrorMessage(error)));
            });
            boundary = buffer.indexOf("\n\n");
          }
        });
        response.on("end", () => finish(null, { reason: "closed" }));
        response.on("error", (error) => finish(mapNetworkError(error)));
      });
      request.on("error", (error) => {
        finish(error?.name === "AbortError"
          ? mapNetworkError(error)
          : mapNetworkError(error));
      });
      request.end();
    });
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
