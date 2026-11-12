import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createPlugin } from '../../server/plugins/sdk.js'

const PLUGIN_ID = 'scenario-copilot'
const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url))
const PANEL_DIR = path.join(PLUGIN_DIR, 'panel')
const LOG_LIMIT = 240_000

const DEFAULTS = {
  scenarioRoot: '',
  workspaceDir: '',
  outputRoot: '',
  outlinesDir: '',
  knowledgePath: '',
  targetUrl: '',
  storageState: '',
  orgName: '',
  username: '',
  password: '',
  llmApiKey: '',
  llmBaseUrl: '',
  llmModel: '',
  maxTokens: 32768,
  effort: '',
  effortField: 'reasoning_effort',
  reconSnapshots: [],
  defaultOutline: '',
  timeoutMs: 15 * 60_000,
  maxRuns: 20,
  maxHealingRetries: 1,
}

const ASSETS = new Map([
  ['/panel', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/app.css', ['app.css', 'text/css; charset=utf-8']],
])

function normalizeConfig(raw = {}) {
  return {
    ...DEFAULTS,
    ...raw,
    timeoutMs: Number.isFinite(Number(raw.timeoutMs))
      ? Math.max(60_000, Number(raw.timeoutMs))
      : DEFAULTS.timeoutMs,
    maxRuns: Number.isFinite(Number(raw.maxRuns))
      ? Math.max(1, Math.min(100, Number(raw.maxRuns)))
      : DEFAULTS.maxRuns,
  }
}

function text(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback
}

function parseList(value) {
  if (Array.isArray(value)) return value.map((item) => text(item)).filter(Boolean)
  return text(value)
    .split(/[\s,，;；]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function slugify(value) {
  return (
    String(value || 'scenario')
      .replace(/[^\w\u4e00-\u9fa5.-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'scenario'
  )
}

function testVersionStamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
}

function taskNumbers(task, taskKey) {
  const meta = task.meta && typeof task.meta === 'object' ? task.meta : {}
  const witops =
    text(meta.witops_task_id) ||
    text(meta.platform_task_id) ||
    text(meta.requirement_id) ||
    'WIT-NA'
  const base = path.basename(task.relativeDir || '') || text(task.id) || 'trellis-NA'
  const uid = createHash('sha1').update(taskKey).digest('hex').slice(0, 6)
  return { witops, trellis: `${base}-${uid}` }
}

function requirementNumbers(subject) {
  const code = text(subject.requirementCode) || text(subject.requirementId) || 'REQ-NA'
  return { witops: code, trellis: '' }
}

function listOutlines(config) {
  const dir = text(config.outlinesDir) ? path.resolve(config.outlinesDir) : ''
  if (!dir || !fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(md|txt)$/i.test(entry.name))
    .map((entry) => ({
      name: entry.name,
      title: entry.name.replace(/\.(md|txt)$/i, ''),
      size: fs.statSync(path.join(dir, entry.name)).size,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh'))
}

function tail(textValue, limit = LOG_LIMIT) {
  const value = String(textValue ?? '')
  return value.length > limit ? `…${value.slice(-limit)}` : value
}

function summaryOf(run) {
  return {
    id: run.id,
    groupId: run.groupId || '',
    regressionName: run.regressionName || '',
    status: run.status,
    subject: run.subject,
    subjectKey: run.subjectKey || '',
    requirementId: run.requirementId || '',
    requirementCode: run.requirementCode || '',
    taskKey: run.taskKey || '',
    taskTitle: run.taskTitle,
    outline: run.outline,
    testVersion: run.testVersion,
    stateKey: run.stateKey,
    stage: run.stage,
    targetUrl: run.targetUrl,
    noRun: run.noRun,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    durationMs: run.durationMs,
    exitCode: run.exitCode,
    scriptPath: run.scriptPath,
    error: run.error,
  }
}

export default createPlugin({
  name: PLUGIN_ID,
  version: '0.2.0',
  apiVersion: 1,
  permissions: [
    'capabilities:provide',
    'tasks:read',
    'store',
    'events:emit',
    'events:publish',
    'http:route',
    'panels',
  ],

  async onStart(ctx) {
    const config = normalizeConfig(ctx.config)
    const runs = new Map()
    const groups = new Map()
    const children = new Map()
    const maxRuns = config.maxRuns

    const storedRuns = await ctx.store.get('runs').catch(() => null)
    if (Array.isArray(storedRuns)) {
      for (const item of storedRuns) {
        if (item?.id) runs.set(item.id, { ...item, logs: '' })
      }
    }
    const storedGroups = await ctx.store.get('regressions').catch(() => null)
    if (Array.isArray(storedGroups)) {
      for (const item of storedGroups) {
        if (item?.id) groups.set(item.id, { ...item })
      }
    }

    function workspaceDir() {
      return config.workspaceDir || path.join(PLUGIN_DIR, 'workspace')
    }

    // Generated specs and run state are machine-local: they must not be written into
    // the analysed repository, which belongs to somebody else.
    function outputRoot() {
      const raw = String(config.outputRoot || process.env.MOM_SCENARIO_OUTPUT || '').trim()
      if (!raw) return path.join(os.homedir(), '.scenario')
      if (raw === '~') return os.homedir()
      if (raw.startsWith('~/')) return path.join(os.homedir(), raw.slice(2))
      return path.resolve(raw)
    }

    function persist() {
      const latest = [...runs.values()]
        .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
        .slice(0, maxRuns)
        .map(summaryOf)
      ctx.store.set('runs', latest).catch(() => {})
      const latestGroups = [...groups.values()]
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .slice(0, maxRuns)
        .map((group) => ({
          ...group,
          runs: [...(group.runIds || [])],
        }))
      ctx.store.set('regressions', latestGroups).catch(() => {})
    }

    function prune() {
      const finished = [...runs.values()]
        .filter((run) => !['queued', 'running'].includes(run.status))
        .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)))
      while (runs.size > maxRuns && finished.length) {
        const oldest = finished.shift()
        runs.delete(oldest.id)
        children.delete(oldest.id)
      }
    }

    function groupSummary(group) {
      const childRuns = (group.runIds || [])
        .map((id) => runs.get(id))
        .filter(Boolean)
        .map(summaryOf)
      return {
        id: group.id,
        name: group.name,
        status: group.status,
        total: group.subjects?.length || 0,
        done: (group.runIds?.length || 0) + (group.errors?.length || 0),
        runIds: [...(group.runIds || [])],
        errors: [...(group.errors || [])],
        runs: childRuns,
        createdAt: group.createdAt,
        startedAt: group.startedAt || null,
        finishedAt: group.finishedAt || null,
      }
    }

    function appendLog(run, chunk) {
      run.logs = tail(run.logs + String(chunk ?? ''))
    }

    function finish(run, status, exitCode, error) {
      if (run.status !== 'running') return
      run.status = status
      run.exitCode = exitCode
      run.finishedAt = new Date().toISOString()
      run.durationMs = Date.now() - new Date(run.startedAt).getTime()
      run.error = error || run.error || null
      children.delete(run.id)
      persist()
      ctx.events.publish('scenario-copilot/run.finished', summaryOf(run)).catch(() => {})
      if (run.groupId) void advanceGroup(run.groupId).catch(() => {})
    }

    function resolveRoot() {
      const configured = text(config.scenarioRoot)
      if (!configured) throw ctx.error(2001, '未配置 scenarioRoot（scenario-copilot 包目录）')
      const candidates = [
        path.resolve(configured),
        path.resolve(configured, 'packages', 'scenario-copilot'),
      ]
      const root = candidates.find((candidate) =>
        fs.existsSync(path.join(candidate, 'dist', 'bin', 'scenario-copilot.js')),
      )
      if (!root) throw ctx.error(2001, `scenario-copilot 不存在: ${configured}`)
      return root
    }

    function bindingStorageKey(subject) {
      return subject.kind === 'trellis' ? subject.taskKey : subject.key
    }

    async function bindingOf(subject) {
      const value = await ctx.store.get(`binding:${bindingStorageKey(subject)}`).catch(() => null)
      if (value && typeof value === 'object') return value
      if (subject.kind === 'trellis') {
        const legacy = await ctx.store.get(`binding:${subject.key}`).catch(() => null)
        if (legacy && typeof legacy === 'object') return legacy
      }
      return {}
    }

    async function listBindings() {
      const entries = await ctx.store.list('binding:').catch(() => [])
      const map = new Map()
      for (const entry of entries) {
        const key = String(entry?.key ?? '')
        if (key.startsWith('binding:') && entry.value && typeof entry.value === 'object') {
          map.set(key.slice('binding:'.length), entry.value)
        }
      }
      return map
    }

    function taskTarget(task) {
      return (
        text(task?.meta?.testUrl) ||
        text(task?.meta?.scenarioCopilot?.targetUrl) ||
        text(task?.meta?.scenario?.targetUrl)
      )
    }

    function outlineForTask(task) {
      if (!task) return ''
      const slug = path.basename(task.relativeDir || '')
      return (
        listOutlines(config).find((outline) => {
          const stem = outline.name.replace(/\.(md|txt)$/i, '')
          return slug.includes(stem) || stem.includes(slug)
        })?.name ?? ''
      )
    }

    async function resolveSubject(input = {}) {
      const raw = input?.subject && typeof input.subject === 'object' ? input.subject : input
      const explicitTaskKey = text(raw?.taskKey)
      const explicitRequirementId = text(raw?.requirementId || raw?.id)
      const kind = text(raw?.kind)

      if (kind === 'requirement' || (!explicitTaskKey && explicitRequirementId)) {
        const requirementId = explicitRequirementId || text(raw?.code)
        if (!requirementId) throw ctx.error(2005, '需求测试必须指定 requirementId')
        return {
          kind: 'requirement',
          key: `requirement:${requirementId}`,
          requirementId,
          requirementCode: text(raw?.requirementCode || raw?.code),
          taskKey: '',
          title: text(raw?.title) || `需求 ${requirementId}`,
        }
      }

      const taskKey = explicitTaskKey
      if (!taskKey) throw ctx.error(2005, '下发测试必须指定 Trellis 任务或需求')
      const task = await ctx.tasks.get({ taskKey })
      return {
        kind: 'trellis',
        key: `trellis:${taskKey}`,
        taskKey,
        requirementId: text(task.meta?.requirement_id),
        requirementCode: text(task.meta?.requirement_code || task.meta?.code),
        title: task.title,
        task,
      }
    }

    async function startRun(input = {}) {
      const subject = await resolveSubject(input)
      const task = subject.task
      const binding = await bindingOf(subject)
      const outlineName =
        text(input.outline) ||
        text(binding.outline) ||
        outlineForTask(task) ||
        text(config.defaultOutline) ||
        listOutlines(config)[0]?.name ||
        ''
      const outlineDir = text(config.outlinesDir) ? path.resolve(config.outlinesDir) : ''
      if (!outlineDir) throw ctx.error(2002, '未配置 outlinesDir（测试大纲目录）')
      const outlinePath = path.join(outlineDir, path.basename(outlineName))
      if (!outlineName || !fs.existsSync(outlinePath)) {
        throw ctx.error(2002, `测试大纲不存在: ${outlineName || '(未指定)'}`, { outlineDir })
      }
      const targetUrl =
        text(input.targetUrl) ||
        text(binding.targetUrl) ||
        taskTarget(task) ||
        text(config.targetUrl)
      if (!/^https?:\/\//i.test(targetUrl)) {
        const label =
          subject.kind === 'trellis' ? `任务 ${subject.taskKey}` : `需求 ${subject.title}`
        throw ctx.error(2003, `${label} 未配置测试地址`, { subjectKey: subject.key })
      }
      const username = text(input.username) || config.username
      const password = text(input.password) || config.password
      const noRun = input.noRun === true || (input.noRun !== false && !username && !password && !config.storageState)
      const scenarioRoot = resolveRoot()
      const momRoot = path.resolve(scenarioRoot, '../..')
      const workspace = workspaceDir()
      const modulesLink = path.join(workspace, 'node_modules')
      if (!fs.existsSync(modulesLink)) {
        fs.mkdirSync(workspace, { recursive: true })
        fs.symlinkSync(path.join(momRoot, 'node_modules'), modulesLink, 'dir')
      }
      const cliPath = path.join(scenarioRoot, 'dist', 'bin', 'scenario-copilot.js')
      const specDir = path.join(outputRoot(), 'scripts')
      fs.mkdirSync(specDir, { recursive: true })
      const numbers =
        subject.kind === 'trellis'
          ? taskNumbers(task, subject.taskKey)
          : requirementNumbers(subject)
      const generation = Number(binding.testGeneration || 0) + 1
      const version = `v${generation}`
      const nameParts = [numbers.witops, numbers.trellis].filter(Boolean)
      const testVersion = `${slugify(nameParts.join('-')).slice(0, 80)}-${testVersionStamp()}-${version}`
      const stateKey = `${subject.key}::${outlineName}`
      const stage = ['recon', 'generate', 'verify', 'execute'].includes(text(input.stage))
        ? text(input.stage)
        : 'execute'
      const scriptPath = path.join(specDir, `${slugify(testVersion)}.spec.ts`)
      const knowledgePath = text(config.knowledgePath)
      const args = [
        cliPath,
        'pipeline',
        '--outline',
        outlinePath,
        '--api-url',
        targetUrl,
        '--workspace',
        workspace,
        '--output-root',
        outputRoot(),
        '--spec-dir',
        specDir,
        '--output',
        scriptPath,
        '--test-version',
        testVersion,
        '--state-key',
        stateKey,
        '--stop-after',
        stage,
      ]
      if (knowledgePath && fs.existsSync(knowledgePath)) args.push('--knowledge', knowledgePath)
      args.push('--max-healing', String(Number(config.maxHealingRetries ?? 1)))
      if (input.resume === true) args.push('--resume')
      if (input.regenerate === true) args.push('--regenerate')
      if (input.onlyFailed === true) args.push('--only-failed')
      if (text(input.grep)) args.push('--grep', text(input.grep))
      if (noRun && stage === 'execute') args.push('--no-run')
      if (Array.isArray(input.reconActions)) {
        for (const action of input.reconActions) {
          if (text(action)) args.push('--recon-click', text(action))
        }
      }
      const reconSnapshots = Array.isArray(input.reconSnapshots)
        ? input.reconSnapshots
        : Array.isArray(config.reconSnapshots) ? config.reconSnapshots : []
      if (reconSnapshots.length) args.push('--recon-snapshots', JSON.stringify(reconSnapshots))
      const env = {
        ...process.env,
        MOM_TARGET_URL: targetUrl,
        MOM_USERNAME: username,
        MOM_PASSWORD: password,
        MOM_ORG_NAME: text(input.orgName) || config.orgName,
        NODE_PATH: [path.join(momRoot, 'node_modules'), process.env.NODE_PATH]
          .filter(Boolean)
          .join(path.delimiter),
        MOM_TEST_TIMEOUT: String(Math.min(config.timeoutMs, 120_000)),
      }
      if (config.storageState) env.MOM_STORAGE_STATE = config.storageState
      if (config.llmApiKey) env.MOM_LLM_API_KEY = config.llmApiKey
      if (config.llmBaseUrl) env.MOM_LLM_BASE_URL = config.llmBaseUrl
      if (config.llmModel) env.MOM_LLM_MODEL = config.llmModel
      if (config.maxTokens) env.MOM_LLM_MAX_TOKENS = String(config.maxTokens)
      if (config.effort) env.MOM_LLM_EFFORT = config.effort
      if (config.effortField) env.MOM_LLM_EFFORT_FIELD = config.effortField
      const id = `sc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
      const run = {
        id,
        groupId: text(input.groupId),
        regressionName: text(input.regressionName),
        status: 'running',
        subject,
        subjectKey: subject.key,
        requirementId: subject.requirementId || '',
        requirementCode: subject.requirementCode || '',
        taskKey: subject.taskKey || '',
        taskTitle: subject.title,
        outline: outlineName,
        witopsTaskNo: numbers.witops,
        trellisTaskNo: numbers.trellis,
        testVersion,
        testGeneration: generation,
        stateKey,
        stage,
        targetUrl,
        noRun,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        durationMs: null,
        exitCode: null,
        scriptPath,
        error: null,
        logs: '',
      }
      runs.set(id, run)
      prune()
      appendLog(run, `$ node ${cliPath} ${args.slice(1).join(' ')}\n`)
      const child = spawn(process.execPath, args, {
        cwd: momRoot,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      children.set(id, child)
      const timer = setTimeout(() => {
        appendLog(run, `\n[scenario-copilot] 超时 ${config.timeoutMs}ms，终止进程\n`)
        child.kill('SIGTERM')
      }, config.timeoutMs)
      timer.unref?.()
      child.stdout.on('data', (chunk) => appendLog(run, chunk))
      child.stderr.on('data', (chunk) => appendLog(run, chunk))
      child.on('error', (error) => {
        clearTimeout(timer)
        appendLog(run, `\n[scenario-copilot] 启动失败: ${error.message}\n`)
        finish(run, 'failed', null, error.message)
      })
      child.on('close', (code, signal) => {
        clearTimeout(timer)
        if (run.status !== 'running') return
        const status = code === 0 ? 'succeeded' : 'failed'
        const error = code === 0 ? null : `scenario-copilot 退出码 ${code ?? signal}`
        finish(run, status, code, error)
      })
      persist()
      await ctx.store
        .set(`binding:${bindingStorageKey(subject)}`, {
          targetUrl,
          outline: outlineName,
          testGeneration: generation,
          testVersion,
          scriptPath,
          updatedAt: new Date().toISOString(),
        })
        .catch(() => {})
      ctx.events.publish('scenario-copilot/run.started', summaryOf(run)).catch(() => {})
      return run
    }

    function listRuns(params = {}) {
      const requirementIds = new Set(parseList(params.requirementIds || params.requirementId))
      const taskKeys = new Set(parseList(params.taskKeys || params.taskKey))
      const subjectKeys = new Set(parseList(params.subjectKeys || params.subjectKey))
      const statuses = new Set(parseList(params.status || params.statuses))
      const limit = Math.max(1, Math.min(200, Number(params.limit) || 50))
      return [...runs.values()]
        .filter((run) => {
          if (requirementIds.size && !requirementIds.has(run.requirementId)) return false
          if (taskKeys.size && !taskKeys.has(run.taskKey)) return false
          if (subjectKeys.size && !subjectKeys.has(run.subjectKey)) return false
          if (statuses.size && !statuses.has(run.status)) return false
          if (params.groupId && run.groupId !== params.groupId) return false
          return true
        })
        .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
        .slice(0, limit)
        .map(summaryOf)
    }

    function defaultsResult() {
      return {
        orgName: config.orgName,
        hasCredentials: Boolean(config.username && config.password),
        defaultOutline: config.defaultOutline,
        targetUrl: config.targetUrl,
        workspace: workspaceDir(),
        outputRoot: outputRoot(),
        outlines: listOutlines(config),
      }
    }

    async function bindingsResult(params = {}) {
      const keys = parseList(params.subjectKeys || params.keys || params)
      const bindings = {}
      for (const key of keys) {
        const storageKey = key.startsWith('trellis:') ? key.slice('trellis:'.length) : key
        const value = await ctx.store.get(`binding:${storageKey}`).catch(() => null)
        if (value && typeof value === 'object') bindings[key] = value
      }
      return { bindings }
    }

    async function advanceGroup(groupId) {
      const group = groups.get(groupId)
      if (!group || group.finishedAt) return
      if (group.cancelRequested) {
        finishGroup(group, 'cancelled')
        return
      }
      while (group.index < group.subjects.length) {
        if (group.cancelRequested) {
          finishGroup(group, 'cancelled')
          return
        }
        const item = group.subjects[group.index++]
        group.status = 'running'
        group.startedAt = group.startedAt || new Date().toISOString()
        try {
          const run = await startRun({
            ...item,
            groupId: group.id,
            regressionName: group.name,
            outline: text(item.outline) || group.outline,
            targetUrl: text(item.targetUrl) || undefined,
            noRun: group.noRun,
          })
          group.runIds.push(run.id)
          group.currentRunId = run.id
          persist()
          return
        } catch (error) {
          group.errors.push({ subject: item, error: error.message })
          persist()
        }
      }
      const childrenRuns = group.runIds.map((id) => runs.get(id)).filter(Boolean)
      const failed = group.errors.length > 0 || childrenRuns.some((run) => run.status === 'failed')
      const succeeded = childrenRuns.some((run) => run.status === 'succeeded')
      let finalStatus = 'succeeded'
      if (failed) finalStatus = succeeded ? 'partial' : 'failed'
      finishGroup(group, finalStatus)
    }

    function finishGroup(group, status) {
      group.status = status
      group.finishedAt = new Date().toISOString()
      group.currentRunId = null
      persist()
      ctx.events
        .publish('scenario-copilot/regression.finished', groupSummary(group))
        .catch(() => {})
    }

    async function startRegression(input = {}) {
      const subjects = Array.isArray(input.subjects)
        ? input.subjects.filter((item) => item && typeof item === 'object')
        : []
      if (!subjects.length) throw ctx.error(2006, '回归任务至少需要一个测试对象')
      const group = {
        id: `rg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: text(input.name) || `回归 ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
        status: 'queued',
        subjects,
        index: 0,
        runIds: [],
        errors: [],
        currentRunId: null,
        outline: text(input.outline),
        noRun: input.noRun,
        createdAt: new Date().toISOString(),
        startedAt: null,
        finishedAt: null,
      }
      groups.set(group.id, group)
      persist()
      ctx.events.publish('scenario-copilot/regression.started', groupSummary(group)).catch(() => {})
      await advanceGroup(group.id)
      return groupSummary(group)
    }

    async function getRegression(id) {
      const group = groups.get(text(id))
      if (!group) throw ctx.error(2004, '回归任务不存在')
      return groupSummary(group)
    }

    async function cancelRegression(id) {
      const group = groups.get(text(id))
      if (!group) throw ctx.error(2004, '回归任务不存在')
      group.cancelRequested = true
      const child = group.currentRunId ? children.get(group.currentRunId) : null
      if (child) child.kill('SIGTERM')
      if (!child) finishGroup(group, 'cancelled')
      return groupSummary(group)
    }

    function cancelRun(id) {
      const key = text(id)
      const child = children.get(key)
      const run = runs.get(key)
      if (!run) throw ctx.error(2004, '运行记录不存在')
      if (!child) return { cancelled: false, status: run.status }
      child.kill('SIGTERM')
      appendLog(run, '\n[scenario-copilot] 已请求取消\n')
      return { cancelled: true, status: run.status }
    }

    ctx.http.route('GET', '/panel', async () => {
      const [file, type] = ASSETS.get('/panel')
      return {
        status: 200,
        headers: { 'content-type': type },
        body: fs.readFileSync(path.join(PANEL_DIR, file), 'utf8'),
      }
    })
    for (const [route, [file, type]] of ASSETS) {
      if (route === '/panel') continue
      ctx.http.route('GET', route, async () => ({
        status: 200,
        headers: { 'content-type': type },
        body: fs.readFileSync(path.join(PANEL_DIR, file), 'utf8'),
      }))
    }

    ctx.http.route('GET', '/defaults', async () => defaultsResult())

    ctx.http.route('GET', '/tasks', async () => {
      const tasks = await ctx.tasks.list({ includeArchived: true })
      const bindings = await listBindings()
      return {
        tasks: tasks.map((task) => ({
          taskKey: task.taskKey,
          projectId: task.projectId,
          projectName: task.projectName,
          relativeDir: task.relativeDir,
          title: task.title,
          status: task.status,
          archived: task.archived || task.relativeDir.startsWith('archive/'),
          binding: bindings.get(task.taskKey) ?? null,
        })),
      }
    })

    ctx.http.route('GET', '/history', async () => ({
      runs: listRuns({ limit: maxRuns }),
    }))

    ctx.http.route('POST', '/runs', async (request) => {
      const run = await startRun(request.json())
      return { status: 202, body: { run: summaryOf(run), noRun: run.noRun } }
    })

    ctx.http.route('GET', '/run', async (request) => {
      const run = runs.get(text(request.query.id))
      if (!run) throw ctx.error(2004, '运行记录不存在')
      return { run: { ...summaryOf(run), logs: run.logs } }
    })

    ctx.http.route('POST', '/cancel', async (request) => cancelRun(request.json().id))

    ctx.http.route('GET', '/regressions', async (request) => {
      if (request.query?.id) return { group: await getRegression(request.query.id) }
      return {
        groups: [...groups.values()]
          .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
          .map(groupSummary),
      }
    })

    ctx.http.route('POST', '/regressions', async (request) => {
      const group = await startRegression(request.json())
      return { status: 202, body: { group } }
    })

    ctx.http.route('POST', '/regressions/cancel', async (request) => ({
      group: await cancelRegression(request.json().id),
    }))

    ctx.capabilities.register('scenario.copilot', {
      'defaults.get': async () => defaultsResult(),
      'bindings.get': async (params) => bindingsResult(params),
      'runs.list': async (params) => ({ runs: listRuns(params) }),
      'runs.get': async (params) => {
        const run = runs.get(text(params?.id))
        if (!run) throw ctx.error(2004, '运行记录不存在')
        return { ...summaryOf(run), logs: run.logs }
      },
      'runs.start': async (params) => summaryOf(await startRun(params)),
      'runs.cancel': async (params) => cancelRun(params?.id),
      'regressions.start': async (params) => startRegression(params),
      'regressions.get': async (params) => getRegression(params?.id),
      'regressions.cancel': async (params) => cancelRegression(params?.id),
    })

    ctx.effect(() => {
      for (const child of children.values()) child.kill('SIGTERM')
      children.clear()
    })
  },
})
