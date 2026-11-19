import { securityHeaders } from '../../../http-common.js'
import { ERROR_CODES, teamError } from '../../errors.js'
import {
  sendJson,
  sendNotModified,
  readJsonBody,
  taskQueryInput,
  pagePayload,
  archiveContentDisposition,
  archiveContentType,
  routeMatch,
  assertValidQueryEncoding,
} from '../common.js'

export function createTaskRoutes(ctx) {
  const { boardService, taskSpaces, taskSpaceIndex, taskCommands, requireActor } = ctx

  async function handleTasks(request, response, url) {
    const { pathname } = url
    const actor = requireActor(request)

    const archiveFileMatch = routeMatch(pathname, /^\/api\/archive-files\/([^/]+)$/)
    if (archiveFileMatch && request.method === 'GET') {
      assertValidQueryEncoding(url.search)
      const taskSpaceId = String(url.searchParams.get('taskSpaceId') || '').trim()
      if (!taskSpaceId || taskSpaceId.length > 128) {
        throw teamError(400, ERROR_CODES.INVALID_INPUT, '任务空间 ID 格式无效')
      }
      const file = await boardService.getArchiveFile(actor, taskSpaceId, archiveFileMatch[0])
      response.writeHead(200, {
        ...securityHeaders(),
        'content-type': archiveContentType(file.mimeType),
        'content-length': file.buffer.length,
        'content-disposition': archiveContentDisposition(file.name),
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
      })
      response.end(file.buffer)
      return true
    }

    if (pathname === '/api/tasks/query' && request.method === 'GET') {
      const queryInput = taskQueryInput(url)
      queryInput.taskSpaceId = url.searchParams.get('taskSpaceId')
      queryInput.ifNoneMatch = String(request.headers['if-none-match'] || '')
      const page = taskSpaceIndex.queryTasks(actor, queryInput)
      if (page.notModified) {
        sendNotModified(response, page.etag)
        return true
      }
      sendJson(response, 200, pagePayload(page), { etag: page.etag })
      return true
    }
    if (pathname === '/api/board' && request.method === 'GET') {
      const input = taskQueryInput(url)
      input.taskSpaceId = url.searchParams.get('taskSpaceId')
      const page = boardService.getBoard(actor, input)
      if (String(request.headers['if-none-match'] || '') === page.etag) {
        sendNotModified(response, page.etag)
        return true
      }
      sendJson(response, 200, pagePayload(page), { etag: page.etag })
      return true
    }
    if (pathname === '/api/board/settings' && request.method === 'GET') {
      sendJson(
        response,
        200,
        boardService.readSettings(actor, {
          teamId: url.searchParams.get('teamId'),
        }),
      )
      return true
    }
    if (pathname === '/api/board/settings' && request.method === 'PUT') {
      sendJson(response, 200, boardService.updateWipLimit(actor, await readJsonBody(request)))
      return true
    }
    if (pathname === '/api/saved-views' && request.method === 'GET') {
      sendJson(response, 200, {
        views: boardService.listSavedViews(actor, {
          teamId: url.searchParams.get('teamId'),
        }),
      })
      return true
    }
    if (pathname === '/api/saved-views' && request.method === 'POST') {
      sendJson(response, 201, boardService.createSavedView(actor, await readJsonBody(request)))
      return true
    }
    if (pathname === '/api/saved-views' && request.method === 'PUT') {
      sendJson(response, 200, boardService.updateSavedView(actor, await readJsonBody(request)))
      return true
    }
    if (pathname === '/api/saved-views' && request.method === 'DELETE') {
      sendJson(response, 200, boardService.deleteSavedView(actor, await readJsonBody(request)))
      return true
    }
    if (pathname === '/api/tasks/execution' && request.method === 'PUT') {
      sendJson(response, 200, await boardService.updatePlan(actor, await readJsonBody(request)))
      return true
    }
    if (pathname === '/api/tasks/stage' && request.method === 'PUT') {
      sendJson(response, 200, await boardService.setStage(actor, await readJsonBody(request)))
      return true
    }
    if (pathname === '/api/tasks/dependencies' && request.method === 'POST') {
      sendJson(
        response,
        201,
        await boardService.createDependency(actor, await readJsonBody(request)),
      )
      return true
    }
    if (pathname === '/api/tasks/dependencies' && request.method === 'DELETE') {
      sendJson(
        response,
        200,
        await boardService.resolveDependency(actor, await readJsonBody(request)),
      )
      return true
    }
    if (pathname === '/api/tasks/undo' && request.method === 'POST') {
      sendJson(response, 200, await boardService.undo(actor, await readJsonBody(request)))
      return true
    }
    if (pathname === '/api/assignments' && request.method === 'GET') {
      const result = boardService.listAssignments(actor, {
        state: url.searchParams.get('state'),
      })
      sendJson(response, 200, {
        ...result,
        tasks: result.assignments,
        items: result.assignments,
      })
      return true
    }
    if (pathname === '/api/tasks/accept' && request.method === 'POST') {
      const body = await readJsonBody(request)
      sendJson(response, 200, boardService.accept(actor, body))
      return true
    }
    if (pathname === '/api/tasks/assign' && request.method === 'POST') {
      const body = await readJsonBody(request)
      const result = taskCommands.enqueue(actor, { ...body, commandType: 'assign_task' })
      sendJson(response, result.statusCode, result)
      return true
    }
    if (pathname === '/api/tasks' && request.method === 'POST') {
      const body = await readJsonBody(request)
      const result = taskCommands.enqueue(actor, { ...body, commandType: 'create_task' })
      sendJson(response, result.statusCode, result)
      return true
    }
    if (pathname === '/api/tasks' && request.method === 'GET') {
      sendJson(
        response,
        200,
        await boardService.getTask(actor, {
          taskSpaceId: url.searchParams.get('taskSpaceId'),
          executionTaskKey: url.searchParams.get('executionTaskKey'),
          projectId: url.searchParams.get('projectId'),
          taskPath: url.searchParams.get('taskPath'),
        }),
      )
      return true
    }
    if (pathname === '/api/task' && request.method === 'POST') {
      sendJson(response, 200, await boardService.getTask(actor, await readJsonBody(request)))
      return true
    }
    const taskMatch = routeMatch(pathname, /^\/api\/tasks\/([^/]+)$/)
    if (taskMatch && request.method === 'GET') {
      sendJson(
        response,
        200,
        await boardService.getTask(actor, {
          taskSpaceId: url.searchParams.get('taskSpaceId'),
          executionTaskKey: taskMatch[0],
        }),
      )
      return true
    }
    const assigneeMatch = routeMatch(pathname, /^\/api\/task-spaces\/([^/]+)\/assignees$/)
    if (assigneeMatch && request.method === 'GET') {
      sendJson(response, 200, {
        assignees: boardService.assigneeCandidates(actor, assigneeMatch[0]),
      })
      return true
    }
    const listenersMatch = routeMatch(pathname, /^\/api\/task-spaces\/([^/]+)\/listeners$/)
    if (listenersMatch && request.method === 'GET') {
      sendJson(response, 200, taskSpaces.listenerDetails(actor, listenersMatch[0]))
      return true
    }
    if (pathname === '/api/task-operations' && request.method === 'GET') {
      sendJson(
        response,
        200,
        taskCommands.list(actor, {
          taskSpaceId: url.searchParams.get('taskSpaceId'),
        }),
      )
      return true
    }
    const operationMatch = routeMatch(pathname, /^\/api\/task-operations\/([^/]+)$/)
    if (operationMatch && request.method === 'GET') {
      sendJson(response, 200, taskCommands.get(actor, operationMatch[0]))
      return true
    }
    const retryMatch = routeMatch(pathname, /^\/api\/task-operations\/([^/]+)\/retry$/)
    if (retryMatch && request.method === 'POST') {
      await readJsonBody(request)
      sendJson(response, 200, taskCommands.retry(actor, retryMatch[0]))
      return true
    }
    const cancelMatch = routeMatch(pathname, /^\/api\/task-operations\/([^/]+)\/cancel$/)
    if (cancelMatch && request.method === 'POST') {
      await readJsonBody(request)
      sendJson(response, 200, taskCommands.cancel(actor, cancelMatch[0]))
      return true
    }
    return false
  }

  return { handleTasks }
}
