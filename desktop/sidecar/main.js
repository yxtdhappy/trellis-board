import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import sea from 'node:sea'
import { AgentApiClient } from '../../agent/api.js'
import { ConfigStore } from '../../agent/config-store.js'
import { DpapiCredentialStore } from '../../agent/credential-store.js'
import { runAgentProcess } from '../../agent/index.js'
import {
  checkInitialPush,
  initializeProject,
  inspectProject,
} from '../../agent/project-onboarding.js'
import {
  AgentTaskSnapshotSync,
  liveControlLine,
  restoreLiveBackup,
} from '../../agent/task-snapshot-sync.js'
import {
  AgentError,
  AGENT_PROTOCOL_VERSION,
  AGENT_VERSION,
  safeErrorMessage,
} from '../../agent/protocol.js'
import {
  loginDesktop,
  logoutDesktopSession,
  readLocalAssociations,
  readAgentIdentity,
  revokeDesktopDevice,
  validateAgentId,
  validateDeviceName,
} from './desktop-device.js'
import { associateDesktopProject, preflightDesktopProject } from './desktop-association.js'
import { startParentWatchdog } from './parent-watchdog.js'
import { initializeTrellis } from './trellis-runtime.js'

export const SIDECAR_EXIT_CODE = Object.freeze({
  OK: 0,
  USAGE: 2,
  CONFIG: 3,
  AUTH: 4,
  NETWORK: 5,
  IO: 6,
})

const DPAPI_ASSET = 'dpapi.ps1'

function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function exitCodeFor(error) {
  if (!(error instanceof AgentError)) return SIDECAR_EXIT_CODE.IO
  if (error.code === 'CONFIG_INVALID' || error.code === 'CONFIG_MISSING') {
    return SIDECAR_EXIT_CODE.CONFIG
  }
  if (error.code === 'AUTH_REVOKED' || error.code === 'DESKTOP_TOKEN_INVALID') {
    return SIDECAR_EXIT_CODE.AUTH
  }
  if (error.code === 'NETWORK_ERROR' || error.code === 'HTTP_ERROR') {
    return SIDECAR_EXIT_CODE.NETWORK
  }
  return SIDECAR_EXIT_CODE.IO
}

function parseOptions(args, spec) {
  const values = {}
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]
    const equal = token.indexOf('=')
    const key = equal >= 0 ? token.slice(2, equal) : token.slice(2)
    if (!token.startsWith('--') || !spec[key]) {
      throw new AgentError('CONFIG_INVALID', `未知参数 ${token}`)
    }
    if (spec[key].flag) {
      if (equal >= 0) {
        throw new AgentError('CONFIG_INVALID', `参数 --${key} 不接受值`)
      }
      values[key] = true
      continue
    }
    const value = equal >= 0 ? token.slice(equal + 1) : args[++index]
    if (!value) {
      throw new AgentError('CONFIG_INVALID', `参数 --${key} 缺少值`)
    }
    values[key] = value
  }
  return values
}

function requireOption(values, key) {
  if (!values[key]) {
    throw new AgentError('CONFIG_INVALID', `缺少参数 --${key}`)
  }
  return values[key]
}

async function withEphemeralHooks(callback) {
  const hooksDir = await fs.mkdtemp(path.join(os.tmpdir(), 'trellis-agent-hooks-'))
  try {
    return await callback(hooksDir)
  } finally {
    await fs.rm(hooksDir, { recursive: true }).catch(() => {})
  }
}

async function allowLocalGitRemotes() {
  const config = await new ConfigStore().readConfig()
  return config?.allowLocalGitRemotes === true
}

async function readSecret() {
  if (process.stdin.isTTY) {
    throw new AgentError('CONFIG_INVALID', '桌面敏感输入必须由客户端通过标准输入提供')
  }
  const reader = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
  try {
    for await (const line of reader) {
      const value = line.trim()
      if (value) return value
    }
  } finally {
    reader.close()
  }
  throw new AgentError('CONFIG_INVALID', '没有收到标准输入')
}

async function readJsonInput() {
  const payload = await readSecret()
  try {
    const value = JSON.parse(payload)
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('not object')
    }
    return value
  } catch {
    throw new AgentError('CONFIG_INVALID', '标准输入必须是单个 JSON 对象')
  }
}

async function extractSeaAsset(key, directory) {
  if (!sea.isSea()) return null
  let bytes
  try {
    bytes = Buffer.from(sea.getAsset(key))
  } catch {
    return null
  }
  const target = path.join(directory, key)
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
  await fs.writeFile(target, bytes, { mode: 0o600 })
  return target
}

