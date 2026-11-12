import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPlugin } from '../../apps/server/plugins/sdk.js'
import { AcpClient } from './acp-client.js'

const PLUGIN_ID = 'acp-dispatch'
const PANEL_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'panel')

const DEFAULTS = {
  agent: 'opencode',
  command: '',
  args: [],
  cwd: '',
  env: {},
  repositoryId: null,
  permission: {
    default: 'allow',
    byKind: { delete: 'deny', fetch: 'deny', switch_mode: 'deny' },
  },
  runTimeoutMs: 6 * 60 * 60_000,
  idleTimeoutMs: 30 * 60_000,
  sessionIdleMs: 10 * 60_000,
  maxSessions: 3,
  maxConcurrent: 1,
  retryFailed: false,
  rerunSucceeded: false,
  dispatchUnbound: true,
  promptTemplate: null,
}

const DEFAULT_PROMPT = [
  '请执行 Trellis 任务 {relativeDir}（{title}）。',
  '仓库目录：{cwd}。',
  '先阅读 .trellis/tasks/{relativeDir}/prd.md 与同目录下的 implement.md / check.jsonl，',
  '按其中的验收标准实施改动并运行相关测试，最后给出改动摘要与验证结果。',
].join('\n')

const PANEL_ASSETS = new Map([
  ['/panel', ['index.html', 'text/html; charset=utf-8']],
  ['/panel/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/panel/app.css', ['app.css', 'text/css; charset=utf-8']],
])

function normalizeConfig(raw = {}) {
  return {
    ...DEFAULTS,
    ...raw,
    args: Array.isArray(raw.args) ? raw.args.map(String) : DEFAULTS.args,
    env: raw.env && typeof raw.env === 'object' ? raw.env : {},
    permission: {
      ...DEFAULTS.permission,
      ...(raw.permission || {}),
      byKind: { ...DEFAULTS.permission.byKind, ...(raw.permission?.byKind || {}) },
    },
  }
}

function renderPrompt(template, task) {
  const relativeDir = task.relativeDir ?? task.taskKey?.split('::')[1] ?? task.taskKey
  const cwd = task.projectPath ?? ''
  return String(template)
    .replaceAll('{taskKey}', task.taskKey)
    .replaceAll('{title}', task.title ?? '')
    .replaceAll('{relativeDir}', relativeDir)
    .replaceAll('{cwd}', cwd)
}

function normalizeTaskRelativeDir(raw) {
  const value = String(raw ?? '')
    .trim()
    .replaceAll('\\', '/')
    .replace(/^\.\/+/, '')
    .replace(/^\.trellis\/tasks\/+/, '')
    .replace(/\/+$/, '')
  if (!value || value.includes('..') || value.startsWith('/')) return null
  return value
}

function splitTaskKey(taskKey) {
  const [projectId, rawDir] = String(taskKey ?? '').split('::')
  const relativeDir = normalizeTaskRelativeDir(rawDir)
  if (!projectId || !relativeDir) return null
  return { projectId, relativeDir }
}

function permissionStats(decisions = []) {
  return {
    allow: decisions.filter((decision) => !decision.cancelled && decision.policy === 'allow')
      .length,
    deny: decisions.filter((decision) => !decision.cancelled && decision.policy !== 'allow').length,
  }
}

