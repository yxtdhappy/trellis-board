import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { AgentApiClient, loadCaFile } from './api.js'
import {
  CONFIG_SCHEMA_VERSION,
  ConfigStore,
  createConfigRevision,
  defaultAgentRoot,
} from './config-store.js'
import { DpapiCredentialStore } from './credential-store.js'
import { inspectRepository } from './git-sync.js'
import { runAgentProcess } from './index.js'
import {
  AgentError,
  AGENT_ERROR_CODE,
  AGENT_PROTOCOL_VERSION,
  AGENT_VERSION,
  isAuthenticationError,
  isLoopbackHostname,
  normalizeServerUrl,
  safeErrorMessage,
  validateBranchNameSyntax,
  validatePairingCode,
} from './protocol.js'
import { buildEnvironment, runProcess } from './process.js'
import { initializeWorkspace, WORKSPACE_ERROR_CODE, WorkspaceBootstrapError } from './workspace.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DPAPI_SCRIPT_FILE = path.join(HERE, 'windows', 'dpapi.ps1')
const SERVICE_SCRIPT = path.join(HERE, 'windows', 'service.ps1')
const SERVICE_TASK_NAME = 'TrellisBoardAgent'

function createCredentialStore(store) {
  return new DpapiCredentialStore(store, { scriptFile: DPAPI_SCRIPT_FILE })
}

export const CLI_EXIT_CODE = Object.freeze({
  OK: 0,
  USAGE: 2,
  CONFIG: 3,
  AUTH: 4,
  NETWORK: 5,
  WINDOWS_ONLY: 6,
  LOCKED: 7,
  CHECK_FAILED: 8,
  WORKSPACE_CONFLICT: 9,
  WORKSPACE_PERMISSION: 10,
  WORKSPACE_OFFLINE: 11,
  WORKSPACE_TEMPLATE: 12,
})

const COMMAND_HELP = Object.freeze({
  pair: 'pair --server <URL> --name <设备名> [--ca <绝对路径>] [--replace]',
  bind: 'bind --task-space <任务空间 ID> --project <项目 ID> --path <仓库根目录> --branch <同步分支>',
  unbind: 'unbind (--project <项目 ID> | --binding <本地绑定 ID>)',
  status: 'status [--json]',
  diagnose: 'diagnose [--json] [--offline]',
  run: 'run',
  service: 'service <install|uninstall|status>',
  workspace:
    'workspace <init|status> --path <绝对路径> [--tools .opencode,.agents] [--username <name>] --team <ID> [--json]',
})

function usageText() {
  return [
    'Trellis Board Windows Agent',
    '',
    ...Object.values(COMMAND_HELP).map((line) => `  ${line}`),
    '',
    '配对码始终通过关闭回显的交互提示输入，不接受命令行参数。',
  ].join('\n')
}

function writeLine(io, text = '') {
  io.stdout.write(`${text}\n`)
}

function writeJson(io, value) {
  io.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function parseOptions(args, spec) {
  const values = {}
  const positionals = []
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]
    if (token === '--help' || token === '-h') {
      values.help = true
      continue
    }
    if (!token.startsWith('--')) {
      positionals.push(token)
      continue
    }
    const equal = token.indexOf('=')
    const key = equal >= 0 ? token.slice(2, equal) : token.slice(2)
    const definition = spec[key]
    if (!definition) {
      throw new AgentError(AGENT_ERROR_CODE.CONFIG_INVALID, `未知参数 --${key}`)
    }
    if (Object.hasOwn(values, key)) {
      throw new AgentError(AGENT_ERROR_CODE.CONFIG_INVALID, `参数 --${key} 重复`)
    }
    if (definition.boolean) {
      if (equal >= 0) {
        throw new AgentError(AGENT_ERROR_CODE.CONFIG_INVALID, `参数 --${key} 不接受值`)
      }
      values[key] = true
      continue
    }
    const value = equal >= 0 ? token.slice(equal + 1) : args[++index]
    if (value == null || value === '') {
      throw new AgentError(AGENT_ERROR_CODE.CONFIG_INVALID, `参数 --${key} 缺少值`)
    }
    values[key] = value
  }
  return { values, positionals }
}

