import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import sea from "node:sea";
import { ConfigStore } from "../../agent/config-store.js";
import { DpapiCredentialStore } from "../../agent/credential-store.js";
import { runAgentProcess } from "../../agent/index.js";
import {
  AgentError,
  AGENT_PROTOCOL_VERSION,
  AGENT_VERSION,
  safeErrorMessage,
} from "../../agent/protocol.js";
import {
  WORKSPACE_ERROR_CODE,
  WorkspaceBootstrapError,
} from "../../agent/workspace.js";
import { runWorkspaceInit } from "./workspace-init.js";
import {
  enrollDesktopDevice,
  readAgentIdentity,
  revokeDesktopDevice,
  validateAgentId,
  validateDeviceName,
} from "./desktop-device.js";

export const SIDECAR_EXIT_CODE = Object.freeze({
  OK: 0,
  USAGE: 2,
  CONFIG: 3,
  AUTH: 4,
  NETWORK: 5,
  IO: 6,
  WORKSPACE_CONFLICT: 9,
  WORKSPACE_PERMISSION: 10,
  WORKSPACE_OFFLINE: 11,
  WORKSPACE_TEMPLATE: 12,
});

const DPAPI_ASSET = "dpapi.ps1";
const DEFAULT_DPAPI_SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "agent",
  "windows",
  "dpapi.ps1",
);

function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function exitCodeFor(error) {
  if (error instanceof WorkspaceBootstrapError) {
    if (error.code === WORKSPACE_ERROR_CODE.DEVELOPER_CONFLICT) {
      return SIDECAR_EXIT_CODE.WORKSPACE_CONFLICT;
    }
    if (
      error.code === WORKSPACE_ERROR_CODE.PATH_INVALID ||
      error.code === WORKSPACE_ERROR_CODE.PATH_UNWRITABLE ||
      error.code === WORKSPACE_ERROR_CODE.USERNAME_INVALID
    ) {
      return SIDECAR_EXIT_CODE.WORKSPACE_PERMISSION;
    }
    if (error.code === WORKSPACE_ERROR_CODE.TEMPLATE_UNAVAILABLE) {
      return SIDECAR_EXIT_CODE.WORKSPACE_OFFLINE;
    }
    return SIDECAR_EXIT_CODE.WORKSPACE_TEMPLATE;
  }
  if (!(error instanceof AgentError)) return SIDECAR_EXIT_CODE.IO;
  if (error.code === "CONFIG_INVALID" || error.code === "CONFIG_MISSING") {
    return SIDECAR_EXIT_CODE.CONFIG;
  }
  if (error.code === "AUTH_REVOKED") return SIDECAR_EXIT_CODE.AUTH;
  if (error.code === "NETWORK_ERROR" || error.code === "HTTP_ERROR") {
    return SIDECAR_EXIT_CODE.NETWORK;
  }
  return SIDECAR_EXIT_CODE.IO;
}

function parseOptions(args, spec) {
  const values = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    const equal = token.indexOf("=");
    const key = (equal >= 0 ? token.slice(2, equal) : token.slice(2));
    if (!token.startsWith("--") || !spec[key]) {
      throw new AgentError("CONFIG_INVALID", `未知参数 ${token}`);
    }
    const value = equal >= 0 ? token.slice(equal + 1) : args[++index];
    if (!value) {
      throw new AgentError("CONFIG_INVALID", `参数 --${key} 缺少值`);
    }
    values[key] = value;
  }
  return values;
}

function requireOption(values, key) {
  if (!values[key]) {
    throw new AgentError("CONFIG_INVALID", `缺少参数 --${key}`);
  }
  return values[key];
}

async function readPairingCode() {
  if (process.stdin.isTTY) {
    throw new AgentError("CONFIG_INVALID", "桌面注册的配对码必须由客户端通过标准输入提供");
  }
  const reader = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  try {
    for await (const line of reader) {
      const value = line.trim();
      if (value) return value;
    }
  } finally {
    reader.close();
  }
  throw new AgentError("CONFIG_INVALID", "没有收到配对码");
}

async function extractSeaAsset(key, directory) {
  if (!sea.isSea()) return null;
  let bytes;
  try {
    bytes = Buffer.from(sea.getAsset(key));
  } catch {
    return null;
  }
  const target = path.join(directory, key);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await fs.writeFile(target, bytes, { mode: 0o600 });
  return target;
}

async function prepareAgent(store) {
  const scriptFile = await extractSeaAsset(
    DPAPI_ASSET,
    path.join(store.paths.root, "windows"),
  );
  return {
    store,
    credentialStore: new DpapiCredentialStore(store, {
      scriptFile: scriptFile || DEFAULT_DPAPI_SCRIPT,
    }),
  };
}

