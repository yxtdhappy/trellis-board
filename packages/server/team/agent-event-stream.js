import { ERROR_CODES, teamError } from './errors.js'

const HEARTBEAT_MS = 15_000
const RETRY_MS = 3_000

function frame(response, eventName, data, id = null) {
  if (response.destroyed || response.writableEnded) return false
  if (id != null) response.write(`id: ${id}\n`)
  response.write(`event: ${eventName}\n`)
  response.write(`data: ${JSON.stringify(data)}\n\n`)
  return true
}

export function createAgentEventStream({ db, commands, logger = console }) {
  const streams = new Map()
  // 只省略重复广播；服务重启后的客户端重连仍由现有补偿拉取负责。
  const lastTaskRevisionByTaskSpace = new Map()
  let closed = false
  let heartbeatTimer = null

  function endAgent(agentId) {
    const set = streams.get(agentId)
    if (!set) return
    streams.delete(agentId)
    for (const stream of set) {
      clearInterval(stream.timer)
      frame(stream.response, 'agent.revoked', {
        type: 'agent.revoked',
        message: '账号已在其他设备登录或被管理员撤销',
      })
      stream.response.end()
    }
  }

  function sendCommands(agentId) {
    const set = streams.get(agentId)
    if (!set?.size) return
    commands.staleLeases(agentId)
    for (const command of commands.available(agentId)) {
      for (const stream of set) {
        frame(
          stream.response,
          'command',
          {
            id: null,
            teamId: null,
            type: 'command',
            payload: { command },
            // 兼容只读取顶层 command 的旧客户端；新客户端优先读取 payload.command。
            command,
          },
          command.id,
        )
      }
      commands.markDelivered(agentId, command.id)
    }
  }

  function notifyCommandAvailable(agentId) {
    if (!closed) sendCommands(agentId)
  }

  function notifyTaskSpaceChanged(taskSpaceId, revision, sourceAgentId = null) {
    if (closed) return
    if (!Number.isSafeInteger(revision) || revision < 0) return
    const lastRevision = lastTaskRevisionByTaskSpace.get(taskSpaceId)
    if (lastRevision != null && revision <= lastRevision) return
    lastTaskRevisionByTaskSpace.set(taskSpaceId, revision)
    const bindings = db
      .prepare(`
      SELECT agent_id
      FROM sync_agent_binding
      WHERE task_space_id = ? AND sync_status = 'approved'
    `)
      .all(taskSpaceId)
    for (const binding of bindings) {
      if (binding.agent_id === sourceAgentId) continue
      const set = streams.get(binding.agent_id)
      if (!set) continue
      for (const stream of set) {
        frame(stream.response, 'task.changed', {
          type: 'task.changed',
          taskSpaceId,
          revision,
        })
      }
    }
  }

  function notifyTaskControlChanged(taskSpaceId) {
    if (closed) return
    const bindings = db
      .prepare(`
      SELECT agent_id
      FROM sync_agent_binding
      WHERE task_space_id = ? AND sync_status = 'approved'
    `)
      .all(taskSpaceId)
    for (const binding of bindings) {
      const set = streams.get(binding.agent_id)
      if (!set) continue
      for (const stream of set) {
        frame(stream.response, 'control.changed', {
          type: 'control.changed',
          taskSpaceId,
        })
      }
    }
  }

  function open({ agent, response }) {
    if (closed) throw teamError(503, ERROR_CODES.SERVICE_SHUTTING_DOWN, '服务正在关闭')
    const active = db
      .prepare('SELECT 1 FROM sync_active_agent WHERE user_id = ? AND agent_id = ?')
      .get(agent.userId, agent.id)
    if (!active) {
      throw teamError(401, ERROR_CODES.AGENT_AUTH_REQUIRED, 'Agent 已被其他设备替换')
    }
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    response.write(`retry: ${RETRY_MS}\n\n`)
    const stream = {
      agentId: agent.id,
      userId: agent.userId,
      response,
      timer: null,
    }
    stream.timer = setInterval(() => {
      const current = db
        .prepare(`
        SELECT 1
        FROM sync_active_agent active
        JOIN agent_device a ON a.id = active.agent_id
        JOIN user_account u ON u.id = a.user_id
        WHERE active.user_id = ? AND active.agent_id = ?
          AND a.status = 'active' AND u.status = 'active'
      `)
        .get(agent.userId, agent.id)
      if (!current) {
        endAgent(agent.id)
        return
      }
      response.write(': heartbeat\n\n')
      sendCommands(agent.id)
    }, HEARTBEAT_MS)
    stream.timer.unref?.()
    if (!streams.has(agent.id)) streams.set(agent.id, new Set())
    streams.get(agent.id).add(stream)
    response.on('close', () => {
      clearInterval(stream.timer)
      streams.get(agent.id)?.delete(stream)
      if (!streams.get(agent.id)?.size) streams.delete(agent.id)
    })
    sendCommands(agent.id)
    return true
  }

  function publishAgentRevoked(agentId) {
    endAgent(agentId)
  }

  function close() {
    if (closed) return
    closed = true
    lastTaskRevisionByTaskSpace.clear()
    if (heartbeatTimer) clearInterval(heartbeatTimer)
    heartbeatTimer = null
    for (const agentId of [...streams.keys()]) endAgent(agentId)
  }

  return {
    open,
    notifyCommandAvailable,
    notifyTaskSpaceChanged,
    notifyTaskControlChanged,
    publishAgentRevoked,
    close,
  }
}
