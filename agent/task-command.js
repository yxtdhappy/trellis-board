import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { isDeepStrictEqual, TextDecoder } from 'node:util'
import { normalizeTaskSlug, slugifyTaskTitle, TASK_SLUG_PATTERN } from '../shared/slug.js'
import { snapshotSha256 } from '../shared/task-snapshot.js'
import { inspectGitProject, readGitStatePath, readGitStatus } from './git-sync.js'
import { AgentError, AGENT_ERROR_CODE, safeErrorMessage } from './protocol.js'
import { buildEnvironment, runProcess } from './process.js'

const PYTHON_TIMEOUT_MS = 150_000
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })

function decodeUtf8(bytes) {
  try {
    return UTF8_DECODER.decode(bytes)
  } catch {
    throw new AgentError(AGENT_ERROR_CODE.INVALID_RESPONSE, '任务文件不是有效的 UTF-8 文本')
  }
}

function isInside(parent, child) {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function requireSyncedRevision(result) {
  if (result?.code === 'TASK_FILE_CONFLICT') {
    throw new AgentError(
      AGENT_ERROR_CODE.HTTP_ERROR,
      result.message || '任务文件已被其他成员修改，本次命令未保存',
    )
  }
  const revision = Number(result?.revision)
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new AgentError(
      AGENT_ERROR_CODE.HTTP_ERROR,
      '任务文件尚未成功上传到服务端，请检查同步错误后重试',
    )
  }
  return revision
}

function statusPaths(output) {
  return String(output || '')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.slice(3).replace(/^"|"$/g, '').replaceAll('\\', '/'))
}

function statusPathSet(output) {
  return new Set(statusPaths(output))
}

async function taskDirectories(repoPath) {
  const root = path.join(repoPath, '.trellis', 'tasks')
  const entries = await fs.readdir(root, { withFileTypes: true })
  return new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name))
}

async function interruptedGitState(repoPath, hooksDir) {
  const markers = [
    ['MERGE_HEAD', '合并'],
    ['rebase-merge', '变基'],
    ['rebase-apply', '变基'],
    ['CHERRY_PICK_HEAD', '拣选提交'],
    ['REVERT_HEAD', '回滚提交'],
  ]
  for (const [marker, label] of markers) {
    const markerPath = await readGitStatePath({ repoPath, hooksDir, marker })
    try {
      await fs.access(markerPath)
      throw new AgentError(
        AGENT_ERROR_CODE.GIT_FAILED,
        `仓库存在未完成的${label}操作，请先处理后再执行任务命令`,
      )
    } catch (error) {
      if (error instanceof AgentError) throw error
      if (error.code !== 'ENOENT') throw error
    }
  }
}

async function runTaskPython(repoPath, args) {
  const script = path.join(repoPath, '.trellis', 'scripts', 'task.py')
  try {
    await fs.access(script)
  } catch {
    throw new AgentError(
      AGENT_ERROR_CODE.MISSING_TRELLIS,
      '项目缺少 .trellis/scripts/task.py，请检查 Trellis 初始化',
    )
  }
  const candidates = [
    [process.env.TRELLIS_PYTHON || 'python', [script, ...args]],
    ['py', ['-3', script, ...args]],
  ]
  let lastError = null
  for (const [command, commandArgs] of candidates) {
    try {
      const result = await runProcess(command, commandArgs, {
        cwd: repoPath,
        env: buildEnvironment({ PYTHONUTF8: '1' }),
        timeoutMs: PYTHON_TIMEOUT_MS,
        maxOutputBytes: 2 * 1024 * 1024,
      })
      if (result.exitCode !== 0) {
        throw new AgentError(
          AGENT_ERROR_CODE.GIT_FAILED,
          `task.py 执行失败：${safeErrorMessage(
            new Error(result.stderr.trim() || result.stdout.trim() || '未知错误'),
          )}`,
        )
      }
      return result
    } catch (error) {
      lastError = error
      if (error instanceof AgentError) throw error
      if (error?.cause?.code !== 'ENOENT') {
        throw new AgentError(AGENT_ERROR_CODE.GIT_FAILED, '无法启动 Python 执行 task.py', {
          cause: error,
        })
      }
    }
  }
  throw new AgentError(
    AGENT_ERROR_CODE.GIT_FAILED,
    '客户端找不到 Python 运行环境，无法执行项目 task.py',
    { cause: lastError },
  )
}

