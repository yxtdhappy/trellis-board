/**
 * 宿主↔插件的帧协议与错误码。
 *
 * 传输是 newline-delimited JSON（JSONL）：一行一个完整 JSON-RPC 2.0 消息，
 * 行内不允许出现换行。协议层不暴露任何运行环境概念（信号、shell、路径分隔符），
 * 这些差异由宿主封装点吸收。
 */

export const HOST_API_VERSION = 1;
export const MAX_FRAME_BYTES = 1024 * 1024;
export const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

export const ERROR_CODES = Object.freeze({
  PERMISSION_DENIED: 1001,
  NOT_FOUND: 1002,
  TIMEOUT: 1003,
  TASK_REJECTED: 1004,
  RATE_LIMITED: 1005,
  API_VERSION_MISMATCH: 1006,
  DISABLED: 1007,
  VERSION_MISMATCH: 1008,
  CAPABILITY_UNAVAILABLE: 1009,
  CAPABILITY_METHOD_DENIED: 1010
});

export const RPC = Object.freeze({
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  REQUEST_CANCELLED: -32800
});

export const HOST_TO_PLUGIN_TIMEOUTS = Object.freeze({
  initialize: 10_000,
  "plugin/configure": 10_000,
  "http/request": 30_000,
  "event/dispatch": 10_000,
  "timer/fire": 10_000,
  "plugin/status": 5_000,
  "capability/call": 30_000,
  shutdown: 5_000
});

export const PLUGIN_TO_HOST_TIMEOUTS = Object.freeze({
  "task/get": 10_000,
  "task/list": 10_000,
  "task/create": 120_000,
  "task/assign": 30_000,
  "task/setStage": 10_000,
  "event/emit": 5_000,
  "event/publish": 5_000,
  "store/get": 5_000,
  "store/set": 5_000,
  "store/delete": 5_000,
  "store/list": 5_000,
  "log/write": 5_000,
  "schedule/register": 5_000,
  "schedule/unregister": 5_000,
  "capability/call": 30_000
});

export const HOST_REQUEST_METHODS = Object.freeze(
  Object.keys(HOST_TO_PLUGIN_TIMEOUTS)
);
export const PLUGIN_REQUEST_METHODS = Object.freeze(
  Object.keys(PLUGIN_TO_HOST_TIMEOUTS)
);

export const PERMISSION_BY_METHOD = Object.freeze({
  "task/get": "tasks:read",
  "task/list": "tasks:read",
  "task/create": "tasks:write",
  "task/assign": "tasks:write",
  "task/setStage": "tasks:write",
  "event/emit": "events:emit",
  "event/publish": "events:publish",
  "store/get": "store",
  "store/set": "store",
  "store/delete": "store",
  "store/list": "store",
  "schedule/register": "schedule",
  "schedule/unregister": "schedule",
  "run/start": "runs:write",
  "run/progress": "runs:write",
  "run/finish": "runs:write",
  "run/list": "runs:read",
  "capability/call": "capabilities:call"
});

export const ALWAYS_ALLOWED_METHODS = Object.freeze(["log/write"]);

export const TODO_STATUSES = Object.freeze(["queued", "starting", "running"]);

export class RpcError extends Error {
  constructor(code, message, { rpcCode = RPC.INTERNAL_ERROR, data } = {}) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.rpcCode = rpcCode;
    this.data = data;
  }

  toJSON() {
    return {
      code: this.rpcCode,
      message: this.message,
      data: { code: this.code, ...(this.data ? { detail: this.data } : {}) }
    };
  }
}

export function appError(code, message, detail) {
  return new RpcError(code, message, {
    rpcCode: code === ERROR_CODES.METHOD_NOT_FOUND ? RPC.METHOD_NOT_FOUND : RPC.INTERNAL_ERROR,
    data: detail
  });
}