function requireOption(values, key) {
  if (!values[key]) {
    throw new AgentError(AGENT_ERROR_CODE.CONFIG_INVALID, `缺少参数 --${key}`)
  }
  return values[key]
}

function validateDeviceName(value) {
  const name = String(value || '').trim()
  if (!name || Array.from(name).length > 80 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new AgentError(AGENT_ERROR_CODE.CONFIG_INVALID, '设备名格式无效')
  }
  return name
}

function validateProjectId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new AgentError(AGENT_ERROR_CODE.CONFIG_INVALID, '项目 ID 格式无效')
  }
  return value
}

export function createTerminalSecretReader(input = process.stdin, output = process.stderr) {
  return (prompt) =>
    new Promise((resolve, reject) => {
      if (!input.isTTY || typeof input.setRawMode !== 'function') {
        reject(new AgentError(AGENT_ERROR_CODE.CONFIG_INVALID, '配对码必须从交互式终端输入'))
        return
      }
      let value = ''
      const wasRaw = input.isRaw
      readline.emitKeypressEvents(input)
      input.setRawMode(true)
      input.resume()
      output.write(prompt)

      const cleanup = () => {
        input.removeListener('keypress', onKeypress)
        input.removeListener('error', onError)
        input.setRawMode(Boolean(wasRaw))
        input.pause()
        output.write('\n')
      }
      const finish = (error) => {
        cleanup()
        if (error) {
          reject(error)
        } else {
          resolve(value)
        }
      }
      const onError = (error) => finish(error)
      const onKeypress = (text, key = {}) => {
        if (key.ctrl && key.name === 'c') {
          finish(new AgentError(AGENT_ERROR_CODE.CONFIG_INVALID, '已取消配对输入'))
          return
        }
        if (key.name === 'return' || key.name === 'enter') {
          finish(null)
          return
        }
        if (key.name === 'backspace') {
          if (value) {
            value = value.slice(0, -1)
            output.write('\b \b')
          }
          return
        }
        if (text && !key.ctrl && !key.meta && /^[\x21-\x7e]+$/.test(text)) {
          value += text
          output.write('*'.repeat(text.length))
        }
      }
      input.on('keypress', onKeypress)
      input.once('error', onError)
    })
}

async function commandPair(args, context) {
  const { values, positionals } = parseOptions(args, {
    server: {},
    name: {},
    ca: {},
    replace: { boolean: true },
  })
  if (positionals.length) {
    throw new AgentError(AGENT_ERROR_CODE.CONFIG_INVALID, 'pair 不接受位置参数')
  }
  const serverUrl = normalizeServerUrl(requireOption(values, 'server'))
  const deviceName = validateDeviceName(values.name || os.hostname())
  if (values.ca && !path.isAbsolute(values.ca)) {
    throw new AgentError(AGENT_ERROR_CODE.CONFIG_INVALID, 'CA 文件必须使用绝对路径')
  }
  const caFile = values.ca ? path.resolve(values.ca) : null
  const ca = await loadCaFile(caFile)
  const store = context.store
  const existing = await store.readConfig()
  if (existing && !values.replace) {
    throw new AgentError(
      AGENT_ERROR_CODE.CONFIG_INVALID,
      '当前电脑已经配对；如需更换账号，请显式使用 --replace',
    )
  }
  const pairingCode = validatePairingCode(
    (await context.readSecret('配对码（输入不回显）：')).trim(),
  )
  const client = new AgentApiClient({ serverUrl, ca })
  let enrolled
  try {
    enrolled = await client.enroll({ pairingCode, deviceName })
  } catch (error) {
    if (isAuthenticationError(error)) {
      throw new AgentError(AGENT_ERROR_CODE.AUTH_REVOKED, '配对码无效、已使用或已过期')
    }
    throw error
  }
  if (enrolled.protocolVersion !== AGENT_PROTOCOL_VERSION) {
    throw new AgentError(
      AGENT_ERROR_CODE.PROTOCOL_INCOMPATIBLE,
      '服务端 Agent 协议版本与当前客户端不兼容',
    )
  }
  const now = new Date().toISOString()
  const config = {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    revision: createConfigRevision(),
    serverUrl,
    caFile,
    agentId: enrolled.agentId,
    deviceName,
    username: enrolled.username || null,
    teamId: enrolled.teamId || null,
    teams: Array.isArray(enrolled.teams) ? enrolled.teams : [],
    protocolVersion: AGENT_PROTOCOL_VERSION,
    agentVersion: AGENT_VERSION,
    pairedAt: now,
    bindings: [],
  }
  const credentialStore = context.credentialStore
  await store.updateConfig(
    async (current) => {
      if (current && !values.replace) {
        throw new AgentError(
          AGENT_ERROR_CODE.CONFIG_INVALID,
          '当前电脑在配对期间已被其他进程绑定，请重试',
        )
      }
      await credentialStore.saveCredential(enrolled.credential)
      return config
    },
    { allowMissing: true },
  )
  if (context.json) {
    writeJson(context.io, {
      paired: true,
      serverUrl,
      agentId: enrolled.agentId,
      deviceName,
      replaced: Boolean(existing),
    })
  } else {
    writeLine(context.io, `配对成功：${deviceName}`)
    writeLine(context.io, `Agent ID：${enrolled.agentId}`)
    if (existing) {
      writeLine(context.io, '原有本地项目绑定已清空，请在服务端重新确认。')
    }
  }
  return CLI_EXIT_CODE.OK
}

