import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { AgentApiClient } from '../../agent/api.js'
import { ConfigStore } from '../../agent/config-store.js'
import { attachProject, preflightProject } from '../../agent/project-onboarding.js'
import {
  AgentError,
  AGENT_ERROR_CODE,
  safeErrorMessage,
  validateBranchNameSyntax,
} from '../../agent/protocol.js'

export async function associateDesktopProject(options = {}) {
  const branchName = validateBranchNameSyntax(options.branchName)
  const teamId = String(options.teamId || '').trim()
  const developerId = String(options.developerId || '').trim()
  const initialSyncMode = String(options.initialSyncMode || '').trim()
  if (!teamId || !developerId) {
    throw new AgentError(AGENT_ERROR_CODE.CONFIG_INVALID, '关联项目必须选择团队并填写 developer ID')
  }
  if (!['bootstrap', 'safe', 'review'].includes(initialSyncMode)) {
    throw new AgentError(AGENT_ERROR_CODE.CONFIG_INVALID, '首次同步处理方式无效')
  }
  const repoPath = path.resolve(String(options.repoPath || '').trim())
  const store =
    options.store ||
    new ConfigStore(options.root, {
      secureDirectory: options.secureDirectory !== false,
    })
  await store.ensureDirectories()
  if (!options.credentialStore) {
    throw new AgentError(AGENT_ERROR_CODE.CONFIG_INVALID, '本地项目关联缺少设备凭证存储')
  }
  const config = await store.readConfig({ allowMissing: false })
  const credential = await options.credentialStore.loadCredential()
  const localId = crypto.randomUUID()
  const hooksDir = path.join(store.paths.hooksBaseDir, localId)
  await fs.mkdir(hooksDir, { recursive: true, mode: 0o700 })
  const allowFileRemote = config.allowLocalGitRemotes === true
  const apiFactory =
    options.apiClientFactory ||
    (({ serverUrl, credential: value }) =>
      new AgentApiClient({
        serverUrl,
        credential: value,
      }))
  const api = apiFactory({ serverUrl: config.serverUrl, credential })
  const result = await attachProject({
    api,
    store,
    repoPath,
    hooksDir,
    expectedBranchName: branchName,
    teamId,
    developerId,
    displayName: options.displayName,
    allowFileRemote,
    requirePushed: options.requirePushed === true,
    initialSyncMode,
  })
  return {
    projectId: result.project.id,
    taskSpaceId: result.taskSpace.id,
    repoPath: result.inspected.root,
    displayName: result.binding.displayName,
    branchName: result.inspected.branchName,
    teamId: result.binding.teamId,
    status: result.binding.syncStatus,
    readOnly: result.binding.readOnly,
    liveSyncStatus: result.binding.liveSyncStatus,
    liveSyncError: null,
  }
}

export async function preflightDesktopProject(options = {}) {
  const teamId = String(options.teamId || '').trim()
  if (!teamId) {
    throw new AgentError(AGENT_ERROR_CODE.CONFIG_INVALID, '预检项目必须选择团队')
  }
  const repoPath = path.resolve(String(options.repoPath || '').trim())
  const store =
    options.store ||
    new ConfigStore(options.root, {
      secureDirectory: options.secureDirectory !== false,
    })
  if (!options.credentialStore) {
    throw new AgentError(AGENT_ERROR_CODE.CONFIG_INVALID, '本地项目预检缺少设备凭证存储')
  }
  const config = await store.readConfig({ allowMissing: false })
  const credential = await options.credentialStore.loadCredential()
  const allowFileRemote = config.allowLocalGitRemotes === true
  const apiFactory =
    options.apiClientFactory ||
    (({ serverUrl, credential: value }) =>
      new AgentApiClient({
        serverUrl,
        credential: value,
      }))
  const api = apiFactory({ serverUrl: config.serverUrl, credential })
  const hooksDir = await fs.mkdtemp(path.join(os.tmpdir(), 'trellis-preflight-hooks-'))
  try {
    return await preflightProject({
      api,
      repoPath,
      hooksDir,
      teamId,
      allowFileRemote,
      requirePushed: options.requirePushed === true,
    })
  } finally {
    await fs.rm(hooksDir, { recursive: true, maxRetries: 3, retryDelay: 50 }).catch(() => {})
  }
}

export function formatAssociationError(error) {
  return {
    code: error instanceof AgentError ? error.code : AGENT_ERROR_CODE.GIT_FAILED,
    error: safeErrorMessage(error),
  }
}