export function methodNotFound(method) {
  return new RpcError(RPC.METHOD_NOT_FOUND, `未知方法: ${method}`, {
    rpcCode: RPC.METHOD_NOT_FOUND
  });
}

export function invalidParams(message) {
  return new RpcError(RPC.INVALID_PARAMS, message, { rpcCode: RPC.INVALID_PARAMS });
}

export function encodeFrame(message) {
  const line = JSON.stringify(message);
  if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES) {
    throw new RpcError(
      ERROR_CODES.RATE_LIMITED,
      `协议帧超过 ${MAX_FRAME_BYTES} 字节`,
      { rpcCode: RPC.INVALID_REQUEST }
    );
  }
  return `${line}\n`;
}

/**
 * 增量帧解码器。缓冲区只保留未完成的一行；超限帧整体丢弃并上报。
 */
export function createFrameDecoder({
  maxBytes = MAX_FRAME_BYTES,
  onMessage,
  onError = () => {}
} = {}) {
  let buffer = "";
  let dropped = 0;

  function push(chunk) {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
      if (!line.trim()) continue;
      if (Buffer.byteLength(line, "utf8") > maxBytes) {
        dropped += 1;
        onError(new RpcError(ERROR_CODES.RATE_LIMITED, "协议帧超过上限", {
          rpcCode: RPC.INVALID_REQUEST
        }));
        continue;
      }
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        dropped += 1;
        onError(new RpcError(RPC.PARSE_ERROR, "协议帧不是合法 JSON", {
          rpcCode: RPC.PARSE_ERROR
        }));
        continue;
      }
      onMessage(message);
    }
    if (Buffer.byteLength(buffer, "utf8") > maxBytes) {
      buffer = "";
      dropped += 1;
      onError(new RpcError(ERROR_CODES.RATE_LIMITED, "协议帧超过上限", {
        rpcCode: RPC.INVALID_REQUEST
      }));
    }
  }

  return {
    push,
    reset() {
      buffer = "";
    },
    get pending() {
      return buffer;
    },
    get dropped() {
      return dropped;
    }
  };
}

export function isRequest(message) {
  return Boolean(
    message &&
    typeof message === "object" &&
    message.jsonrpc === "2.0" &&
    typeof message.method === "string" &&
    message.id !== undefined &&
    message.id !== null
  );
}

export function isNotification(message) {
  return Boolean(
    message &&
    typeof message === "object" &&
    message.jsonrpc === "2.0" &&
    typeof message.method === "string" &&
    (message.id === undefined || message.id === null)
  );
}

export function isResponse(message) {
  return Boolean(
    message &&
    typeof message === "object" &&
    message.jsonrpc === "2.0" &&
    (Object.hasOwn(message, "result") || Object.hasOwn(message, "error")) &&
    message.id !== undefined
  );
}

export function successResponse(id, result) {
  return { jsonrpc: "2.0", id, result };
}

export function errorResponse(id, error) {
  if (error instanceof RpcError) {
    return { jsonrpc: "2.0", id, error: error.toJSON() };
  }
  const message = error instanceof Error ? error.message : String(error);
  const code = Number.isInteger(error?.code) && error.code < 0
    ? error.code
    : RPC.INTERNAL_ERROR;
  const data = Number.isInteger(error?.code) && error.code > 0
    ? { code: error.code }
    : undefined;
  return {
    jsonrpc: "2.0",
    id,
    error: data ? { code, message, data } : { code, message }
  };
}

export function requestFrame(id, method, params) {
  return { jsonrpc: "2.0", id, method, params };
}

export function notificationFrame(method, params) {
  return { jsonrpc: "2.0", method, params };
}

/**
 * 给任意 Promise 挂超时。超时不自动杀进程（是否终止由调用方决定）。
 */
export function withTimeout(promise, timeoutMs, message = "请求超时") {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new RpcError(ERROR_CODES.TIMEOUT, message));
      }, timeoutMs);
      timer.unref?.();
    })
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