async function prepareAgent(store, fallbackDpapiScript) {
  const scriptFile = await extractSeaAsset(DPAPI_ASSET, path.join(store.paths.root, 'windows'))
  const resolvedScriptFile = scriptFile || fallbackDpapiScript
  if (!resolvedScriptFile) {
    throw new AgentError('CONFIG_INVALID', 'sidecar 缺少 DPAPI helper，无法初始化凭证存储')
  }
  return {
    store,
    credentialStore: new DpapiCredentialStore(store, {
      scriptFile: resolvedScriptFile,
    }),
  }
}

async function commandRun(options) {
  const store = new ConfigStore()
  await store.ensureDirectories()
  const agent = await prepareAgent(store, options.fallbackDpapiScript)
  const controller = new AbortController()
  const stop = () => controller.abort()
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  try {
    const result = await runAgentProcess({
      store: agent.store,
      credentialStore: agent.credentialStore,
      emitControl: (event) => process.stdout.write(liveControlLine(event)),
      signal: controller.signal,
    })
    return result.exitCode === 0 ? SIDECAR_EXIT_CODE.OK : result.exitCode || 1
  } finally {
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
  }
}

async function commandLogin(args, options) {
  const values = parseOptions(args, {
    server: {},
    name: {},
    'force-new': { flag: true },
  })
  const credentials = await readJsonInput()
  const store = new ConfigStore()
  const agent = await prepareAgent(store, options.fallbackDpapiScript)
  const result = await loginDesktop({
    serverUrl: requireOption(values, 'server'),
    username: credentials.username,
    password: credentials.password,
    deviceName: validateDeviceName(values.name),
    store: agent.store,
    credentialStore: agent.credentialStore,
    forceNew: values['force-new'] === true,
  })
  writeJson({ ok: true, ...result })
  return SIDECAR_EXIT_CODE.OK
}

async function commandLogout(args) {
  const values = parseOptions(args, { server: {} })
  const input = await readJsonInput()
  const result = await logoutDesktopSession({
    serverUrl: requireOption(values, 'server'),
    sessionToken: input.sessionToken,
  })
  writeJson({ ok: true, ...result })
  return SIDECAR_EXIT_CODE.OK
}

async function commandRevoke(args) {
  const values = parseOptions(args, { server: {}, agent: {} })
  const sessionCookie = process.env.TRELLIS_BOARD_SESSION || ''
  const result = await revokeDesktopDevice({
    serverUrl: requireOption(values, 'server'),
    agentId: validateAgentId(requireOption(values, 'agent')),
    sessionCookie,
  })
  writeJson({ ok: true, ...result })
  return SIDECAR_EXIT_CODE.OK
}

async function commandStatus(args) {
  const values = parseOptions(args, { root: {} })
  const identity = await readAgentIdentity(values.root || undefined)
  writeJson({ ok: true, ...identity })
  return SIDECAR_EXIT_CODE.OK
}

async function commandAssociate(args, options) {
  const values = parseOptions(args, {
    path: {},
    branch: {},
    team: {},
    developer: {},
    name: {},
    'initial-mode': {},
    'require-pushed': { flag: true },
  })
  const store = new ConfigStore()
  const agent = await prepareAgent(store, options.fallbackDpapiScript)
  const result = await associateDesktopProject({
    teamId: requireOption(values, 'team'),
    developerId: requireOption(values, 'developer'),
    repoPath: requireOption(values, 'path'),
    branchName: requireOption(values, 'branch'),
    displayName: values.name || null,
    requirePushed: values['require-pushed'] === true,
    initialSyncMode: requireOption(values, 'initial-mode'),
    store: agent.store,
    credentialStore: agent.credentialStore,
  })
  writeJson({ ok: true, ...result })
  return SIDECAR_EXIT_CODE.OK
}

async function commandPreflightProject(args, options) {
  const values = parseOptions(args, {
    path: {},
    team: {},
    'require-pushed': { flag: true },
  })
  const store = new ConfigStore()
  const agent = await prepareAgent(store, options.fallbackDpapiScript)
  const result = await preflightDesktopProject({
    teamId: requireOption(values, 'team'),
    repoPath: requireOption(values, 'path'),
    requirePushed: values['require-pushed'] === true,
    store: agent.store,
    credentialStore: agent.credentialStore,
  })
  writeJson({ ok: true, ...result })
  return SIDECAR_EXIT_CODE.OK
}

