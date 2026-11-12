import fs from 'node:fs/promises'
import path from 'node:path'
import { AgentError, AGENT_ERROR_CODE, safeErrorMessage } from '../../agent/protocol.js'
import { runProcess } from '../../agent/process.js'
import { trellisAgentToolFlags } from '../../shared/trellis-agent-tools.js'

const INIT_TIMEOUT_MS = 210_000
const PI_REPAIR_SCRIPT = 'trellis-pi-repair.mjs'

function failedResultMessage(result) {
  const output = result.stderr || result.stdout || `退出码 ${result.exitCode}`
  return safeErrorMessage(new Error(output))
}

function shouldRepairPi(agentTools, result) {
  const output = `${result.stderr}\n${result.stdout}`
  return (
    agentTools.includes('pi') &&
    result.exitCode !== 0 &&
    output.includes('EXDEV') &&
    /\.pi[\\/]extensions[\\/]trellis(?:[\\/]|$)/i.test(output)
  )
}

export async function resolveTrellisRuntime({
  resourcesPath,
  applicationDir,
  executablePath = process.execPath,
} = {}) {
  const roots = [
    resourcesPath ? path.join(resourcesPath, 'trellis-runtime') : null,
    applicationDir ? path.join(applicationDir, 'trellis-runtime') : null,
    path.join(path.dirname(executablePath), 'trellis-runtime'),
    path.resolve(process.cwd(), 'trellis-runtime'),
  ].filter(Boolean)
  for (const root of roots) {
    const nodeFile = path.join(root, 'node.exe')
    const cliFile = path.join(root, 'node_modules', '@mindfoldhq', 'trellis', 'bin', 'trellis.js')
    try {
      const [nodeStat, cliStat] = await Promise.all([fs.stat(nodeFile), fs.stat(cliFile)])
      if (nodeStat.isFile() && cliStat.isFile()) return { root, nodeFile, cliFile }
    } catch {
      // 继续检查下一个候选目录。
    }
  }
  throw new AgentError(
    AGENT_ERROR_CODE.CONFIG_MISSING,
    '客户端安装包缺少固定 Trellis 运行环境，请重新安装客户端',
  )
}

export async function initializeTrellis({
  repoPath,
  developerId,
  agentTools,
  runtime = null,
  resourcesPath,
  applicationDir,
  processRunner = runProcess,
}) {
  const resolved = runtime || (await resolveTrellisRuntime({ resourcesPath, applicationDir }))
  const flags = trellisAgentToolFlags(agentTools)
  const args = [resolved.cliFile, 'init', '-y', '--skip-existing', '-u', developerId, ...flags]
  const options = {
    cwd: repoPath,
    timeoutMs: INIT_TIMEOUT_MS,
    maxOutputBytes: 2 * 1024 * 1024,
  }
  const result = await processRunner(resolved.nodeFile, args, options)
  let successful = result
  if (result.exitCode !== 0) {
    if (!shouldRepairPi(agentTools, result)) {
      throw new AgentError(
        AGENT_ERROR_CODE.GIT_FAILED,
        `Trellis 初始化失败：${failedResultMessage(result)}`,
      )
    }

    const repairFile = path.join(resolved.root, PI_REPAIR_SCRIPT)
    let repairResult
    try {
      repairResult = await processRunner(
        resolved.nodeFile,
        [repairFile, resolved.root, repoPath],
        options,
      )
    } catch (error) {
      throw new AgentError(
        AGENT_ERROR_CODE.GIT_FAILED,
        `Pi 模板补齐失败：${safeErrorMessage(error)}`,
        { cause: error },
      )
    }
    if (repairResult.exitCode !== 0) {
      throw new AgentError(
        AGENT_ERROR_CODE.GIT_FAILED,
        `Pi 模板补齐失败：${failedResultMessage(repairResult)}`,
      )
    }

    try {
      successful = await processRunner(resolved.nodeFile, args, options)
    } catch (error) {
      throw new AgentError(
        AGENT_ERROR_CODE.GIT_FAILED,
        `Pi 模板补齐后 Trellis 初始化重试失败：${safeErrorMessage(error)}`,
        { cause: error },
      )
    }
    if (successful.exitCode !== 0) {
      throw new AgentError(
        AGENT_ERROR_CODE.GIT_FAILED,
        `Pi 模板补齐后 Trellis 初始化重试失败：${failedResultMessage(successful)}`,
      )
    }
  }
  return {
    initialized: true,
    agentTools: agentTools.slice(),
    stdout: successful.stdout.slice(0, 4000),
  }
}
