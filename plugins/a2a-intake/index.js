import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createPlugin } from '@trellis-board/server/plugins/sdk.js'

const PLUGIN_ID = 'a2a-intake'
const PANEL_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'panel')
const PANEL_ASSETS = new Map([
  ['/panel', ['index.html', 'text/html; charset=utf-8']],
  ['/panel/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/panel/app.css', ['app.css', 'text/css; charset=utf-8']],
])

const DEFAULTS = {
  token: '',
  repositoryId: null,
  defaultAssignee: '',
  defaultPriority: 'P2',
  publicBaseUrl: '',
  protocolVersion: '0.3.0',
  maxTextLength: 20_000,
  defaultAgent: 'opencode',
}

const METHOD_ALIASES = new Map([
  ['message/send', 'send'],
  ['SendMessage', 'send'],
  ['tasks/get', 'get'],
  ['GetTask', 'get'],
  ['tasks/cancel', 'cancel'],
  ['CancelTask', 'cancel'],
  ['board/action', 'board'],
  ['board/call', 'board'],
  ['BoardAction', 'board'],
])

const BOARD_ACTIONS = Object.freeze({
  'repositories.list': {
    capability: 'trellis.repositories',
    method: 'list',
    timeoutMs: 10_000,
    params: () => ({}),
  },
  'repositories.add': { capability: 'trellis.repositories', method: 'add' },
  'repositories.remove': { capability: 'trellis.repositories', method: 'remove' },
  'tasks.list': { host: 'tasks', method: 'list', wrap: 'tasks' },
  'tasks.get': { host: 'tasks', method: 'get' },
  'capabilities.list': {
    capability: 'trellis.capabilities',
    method: 'list',
    timeoutMs: 10_000,
    params: () => ({}),
  },
  'capabilities.call': {
    capability: 'trellis.capabilities',
    method: 'call',
    timeoutMs: 300_000,
  },
})

function normalizeConfig(raw = {}) {
  return { ...DEFAULTS, ...raw }
}

function rpcError(id, code, message, data) {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } }
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result }
}

function textParts(message) {
  const parts = Array.isArray(message?.parts) ? message.parts : []
  return parts
    .filter((part) => part && (part.kind === 'text' || part.type === 'text'))
    .map((part) => String(part.text ?? ''))
    .join('\n')
    .trim()
}

function parsePayload(text) {
  const trimmed = String(text || '').trim()
  if (!trimmed) return {}
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch {
      // 回落为纯文本标题。
    }
  }
  const firstLine = trimmed.split('\n').find((line) => line.trim()) ?? 'A2A 任务'
  return { title: firstLine.slice(0, 200), description: trimmed }
}

function toTaskState({ status, stage, archived, blocked, dorMissingCount } = {}) {
  if (status === 'canceled') return 'canceled'
  if (archived === true) return status === 'completed' ? 'completed' : 'canceled'
  if (blocked === true || Number(dorMissingCount) > 0) return 'input-required'
  if (status === 'completed' || stage === 'archive' || stage === 'journal') return 'completed'
  if (status === 'in_progress') return 'working'
  return 'submitted'
}

