import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  detectTrellisAgentTools,
  TRELLIS_AGENT_TOOLS,
  normalizeTrellisAgentTools,
} from '../shared/trellis-agent-tools.js'
import {
  compareRemoteBranch,
  inspectGitProject,
  readGitStatus,
  readHeadTrellisFiles,
  readRemoteBranch,
} from './git-sync.js'
import { readLocalTaskSnapshotGroups } from './local-task-snapshot.js'
import { AgentError, AGENT_ERROR_CODE, safeErrorMessage } from './protocol.js'
import {
  classifyTaskSnapshots,
  normalizeSnapshotPath,
  taskDirectoryFromPath,
} from '../shared/task-snapshot.js'

async function exists(target) {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

async function detectedTools(repoPath, headPaths = []) {
  const localPaths = []
  for (const tool of TRELLIS_AGENT_TOOLS) {
    for (const presencePath of tool.presencePaths) {
      if (await exists(path.join(repoPath, ...presencePath.split('/')))) {
        localPaths.push(presencePath)
      }
    }
  }
  return detectTrellisAgentTools([...headPaths, ...localPaths])
}

function remoteBranchSha(output, branchName) {
  const suffix = `refs/heads/${branchName}`
  for (const line of String(output || '').split(/\r?\n/)) {
    const [sha, reference] = line.trim().split(/\s+/)
    if (reference === suffix && /^[a-f0-9]{40,64}$/i.test(sha)) return sha
  }
  return null
}

export async function inspectProject({
  repoPath,
  hooksDir,
  allowFileRemote = false,
  expectedBranchName = null,
}) {
  const repository = await inspectGitProject({
    repoPath,
    branchName: expectedBranchName,
    hooksDir,
    allowFileRemote,
    allowUnborn: true,
  })
  const trellisDir = path.join(repository.root, '.trellis')
  const tasksDir = path.join(trellisDir, 'tasks')
  const hasTrellis = await exists(trellisDir)
  const hasTasks = await exists(tasksDir)
  const headTree = await readHeadTrellisFiles({
    repoPath: repository.root,
    hooksDir,
  })
  const headPaths = headTree.exitCode === 0 ? headTree.stdout.split(/\r?\n/).filter(Boolean) : []
  return {
    ...repository,
    hasTrellis,
    hasTasks,
    hasCommittedTrellis: headPaths.length > 0,
    requiresInitialization: !hasTrellis || !hasTasks,
    existingAgentTools: await detectedTools(repository.root, headPaths),
    repositoryName: path.basename(repository.root),
  }
}

export async function initializeProject({
  repoPath,
  hooksDir,
  developerId,
  agentTools,
  allowFileRemote = false,
  initialize,
}) {
  const inspected = await inspectProject({ repoPath, hooksDir, allowFileRemote })
  const selectedTools = normalizeTrellisAgentTools(agentTools)
  if (
    !inspected.hasTrellis ||
    !inspected.hasTasks ||
    selectedTools.some((id) => !inspected.existingAgentTools.includes(id))
  ) {
    if (typeof initialize !== 'function') {
      throw new AgentError(AGENT_ERROR_CODE.CONFIG_MISSING, '客户端缺少 Trellis 初始化器')
    }
    await initialize({
      repoPath: inspected.root,
      developerId,
      agentTools: selectedTools,
    })
  }
  return inspectProject({
    repoPath: inspected.root,
    hooksDir,
    allowFileRemote,
  })
}

function classifyRemoteFailure(result) {
  const message = String(result?.stderr || result?.stdout || '')
  if (/couldn't find remote ref|remote ref does not exist/i.test(message)) {
    return 'branch_missing'
  }
  if (
    /could not resolve|connection refused|unable to access|authentication failed|could not read from remote repository|timed out|network/i.test(
      message,
    )
  ) {
    return 'unable_to_verify'
  }
  return 'unable_to_verify'
}

export async function checkInitialPush({
  repoPath,
  branchName,
  hooksDir,
  allowFileRemote = false,
}) {
  const repository = await inspectGitProject({
    repoPath,
    branchName,
    hooksDir,
    allowFileRemote,
    allowUnborn: true,
  })
  const committed = await readHeadTrellisFiles({ repoPath: repository.root, hooksDir })
  if (!repository.head || committed.exitCode !== 0 || !committed.stdout.includes('.trellis/')) {
    return {
      state: 'waiting_commit',
      message: '请先提交 .trellis 初始化文件',
      localHead: repository.head,
      remoteHead: null,
    }
  }
  const dirty = await readGitStatus({
    repoPath: repository.root,
    hooksDir,
    paths: ['.trellis'],
  })
  if (dirty.exitCode !== 0) {
    return {
      state: 'waiting_commit',
      message: '无法确认 .trellis 是否已全部提交',
      localHead: repository.head,
      remoteHead: null,
    }
  }
  if (dirty.stdout.trim()) {
    return {
      state: 'waiting_commit',
      message: '.trellis 仍有未提交文件，请提交后再推送',
      localHead: repository.head,
      remoteHead: null,
      dirtySummary: safeErrorMessage(new Error(dirty.stdout)).slice(0, 500),
    }
  }
  const remote = await readRemoteBranch({
    repoPath: repository.root,
    branchName,
    hooksDir,
  })
  if (remote.exitCode !== 0) {
    const state = classifyRemoteFailure(remote)
    return {
      state,
      message:
        state === 'branch_missing'
          ? `远端分支 ${branchName} 还不存在，请推送本地分支`
          : '暂时无法连接远端，不能确认是否已推送',
      localHead: repository.head,
      remoteHead: null,
    }
  }
  const remoteHead = remoteBranchSha(remote.stdout, branchName)
  if (!remoteHead) {
    return {
      state: 'unable_to_verify',
      message: '远端没有返回目标分支，无法确认推送结果',
      localHead: repository.head,
      remoteHead: null,
    }
  }
  if (remoteHead === repository.head) {
    return {
      state: 'ready',
      message: '初始化文件已提交并推送到远端',
      localHead: repository.head,
      remoteHead,
    }
  }
  const compared = await compareRemoteBranch({
    repoPath: repository.root,
    branchName,
    hooksDir,
  })
  if (!compared.ok) {
    return {
      state: 'unable_to_verify',
      message: '已读取远端分支，但无法比较本地与远端提交',
      localHead: repository.head,
      remoteHead,
    }
  }
  const [localAhead, remoteAhead] = String(compared.countsResult.stdout)
    .trim()
    .split(/\s+/)
    .map(Number)
  let state = 'diverged'
  let message = '本地与远端已经分叉，请先处理 Git 历史'
  if (localAhead > 0 && remoteAhead === 0) {
    state = 'waiting_push'
    message = '本地有新提交尚未推送'
  } else if (remoteAhead > 0 && localAhead === 0) {
    state = 'remote_ahead'
    message = '远端分支比本地更新，请先拉取并处理'
  }
  return {
    state,
    message,
    localHead: repository.head,
    remoteHead,
    localAhead,
    remoteAhead,
  }
}

function normalizeInitialSyncMode(value) {
  const mode = String(value || '').trim()
  if (!new Set(['bootstrap', 'safe', 'review']).has(mode)) {
    throw new AgentError(AGENT_ERROR_CODE.COMMAND_INVALID, '首次同步处理方式无效')
  }
  return mode
}

function normalizeServerTaskGroups(tasks) {
  if (!Array.isArray(tasks)) return []
  return tasks.map((group, groupIndex) => {
    if (!group || typeof group !== 'object' || !Array.isArray(group.files)) {
      throw new AgentError(
        AGENT_ERROR_CODE.INVALID_RESPONSE,
        `服务端任务快照第 ${groupIndex + 1} 组无效`,
      )
    }
    const taskDir = String(group.taskDir || '').trim()
    const files = group.files.map((file) => {
      if (!file || typeof file !== 'object') {
        throw new AgentError(AGENT_ERROR_CODE.INVALID_RESPONSE, '服务端任务文件元数据无效')
      }
      const relativePath = normalizeSnapshotPath(file.path)
      if (taskDirectoryFromPath(relativePath).taskDir !== taskDir) {
        throw new AgentError(AGENT_ERROR_CODE.INVALID_RESPONSE, '服务端任务文件不属于目标目录')
      }
      const sha256 = String(file.sha256 || '')
      if (!/^[a-f0-9]{64}$/.test(sha256)) {
        throw new AgentError(AGENT_ERROR_CODE.INVALID_RESPONSE, '服务端任务文件摘要无效')
      }
      return { path: relativePath, sha256 }
    })
    return {
      taskDir,
      taskId: typeof group.taskId === 'string' && group.taskId.trim() ? group.taskId.trim() : null,
      files,
    }
  })
}

function snapshotCounts(differences) {
  const counts = {
    same: 0,
    localOnly: 0,
    serverOnly: 0,
    conflicts: 0,
    invalid: 0,
  }
  for (const difference of differences) {
    if (difference.type === 'same') counts.same += 1
    else if (difference.type === 'local-only') counts.localOnly += 1
    else if (difference.type === 'server-only') counts.serverOnly += 1
    else if (difference.type === 'invalid') counts.invalid += 1
    else counts.conflicts += 1
  }
  return counts
}

function bindingFromAttach({ inspected, attached, teamId, allowFileRemote, initialSyncMode }) {
  const now = new Date().toISOString()
  return {
    localId: crypto.randomUUID(),
    serverBindingId: attached.binding.id,
    taskSpaceId: attached.taskSpace.id,
    projectId: attached.project.id,
    repoPath: inspected.root,
    branchName: inspected.branchName,
    teamId: attached.project.ownerTeamId || teamId,
    remoteIdentityKey: inspected.remoteIdentityKey,
    localRepoKey: inspected.localRepoKey,
    displayName: attached.project.name || inspected.repositoryName,
    createdAt: now,
    allowFileRemote,
    readOnly: attached.binding.readOnly === true,
    syncStatus: attached.binding.status || 'approved',
    initialSyncMode,
    initialSyncCompleted: false,
    initialReviewPending: initialSyncMode === 'review',
    liveSyncStatus: 'syncing',
    liveSyncError: null,
    lastSyncedAt: null,
    lastHead: inspected.head,
    lastError: null,
    lastErrorCode: null,
  }
}

export async function preflightProject({
  api,
  repoPath,
  hooksDir,
  teamId,
  allowFileRemote = false,
  requirePushed = false,
}) {
  const inspected = await inspectProject({ repoPath, hooksDir, allowFileRemote })
  if (!inspected.hasTrellis || !inspected.hasTasks) {
    throw new AgentError(
      AGENT_ERROR_CODE.MISSING_TRELLIS,
      '项目还没有初始化 Trellis，请先选择编码 Agent 并完成初始化',
    )
  }
  if (requirePushed) {
    const push = await checkInitialPush({
      repoPath: inspected.root,
      branchName: inspected.branchName,
      hooksDir,
      allowFileRemote,
    })
    if (push.state !== 'ready') {
      throw new AgentError(AGENT_ERROR_CODE.LOCAL_AHEAD, push.message)
    }
  }

  const server = await api.preflightTaskSpaceAccess({
    remoteUrl: inspected.remoteUrl,
    branchName: inspected.branchName,
    teamId,
  })
  if (!server || typeof server !== 'object' || typeof server.status !== 'string') {
    throw new AgentError(AGENT_ERROR_CODE.INVALID_RESPONSE, '服务端返回了无效的任务预检结果')
  }
  if (server.status === 'access_required') {
    return {
      ...server,
      inspected,
      differences: [],
      counts: snapshotCounts([]),
    }
  }

  const localGroups = await readLocalTaskSnapshotGroups(inspected.root)
  const serverGroups = normalizeServerTaskGroups(server.tasks)
  const differences = classifyTaskSnapshots(localGroups, serverGroups)
  return {
    ...server,
    inspected,
    differences,
    counts: snapshotCounts(differences),
  }
}

export async function attachProject({
  api,
  store,
  repoPath,
  hooksDir,
  expectedBranchName = null,
  teamId,
  developerId,
  displayName = null,
  allowFileRemote = false,
  requirePushed = false,
  initialSyncMode = 'review',
}) {
  const mode = normalizeInitialSyncMode(initialSyncMode)
  const inspected = await inspectProject({
    repoPath,
    hooksDir,
    allowFileRemote,
    expectedBranchName,
  })
  if (!inspected.hasTrellis || !inspected.hasTasks) {
    throw new AgentError(
      AGENT_ERROR_CODE.MISSING_TRELLIS,
      '项目还没有初始化 Trellis，请先选择编码 Agent 并完成初始化',
    )
  }
  if (requirePushed) {
    const push = await checkInitialPush({
      repoPath: inspected.root,
      branchName: inspected.branchName,
      hooksDir,
      allowFileRemote,
    })
    if (push.state !== 'ready') {
      throw new AgentError(AGENT_ERROR_CODE.LOCAL_AHEAD, push.message)
    }
  }
  const attached = await api.attachTaskSpace({
    remoteUrl: inspected.remoteUrl,
    branchName: inspected.branchName,
    teamId,
    developerId,
    displayName: displayName || inspected.repositoryName,
    localRepoKey: inspected.localRepoKey,
  })
  const binding = bindingFromAttach({
    inspected,
    attached,
    teamId,
    allowFileRemote,
    initialSyncMode: mode,
  })
  await store.updateConfig((config) => ({
    ...config,
    bindings: [
      ...config.bindings.filter((item) => item.taskSpaceId !== binding.taskSpaceId),
      binding,
    ],
  }))
  return { status: 'attached', ...attached, binding, inspected }
}
