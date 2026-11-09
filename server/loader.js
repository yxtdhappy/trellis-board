import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const STAGE_ORDER = [
  'prd',
  'research',
  'design',
  'implementPlan',
  'context',
  'review',
  'implement',
  'check',
  'e2e',
  'spec',
  'commit',
  'archive',
  'journal',
]

const STAGE_META = {
  prd: { label: '需求', index: 1 },
  research: { label: '调研', index: 2 },
  design: { label: '设计', index: 3 },
  implementPlan: { label: '实施计划', index: 4 },
  context: { label: '上下文编排', index: 5 },
  review: { label: '规划评审', index: 6 },
  implement: { label: '实现', index: 7 },
  check: { label: '检查', index: 8 },
  e2e: { label: '真实验证', index: 9 },
  spec: { label: '规范回写', index: 10 },
  commit: { label: '工作提交', index: 11 },
  archive: { label: '归档', index: 12 },
  journal: { label: '会话记录', index: 13 },
}

const TASK_CACHE_FILES = [
  'task.json',
  'prd.md',
  'design.md',
  'implement.md',
  'implementation-report.md',
  'check-report.md',
  'e2e-report.md',
  'implement.jsonl',
  'check.jsonl',
]
const GIT_METADATA_CACHE_TTL_MS = 60_000
const taskScanCache = new Map()
const gitMetadataCache = new Map()

export function clearScanCaches({ tasks = true, gitMetadata = true } = {}) {
  if (tasks) taskScanCache.clear()
  if (gitMetadata) gitMetadataCache.clear()
}