async function commandInspectProject(args) {
  const values = parseOptions(args, { path: {} })
  const root = path.resolve(requireOption(values, 'path'))
  const allowFileRemote = await allowLocalGitRemotes()
  const inspected = await withEphemeralHooks((hooksDir) =>
    inspectProject({
      repoPath: root,
      hooksDir,
      allowFileRemote,
    }),
  )
  writeJson({ ok: true, project: inspected })
  return SIDECAR_EXIT_CODE.OK
}

async function commandInitializeProject(args, options) {
  const values = parseOptions(args, {
    path: {},
    developer: {},
    tools: {},
    runtime: {},
  })
  const root = path.resolve(requireOption(values, 'path'))
  const tools = requireOption(values, 'tools')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  const allowFileRemote = await allowLocalGitRemotes()
  const project = await withEphemeralHooks((hooksDir) =>
    initializeProject({
      repoPath: root,
      hooksDir,
      developerId: requireOption(values, 'developer'),
      agentTools: tools,
      allowFileRemote,
      initialize: (input) =>
        initializeTrellis({
          ...input,
          runtime: values.runtime || null,
          resourcesPath: options.resourcesPath,
          applicationDir: options.applicationDir,
        }),
    }),
  )
  writeJson({ ok: true, project })
  return SIDECAR_EXIT_CODE.OK
}

async function commandCheckPush(args) {
  const values = parseOptions(args, { path: {}, branch: {} })
  const root = path.resolve(requireOption(values, 'path'))
  const allowFileRemote = await allowLocalGitRemotes()
  const result = await withEphemeralHooks((hooksDir) =>
    checkInitialPush({
      repoPath: root,
      branchName: requireOption(values, 'branch'),
      hooksDir,
      allowFileRemote,
    }),
  )
  writeJson({ ok: true, ...result })
  return SIDECAR_EXIT_CODE.OK
}

async function commandAssociations() {
  writeJson({ ok: true, associations: await readLocalAssociations() })
  return SIDECAR_EXIT_CODE.OK
}

async function commandLiveDecide(args, options) {
  const values = parseOptions(args, {
    'task-space': {},
    conflict: {},
    action: {},
  })
  const store = new ConfigStore()
  const agent = await prepareAgent(store, options.fallbackDpapiScript)
  const config = await store.readConfig({ allowMissing: false })
  const credential = await agent.credentialStore.loadCredential()
  const api = new AgentApiClient({
    serverUrl: config.serverUrl,
    credential,
  })
  const taskSync = new AgentTaskSnapshotSync({
    store,
    loadContext: async () => ({ config, credential, api }),
  })
  taskSync.updateBindings(config.bindings)
  const result = await taskSync.decideConflict({
    taskSpaceId: requireOption(values, 'task-space'),
    conflictId: requireOption(values, 'conflict'),
    action: requireOption(values, 'action'),
  })
  writeJson({ ok: true, ...result })
  return SIDECAR_EXIT_CODE.OK
}

async function commandLiveDiff(args, options) {
  const values = parseOptions(args, {
    'task-space': {},
    conflict: {},
  })
  const store = new ConfigStore()
  const agent = await prepareAgent(store, options.fallbackDpapiScript)
  const config = await store.readConfig({ allowMissing: false })
  const credential = await agent.credentialStore.loadCredential()
  const api = new AgentApiClient({
    serverUrl: config.serverUrl,
    credential,
  })
  const taskSync = new AgentTaskSnapshotSync({
    store,
    loadContext: async () => ({ config, credential, api }),
  })
  taskSync.updateBindings(config.bindings)
  const result = await taskSync.conflictDetails({
    taskSpaceId: requireOption(values, 'task-space'),
    conflictId: requireOption(values, 'conflict'),
  })
  writeJson({ ok: true, ...result })
  return SIDECAR_EXIT_CODE.OK
}

async function commandLiveInitial(args, options) {
  const values = parseOptions(args, {
    'task-space': {},
    mode: {},
  })
  const mode = requireOption(values, 'mode')
  if (!new Set(['safe', 'review']).has(mode)) {
    throw new AgentError('CONFIG_INVALID', '首次同步处理方式无效')
  }
  const store = new ConfigStore()
  const agent = await prepareAgent(store, options.fallbackDpapiScript)
  const config = await store.readConfig({ allowMissing: false })
  const credential = await agent.credentialStore.loadCredential()
  const api = new AgentApiClient({
    serverUrl: config.serverUrl,
    credential,
  })
  const taskSync = new AgentTaskSnapshotSync({
    store,
    loadContext: async () => ({ config, credential, api }),
  })
  taskSync.updateBindings(config.bindings)
  const taskSpaceId = requireOption(values, 'task-space')
  const input = mode === 'review' ? await readJsonInput() : {}
  const result = await taskSync.resolveInitialSync({
    taskSpaceId,
    mode,
    decisions: Array.isArray(input.decisions) ? input.decisions : [],
  })
  writeJson({ ok: true, ...result })
  return SIDECAR_EXIT_CODE.OK
}

