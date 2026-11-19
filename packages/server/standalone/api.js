import { undoLastOperation } from '../execution-history.js'
import { assignTask, createTask } from '../actions.js'
import { setManualStage } from '../metadata.js'
import { sendJson, readJsonBody, SERVER_VERSION } from './http-io.js'
import { readBoardState } from './board-state.js'
import { publishRepositoryChange } from '../plugins/repository-events.js'
import { getBoardWithBackgroundRefresh, readScanCache, refreshBoardFromFiles } from './refresh.js'
import { refreshAfterRepositoryChange, repositoryInputs } from './repositories.js'
import { pickFoldersFromDesktop } from './folder-picker.js'
import {
  findTask,
  requireDependencyIdentity,
  requireWritableExecution,
  resolveCurrentTask,
} from './tasks.js'
import { handlePluginRequest } from './plugins.js'

export async function handleApi(state, request, response, url) {
  const pluginPath =
    url.pathname.startsWith('/api/plugins') ||
    url.pathname === '/api/panels' ||
    url.pathname === '/api/events'
  if (pluginPath && (await handlePluginRequest(state, request, response, url))) {
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/board/events') {
    if (!state.boardEventService?.open({ response })) {
      sendJson(response, 503, { error: '实时刷新服务不可用' })
    }
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/board') {
    const board = await getBoardWithBackgroundRefresh(state, false)
    sendJson(response, 200, {
      ...board,
      refreshRunning: Boolean(state.inflightScan),
      refreshQueued: Boolean(state.inflightScan || state.queuedRefresh || state.watchDebounceTimer),
    })
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/board/status') {
    sendJson(response, 200, {
      ...readBoardState(state),
      refreshRunning: Boolean(state.inflightScan),
      refreshQueued: Boolean(state.inflightScan || state.queuedRefresh || state.watchDebounceTimer),
      watcher: state.watchRuntime?.status() || {
        enabled: false,
        watchedRepositories: [],
        watchedRoots: [],
        eventsSeen: 0,
        lastEvent: null,
        errors: [],
      },
    })
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/health') {
    sendJson(response, 200, { status: 'ok', processId: process.pid, version: SERVER_VERSION })
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/board/refresh/start') {
    if (!state.inflightScan) {
      refreshBoardFromFiles(state, 'manual', null, {
        refreshRepositoryMetadata: true,
        forceFull: true,
      }).catch((error) => state.logger.error('后台刷新失败', error))
    }
    sendJson(response, 202, {
      refreshRunning: true,
      refreshQueued: Boolean(state.queuedRefresh || state.watchDebounceTimer),
    })
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/board/refresh') {
    sendJson(response, 200, await getBoardWithBackgroundRefresh(state, true))
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/repositories') {
    sendJson(response, 200, { repositories: state.repositoryStore.list() })
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/repositories/pick-folders') {
    sendJson(response, 200, { paths: await pickFoldersFromDesktop(state) })
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/repositories') {
    const payload = await readJsonBody(request)
    const repositories = state.repositoryStore.addMany(repositoryInputs(payload))
    const board = await refreshAfterRepositoryChange(state, 'add', repositories)
    publishRepositoryChange(state.pluginRuntime, 'add', repositories)
    const projects = repositories.map(
      (repository) =>
        board.projects.find((candidate) => candidate.id === repository.id) || repository,
    )
    sendJson(response, 201, {
      message:
        repositories.length === 1 ? '项目已加入看板' : `已加入 ${repositories.length} 个项目`,
      repositories: projects,
      repository: projects.length === 1 ? projects[0] : undefined,
    })
    return
  }
  if (request.method === 'DELETE' && url.pathname === '/api/repositories') {
    const payload = await readJsonBody(request)
    const repository = state.repositoryStore.remove(payload)
    await refreshAfterRepositoryChange(state, 'remove', [repository])
    publishRepositoryChange(state.pluginRuntime, 'remove', [repository])
    sendJson(response, 200, {
      message: '项目已从看板移除，源文件未删除',
      repository,
    })
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/task') {
    const payload = await readJsonBody(request)
    sendJson(response, 200, findTask(state, payload))
    return
  }
  if (request.method === 'PUT' && url.pathname === '/api/tasks/execution') {
    const payload = await readJsonBody(request)
    const resolved = resolveCurrentTask(state, payload)
    requireWritableExecution(resolved)
    const result = state.executionStore.updatePlan(
      resolved.task.executionTaskKey,
      payload,
      resolved.actor,
    )
    sendJson(response, 200, {
      message: result.changed ? '计划字段已保存' : '计划字段没有变化',
      ...result,
    })
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/tasks/dependencies') {
    const payload = await readJsonBody(request)
    const blocked = resolveCurrentTask(state, payload.blocked)
    const blocker = resolveCurrentTask(state, payload.blocker)
    requireDependencyIdentity(blocked, '被阻断')
    requireDependencyIdentity(blocker, '阻断方')
    const currentBoard = state.boardCache || readScanCache(state)
    const taskLabels = Object.fromEntries(
      (currentBoard?.tasks || [])
        .filter((task) => task.executionTaskKey)
        .map((task) => [task.executionTaskKey, task.title]),
    )
    const dependency = state.executionStore.createDependency(
      {
        blockerTaskKey: blocker.task.executionTaskKey,
        blockedTaskKey: blocked.task.executionTaskKey,
        reason: payload.reason,
        blockerLabel: blocker.task.title,
        blockedLabel: blocked.task.title,
        taskLabels,
      },
      blocked.actor,
    )
    sendJson(response, 201, {
      message: '阻断依赖已创建',
      dependency: {
        ...dependency,
        blocker: {
          taskKey: blocker.task.taskKey,
          executionTaskKey: blocker.task.executionTaskKey,
          title: blocker.task.title,
          projectName: blocker.task.projectName,
        },
        blocked: {
          taskKey: blocked.task.taskKey,
          executionTaskKey: blocked.task.executionTaskKey,
          title: blocked.task.title,
          projectName: blocked.task.projectName,
        },
      },
    })
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/tasks/undo') {
    const payload = await readJsonBody(request)
    const resolved = resolveCurrentTask(state, payload)
    requireWritableExecution(resolved)
    const undone = undoLastOperation({
      db: state.database,
      executionTaskKey: resolved.task.executionTaskKey,
      projectId: resolved.project.id,
      taskPath: resolved.task.relativeDir,
      task: resolved.task,
      actor: resolved.actor,
    })
    await refreshBoardFromFiles(state, 'undo', null, {
      suppressStageObservation: true,
    })
    sendJson(response, 200, {
      message: '最近操作已撤销',
      ...undone,
      task: findTask(state, payload),
    })
    return
  }
  if (request.method === 'DELETE' && url.pathname === '/api/tasks/dependencies') {
    const payload = await readJsonBody(request)
    const dependency = state.executionStore.resolveDependency(payload.id)
    sendJson(response, 200, {
      message: '阻断依赖已解除',
      dependency,
    })
    return
  }
  if (request.method === 'PUT' && url.pathname === '/api/board/settings') {
    const payload = await readJsonBody(request)
    const unknownKeys = Object.keys(payload).filter((key) => key !== 'executionWipLimit')
    if (unknownKeys.length) {
      throw new Error(`看板设置包含未知字段: ${unknownKeys.join(', ')}`)
    }
    const executionWipLimit = state.persistence.writeExecutionWipLimit(payload.executionWipLimit)
    sendJson(response, 200, {
      message: '实现中 WIP 软上限已保存',
      executionWipLimit,
    })
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/saved-views') {
    const payload = await readJsonBody(request)
    const view = state.executionStore.createSavedView(payload)
    sendJson(response, 201, { message: '组合视图已保存', view })
    return
  }
  if (request.method === 'PUT' && url.pathname === '/api/saved-views') {
    const payload = await readJsonBody(request)
    const view = state.executionStore.updateSavedView(payload)
    sendJson(response, 200, { message: '组合视图已更新', view })
    return
  }
  if (request.method === 'DELETE' && url.pathname === '/api/saved-views') {
    const payload = await readJsonBody(request)
    const view = state.executionStore.deleteSavedView(payload.id)
    sendJson(response, 200, { message: '组合视图已删除', view })
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/tasks') {
    const payload = await readJsonBody(request)
    const result = await createTask(payload)
    state.boardCache = null
    sendJson(response, 201, {
      message: '任务已创建，尚未启动',
      repository: result.repository,
      stdout: result.output.stdout,
      stderr: result.output.stderr,
    })
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/tasks/assign') {
    const payload = await readJsonBody(request)
    const assigned = await assignTask(payload)
    state.boardCache = null
    state.pluginRuntime?.publish('task.assigned', {
      taskKey: `${payload.repositoryId}::${payload.taskDir}`,
      projectId: payload.repositoryId,
      assignee: assigned.assignee,
      occurredAt: new Date().toISOString(),
    })
    sendJson(response, 200, { message: '任务负责人已更新', ...assigned })
    return
  }
  if (request.method === 'PUT' && url.pathname === '/api/tasks/stage') {
    const payload = await readJsonBody(request)
    const resolved = resolveCurrentTask(state, payload)
    requireWritableExecution(resolved)
    const stage = setManualStage(
      resolved.project.id,
      resolved.task.relativeDir,
      payload.stage,
      state.database,
      {
        executionTaskKey: resolved.task.executionTaskKey,
        actor: resolved.actor,
      },
    )
    await refreshBoardFromFiles(state, 'manual-stage', null, {
      suppressStageObservation: true,
    })
    state.pluginRuntime?.publish('task.stage.changed', {
      taskKey: resolved.task.taskKey,
      stage: stage.stage,
      occurredAt: stage.updatedAt,
    })
    sendJson(response, 200, { message: '流程检查点已记录', stage })
    return
  }
  sendJson(response, 404, { error: '接口不存在' })
}
