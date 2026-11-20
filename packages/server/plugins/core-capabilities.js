import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { ERROR_CODES, appError, invalidParams } from './protocol.js'

/**
 * 宿主内置 capability 的公开契约。
 *
 * 与插件 manifest 的 provides 使用同一套名字/版本/方法模型：
 * - 插件通过 requires 声明依赖；
 * - 宿主在这里登记实现，capability/call 统一路由到宿主或插件；
 * - 新增核心资源时只追加一个 definition + handlers，不再扩展协议方法表。
 */
export const CORE_CAPABILITIES = Object.freeze([
  {
    name: 'trellis.capabilities',
    version: '1.0.0',
    description: '宿主能力目录与通用调用',
    methods: {
      list: { access: 'read', permission: 'capabilities:call', timeoutMs: 10_000 },
      call: { access: 'write', permission: 'capabilities:invoke', timeoutMs: 300_000 },
    },
  },
  {
    name: 'trellis.projects',
    version: '1.0.0',
    description: '当前看板项目上下文',
    methods: {
      list: { access: 'read', permission: 'projects:read', timeoutMs: 10_000 },
      get: { access: 'read', permission: 'projects:read', timeoutMs: 10_000 },
      current: { access: 'read', permission: 'projects:read', timeoutMs: 10_000 },
      branches: { access: 'read', permission: 'projects:read', timeoutMs: 10_000 },
    },
  },
  {
    name: 'trellis.repositories',
    version: '1.0.0',
    description: 'Trellis 看板工作区仓库',
    methods: {
      list: { access: 'read', permission: 'repositories:read', timeoutMs: 10_000 },
      add: { access: 'write', permission: 'repositories:write', timeoutMs: 120_000 },
      remove: { access: 'write', permission: 'repositories:write', timeoutMs: 120_000 },
    },
  },
])

function publicRepository({ id, name, path: repositoryPath }) {
  return { id, name, path: repositoryPath }
}

const BRANCH_CACHE_TTL_MS = 15_000
const branchCache = new Map()

/** 本地分支列表：只读 refs/heads，避免把远端分支混进「基线分支」选项。 */
function readLocalBranches(repositoryPath) {
  const cached = branchCache.get(repositoryPath)
  if (cached && Date.now() - cached.at < BRANCH_CACHE_TTL_MS) return cached.value
  const value = { branch: null, branches: [] }
  try {
    const output = execFileSync(
      'git',
      ['for-each-ref', '--format=%(refname:short)%09%(HEAD)', 'refs/heads'],
      {
        cwd: repositoryPath,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      },
    )
    const branches = []
    for (const line of output.split(/\r?\n/)) {
      const [name, head = ''] = line.split('\t')
      if (!name) continue
      branches.push(name)
      if (head.trim() === '*') value.branch = name
    }
    branches.sort((left, right) => left.localeCompare(right, 'en'))
    value.branches = branches
  } catch {
    // 非 Git 目录或环境里没有 git 时返回空列表，面板退化为自由输入。
  }
  if (!value.branch) {
    try {
      const head = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: repositoryPath,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      }).trim()
      if (head && head !== 'HEAD') value.branch = head
    } catch {
      // 忽略：没有当前分支时由面板让用户手填。
    }
  }
  branchCache.set(repositoryPath, { at: Date.now(), value })
  return value
}

function readDeveloper(repositoryPath) {
  try {
    const value = fs
      .readFileSync(path.join(repositoryPath, '.trellis', '.developer'), 'utf8')
      .trim()
    return value ? value.slice(0, 200) : null
  } catch {
    return null
  }
}

function publicProject({
  id,
  name,
  path: repositoryPath,
  branch,
  branchName,
  developerId,
}) {
  const project = { repositoryId: id, name, path: repositoryPath }
  const currentBranch = branch ?? branchName
  if (currentBranch) project.branch = currentBranch
  const developer = developerId || readDeveloper(repositoryPath)
  if (developer) project.developerId = developer
  return project
}

function projectList(repositories, repositoryService) {
  return (repositoryService?.list ? repositoryService.list() : repositories).map(publicProject)
}

function repositoryList(repositories, repositoryService) {
  return repositoryService?.list ? repositoryService.list() : repositories
}

function normalizeInputs(params = {}) {
  const raw = Array.isArray(params.repositories)
    ? params.repositories
    : Array.isArray(params.paths)
      ? params.paths.map((repositoryPath) => ({ path: repositoryPath }))
      : [params]
  const inputs = raw.filter((input) => input && typeof input === 'object')
  if (!inputs.length) throw invalidParams('repository/add 缺少 repositories')
  return inputs
}

