import { spawn } from "node:child_process";

/**
 * 最小 ACP client：JSON-RPC 2.0 按行分隔（ndjson）走子进程 stdio。
 *
 * 只实现 board 需要的部分：initialize / session/new / session/prompt /
 * session/cancel / session/close，以及 session/update 与
 * session/request_permission 两个反向消息。
 */
export class AcpError extends Error {
  constructor(message, { code = null, data = null } = {}) {
    super(message);
    this.name = "AcpError";
    this.code = code;
    this.data = data;
  }
}

function toLines(onLine) {
  let buffer = "";
  return (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) onLine(line);
      index = buffer.indexOf("\n");
    }
  };
}

export class AcpClient {
  constructor({
    command,
    args = [],
    cwd = process.cwd(),
    env = {},
    permission = {},
    log = () => {},
    spawnImpl = spawn,
    runTimeoutMs = 30 * 60_000,
    controlTimeoutMs = 30_000,
    permissionTimeoutMs = 120_000,
    idleTimeoutMs = 10 * 60_000,
    idleGraceMs = 5_000,
    onUpdate = null
  } = {}) {
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.env = env;
    this.permission = {
      default: permission.default ?? "allow",
      byKind: permission.byKind ?? {}
    };
    this.log = log;
    this.spawnImpl = spawnImpl;
    this.runTimeoutMs = runTimeoutMs;
    this.controlTimeoutMs = controlTimeoutMs;
    this.permissionTimeoutMs = permissionTimeoutMs;
    this.onUpdate = typeof onUpdate === "function" ? onUpdate : null;
    this.sequence = 0;
    this.pending = new Map();
    this.toolKinds = new Map();
    this.pendingPermissions = new Set();
    this.child = null;
    this.closed = false;
    this.decisions = [];
    this.agentCapabilities = {};
    this.idleTimeoutMs = idleTimeoutMs;
    this.idleGraceMs = idleGraceMs;
    this.idleTimedOut = false;
    this.lastActivityAt = 0;
    this.idleTimer = null;
  }

