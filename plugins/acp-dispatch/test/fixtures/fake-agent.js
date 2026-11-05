#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

/**
 * 测试用 ACP agent。行为由环境变量控制：
 * - FAKE_ACP_TRACE: 逐行记录收到的消息
 * - FAKE_ACP_KIND: tool_call 的 kind（默认 edit）
 * - FAKE_ACP_STOP: stopReason（默认 end_turn）
 * - FAKE_ACP_HANG: 收到 prompt 后不返回，等待 session/cancel
 * - FAKE_ACP_EXIT_ON_PROMPT: 收到 prompt 立即退出
 * - FAKE_ACP_REJECT_ONLY: 权限选项里只给 reject_*
 * - FAKE_ACP_SESSION_CLOSE: 是否声明 sessionCapabilities.close（默认 true）
 * - FAKE_ACP_LOAD_SESSION: 是否声明 loadSession 能力（默认 false）
 * - FAKE_ACP_SILENT: 收到 prompt 后既不回 update 也不结束（用于 idle 超时）
 */

const traceFile = process.env.FAKE_ACP_TRACE || "";
const kind = process.env.FAKE_ACP_KIND || "edit";
const stopReason = process.env.FAKE_ACP_STOP || "end_turn";
const hang = process.env.FAKE_ACP_HANG === "1";
const exitOnPrompt = process.env.FAKE_ACP_EXIT_ON_PROMPT === "1";
const rejectOnly = process.env.FAKE_ACP_REJECT_ONLY === "1";
const supportsClose = process.env.FAKE_ACP_SESSION_CLOSE !== "0";
const supportsLoad = process.env.FAKE_ACP_LOAD_SESSION === "1";
const silent = process.env.FAKE_ACP_SILENT === "1";
const writeFile = process.env.FAKE_ACP_WRITE_FILE || "";
const writeContent = process.env.FAKE_ACP_WRITE_CONTENT || "";

function trace(entry) {
  if (!traceFile) return;
  fs.appendFileSync(traceFile, `${JSON.stringify(entry)}\n`);
}

function send(message) {
  trace({ dir: "out", message });
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function respondError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

let sessionId = "sess-1";
let promptId = null;
let permissionId = 9000;

const options = rejectOnly
  ? [
      { optionId: "opt-reject", name: "Reject", kind: "reject_once" },
      { optionId: "opt-reject-always", name: "Reject always", kind: "reject_always" }
    ]
  : [
      { optionId: "opt-allow", name: "Allow", kind: "allow_once" },
      { optionId: "opt-always", name: "Allow always", kind: "allow_always" },
      { optionId: "opt-reject", name: "Reject", kind: "reject_once" }
    ];

function finishPrompt(reason = stopReason) {
  if (promptId === null) return;
  const id = promptId;
  promptId = null;
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "完成" } }
    }
  });
  respond(id, { stopReason: reason });
}

function handleRequest(message) {
  switch (message.method) {
    case "initialize":
      respond(message.id, {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: supportsLoad,
          sessionCapabilities: supportsClose ? { close: {} } : {}
        }
      });
      return;
    case "session/new":
      respond(message.id, { sessionId });
      return;
    case "session/load":
      sessionId = message.params?.sessionId || sessionId;
      respond(message.id, { sessionId });
      return;
    case "session/prompt": {
      if (exitOnPrompt) {
        process.exit(2);
      }
      promptId = message.id;
      if (writeFile) {
        fs.mkdirSync(path.dirname(writeFile), { recursive: true });
        fs.writeFileSync(writeFile, writeContent);
      }
      if (silent) return;
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: { sessionUpdate: "tool_call", toolCallId: "call-1", kind, title: "编辑文件" }
        }
      });
      send({
        jsonrpc: "2.0",
        method: "session/request_permission",
        id: permissionId,
        params: { sessionId, toolCall: { toolCallId: "call-1" }, options }
      });
      return;
    }
    case "session/cancel":
      finishPrompt("cancelled");
      return;
    case "session/close":
      respond(message.id, {});
      return;
    default:
      respondError(message.id, -32601, `不支持的方法: ${message.method}`);
  }
}

function handleResponse(message) {
  if (message.id !== permissionId) return;
  trace({ dir: "decision", result: message.result ?? null, error: message.error ?? null });
  if (hang) return;
  finishPrompt();
}

const reader = readline.createInterface({ input: process.stdin });
reader.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  trace({ dir: "in", message });
  if (message.method) handleRequest(message);
  else handleResponse(message);
});

reader.on("close", () => process.exit(0));
