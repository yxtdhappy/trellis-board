import fs from 'node:fs/promises'
import path from 'node:path'
import { AgentError, AGENT_ERROR_CODE, safeErrorMessage } from '../../agent/protocol.js'
import { runProcess } from '../../agent/process.js'
import { trellisAgentToolFlags } from '../../shared/trellis-agent-tools.js'

const INIT_TIMEOUT_MS = 210_000

export async function resolveTrellisRuntime({ resourcesPath, applicationDir } = {}) {
  const roots = [
    resourcesPath ? path.join(resourcesPath, 'trellis-runtime') : null,
    applicationDir ? path.join(applicationDir, 'trellis-runtime') : null,
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
}) {
  const resolved = runtime || (await resolveTrellisRuntime({ resourcesPath, applicationDir }))
  const flags = trellisAgentToolFlags(agentTools)
  const result = await runProcess(
    resolved.nodeFile,
    [resolved.cliFile, 'init', '-y', '--skip-existing', '-u', developerId, ...flags],
    {
      cwd: repoPath,
      timeoutMs: INIT_TIMEOUT_MS,
      maxOutputBytes: 2 * 1024 * 1024,
    },
  )
  if (result.exitCode !== 0) {
    throw new AgentError(
      AGENT_ERROR_CODE.GIT_FAILED,
      `Trellis 初始化失败：${safeErrorMessage(new Error(result.stderr || result.stdout))}`,
    )
  }
  return {
    initialized: true,
    agentTools: agentTools.slice(),
    stdout: result.stdout.slice(0, 4000),
  }
}