export default createPlugin({
  name: PLUGIN_ID,
  version: '1.0.0',
  apiVersion: 1,
  permissions: [
    'tasks:read',
    'tasks:write',
    'store',
    'http:root',
    'capabilities:call',
    'capabilities:invoke',
    'repositories:read',
    'repositories:write',
  ],

  async onStart(ctx) {
    const config = normalizeConfig(ctx.config)
    let sequence = 0
    let project = null
    try {
      const listed = await ctx.capabilities.call('trellis.projects', 'list', {})
      project = listed?.projects?.[0] ?? null
    } catch {
      // 项目能力不可用时保持空配置。
    }
    const defaultAssignee = String(config.defaultAssignee || project?.developerId || '').trim()
    const defaultRepositoryId = config.repositoryId || project?.repositoryId || null
    let localToken = String(config.token || '').trim()
    if (!localToken) {
      const stored = await ctx.store.get('local-token').catch(() => null)
      localToken = String(stored || '').trim()
      if (!localToken) {
        localToken = randomBytes(24).toString('base64url')
        await ctx.store
          .set('local-token', localToken)
          .catch((error) => ctx.log.warn('A2A token 持久化失败', { message: error.message }))
      }
    }

    function publicBase(request) {
      const configured = String(config.publicBaseUrl || '').replace(/\/+$/, '')
      if (configured) return configured
      const forwarded = String(request?.headers?.['x-trellis-base'] || '').replace(/\/+$/, '')
      if (forwarded) return forwarded
      const host = request?.headers?.host
      return host ? `http://${host}` : ''
    }

    function card(request) {
      const base = publicBase(request)
      return {
        name: `${PLUGIN_ID}`,
        description:
          '通过 A2A JSON-RPC 创建 Trellis 任务，并以标准 capability 桥接宿主与其他插件能力',
        version: '1.0.0',
        protocolVersion: config.protocolVersion,
        url: `${base}/a2a`,
        preferredTransport: 'JSONRPC',
        capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
        defaultInputModes: ['text/plain', 'application/json'],
        defaultOutputModes: ['application/json'],
        skills: [
          {
            id: 'create-task',
            name: '创建 Trellis 任务',
            description: '从文本或 JSON 创建一条 Trellis 任务，返回任务标识',
            tags: ['trellis', 'task'],
            inputModes: ['text/plain', 'application/json'],
            outputModes: ['application/json'],
            examples: ['{"title":"修复登录","assignee":"alice","priority":"P2"}'],
          },
          {
            id: 'manage-repositories',
            name: '管理工作区',
            description: '通过宿主 trellis.repositories 能力注册、查询或移除 Trellis 工作区',
            tags: ['trellis', 'repository', 'workspace'],
            inputModes: ['application/json'],
            outputModes: ['application/json'],
            examples: [
              '{"action":"repositories.list","input":{}}',
              '{"action":"repositories.add","input":{"path":"/path/to/repo","name":"demo"}}',
              '{"action":"repositories.remove","input":{"id":"demo"}}',
            ],
          },
          {
            id: 'query-tasks',
            name: '查询 Trellis 任务',
            description: '通过宿主 tasks 能力查询任务列表或单条任务',
            tags: ['trellis', 'task', 'query'],
            inputModes: ['application/json'],
            outputModes: ['application/json'],
            examples: [
              '{"action":"tasks.list","input":{"repositoryId":"demo","includeArchived":true}}',
              '{"action":"tasks.get","input":{"repositoryId":"demo","relativeDir":"11-04-demo"}}',
            ],
          },
          {
            id: 'invoke-capability',
            name: '调用标准能力',
            description:
              '通过宿主 trellis.capabilities 发现并调用已注册的 capability；具体目标由运行时决定，不在 A2A 接入层硬编码',
            tags: ['capability', 'plugin', 'bridge'],
            inputModes: ['application/json'],
            outputModes: ['application/json'],
            examples: [
              '{"action":"capabilities.list","input":{}}',
              '{"action":"capabilities.call","input":{"name":"<capability>","method":"<method>","params":{}}}',
            ],
          },
        ],
      }
    }

    async function readLive(record) {
      if (!record.taskKey) return null
      const index = String(record.taskKey).indexOf('::')
      if (index < 0) return null
      try {
        return await ctx.tasks.get({
          repositoryId: record.taskKey.slice(0, index),
          relativeDir: record.taskKey.slice(index + 2),
        })
      } catch {
        return null
      }
    }

    async function taskDto(record) {
      const live = await readLive(record)
      const status =
        record.state === 'canceled' ? 'canceled' : (live?.status ?? record.status ?? 'planning')
      const stage = live?.manualStage || live?.stage || null
      return {
        kind: 'task',
        id: record.id,
        contextId: record.contextId ?? record.id,
        status: {
          state: toTaskState({
            status,
            stage,
            archived: live?.archived,
            blocked: live?.blocked,
            dorMissingCount: live?.dorMissingCount,
          }),
          timestamp: live?.updatedAt ?? record.updatedAt,
        },
        artifacts: [
          {
            artifactId: `${record.id}-task`,
            name: 'trellis-task.json',
            parts: [
              {
                kind: 'text',
                text: JSON.stringify({ taskKey: record.taskKey, title: record.title }),
              },
            ],
          },
        ],
        metadata: {
          trellisTaskKey: record.taskKey,
          protocol: record.protocol ?? '0.3',
        },
      }
    }

    async function handleSend(id, params, protocol) {
      const message = params?.message ?? {}
      const text = textParts(message)
      if (!text) return rpcError(id, -32602, 'message.parts 中缺少 text')
      if (text.length > config.maxTextLength) {
        return rpcError(id, -32602, `文本超过 ${config.maxTextLength} 字符`)
      }

      const idempotencyKey = String(
        params?.metadata?.idempotencyKey || message.messageId || params?.messageId || '',
      ).trim()
      if (idempotencyKey) {
        const previous = await ctx.store.get(`idem:${idempotencyKey}`)
        if (previous?.taskId) {
          const record = await ctx.store.get(`task:${previous.taskId}`)
          if (record) return rpcResult(id, await taskDto(record))
        }
      }

      const payload = { ...parsePayload(text), ...(params?.metadata?.trellis ?? {}) }
      const title = String(payload.title ?? '').trim()
      if (!title) return rpcError(id, -32602, '缺少任务标题')
      const assignee = String(payload.assignee ?? defaultAssignee ?? '').trim()
      if (!assignee) return rpcError(id, -32602, '缺少负责人 assignee')
      const agent = String(
        payload.agent ?? params?.metadata?.agent ?? config.defaultAgent ?? '',
      ).trim()

      sequence += 1
      const taskId = `a2a-${Date.now().toString(36)}-${sequence}`
      const createdAt = new Date().toISOString()

      try {
        const created = await ctx.tasks.create({
          repositoryId: payload.repositoryId || defaultRepositoryId,
          title: title.slice(0, 200),
          description: String(payload.description ?? text).slice(0, 3000),
          prd: String(payload.prd ?? `# ${title}\n\n${payload.description ?? text}\n`),
          assignee,
          priority: String(payload.priority ?? config.defaultPriority ?? 'P2'),
          slug: String(payload.slug || taskId),
          taskType:
            String(payload.taskType ?? params?.metadata?.taskType ?? '').trim() || undefined,
          workType:
            String(payload.workType ?? params?.metadata?.workType ?? '').trim() || undefined,
          meta: agent ? { agent } : {},
        })
        const record = {
          id: taskId,
          taskKey: created?.taskKey ?? null,
          title,
          assignee,
          status: 'planning',
          agent,
          protocol,
          contextId: message.contextId ?? taskId,
          createdAt,
          updatedAt: createdAt,
        }
        await ctx.store.set(`task:${taskId}`, record)
        if (idempotencyKey) {
          await ctx.store.set(`idem:${idempotencyKey}`, { taskId, createdAt })
        }
        ctx.log.info('A2A 建任务', { taskId, taskKey: record.taskKey, assignee, protocol })
        return rpcResult(id, await taskDto(record))
      } catch (error) {
        if (error?.code === 1004 || error?.code === 1001 || error?.code === 1002) {
          return rpcError(id, -32602, error.message, { code: error.code })
        }
        ctx.log.error('A2A 建任务失败', { message: error.message })
        return rpcError(id, -32603, error.message)
      }
    }

    async function handleGet(id, params) {
      const taskId = String(params?.id ?? params?.taskId ?? '').trim()
      if (!taskId) return rpcError(id, -32602, '缺少任务 id')
      const record = await ctx.store.get(`task:${taskId}`)
      if (!record) return rpcError(id, -32001, `任务不存在: ${taskId}`)
      return rpcResult(id, await taskDto(record))
    }

    async function handleCancel(id, params) {
      const taskId = String(params?.id ?? params?.taskId ?? '').trim()
      if (!taskId) return rpcError(id, -32602, '缺少任务 id')
      const record = await ctx.store.get(`task:${taskId}`)
      if (!record) return rpcError(id, -32001, `任务不存在: ${taskId}`)
      if (record.state !== 'canceled') {
        record.state = 'canceled'
        record.updatedAt = new Date().toISOString()
        await ctx.store.set(`task:${taskId}`, record)
        ctx.log.info('A2A 取消任务', { taskId })
      }
      return rpcResult(id, await taskDto(record))
    }

    function actionInput(params = {}) {
      if (params.input && typeof params.input === 'object') return params.input
      if (params.params && typeof params.params === 'object') return params.params
      const rest = { ...params }
      delete rest.action
      delete rest.operation
      return rest
    }

    async function callCapability(name, method, params, timeoutMs = 120_000) {
      return ctx.capabilities.call(name, method, params ?? {}, { timeoutMs })
    }

    async function handleBoard(id, params) {
      const action = String(params?.action ?? params?.operation ?? '').trim()
      const definition = BOARD_ACTIONS[action]
      if (!definition) {
        return rpcError(id, -32601, `不支持的 action: ${action}`, {
          supported: Object.keys(BOARD_ACTIONS),
        })
      }
      const input = actionInput(params)
      try {
        if (definition.host === 'tasks') {
          const value = await ctx.tasks[definition.method](input)
          return rpcResult(id, definition.wrap === 'tasks' ? { tasks: value } : value)
        }
        const value = await callCapability(
          definition.capability,
          definition.method,
          definition.params ? definition.params(input) : input,
          definition.timeoutMs,
        )
        return rpcResult(id, value)
      } catch (error) {
        ctx.log.error('A2A 能力调用失败', { action, message: error.message })
        return rpcError(id, -32603, error.message, {
          code: error.code ?? null,
          detail: error.detail ?? null,
        })
      }
    }

    const handlers = { send: handleSend, get: handleGet, cancel: handleCancel, board: handleBoard }

    ctx.http.public('GET', '/.well-known/agent-card.json', async (request) => ({
      status: 200,
      body: card(request),
    }))

    ctx.http.public('GET', '/.well-known/agent.json', async (request) => ({
      status: 200,
      body: card(request),
    }))

    for (const [route, [file, type]] of PANEL_ASSETS) {
      ctx.http.route('GET', route, async () => {
        try {
          return {
            status: 200,
            headers: { 'content-type': type },
            body: fs.readFileSync(path.join(PANEL_DIR, file), 'utf8'),
          }
        } catch {
          return { status: 404, body: { error: '面板资源缺失' } }
        }
      })
    }

    ctx.http.route('GET', '/config', async (request) => ({
      status: 200,
      body: {
        token: localToken,
        publicBaseUrl: publicBase(request),
        repositoryId: defaultRepositoryId,
        defaultAssignee,
      },
    }))

    ctx.http.public('POST', '/a2a', async (request) => {
      const provided = String(
        request.headers.authorization || request.headers.Authorization || '',
      ).replace(/^Bearer\s+/i, '')
      if (!provided) return { status: 401, body: { error: '缺少访问令牌' } }
      if (provided !== localToken) return { status: 403, body: { error: '访问令牌无效' } }
      let envelope
      try {
        envelope = request.json()
      } catch {
        return { status: 200, body: rpcError(null, -32700, '请求不是合法 JSON') }
      }
      if (!envelope || envelope.jsonrpc !== '2.0' || typeof envelope.method !== 'string') {
        return { status: 200, body: rpcError(envelope?.id ?? null, -32600, '非法 JSON-RPC 请求') }
      }
      const action = METHOD_ALIASES.get(envelope.method)
      if (!action) {
        return {
          status: 200,
          body: rpcError(envelope.id, -32601, `不支持的方法: ${envelope.method}`, {
            supported: [...METHOD_ALIASES.keys()],
          }),
        }
      }
      const protocol =
        envelope.method === 'SendMessage' ||
        envelope.method === 'GetTask' ||
        envelope.method === 'CancelTask' ||
        envelope.method === 'BoardAction'
          ? '1.0'
          : '0.3'
      const body = await handlers[action](envelope.id, envelope.params ?? {}, protocol)
      return { status: 200, body }
    })

    ctx.log.info('a2a-intake 已启动', {
      repositoryId: defaultRepositoryId,
      defaultAssignee,
      publicBaseUrl: config.publicBaseUrl,
    })
  },
})
