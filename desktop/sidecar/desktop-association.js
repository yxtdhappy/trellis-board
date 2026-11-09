import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { AgentApiClient } from "../../agent/api.js";
import { ConfigStore } from "../../agent/config-store.js";
import { inspectRepository } from "../../agent/git-sync.js";
import {
  AgentError,
  AGENT_ERROR_CODE,
  AGENT_PROTOCOL_VERSION,
  AGENT_VERSION,
  isLoopbackHostname,
  safeErrorMessage,
  validateBranchNameSyntax,
} from "../../agent/protocol.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function validateProjectId(value) {
  const projectId = String(value || "").trim();
  if (!SAFE_ID.test(projectId)) {
    throw new AgentError(AGENT_ERROR_CODE.CONFIG_INVALID, "项目 ID 格式无效");
  }
  return projectId;
}

function associationPayload(binding) {
  return {
    projectId: binding.projectId,
    localRepoKey: binding.localRepoKey,
    branchName: binding.branchName,
    remoteIdentityKey: binding.remoteIdentityKey,
    displayName: binding.displayName,
    status: binding.syncStatus,
  };
}

/**
 * 关联只复用现有 Git 检查与 Agent 心跳；不在桌面端另写远端身份校验。
 */
export async function associateDesktopProject(options = {}) {
  const projectId = validateProjectId(options.projectId);
  const branchName = validateBranchNameSyntax(options.branchName);
  const repoPath = path.resolve(String(options.repoPath || "").trim());
  const store = options.store || new ConfigStore(options.root, {
    secureDirectory: options.secureDirectory !== false,
  });
  await store.ensureDirectories();
  if (!options.credentialStore) {
    throw new AgentError(
      AGENT_ERROR_CODE.CONFIG_INVALID,
      "本地项目关联缺少设备凭证存储",
    );
  }
  const config = await store.readConfig({ allowMissing: false });
  const credential = await options.credentialStore.loadCredential();
  const localId = crypto.randomUUID();
  const hooksDir = path.join(store.paths.hooksBaseDir, localId);
  await fs.mkdir(hooksDir, { recursive: true, mode: 0o700 });
  const allowFileRemote = isLoopbackHostname(new URL(config.serverUrl).hostname);
  const inspected = await (options.inspectRepository || inspectRepository)({
    repoPath,
    branchName,
    hooksDir,
    allowFileRemote,
  });
  const binding = {
    localId,
    serverBindingId: null,
    projectId,
    repoPath: inspected.root,
    branchName,
    teamId: null,
    remoteIdentityKey: inspected.remoteIdentityKey,
    localRepoKey: inspected.localRepoKey,
    displayName: path.basename(inspected.root),
    createdAt: new Date().toISOString(),
    allowFileRemote,
    readOnly: false,
    syncStatus: "pending",
    liveSyncStatus: "pending",
    liveSyncError: null,
    lastSyncedAt: null,
    lastHead: inspected.head,
    lastError: inspected.clean ? null : "本地工作区存在未提交或未跟踪文件",
    lastErrorCode: inspected.clean ? null : AGENT_ERROR_CODE.LOCAL_DIRTY,
  };
  await store.updateConfig((current) => {
    if (current.bindings.some((item) => item.projectId === projectId)) {
      throw new AgentError(AGENT_ERROR_CODE.CONFIG_INVALID, "该项目已经关联本地仓库");
    }
    if (current.bindings.some((item) => item.localRepoKey === binding.localRepoKey)) {
      throw new AgentError(AGENT_ERROR_CODE.CONFIG_INVALID, "该本地仓库已经关联其他项目");
    }
    return {
      ...current,
      bindings: [...current.bindings, binding],
    };
  }, { allowMissing: false });

  const apiFactory = options.apiClientFactory ||
    (({ serverUrl, credential: value }) => new AgentApiClient({
      serverUrl,
      credential: value,
    }));
  const api = apiFactory({ serverUrl: config.serverUrl, credential });
  let remote;
  try {
    const heartbeat = await api.heartbeat({
      agentId: config.agentId,
      deviceName: config.deviceName,
      protocolVersion: AGENT_PROTOCOL_VERSION,
      agentVersion: AGENT_VERSION,
      bindings: [associationPayload(binding)],
    });
    remote = heartbeat.bindings?.find((item) => item.projectId === projectId) || null;
  } catch (error) {
    await removeBinding(store, localId);
    throw error;
  }
  if (!remote || remote.status !== "approved") {
    await removeBinding(store, localId);
    const code = remote?.errorCode || "BINDING_REJECTED";
    const message = remote?.error || "服务端拒绝本地项目关联";
    throw new AgentError(code, message);
  }
  await store.updateConfig((current) => ({
    ...current,
    bindings: current.bindings.map((item) => item.localId === localId
      ? {
          ...item,
          serverBindingId: remote.id,
          teamId: remote.teamId ?? null,
          readOnly: remote.readOnly === true,
          syncStatus: remote.status,
          liveSyncStatus: "pending",
          liveSyncError: null,
          lastError: null,
          lastErrorCode: null,
        }
      : item),
  }), { allowMissing: false });
  return {
    projectId,
    repoPath: inspected.root,
    displayName: binding.displayName,
    branchName,
    teamId: remote.teamId ?? null,
    status: remote.status,
    readOnly: remote.readOnly === true,
    liveSyncStatus: "pending",
    liveSyncError: null,
  };
}

async function removeBinding(store, localId) {
  await store.updateConfig((current) => ({
    ...current,
    bindings: current.bindings.filter((item) => item.localId !== localId),
  }), { allowMissing: false }).catch(() => {});
}

export function formatAssociationError(error) {
  return {
    code: error instanceof AgentError ? error.code : AGENT_ERROR_CODE.GIT_FAILED,
    error: safeErrorMessage(error),
  };
}
