import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createPlugin } from '@trellis-board/server/plugins/sdk.js'

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
  outlineTimeoutMs: 5 * 60_000,
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
    outlineTimeoutMs: Number.isFinite(Number(raw.outlineTimeoutMs))
      ? Math.max(30_000, Math.min(15 * 60_000, Number(raw.outlineTimeoutMs)))
      : DEFAULTS.outlineTimeoutMs,
  }
}

function text(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback
}

function parseList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => text(item == null ? '' : String(item))).filter(Boolean)
  }
  return text(value == null ? '' : String(value))
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

const OUTLINE_MANIFEST = 'outlines.manifest.json'

function outlineDirOf(config) {
  const configured = text(config.outlinesDir)
  return configured ? path.resolve(configured) : ''
}

function outlineManifestPath(config) {
  const directory = outlineDirOf(config)
  return directory ? path.join(directory, OUTLINE_MANIFEST) : ''
}

function emptyManifest() {
  return { version: 1, outlines: {} }
}

function readManifest(config) {
  const file = outlineManifestPath(config)
  if (!file || !fs.existsSync(file)) return emptyManifest()
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    const outlines =
      parsed && typeof parsed === 'object' && parsed.outlines && typeof parsed.outlines === 'object'
        ? parsed.outlines
        : {}
    return { version: 1, outlines: { ...outlines } }
  } catch {
    // Manifest 只是辅助索引：损坏时回退到纯文件列表，不能阻塞已有大纲运行。
    return emptyManifest()
  }
}

function writeManifest(config, manifest) {
  const file = outlineManifestPath(config)
  if (!file) return
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  const payload = { version: 1, outlines: manifest?.outlines || {} }
  fs.writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  fs.renameSync(temp, file)
}

function outlineStem(name) {
  return String(name || '').replace(/\.(md|txt)$/i, '')
}

function normalizeOutlineMeta(value = {}, fallbackName = '') {
  const source = value && typeof value === 'object' ? value : {}
  return {
    title: text(source.title) || outlineStem(fallbackName),
    scope: ['requirement', 'task'].includes(text(source.scope))
      ? text(source.scope)
      : 'requirement',
    requirementIds: parseList(source.requirementIds),
    requirementCodes: parseList(source.requirementCodes),
    taskKeys: parseList(source.taskKeys),
    route: text(source.route),
    source: text(source.source) || 'manual',
    status: ['active', 'draft', 'archived'].includes(text(source.status))
      ? text(source.status)
      : 'active',
    createdAt: text(source.createdAt),
    updatedAt: text(source.updatedAt),
    contentHash: text(source.contentHash),
  }
}

function outlineMetaOf(manifest, name) {
  return normalizeOutlineMeta(manifest?.outlines?.[name], name)
}

function outlineHash(content) {
  return createHash('sha256')
    .update(String(content ?? ''), 'utf8')
    .digest('hex')
}

