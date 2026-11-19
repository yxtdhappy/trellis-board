import { ERROR_CODES, teamError } from '../../errors.js'
import {
  requireObservedBranchName,
  sendJson,
  clientIp,
  readJsonBody,
  routeMatch,
  MAX_LIVE_BATCH_BYTES,
  MAX_OWNERSHIP_INBOX_BYTES,
} from '../common.js'

export function createAgentRoutes(ctx) {
  const {
    taskSpaces,
    taskSnapshots,
    ownershipInbox,
    taskCommands,
    taskControl,
    agentService,
    agentEvents,
    boardEvents,
    desktopAuth,
    publishTaskControlChanged,
  } = ctx

  async function handleAgent(request, response, url) {
    const { pathname } = url
    if (pathname === '/api/agent/enroll' && request.method === 'POST') {
      const body = await readJsonBody(request)
      sendJson(
        response,
        201,
        agentService.enroll(body, {
          ip: clientIp(request, false),
        }),
      )
      return true
    }
    if (pathname === '/api/agent/enroll-desktop' && request.method === 'POST') {
      const body = await readJsonBody(request)
      // verify 与 consume 之间不 await，保证令牌在本进程中只可能被兑换一次。
      const record = desktopAuth.verify(body.token)
      const result = agentService.enrollDesktop(body, record)
      desktopAuth.consume(body.token)
      sendJson(response, 201, result)
      return true
    }
    if (!pathname.startsWith('/api/agent/')) return false

    const agent = agentService.authenticate(request)
    if (pathname === '/api/agent/heartbeat' && request.method === 'POST') {
      const body = await readJsonBody(request)
      sendJson(response, 200, agentService.heartbeat(agent, body))
      return true
    }
    if (pathname === '/api/agent/task-spaces/preflight' && request.method === 'POST') {
      const body = await readJsonBody(request)
      sendJson(response, 200, taskSpaces.preflight(agent.userId, body))
      return true
    }
    if (pathname === '/api/agent/task-spaces/resolve' && request.method === 'POST') {
      const body = await readJsonBody(request)
      sendJson(response, 200, taskSpaces.resolve(agent.userId, body))
      return true
    }
    if (pathname === '/api/agent/task-spaces/attach' && request.method === 'POST') {
      const body = await readJsonBody(request, MAX_LIVE_BATCH_BYTES)
      sendJson(response, 201, taskSpaces.attach(agent.userId, agent.id, body))
      return true
    }
    const detachMatch = routeMatch(pathname, /^\/api\/agent\/task-spaces\/([^/]+)\/detach$/)
    if (detachMatch && request.method === 'POST') {
      const body = await readJsonBody(request)
      sendJson(response, 200, taskSpaces.detachAgent(agent, detachMatch[0], body))
      return true
    }
    const snapshotMatch = routeMatch(pathname, /^\/api\/agent\/task-spaces\/([^/]+)\/snapshot$/)
    if (snapshotMatch && request.method === 'GET') {
      sendJson(
        response,
        200,
        taskSnapshots.snapshot(agent, snapshotMatch[0], {
          afterRevision: url.searchParams.get('afterRevision'),
        }),
      )
      return true
    }
    const filesMatch = routeMatch(pathname, /^\/api\/agent\/task-spaces\/([^/]+)\/files$/)
    if (filesMatch && request.method === 'GET') {
      sendJson(
        response,
        200,
        taskSnapshots.directorySnapshot(agent, filesMatch[0], url.searchParams.get('taskDir')),
      )
      return true
    }
    const tasksListMatch = routeMatch(pathname, /^\/api\/agent\/task-spaces\/([^/]+)\/tasks$/)
    if (tasksListMatch && request.method === 'GET') {
      sendJson(response, 200, {
        tasks: taskSnapshots.listTaskSummaries(agent, tasksListMatch[0]),
      })
      return true
    }
    const taskFilesMatch = routeMatch(
      pathname,
      /^\/api\/agent\/task-spaces\/([^/]+)\/tasks\/([^/]+)\/files$/,
    )
    if (taskFilesMatch && request.method === 'GET') {
      sendJson(
        response,
        200,
        taskSnapshots.taskFilesById(agent, taskFilesMatch[0], taskFilesMatch[1]),
      )
      return true
    }
    const preflightMatch = routeMatch(pathname, /^\/api\/agent\/task-spaces\/([^/]+)\/preflight$/)
    if (preflightMatch && request.method === 'POST') {
      const body = await readJsonBody(request, MAX_LIVE_BATCH_BYTES)
      sendJson(response, 200, taskSnapshots.preflight(agent, preflightMatch[0], body))
      return true
    }
    const ownershipMatch = routeMatch(
      pathname,
      /^\/api\/agent\/task-spaces\/([^/]+)\/task-ownership$/,
    )
    if (ownershipMatch && request.method === 'POST') {
      const body = await readJsonBody(request)
      sendJson(response, 200, taskSnapshots.taskOwnership(agent, ownershipMatch[0], body))
      return true
    }
    const changesMatch = routeMatch(pathname, /^\/api\/agent\/task-spaces\/([^/]+)\/changes$/)
    if (changesMatch && request.method === 'POST') {
      const body = await readJsonBody(request, MAX_LIVE_BATCH_BYTES)
      requireObservedBranchName(body)
      const result = taskSnapshots.applyChanges(agent, changesMatch[0], body)
      sendJson(response, result.status || 200, result)
      return true
    }
    const ownershipInboxMatch = routeMatch(
      pathname,
      /^\/api\/agent\/task-spaces\/([^/]+)\/ownership-inbox$/,
    )
    if (ownershipInboxMatch && request.method === 'PUT') {
      const body = await readJsonBody(request, MAX_OWNERSHIP_INBOX_BYTES)
      requireObservedBranchName(body)
      const result = ownershipInbox.apply(agent, ownershipInboxMatch[0], body)
      if (result.changed) boardEvents.publish({})
      sendJson(response, 200, result)
      return true
    }
    const cursorMatch = routeMatch(pathname, /^\/api\/agent\/task-spaces\/([^/]+)\/cursor$/)
    if (cursorMatch && request.method === 'PUT') {
      const body = await readJsonBody(request)
      sendJson(response, 200, taskSnapshots.writeCursor(agent, cursorMatch[0], body))
      return true
    }
    const conflictsMatch = routeMatch(pathname, /^\/api\/agent\/task-spaces\/([^/]+)\/conflicts$/)
    if (conflictsMatch && request.method === 'GET') {
      sendJson(response, 200, {
        conflicts: taskSnapshots.listConflicts(agent, conflictsMatch[0]),
      })
      return true
    }
    const conflictResolveMatch = routeMatch(
      pathname,
      /^\/api\/agent\/task-spaces\/([^/]+)\/conflicts\/([^/]+)\/resolve$/,
    )
    if (conflictResolveMatch && request.method === 'POST') {
      const body = await readJsonBody(request, MAX_LIVE_BATCH_BYTES)
      if (body.action === 'overwrite-server') requireObservedBranchName(body)
      sendJson(
        response,
        200,
        taskSnapshots.resolveConflict(
          agent,
          conflictResolveMatch[0],
          conflictResolveMatch[1],
          body,
        ),
      )
      return true
    }
    const controlledTaskMatch = routeMatch(
      pathname,
      /^\/api\/agent\/tasks\/([^/]+)(?:\/(claim|heartbeat|release|handoff-ack))?$/,
    )
    if (controlledTaskMatch) {
      const [executionTaskKey, action = ''] = controlledTaskMatch
      const taskSpaceId = executionTaskKey.slice(0, executionTaskKey.indexOf('::'))
      if (!taskSpaceId) {
        throw teamError(400, ERROR_CODES.INVALID_INPUT, '任务身份格式无效')
      }
      if (!action && request.method === 'GET') {
        sendJson(response, 200, taskControl.getTask(agent, taskSpaceId, executionTaskKey))
        return true
      }
      if (request.method === 'POST' && action === 'claim') {
        const result = taskControl.claim(agent, taskSpaceId, executionTaskKey)
        publishTaskControlChanged()
        sendJson(response, 200, result)
        return true
      }
      if (request.method === 'POST' && action === 'heartbeat') {
        const body = await readJsonBody(request)
        sendJson(response, 200, taskControl.heartbeat(agent, taskSpaceId, executionTaskKey, body))
        return true
      }
      if (request.method === 'POST' && action === 'release') {
        const body = await readJsonBody(request)
        const result = taskControl.release(agent, taskSpaceId, executionTaskKey, body)
        publishTaskControlChanged()
        sendJson(response, 200, result)
        return true
      }
      if (request.method === 'POST' && action === 'handoff-ack') {
        const body = await readJsonBody(request)
        const result = taskControl.ackHandoff(agent, taskSpaceId, executionTaskKey, body)
        publishTaskControlChanged()
        sendJson(response, 200, result)
        return true
      }
    }
    if (pathname === '/api/agent/events' && request.method === 'GET') {
      agentEvents.open({
        agent,
        response,
      })
      return true
    }
    if (pathname === '/api/agent/commands' && request.method === 'POST') {
      throw teamError(
        410,
        ERROR_CODES.AGENT_LONG_POLL_REMOVED,
        '命令长轮询已移除，请升级 Agent 并使用 GET /api/agent/events',
      )
    }
    const startMatch = routeMatch(pathname, /^\/api\/agent\/commands\/([^/]+)\/start$/)
    if (startMatch && request.method === 'POST') {
      sendJson(response, 200, taskCommands.start(agent.id, startMatch[0]))
      return true
    }
    const resultMatch = routeMatch(pathname, /^\/api\/agent\/commands\/([^/]+)\/result$/)
    if (resultMatch && request.method === 'POST') {
      const body = await readJsonBody(request)
      sendJson(response, 200, taskCommands.complete(agent, resultMatch[0], body))
      return true
    }
    return false
  }

  return { handleAgent }
}