function safeRead(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8')
  } catch {
    return ''
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

function listDirectories(dirPath) {
  try {
    return fs
      .readdirSync(dirPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(dirPath, entry.name))
  } catch {
    return []
  }
}

function hasMeaningfulPrd(content) {
  const requirements = content.match(/##\s+Requirements\s*\n([\s\S]*?)(?=\n##\s|$)/i)?.[1] || ''
  const acceptance =
    content.match(/##\s+Acceptance Criteria\s*\n([\s\S]*?)(?=\n##\s|$)/i)?.[1] || ''
  const meaningfulLines = [...requirements.split(/\r?\n/), ...acceptance.split(/\r?\n/)]
    .map((line) => line.trim())
    .filter((line) => line && !/^-\s*\[\s*\]\s*TBD\.?$/i.test(line) && !/^-?\s*TBD\.?$/i.test(line))
  return {
    initialized: meaningfulLines.length > 0,
    acceptanceCount: (acceptance.match(/^-\s*\[[ xX]\]/gm) || []).length,
    checkedCount: (acceptance.match(/^-\s*\[[xX]\]/gm) || []).length,
  }
}

function hasMeaningfulDocument(content) {
  if (typeof content !== 'string' || !content.trim()) return false
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^#{1,6}\s/.test(line))
    .filter((line) => !/^[-*]?\s*(?:TBD|TODO|待补|待填写)[.。]?$/i.test(line))
    .some((line) => line.replace(/[`*_#[\]()>-]/g, '').trim().length >= 4)
}

const E2E_CONTEXT_PATTERN = /E2E|真机|真实页面|真实联调|浏览器验证|Playwright|Chrome DevTools/i
const E2E_COMPLETED_PATTERN =
  /已完成|已执行|已验证|已复测|验证通过|测试通过|端到端通过|(?:^|[|:：\s-])(?:通过|成功|PASS(?:ED)?|SUCCESS|OK|✅)(?:$|[|。；;\s（(])/i
const E2E_NEGATIVE_PATTERN =
  /未完成|未执行|未验证|未运行|尚未|待确认|待执行|等待|未通过|失败|blocked|不能标记/i
const E2E_DEFERRED_PATTERN = /通过后|完成后再|再做|下一步|后续|计划执行|准备执行|预计/i

function hasCompletedVerificationEvidence(content, source = '') {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const usableLines = lines.filter(
    (line) => !E2E_NEGATIVE_PATTERN.test(line) && !E2E_DEFERRED_PATTERN.test(line),
  )
  if (source === 'e2e-report') {
    return (
      E2E_CONTEXT_PATTERN.test(content) &&
      usableLines.some((line) => E2E_COMPLETED_PATTERN.test(line))
    )
  }
  return usableLines.some(
    (line) => E2E_CONTEXT_PATTERN.test(line) && E2E_COMPLETED_PATTERN.test(line),
  )
}

function hasCompletedCheckEvidence(content) {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const checkPattern = /测试|vitest|jest|test|lint|type.?check|编译|build|检查/i
  const completedPattern = /通过|passed|pass|成功|success|0 failures|0 errors/i
  const incompletePattern = /未执行|未运行|未通过|尚未|待执行|等待|失败|blocked/i
  return lines.some(
    (line) =>
      checkPattern.test(line) && completedPattern.test(line) && !incompletePattern.test(line),
  )
}

function hasCheckedAcceptanceEvidence(content) {
  const acceptance =
    content.match(/##\s+Acceptance Criteria\s*\n([\s\S]*?)(?=\n##\s|$)/i)?.[1] || ''
  return /^-\s*\[[xX]\]/m.test(acceptance)
}

function hasCheckedPlanEvidence(content) {
  return (
    (content.match(/^-\s*\[[xX]\].*(测试|验证|检查|test|verify|check|lint)/gim) || []).length > 0
  )
}

function deriveCurrentStageFromStages(stages) {
  if (!Array.isArray(stages) || !stages.length) return 'prd'
  const archiveStage = stages.find((stage) => stage.id === 'archive')
  if (archiveStage?.complete) {
    const journalStage = stages.find((stage) => stage.id === 'journal')
    return journalStage?.complete ? 'journal' : 'archive'
  }
  const executionEnd = stages.findIndex((stage) => stage.id === 'check')
  const frontier = stages.reduce(
    (highest, stage, index) => (stage.complete && index <= executionEnd ? index : highest),
    0,
  )
  const next = stages.slice(frontier + 1).find((stage) => !stage.complete && !stage.optional)?.id
  return next || stages[stages.length - 1].id
}

function countJsonlEntries(filePath) {
  return safeRead(filePath)
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.includes('"_example"'))
    .filter((line) => {
      try {
        return typeof JSON.parse(line).file === 'string'
      } catch {
        return false
      }
    }).length
}

function readWorkspaceSummary(repoPath, assignee) {
  const indexFile = path.join(repoPath, '.trellis', 'workspace', assignee, 'index.md')
  const workspaceDir = path.dirname(indexFile)
  let journals = 0
  try {
    journals = fs.readdirSync(workspaceDir).filter((name) => /^journal-\d+\.md$/.test(name)).length
  } catch {
    // Missing workspace data is the normal state for tasks imported from another developer.
  }
  return {
    indexExists: fs.existsSync(indexFile),
    journals,
  }
}

function taskWorkspaceMember(task) {
  return task.assignee || task.creator || 'unknown'
}

function statSignature(filePath) {
  try {
    const stat = fs.statSync(filePath, { bigint: true })
    return `${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.ino}`
  } catch {
    return 'missing'
  }
}

function modifiedAt(filePath) {
  try {
    return fs.statSync(filePath).mtime.toISOString()
  } catch {
    return null
  }
}

function taskBaseSignature(project, taskDir) {
  let rootEntries = new Map()
  try {
    rootEntries = new Map(
      fs.readdirSync(taskDir, { withFileTypes: true }).map((entry) => [entry.name, entry]),
    )
  } catch {
    // A disappearing task is handled by the caller as a cache miss.
  }
  const parts = [
    `project=${project.id}:${project.name}`,
    ...TASK_CACHE_FILES.map((name) => {
      const entry = rootEntries.get(name)
      return entry?.isFile()
        ? `${name}=${statSignature(path.join(taskDir, name))}`
        : `${name}=missing`
    }),
  ]
  const researchDir = path.join(taskDir, 'research')
  let researchFiles = []
  if (rootEntries.get('research')?.isDirectory()) {
    try {
      researchFiles = fs
        .readdirSync(researchDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
        .map((entry) => entry.name)
        .sort((left, right) => left.localeCompare(right, 'en'))
        .map((name) => `${name}=${statSignature(path.join(researchDir, name))}`)
    } catch {
      // A disappearing research directory becomes a cache miss on the next event.
    }
  }
  parts.push(`research=${researchFiles.join(',')}`)
  return parts.join('|')
}

function taskCacheKey(project, taskDir, includeContent) {
  const relativeDir = path.relative(project.path, taskDir).replaceAll('\\', '/')
  return `${normalizePath(project.path)}::${relativeDir}:${includeContent ? 'detail' : 'list'}`
}

function forgetTaskCacheEntries(project, taskDir) {
  taskScanCache.delete(taskCacheKey(project, taskDir, false))
  taskScanCache.delete(taskCacheKey(project, taskDir, true))
}

function workspaceSignature(repoPath, member) {
  const workspaceDir = path.join(repoPath, '.trellis', 'workspace', member)
  const indexSignature = statSignature(path.join(workspaceDir, 'index.md'))
  let journals = []
  try {
    journals = fs
      .readdirSync(workspaceDir)
      .filter((name) => /^journal-\d+\.md$/.test(name))
      .sort((left, right) => left.localeCompare(right, 'en'))
  } catch {
    // Missing workspace data is already represented by the missing index.
  }
  return `${indexSignature}:${journals.join(',')}`
}

function latestCommit(repoPath) {
  try {
    const headFile = path.join(repoPath, '.git', 'HEAD')
    return safeRead(headFile).trim() || null
  } catch {
    return null
  }
}

function buildArtifactSummary(files, includeContent = false) {
  const maxChars = 40_000
  const prdInfo = hasMeaningfulPrd(files.prd?.content || '')
  const normalize = (file) =>
    file && includeContent
      ? {
          path: file.path,
          content: file.content.slice(0, maxChars),
          truncated: file.content.length > maxChars,
        }
      : file
        ? { path: file.path, content: '', truncated: false }
        : null
  return {
    summary: {
      hasPrd: Boolean(files.prd),
      hasDesign: Boolean(files.design),
      hasImplement: Boolean(files.implement),
      hasImplementationReport: Boolean(files.implementationReport),
      hasCheckReport: Boolean(files.checkReport),
      hasE2eReport: Boolean(files.e2eReport),
      researchFiles: files.researchFiles,
      implementEntries: files.implementEntries,
      checkEntries: files.checkEntries,
      prdMeaningful: prdInfo.initialized,
      prdAcceptanceCount: prdInfo.acceptanceCount,
      prdCheckedCount: prdInfo.checkedCount,
      designMeaningful: hasMeaningfulDocument(files.design?.content || ''),
    },
    artifacts: {
      prd: normalize(files.prd),
      design: normalize(files.design),
      implement: normalize(files.implement),
      implementationReport: normalize(files.implementationReport),
      checkReport: normalize(files.checkReport),
      e2eReport: normalize(files.e2eReport),
    },
  }
}

function createStageMap(evidence) {
  return STAGE_ORDER.map((id) => ({
    id,
    ...STAGE_META[id],
    complete: Boolean(evidence[id]?.complete),
    evidence: evidence[id]?.evidence || null,
    source: evidence[id]?.source || 'missing',
    optional: id === 'e2e',
  }))
}

function inferDerivedStage(task, taskDir, files, workspaceSummary = null) {
  const evidence = {}
  const prd = files.prd?.content || ''
  const prdInfo = hasMeaningfulPrd(prd)
  const implementationReport = files.implementationReport?.content || ''
  const checkReport = files.checkReport?.content || ''
  const e2eReport = files.e2eReport?.content || ''
  const implementPlan = files.implement?.content || ''
  const hasStarted = ['in_progress', 'completed'].includes(task.status)
  const hasCheckedAcceptance = hasCheckedAcceptanceEvidence(prd)
  const passedCheckReport = hasCompletedCheckEvidence(checkReport)
  const passedImplementationReport = hasCompletedCheckEvidence(implementationReport)
  const checkedPlan = hasCheckedPlanEvidence(implementPlan)
  const hasImplementationEvidence =
    task.status === 'completed' ||
    Boolean(task.commit) ||
    hasCheckedAcceptance ||
    Boolean(implementationReport.trim()) ||
    Boolean(checkReport.trim())
  const hasPlanningCutoff = prdInfo.initialized && (hasStarted || hasImplementationEvidence)
  const checkEvidence =
    hasImplementationEvidence &&
    (passedCheckReport ||
      passedImplementationReport ||
      hasCheckedAcceptance ||
      checkedPlan ||
      task.status === 'completed')
  const implementationSource = implementationReport.trim()
    ? 'implementation-report'
    : checkReport.trim()
      ? 'check-report'
      : hasCheckedAcceptance
        ? 'prd-acceptance'
        : task.commit
          ? 'task-json'
          : task.status === 'completed'
            ? 'status'
            : 'missing'
  const implementationEvidence = implementationReport.trim()
    ? `implementation-report.md 记录交付 ${implementationReport.length.toLocaleString('zh-CN')} 字符`
    : checkReport.trim()
      ? `check-report.md 记录实现检查 ${checkReport.length.toLocaleString('zh-CN')} 字符`
      : hasCheckedAcceptance
        ? 'PRD 验收项已勾选'
        : task.commit
          ? `task.json commit=${task.commit}`
          : task.status === 'completed'
            ? 'task.json status=completed'
            : hasStarted
              ? '任务已开始，但尚无实施报告、检查报告、验收勾选、提交或完成状态'
              : '任务尚未开始，也没有实施报告、检查报告、验收勾选、提交或完成状态'

  evidence.prd = {
    complete: Boolean(files.prd && prdInfo.initialized),
    source: files.prd ? 'file' : 'missing',
    evidence: files.prd
      ? prdInfo.initialized
        ? `PRD 已填写；验收项 ${prdInfo.checkedCount}/${prdInfo.acceptanceCount} 已勾选`
        : '仍为默认 PRD 骨架'
      : '没有 prd.md',
  }
  evidence.research = {
    complete: files.researchFiles.length > 0,
    source: 'file',
    evidence: files.researchFiles.length
      ? `research/ 下有 ${files.researchFiles.length} 个文件`
      : '没有 research 文件',
  }
  evidence.design = {
    complete: Boolean(files.design),
    source: 'file',
    evidence: files.design ? '存在 design.md' : '没有 design.md',
  }
  evidence.implementPlan = {
    complete: Boolean(files.implement),
    source: 'file',
    evidence: files.implement ? '存在 implement.md' : '没有 implement.md',
  }
  evidence.context = {
    complete: files.implementEntries > 0 && files.checkEntries > 0,
    source: 'file',
    evidence: `implement.jsonl ${files.implementEntries} 条 / check.jsonl ${files.checkEntries} 条`,
  }
  evidence.review = {
    complete: hasPlanningCutoff,
    source: hasPlanningCutoff ? (hasStarted ? 'status' : implementationSource) : 'status',
    evidence: hasPlanningCutoff
      ? hasStarted
        ? `task.json status=${task.status}，规划已放行`
        : '已有实施/检查完成证据，说明任务已进入开发'
      : hasImplementationEvidence
        ? '已有实施/检查完成证据，但 PRD 仍是默认骨架'
        : hasStarted
          ? '任务已开始，但 PRD 仍未有效填写'
          : '任务仍在 planning，且没有开发完成证据',
  }
  evidence.implement = {
    complete: hasImplementationEvidence,
    source: implementationSource,
    evidence: implementationEvidence,
  }
  evidence.check = {
    complete: checkEvidence,
    source: checkEvidence
      ? passedCheckReport
        ? 'check-report'
        : passedImplementationReport
          ? 'implementation-report'
          : hasCheckedAcceptance
            ? 'prd-acceptance'
            : checkedPlan
              ? 'implement-plan'
              : 'status'
      : 'missing',
    evidence: checkEvidence
      ? passedCheckReport
        ? 'check-report.md 记录了通过的测试、类型检查、编译或 lint'
        : passedImplementationReport
          ? 'implementation-report.md 记录了通过的检查'
          : hasCheckedAcceptance
            ? 'PRD 验收项已勾选'
            : checkedPlan
              ? 'implement.md 已勾选检查项'
              : '任务已完成，按 Trellis 状态视为检查阶段已收口'
      : checkedPlan
        ? 'implement.md 已勾选检查项，但缺少实施报告、检查报告、验收勾选、提交或完成状态'
        : '没有找到通过的持久检查证据，需人工确认',
  }
  const verificationSources = [
    { source: 'e2e-report', content: e2eReport },
    { source: 'check-report', content: checkReport },
    { source: 'implementation-report', content: implementationReport },
  ]
  const verificationEvidence = verificationSources.find(
    ({ source, content }) => content && hasCompletedVerificationEvidence(content, source),
  )
  evidence.e2e = {
    complete: Boolean(verificationEvidence),
    source: verificationEvidence?.source || 'missing',
    evidence: verificationEvidence
      ? verificationEvidence.source === 'e2e-report'
        ? 'e2e-report.md 记录了明确通过的真实验证'
        : '任务产物记录了明确通过的真实验证'
      : '可选步骤：没有真实验证证据；不阻塞规范和收尾',
  }
  const specEvidence = task.relatedFiles?.some((file) => file.startsWith('.trellis/spec/'))
  evidence.spec = {
    complete: Boolean(specEvidence),
    source: specEvidence ? 'task-json' : 'missing',
    evidence: specEvidence
      ? 'relatedFiles 含 .trellis/spec/'
      : 'relatedFiles 没有 spec 文件；需人工核验',
  }
  evidence.commit = {
    complete: Boolean(task.commit),
    source: 'task-json',
    evidence: task.commit ? `task.json commit=${task.commit}` : 'task.json 没有 commit 字段',
  }
  evidence.archive = {
    complete: task.archived,
    source: 'archive',
    evidence: task.archived ? '任务位于 archive/' : '任务仍在进行中目录',
  }
  const workspace =
    workspaceSummary || readWorkspaceSummary(task.repoPath, taskWorkspaceMember(task))
  evidence.journal = {
    complete: workspace.indexExists && workspace.journals > 0,
    source: 'workspace',
    evidence: `${task.assignee || task.creator || 'unknown'} 有 ${workspace.journals} 个 journal 文件`,
  }

  return evidence
}

function buildTask(
  project,
  taskDir,
  archived,
  includeContent = false,
  workspaceSummaryResolver = readWorkspaceSummary,
) {
  const taskJsonPath = path.join(taskDir, 'task.json')
  const taskJson = readJson(taskJsonPath)
  if (!taskJson) return null
  const archivedAt = archived ? modifiedAt(taskJsonPath) : null
  const prdPath = path.join(taskDir, 'prd.md')
  const designPath = path.join(taskDir, 'design.md')
  const implementPath = path.join(taskDir, 'implement.md')
  const implementationReportPath = path.join(taskDir, 'implementation-report.md')
  const checkReportPath = path.join(taskDir, 'check-report.md')
  const e2eReportPath = path.join(taskDir, 'e2e-report.md')
  const prdContent = safeRead(prdPath)
  const implementContent = safeRead(implementPath)
  const designContent = safeRead(designPath)
  const implementationReportContent = safeRead(implementationReportPath)
  const checkReportContent = safeRead(checkReportPath)
  const e2eReportContent = safeRead(e2eReportPath)
  const researchDir = path.join(taskDir, 'research')
  const files = {
    prd: fs.existsSync(prdPath) ? { path: prdPath, content: prdContent } : null,
    design: fs.existsSync(designPath) ? { path: designPath, content: designContent } : null,
    implement: fs.existsSync(implementPath)
      ? { path: implementPath, content: implementContent }
      : null,
    implementationReport: fs.existsSync(implementationReportPath)
      ? { path: implementationReportPath, content: implementationReportContent }
      : null,
    checkReport: fs.existsSync(checkReportPath)
      ? { path: checkReportPath, content: checkReportContent }
      : null,
    e2eReport: fs.existsSync(e2eReportPath)
      ? { path: e2eReportPath, content: e2eReportContent }
      : null,
    researchFiles: listDirectories(path.dirname(researchDir)).includes(researchDir)
      ? fs.readdirSync(researchDir).filter((name) => name.endsWith('.md'))
      : [],
    implementEntries: countJsonlEntries(path.join(taskDir, 'implement.jsonl')),
    checkEntries: countJsonlEntries(path.join(taskDir, 'check.jsonl')),
  }
  const task = {
    ...taskJson,
    repoPath: project.path,
    archived,
    dirName: path.basename(taskDir),
    relativeDir: path.relative(project.path, taskDir).replaceAll('\\', '/'),
  }
  const workspaceSummary = workspaceSummaryResolver(project.path, taskWorkspaceMember(task))
  const evidence = inferDerivedStage(task, taskDir, files, workspaceSummary)
  if (archived) {
    evidence.archive = {
      complete: true,
      source: 'archive',
      evidence: '任务位于 archive/',
    }
    const achievedIndex = STAGE_ORDER.reduce(
      (highest, id, index) => (evidence[id]?.complete ? index : highest),
      -1,
    )
    for (let index = 0; index <= achievedIndex; index += 1) {
      const id = STAGE_ORDER[index]
      if (!evidence[id]?.complete) {
        evidence[id] = {
          complete: true,
          source: 'archive-gap',
          evidence: `归档任务没有留下${STAGE_META[id].label}证据；按历史任务处理，不据此后补事实`,
        }
      }
    }
  }
  const stageMap = createStageMap(evidence)
  const relativeDir = path.relative(project.path, taskDir).replaceAll('\\', '/')
  const explicitExecutionId = String(taskJson.id || '').trim()
  const executionId = explicitExecutionId || path.basename(taskDir)
  const artifactSummary = buildArtifactSummary(files, includeContent)
  return {
    ...task,
    taskKey: `${project.id}::${relativeDir}`,
    executionTaskKey: `${project.id}::${executionId}`,
    executionIdentityValid: Boolean(executionId),
    projectId: project.id,
    projectName: project.name,
    archivedAt,
    artifacts: artifactSummary.artifacts,
    summary: artifactSummary.summary,
    files: undefined,
    derivedStage: deriveCurrentStageFromStages(stageMap),
    stages: stageMap,
  }
}

function collectTaskDirs(repoPath) {
  const tasksDir = path.join(repoPath, '.trellis', 'tasks')
  if (!fs.existsSync(tasksDir)) return { active: [], archived: [] }
  const active = listDirectories(tasksDir).filter((dir) => path.basename(dir) !== 'archive')
  const archiveRoot = path.join(tasksDir, 'archive')
  const archived = []
  const pending = fs.existsSync(archiveRoot) ? [archiveRoot] : []
  while (pending.length) {
    const current = pending.pop()
    for (const dir of listDirectories(current)) {
      archived.push(dir)
      pending.push(dir)
    }
  }
  const newestFirst = (a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs
  active.sort(newestFirst)
  archived.sort(newestFirst)
  return { active, archived }
}

export function scanRepository(project, options = {}) {
  const includeContent = Boolean(options.includeContent)
  const metadataRepoPath = options.metadataRepoPath || project.path
  const stats = {
    tasksParsed: 0,
    tasksReused: 0,
    gitMetadataCacheHits: 0,
    gitMetadataCacheMisses: 0,
  }
  if (!fs.existsSync(path.join(project.path, '.trellis'))) {
    return { project, tasks: [], error: '缺少 .trellis 目录', stats }
  }
  const baseProject = {
    ...project,
    developer: readDeveloper(project.path),
    members: readMembers(project.path),
    head: latestCommit(metadataRepoPath),
    ...readCachedGitMetadata(metadataRepoPath, options, stats),
  }
  const workspaceCache = new Map()
  const getWorkspaceSummary = (repoPath, member) => {
    if (!workspaceCache.has(member)) {
      workspaceCache.set(member, readWorkspaceSummary(repoPath, member))
    }
    return workspaceCache.get(member)
  }
  const dirs = collectTaskDirs(project.path)
  const cachePrefix = `${normalizePath(project.path)}::`
  const activeCacheKeys = new Set()
  const tasks = [
    ...dirs.active.map((dir) => ({ dir, archived: false })),
    ...dirs.archived.map((dir) => ({ dir, archived: true })),
  ]
    .map(({ dir, archived }) => {
      const cacheKey = taskCacheKey(project, dir, includeContent)
      activeCacheKeys.add(cacheKey)
      const baseSignature = taskBaseSignature(project, dir)
      const cached = taskScanCache.get(cacheKey)
      if (cached?.baseSignature === baseSignature) {
        const summary = getWorkspaceSummary(project.path, cached.workspaceMember)
        const signature = `${baseSignature}|workspace=${workspaceSignature(project.path, cached.workspaceMember)}`
        if (cached.signature === signature) {
          stats.tasksReused += 1
          return cached.task
        }
      }

      const task = buildTask(project, dir, archived, includeContent, getWorkspaceSummary)
      if (!task) return null
      const workspaceMember = taskWorkspaceMember(task)
      taskScanCache.set(cacheKey, {
        baseSignature,
        signature: `${baseSignature}|workspace=${workspaceSignature(project.path, workspaceMember)}`,
        workspaceMember,
        task,
      })
      stats.tasksParsed += 1
      return task
    })
    .filter(Boolean)

  for (const cacheKey of taskScanCache.keys()) {
    if (cacheKey.startsWith(cachePrefix) && !activeCacheKeys.has(cacheKey)) {
      taskScanCache.delete(cacheKey)
    }
  }

  const members = [
    ...new Set([
      ...baseProject.members,
      ...tasks.map((task) => task.assignee || task.creator).filter(Boolean),
    ]),
  ].sort((a, b) => a.localeCompare(b, 'zh-CN'))

  return {
    project: {
      ...baseProject,
      members,
      workspaceMembers: baseProject.members,
    },
    tasks,
    error: null,
    stats,
  }
}

export function scanTask(project, taskDir, options = {}) {
  return buildTask(project, taskDir, Boolean(options.archived), options.includeContent !== false)
}

export function refreshCachedTask(project, taskDir, options = {}) {
  const includeContent = Boolean(options.includeContent)
  if (!fs.existsSync(path.join(taskDir, 'task.json'))) {
    forgetTaskCacheEntries(project, taskDir)
    return null
  }

  const cacheKey = taskCacheKey(project, taskDir, includeContent)
  const baseSignature = taskBaseSignature(project, taskDir)
  const cached = taskScanCache.get(cacheKey)
  const workspaceCache = new Map()
  const getWorkspaceSummary = (repoPath, member) => {
    if (!workspaceCache.has(member)) {
      workspaceCache.set(member, readWorkspaceSummary(repoPath, member))
    }
    return workspaceCache.get(member)
  }
  if (cached?.baseSignature === baseSignature) {
    const signature = `${baseSignature}|workspace=${workspaceSignature(project.path, cached.workspaceMember)}`
    if (cached.signature === signature) return cached.task
  }

  const task = buildTask(
    project,
    taskDir,
    Boolean(options.archived),
    includeContent,
    getWorkspaceSummary,
  )
  if (!task) return null
  const workspaceMember = taskWorkspaceMember(task)
  taskScanCache.set(cacheKey, {
    baseSignature,
    signature: `${baseSignature}|workspace=${workspaceSignature(project.path, workspaceMember)}`,
    workspaceMember,
    task,
  })
  return task
}

export function readProjectMembers(repoPath) {
  return readMembers(repoPath)
}

function normalizePath(value) {
  return path.resolve(value).replaceAll('\\', '/').toLowerCase()
}

function archivePathVariants(value) {
  const normalized = String(value || '')
    .replaceAll('\\', '/')
    .replace(/\/+$/, '')
  const marker = '/.trellis/tasks/'
  const markerIndex = normalized.toLowerCase().indexOf(marker)
  if (markerIndex < 0) return []
  return [...normalized.matchAll(/\/archive\/\d{4}-\d{2}\//gi)].map((match) => {
    const archiveSegment = match[0]
    return {
      path:
        normalized.slice(0, match.index) +
        '/' +
        normalized.slice(match.index + archiveSegment.length),
      sourcePath: normalized,
      archiveSegment,
    }
  })
}

function taskAbsolutePath(task) {
  return path.resolve(task.repoPath, task.relativeDir)
}

const META_CHILD_TASK_KEYS = new Set([
  'backendtask',
  'backendtasks',
  'childtask',
  'childtasks',
  'frontendtask',
  'frontendtasks',
  'integrationtask',
  'integrationtasks',
  'uitask',
  'uitasks',
])

function resolveTaskReference(sourceTask, reference, resolvePath, byProjectRef) {
  const raw = String(reference || '').trim()
  if (!raw) return null
  if (path.isAbsolute(raw) || /[\\/]\.trellis[\\/]tasks[\\/]/i.test(raw)) {
    const direct = resolvePath(raw)
    if (direct) return direct
    const archiveVariants = archivePathVariants(raw)
    const archiveHits = archiveVariants.map((variant) => resolvePath(variant.path)).filter(Boolean)
    return new Set(archiveHits).size === 1 ? archiveHits[0] : null
  }
  const projectIndex = byProjectRef.get(sourceTask.projectId)
  const hits = projectIndex?.get(raw)
  return hits?.size === 1 ? [...hits][0] : null
}

function flattenReferences(value) {
  if (Array.isArray(value)) return value.flatMap(flattenReferences)
  if (typeof value === 'string' && value.trim()) return [value.trim()]
  return []
}

function collectRelationshipCandidates(task) {
  const candidates = []
  if (task.parent) {
    candidates.push({
      parentReference: task.parent,
      childTask: task,
      source: 'task-json',
      field: 'parent',
    })
  }
  flattenReferences(task.children).forEach((reference) => {
    candidates.push({
      parentTask: task,
      childReference: reference,
      source: 'task-json',
      field: 'children',
    })
  })
  Object.entries(task.meta || {}).forEach(([key, value]) => {
    const normalizedKey = key.toLowerCase()
    const references = flattenReferences(value)
    if (!references.length) return
    if (/(?:parenttask|parenttasks)$/i.test(key)) {
      references.forEach((reference) => {
        candidates.push({
          parentReference: reference,
          childTask: task,
          source: 'meta',
          field: `meta.${key}`,
        })
      })
      return
    }
    if (META_CHILD_TASK_KEYS.has(normalizedKey)) {
      references.forEach((reference) => {
        candidates.push({
          parentTask: task,
          childReference: reference,
          source: 'meta',
          field: `meta.${key}`,
        })
      })
    }
  })
  return candidates
}

function applyGroupProgress(parent, members) {
  const children = members.filter((task) => task.taskKey !== parent.taskKey)
  if (!children.length) return parent
  const stageMap = new Map(parent.stages.map((stage) => [stage.id, stage]))
  const childStageComplete = (id) =>
    children.every((child) => child.stages.find((stage) => stage.id === id)?.complete)
  const childStageEntered = (id) =>
    children.some((child) => child.stages.find((stage) => stage.id === id)?.complete)
  const assignments = [
    {
      id: 'review',
      complete: childStageEntered('review'),
      evidence: `${children.length} 个子任务中已有任务进入开发`,
    },
    {
      id: 'implement',
      complete: childStageComplete('implement'),
      evidence: `${children.length} 个子任务均已确认进入实现，父任务继承子任务组进度`,
    },
    {
      id: 'check',
      complete: childStageComplete('check'),
      evidence: `${children.length} 个子任务的检查阶段均已完成，父任务继承子任务组进度`,
    },
    {
      id: 'e2e',
      complete: childStageComplete('e2e'),
      evidence: `${children.length} 个子任务的真实 E2E 均已完成，父任务继承子任务组进度`,
    },
    {
      id: 'spec',
      complete: childStageComplete('spec'),
      evidence: `${children.length} 个子任务的规范回写均已确认，父任务继承子任务组进度`,
    },
    {
      id: 'commit',
      complete: childStageComplete('commit'),
      evidence: `${children.length} 个子任务的工作提交均已登记，父任务继承子任务组进度`,
    },
  ]
  assignments.forEach((assignment) => {
    const current = stageMap.get(assignment.id)
    if (assignment.complete && !current?.complete) {
      stageMap.set(assignment.id, {
        ...current,
        complete: true,
        source: 'group-child',
        evidence: assignment.evidence,
      })
    }
  })
  const stages = parent.stages.map((stage) => stageMap.get(stage.id))
  return {
    ...parent,
    stages,
    derivedStage: deriveCurrentStageFromStages(stages),
  }
}

export function linkTaskGroups(results) {
  const tasks = results.flatMap((result) => result.tasks)
  const byPath = new Map()
  const registerPath = (value, task) => {
    const key = normalizePath(value)
    if (!byPath.has(key)) byPath.set(key, new Set())
    byPath.get(key).add(task)
  }
  tasks.forEach((task) => {
    const absolutePath = taskAbsolutePath(task)
    registerPath(absolutePath, task)
    archivePathVariants(absolutePath).forEach((variant) => registerPath(variant.path, task))
  })
  const resolvePath = (value) => {
    const hits = byPath.get(normalizePath(value))
    return hits?.size === 1 ? [...hits][0] : null
  }
  const byProjectRef = new Map()
  tasks.forEach((task) => {
    if (!byProjectRef.has(task.projectId)) byProjectRef.set(task.projectId, new Map())
    const projectIndex = byProjectRef.get(task.projectId)
    ;[task.id, task.dirName, task.name].filter(Boolean).forEach((reference) => {
      if (!projectIndex.has(reference)) projectIndex.set(reference, new Set())
      projectIndex.get(reference).add(task)
    })
  })

  const tasksByKey = new Map(tasks.map((task) => [task.taskKey, task]))
  const edges = new Map()
  const warningsByTask = new Map()
  const addWarning = (taskKey, warning) => {
    if (!warningsByTask.has(taskKey)) warningsByTask.set(taskKey, [])
    const existing = warningsByTask.get(taskKey)
    if (!existing.some((item) => item.code === warning.code && item.message === warning.message)) {
      existing.push(warning)
    }
  }
  tasks.forEach((task) => {
    collectRelationshipCandidates(task).forEach((candidate) => {
      const parent =
        candidate.parentTask ||
        resolveTaskReference(task, candidate.parentReference, resolvePath, byProjectRef)
      const child =
        candidate.childTask ||
        resolveTaskReference(task, candidate.childReference, resolvePath, byProjectRef)
      const missingReference = candidate.parentTask
        ? candidate.childReference
        : candidate.parentReference
      if (!parent || !child) {
        addWarning(task.taskKey, {
          code: 'RELATION_MISSING',
          field: candidate.field,
          message: `${candidate.field} 引用的任务无法唯一解析：${missingReference}`,
        })
        return
      }
      if (parent.taskKey === child.taskKey) {
        addWarning(task.taskKey, {
          code: 'RELATION_SELF',
          field: candidate.field,
          message: `${candidate.field} 形成了任务自引用`,
        })
        return
      }
      const edgeKey = `${parent.taskKey}\0${child.taskKey}`
      if (!edges.has(edgeKey)) {
        edges.set(edgeKey, {
          parentKey: parent.taskKey,
          childKey: child.taskKey,
          sources: [],
        })
      }
      const sourceLabel = `${candidate.source}:${candidate.field}`
      const edge = edges.get(edgeKey)
      if (!edge.sources.includes(sourceLabel)) edge.sources.push(sourceLabel)
    })
  })

  const parentsByChild = new Map()
  const directChildren = new Map()
  edges.forEach((edge) => {
    if (!parentsByChild.has(edge.childKey)) parentsByChild.set(edge.childKey, new Set())
    parentsByChild.get(edge.childKey).add(edge.parentKey)
    if (!directChildren.has(edge.parentKey)) directChildren.set(edge.parentKey, new Set())
    directChildren.get(edge.parentKey).add(edge.childKey)
  })

  parentsByChild.forEach((parentKeys, childKey) => {
    if (parentKeys.size <= 1) return
    addWarning(childKey, {
      code: 'RELATION_CONFLICT',
      message: `同一任务被 ${parentKeys.size} 个父任务引用：${[...parentKeys].join('、')}`,
    })
  })

  const undirected = new Map(tasks.map((task) => [task.taskKey, new Set()]))
  edges.forEach((edge) => {
    undirected.get(edge.parentKey)?.add(edge.childKey)
    undirected.get(edge.childKey)?.add(edge.parentKey)
  })

  const componentByTask = new Map()
  const components = []
  tasks.forEach((task) => {
    if (componentByTask.has(task.taskKey)) return
    const memberKeys = []
    const pending = [task.taskKey]
    while (pending.length) {
      const key = pending.pop()
      if (componentByTask.has(key)) continue
      componentByTask.set(key, components.length)
      memberKeys.push(key)
      undirected.get(key)?.forEach((neighbor) => {
        if (!componentByTask.has(neighbor)) pending.push(neighbor)
      })
    }
    components.push(memberKeys)
  })

  function findCycleNodes(memberKeys) {
    const memberSet = new Set(memberKeys)
    const colors = new Map()
    const stack = []
    const cycleNodes = new Set()
    const visit = (key) => {
      colors.set(key, 1)
      stack.push(key)
      for (const childKey of directChildren.get(key) || []) {
        if (!memberSet.has(childKey)) continue
        if (colors.get(childKey) === 1) {
          const start = stack.indexOf(childKey)
          stack.slice(start).forEach((cycleKey) => cycleNodes.add(cycleKey))
        } else if (!colors.has(childKey)) {
          visit(childKey)
        }
      }
      stack.pop()
      colors.set(key, 2)
    }
    memberKeys.forEach((key) => {
      if (!colors.has(key)) visit(key)
    })
    return cycleNodes
  }

  const groupRootByTask = new Map()
  components.forEach((memberKeys) => {
    const cycleNodes = findCycleNodes(memberKeys)
    cycleNodes.forEach((key) => {
      addWarning(key, {
        code: 'RELATION_CYCLE',
        message: '任务父子关系形成循环，已停止父任务阶段继承，需修正 task.json',
      })
    })
    const rootCandidates = memberKeys
      .filter((key) => !parentsByChild.get(key)?.size)
      .sort((a, b) => {
        const taskA = tasksByKey.get(a)
        const taskB = tasksByKey.get(b)
        return (
          String(taskA?.createdAt || '').localeCompare(String(taskB?.createdAt || '')) ||
          a.localeCompare(b)
        )
      })
    const rootKey = rootCandidates[0] || [...memberKeys].sort()[0]
    memberKeys.forEach((key) => groupRootByTask.set(key, rootKey))
  })

  const groups = new Map()
  tasks.forEach((task) => {
    const rootKey = groupRootByTask.get(task.taskKey) || task.taskKey
    if (!groups.has(rootKey)) groups.set(rootKey, [])
    groups.get(rootKey).push(task)
  })

  const linked = []
  groups.forEach((members, groupKey) => {
    const parent = tasksByKey.get(groupKey) || members[0]
    const groupWarnings = [
      ...new Set(
        members.flatMap((task) =>
          (warningsByTask.get(task.taskKey) || []).map((warning) => warning.message),
        ),
      ),
    ]
    const canRollup = members.length > 1 && groupWarnings.length === 0
    const rollupParent = canRollup ? applyGroupProgress(parent, members) : parent
    if (rollupParent !== parent) {
      const index = members.findIndex((task) => task.taskKey === parent.taskKey)
      members[index] = rollupParent
    }
    const groupKeys = members.map((task) => task.taskKey)
    members.forEach((task) => {
      const parentKeys = [...(parentsByChild.get(task.taskKey) || [])]
      const parentKey = parentKeys.length === 1 ? parentKeys[0] : null
      linked.push({
        ...task,
        parentTaskKey: parentKey,
        parentTaskKeys: parentKeys,
        childTaskKeys: [...(directChildren.get(task.taskKey) || [])],
        groupKey,
        groupRole: task.taskKey === groupKey ? 'parent' : 'child',
        groupTaskKeys: groupKeys,
        groupSize: groupKeys.length,
        relationshipWarnings: warningsByTask.get(task.taskKey) || [],
        groupWarnings,
        groupRelationsValid: groupWarnings.length === 0,
      })
    })
  })
  const executionKeyCounts = new Map()
  linked.forEach((task) => {
    const key = String(task.executionTaskKey || '').trim()
    if (!key) return
    executionKeyCounts.set(key, (executionKeyCounts.get(key) || 0) + 1)
  })
  return linked.map((task) => {
    const key = String(task.executionTaskKey || '').trim()
    const identityConflict = !key || (executionKeyCounts.get(key) || 0) > 1
    return {
      ...task,
      executionIdentityValid: Boolean(key) && !identityConflict,
      executionIdentityConflict: identityConflict,
    }
  })
}

export function toTaskListItem(task) {
  return {
    taskKey: task.taskKey,
    executionTaskKey: task.executionTaskKey,
    executionIdentityValid: task.executionIdentityValid !== false,
    executionIdentityConflict: Boolean(task.executionIdentityConflict),
    projectId: task.projectId,
    projectName: task.projectName,
    repoPath: task.repoPath,
    dirName: task.dirName,
    relativeDir: task.relativeDir,
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority,
    assignee: task.assignee,
    creator: task.creator,
    createdAt: task.createdAt,
    completedAt: task.completedAt,
    archivedAt: task.archivedAt,
    branch: task.branch,
    base_branch: task.base_branch,
    archived: task.archived,
    derivedStage: task.derivedStage,
    manualStage: task.manualStage || null,
    parentTaskKey: task.parentTaskKey || null,
    childTaskKeys: task.childTaskKeys || [],
    groupKey: task.groupKey || task.taskKey,
    groupRole: task.groupRole || 'parent',
    groupTaskKeys: task.groupTaskKeys || [task.taskKey],
    groupSize: task.groupSize || 1,
    relationshipWarnings: task.relationshipWarnings || [],
    groupWarnings: task.groupWarnings || [],
    groupRelationsValid: task.groupRelationsValid !== false,
    stages: task.stages.map((stage) => ({
      id: stage.id,
      label: stage.label,
      index: stage.index,
      complete: stage.complete,
      evidence: stage.evidence,
      source: stage.source,
      optional: Boolean(stage.optional),
    })),
    summary: task.summary,
  }
}

function readDeveloper(repoPath) {
  const raw = safeRead(path.join(repoPath, '.trellis', '.developer'))
  const match = raw.match(/name=(.+)/)
  return match ? match[1].trim() : null
}

function readMembers(repoPath) {
  return listDirectories(path.join(repoPath, '.trellis', 'workspace')).map((dir) =>
    path.basename(dir),
  )
}

function readGitHead(repoPath) {
  try {
    const head = safeRead(path.join(repoPath, '.git', 'HEAD')).trim()
    return head.startsWith('ref: refs/heads/') ? head.slice('ref: refs/heads/'.length) : 'detached'
  } catch {
    return null
  }
}

function gitMetadataSignature(repoPath) {
  const gitDir = path.join(repoPath, '.git')
  return [
    statSignature(path.join(gitDir, 'HEAD')),
    statSignature(path.join(gitDir, 'packed-refs')),
    statSignature(path.join(gitDir, 'refs', 'heads')),
    statSignature(path.join(gitDir, 'refs', 'remotes')),
  ].join('|')
}

function readCachedGitMetadata(repoPath, options, stats) {
  const cacheKey = normalizePath(repoPath)
  const signature = gitMetadataSignature(repoPath)
  const cached = gitMetadataCache.get(cacheKey)
  if (
    !options.refreshRepositoryMetadata &&
    cached &&
    cached.signature === signature &&
    Date.now() - cached.readAt < GIT_METADATA_CACHE_TTL_MS
  ) {
    stats.gitMetadataCacheHits += 1
    return cached.value
  }

  stats.gitMetadataCacheMisses += 1
  const value = readGitMetadata(repoPath)
  gitMetadataCache.set(cacheKey, {
    signature,
    readAt: Date.now(),
    value,
  })
  return value
}

function readGitMetadata(repoPath) {
  const localBranches = []
  const remoteBranches = []
  let branch = null

  try {
    const output = execFileSync(
      'git',
      [
        'for-each-ref',
        '--format=%(refname)%09%(refname:short)%09%(HEAD)',
        'refs/heads',
        'refs/remotes',
      ],
      {
        cwd: repoPath,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      },
    ).trim()

    for (const line of output.split(/\r?\n/)) {
      const [refName, shortName, head = ''] = line.split('\t')
      if (!refName || !shortName) continue
      if (refName.startsWith('refs/heads/')) {
        localBranches.push(shortName)
        if (head.trim() === '*') branch = shortName
      } else if (refName.startsWith('refs/remotes/')) {
        const remotePath = refName.slice('refs/remotes/'.length)
        const separator = remotePath.indexOf('/')
        if (separator <= 0) continue
        const remoteBranch = remotePath.slice(separator + 1)
        if (remoteBranch && remoteBranch !== 'HEAD') remoteBranches.push(remoteBranch)
      }
    }
  } catch {
    // Non-Git projects and environments without Git still render with no branch choices.
  }

  if (!branch) branch = readGitHead(repoPath)
  const compare = (left, right) => left.localeCompare(right, 'en')
  const branches = [
    ...new Set(
      [branch, ...localBranches.sort(compare), ...remoteBranches.sort(compare)].filter(Boolean),
    ),
  ]
  return { branch, branches }
}

export function withManualStages(task, manualRecord) {
  const manualStage = manualRecord?.stage
  if (!manualStage) return task
  const stageIndex = STAGE_ORDER.indexOf(manualStage)
  if (stageIndex < 0) return task
  const stages = task.stages.map((stage, index) => {
    if (index === stageIndex) {
      return {
        ...stage,
        complete: true,
        source: 'manual',
        evidence: `人工记录：已到${stage.label}${manualRecord.updatedAt ? `（${manualRecord.updatedAt.slice(0, 10)}）` : ''}；未自动补齐前序步骤`,
      }
    }
    return stage
  })
  return { ...task, stages, manualStage, derivedStage: deriveCurrentStageFromStages(stages) }
}

export function mergeTaskDetail(task, listTask, manualRecord) {
  const mergedTask = listTask
    ? {
        ...task,
        ...listTask,
        artifacts: task.artifacts,
        summary: task.summary,
      }
    : task
  return withManualStages(mergedTask, manualRecord)
}

export { STAGE_ORDER, STAGE_META, deriveCurrentStageFromStages }