async function commandBind(args, context) {
  const { values, positionals } = parseOptions(args, {
    'task-space': {},
    project: {},
    path: {},
    branch: {},
  })
  if (positionals.length) {
    throw new AgentError(AGENT_ERROR_CODE.CONFIG_INVALID, 'bind 不接受位置参数')
  }
  const taskSpaceId = validateProjectId(requireOption(values, 'task-space'))
  const projectId = validateProjectId(requireOption(values, 'project'))
  const branchName = validateBranchNameSyntax(requireOption(values, 'branch'))
  const repoPath = path.resolve(requireOption(values, 'path'))
  const config = await context.store.readConfig({ allowMissing: false })
  const localId = crypto.randomUUID()
  const hooksDir = path.join(context.store.paths.hooksBaseDir, localId)
  await fs.mkdir(hooksDir, { recursive: true, mode: 0o700 })
  const allowFileRemote = isLoopbackHostname(new URL(config.serverUrl).hostname)
  const inspected = await inspectRepository({
    repoPath,
    branchName,
    hooksDir,
    allowFileRemote,
  })
  const binding = {
    localId,
    serverBindingId: null,
    taskSpaceId,
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
    syncStatus: 'pending',
    liveSyncStatus: 'pending',
    liveSyncError: null,
    lastSyncedAt: null,
    lastHead: inspected.head,
    lastError: inspected.clean ? null : '本地工作区存在未提交或未跟踪文件',
    lastErrorCode: inspected.clean ? null : AGENT_ERROR_CODE.LOCAL_DIRTY,
  }
  await context.store.updateConfig(
    (current) => {
      if (current.bindings.some((item) => item.taskSpaceId === taskSpaceId)) {
        throw new AgentError(AGENT_ERROR_CODE.CONFIG_INVALID, '该任务空间已经绑定本地仓库')
      }
      if (current.bindings.some((item) => item.localRepoKey === binding.localRepoKey)) {
        throw new AgentError(AGENT_ERROR_CODE.CONFIG_INVALID, '该本地仓库已经绑定其他项目')
      }
      return {
        ...current,
        bindings: [...current.bindings, binding],
      }
    },
    { allowMissing: false },
  )
  const summary = {
    localId,
    taskSpaceId,
    projectId,
    displayName: binding.displayName,
    branchName,
    head: inspected.head,
    clean: inspected.clean,
    status: 'pending',
  }
  if (context.json) {
    writeJson(context.io, summary)
  } else {
    writeLine(context.io, `已创建待确认绑定：${taskSpaceId}`)
    writeLine(context.io, `仓库：${binding.displayName}`)
    writeLine(context.io, `分支：${branchName}   HEAD：${inspected.head.slice(0, 12)}`)
    if (!inspected.clean) {
      writeLine(context.io, '当前工作区不干净，后台心跳仍会上报，但同步会被拒绝。')
    }
    writeLine(context.io, '请在 Web 项目设备页由项目负责人确认绑定。')
  }
  return CLI_EXIT_CODE.OK
}