  start() {
    if (this.child) return this;
    this.child = this.spawnImpl(this.command, this.args, {
      cwd: this.cwd,
      env: { ...process.env, ...this.env },
      stdio: ["pipe", "pipe", "pipe"],
      shell: false
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", toLines((line) => this.handleLine(line)));
    this.child.stderr.on("data", (chunk) => {
      const text = String(chunk).trim();
      if (text) this.log("debug", "agent stderr", { text: text.slice(0, 2000) });
    });
    this.child.on("error", (error) => this.failAll(new AcpError(`ACP agent 启动失败: ${error.message}`)));
    this.child.on("close", (code, signal) => {
      this.closed = true;
      this.failAll(new AcpError(`ACP agent 已退出（code=${code} signal=${signal ?? ""}）`));
    });
    return this;
  }

  handleLine(line) {
    this.lastActivityAt = Date.now();
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.log("warn", "收到非 JSON 行", { line: line.slice(0, 200) });
      return;
    }
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new AcpError(message.error.message || "ACP 调用失败", {
          code: message.error.code ?? null,
          data: message.error.data ?? null
        }));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.id !== undefined && message.method) {
      this.handleAgentRequest(message);
      return;
    }
    if (message.method) this.handleNotification(message);
  }

  handleNotification(message) {
    if (message.method === "session/update") {
      const update = message.params?.update ?? {};
      const toolCallId = update.toolCallId;
      if (toolCallId && update.kind) this.toolKinds.set(toolCallId, update.kind);
      this.log("debug", "session/update", {
        sessionUpdate: update.sessionUpdate ?? null,
        toolCallId: toolCallId ?? null,
        kind: update.kind ?? null
      });
      try {
        this.onUpdate?.(update);
      } catch (error) {
        this.log("warn", "处理 session/update 失败", { message: error.message });
      }
      return;
    }
    this.log("debug", "未知 ACP 通知", { method: message.method });
  }

  handleAgentRequest(message) {
    if (message.method !== "session/request_permission") {
      this.write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `不支持的方法: ${message.method}` } });
      return;
    }
    const decision = this.decidePermission(message.params ?? {});
    this.decisions.push(decision);
    this.log("info", "权限决策", decision);
    if (decision.cancelled) {
      this.write({
        jsonrpc: "2.0",
        id: message.id,
        result: { outcome: { outcome: "cancelled" } }
      });
      return;
    }
    this.write({
      jsonrpc: "2.0",
      id: message.id,
      result: { outcome: { outcome: "selected", optionId: decision.optionId } }
    });
  }

  decidePermission(params) {
    const toolCall = params.toolCall ?? {};
    const toolCallId = toolCall.toolCallId ?? null;
    const kind = toolCall.kind || this.toolKinds.get(toolCallId) || "other";
    const policy = this.permission.byKind?.[kind] ?? this.permission.default ?? "allow";
    const options = Array.isArray(params.options) ? params.options : [];
    const preferred = policy === "allow" ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
    const option = preferred
      .map((optionKind) => options.find((candidate) => candidate.kind === optionKind))
      .find(Boolean);
    if (!option) {
      return {
        cancelled: true,
        reason: "permission-unavailable",
        toolCallId,
        kind,
        policy,
        available: options.map((candidate) => candidate.kind)
      };
    }
    return { cancelled: false, optionId: option.optionId, optionKind: option.kind, toolCallId, kind, policy };
  }

  write(message) {
    if (!this.child?.stdin?.writable) return false;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
    return true;
  }

  notify(method, params) {
    return this.write({ jsonrpc: "2.0", method, params });
  }

  request(method, params, { timeoutMs } = {}) {
    if (this.closed) return Promise.reject(new AcpError("ACP agent 已退出"));
    const id = ++this.sequence;
    const budget = timeoutMs ?? this.controlTimeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AcpError(`ACP 调用超时: ${method}`));
      }, budget);
      this.pending.set(id, { resolve, reject, timer, method });
      if (!this.write({ jsonrpc: "2.0", id, method, params })) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new AcpError("ACP agent 输入不可写"));
      }
    });
  }

  async initialize({ protocolVersion = 1, clientCapabilities = {} } = {}) {
    const result = await this.request("initialize", {
      protocolVersion,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        ...clientCapabilities
      }
    });
    this.agentCapabilities = result?.agentCapabilities ?? {};
    return result;
  }

  supportsLoadSession() {
    return Boolean(this.agentCapabilities?.loadSession);
  }

  async loadSession({ sessionId, cwd, mcpServers = [] } = {}) {
    const result = await this.request("session/load", {
      sessionId,
      cwd: cwd ?? this.cwd,
      mcpServers
    });
    this.sessionId = result?.sessionId ?? sessionId;
    return result;
  }

  armIdleWatch() {
    this.disarmIdleWatch();
    this.lastActivityAt = Date.now();
    const interval = Math.max(200, Math.min(10_000, Math.floor(this.idleTimeoutMs / 10)));
    this.idleTimer = setInterval(() => {
      if (this.closed || !this.sessionId) return;
      if (Date.now() - this.lastActivityAt < this.idleTimeoutMs) return;
      this.idleTimedOut = true;
      this.log("warn", "ACP 会话 idle 超时，先 cancel 再终止", {
        idleTimeoutMs: this.idleTimeoutMs,
        graceMs: this.idleGraceMs
      });
      this.cancel();
      const child = this.child;
      setTimeout(() => {
        if (child && !this.closed) child.kill("SIGTERM");
      }, this.idleGraceMs).unref?.();
      this.disarmIdleWatch();
    }, interval);
    this.idleTimer.unref?.();
  }

  disarmIdleWatch() {
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = null;
  }

  async newSession({ cwd, mcpServers = [] } = {}) {
    const result = await this.request("session/new", { cwd: cwd ?? this.cwd, mcpServers });
    if (!result?.sessionId) throw new AcpError("session/new 未返回 sessionId");
    this.sessionId = result.sessionId;
    return result;
  }

  async prompt(text, { timeoutMs } = {}) {
    this.armIdleWatch();
    try {
      return await this.request(
        "session/prompt",
        { sessionId: this.sessionId, prompt: [{ type: "text", text: String(text) }] },
        { timeoutMs: timeoutMs ?? this.runTimeoutMs }
      );
    } finally {
      this.disarmIdleWatch();
    }
  }

  cancel() {
    if (!this.sessionId) return false;
    this.notify("session/cancel", { sessionId: this.sessionId });
    return true;
  }

  cancelPendingPermissions() {
    const count = this.pendingPermissions.size;
    this.pendingPermissions.clear();
    return count;
  }

  async close({ graceMs = 2_000 } = {}) {
    if (!this.child) return;
    try {
      if (this.agentCapabilities?.sessionCapabilities?.close) {
        await this.request("session/close", { sessionId: this.sessionId }, { timeoutMs: 3_000 }).catch(() => {});
      }
    } finally {
      this.child.stdin?.end();
      const child = this.child;
      const exited = new Promise((resolve) => {
        if (this.closed) resolve(true);
        else child.once("close", () => resolve(true));
      });
      const timer = setTimeout(() => {
        if (!this.closed) child.kill("SIGKILL");
      }, graceMs);
      await exited;
      clearTimeout(timer);
    }
  }

  failAll(error) {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export function buildAgentEnvironment(base = {}, extra = {}) {
  return { ...base, ...extra };
}