async function atomicWriteJson(target, value) {
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  try {
    await fs.rename(temporary, target)
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

function commandBinding(bindings, command) {
  const binding = bindings.find(
    (item) =>
      item.serverBindingId === command.bindingId &&
      item.taskSpaceId === command.payload.taskSpaceId,
  )
  if (!binding) {
    throw new AgentError(AGENT_ERROR_CODE.BINDING_UNKNOWN, '命令引用了未知的本地任务空间绑定')
  }
  if (binding.syncStatus !== 'approved') {
    throw new AgentError(AGENT_ERROR_CODE.BINDING_NOT_APPROVED, '本地任务空间绑定尚未批准')
  }
  if (binding.readOnly) {
    throw new AgentError(AGENT_ERROR_CODE.BINDING_NOT_APPROVED, '只读任务空间不能执行任务命令')
  }
  return binding
}

export class AgentTaskCommandExecutor {
  constructor({ store, taskSync, loadContext, logger = console }) {
    this.store = store
    this.taskSync = taskSync
    this.loadContext = loadContext
    this.logger = logger
    this.queues = new Map()
  }

  execute(command) {
    const taskSpaceId = command.payload.taskSpaceId
    const previous = this.queues.get(taskSpaceId) || Promise.resolve()
    const current = previous
      .catch(() => {})
      .then(() => this._execute(command))
      .finally(() => {
        if (this.queues.get(taskSpaceId) === current) this.queues.delete(taskSpaceId)
      })
    this.queues.set(taskSpaceId, current)
    return current
  }

  async _execute(command) {
    const { config } = await this.loadContext()
    const binding = commandBinding(config.bindings, command)
    const hooksDir = path.join(this.store.paths.hooksBaseDir, binding.localId)
    const repository = await inspectGitProject({
      repoPath: binding.repoPath,
      branchName: binding.branchName,
      hooksDir,
      allowFileRemote: binding.allowFileRemote,
    })
    if (repository.remoteIdentityKey !== binding.remoteIdentityKey) {
      throw new AgentError(AGENT_ERROR_CODE.REMOTE_MISMATCH, '本地仓库 origin 与任务空间不一致')
    }
    await interruptedGitState(repository.root, hooksDir)
    if (command.type === 'create_task') {
      return this._createTask({ binding, command, hooksDir, repository })
    }
    if (command.type === 'assign_task') {
      return this._assignTask({ binding, command, hooksDir, repository })
    }
    throw new AgentError(AGENT_ERROR_CODE.COMMAND_INVALID, '不支持的任务命令')
  }

  async _createTask({ binding, command, hooksDir, repository }) {
    const payload = command.payload
    const slug = normalizeTaskSlug(payload.slug || slugifyTaskTitle(payload.title))
    if (!TASK_SLUG_PATTERN.test(slug)) {
      throw new AgentError(
        AGENT_ERROR_CODE.COMMAND_INVALID,
        '任务标题没有可用英文标识，请使用包含英文或数字的标题',
      )
    }
    const before = await taskDirectories(repository.root)
    const existing = path.join(repository.root, '.trellis', 'tasks', slug)
    try {
      const taskJson = JSON.parse(decodeUtf8(await fs.readFile(path.join(existing, 'task.json'))))
      if (taskJson?.title === payload.title && taskJson?.assignee === payload.assigneeDevId) {
        return this._finishCreate({
          binding,
          command,
          taskDir: `.trellis/tasks/${slug}`,
          taskId: taskJson.id,
          revision: null,
        })
      }
      throw new AgentError(
        AGENT_ERROR_CODE.COMMAND_INVALID,
        `任务目录 ${slug} 已存在且内容与本次命令不一致，请更换任务标识`,
      )
    } catch (error) {
      if (error instanceof AgentError) throw error
      if (error.code !== 'ENOENT') {
        throw new AgentError(
          AGENT_ERROR_CODE.COMMAND_INVALID,
          `任务目录 ${slug} 已存在但 task.json 无法读取，请先检查本地任务`,
          { cause: error },
        )
      }
    }
    const beforeStatus = await readGitStatus({
      repoPath: repository.root,
      hooksDir,
    })
    if (beforeStatus.exitCode !== 0) {
      throw new AgentError(AGENT_ERROR_CODE.GIT_FAILED, '无法记录命令执行前的 Git 状态')
    }
    await runTaskPython(repository.root, [
      'create',
      payload.title,
      `--description=${payload.description || ''}`,
      `--assignee=${payload.assigneeDevId}`,
      `--priority=${payload.priority || 'P2'}`,
      `--slug=${slug}`,
      '--no-start',
      `--base-branch=${binding.branchName}`,
    ])
    const after = await taskDirectories(repository.root)
    const created = [...after].filter((name) => !before.has(name))
    if (created.length !== 1) {
      throw new AgentError(
        AGENT_ERROR_CODE.GIT_FAILED,
        'task.py 没有生成唯一的新任务目录，客户端拒绝继续同步',
      )
    }
    const taskDir = `.trellis/tasks/${created[0]}`
    const taskJsonPath = path.join(repository.root, ...taskDir.split('/'), 'task.json')
    const taskJson = JSON.parse(decodeUtf8(await fs.readFile(taskJsonPath)))
    const status = await readGitStatus({
      repoPath: repository.root,
      hooksDir,
    })
    if (status.exitCode !== 0) {
      throw new AgentError(AGENT_ERROR_CODE.GIT_FAILED, '无法校验命令执行后的 Git 状态')
    }
    const beforePaths = statusPathSet(beforeStatus.stdout)
    const unexpected = [...statusPathSet(status.stdout)].filter(
      (item) => !beforePaths.has(item) && item !== taskDir && !item.startsWith(`${taskDir}/`),
    )
    if (unexpected.length) {
      throw new AgentError(
        AGENT_ERROR_CODE.LOCAL_DIRTY,
        `task.py 修改了新任务目录之外的文件：${unexpected.join('、')}`,
      )
    }
    const targetStatus = await readGitStatus({
      repoPath: repository.root,
      hooksDir,
      paths: [taskDir],
    })
    if (targetStatus.exitCode !== 0) {
      throw new AgentError(AGENT_ERROR_CODE.GIT_FAILED, '无法校验新任务目录状态')
    }
    return this._finishCreate({
      binding,
      command,
      taskDir,
      taskId: taskJson.id,
    })
  }

  async _finishCreate({ binding, command, taskDir, taskId }) {
    const synced = await this.taskSync.syncTaskDirectories(binding.taskSpaceId, [taskDir])
    const revision = requireSyncedRevision(synced)
    return {
      taskId,
      taskKey: `${binding.taskSpaceId}::${taskDir}`,
      executionTaskKey: `${binding.taskSpaceId}::${taskId}`,
      relativeDir: taskDir,
      revision,
      commandId: command.id,
    }
  }

  async _assignTask({ binding, command, hooksDir, repository }) {
    const payload = command.payload
    const taskDir = String(payload.relativeDir || '')
    const target = path.resolve(repository.root, ...taskDir.split('/'))
    const tasksRoot = path.join(repository.root, '.trellis', 'tasks')
    if (!isInside(tasksRoot, target) || target === path.resolve(tasksRoot)) {
      throw new AgentError(AGENT_ERROR_CODE.COMMAND_INVALID, '改派任务目录越界')
    }
    const taskJsonPath = path.join(target, 'task.json')
    const content = decodeUtf8(await fs.readFile(taskJsonPath))
    const task = JSON.parse(content)
    const status = await readGitStatus({
      repoPath: repository.root,
      hooksDir,
      paths: [taskDir],
    })
    if (status.exitCode !== 0) {
      throw new AgentError(AGENT_ERROR_CODE.GIT_FAILED, '无法检查目标任务目录状态')
    }
    const dirty = status.stdout.trim()
    const taskJsonRelative = `${taskDir}/task.json`
    const dirtyPaths = statusPaths(status.stdout)
    const { api } = await this.loadContext()
    if (dirty && typeof api.fetchTaskDirectory !== 'function') {
      throw new AgentError(
        AGENT_ERROR_CODE.LOCAL_DIRTY,
        `目标任务目录有未提交修改，请先处理：${dirty.slice(0, 500)}`,
      )
    }
    const directory = await api.fetchTaskDirectory(binding.taskSpaceId, taskDir)
    const taskJsonFile = directory.files.find((file) => file.path.endsWith('/task.json'))
    if (!taskJsonFile) {
      throw new AgentError(AGENT_ERROR_CODE.INVALID_RESPONSE, '服务端缺少目标任务的 task.json')
    }
    if (payload.baseTaskSha256 && taskJsonFile.sha256 !== payload.baseTaskSha256) {
      throw new AgentError(AGENT_ERROR_CODE.HTTP_ERROR, '任务文件已被其他成员修改，改派命令已取消')
    }
    const localMatchesServer = snapshotSha256(content) === taskJsonFile.sha256
    const retryAfterUploadFailure =
      !localMatchesServer &&
      dirtyPaths.length > 0 &&
      dirtyPaths.every((item) => item === taskJsonRelative) &&
      typeof taskJsonFile.content === 'string' &&
      isDeepStrictEqual(task, {
        ...JSON.parse(taskJsonFile.content),
        assignee: payload.assigneeDevId,
      })
    if (dirty && !retryAfterUploadFailure) {
      throw new AgentError(
        AGENT_ERROR_CODE.LOCAL_DIRTY,
        `目标任务目录有未提交修改，请先处理：${dirty.slice(0, 500)}`,
      )
    }
    if (!localMatchesServer && !retryAfterUploadFailure) {
      throw new AgentError(
        AGENT_ERROR_CODE.HTTP_ERROR,
        '本地任务文件与服务端基线不一致，请先同步任务空间后再改派',
      )
    }
    if (localMatchesServer) {
      task.assignee = payload.assigneeDevId
      await atomicWriteJson(taskJsonPath, task)
    }
    const synced = await this.taskSync.syncTaskDirectories(binding.taskSpaceId, [taskDir], {
      baseShaByPath: { [taskJsonFile.path]: taskJsonFile.sha256 },
    })
    const revision = requireSyncedRevision(synced)
    return {
      taskId: task.id,
      taskKey: `${binding.taskSpaceId}::${taskDir}`,
      executionTaskKey: `${binding.taskSpaceId}::${task.id}`,
      relativeDir: taskDir,
      assignee: payload.assigneeDevId,
      revision,
      commandId: command.id,
    }
  }
}