async function commandUnbind(args, context) {
  const { values, positionals } = parseOptions(args, {
    project: {},
    binding: {},
  })
  if (positionals.length || Boolean(values.project) === Boolean(values.binding)) {
    throw new AgentError(
      AGENT_ERROR_CODE.CONFIG_INVALID,
      'unbind 必须且只能指定 --project 或 --binding',
    )
  }
  let removed = null
  await context.store.updateConfig((config) => {
    const binding = config.bindings.find((item) =>
      values.project
        ? item.projectId === validateProjectId(values.project)
        : item.localId === values.binding,
    )
    if (!binding) {
      throw new AgentError(AGENT_ERROR_CODE.CONFIG_INVALID, '未找到指定本地绑定')
    }
    removed = binding
    return {
      ...config,
      bindings: config.bindings.filter((item) => item.localId !== binding.localId),
    }
  })
  if (!removed) {
    throw new AgentError(AGENT_ERROR_CODE.CONFIG_INVALID, '未找到指定本地绑定')
  }
  writeLine(context.io, `已移除本地绑定：${removed.projectId}`)
  writeLine(context.io, '服务端设备授权请在 Web 项目管理页撤销。')
  return CLI_EXIT_CODE.OK
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false
  }
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function commandStatus(args, context) {
  const { positionals } = parseOptions(args, { json: { boolean: true } })
  if (positionals.length) {
    throw new AgentError(AGENT_ERROR_CODE.CONFIG_INVALID, 'status 不接受位置参数')
  }
  const config = await context.store.readConfig()
  const state = await context.store.readState()
  const running = state?.status === 'running' && isProcessAlive(state.pid)
  const result = config
    ? {
        paired: true,
        serverUrl: config.serverUrl,
        agentId: config.agentId,
        deviceName: config.deviceName,
        agentVersion: AGENT_VERSION,
        running,
        runtimeStatus: running ? 'running' : state?.status || 'stopped',
        lastHeartbeatAt: state?.lastHeartbeatAt || null,
        lastHeartbeatError: state?.lastHeartbeatError || null,
        configRevision: config.revision,
        bindings: config.bindings.map((binding) => ({
          localId: binding.localId,
          serverBindingId: binding.serverBindingId,
          taskSpaceId: binding.taskSpaceId,
          projectId: binding.projectId,
          repoPath: binding.repoPath,
          branchName: binding.branchName,
          readOnly: binding.readOnly === true,
          status: binding.syncStatus,
          liveSyncStatus: binding.liveSyncStatus,
          liveSyncError: binding.liveSyncError,
          lastHead: binding.lastHead,
          lastSyncedAt: binding.lastSyncedAt,
          lastErrorCode: binding.lastErrorCode,
          lastError: binding.lastError,
        })),
      }
    : {
        paired: false,
        running: false,
        agentVersion: AGENT_VERSION,
        runtimeStatus: 'unpaired',
        bindings: [],
      }
  if (context.json) {
    writeJson(context.io, result)
    return CLI_EXIT_CODE.OK
  }
  writeLine(
    context.io,
    `Agent：${result.paired ? `${result.deviceName} (${result.agentId})` : '未配对'}`,
  )
  writeLine(context.io, `运行状态：${result.runtimeStatus}`)
  if (result.paired) {
    writeLine(context.io, `服务地址：${result.serverUrl}`)
    writeLine(context.io, `最近心跳：${result.lastHeartbeatAt || '无'}`)
  }
  if (!result.bindings.length) {
    writeLine(context.io, '本地项目绑定：无')
  } else {
    writeLine(context.io, '本地项目绑定：')
    for (const binding of result.bindings) {
      writeLine(
        context.io,
        `  ${binding.taskSpaceId}  ${binding.branchName}  ${binding.status}  ` +
          `实时同步:${binding.liveSyncStatus}  ${binding.repoPath}`,
      )
      if (binding.liveSyncError) {
        writeLine(context.io, `    实时同步错误：${binding.liveSyncError}`)
      }
      if (binding.lastError) {
        writeLine(context.io, `    错误：${binding.lastErrorCode || 'ERROR'} ${binding.lastError}`)
      }
    }
  }
  return CLI_EXIT_CODE.OK
}

