import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentApiClient, loadCaFile } from "./api.js";
import { ConfigStore, createConfigRevision } from "./config-store.js";
import { DpapiCredentialStore } from "./credential-store.js";
import {
  formatBindingHealth,
  inspectRepository,
  syncRepository,
} from "./git-sync.js";
import { SingleInstanceLock } from "./lock.js";
import { AgentLogger } from "./logger.js";
import {
  AgentError,
  AGENT_ERROR_CODE,
  AGENT_PROTOCOL_VERSION,
  AGENT_VERSION,
  buildCommandResult,
  compareVersions,
  isAuthenticationError,
  safeErrorMessage,
} from "./protocol.js";

const HEARTBEAT_MS = 15_000;
const POLL_WAIT_MS = 25_000;
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 60_000;

function sleep(ms, signal) {
  if (signal?.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

function nextDelay(attempt, retryAfterMs = null) {
  if (Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
    return Math.min(Math.max(retryAfterMs, RETRY_BASE_MS), RETRY_MAX_MS);
  }
  return Math.min(RETRY_BASE_MS * 2 ** Math.min(attempt, 6), RETRY_MAX_MS);
}

function publicBinding(binding) {
  return {
    localId: binding.localId,
    serverBindingId: binding.serverBindingId,
    projectId: binding.projectId,
    localRepoKey: binding.localRepoKey,
    remoteIdentityKey: binding.remoteIdentityKey,
    displayName: binding.displayName,
    branchName: binding.branchName,
    status: binding.syncStatus,
    lastSyncedAt: binding.lastSyncedAt,
    lastErrorCode: binding.lastErrorCode,
    lastError: binding.lastError,
  };
}

function commandBinding(config, command) {
  const byServerId = config.bindings.find(
    (binding) => binding.serverBindingId === command.bindingId,
  );
  if (byServerId) {
    return byServerId;
  }
  if (command.payload.projectId) {
    return config.bindings.find(
      (binding) => binding.projectId === command.payload.projectId,
    ) || null;
  }
  return null;
}

function bindingMatchesCommand(binding, command) {
  if (command.payload.projectId && binding.projectId !== command.payload.projectId) {
    return false;
  }
  if (binding.serverBindingId &&
      binding.serverBindingId !== command.bindingId) {
    return false;
  }
  return !command.payload.branchName || command.payload.branchName === binding.branchName;
}

function activeCommandEnabled(heartbeat) {
  if (!heartbeat?.compatible) {
    return false;
  }
  if (!heartbeat.minimumAgentVersion) {
    return true;
  }
  const comparison = compareVersions(AGENT_VERSION, heartbeat.minimumAgentVersion);
  return comparison != null && comparison >= 0;
}

export class AgentRuntime {
  constructor(options) {
    this.store = options.store;
    this.credentialStore = options.credentialStore;
    this.logger = options.logger;
    this.apiFactory = options.apiFactory || ((config, credential, ca) =>
      new AgentApiClient({
        serverUrl: config.serverUrl,
        credential,
        ca,
      }));
    this.inspectRepository = options.inspectRepository || inspectRepository;
    this.syncRepository = options.syncRepository || syncRepository;
    this.heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
    this.pollWaitMs = options.pollWaitMs ?? POLL_WAIT_MS;
    this.pollIdleMs = options.pollIdleMs ?? 500;
    this.abortController = new AbortController();
    this.signal = this.abortController.signal;
    if (options.signal?.aborted) {
      this.stop("signal");
    } else if (options.signal) {
      options.signal.addEventListener("abort", () => this.stop("signal"), {
        once: true,
      });
    }
    this.api = null;
    this.config = null;
    this.credential = null;
    this.ca = null;
    this.lastHeartbeat = null;
    this.pollEnabled = false;
    this.authRevoked = false;
    this.stopReason = null;
    this.fatalError = null;
  }

  stop(reason = "requested") {
    if (!this.signal.aborted) {
      this.stopReason ||= reason;
      this.abortController.abort();
    }
  }

  async loadContext(force = false) {
    const config = await this.store.readConfig({ allowMissing: false });
    const credential = force || !this.credential
      ? await this.credentialStore.loadCredential()
      : this.credential;
    const ca = force || !this.api
      ? await loadCaFile(config.caFile)
      : this.ca;
    if (
      force ||
      !this.api ||
      !this.config ||
      this.config.revision !== config.revision ||
      this.credential !== credential ||
      this.ca !== ca
    ) {
      this.api = this.apiFactory(config, credential, ca);
    }
    this.config = config;
    this.credential = credential;
    this.ca = ca;
    return { config, credential, api: this.api };
  }

  _heartbeatPayload() {
    return {
      agentId: this.config.agentId,
      deviceId: this.config.agentId,
      deviceName: this.config.deviceName,
      protocolVersion: AGENT_PROTOCOL_VERSION,
      agentVersion: AGENT_VERSION,
      bindings: this.config.bindings.map(publicBinding),
    };
  }

  async _applyHeartbeatBindings(heartbeat) {
    if (!heartbeat.bindings?.length) {
      return;
    }
    const byProject = new Map(
      heartbeat.bindings.map((binding) => [binding.projectId, binding]),
    );
    await this.store.updateConfig((config) => {
      let changed = false;
      const bindings = config.bindings.map((binding) => {
        const remote = byProject.get(binding.projectId);
        if (!remote || remote.localRepoKey !== binding.localRepoKey) {
          return binding;
        }
        const next = {
          ...binding,
          serverBindingId: remote.id,
          syncStatus: remote.status,
          lastErrorCode: remote.errorCode,
          lastError: remote.error,
        };
        if (remote.branchName && remote.branchName !== binding.branchName) {
          next.lastErrorCode = "BINDING_BRANCH_MISMATCH";
          next.lastError = "服务端项目管理分支与本地绑定不一致";
        }
        if (
          next.serverBindingId !== binding.serverBindingId ||
          next.syncStatus !== binding.syncStatus ||
          next.lastErrorCode !== binding.lastErrorCode ||
          next.lastError !== binding.lastError
        ) {
          changed = true;
          return next;
        }
        return binding;
      });
      return changed ? { ...config, bindings } : undefined;
    });
  }

  async _recordHeartbeat(heartbeat, error = null) {
    this.lastHeartbeat = {
      at: new Date().toISOString(),
      compatible: heartbeat?.compatible ?? false,
      protocolVersion: heartbeat?.protocolVersion ?? null,
      minimumAgentVersion: heartbeat?.minimumAgentVersion ?? null,
      error: error ? {
        code: error.code || AGENT_ERROR_CODE.NETWORK_ERROR,
        message: safeErrorMessage(error),
      } : null,
    };
    this.pollEnabled = error == null && activeCommandEnabled(this.lastHeartbeat);
    await this.store.writeState({
      status: this.authRevoked ? "auth_revoked" : error ? "degraded" : "running",
      pid: process.pid,
      startedAt: this.startedAt || null,
      lastHeartbeatAt: this.lastHeartbeat.at,
      lastHeartbeatError: this.lastHeartbeat.error,
      commandPollingEnabled: this.pollEnabled,
    });
  }

  async heartbeatOnce() {
    await this.loadContext();
    try {
      const heartbeat = await this.api.heartbeat(this._heartbeatPayload(), {
        signal: this.signal,
      });
      await this._applyHeartbeatBindings(heartbeat);
      await this._recordHeartbeat(heartbeat);
      if (!heartbeat.compatible) {
        this.logger.warn("服务端协议不兼容，仅保留心跳");
      } else if (!activeCommandEnabled(heartbeat)) {
        this.logger.warn("Agent 版本低于服务端最低版本，暂停领取命令", {
          minimumAgentVersion: heartbeat.minimumAgentVersion,
        });
      }
      return heartbeat;
    } catch (error) {
      await this._recordHeartbeat(null, error);
      if (isAuthenticationError(error)) {
        this.authRevoked = true;
        this.logger.error("Agent 凭证已撤销，停止重试，请重新配对");
        this.stop("auth_revoked");
        return null;
      }
      throw error;
    }
  }

  async _heartbeatLoop() {
    let attempt = 0;
    while (!this.signal.aborted) {
      try {
        await this.heartbeatOnce();
        attempt = 0;
      } catch (error) {
        if (isAuthenticationError(error)) {
          return;
        }
        const delay = nextDelay(attempt, error.retryAfterMs);
        attempt += 1;
        this.logger.warn("心跳失败，稍后重试", error);
        await sleep(delay, this.signal);
        continue;
      }
      await sleep(this.heartbeatMs, this.signal);
    }
  }

  async _submitResult(command, result, attempt = 0) {
    try {
      await this.loadContext();
      await this.api.submitCommandResult(command.id, result, {
        signal: this.signal,
      });
      return true;
    } catch (error) {
      if (isAuthenticationError(error)) {
        this.authRevoked = true;
        this.stop("auth_revoked");
        return false;
      }
      if (this.signal.aborted) {
        return false;
      }
      if (error.retryable !== true && error.code !== AGENT_ERROR_CODE.NETWORK_ERROR) {
        this.logger.error("命令结果上报被服务端拒绝", error);
        return false;
      }
      if (attempt >= 2) {
        this.logger.error("命令结果上报失败，等待服务端租约重投", error);
        return false;
      }
      await sleep(nextDelay(attempt, error.retryAfterMs), this.signal);
      return this._submitResult(command, result, attempt + 1);
    }
  }

  async _updateBindingResult(binding, result, error = null) {
    const health = error
      ? formatBindingHealth(error)
      : result?.clean === false
        ? {
            errorCode: AGENT_ERROR_CODE.LOCAL_DIRTY,
            error: "本地工作区存在未提交或未跟踪文件",
          }
        : null;
    await this.store.updateConfig((config) => {
      let changed = false;
      const bindings = config.bindings.map((item) => {
        if (item.localId !== binding.localId) {
          return item;
        }
        const next = {
          ...item,
          syncStatus: result ? "approved" : item.syncStatus,
          lastSyncedAt: result?.syncedAt ?? item.lastSyncedAt,
          lastHead: result?.head ?? item.lastHead,
          lastErrorCode: health?.errorCode ?? null,
          lastError: health?.error ?? null,
        };
        if (
          next.lastSyncedAt !== item.lastSyncedAt ||
          next.lastHead !== item.lastHead ||
          next.lastErrorCode !== item.lastErrorCode ||
          next.lastError !== item.lastError
        ) {
          changed = true;
          return next;
        }
        return item;
      });
      return changed ? { ...config, bindings } : undefined;
    });
  }

  async _runCommand(command) {
    const { config } = await this.loadContext();
    const binding = commandBinding(config, command);
    if (!binding) {
      throw new AgentError(
        AGENT_ERROR_CODE.BINDING_UNKNOWN,
        "服务端命令引用了未知的本地项目绑定",
      );
    }
    if (!bindingMatchesCommand(binding, command)) {
      throw new AgentError(
        AGENT_ERROR_CODE.COMMAND_INVALID,
        "服务端命令的项目或分支与本地绑定不一致",
      );
    }
    const serverAuthorized =
      binding.syncStatus === "pending" &&
      binding.serverBindingId != null &&
      binding.serverBindingId === command.bindingId;
    if (binding.syncStatus !== "approved" && !serverAuthorized) {
      throw new AgentError(
        AGENT_ERROR_CODE.BINDING_NOT_APPROVED,
        "本地项目绑定尚未获项目负责人批准",
      );
    }
    const options = {
      repoPath: binding.repoPath,
      branchName: binding.branchName,
      hooksDir: path.join(this.store.paths.hooksBaseDir, binding.localId),
      expectedRemoteIdentity: binding.remoteIdentityKey,
      allowFileRemote: binding.allowFileRemote,
    };
    if (command.type === "sync_branch") {
      const result = await this.syncRepository(options);
      await this._updateBindingResult(binding, result);
      return {
        bindingId: binding.serverBindingId,
        projectId: binding.projectId,
        branchName: result.branchName,
        head: result.head,
        clean: result.clean,
        syncedAt: result.syncedAt,
        localRepoKey: result.localRepoKey,
        remoteIdentityKey: result.remoteIdentityKey,
      };
    }
    if (command.type === "refresh_status") {
      const result = await this.inspectRepository(options);
      const reported = {
        bindingId: binding.serverBindingId,
        projectId: binding.projectId,
        branchName: result.branchName,
        head: result.head,
        clean: result.clean,
        syncedAt: new Date().toISOString(),
        localRepoKey: result.localRepoKey,
        remoteIdentityKey: result.remoteIdentityKey,
      };
      await this._updateBindingResult(binding, reported);
      return reported;
    }
    throw new AgentError(AGENT_ERROR_CODE.COMMAND_INVALID, "不支持的服务端命令");
  }

  async _processCommand(command) {
    try {
      const result = await this._runCommand(command);
      const payload = buildCommandResult("succeeded", result);
      const delivered = await this._submitResult(command, payload);
      if (delivered) {
        this.logger.info("Agent 命令执行成功", {
          commandId: command.id,
          commandType: command.type,
        });
      } else {
        this.logger.warn("Agent 命令执行成功，但结果未上报", {
          commandId: command.id,
          commandType: command.type,
        });
      }
      return payload;
    } catch (error) {
      const { config } = await this.loadContext().catch(() => ({ config: this.config }));
      const binding = config ? commandBinding(config, command) : null;
      if (binding) {
        await this._updateBindingResult(binding, null, error).catch(() => {});
      }
      const payload = buildCommandResult("failed", null, error);
      await this._submitResult(command, payload);
      this.logger.warn("Agent 命令执行失败", error);
      return payload;
    }
  }

  async _commandLoop() {
    let attempt = 0;
    while (!this.signal.aborted) {
      if (!this.pollEnabled) {
        await sleep(this.pollIdleMs, this.signal);
        continue;
      }
      try {
        await this.loadContext();
        const commands = await this.api.pollCommands(
          {
            agentId: this.config.agentId,
            deviceId: this.config.agentId,
            waitMs: this.pollWaitMs,
          },
          {
            signal: this.signal,
            timeoutMs: this.pollWaitMs + 25_000,
          },
        );
        attempt = 0;
        for (const command of commands) {
          if (this.signal.aborted || !this.pollEnabled) {
            break;
          }
          await this._processCommand(command);
        }
      } catch (error) {
        if (isAuthenticationError(error)) {
          this.authRevoked = true;
          this.stop("auth_revoked");
          return;
        }
        if (error.code === AGENT_ERROR_CODE.PROTOCOL_INCOMPATIBLE) {
          this.pollEnabled = false;
          this.logger.warn("Agent 协议不兼容，暂停命令轮询");
          continue;
        }
        const delay = nextDelay(attempt, error.retryAfterMs);
        attempt += 1;
        this.logger.warn("命令长轮询失败，稍后重试", error);
        await sleep(delay, this.signal);
      }
    }
  }

  async run() {
    this.startedAt = new Date().toISOString();
    await this.store.ensureDirectories();
    await this.loadContext(true);
    await this.store.writeState({
      status: "starting",
      pid: process.pid,
      startedAt: this.startedAt,
    });
    this.logger.info("Trellis Agent 已启动");
    const heartbeat = this._heartbeatLoop();
    const commands = this._commandLoop();
    await Promise.all([heartbeat, commands]);
    await this.store.writeState({
      status: this.authRevoked ? "auth_revoked" : "stopped",
      pid: process.pid,
      startedAt: this.startedAt,
      stoppedAt: new Date().toISOString(),
      reason: this.stopReason || "requested",
      lastHeartbeatAt: this.lastHeartbeat?.at ?? null,
    });
    this.logger.info(
      this.authRevoked ? "Trellis Agent 因凭证撤销停止" : "Trellis Agent 已停止",
    );
    return {
      exitCode: 0,
      authRevoked: this.authRevoked,
      reason: this.stopReason,
    };
  }
}

export async function runAgentProcess(options = {}) {
  const store = options.store || new ConfigStore();
  await store.ensureDirectories();
  const logger = options.logger || new AgentLogger({ logsDir: store.paths.logsDir });
  const lock = options.lock || new SingleInstanceLock(store.paths.lockFile);
  let acquired = false;
  try {
    await lock.acquire();
    acquired = true;
    const credentialStore =
      options.credentialStore || new DpapiCredentialStore(store);
    const runtime = new AgentRuntime({
      store,
      credentialStore,
      logger,
      apiFactory: options.apiFactory,
      inspectRepository: options.inspectRepository,
      syncRepository: options.syncRepository,
      heartbeatMs: options.heartbeatMs,
      pollWaitMs: options.pollWaitMs,
      signal: options.signal,
    });
    return await runtime.run();
  } catch (error) {
    logger.error("Trellis Agent 启动或运行失败", error);
    return {
      exitCode: error.code === AGENT_ERROR_CODE.LOCKED ? 7 : 1,
      error,
    };
  } finally {
    if (acquired) {
      await lock.release();
    }
    await logger.close();
  }
}

export async function runAgentMain() {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const result = await runAgentProcess({ signal: controller.signal });
    return result.exitCode;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  runAgentMain()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      process.stderr.write(`${safeErrorMessage(error)}\n`);
      process.exitCode = 1;
    });
}
