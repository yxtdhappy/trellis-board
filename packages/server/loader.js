import fs from 'node:fs'
import path from 'node:path'
import {
  countJsonlEntries,
  forgetTaskCacheEntries,
  modifiedAt,
  readWorkspaceSummary,
  taskBaseSignature,
  taskCacheKey,
  taskScanCache,
  taskWorkspaceMember,
  workspaceSignature,
} from './loader-cache.js'
import { listDirectories, readJson, safeRead } from './loader-fs.js'
import { latestCommit, readCachedGitMetadata, readDeveloper, readMembers } from './loader-git.js'
import { normalizePath } from './loader-groups.js'
import {
  STAGE_META,
  STAGE_ORDER,
  createStageMap,
  deriveCurrentStageFromStages,
  hasMeaningfulDocument,
  hasMeaningfulPrd,
  inferDerivedStage,
} from './loader-stage.js'

export { clearScanCaches } from './loader-cache.js'
export { linkTaskGroups } from './loader-groups.js'

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
      hasSource: Boolean(files.source),
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
      source: normalize(files.source),
      prd: normalize(files.prd),
      design: normalize(files.design),
      implement: normalize(files.implement),
      implementationReport: normalize(files.implementationReport),
      checkReport: normalize(files.checkReport),
      e2eReport: normalize(files.e2eReport),
    },
  }
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
  const sourcePath = path.join(taskDir, 'task.md')
  const prdPath = path.join(taskDir, 'prd.md')
  const designPath = path.join(taskDir, 'design.md')
  const implementPath = path.join(taskDir, 'implement.md')
  const implementationReportPath = path.join(taskDir, 'implementation-report.md')
  const checkReportPath = path.join(taskDir, 'check-report.md')
  const e2eReportPath = path.join(taskDir, 'e2e-report.md')
  const sourceContent = safeRead(sourcePath)
  const prdContent = safeRead(prdPath)
  const implementContent = safeRead(implementPath)
  const designContent = safeRead(designPath)
  const implementationReportContent = safeRead(implementationReportPath)
  const checkReportContent = safeRead(checkReportPath)
  const e2eReportContent = safeRead(e2eReportPath)
  const researchDir = path.join(taskDir, 'research')
  const files = {
    source: fs.existsSync(sourcePath) ? { path: sourcePath, content: sourceContent } : null,
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
  const evidence = inferDerivedStage(task, files, workspaceSummary)
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
  const repositoryMetadata = options.repositoryMetadata || null
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
    developer: Object.prototype.hasOwnProperty.call(options, 'developer')
      ? options.developer
      : readDeveloper(project.path),
    members: Array.isArray(options.members) ? options.members : readMembers(project.path),
    head:
      repositoryMetadata && Object.prototype.hasOwnProperty.call(repositoryMetadata, 'head')
        ? repositoryMetadata.head
        : latestCommit(metadataRepoPath),
    ...(repositoryMetadata || readCachedGitMetadata(metadataRepoPath, options, stats)),
  }
  const workspaceCache = new Map()
  const workspaceSummaryResolver =
    typeof options.workspaceSummaryResolver === 'function'
      ? options.workspaceSummaryResolver
      : readWorkspaceSummary
  const getWorkspaceSummary = (repoPath, member) => {
    if (!workspaceCache.has(member)) {
      workspaceCache.set(member, workspaceSummaryResolver(repoPath, member))
    }
    return workspaceCache.get(member)
  }
  const dirs = collectTaskDirs(project.path)
  const cachePrefix = `${normalizePath(project.path)}::`
  const activeCacheKeys = new Set()
  const useTaskCache = options.disableTaskCache !== true
  const tasks = [
    ...dirs.active.map((dir) => ({ dir, archived: false })),
    ...dirs.archived.map((dir) => ({ dir, archived: true })),
  ]
    .map(({ dir, archived }) => {
      const cacheKey = taskCacheKey(project, dir, includeContent)
      activeCacheKeys.add(cacheKey)
      const baseSignature = taskBaseSignature(project, dir)
      const cached = useTaskCache ? taskScanCache.get(cacheKey) : null
      if (cached?.baseSignature === baseSignature) {
        const signature = `${baseSignature}|workspace=${workspaceSignature(project.path, cached.workspaceMember)}`
        if (cached.signature === signature) {
          stats.tasksReused += 1
          return cached.task
        }
      }

      const task = buildTask(project, dir, archived, includeContent, getWorkspaceSummary)
      if (!task) return null
      const workspaceMember = taskWorkspaceMember(task)
      if (useTaskCache) {
        taskScanCache.set(cacheKey, {
          baseSignature,
          signature: `${baseSignature}|workspace=${workspaceSignature(project.path, workspaceMember)}`,
          workspaceMember,
          task,
        })
      }
      stats.tasksParsed += 1
      return task
    })
    .filter(Boolean)

  if (useTaskCache) {
    for (const cacheKey of taskScanCache.keys()) {
      if (cacheKey.startsWith(cachePrefix) && !activeCacheKeys.has(cacheKey)) {
        taskScanCache.delete(cacheKey)
      }
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
  const workspaceSummaryResolver =
    typeof options.workspaceSummaryResolver === 'function'
      ? options.workspaceSummaryResolver
      : readWorkspaceSummary
  const getWorkspaceSummary = (repoPath, member) => {
    if (!workspaceCache.has(member)) {
      workspaceCache.set(member, workspaceSummaryResolver(repoPath, member))
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
