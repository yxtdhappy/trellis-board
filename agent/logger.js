import fsp from "node:fs/promises";
import path from "node:path";
import { safeErrorMessage } from "./protocol.js";

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_FILES = 5;
const WRITE_BUFFER_MAX = 64 * 1024;

export function redactLogText(value) {
  return String(value ?? "")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/((?:https?|ssh):\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, "$1[REDACTED]@")
    .replace(/\b(password|pairingCode|credential|token)\s*[=:]\s*[^\s,;"']+/gi, "$1=[REDACTED]")
    .replace(/[A-Za-z]:[\\/][^\s"'<>|]+/g, "[本地路径]")
    .replace(/\\\\[^\\\s]+\\[^\s"'<>|]+/g, "[本地路径]");
}

function formatDetail(detail) {
  if (detail == null) {
    return "";
  }
  let text;
  if (detail instanceof Error) {
    text = `${detail.name || "Error"}:${detail.code || ""}:${safeErrorMessage(detail)}`;
  } else if (typeof detail === "string") {
    text = detail;
  } else {
    try {
      text = JSON.stringify(detail);
    } catch {
      text = String(detail);
    }
  }
  return redactLogText(text).replace(/[\r\n]+/g, " ");
}

export class AgentLogger {
  constructor(options = {}) {
    this.logsDir = options.logsDir;
    this.logFile = options.logFile || path.join(options.logsDir, "agent.log");
    this.stdout = options.stdout || process.stdout;
    this.stderr = options.stderr || process.stderr;
    this.maxBytes = options.maxBytes || DEFAULT_MAX_BYTES;
    this.maxFiles = options.maxFiles || DEFAULT_MAX_FILES;
    this.pending = Promise.resolve();
    this.buffer = "";
    this.timer = null;
    this.closed = false;
  }

  info(message, detail = null) {
    this._write("INFO", message, detail);
  }

  warn(message, detail = null) {
    this._write("WARN", message, detail);
  }

  error(message, detail = null) {
    this._write("ERROR", message, detail);
  }

  _write(level, message, detail) {
    if (this.closed) {
      return;
    }
    const suffix = formatDetail(detail);
    const line = `${new Date().toISOString()} ${level} ${redactLogText(message)}${suffix ? ` ${suffix}` : ""}\n`;
    this.buffer += line;
    validateConsoleWrite(this.stderr, line);
    if (Buffer.byteLength(this.buffer, "utf8") >= WRITE_BUFFER_MAX) {
      this.flush();
      return;
    }
    this.timer ||= setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 500);
    this.timer.unref?.();
  }

  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.buffer) {
      return this.pending;
    }
    const content = this.buffer;
    this.buffer = "";
    this.pending = this.pending
      .then(() => this._append(content))
      .catch((error) => {
        validateConsoleWrite(this.stderr, `日志写入失败：${formatDetail(error)}\n`);
      });
    return this.pending;
  }

  async _append(content) {
    await fsp.mkdir(this.logsDir, { recursive: true, mode: 0o700 });
    await this._rotateIfNeeded(Buffer.byteLength(content, "utf8"));
    await fsp.appendFile(this.logFile, content, { encoding: "utf8", mode: 0o600 });
  }

  async _rotateIfNeeded(incomingBytes) {
    let size = 0;
    try {
      size = (await fsp.stat(this.logFile)).size;
    } catch (error) {
      if (error.code === "ENOENT") {
        return;
      }
      throw error;
    }
    if (size + incomingBytes <= this.maxBytes) {
      return;
    }
    for (let index = this.maxFiles - 1; index >= 1; index -= 1) {
      const source = index === 1 ? this.logFile : `${this.logFile}.${index - 1}`;
      const destination = `${this.logFile}.${index}`;
      try {
        await fsp.rename(source, destination);
      } catch (error) {
        if (error.code !== "ENOENT") {
          throw error;
        }
      }
    }
  }

  async close() {
    if (this.closed) {
      return this.flush();
    }
    this.flush();
    await this.pending;
    this.closed = true;
  }
}

function validateConsoleWrite(stream, text) {
  try {
    stream.write(text);
  } catch {
    // 控制台不可用时仍保留文件日志。
  }
}

export function createFileOnlyLogger(options) {
  return new AgentLogger({
    ...options,
    stdout: { write() {} },
    stderr: { write() {} },
  });
}

export function logFileContract(root) {
  return path.join(root, "logs", "agent.log");
}