export default createPlugin({
  name: PLUGIN_ID,
  version: '1.1.0',
  apiVersion: 1,
  permissions: [
    'tasks:read',
    'store',
    'events',
    'events:emit',
    'events:publish',
    'http:route',
    'runs:read',
    'runs:write',
    'panels',
  ],

  async onStart(ctx) {
    const config = normalizeConfig(ctx.config)
    if (!config.command) {
      ctx.log.warn('acp-dispatch 未配置 command，插件保持空闲')
    }

    const active = new Map()
    const queue = []
    const sessions = new Map()
    let running = 0
    let discoveryTimer = null
    let reaperTimer = null
    let stopped = false
    let lastDiscovery = null

    const promptTemplate = config.promptTemplate || DEFAULT_PROMPT
    const sessionKey = (taskKey) => `session:${taskKey}`

    function agentBinding(task) {
      const binding = task?.meta?.agent
      return typeof binding === 'string' ? binding.trim() : ''
    }

    function publish(type, payload) {
      ctx.events.publish(type, payload).catch(() => {})
    }

    function buildResult(record, { status } = {}) {
      const decisions = record.decisions ?? []
      return {
        version: 1,
        agent: record.agent,
        command: record.command,
        cwd: record.cwd,
        session: record.session,
        outcome: {
          status: status ?? record.status,
          stopReason: record.stopReason,
          error: record.error,
        },
        stats: {
          updates: record.updates,
          chunkUpdates: record.chunkUpdates,
          toolCalls: record.toolCalls,
          permissions: permissionStats(decisions),
          startedAt: record.startedAt,
          finishedAt: record.finishedAt,
          durationMs: record.durationMs,
        },
        summary: { text: record.summary ?? null },
      }
    }

    async function shouldDispatch(task) {
      if (active.has(task.taskKey)) return false
      const [previous] = await ctx.runs.list({ taskKey: task.taskKey, limit: 1 })
      if (!previous) return true
      if (['queued', 'starting', 'running'].includes(previous.status)) return false
      if (previous.status === 'succeeded') return config.rerunSucceeded
      return config.retryFailed
    }

    function enqueue(task) {
      if (active.has(task.taskKey)) return false
      if (queue.some((item) => item.taskKey === task.taskKey)) return false
      queue.push(task)
      drain()
      return true
    }

    async function drain() {
      while (!stopped && running < config.maxConcurrent && queue.length) {
        const task = queue.shift()
        running += 1
        execute(task)
          .catch((error) =>
            ctx.log.error('任务执行异常', { taskKey: task.taskKey, message: error.message }),
          )
          .finally(() => {
            running -= 1
            drain()
          })
      }
    }

    async function discover() {
      if (!config.command) return { dispatched: 0, skipped: 'no-command' }
      const tasks = await ctx.tasks.list({
        repositoryId: config.repositoryId ?? undefined,
        status: 'in_progress',
      })
      let dispatched = 0
      let skippedOtherAgent = 0
      let skippedUnbound = 0
      for (const task of tasks) {
        const binding = agentBinding(task)
        if (binding && config.agent && binding !== config.agent) {
          skippedOtherAgent += 1
          continue
        }
        if (!binding && config.dispatchUnbound === false) {
          skippedUnbound += 1
          continue
        }
        if (!(await shouldDispatch(task))) continue
        if (enqueue(task)) dispatched += 1
      }
      lastDiscovery = {
        at: new Date().toISOString(),
        scanned: tasks.length,
        dispatched,
        skippedOtherAgent,
        skippedUnbound,
      }
      if (dispatched) ctx.log.info('自动派发', lastDiscovery)
      return lastDiscovery
    }

    function newClient(task, { onUpdate } = {}) {
      const cwd = config.cwd || task.projectPath || process.cwd()
      return new AcpClient({
        command: config.command,
        args: config.args,
        cwd,
        env: config.env,
        permission: config.permission,
        runTimeoutMs: config.runTimeoutMs,
        idleTimeoutMs: config.idleTimeoutMs,
        log: (level, message, fields) => ctx.log[level]?.(message, fields),
        onUpdate,
      })
    }

    async function openSession(task, { client, allowResume }) {
      client.start()
      await client.initialize()
      let resumed = false
      if (allowResume && client.supportsLoadSession()) {
        const previous = await ctx.store.get(sessionKey(task.taskKey))
        if (previous?.sessionId) {
          try {
            await client.loadSession({ sessionId: previous.sessionId, cwd: client.cwd })
            resumed = true
            ctx.log.info('复用 ACP 会话', { taskKey: task.taskKey, sessionId: previous.sessionId })
          } catch (failure) {
            ctx.log.warn('session/load 失败，回退 session/new', {
              taskKey: task.taskKey,
              message: failure.message,
            })
          }
        }
      }
      if (!resumed) await client.newSession({ cwd: client.cwd })
      await ctx.store
        .set(sessionKey(task.taskKey), {
          sessionId: client.sessionId,
          updatedAt: new Date().toISOString(),
        })
        .catch(() => {})
      return {
        session: {
          id: client.sessionId,
          resumed,
          capabilities: {
            loadSession: client.supportsLoadSession(),
            close: Boolean(client.agentCapabilities?.sessionCapabilities?.close),
          },
          openedAt: new Date().toISOString(),
        },
        resumed,
      }
    }

    function trackSession(taskKey, entry) {
      sessions.set(taskKey, {
        client: entry.client,
        sessionId: entry.client.sessionId,
        openedAt: entry.session?.openedAt ?? new Date().toISOString(),
        resumed: Boolean(entry.session?.resumed),
        busy: Boolean(entry.busy),
        lastUsedAt: Date.now(),
      })
      reapSessions()
    }

    function reapSessions() {
      const now = Date.now()
      const idle = [...sessions.entries()]
        .filter(([, entry]) => !entry.busy && now - entry.lastUsedAt > config.sessionIdleMs)
        .map(([taskKey]) => taskKey)
      for (const taskKey of idle) closeSession(taskKey, 'idle')
      if (sessions.size <= config.maxSessions) return
      const candidates = [...sessions.entries()]
        .filter(([, entry]) => !entry.busy)
        .sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt)
      while (sessions.size > config.maxSessions && candidates.length) {
        closeSession(candidates.shift()[0], 'lru')
      }
    }

    function closeSession(taskKey, reason) {
      const entry = sessions.get(taskKey)
      if (!entry) return false
      sessions.delete(taskKey)
      entry.client?.close().catch(() => {})
      ctx.log.info('关闭 ACP 会话', { taskKey, sessionId: entry.sessionId, reason })
      return true
    }

    function poolEntry(task) {
      const entry = sessions.get(task.taskKey)
      if (!entry || entry.busy || entry.client.closed) return null
      entry.lastUsedAt = Date.now()
      return entry
    }

    async function execute(task) {
      const cwd = config.cwd || task.projectPath || process.cwd()
      const started = await ctx.runs.start({
        taskKey: task.taskKey,
        request: { agent: config.agent, command: config.command, cwd },
      })
      if (!started.started) {
        ctx.log.info('任务已有活动 run，跳过', { taskKey: task.taskKey, runId: started.runId })
        return
      }
      const runId = started.runId
      const record = {
        runId,
        taskKey: task.taskKey,
        agent: config.agent,
        command: config.command,
        cwd,
        status: 'running',
        stopReason: null,
        error: null,
        session: null,
        decisions: [],
        updates: 0,
        chunkUpdates: 0,
        toolCalls: 0,
        summary: null,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        durationMs: null,
      }
      active.set(task.taskKey, { runId, client: null, record, lastProgressAt: 0 })
      publish('session.started', {
        taskKey: task.taskKey,
        runId,
        agent: config.agent,
        cwd,
        startedAt: record.startedAt,
      })
      ctx.log.info('开始派发', { taskKey: task.taskKey, runId, cwd })

      let client = null
      try {
        const pooled = poolEntry(task)
        client = pooled?.client ?? null
        if (client) {
          record.session = {
            id: client.sessionId,
            resumed: true,
            capabilities: {
              loadSession: client.supportsLoadSession(),
              close: Boolean(client.agentCapabilities?.sessionCapabilities?.close),
            },
            openedAt: pooled.openedAt,
          }
          pooled.busy = true
        } else {
          client = newClient(task, {
            onUpdate: () => {
              record.updates += 1
            },
          })
          active.get(task.taskKey).client = client
          const opened = await openSession(task, { client, allowResume: true })
          record.session = opened.session
          trackSession(task.taskKey, { client, session: opened.session, busy: true })
        }
        record.sessionId = client.sessionId
        await ctx.runs
          .progress(runId, {
            result: buildResult(record, { status: 'running' }),
          })
          .catch(() => {})
        publish('session.ready', {
          taskKey: task.taskKey,
          runId,
          session: record.session,
        })

        const attempt = Number(String(runId).split(':').pop()) || 1
        const promptText =
          record.session?.resumed && attempt > 1
            ? renderPrompt(promptTemplate, task)
            : `${renderPrompt(promptTemplate, task)}${
                attempt > 1 ? `\n\n（这是第 ${attempt} 次尝试，上一次运行未正常结束。）` : ''
              }`
        const result = await client.prompt(promptText)
        record.stopReason = result?.stopReason ?? null
        if (client.timeoutReason === 'idle') {
          record.status = 'timeout'
          record.error = `idle 超时（${config.idleTimeoutMs}ms 无 session/update）`
        } else if (client.timeoutReason === 'run') {
          record.status = 'timeout'
          record.error = `运行超时（${config.runTimeoutMs}ms）`
        } else if (result?.stopReason === 'cancelled') {
          record.status = 'cancelled'
        } else {
          record.status = 'succeeded'
        }
      } catch (failure) {
        record.error = failure.message
        if (client?.timeoutReason === 'idle' || client?.timeoutReason === 'run') {
          record.status = 'timeout'
          record.error =
            client.timeoutReason === 'idle'
              ? `idle 超时（${config.idleTimeoutMs}ms 无 session/update）`
              : `运行超时（${config.runTimeoutMs}ms）`
          client.cancel()
        } else if (client?.closed) {
          record.status = 'failed'
        } else {
          record.status = 'failed'
        }
      } finally {
        if (client) {
          record.decisions = client.decisions
          record.chunkUpdates = client.chunkUpdates
          record.toolCalls = client.toolCalls
          record.updates = Math.max(record.updates, client.chunkUpdates)
          record.summary = client.assistantText ? client.assistantText.slice(-4000) : null
          const pooled = sessions.get(task.taskKey)
          if (pooled) {
            pooled.busy = false
            pooled.lastUsedAt = Date.now()
          } else if (!client.closed) {
            trackSession(task.taskKey, {
              client,
              session: record.session,
              busy: false,
            })
          }
        }
      }

      record.finishedAt = new Date().toISOString()
      record.durationMs = Date.parse(record.finishedAt) - Date.parse(record.startedAt)
      active.delete(task.taskKey)
      publish('session.finished', {
        taskKey: task.taskKey,
        runId,
        session: record.session,
        outcome: { status: record.status, stopReason: record.stopReason, error: record.error },
        durationMs: record.durationMs,
      })
      await ctx.runs
        .finish(runId, { status: record.status, result: buildResult(record) })
        .catch((failure) => ctx.log.warn('回写 run 失败', { runId, message: failure.message }))
      ctx.log.info('派发结束', {
        taskKey: task.taskKey,
        runId,
        status: record.status,
        stopReason: record.stopReason,
      })
    }

    async function promptTask(task, text, { requestedBy = null } = {}) {
      const entry = active.get(task.taskKey)
      if (entry) {
        const error = new Error('该任务已有运行中的会话')
        error.status = 409
        throw error
      }
      const pooled = poolEntry(task)
      const started = await ctx.runs.start({
        taskKey: task.taskKey,
        request: {
          agent: config.agent,
          command: config.command,
          cwd: pooled?.client.cwd ?? config.cwd,
          source: 'panel',
          requestedBy,
        },
      })
      if (!started.started) {
        const error = new Error('该任务已有活动运行')
        error.status = 409
        throw error
      }
      const runId = started.runId
      const cwd = pooled?.client.cwd ?? config.cwd
      const record = {
        runId,
        taskKey: task.taskKey,
        agent: config.agent,
        command: config.command,
        cwd,
        status: 'running',
        stopReason: null,
        error: null,
        session: null,
        decisions: [],
        updates: 0,
        chunkUpdates: 0,
        toolCalls: 0,
        summary: null,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        durationMs: null,
      }
      let client = pooled?.client ?? null
      active.set(task.taskKey, { runId, client, record, lastProgressAt: 0 })
      publish('session.started', {
        taskKey: task.taskKey,
        runId,
        agent: config.agent,
        cwd,
        startedAt: record.startedAt,
      })
      try {
        if (client) {
          record.session = {
            id: client.sessionId,
            resumed: true,
            capabilities: {
              loadSession: client.supportsLoadSession(),
              close: Boolean(client.agentCapabilities?.sessionCapabilities?.close),
            },
            openedAt: pooled.openedAt,
          }
          pooled.busy = true
        } else {
          client = newClient(task, {
            onUpdate: () => {
              record.updates += 1
            },
          })
          active.get(task.taskKey).client = client
          const opened = await openSession(task, { client, allowResume: true })
          record.session = opened.session
          trackSession(task.taskKey, { client, session: opened.session, busy: true })
        }
        publish('session.ready', { taskKey: task.taskKey, runId, session: record.session })
        const result = await client.prompt(text)
        record.stopReason = result?.stopReason ?? null
        if (client.timeoutReason === 'idle' || client.timeoutReason === 'run') {
          record.status = 'timeout'
          record.error =
            client.timeoutReason === 'idle'
              ? `idle 超时（${config.idleTimeoutMs}ms 无 session/update）`
              : `运行超时（${config.runTimeoutMs}ms）`
        } else if (result?.stopReason === 'cancelled') {
          record.status = 'cancelled'
        } else {
          record.status = 'succeeded'
        }
      } catch (failure) {
        record.status = 'failed'
        record.error = failure.message
        if (client?.timeoutReason === 'idle' || client?.timeoutReason === 'run') {
          record.status = 'timeout'
          record.error =
            client.timeoutReason === 'idle'
              ? `idle 超时（${config.idleTimeoutMs}ms 无 session/update）`
              : `运行超时（${config.runTimeoutMs}ms）`
        }
      } finally {
        record.decisions = client?.decisions ?? []
        record.chunkUpdates = client?.chunkUpdates ?? 0
        record.toolCalls = client?.toolCalls ?? 0
        record.updates = record.chunkUpdates
        record.summary = client?.assistantText ? client.assistantText.slice(-4000) : null
        record.finishedAt = new Date().toISOString()
        record.durationMs = Date.parse(record.finishedAt) - Date.parse(record.startedAt)
        const pooledEntry = sessions.get(task.taskKey)
        if (pooledEntry) {
          pooledEntry.busy = false
          pooledEntry.lastUsedAt = Date.now()
        }
        active.delete(task.taskKey)
      }
      publish('session.finished', {
        taskKey: task.taskKey,
        runId,
        session: record.session,
        outcome: { status: record.status, stopReason: record.stopReason, error: record.error },
        durationMs: record.durationMs,
      })
      const result = buildResult(record)
      await ctx.runs.finish(runId, { status: record.status, result }).catch(() => {})
      return result
    }

    function scheduleDiscovery() {
      if (discoveryTimer || stopped) return
      discoveryTimer = setTimeout(() => {
        discoveryTimer = null
        discover().catch((error) => ctx.log.error('扫描任务失败', { message: error.message }))
      }, 50)
    }

    ctx.events.on('scan.completed', scheduleDiscovery)
    ctx.events.on('task.assigned', scheduleDiscovery)
    ctx.events.on('task.created', scheduleDiscovery)

    function panelAsset(routePath) {
      const asset = PANEL_ASSETS.get(routePath)
      if (!asset) return null
      return {
        status: 200,
        headers: { 'content-type': asset[1], 'cache-control': 'no-store' },
        body: fs.readFileSync(path.join(PANEL_DIR, asset[0]), 'utf8'),
      }
    }

    async function panelData() {
      const tasks = await ctx.tasks
        .list({ repositoryId: config.repositoryId ?? undefined })
        .catch(() => [])
      const titles = new Map(tasks.map((task) => [task.taskKey, task.title]))
      const runs = await ctx.runs.list({ limit: 50 })
      const sessionsList = [...sessions.entries()].map(([taskKey, entry]) => ({
        taskKey,
        title: titles.get(taskKey) ?? null,
        sessionId: entry.sessionId,
        busy: entry.busy,
        openedAt: entry.openedAt,
        resumed: entry.resumed,
        lastUsedAt: new Date(entry.lastUsedAt).toISOString(),
      }))
      return {
        agent: config.agent,
        command: config.command,
        configured: Boolean(config.command),
        active: [...active.values()].map((item) => ({
          runId: item.runId,
          taskKey: item.record.taskKey,
          sessionId: item.record.session?.id ?? null,
        })),
        sessions: sessionsList,
        runs: runs.map((run) => ({
          runId: run.runId,
          taskKey: run.taskKey,
          status: run.status,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
          result: run.result ?? null,
        })),
      }
    }

    ctx.http.route(
      'GET',
      '/panel',
      async () => panelAsset('/panel') ?? { status: 404, body: { error: '面板资源缺失' } },
    )
    ctx.http.route(
      'GET',
      '/panel/app.js',
      async () => panelAsset('/panel/app.js') ?? { status: 404, body: '' },
    )
    ctx.http.route(
      'GET',
      '/panel/app.css',
      async () => panelAsset('/panel/app.css') ?? { status: 404, body: '' },
    )
    ctx.http.route('GET', '/panel/data', async () => ({ status: 200, body: await panelData() }))

    ctx.http.route('POST', '/panel/prompt', async (request) => {
      const body = request.json()
      const parsed = splitTaskKey(body.taskKey)
      if (!parsed)
        return { status: 400, body: { error: 'taskKey 必须包含 .trellis/tasks 下的任务目录' } }
      const text = String(body.text ?? '').trim()
      if (!text) return { status: 400, body: { error: 'prompt 不能为空' } }
      if (text.length > 8000) return { status: 400, body: { error: 'prompt 超过 8000 字符' } }
      const task = await ctx.tasks.get({
        repositoryId: parsed.projectId,
        relativeDir: parsed.relativeDir,
      })
      try {
        const result = await promptTask(task, text, { requestedBy: body.requestedBy ?? null })
        return { status: 200, body: { result } }
      } catch (error) {
        return { status: error.status ?? 500, body: { error: error.message } }
      }
    })

    ctx.http.route('POST', '/panel/cancel', async (request) => {
      const taskKey = request.json()?.taskKey
      const entry = taskKey ? active.get(taskKey) : [...active.values()][0]
      if (!entry) return { status: 404, body: { error: '没有运行中的任务' } }
      entry.client?.cancel()
      return { status: 200, body: { cancelled: entry.runId } }
    })

    ctx.http.route('GET', '/status', async () => ({
      status: 200,
      body: {
        agent: config.agent,
        command: config.command,
        configured: Boolean(config.command),
        maxConcurrent: config.maxConcurrent,
        runTimeoutMs: config.runTimeoutMs,
        idleTimeoutMs: config.idleTimeoutMs,
        active: [...active.values()].map((item) => ({
          runId: item.runId,
          taskKey: item.record.taskKey,
        })),
        queued: queue.map((task) => task.taskKey),
        sessions: [...sessions.keys()],
        dispatchUnbound: config.dispatchUnbound !== false,
        lastDiscovery,
        permission: config.permission,
      },
    }))

    ctx.http.route('GET', '/executions', async (request) => {
      const limit = Math.min(100, Number(request.query.limit) || 20)
      const runs = await ctx.runs.list({ limit })
      return { status: 200, body: { runs } }
    })

    async function manualDispatch(request) {
      const body = request.json()
      if (body.taskKey) {
        const parsed = splitTaskKey(body.taskKey)
        if (!parsed) {
          return { status: 400, body: { error: 'taskKey 必须包含 .trellis/tasks 下的任务目录' } }
        }
        const task = await ctx.tasks.get({
          repositoryId: parsed.projectId,
          relativeDir: parsed.relativeDir,
        })
        if (task.status !== 'in_progress') {
          return { status: 409, body: { error: `任务状态为 ${task.status}，只派发 in_progress` } }
        }
        if (!(await shouldDispatch(task))) {
          return { status: 409, body: { error: '该任务已有运行记录', taskKey: task.taskKey } }
        }
        return { status: 202, body: { queued: enqueue(task), taskKey: task.taskKey } }
      }
      const result = await discover()
      return { status: 202, body: result }
    }

    ctx.http.route('POST', '/runs', manualDispatch)
    ctx.http.route('POST', '/dispatch', manualDispatch)

    ctx.http.route('POST', '/cancel', async (request) => {
      const taskKey = request.json()?.taskKey
      const entry = taskKey ? active.get(taskKey) : [...active.values()][0]
      if (!entry) return { status: 404, body: { error: '没有运行中的任务' } }
      entry.client?.cancel()
      ctx.log.info('收到取消请求', { taskKey: entry.record.taskKey, runId: entry.runId })
      return { status: 200, body: { cancelled: entry.runId } }
    })

    reaperTimer = setInterval(reapSessions, 60_000)
    reaperTimer.unref?.()

    ctx.log.info('acp-dispatch 已启动', {
      agent: config.agent,
      command: config.command,
      maxConcurrent: config.maxConcurrent,
      runTimeoutMs: config.runTimeoutMs,
    })

    ctx.effect(() => {
      stopped = true
      if (discoveryTimer) clearTimeout(discoveryTimer)
      if (reaperTimer) clearInterval(reaperTimer)
      for (const entry of active.values()) entry.client?.cancel()
      for (const taskKey of [...sessions.keys()]) closeSession(taskKey, 'shutdown')
    })
  },
})