async function commandDiagnose(args, context) {
  const { values, positionals } = parseOptions(args, {
    json: { boolean: true },
    offline: { boolean: true },
  })
  if (positionals.length) {
    throw new AgentError(AGENT_ERROR_CODE.CONFIG_INVALID, 'diagnose 不接受位置参数')
  }
  const checks = []
  const addCheck = (name, ok, message, code = null) => {
    checks.push({ name, ok, message, code })
  }
  let config
  try {
    config = await context.store.readConfig({ allowMissing: false })
    addCheck('配置', true, '配置读取成功')
  } catch (error) {
    addCheck('配置', false, safeErrorMessage(error), error.code)
    return finishDiagnose(context, checks)
  }
  const credentialStore = context.credentialStore
  try {
    await credentialStore.selfTest()
    addCheck('DPAPI', true, 'CurrentUser 加解密往返成功')
  } catch (error) {
    addCheck('DPAPI', false, safeErrorMessage(error), error.code)
  }
  let credential = null
  try {
    credential = await credentialStore.loadCredential()
    addCheck('凭证', true, `DPAPI 凭证可解密（长度 ${credential.length}）`)
  } catch (error) {
    addCheck('凭证', false, safeErrorMessage(error), error.code)
  }
  if (!values.offline) {
    try {
      const ca = await loadCaFile(config.caFile)
      const client = new AgentApiClient({
        serverUrl: config.serverUrl,
        credential,
        ca,
      })
      await client.health()
      addCheck('服务端', true, 'Agent 服务健康检查成功')
    } catch (error) {
      addCheck('服务端', false, safeErrorMessage(error), error.code)
    }
  }
  for (const binding of config.bindings) {
    try {
      const inspected = await inspectRepository({
        repoPath: binding.repoPath,
        branchName: binding.branchName,
        hooksDir: path.join(context.store.paths.hooksBaseDir, binding.localId),
        expectedRemoteIdentity: binding.remoteIdentityKey,
        allowFileRemote: binding.allowFileRemote,
      })
      addCheck(
        `仓库 ${binding.displayName}`,
        inspected.clean,
        inspected.clean
          ? `分支与远端匹配，HEAD ${inspected.head.slice(0, 12)}`
          : '工作区存在未提交或未跟踪文件',
        inspected.clean ? null : AGENT_ERROR_CODE.LOCAL_DIRTY,
      )
    } catch (error) {
      addCheck(`仓库 ${binding.displayName}`, false, safeErrorMessage(error), error.code)
    }
  }
  return finishDiagnose(context, checks)
}

function finishDiagnose(context, checks) {
  const ok = checks.every((check) => check.ok)
  if (context.json) {
    writeJson(context.io, { ok, checks })
  } else {
    for (const check of checks) {
      writeLine(context.io, `[${check.ok ? 'OK' : 'FAIL'}] ${check.name}：${check.message}`)
    }
  }
  return ok ? CLI_EXIT_CODE.OK : CLI_EXIT_CODE.CHECK_FAILED
}

function fixedPowerShellPath() {
  return path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  )
}

async function runServiceAction(action) {
  if (process.platform !== 'win32') {
    throw new AgentError(AGENT_ERROR_CODE.CONFIG_INVALID, '用户级计划任务仅支持 Windows')
  }
  const args = [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    SERVICE_SCRIPT,
    '-Action',
    action,
    '-TaskName',
    SERVICE_TASK_NAME,
  ]
  if (action === 'install') {
    args.push(
      '-NodePath',
      process.execPath,
      '-EntryPath',
      path.join(HERE, 'cli.js'),
      '-WorkingDirectory',
      path.dirname(HERE),
      '-AgentRoot',
      defaultAgentRoot(),
    )
  }
  const result = await runProcess(fixedPowerShellPath(), args, {
    env: buildEnvironment(),
    timeoutMs: 60_000,
    maxOutputBytes: 262_144,
  })
  if (result.exitCode !== 0) {
    throw new AgentError(
      AGENT_ERROR_CODE.CONFIG_INVALID,
      `计划任务${action}失败：${safeErrorMessage(new Error(result.stderr))}`,
    )
  }
  const output = result.stdout.trim()
  try {
    return output ? JSON.parse(output) : { action, ok: true }
  } catch {
    return { action, ok: true }
  }
}

