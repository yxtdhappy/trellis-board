import fs from 'node:fs'
import path from 'node:path'
import { createTask, assignTask } from '../actions.js'
import { createExecutionStore } from '../execution-store.js'
import { getManualRecord, setManualStage } from '../metadata.js'
import { appError, invalidParams, ERROR_CODES } from './protocol.js'

const MAX_TASKS_PER_LIST = 500
const ACTIVE_STATUSES = new Set(['planning', 'in_progress', 'blocked'])

function datePrefix(now = new Date()) {
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${month}-${day}`
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

// 看板缓存可能尚未建立，DoR 缺口要能从任务目录直接判定，不能只依赖 boardProvider。
function fileDorGapCount(full, task) {
  if (task?.status !== 'planning') return 0
  let gaps = 0
  if (readText(path.join(full, 'prd.md')).trim().length < 20) gaps += 1
  if (!fs.existsSync(path.join(full, 'implement.md'))) gaps += 1
  return gaps
}

function writeJsonAtomic(file, value) {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  fs.renameSync(temporary, file)
}

function writeTextAtomic(file, value) {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(temporary, value, 'utf8')
  fs.renameSync(temporary, file)
}

function isInside(target, parent) {
  const relative = path.relative(parent, target)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function taskDirectory(root, relativeDir) {
  if (typeof relativeDir !== 'string' || !relativeDir.trim()) {
    throw invalidParams('任务目录不能为空')
  }
  if (relativeDir.includes('..') || relativeDir.includes('\\')) {
    throw invalidParams('任务目录必须是 .trellis/tasks 下的相对路径')
  }
  const tasksRoot = path.resolve(root, '.trellis', 'tasks')
  const full = path.resolve(tasksRoot, relativeDir)
  if (!isInside(full, tasksRoot)) throw invalidParams('任务目录越出 .trellis/tasks')
  return full
}

function normalizeTaskKey(projectId, relativeDir) {
  return `${projectId}::${relativeDir}`
}

function splitTaskKey(taskKey) {
  if (typeof taskKey !== 'string' || !taskKey.includes('::')) {
    throw invalidParams('taskKey 必须是 <项目>::<任务目录>')
  }
  const index = taskKey.indexOf('::')
  return { projectId: taskKey.slice(0, index), relativeDir: taskKey.slice(index + 2) }
}

function toTaskDto(project, relativeDir, task, extra = {}) {
  return {
    taskKey: normalizeTaskKey(project.id, relativeDir),
    projectId: project.id,
    projectName: project.name,
    projectPath: project.path,
    relativeDir,
    title: task?.title ?? relativeDir,
    status: task?.status ?? 'unknown',
    assignee: task?.assignee ?? null,
    priority: task?.priority ?? 'P2',
    meta: task?.meta ?? {},
    archived: Boolean(extra.archived),
    ...extra,
  }
}

/**
 * 插件可用的任务读写 facade。所有写操作都复用 actions.js / metadata.js，
 * 插件进程不直接接触 SQLite 或 task.py。
 */
export function createTaskService({
  repositories = [],
  db,
  boardProvider = () => null,
  actions = { createTask, assignTask },
  metadata = { setManualStage },
  now = () => new Date(),
} = {}) {
  function findRepository(repositoryId) {
    const project = repositories.find((candidate) => candidate.id === repositoryId)
    if (!project) {
      throw appError(ERROR_CODES.NOT_FOUND, `仓库不在白名单中: ${repositoryId}`)
    }
    return project
  }

  function boardStageMap() {
    const board = boardProvider()
    const map = new Map()
    for (const task of board?.tasks ?? []) {
      map.set(`${task.projectId}::${task.relativeDir}`, {
        derivedStage: task.derivedStage,
        manualStage: task.manualStage,
        blocked: task.execution?.isBlocked === true,
        dorMissingCount: task.execution?.risk?.dorMissingCount ?? 0,
      })
    }
    return map
  }

  function readTask(project, relativeDir) {
    const full = taskDirectory(project.path, relativeDir)
    const taskJson = path.join(full, 'task.json')
    if (!fs.existsSync(taskJson)) {
      throw appError(ERROR_CODES.NOT_FOUND, `任务不存在: ${relativeDir}`)
    }
    return { full, task: readJson(taskJson) }
  }

  async function create(params = {}) {
    const project = findRepository(params.repositoryId)
    const title = params.title
    const description = params.description
    const created = await actions.createTask(
      {
        repositoryId: project.id,
        title,
        description,
        assignee: params.assignee,
        priority: params.priority ?? 'P2',
        slug: params.slug,
        packageName: params.packageName,
      },
      { listRepositories: () => repositories },
    )
    const slug = String(params.slug || '').trim()
    const directory = slug ? `${datePrefix(now())}-${slug}` : null
    const relativeDir = directory ?? newestTaskDirectory(project, now())
    const full = taskDirectory(project.path, relativeDir)

    if (params.prd) {
      writeTextAtomic(path.join(full, 'prd.md'), String(params.prd))
    }
    if (params.extraFiles && typeof params.extraFiles === 'object') {
      for (const [name, content] of Object.entries(params.extraFiles)) {
        const target = path.resolve(full, String(name))
        const relative = path.relative(full, target)
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
          throw appError(ERROR_CODES.TASK_REJECTED, `附加文件路径越界: ${name}`)
        }
        writeTextAtomic(target, String(content ?? ''))
      }
    }
    if (params.meta && typeof params.meta === 'object') {
      mergeMeta(full, params.meta)
    }

    const task = readJson(path.join(full, 'task.json')) || {}
    return actions.createTaskResult ? created : toTaskDto(project, relativeDir, task)
  }

  function newestTaskDirectory(project, at) {
    const prefix = datePrefix(at)
    const tasksRoot = path.join(project.path, '.trellis', 'tasks')
    const entries = fs.existsSync(tasksRoot)
      ? fs.readdirSync(tasksRoot, { withFileTypes: true })
      : []
    const candidates = entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(`${prefix}-`))
      .map((entry) => ({
        name: entry.name,
        mtime: fs.statSync(path.join(tasksRoot, entry.name)).mtimeMs,
      }))
      .sort((left, right) => right.mtime - left.mtime)
    if (!candidates.length) {
      throw appError(ERROR_CODES.TASK_REJECTED, '任务创建后未找到任务目录')
    }
    return candidates[0].name
  }

  function mergeMeta(full, meta) {
    const taskJson = path.join(full, 'task.json')
    const task = readJson(taskJson)
    if (!task) throw appError(ERROR_CODES.TASK_REJECTED, '任务创建后 task.json 不可读')
    task.meta = { ...(task.meta || {}), ...meta }
    writeJsonAtomic(taskJson, task)
    return task.meta
  }

  async function assign(params = {}) {
    const project = findRepository(params.repositoryId)
    const relativeDir = params.relativeDir || splitTaskKey(params.taskKey).relativeDir
    const before = get({ repositoryId: project.id, relativeDir })
    await actions.assignTask(
      {
        repositoryId: project.id,
        taskDir: path.join('.trellis', 'tasks', relativeDir),
        assignee: params.assignee,
      },
      { listRepositories: () => repositories },
    )
    if (params.meta && typeof params.meta === 'object') {
      mergeMeta(taskDirectory(project.path, relativeDir), params.meta)
    }
    return {
      ...get({ repositoryId: project.id, relativeDir }),
      previousAssignee: before.assignee ?? null,
    }
  }

  function setStage(params = {}) {
    const project = findRepository(params.repositoryId)
    const relativeDir = params.relativeDir || splitTaskKey(params.taskKey).relativeDir
    readTask(project, relativeDir)
    const previous = getManualRecord(project.id, relativeDir, db)
    const record = metadata.setManualStage(project.id, relativeDir, params.stage, db)
    return {
      ...record,
      taskKey: normalizeTaskKey(project.id, relativeDir),
      previousStage: previous?.stage ?? null,
    }
  }

  function get(params = {}) {
    const split = params.taskKey ? splitTaskKey(params.taskKey) : null
    const project = findRepository(params.repositoryId || split?.projectId)
    const relativeDir = params.relativeDir || split.relativeDir
    const full = taskDirectory(project.path, relativeDir)
    const taskJson = path.join(full, 'task.json')
    if (!fs.existsSync(taskJson)) {
      throw appError(ERROR_CODES.NOT_FOUND, `任务不存在: ${relativeDir}`)
    }
    const task = readJson(taskJson) || {}
    const stage = boardStageMap().get(normalizeTaskKey(project.id, relativeDir)) || {}
    return toTaskDto(project, relativeDir, task, {
      stage: stage.derivedStage ?? task.status ?? null,
      manualStage: stage.manualStage ?? null,
      archived: task.archived === true || relativeDir.startsWith('archive/'),
      blocked: stage.blocked === true || task.status === 'blocked',
      dorMissingCount: Math.max(stage.dorMissingCount || 0, fileDorGapCount(full, task)),
      files: listFiles(full),
    })
  }

  function setPlan(params = {}) {
    const split = params.taskKey ? splitTaskKey(params.taskKey) : null
    const project = findRepository(params.repositoryId || split?.projectId)
    const relativeDir = params.relativeDir || split?.relativeDir
    if (!relativeDir) throw invalidParams('setPlan 缺少 relativeDir 或 taskKey')
    const { task } = readTask(project, relativeDir)
    const executionId = String(task.id || '').trim() || path.basename(relativeDir)
    const executionTaskKey = `${project.id}::${executionId}`
    const store = createExecutionStore({ db })
    const result = store.updatePlan(
      executionTaskKey,
      { dueDate: params.dueDate },
      params.actor ?? null,
    )
    return {
      taskKey: normalizeTaskKey(project.id, relativeDir),
      executionTaskKey,
      changed: result.changed,
      dueDate: result.plan?.dueDate ?? null,
      plan: result.plan ?? null,
    }
  }

  function taskDirectories(tasksRoot, includeArchived) {
    const directories = []
    const walk = (root, prefix, depth) => {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const relativeDir = prefix ? `${prefix}/${entry.name}` : entry.name
        const full = path.join(root, entry.name)
        if (fs.existsSync(path.join(full, 'task.json'))) {
          directories.push({ relativeDir, full })
          continue
        }
        if (!includeArchived || depth >= 3) continue
        if (entry.name === 'archive' || prefix === 'archive' || prefix.startsWith('archive/')) {
          walk(full, relativeDir, depth + 1)
        }
      }
    }
    walk(tasksRoot, '', 0)
    return directories
  }

  function listFiles(full) {
    try {
      return fs.readdirSync(full).filter((name) => !name.endsWith('.tmp'))
    } catch {
      return []
    }
  }

  function list(params = {}) {
    const projects = params.repositoryId ? [findRepository(params.repositoryId)] : repositories
    const stageMap = boardStageMap()
    const results = []
    for (const project of projects) {
      const tasksRoot = path.join(project.path, '.trellis', 'tasks')
      if (!fs.existsSync(tasksRoot)) continue
      for (const entry of taskDirectories(tasksRoot, params.includeArchived === true)) {
        const taskJson = path.join(entry.full, 'task.json')
        const task = readJson(taskJson)
        if (!task) continue
        if (params.status && task.status !== params.status) continue
        if (params.assignee && task.assignee !== params.assignee) continue
        if (params.agent && task.meta?.agent !== params.agent) continue
        const archived = entry.relativeDir.startsWith('archive/')
        if (!params.includeArchived && (archived || task.archived === true)) continue
        const key = normalizeTaskKey(project.id, entry.relativeDir)
        const stage = stageMap.get(key) || {}
        results.push(
          toTaskDto(project, entry.relativeDir, task, {
            stage: stage.derivedStage ?? task.status ?? null,
            manualStage: stage.manualStage ?? null,
            archived,
          }),
        )
        if (results.length >= MAX_TASKS_PER_LIST) return results
      }
    }
    return results.sort((left, right) => left.taskKey.localeCompare(right.taskKey))
  }

  function getByTaskKey(taskKey) {
    const { projectId, relativeDir } = splitTaskKey(taskKey)
    return get({ repositoryId: projectId, relativeDir })
  }

  function activeOnly(task) {
    return ACTIVE_STATUSES.has(task.status)
  }

  return {
    create,
    setPlan,
    assign,
    setStage,
    get,
    list,
    getByTaskKey,
    activeOnly,
    splitTaskKey,
    normalizeTaskKey,
  }
}
