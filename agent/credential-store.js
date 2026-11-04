import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentError, AGENT_ERROR_CODE } from "./protocol.js";
import { buildEnvironment, ProcessError, runProcess } from "./process.js";

const CREDENTIAL_SCHEMA_VERSION = 1;
const CREDENTIAL_ALGORITHM = "WindowsDPAPI-CurrentUser";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DPAPI_SCRIPT_FILE = path.join(HERE, "windows", "dpapi.ps1");

function fixedPowerShellPath() {
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  return path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function classifyPowerShellFailure(error) {
  const output = `${error?.stderr || ""}\n${error?.message || ""}`;
  if (/ConstrainedLanguage|System\.Security|ProtectedData|MethodInvocation|DPAPI_UNAVAILABLE/i.test(output)) {
    return new AgentError(
      AGENT_ERROR_CODE.DPAPI_UNAVAILABLE,
      "Windows DPAPI 不可用，当前 PowerShell 可能处于受限语言模式",
      { cause: error },
    );
  }
  if (error instanceof ProcessError && error.timedOut) {
    return new AgentError(AGENT_ERROR_CODE.DPAPI_FAILED, "Windows DPAPI 调用超时", { cause: error });
  }
  return new AgentError(AGENT_ERROR_CODE.DPAPI_FAILED, "Windows DPAPI 加解密失败", { cause: error });
}

export class DpapiCredentialStore {
  constructor(store, options = {}) {
    this.store = store;
    this.powerShellPath = options.powerShellPath || fixedPowerShellPath();
    this.scriptFile = options.scriptFile || DPAPI_SCRIPT_FILE;
  }

  async _execute(action, input) {
    if (process.platform !== "win32") {
      throw new AgentError(AGENT_ERROR_CODE.DPAPI_UNAVAILABLE, "Agent 凭证保护仅支持 Windows");
    }
    await this.store.ensureDirectories();

    let source;
    try {
      source = await fs.readFile(this.scriptFile, "utf8");
    } catch (error) {
      throw new AgentError(AGENT_ERROR_CODE.DPAPI_FAILED, "DPAPI helper 缺失", { cause: error });
    }
    const encodedCommand = Buffer.from(source, "utf16le").toString("base64");
    const request = JSON.stringify({
      action,
      data: input.toString("base64"),
    });

    let result;
    try {
      result = await runProcess(
        this.powerShellPath,
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          encodedCommand,
        ],
        {
          env: buildEnvironment(),
          stdin: request,
          timeoutMs: 20_000,
          maxOutputBytes: 131_072,
        },
      );
    } catch (error) {
      throw classifyPowerShellFailure(error);
    }
    if (result.exitCode !== 0) {
      throw classifyPowerShellFailure(new ProcessError("DPAPI helper failed", {
        exitCode: result.exitCode,
        stderr: result.stderr,
      }));
    }

    let parsed;
    try {
      parsed = JSON.parse(result.stdout);
    } catch (error) {
      throw new AgentError(AGENT_ERROR_CODE.DPAPI_FAILED, "DPAPI helper 返回了无效响应", {
        cause: error,
      });
    }
    if (typeof parsed?.data !== "string") {
      throw new AgentError(AGENT_ERROR_CODE.DPAPI_FAILED, "DPAPI helper 未返回密文");
    }
    try {
      return Buffer.from(parsed.data, "base64");
    } catch (error) {
      throw new AgentError(AGENT_ERROR_CODE.DPAPI_FAILED, "DPAPI helper 返回的数据已损坏", {
        cause: error,
      });
    }
  }

  async protect(value) {
    return this._execute("protect", Buffer.from(value, "utf8"));
  }

  async unprotect(ciphertext) {
    return this._execute("unprotect", ciphertext);
  }

  async saveCredential(credential) {
    if (typeof credential !== "string" || credential.length < 32 || /\s/.test(credential)) {
      throw new AgentError(AGENT_ERROR_CODE.CREDENTIAL_CORRUPT, "Agent 凭证格式无效");
    }
    const ciphertext = await this.protect(credential);
    const now = new Date().toISOString();
    await this.store.writeCredentialRecord({
      schemaVersion: CREDENTIAL_SCHEMA_VERSION,
      algorithm: CREDENTIAL_ALGORITHM,
      ciphertext: ciphertext.toString("base64"),
      createdAt: now,
      updatedAt: now,
    });
  }

  async loadCredential() {
    const record = await this.store.readCredentialRecord();
    if (record?.schemaVersion !== CREDENTIAL_SCHEMA_VERSION ||
        record?.algorithm !== CREDENTIAL_ALGORITHM ||
        typeof record?.ciphertext !== "string") {
      throw new AgentError(AGENT_ERROR_CODE.CREDENTIAL_CORRUPT, "Agent 凭证文件格式无效，请重新配对");
    }
    let ciphertext;
    try {
      ciphertext = Buffer.from(record.ciphertext, "base64");
    } catch (error) {
      throw new AgentError(AGENT_ERROR_CODE.CREDENTIAL_CORRUPT, "Agent 凭证文件已损坏，请重新配对", {
        cause: error,
      });
    }
    if (ciphertext.length < 32) {
      throw new AgentError(AGENT_ERROR_CODE.CREDENTIAL_CORRUPT, "Agent 凭证文件已损坏，请重新配对");
    }
    let plaintext;
    try {
      plaintext = await this.unprotect(ciphertext);
    } catch (error) {
      if (error instanceof AgentError && error.code === AGENT_ERROR_CODE.DPAPI_UNAVAILABLE) {
        throw error;
      }
      throw new AgentError(
        AGENT_ERROR_CODE.CREDENTIAL_CORRUPT,
        "Agent 凭证无法由当前 Windows 用户解密，请重新配对",
        { cause: error },
      );
    }
    const credential = plaintext.toString("utf8");
    if (credential.length < 32 || /\s/.test(credential)) {
      throw new AgentError(AGENT_ERROR_CODE.CREDENTIAL_CORRUPT, "Agent 凭证内容无效，请重新配对");
    }
    return credential;
  }

  async selfTest() {
    const sample = Buffer.from(`trellis-agent-dpapi-${Date.now()}`, "utf8");
    const ciphertext = await this.protect(sample);
    const plaintext = await this.unprotect(ciphertext);
    if (!plaintext.equals(sample)) {
      throw new AgentError(AGENT_ERROR_CODE.DPAPI_FAILED, "DPAPI 往返校验失败");
    }
  }
}