function addInMemory(repositories, inputs) {
  const added = []
  for (const input of inputs) {
    const rawPath = String(input.path ?? '').trim()
    if (!rawPath) throw invalidParams('项目路径不能为空')
    const repositoryPath = path.resolve(rawPath)
    if (!fs.existsSync(repositoryPath) || !fs.statSync(repositoryPath).isDirectory()) {
      throw invalidParams(`项目目录不存在: ${repositoryPath}`)
    }
    if (!fs.existsSync(path.join(repositoryPath, '.trellis'))) {
      throw invalidParams(`目标目录尚未初始化 Trellis，缺少 .trellis 目录: ${repositoryPath}`)
    }
    const duplicate = repositories.find(
      (repository) => path.resolve(repository.path) === repositoryPath,
    )
    if (duplicate) throw invalidParams(`该路径已在看板中: ${repositoryPath}`)
    const fallbackName = path.basename(repositoryPath)
    const repository = {
      id: String(input.id || fallbackName).trim(),
      name: String(input.name || fallbackName).trim() || fallbackName,
      path: repositoryPath.replaceAll('\\', '/'),
    }
    if (!repository.id) throw invalidParams('repository/add 缺少 id')
    if (repositories.some((item) => item.id === repository.id)) {
      throw invalidParams(`仓库 ID 已存在: ${repository.id}`)
    }
    repositories.push(repository)
    added.push(repository)
  }
  return added
}

export function createCoreCapabilities({
  repositories,
  repositoryService,
  listCapabilities = () => [],
  invokeCapability = async () => {
    throw appError(ERROR_CODES.CAPABILITY_UNAVAILABLE, '宿主未配置能力调用代理')
  },
}) {
  const definitions = new Map(CORE_CAPABILITIES.map((definition) => [definition.name, definition]))
  const handlers = new Map()

  handlers.set('trellis.capabilities', {
    async list() {
      return { capabilities: listCapabilities() }
    },
    async call(params, state) {
      const name = String(params?.name ?? '').trim()
      const method = String(params?.method ?? '').trim()
      if (!name || !method) throw invalidParams('capability/call 缺少 name 或 method')
      if (name === 'trellis.capabilities' && method === 'call') {
        throw invalidParams('不能通过能力代理递归调用 trellis.capabilities.call')
      }
      const timeoutMs = params?.timeoutMs === undefined ? undefined : Number(params.timeoutMs)
      if (
        timeoutMs !== undefined &&
        (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300_000)
      ) {
        throw invalidParams('timeoutMs 必须是 1000-300000 的整数')
      }
      const result = await invokeCapability({
        state,
        name,
        method,
        params: params?.params ?? {},
        timeoutMs,
      })
      return result?.value ?? null
    },
  })

  handlers.set('trellis.projects', {
    async list() {
      return { projects: projectList(repositories, repositoryService) }
    },
    async get(params) {
      const id = String(params?.id ?? params?.repositoryId ?? '').trim()
      if (!id) throw invalidParams('projects/get 缺少 id')
      const project = projectList(repositories, repositoryService).find(
        (item) => item.repositoryId === id,
      )
      if (!project) throw appError(ERROR_CODES.NOT_FOUND, `项目不存在: ${id}`)
      return { project }
    },
    async current(params) {
      const projects = projectList(repositories, repositoryService)
      const requested = String(params?.repositoryId ?? params?.id ?? '').trim()
      const project = requested
        ? (projects.find((item) => item.repositoryId === requested) ?? null)
        : projects.length === 1
          ? projects[0]
          : null
      return { project }
    },
    async branches(params) {
      const id = String(params?.repositoryId ?? params?.id ?? '').trim()
      if (!id) throw invalidParams('projects/branches 缺少 repositoryId')
      const project = projectList(repositories, repositoryService).find(
        (item) => item.repositoryId === id,
      )
      if (!project) throw appError(ERROR_CODES.NOT_FOUND, `项目不存在: ${id}`)
      return { repositoryId: project.repositoryId, ...readLocalBranches(project.path) }
    },
  })

  handlers.set('trellis.repositories', {
    async list() {
      return {
        repositories: repositoryList(repositories, repositoryService).map(publicRepository),
      }
    },
    async add(params) {
      const inputs = normalizeInputs(params)
      if (repositoryService?.addMany) {
        const result = await repositoryService.addMany(inputs)
        return {
          ...result,
          repositories: repositoryList(repositories, repositoryService).map(publicRepository),
        }
      }
      const added = addInMemory(repositories, inputs)
      return {
        added: added.map(publicRepository),
        repositories: repositories.map(publicRepository),
      }
    },
    async remove(params) {
      const id = String(params.id ?? '').trim()
      if (!id) throw invalidParams('repository/remove 缺少 id')
      if (repositoryService?.remove) {
        const result = await repositoryService.remove({ id })
        return {
          ...result,
          repositories: repositoryList(repositories, repositoryService).map(publicRepository),
        }
      }
      const index = repositories.findIndex((repository) => repository.id === id)
      if (index < 0) throw appError(ERROR_CODES.NOT_FOUND, `仓库不存在: ${id}`)
      const [removed] = repositories.splice(index, 1)
      return {
        removed: publicRepository(removed),
        repositories: repositories.map(publicRepository),
      }
    },
  })

  return {
    definitions: () => [...definitions.values()],
    has(name) {
      return definitions.has(name)
    },
    definition(name) {
      return definitions.get(name) ?? null
    },
    async call(state, name, method, params) {
      const definition = definitions.get(name)
      const meta = definition?.methods?.[method]
      if (!meta) {
        throw appError(
          ERROR_CODES.CAPABILITY_METHOD_DENIED,
          `capability 未提供方法: ${name}.${method}`,
        )
      }
      if (meta.permission && !state.manifest.permissions.includes(meta.permission)) {
        throw appError(ERROR_CODES.PERMISSION_DENIED, `插件未声明权限 ${meta.permission}`)
      }
      return handlers.get(name)[method](params ?? {}, state)
    },
  }
}