async function commandRun() {
  const store = new ConfigStore();
  await store.ensureDirectories();
  const agent = await prepareAgent(store);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const result = await runAgentProcess({
      store: agent.store,
      credentialStore: agent.credentialStore,
      signal: controller.signal,
    });
    return result.exitCode === 0 ? SIDECAR_EXIT_CODE.OK : (result.exitCode || 1);
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

async function commandEnroll(args) {
  const values = parseOptions(args, { server: {}, name: {} });
  const pairingCode = await readPairingCode();
  const store = new ConfigStore();
  const agent = await prepareAgent(store);
  const result = await enrollDesktopDevice({
    serverUrl: requireOption(values, "server"),
    pairingCode,
    deviceName: validateDeviceName(values.name),
    store: agent.store,
    credentialStore: agent.credentialStore,
    replace: false,
  });
  writeJson({ ok: true, ...result });
  return SIDECAR_EXIT_CODE.OK;
}

async function commandRevoke(args) {
  const values = parseOptions(args, { server: {}, agent: {} });
  const sessionCookie = process.env.TRELLIS_BOARD_SESSION || "";
  const result = await revokeDesktopDevice({
    serverUrl: requireOption(values, "server"),
    agentId: validateAgentId(requireOption(values, "agent")),
    sessionCookie,
  });
  writeJson({ ok: true, ...result });
  return SIDECAR_EXIT_CODE.OK;
}

async function commandStatus(args) {
  const values = parseOptions(args, { root: {} });
  const identity = await readAgentIdentity(values.root || undefined);
  writeJson({ ok: true, ...identity });
  return SIDECAR_EXIT_CODE.OK;
}

async function commandWorkspaceInit(args) {
  const values = parseOptions(args, {
    path: {},
    tools: {},
    username: {},
    team: {},
    server: {},
  });
  const store = new ConfigStore();
  const agent = await prepareAgent(store);
  const config = await store.readConfig({ allowMissing: false });
  const username = values.username || config.username;
  if (!username) {
    throw new AgentError(
      "CONFIG_INVALID",
      "本地配置缺少登录用户名；请重新注册设备",
    );
  }
  const teamId = values.team || config.teamId;
  if (!teamId) {
    throw new AgentError(
      "CONFIG_INVALID",
      "本地配置缺少团队信息；请重新注册设备",
    );
  }
  const agentCredential = await agent.credentialStore.loadCredential();
  const result = await runWorkspaceInit({
    workspacePath: requireOption(values, "path"),
    tools: values.tools || null,
    username,
    teamId,
    serverUrl: values.server || config.serverUrl,
    dataRoot: store.paths.root,
    agentCredential,
  });
  writeJson({ ok: true, ...result });
  return SIDECAR_EXIT_CODE.OK;
}

function usage() {
  return [
    "trellis-agent-sidecar <command>",
    "  run",
    "  enroll --server <URL> --name <设备名>   (配对码从标准输入读取)",
    "  revoke --server <URL> --agent <设备 ID> (会话 Cookie 从 TRELLIS_BOARD_SESSION 读取)",
    "  status [--root <Agent 数据目录>]",
    "  workspace-init --path <绝对路径> [--tools .opencode,.agents] [--username <name>] [--team <ID>]",
    "  version",
  ].join("\n");
}

export async function runSidecarMain(argv = process.argv.slice(2)) {
  const [command = "run", ...args] = argv;
  try {
    switch (command) {
      case "run":
        return await commandRun();
      case "enroll":
        return await commandEnroll(args);
      case "revoke":
        return await commandRevoke(args);
      case "status":
        return await commandStatus(args);
      case "workspace-init":
        return await commandWorkspaceInit(args);
      case "version":
        writeJson({
          ok: true,
          agentVersion: AGENT_VERSION,
          protocolVersion: AGENT_PROTOCOL_VERSION,
        });
        return SIDECAR_EXIT_CODE.OK;
      case "help":
      case "--help":
      case "-h":
        process.stdout.write(`${usage()}\n`);
        return SIDECAR_EXIT_CODE.OK;
      default:
        process.stderr.write(`未知命令：${command}\n${usage()}\n`);
        return SIDECAR_EXIT_CODE.USAGE;
    }
  } catch (error) {
    const message = safeErrorMessage(error);
    process.stderr.write(`${message}\n`);
    if (command !== "run") {
      writeJson({
        ok: false,
        error: message,
        ...(typeof error?.code === "string" ? { code: error.code } : {}),
      });
    }
    return exitCodeFor(error);
  }
}

const currentFile = fileURLToPath(import.meta.url);
const isBundled = typeof __TRELLIS_SIDECAR_BUNDLE__ !== "undefined";
if (isBundled || (process.argv[1] && path.resolve(process.argv[1]) === currentFile)) {
  runSidecarMain()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      process.stderr.write(`${safeErrorMessage(error)}\n`);
      process.exitCode = SIDECAR_EXIT_CODE.IO;
    });
}