function listOutlines(config, manifest = readManifest(config)) {
  const dir = outlineDirOf(config)
  if (!dir || !fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(md|txt)$/i.test(entry.name))
    .map((entry) => {
      const meta = outlineMetaOf(manifest, entry.name)
      const file = path.join(dir, entry.name)
      return {
        name: entry.name,
        size: fs.statSync(file).size,
        ...meta,
      }
    })
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
    paused: Boolean(run.paused),
    coveragePassed: run.coveragePassed !== false,
    nextStage: run.nextStage || '',
    resumed: Boolean(run.resumed),
    failedTests: run.failedTests || [],
    statePath: run.statePath || '',
    targetUrl: run.targetUrl,
    noRun: run.noRun,
    input: run.input || null,
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
  version: '0.5.0',
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
    const dataDir = text(ctx.paths?.dataDir)
    let projectPaths = []
    try {
      const listed = await ctx.capabilities.call('trellis.projects', 'list', {})
      projectPaths = (listed?.projects ?? []).map((project) => text(project.path)).filter(Boolean)
    } catch {
      // 项目能力不可用时退化为插件数据目录。
    }
    if (!config.workspaceDir) {
      config.workspaceDir = projectPaths[0] || path.join(dataDir || PLUGIN_DIR, 'workspace')
    }
    if (!config.outlinesDir) {
      config.outlinesDir = path.join(config.workspaceDir, '.trellis', 'scenario-outlines')
    }
    if (!config.outputRoot) {
      config.outputRoot = path.join(dataDir || path.join(os.homedir(), '.scenario'), 'output')
    }
    if (!config.storageState) {
      const candidate = path.join(
        dataDir || path.join(os.homedir(), '.scenario'),
        'storage-state.json',
      )
      if (fs.existsSync(candidate)) config.storageState = candidate
    }

    function scenarioRootCandidates() {
      const values = []
      const configured = text(config.scenarioRoot)
      if (configured) {
        values.push(path.resolve(configured), path.resolve(configured, 'packages', 'scenario-copilot'))
      }
      const envRoot = text(process.env.MOM_SCENARIO_ROOT)
      if (envRoot) values.push(path.resolve(envRoot))
      for (const project of projectPaths) {
        values.push(
          path.join(project, 'packages', 'scenario-copilot'),
          path.join(project, 'node_modules', '@mom-cli', 'scenario-copilot'),
        )
      }
      if (dataDir) values.push(path.join(dataDir, 'scenario-copilot'))
      return [...new Set(values)]
    }
    const runs = new Map()
    const groups = new Map()
    const children = new Map()
    const maxRuns = config.maxRuns

    const storedRuns = await ctx.store.get('runs').catch(() => null)
    if (Array.isArray(storedRuns)) {
      for (const item of storedRuns) {
        if (!item?.id) continue
        // 进程重启后内存里的运行已经不存在，持久化的 running 状态要收尾成中断，
        // 否则面板会一直显示"运行中"，也无法重跑。
        const interrupted = item.status === 'running'
        runs.set(item.id, {
          ...item,
          logs: '',
          ...(interrupted
            ? {
                status: 'failed',
                paused: false,
                nextStage: '',
                error: '实例重启，运行已中断（可重新生成或重新发起）',
                finishedAt: item.finishedAt || new Date().toISOString(),
              }
            : {}),
        })
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

    const NEXT_STAGE = { recon: 'generate', generate: 'verify', verify: 'execute', execute: '' }

    function parseResultLine(logs) {
      const match = /\[scenario-copilot\] result: (\{[^\n]*\})/.exec(String(logs || ''))
      if (!match) return null
      try {
        return JSON.parse(match[1])
      } catch {
        return null
      }
    }

    // CLI 在每个运行的末尾打印一条结果行，插件据此知道停在了哪个阶段、失败用例和状态文件。
    function applyResult(run) {
      const result = parseResultLine(run.logs)
      if (!result) return
      const stoppedAfter = text(result.stoppedAfter) || 'execute'
      run.resumed = Boolean(result.resumed)
      run.failedTests = Array.isArray(result.failedTests) ? result.failedTests : []
      run.statePath = text(result.statePath)
      if (text(result.scriptPath)) run.scriptPath = text(result.scriptPath)
      run.coveragePassed = result.coveragePassed === true
      run.paused = Boolean(stoppedAfter) && stoppedAfter !== 'execute'
      run.nextStage = run.paused ? NEXT_STAGE[stoppedAfter] || '' : ''
    }

    function finish(run, status, exitCode, error) {
      if (run.status !== 'running') return
      applyResult(run)
      // 主动停在中间阶段不是失败：覆盖率/生成问题会随 paused 状态一起展示，便于继续下一阶段
      if (run.paused && status === 'failed') {
        status = 'paused'
        error = null
      }
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
      const candidates = scenarioRootCandidates()
      const root = candidates.find((candidate) =>
        fs.existsSync(path.join(candidate, 'dist', 'bin', 'scenario-copilot.js')),
      )
      if (!root) {
        throw ctx.error(
          2001,
          `未找到 scenario-copilot CLI；已检查: ${candidates.join(', ') || '(无候选目录)'}`,
        )
      }
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

    function guessOutlineForTask(task, outlines) {
      if (!task) return ''
      const slug = path.basename(task.relativeDir || '')
      if (!slug) return ''
      return (
        outlines.find((outline) => {
          const stem = outlineStem(outline.name)
          return slug.includes(stem) || stem.includes(slug)
        })?.name ?? ''
      )
    }

    async function requirementBindingOf(requirementId) {
      const id = text(requirementId)
      if (!id) return {}
      const value = await ctx.store.get(`binding:requirement:${id}`).catch(() => null)
      return value && typeof value === 'object' ? value : {}
    }

    function outlineCandidatesForSubject(subject, options) {
      const { binding, requirementBinding, manifest, outlines, input, allowDefaultOutline } =
        options
      const available = new Set(outlines.map((outline) => outline.name))
      const candidates = []
      const seen = new Set()
      const add = (name, source, confidence) => {
        const value = text(name)
        if (!value || seen.has(value)) return
        seen.add(value)
        candidates.push({
          name: value,
          title: outlines.find((outline) => outline.name === value)?.title || outlineStem(value),
          source,
          confidence,
          available: available.has(value),
        })
      }
      const matchesRequirement = (meta) => {
        const ids = parseList(meta.requirementIds)
        const codes = parseList(meta.requirementCodes)
        return (
          (subject.requirementId && ids.includes(subject.requirementId)) ||
          (subject.requirementCode && codes.includes(subject.requirementCode))
        )
      }
      const matchesSortedByUpdate = (predicate) =>
        Object.entries(manifest.outlines || {})
          .filter(([, meta]) => predicate(meta && typeof meta === 'object' ? meta : {}))
          .sort((a, b) => String(b[1]?.updatedAt).localeCompare(String(a[1]?.updatedAt)))

      add(input.outline, 'explicit', 'high')
      if (subject.kind === 'trellis') {
        add(binding.outline, 'task-binding', 'high')
        add(requirementBinding.outline, 'requirement-binding', 'high')
        for (const [name] of matchesSortedByUpdate((meta) =>
          parseList(meta.taskKeys).includes(subject.taskKey),
        )) {
          add(name, 'manifest-task', 'high')
        }
        for (const [name] of matchesSortedByUpdate(matchesRequirement)) {
          add(name, 'manifest-requirement', 'high')
        }
        add(guessOutlineForTask(subject.task, outlines), 'filename-guess', 'low')
      } else {
        add(binding.outline, 'requirement-binding', 'high')
        for (const [name] of matchesSortedByUpdate(matchesRequirement)) {
          add(name, 'manifest-requirement', 'high')
        }
      }
      if (allowDefaultOutline) add(config.defaultOutline, 'default', 'low')

      const selected =
        candidates.find((candidate) => candidate.available) ||
        candidates.find((candidate) => candidate.source === 'explicit') ||
        null
      return { selected, candidates }
    }

    function targetUrlCandidates(subject, options) {
      const { binding, requirementBinding, task, input } = options
      const candidates = []
      const add = (url, source) => {
        const value = text(url)
        if (value) candidates.push({ url: value, source })
      }
      add(input.targetUrl, 'input')
      add(binding.targetUrl, subject.kind === 'trellis' ? 'task-binding' : 'requirement-binding')
      if (subject.kind === 'trellis') add(requirementBinding.targetUrl, 'requirement-binding')
      add(taskTarget(task), 'task-meta')
      add(config.targetUrl, 'config')
      return candidates
    }

    async function resolveOutlineForSubject(subject, raw = {}, options = {}) {
      const binding = options.binding ?? (await bindingOf(subject))
      const requirementBinding =
        options.requirementBinding ??
        (subject.kind === 'trellis' && subject.requirementId
          ? await requirementBindingOf(subject.requirementId)
          : subject.kind === 'requirement'
            ? binding
            : {})
      const manifest = options.manifest || readManifest(config)
      const outlines = options.outlines || listOutlines(config, manifest)
      const allowDefaultOutline =
        raw.allowDefaultOutline === true ||
        (raw.allowDefaultOutline === undefined && !subject.requirementId && !subject.taskKey)
      const { selected, candidates } = outlineCandidatesForSubject(subject, {
        binding,
        requirementBinding,
        manifest,
        outlines,
        input: raw,
        allowDefaultOutline,
      })
      const targets = targetUrlCandidates(subject, {
        binding,
        requirementBinding,
        task: subject.task,
        input: raw,
      })
      const target =
        targets.find((candidate) => /^https?:\/\//i.test(candidate.url)) || targets[0] || null
      return {
        outline: selected?.name || '',
        outlineTitle: selected?.title || '',
        outlineSource: selected?.source || 'none',
        outlineConfidence: selected?.confidence || 'none',
        outlineAvailable: Boolean(selected?.available),
        candidates: candidates.slice(0, 20),
        targetUrl: target?.url || '',
        targetUrlSource: target?.source || 'none',
        targetUrlCandidates: targets,
        requirementId: subject.requirementId || '',
        requirementCode: subject.requirementCode || '',
        taskKey: subject.taskKey || '',
        binding,
      }
    }

    async function resolveBatch(input = {}) {
      const subjects = Array.isArray(input.subjects)
        ? input.subjects
        : input.subject && typeof input.subject === 'object'
          ? [input.subject]
          : []
      const manifest = readManifest(config)
      const outlines = listOutlines(config, manifest)
      const results = {}
      for (const raw of subjects) {
        if (!raw || typeof raw !== 'object') continue
        const fallbackKey =
          text(raw.key) || text(raw.taskKey) || text(raw.requirementId) || 'unknown'
        try {
          const subject = await resolveSubject(raw)
          results[subject.key] = await resolveOutlineForSubject(subject, raw, {
            manifest,
            outlines,
          })
        } catch (error) {
          results[fallbackKey] = {
            outline: '',
            outlineSource: 'none',
            outlineConfidence: 'none',
            outlineAvailable: false,
            candidates: [],
            targetUrl: '',
            targetUrlSource: 'none',
            error: error.message,
          }
        }
      }
      return { results }
    }

    async function regressionPreflight(input = {}) {
      const subjects = Array.isArray(input.subjects) ? input.subjects : []
      const manifest = readManifest(config)
      const outlines = listOutlines(config, manifest)
      const missing = []
      for (const raw of subjects) {
        if (!raw || typeof raw !== 'object') continue
        let subject
        try {
          subject = await resolveSubject(raw)
        } catch (error) {
          missing.push({
            subjectKey: text(raw.key) || text(raw.taskKey) || text(raw.requirementId) || 'unknown',
            requirementId: text(raw.requirementId),
            taskKey: text(raw.taskKey),
            title: text(raw.title),
            reasons: ['subject-invalid'],
            error: error.message,
          })
          continue
        }
        const resolution = await resolveOutlineForSubject(subject, raw, {
          manifest,
          outlines,
        })
        const reasons = []
        if (!resolution.outline || !resolution.outlineAvailable) reasons.push('outline-missing')
        else if (['filename-guess', 'default'].includes(resolution.outlineSource)) {
          reasons.push('outline-guessed')
        }
        if (!/^https?:\/\//i.test(resolution.targetUrl)) reasons.push('url-missing')
        if (reasons.length) {
          missing.push({
            subjectKey: subject.key,
            requirementId: subject.requirementId,
            requirementCode: subject.requirementCode,
            taskKey: subject.taskKey,
            title: subject.title,
            outline: resolution.outline,
            outlineSource: resolution.outlineSource,
            targetUrl: resolution.targetUrl,
            reasons,
          })
        }
      }
      return { ready: missing.length === 0, total: subjects.length, missing }
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
        requirementId: text(raw?.requirementId) || text(task.meta?.requirement_id),
        requirementCode:
          text(raw?.requirementCode || raw?.code) ||
          text(task.meta?.requirement_code || task.meta?.code),
        title: task.title,
        task,
      }
    }

    async function startRun(input = {}) {
      const subject = await resolveSubject(input)
      const task = subject.task
      const binding = await bindingOf(subject)
      const manifest = readManifest(config)
      const outlines = listOutlines(config, manifest)
      const resolution = await resolveOutlineForSubject(subject, input, {
        binding,
        manifest,
        outlines,
      })
      const outlineDir = outlineDirOf(config)
      if (!outlineDir) throw ctx.error(2002, '未配置 outlinesDir（测试大纲目录）')
      const outlineName = resolution.outline
      if (!outlineName) {
        throw ctx.error(2002, '未关联测试大纲，请先生成或选择测试大纲', {
          needOutline: true,
          subjectKey: subject.key,
          requirementId: subject.requirementId,
          taskKey: subject.taskKey,
          candidates: resolution.candidates,
        })
      }
      const outlinePath = path.join(outlineDir, path.basename(outlineName))
      if (!resolution.outlineAvailable || !fs.existsSync(outlinePath)) {
        throw ctx.error(2002, `测试大纲不存在: ${outlineName}`, {
          outlineDir,
          needOutline: true,
          subjectKey: subject.key,
          candidates: resolution.candidates,
        })
      }
      const targetUrl = resolution.targetUrl
      if (!/^https?:\/\//i.test(targetUrl)) {
        const label =
          subject.kind === 'trellis' ? `任务 ${subject.taskKey}` : `需求 ${subject.title}`
        throw ctx.error(2003, `${label} 未配置测试地址`, {
          subjectKey: subject.key,
          targetUrlSource: resolution.targetUrlSource,
        })
      }
      const username = text(input.username) || config.username
      const password = text(input.password) || config.password
      const noRun =
        input.noRun === true ||
        (input.noRun !== false && !username && !password && !config.storageState)
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
        '--spec-dir',
        specDir,
        '--output',
        scriptPath,
        '--state-key',
        stateKey,
        '--stop-after',
        stage,
      ]
      // app-contract 是 scenario-copilot 认识的组件契约 JSON；普通 markdown 知识文件不传
      if (knowledgePath && fs.existsSync(knowledgePath) && /\.json$/i.test(knowledgePath)) {
        args.push('--app-contract', knowledgePath)
      }
      args.push('--max-healing', String(Number(config.maxHealingRetries ?? 1)))
      if (input.resume === true) args.push('--resume')
      if (input.regenerate === true) args.push('--regenerate')
      if (input.onlyFailed === true) args.push('--only-failed')
      if (text(input.grep)) args.push('--grep', text(input.grep))
      if (noRun && stage === 'execute') args.push('--no-run')
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
      if (config.storageState && fs.existsSync(config.storageState)) {
        env.MOM_STORAGE_STATE = config.storageState
      }
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
        paused: false,
        nextStage: '',
        resumed: false,
        failedTests: [],
        statePath: '',
        input: {
          taskKey: subject.kind === 'trellis' ? subject.taskKey : '',
          requirementId: subject.kind === 'requirement' ? subject.requirementId : '',
          requirementCode: subject.kind === 'requirement' ? subject.requirementCode : '',
          outline: outlineName,
          targetUrl,
          orgName: text(input.orgName) || config.orgName,
          noRun,
        },
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
        canGenerateOutline: Boolean(cliEntry()),
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
      const preflight = await regressionPreflight({
        subjects: subjects.map((item) => ({
          ...item,
          outline: text(item.outline) || text(input.outline),
        })),
      })
      if (!preflight.ready && input.allowMissing !== true) {
        throw ctx.error(2011, '回归预检未通过', { missing: preflight.missing })
      }
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

    function cliEntry() {
      const root = scenarioRootCandidates().find((candidate) =>
        fs.existsSync(path.join(candidate, 'dist', 'bin', 'scenario-copilot.js')),
      )
      return root ? path.join(root, 'dist', 'bin', 'scenario-copilot.js') : ''
    }

    function outlineEnv() {
      const env = { ...process.env }
      if (config.llmApiKey) env.MOM_LLM_API_KEY = config.llmApiKey
      if (config.llmBaseUrl) env.MOM_LLM_BASE_URL = config.llmBaseUrl
      if (config.llmModel) env.MOM_LLM_MODEL = config.llmModel
      if (config.maxTokens) env.MOM_LLM_MAX_TOKENS = String(config.maxTokens)
      if (config.effort) env.MOM_LLM_EFFORT = config.effort
      if (config.effortField) env.MOM_LLM_EFFORT_FIELD = config.effortField
      env.MOM_LLM_TIMEOUT = String(Math.round(config.outlineTimeoutMs / 1000))
      return env
    }

    // 生成大纲只读 stdout：CLI 的日志一律走 stderr，--json 输出才是协议。
    function runCliJson(args, timeoutMs) {
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, args, {
          // CLI 以包根目录为 cwd，和 pipeline 运行的约定保持一致
          cwd: path.dirname(path.dirname(path.dirname(args[0]))),
          env: outlineEnv(),
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        let stdout = ''
        let stderr = ''
        const timer = setTimeout(() => {
          child.kill('SIGTERM')
        }, timeoutMs)
        timer.unref?.()
        child.stdout.on('data', (chunk) => {
          stdout += chunk
        })
        child.stderr.on('data', (chunk) => {
          stderr += chunk
        })
        child.on('error', (error) => {
          clearTimeout(timer)
          reject(error)
        })
        child.on('close', (code, signal) => {
          clearTimeout(timer)
          if (code !== 0) {
            reject(new Error(text(stderr) || `scenario-copilot 退出码 ${code ?? signal}`))
            return
          }
          resolve(stdout)
        })
      })
    }

    async function generateOutline(input = {}) {
      const cliPath = cliEntry()
      if (!cliPath) {
        throw ctx.error(2005, '未找到 scenario-copilot CLI，请检查配置 scenarioRoot 并先构建 dist')
      }
      const args = [cliPath, 'outline', '--json']
      let tempDir = ''
      try {
        const requirementText = String(input.requirementText ?? '').trim()
        if (requirementText) {
          tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scenario-outline-'))
          const tempFile = path.join(tempDir, 'requirement.md')
          fs.writeFileSync(tempFile, requirementText, 'utf8')
          args.push('--input', tempFile)
        }
        if (text(input.title)) args.push('--title', text(input.title).slice(0, 120))
        if (text(input.notes)) args.push('--text', text(input.notes).slice(0, 12_000))
        if (text(input.requirementId)) args.push('--requirement-id', text(input.requirementId))
        if (text(input.targetRoute)) args.push('--route', text(input.targetRoute))
        const knowledge = text(config.knowledgePath)
        if (knowledge && fs.existsSync(knowledge)) args.push('--knowledge', knowledge)
        const caseCount = Number(input.caseCount)
        if (Number.isFinite(caseCount) && caseCount > 0) {
          args.push('--cases', String(Math.min(8, Math.round(caseCount))))
        }
        const stdout = await runCliJson(args, config.outlineTimeoutMs)
        const start = stdout.indexOf('{')
        if (start < 0) throw new Error('scenario-copilot 未返回 JSON')
        const parsed = JSON.parse(stdout.slice(start))
        return {
          title: text(parsed.title),
          content: String(parsed.content ?? ''),
          cases: Number(parsed.cases) || 0,
          steps: Number(parsed.steps) || 0,
          warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
        }
      } catch (error) {
        // CLI 的 stderr 已经带「大纲生成失败：」前缀，这里去掉避免重复
        const message = String(error.message || '').replace(/^大纲生成失败[:：]\s*/, '')
        throw ctx.error(2006, `大纲生成失败: ${message}`)
      } finally {
        if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true })
      }
    }

    function saveOutline(input = {}) {
      const directory = outlineDirOf(config)
      if (!directory) throw ctx.error(2002, '未配置 outlinesDir（测试大纲目录）')
      fs.mkdirSync(directory, { recursive: true })
      const content = String(input.content ?? '')
        .replace(/\r\n/g, '\n')
        .trim()
      if (!content) throw ctx.error(2007, '大纲内容为空')
      const heading = /^#\s+(.+)$/m.exec(content)
      if (!heading) throw ctx.error(2008, '大纲缺少一级标题（# 标题）')
      const title = heading[1].trim()
      let name =
        path
          .basename(text(input.name) || `${slugify(title)}.md`)
          .replace(/[\\/:*?"<>|]+/g, '-')
          .trim() || `${slugify(title)}.md`
      if (!/\.(md|txt)$/i.test(name)) name = `${name}.md`
      const full = path.join(directory, name)
      if (!full.startsWith(directory + path.sep)) throw ctx.error(2010, '文件名不合法')
      if (fs.existsSync(full) && input.overwrite === false) {
        throw ctx.error(2009, `大纲已存在: ${name}`)
      }
      const normalized = content.endsWith('\n') ? content : `${content}\n`
      fs.writeFileSync(full, normalized, 'utf8')
      const manifest = readManifest(config)
      const previous =
        manifest.outlines[name] && typeof manifest.outlines[name] === 'object'
          ? manifest.outlines[name]
          : {}
      const now = new Date().toISOString()
      const next = { ...previous }
      if (input.scope !== undefined) next.scope = input.scope
      if (input.requirementIds !== undefined) next.requirementIds = input.requirementIds
      if (input.requirementCodes !== undefined) next.requirementCodes = input.requirementCodes
      if (input.taskKeys !== undefined) next.taskKeys = input.taskKeys
      if (input.route !== undefined) next.route = input.route
      if (input.source !== undefined) next.source = input.source
      if (input.status !== undefined) next.status = input.status
      const meta = normalizeOutlineMeta(
        {
          ...next,
          title,
          createdAt: text(previous.createdAt) || now,
          updatedAt: now,
          contentHash: outlineHash(normalized),
        },
        name,
      )
      manifest.outlines[name] = meta
      writeManifest(config, manifest)
      return {
        name,
        title,
        size: fs.statSync(full).size,
        outline: { name, ...meta },
        outlines: listOutlines(config, manifest),
      }
    }

    function associateOutline(input = {}) {
      const directory = outlineDirOf(config)
      if (!directory) throw ctx.error(2002, '未配置 outlinesDir（测试大纲目录）')
      const name = path.basename(text(input.name))
      if (!name || !/\.(md|txt)$/i.test(name)) throw ctx.error(2010, '文件名不合法')
      const full = path.join(directory, name)
      if (!fs.existsSync(full)) throw ctx.error(2002, `测试大纲不存在: ${name}`)
      const manifest = readManifest(config)
      const previous =
        manifest.outlines[name] && typeof manifest.outlines[name] === 'object'
          ? manifest.outlines[name]
          : {}
      const now = new Date().toISOString()
      const next = { ...previous }
      if (input.scope !== undefined) next.scope = input.scope
      if (input.route !== undefined) next.route = input.route
      if (input.source !== undefined) next.source = input.source
      if (input.status !== undefined) next.status = input.status
      const merge = input.mode !== 'replace'
      for (const key of ['requirementIds', 'requirementCodes', 'taskKeys']) {
        if (input[key] === undefined) continue
        next[key] = merge
          ? [...new Set([...parseList(previous[key]), ...parseList(input[key])])]
          : parseList(input[key])
      }
      const meta = normalizeOutlineMeta(
        {
          ...next,
          title: text(previous.title) || outlineStem(name),
          createdAt: text(previous.createdAt) || now,
          updatedAt: now,
          contentHash: outlineHash(fs.readFileSync(full, 'utf8')),
        },
        name,
      )
      manifest.outlines[name] = meta
      writeManifest(config, manifest)
      return { outline: { name, ...meta }, outlines: listOutlines(config, manifest) }
    }

    async function resumeRun(input = {}) {
      const run = runs.get(text(input.id))
      if (!run) throw ctx.error(2004, '运行记录不存在')
      if (run.status === 'running') throw ctx.error(2011, '运行尚未结束，不能续跑')
      if (!run.input?.taskKey && !run.input?.requirementId) {
        throw ctx.error(2014, '该运行缺少原始任务信息（插件升级前创建），请重新发起测试')
      }
      const action = ['next', 'only-failed', 'regenerate'].includes(text(input.action))
        ? text(input.action)
        : 'next'
      if (action === 'next' && !run.paused) throw ctx.error(2012, '该运行没有待继续的阶段')
      if (action === 'only-failed' && !(run.failedTests || []).length) {
        throw ctx.error(2013, '上一次运行没有失败用例')
      }
      const stage = action === 'next' ? run.nextStage : run.stage || 'execute'
      if (!stage) throw ctx.error(2012, '没有可继续的阶段')
      const base = run.input && typeof run.input === 'object' ? run.input : {}
      const next = await startRun({
        ...base,
        // 续跑时允许表单重新提供凭据；不落库，只透传给本次进程
        username: text(input.username),
        password: text(input.password),
        orgName: text(input.orgName) || base.orgName,
        stage,
        resume: action !== 'regenerate',
        regenerate: action === 'regenerate',
        onlyFailed: action === 'only-failed',
      })
      return summaryOf(next)
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

    ctx.http.route('GET', '/outlines', async () => ({ outlines: listOutlines(config) }))

    ctx.http.route('POST', '/outlines/generate', async (request) => generateOutline(request.json()))

    ctx.http.route('POST', '/outlines/save', async (request) => saveOutline(request.json()))

    ctx.http.route('POST', '/outlines/resolve', async (request) => resolveBatch(request.json()))

    ctx.http.route('POST', '/outlines/associate', async (request) =>
      associateOutline(request.json()),
    )

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

    ctx.http.route('POST', '/runs/resume', async (request) => ({
      run: await resumeRun(request.json()),
    }))

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

    ctx.http.route('POST', '/regressions/preflight', async (request) =>
      regressionPreflight(request.json()),
    )

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
      'runs.resume': async (params) => resumeRun(params),
      'regressions.start': async (params) => startRegression(params),
      'regressions.get': async (params) => getRegression(params?.id),
      'regressions.cancel': async (params) => cancelRegression(params?.id),
      'regressions.preflight': async (params) => regressionPreflight(params),
      'outlines.list': async () => ({ outlines: listOutlines(config) }),
      'outlines.generate': async (params) => generateOutline(params),
      'outlines.save': async (params) => saveOutline(params),
      'outlines.resolve': async (params) => resolveBatch(params),
      'outlines.associate': async (params) => associateOutline(params),
    })

    ctx.effect(() => {
      for (const child of children.values()) child.kill('SIGTERM')
      children.clear()
    })
  },
})