async function commandLiveRestore(args, options) {
  const values = parseOptions(args, { backup: {} })
  const store = new ConfigStore()
  const agent = await prepareAgent(store, options.fallbackDpapiScript)
  const result = await restoreLiveBackup({
    store: agent.store,
    credentialStore: agent.credentialStore,
    backupId: requireOption(values, 'backup'),
  })
  writeJson({ ok: true, ...result })
  return SIDECAR_EXIT_CODE.OK
}

function usage() {
  return [
    'trellis-agent-sidecar <command>',
    '  run',
    '  login --server <URL> --name <设备名> [--force-new]  (用户名和密码从标准输入 JSON 读取)',
    '  logout --server <URL> (会话 Token 从标准输入 JSON 读取)',
    '  preflight-project --path <仓库根目录> --team <团队 ID> [--require-pushed]',
    '  associate --path <仓库根目录> --branch <同步分支> --team <团队 ID> --developer <Trellis ID> --initial-mode bootstrap|safe|review',
    '  inspect-project --path <仓库根目录>',
    '  initialize-project --path <仓库根目录> --developer <Trellis ID> --tools <id,id>',
    '  check-push --path <仓库根目录> --branch <同步分支>',
    '  associations',
    '  live-decide --task-space <任务空间 ID> --conflict <冲突 ID> --action use-server|overwrite-server|save-local-copy',
    '  live-diff --task-space <任务空间 ID> --conflict <冲突 ID>',
    '  live-initial --task-space <任务空间 ID> --mode safe|review',
    '  live-restore --backup <备份 ID>',
    '  revoke --server <URL> --agent <设备 ID> (会话 Cookie 从 TRELLIS_BOARD_SESSION 读取)',
    '  status [--root <Agent 数据目录>]',
    '  version',
  ].join('\n')
}

export async function runSidecarMain(argv = process.argv.slice(2), options = {}) {
  const [command = 'run', ...args] = argv
  const stopParentWatchdog = startParentWatchdog({
    onParentExit: () => process.exit(SIDECAR_EXIT_CODE.IO),
  })
  try {
    switch (command) {
      case 'run':
        return await commandRun(options)
      case 'login':
        return await commandLogin(args, options)
      case 'logout':
        return await commandLogout(args)
      case 'associate':
        return await commandAssociate(args, options)
      case 'preflight-project':
        return await commandPreflightProject(args, options)
      case 'inspect-project':
        return await commandInspectProject(args)
      case 'initialize-project':
        return await commandInitializeProject(args, options)
      case 'check-push':
        return await commandCheckPush(args)
      case 'associations':
        return await commandAssociations()
      case 'live-decide':
        return await commandLiveDecide(args, options)
      case 'live-diff':
        return await commandLiveDiff(args, options)
      case 'live-initial':
        return await commandLiveInitial(args, options)
      case 'live-restore':
        return await commandLiveRestore(args, options)
      case 'revoke':
        return await commandRevoke(args)
      case 'status':
        return await commandStatus(args)
      case 'version':
        writeJson({
          ok: true,
          agentVersion: AGENT_VERSION,
          protocolVersion: AGENT_PROTOCOL_VERSION,
        })
        return SIDECAR_EXIT_CODE.OK
      case 'help':
      case '--help':
      case '-h':
        process.stdout.write(`${usage()}\n`)
        return SIDECAR_EXIT_CODE.OK
      default:
        process.stderr.write(`未知命令：${command}\n${usage()}\n`)
        return SIDECAR_EXIT_CODE.USAGE
    }
  } catch (error) {
    const message = safeErrorMessage(error)
    process.stderr.write(`${message}\n`)
    if (command !== 'run') {
      writeJson({
        ok: false,
        error: message,
        ...(typeof error?.code === 'string' ? { code: error.code } : {}),
      })
    }
    return exitCodeFor(error)
  } finally {
    stopParentWatchdog()
  }
}