async function commandService(args, context) {
  if (process.platform !== 'win32') {
    throw new AgentError(AGENT_ERROR_CODE.CONFIG_INVALID, '用户级计划任务仅支持 Windows')
  }
  const action = args[0]
  if (!['install', 'uninstall', 'status'].includes(action) || args.length !== 1) {
    throw new AgentError(
      AGENT_ERROR_CODE.CONFIG_INVALID,
      'service 只支持 install、uninstall 或 status',
    )
  }
  if (action === 'install') {
    await context.store.readConfig({ allowMissing: false })
  }
  const result = await runServiceAction(action)
  if (context.json) {
    writeJson(context.io, result)
  } else if (action === 'install') {
    writeLine(context.io, '登录自启计划任务已安装并启动。')
  } else if (action === 'uninstall') {
    writeLine(context.io, '登录自启计划任务已卸载；本地配置和仓库未删除。')
  } else {
    writeLine(context.io, `计划任务状态：${result.state || result.status || 'unknown'}`)
  }
  return CLI_EXIT_CODE.OK
}

function parseWorkspaceTools(value) {
  if (value == null) return null
  const tools = String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  if (!tools.length) {
    throw new AgentError(AGENT_ERROR_CODE.CONFIG_INVALID, '--tools 至少需要一个工具目录')
  }
  for (const tool of tools) {
    if (!/^\.[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(tool)) {
      throw new AgentError(AGENT_ERROR_CODE.CONFIG_INVALID, `工具目录格式无效：${tool}`)
    }
  }
  return tools
}

function readWorkspaceDeveloper(workspacePath) {
  try {
    const content = fsSync.readFileSync(path.join(workspacePath, '.trellis', '.developer'), 'utf8')
    const match = /^name=(.*)$/m.exec(content)
    return match ? match[1].trim() : null
  } catch {
    return null
  }
}

async function resolveWorkspaceUsername(context, values, workspacePath) {
  if (values.username) return values.username
  const config = await context.store.readConfig()
  if (config?.username) return config.username
  return readWorkspaceDeveloper(workspacePath)
}

async function loadWorkspaceCredential(context) {
  if (context.agentCredential) return context.agentCredential
  if (context.workspaceInitializer) return null
  const credentialStore = context.credentialStore
  try {
    return await credentialStore.loadCredential()
  } catch {
    return null
  }
}

function workspaceSummary(result) {
  return {
    workspace: result.workspace,
    developer: result.developer,
    templateVersion: result.templateVersion,
    templateSha256: result.templateSha256,
    source: result.source,
    tools: result.tools,
    created: result.createdFiles?.length ?? 0,
    updated: result.updatedFiles?.length ?? 0,
    skipped: result.skippedFiles?.length ?? 0,
    backupDir: result.backupDir || null,
    developerSwitched: Boolean(result.developerSwitched),
    changed: Boolean(result.changed),
  }
}

async function commandWorkspaceInit(args, context) {
  const { values, positionals } = parseOptions(args, {
    path: {},
    tools: {},
    username: {},
    team: {},
    server: {},
  })
  if (positionals.length) {
    throw new AgentError(AGENT_ERROR_CODE.CONFIG_INVALID, 'workspace init 不接受位置参数')
  }
  const workspacePath = requireOption(values, 'path')
  const tools = parseWorkspaceTools(values.tools)
  const config = await context.store.readConfig()
  const username = await resolveWorkspaceUsername(context, values, workspacePath)
  if (!username) {
    throw new AgentError(
      AGENT_ERROR_CODE.CONFIG_INVALID,
      '缺少登录用户名；请使用 --username 或在 config.json/.trellis/.developer 中提供',
    )
  }
  const teamId =
    values.team || config?.teamId || (config?.teams?.length === 1 ? config.teams[0].id : null)
  if (!teamId) {
    throw new AgentError(
      AGENT_ERROR_CODE.CONFIG_INVALID,
      '请使用 --team 选择要初始化 workspace 的团队',
    )
  }
  const initializer = context.workspaceInitializer || initializeWorkspace
  const result = await initializer({
    workspacePath,
    username,
    tools,
    teamId,
    serverUrl: values.server || config?.serverUrl || null,
    dataRoot: context.store.paths.root,
    agentCredential: await loadWorkspaceCredential(context),
    logger: context.logger,
  })
  const summary = workspaceSummary(result)
  if (context.json) {
    writeJson(context.io, summary)
    return CLI_EXIT_CODE.OK
  }
  writeLine(context.io, `workspace 初始化完成：${summary.workspace}`)
  writeLine(context.io, `developer：${summary.developer}`)
  writeLine(context.io, `模板：${summary.templateVersion}（${summary.source || 'unknown'}）`)
  writeLine(
    context.io,
    `创建 ${summary.created}，更新 ${summary.updated}，跳过 ${summary.skipped}，` +
      `备份：${summary.backupDir || '无'}`,
  )
  return CLI_EXIT_CODE.OK
}

async function commandWorkspaceStatus(args, context) {
  const { values, positionals } = parseOptions(args, { path: {} })
  if (positionals.length) {
    throw new AgentError(AGENT_ERROR_CODE.CONFIG_INVALID, 'workspace status 不接受位置参数')
  }
  const target = requireOption(values, 'path')
  if (!path.isAbsolute(target)) {
    throw new WorkspaceBootstrapError(
      WORKSPACE_ERROR_CODE.PATH_INVALID,
      'workspace 必须使用绝对路径',
    )
  }
  let stat
  try {
    stat = fsSync.lstatSync(target)
  } catch {
    throw new WorkspaceBootstrapError(WORKSPACE_ERROR_CODE.PATH_INVALID, 'workspace 目录不存在')
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new WorkspaceBootstrapError(
      WORKSPACE_ERROR_CODE.PATH_INVALID,
      'workspace 必须是目录且不能是符号链接',
    )
  }
  const trellis = path.join(target, '.trellis')
  let trellisEntry = null
  try {
    trellisEntry = fsSync.lstatSync(trellis)
  } catch {
    trellisEntry = null
  }
  if (trellisEntry?.isSymbolicLink()) {
    throw new WorkspaceBootstrapError(WORKSPACE_ERROR_CODE.PATH_INVALID, '.trellis 不能是符号链接')
  }
  const initialized = Boolean(trellisEntry?.isDirectory())
  const developer = readWorkspaceDeveloper(target)
  let templateVersion = null
  try {
    const hashes = JSON.parse(
      fsSync.readFileSync(path.join(trellis, '.template-hashes.json'), 'utf8'),
    )
    templateVersion = hashes?.templateVersion || null
  } catch {
    templateVersion = null
  }
  const tools = {}
  for (const tool of ['.opencode', '.agents']) {
    const directory = path.join(target, tool)
    let status = 'missing'
    try {
      const entry = fsSync.lstatSync(directory)
      status = entry.isDirectory() && fsSync.readdirSync(directory).length > 0 ? 'present' : 'empty'
    } catch {
      status = 'missing'
    }
    tools[tool] = status
  }
  const summary = {
    workspace: path.basename(path.resolve(target)),
    path: path.resolve(target),
    initialized,
    developer,
    templateVersion,
    tools,
  }
  if (context.json) {
    writeJson(context.io, summary)
  } else {
    writeLine(context.io, `workspace：${summary.workspace}`)
    writeLine(context.io, `已初始化：${initialized ? '是' : '否'}`)
    writeLine(context.io, `developer：${developer || '无'}`)
    writeLine(context.io, `模板版本：${templateVersion || '无'}`)
    for (const [tool, status] of Object.entries(tools)) {
      writeLine(context.io, `${tool}：${status}`)
    }
  }
  return initialized ? CLI_EXIT_CODE.OK : CLI_EXIT_CODE.CHECK_FAILED
}

async function commandWorkspace(args, context) {
  const [subcommand, ...rest] = args
  if (subcommand === 'init') return commandWorkspaceInit(rest, context)
  if (subcommand === 'status') return commandWorkspaceStatus(rest, context)
  throw new AgentError(AGENT_ERROR_CODE.CONFIG_INVALID, 'workspace 只支持 init 或 status')
}

async function commandRun(args, context) {
  if (args.length) {
    throw new AgentError(AGENT_ERROR_CODE.CONFIG_INVALID, 'run 不接受参数')
  }
  const result = await runAgentProcess({
    store: context.store,
    credentialStore: context.credentialStore,
    logger: context.logger,
    signal: context.signal,
  })
  if (result.error) {
    throw result.error
  }
  return result.exitCode
}

function mapCliError(error) {
  if (error instanceof WorkspaceBootstrapError) {
    if (error.code === WORKSPACE_ERROR_CODE.DEVELOPER_CONFLICT) {
      return CLI_EXIT_CODE.WORKSPACE_CONFLICT
    }
    if (
      error.code === WORKSPACE_ERROR_CODE.PATH_INVALID ||
      error.code === WORKSPACE_ERROR_CODE.PATH_UNWRITABLE ||
      error.code === WORKSPACE_ERROR_CODE.USERNAME_INVALID
    ) {
      return CLI_EXIT_CODE.WORKSPACE_PERMISSION
    }
    if (error.code === WORKSPACE_ERROR_CODE.TEMPLATE_UNAVAILABLE) {
      return CLI_EXIT_CODE.WORKSPACE_OFFLINE
    }
    return CLI_EXIT_CODE.WORKSPACE_TEMPLATE
  }
  if (error instanceof AgentError) {
    if (error.code === AGENT_ERROR_CODE.AUTH_REVOKED) {
      return CLI_EXIT_CODE.AUTH
    }
    if (error.code === AGENT_ERROR_CODE.LOCKED) {
      return CLI_EXIT_CODE.LOCKED
    }
    if (
      error.code === AGENT_ERROR_CODE.NETWORK_ERROR ||
      error.code === AGENT_ERROR_CODE.HTTP_ERROR
    ) {
      return CLI_EXIT_CODE.NETWORK
    }
    if (error.code === AGENT_ERROR_CODE.DPAPI_UNAVAILABLE && process.platform !== 'win32') {
      return CLI_EXIT_CODE.WINDOWS_ONLY
    }
    if (
      error.code === AGENT_ERROR_CODE.CONFIG_MISSING ||
      error.code === AGENT_ERROR_CODE.CREDENTIAL_MISSING
    ) {
      return CLI_EXIT_CODE.CONFIG
    }
  }
  return CLI_EXIT_CODE.USAGE
}

export async function runCli(argv = process.argv.slice(2), options = {}) {
  const io = options.io || { stdout: process.stdout, stderr: process.stderr }
  const store = options.store || new ConfigStore(options.root)
  const json = argv.includes('--json')
  const commandArgs = argv.filter((token) => token !== '--json')
  const credentialStore = options.credentialStore || createCredentialStore(store)
  const context = {
    store,
    credentialStore,
    logger: options.logger,
    signal: options.signal,
    readSecret: options.readSecret || createTerminalSecretReader(),
    workspaceInitializer: options.workspaceInitializer,
    agentCredential: options.agentCredential,
    io,
    json,
  }
  const [command, ...args] = commandArgs
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    writeLine(io, usageText())
    return command ? CLI_EXIT_CODE.OK : CLI_EXIT_CODE.USAGE
  }
  try {
    switch (command) {
      case 'pair':
        return await commandPair(args, context)
      case 'bind':
        return await commandBind(args, context)
      case 'unbind':
        return await commandUnbind(args, context)
      case 'status':
        return await commandStatus(args, context)
      case 'diagnose':
        return await commandDiagnose(args, context)
      case 'run':
        return await commandRun(args, context)
      case 'service':
        return await commandService(args, context)
      case 'workspace':
        return await commandWorkspace(args, context)
      default:
        throw new AgentError(AGENT_ERROR_CODE.CONFIG_INVALID, `未知命令：${command}`)
    }
  } catch (error) {
    io.stderr.write(`${safeErrorMessage(error)}\n`)
    return mapCliError(error)
  }
}

export async function runCliMain() {
  const code = await runCli()
  process.exitCode = code
  return code
}

const currentFile = fileURLToPath(import.meta.url)
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  runCliMain().catch((error) => {
    process.stderr.write(`${safeErrorMessage(error)}\n`)
    process.exitCode = CLI_EXIT_CODE.USAGE
  })
}
